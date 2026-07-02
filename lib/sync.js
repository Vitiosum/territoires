import { pool } from "./db.js";
import { fetchActivitiesPage, fetchLatLngStream } from "./strava.js";
import { tilesForTrack, ZOOM } from "./tiles.js";

// Rate limit Strava par défaut : 100 req / 15 min, 1000 / jour.
// On espace les appels (~1 toutes les 10 s) pour rester large.
const CALL_INTERVAL_MS = Number(process.env.SYNC_CALL_INTERVAL_MS || 10_000);
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
    await sleep(CALL_INTERVAL_MS);
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

// Étape 2 : pour chaque activité non traitée, récupérer le stream GPS
// et capturer les tuiles. La carte se remplit au fur et à mesure.
async function processPendingActivities(athleteId) {
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id FROM activities
       WHERE athlete_id=$1 AND NOT processed
       ORDER BY start_date DESC NULLS LAST LIMIT 1`,
      [athleteId]
    );
    if (!rows.length) break;
    const activityId = rows[0].id;

    const latlngs = await fetchLatLngStream(athleteId, activityId);
    if (latlngs?.length) {
      const { rows: srows } = await pool.query(
        "SELECT sport_type FROM activities WHERE id=$1",
        [activityId]
      );
      const sport = srows[0]?.sport_type || null;
      const tiles = tilesForTrack(latlngs);
      for (const key of tiles) {
        const [x, y] = key.split(":").map(Number);
        await pool.query(
          `INSERT INTO tiles (athlete_id, z, x, y, first_activity_id, sport_type)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (athlete_id, z, x, y) DO NOTHING`,
          [athleteId, ZOOM, x, y, activityId, sport]
        );
      }
    }
    await pool.query("UPDATE activities SET processed=true WHERE id=$1", [
      activityId,
    ]);
    await pool.query(
      "UPDATE athletes SET sync_done = sync_done + 1 WHERE id=$1",
      [athleteId]
    );
    await sleep(CALL_INTERVAL_MS);
  }
}

// Reprise après redémarrage : on remet en file les syncs interrompues
export async function resumeInterrupted() {
  const { rows } = await pool.query(
    "SELECT id FROM athletes WHERE sync_status IN ('queued','syncing')"
  );
  for (const r of rows) enqueueFullSync(Number(r.id));
}
