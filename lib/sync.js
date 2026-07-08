import { pool } from "./db.js";
import { fetchActivitiesPage, fetchActivity } from "./strava.js";
import { tilesForTrack, decodePolyline, keysToColumns, ZOOM } from "./tiles.js";
import { fillEnclaves } from "./enclaves.js";
import { capturedTiles } from "./fill.js";

// Rate limit Strava par défaut : 100 req / 15 min, 1000 / jour.
// Priorité à la vitesse de la première sync : le listing (200 activités —
// le maximum Strava — par requête) enchaîne les pages presque sans pause
// (un historique de 2000 sorties = 10 requêtes, loin du quota), et les
// appels de détail (webhook sans polyline, rares) restent espacés. En cas
// de 429, la file re-tente après la fenêtre de 15 min : aucun risque.
const CALL_INTERVAL_MS = Number(process.env.SYNC_CALL_INTERVAL_MS || 3_000);
const PAGE_INTERVAL_MS = Number(process.env.SYNC_PAGE_INTERVAL_MS || 250);
const PAUSE_ON_429_MS = 15 * 60 * 1000;

const queue = []; // { id, full } — full = re-lister tout l'historique Strava
let running = false;

function enqueue(athleteId, full) {
  const cur = queue.find((q) => q.id === athleteId);
  if (cur) cur.full = cur.full || full;
  else queue.push({ id: athleteId, full });
  tick();
}

export function enqueueFullSync(athleteId) {
  enqueue(athleteId, true);
  pool
    .query("UPDATE athletes SET sync_status='queued' WHERE id=$1", [athleteId])
    .catch(console.error);
}

// Appelé par le webhook pour une seule activité : inutile de re-paginer
// tout l'historique (des dizaines d'appels API + sleeps pour rien), le
// détail de l'activité est récupéré par processPendingActivities.
export async function enqueueSingleActivity(athleteId, activityId) {
  await pool.query(
    `INSERT INTO activities (id, athlete_id, processed)
     VALUES ($1, $2, false) ON CONFLICT (id) DO NOTHING`,
    [activityId, athleteId]
  );
  enqueue(athleteId, false);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const { id, full } = queue.shift();
      await syncAthlete(id, full);
    }
  } finally {
    running = false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function syncAthlete(athleteId, full = true) {
  console.log(`[sync] démarrage athlète ${athleteId}${full ? "" : " (webhook)"}`);
  await pool.query("UPDATE athletes SET sync_status='syncing' WHERE id=$1", [
    athleteId,
  ]);
  try {
    if (full) await listAllActivities(athleteId);
    await processPendingActivities(athleteId);
    const enclaves = await fillEnclaves(athleteId);
    if (enclaves) console.log(`[sync] ${enclaves} enclave(s) remplie(s) pour ${athleteId}`);
    await captureTerritory(athleteId);
    await pool.query(
      "UPDATE athletes SET sync_status='done' WHERE id=$1",
      [athleteId]
    );
    console.log(`[sync] terminé athlète ${athleteId}`);
  } catch (e) {
    console.error(`[sync] erreur athlète ${athleteId}:`, e.message);
    if (e.rateLimited) {
      // On remet en file (dédoublonné) et on attend la fenêtre suivante
      enqueue(athleteId, full);
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
    // 1 INSERT par page de 200 (unnest) au lieu d'un par activité
    const ids = [], names = [], sports = [], dates = [], dists = [], polys = [];
    for (const a of acts) {
      ids.push(a.id);
      names.push(a.name ?? null);
      sports.push(a.sport_type ?? null);
      dates.push(a.start_date ?? null);
      dists.push(a.distance ?? null);
      polys.push(a.map?.summary_polyline || null);
    }
    await pool.query(
      `INSERT INTO activities (id, athlete_id, name, sport_type, start_date, distance_m, polyline)
       SELECT u.id, $2, u.name, u.sport, u.start_date, u.dist, u.poly
       FROM unnest($1::bigint[], $3::text[], $4::text[], $5::timestamptz[], $6::float8[], $7::text[])
         AS u(id, name, sport, start_date, dist, poly)
       ON CONFLICT (id) DO NOTHING`,
      [ids, athleteId, names, sports, dates, dists, polys]
    );
    page++;
    await sleep(PAGE_INTERVAL_MS);
  }
  await refreshSyncCounters(athleteId);
}

// Recale sync_total/sync_done sur la réalité — appelé aussi en fin de
// traitement webhook, sinon sync_done dérive au-delà de sync_total
// (barre de progression > 100 % côté client).
async function refreshSyncCounters(athleteId) {
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
async function processPendingActivities(athleteId) {
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, sport_type, polyline FROM activities
       WHERE athlete_id=$1 AND NOT processed
       ORDER BY start_date DESC NULLS LAST LIMIT 50`,
      [athleteId]
    );
    if (!rows.length) break;
    for (const a of rows) {
      let latlngs = a.polyline ? decodePolyline(a.polyline) : null;
      let usedApi = false;
      if (!latlngs?.length) {
        // Activité arrivée par webhook : le détail ramène métadonnées + polyline
        const d = await fetchActivity(athleteId, a.id);
        usedApi = true;
        // l'appel a pu durer : si l'activité a été supprimée ou passée en
        // privé entre-temps (removeActivity), ne pas ré-insérer ses tuiles
        const { rowCount } = await pool.query(
          "SELECT 1 FROM activities WHERE id=$1", [a.id]
        );
        if (!rowCount) continue;
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
        // Une seule requête par activité (unnest) au lieu d'une par tuile.
        const [xs, ys] = keysToColumns(tilesForTrack(latlngs));
        // Rouler sur une case jusque-là seulement ENCERCLÉE la normalise :
        // enclave=false, et elle récupère first_activity_id/sport_type
        // (couleur du sport sur la carte, éligible au streak).
        await pool.query(
          `INSERT INTO tiles (athlete_id, z, x, y, first_activity_id, sport_type, sports)
           SELECT $1, $2, u.x, u.y, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE ARRAY[$4::text] END
           FROM unnest($5::int[], $6::int[]) AS u(x, y)
           ON CONFLICT (athlete_id, z, x, y) DO UPDATE SET
             enclave = false,
             first_activity_id = coalesce(tiles.first_activity_id, EXCLUDED.first_activity_id),
             sport_type = coalesce(tiles.sport_type, EXCLUDED.sport_type),
             sports = (
               SELECT array_agg(DISTINCT s ORDER BY s)
               FROM unnest(coalesce(tiles.sports, ARRAY[]::text[]) || coalesce(EXCLUDED.sports, ARRAY[]::text[])) AS s
             )`,
          [athleteId, ZOOM, a.id, sport, xs, ys]
        );
      }
      // un seul aller-retour PG pour clore l'activité et compter la progression
      await pool.query(
        `WITH done AS (UPDATE activities SET processed=true WHERE id=$1)
         UPDATE athletes SET sync_done = sync_done + 1 WHERE id=$2`,
        [a.id, athleteId]
      );
      if (usedApi) await sleep(CALL_INTERVAL_MS);
    }
  }
  // le chemin webhook ne re-liste pas l'historique : on recale les compteurs
  await refreshSyncCounters(athleteId);
}

// Turf war : l'athlète revendique le territoire qu'il a parcouru ou encerclé.
// Chaque case porte la date du DERNIER passage réel dessus : le vol exige
// d'être passé sur la case après la prise du défenseur (fini le « je roule
// n'importe où et je re-vole tout le territoire contesté »). Les cases
// seulement encerclées prennent la date de la dernière sortie.
export async function captureTerritory(athleteId) {
  const { rows } = await pool.query(
    `SELECT polyline, start_date FROM activities
     WHERE athlete_id=$1 AND polyline IS NOT NULL`,
    [athleteId]
  );
  if (!rows.length) return;
  const tracks = rows.map((r) => decodePolyline(r.polyline));
  const { captured, encircled } = capturedTiles(tracks);
  if (!captured.size) return;
  const last = rows.reduce(
    (m, r) => (r.start_date && (!m || r.start_date > m) ? r.start_date : m),
    null
  ) || new Date();
  // date par case = max(start_date) des sorties qui la traversent
  const dateOf = new Map();
  for (let i = 0; i < rows.length; i++) {
    const d = rows[i].start_date || last;
    for (const k of tilesForTrack(tracks[i])) {
      const cur = dateOf.get(k);
      if (!cur || d > cur) dateOf.set(k, d);
    }
  }
  const xs = [], ys = [], dates = [];
  for (const k of captured) {
    const [x, y] = k.split(":").map(Number);
    xs.push(x);
    ys.push(y);
    dates.push(dateOf.get(k) || last);
  }
  // captured_at = date de PRISE : jamais rafraîchie tant que la case reste
  // au même athlète (sinon chaque recalcul faussait les défis hebdo).
  await pool.query(
    `INSERT INTO territory (z, x, y, owner_id, captured_at)
     SELECT $1, u.x, u.y, $2, u.d
     FROM unnest($3::int[], $4::int[], $5::timestamptz[]) AS u(x, y, d)
     ON CONFLICT (z, x, y) DO UPDATE
       SET owner_id = EXCLUDED.owner_id, captured_at = EXCLUDED.captured_at
       WHERE territory.owner_id <> EXCLUDED.owner_id
         AND territory.captured_at < EXCLUDED.captured_at`,
    [ZOOM, athleteId, xs, ys, dates]
  );
  console.log(
    `[sync] territoire ${athleteId} : ${captured.size} cases revendiquées` +
    (encircled.size ? ` (dont ${encircled.size} encerclées)` : "")
  );
}

// --- Conformité accord API Strava : suppression et vie privée ---

// Révocation (webhook authorized:false) ou suppression de compte dans
// l'app : on efface TOUT (activités, cases, territoire, adhésions clan
// suivent par ON DELETE CASCADE ; clans créés -> created_by NULL).
export async function deleteAthleteData(athleteId) {
  await pool.query("DELETE FROM athletes WHERE id=$1", [athleteId]);
  console.log(`[privacy] données de l'athlète ${athleteId} supprimées`);
}

// Reconstruit toutes les données dérivées d'un athlète depuis ses
// activités restantes (après suppression ou passage en privé d'une
// activité) : cases, enclaves, puis territoire re-revendiqué à neuf.
async function rebuildAthlete(athleteId) {
  const { rows } = await pool.query(
    `SELECT id, sport_type, polyline FROM activities
     WHERE athlete_id=$1 AND polyline IS NOT NULL`,
    [athleteId]
  );
  await pool.query("DELETE FROM tiles WHERE athlete_id=$1", [athleteId]);
  for (const a of rows) {
    const latlngs = decodePolyline(a.polyline);
    if (!latlngs.length) continue;
    const sport = a.sport_type || null;
    const xs = [], ys = [];
    for (const key of tilesForTrack(latlngs)) {
      const [x, y] = key.split(":").map(Number);
      xs.push(x); ys.push(y);
    }
    await pool.query(
      `INSERT INTO tiles (athlete_id, z, x, y, first_activity_id, sport_type, sports)
       SELECT $1, $2, u.x, u.y, $3, $4, CASE WHEN $4::text IS NULL THEN NULL ELSE ARRAY[$4::text] END
       FROM unnest($5::int[], $6::int[]) AS u(x, y)
       ON CONFLICT (athlete_id, z, x, y) DO UPDATE SET
         enclave = false,
         first_activity_id = coalesce(tiles.first_activity_id, EXCLUDED.first_activity_id),
         sport_type = coalesce(tiles.sport_type, EXCLUDED.sport_type),
         sports = (
           SELECT array_agg(DISTINCT s ORDER BY s)
           FROM unnest(coalesce(tiles.sports, ARRAY[]::text[]) || coalesce(EXCLUDED.sports, ARRAY[]::text[])) AS s
         )`,
      [athleteId, ZOOM, a.id, sport, xs, ys]
    );
  }
  await fillEnclaves(athleteId);
  // Territoire : on ne supprime QUE les cases qui ne sont plus couvertes —
  // tout effacer puis re-revendiquer redaterait les prises restantes et
  // re-fausserait les défis hebdo (l'upsert préserve les dates same-owner).
  const { rows: acts } = await pool.query(
    `SELECT polyline FROM activities WHERE athlete_id=$1 AND polyline IS NOT NULL`,
    [athleteId]
  );
  if (acts.length) {
    const { captured } = capturedTiles(acts.map((r) => decodePolyline(r.polyline)));
    const [xs, ys] = keysToColumns(captured);
    await pool.query(
      `DELETE FROM territory t WHERE t.owner_id=$1
         AND NOT EXISTS (SELECT 1 FROM unnest($2::int[], $3::int[]) AS w(x, y)
                         WHERE w.x = t.x AND w.y = t.y)`,
      [athleteId, xs, ys]
    );
  } else {
    await pool.query("DELETE FROM territory WHERE owner_id=$1", [athleteId]);
  }
  await captureTerritory(athleteId);
}

// Une activité supprimée sur Strava (ou passée en privé) disparaît de
// l'app, et tout ce qui en dérivait est recalculé.
export async function removeActivity(athleteId, activityId) {
  const { rowCount } = await pool.query(
    "DELETE FROM activities WHERE id=$1 AND athlete_id=$2",
    [activityId, athleteId]
  );
  if (!rowCount) return;
  console.log(`[privacy] activité ${activityId} retirée, reconstruction de ${athleteId}`);
  await rebuildAthlete(athleteId);
}

// Réparation ponctuelle (via once() de db.js) : l'ancien recalcul
// estampillait TOUT le territoire à la date de la dernière sortie. On
// re-date chaque case parcourue à son dernier passage réel ; les cases
// seulement encerclées marquées « cette semaine » reprennent une date
// antérieure au lundi.
export async function repairCapturedAt() {
  const { rows: owners } = await pool.query("SELECT DISTINCT owner_id FROM territory");
  for (const { owner_id } of owners) {
    const id = Number(owner_id);
    const { rows } = await pool.query(
      `SELECT polyline, start_date FROM activities
       WHERE athlete_id=$1 AND polyline IS NOT NULL AND start_date IS NOT NULL`,
      [id]
    );
    const dateOf = new Map();
    for (const r of rows) {
      for (const k of tilesForTrack(decodePolyline(r.polyline))) {
        const cur = dateOf.get(k);
        if (!cur || r.start_date > cur) dateOf.set(k, r.start_date);
      }
    }
    const xs = [], ys = [], ds = [];
    for (const [k, d] of dateOf) {
      const [x, y] = k.split(":").map(Number);
      xs.push(x); ys.push(y); ds.push(d);
    }
    const r1 = await pool.query(
      `UPDATE territory t SET captured_at = u.d
       FROM unnest($2::int[], $3::int[], $4::timestamptz[]) AS u(x, y, d)
       WHERE t.owner_id=$1 AND t.x = u.x AND t.y = u.y`,
      [id, xs, ys, ds]
    );
    const r2 = await pool.query(
      `UPDATE territory t SET captured_at = (
         SELECT coalesce(max(a.start_date), now() - interval '7 days')
         FROM activities a WHERE a.athlete_id=$1 AND a.start_date < date_trunc('week', now())
       )
       WHERE t.owner_id=$1 AND t.captured_at >= date_trunc('week', now())
         AND NOT EXISTS (SELECT 1 FROM unnest($2::int[], $3::int[]) AS w(x, y)
                         WHERE w.x = t.x AND w.y = t.y)`,
      [id, xs, ys]
    );
    console.log(`[repair] athlète ${id} : ${r1.rowCount} cases re-datées au dernier passage, ${r2.rowCount} encerclées re-datées`);
  }
}

// Reprise après redémarrage : on remet en file les syncs interrompues
export async function resumeInterrupted() {
  const { rows } = await pool.query(
    "SELECT id FROM athletes WHERE sync_status IN ('queued','syncing')"
  );
  for (const r of rows) enqueueFullSync(Number(r.id));
}
