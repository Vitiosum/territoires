import { pool } from "./db.js";
import { fetchActivitiesPage, fetchActivity } from "./strava.js";
import { tilesForTrack, decodePolyline, ZOOM } from "./tiles.js";
import { fillEnclaves } from "./enclaves.js";

// Rate limit Strava par défaut : 100 req / 15 min, 1000 / jour.
// On espace les appels (~1 toutes les 10 s) pour rester large.
const CALL_INTERVAL_MS = Number(process.env.SYNC_CALL_INTERVAL_MS || 10_000);
// Le listing ne coûte qu'1 requête pour 200 activités : pause courte suffit
const PAGE_INTERVAL_MS = Number(process.env.SYNC_PAGE_INTERVAL_MS || 2_000);
const PAUSE_ON_429_MS = 15 * 60 * 1000;

const queue = []; // athleteIds en attente de sync complète
let running = false;

export function enqueueFullSync(athleteId) {
  if (!queue.includes(athleteId)) queue.push(athleteId);
  pool
    .query("UPDATE athletes SET sync_status='queued' WHERE id=$1", [athleteId])
    .catch(console.error);
  tick();
}

// Appelé par le webhook pour une seule activité
export async function enqueueSingleActivity(athleteId, activityId) {
  await pool.query(
    `INSERT INTO activities (id, athlete_id, processed)
     VALUES ($1, $2, false) ON CONFLICT (id) DO NOTHING`,
    [activityId, athleteId]
  );
  if (!queue.includes(athleteId)) queue.push(athleteId);
  tick();
}

async function tick() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const athleteId = queue.shift();
      await syncAthlete(athleteId);
    }
  } finally {
    running = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncAthlete(athleteId) {
  console.log(`[sync] démarrage athlète ${athleteId}`);
  await pool.query("UPDATE athletes SET sync_status='syncing' WHERE id=$1", [
    athleteId,
  ]);
  try {
    await listAllActivities(athleteId);
    await processPendingActivities(athleteId);
    const enclaves = await fillEnclaves(athleteId);
    if (enclaves) console.log(`[sync] ${enclaves} enclave(s) remplie(s) pour ${athleteId}`);
    await pool.query(
      "UPDATE athletes SET sync_status='done' WHERE id=$1",
      [athleteId]
    );
    console.log(`[sync] terminé athlète ${athleteId}`);
  } catch (e) {
    console.error(`[sync] erreur athlète ${athleteId}:`, e.message);
    if (e.rateLimited) {
      // On remet en file et on attend la fenêtre suivante
      queue.push(athleteId);
      await pool.query(
        "UPDATE athletes SET sync_status='queued' WHERE id=$1",
        [athleteId]
      );
      await sleep(PAUSE_ON_429_MS);
    } else {
      await pool.query(
        "UPDATE athletes SET sync_status='error' WHERE id=$1",
        [athleteId]
      );
    }
  }
}

// Étape 1 : lister toutes les activités (paginé, 200/page)
async function listAllActivities(athleteId) {
  let page = 1;
  for (;;) {
    const acts = await fetchActivitiesPage(athleteId, page);
    if (!acts.length) break;
    for (const a of acts) {
      await pool.query(
        `INSERT INTO activities (id, athlete_id, name, sport_type, start_date, distance_m, polyline)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [
          a.id,
          athleteId,
          a.name,
          a.sport_type,
          a.start_date,
          a.distance,
          a.map?.summary_polyline || null,
        ]
      );
    }
    page++;
    await sleep(PAGE_INTERVAL_MS);
  }
  const { rows } = await pool.query(
    "SELECT count(*)::int AS total, count(*) FILTER (WHERE processed)::int AS done FROM activities WHERE athlete_id=$1",
    [athleteId]
  );
  await pool.query(
    "UPDATE athletes SET sync_total=$1, sync_done=$2 WHERE id=$3",
    [rows[0].total, rows[0].done, athleteId]
  );
}

// Étape 2 : pour chaque activité non traitée, capturer les tuiles.
// La polyline résumée (déjà stockée par le listing) suffit à l'échelle des
// tuiles zoom 14 : zéro appel API, la sync complète prend quelques secondes.
// Le stream GPS n'est demandé qu'en dernier recours (webhook sans polyline),
// et c'est seulement dans ce cas qu'on espace les appels (rate limit).
export async function processPendingActivities(athleteId) {
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, sport_type, polyline FROM activities
       WHERE athlete_id=$1 AND NOT processed
       ORDER BY start_date DESC NULLS LAST LIMIT 1`,
      [athleteId]
    );
    if (!rows.length) break;
    const a = rows[0];

    let latlngs = a.polyline ? decodePolyline(a.polyline) : null;
    let usedApi = false;
    if (!latlngs?.length) {
      // Activité arrivée par webhook : le détail ramène métadonnées + polyline
      const d = await fetchActivity(athleteId, a.id);
      usedApi = true;
      if (d) {
        a.sport_type = d.sport_type || a.sport_type;
        const poly = d.map?.summary_polyline || d.map?.polyline || null;
        await pool.query(
          `UPDATE activities SET name=$1, sport_type=$2, start_date=$3, distance_m=$4, polyline=$5
           WHERE id=$6`,
          [d.name, d.sport_type, d.start_date, d.distance, poly, a.id]
        );
        if (poly) latlngs = decodePolyline(poly);
      }
    }
    if (latlngs?.length) {
      const sport = a.sport_type || null;
      const tiles = tilesForTrack(latlngs);
      for (const key of tiles) {
        const [x, y] = key.split(":").map(Number);
        await pool.query(
          `INSERT INTO tiles (athlete_id, z, x, y, first_activity_id, sport_type, sports)
           VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6::text IS NULL THEN NULL ELSE ARRAY[$6::text] END)
           ON CONFLICT (athlete_id, z, x, y) DO UPDATE SET sports = (
             SELECT array_agg(DISTINCT s ORDER BY s)
             FROM unnest(coalesce(tiles.sports, ARRAY[]::text[]) || coalesce(EXCLUDED.sports, ARRAY[]::text[])) AS s
           )`,
          [athleteId, ZOOM, x, y, a.id, sport]
        );
      }
    }
    await pool.query("UPDATE activities SET processed=true WHERE id=$1", [
      a.id,
    ]);
    await pool.query(
      "UPDATE athletes SET sync_done = sync_done + 1 WHERE id=$1",
      [athleteId]
    );
    if (usedApi) await sleep(CALL_INTERVAL_MS);
  }
}

// Reprise après redémarrage : on remet en file les syncs interrompues
export async function resumeInterrupted() {
  const { rows } = await pool.query(
    "SELECT id FROM athletes WHERE sync_status IN ('queued','syncing')"
  );
  for (const r of rows) enqueueFullSync(Number(r.id));
}
