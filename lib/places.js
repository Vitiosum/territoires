import { pool } from "./db.js";
import { tileCenter } from "./tiles.js";

// Géocodage inverse des cases du territoire vers leur commune, en tâche de
// fond. Politique Nominatim respectée : 1 requête/s max, User-Agent
// identifiant l'app, résultats mis en cache définitivement en base.
const UA = "Tilevore/1.0 (+https://app-4f9ed7b1-a32a-4081-8972-bbc36cf6e0c6.cleverapps.io)";
const PACE_MS = 1_100;

let running = false;

// Lancement « fire and forget » : au boot et après chaque sync. Traite au
// plus `limit` cases non géocodées puis s'arrête (enrichissement progressif).
export function geocodePendingTiles(limit = 300) {
  if (running) return;
  running = true;
  (async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT t.z, t.x, t.y FROM territory t
       LEFT JOIN tile_places p ON p.z = t.z AND p.x = t.x AND p.y = t.y
       WHERE p.z IS NULL
       LIMIT $1`,
      [limit]
    );
    if (rows.length) console.log(`[villes] géocodage de ${rows.length} case(s)…`);
    for (const t of rows) {
      const [lng, lat] = tileCenter(t.x, t.y, t.z);
      let city = "";
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10&accept-language=fr`,
          { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) }
        );
        if (r.status === 429 || r.status === 403) break; // politesse : on réessaiera plus tard
        if (r.ok) {
          const a = (await r.json()).address || {};
          city = a.city || a.town || a.village || a.municipality || "";
        }
      } catch {
        // réseau/timeout : la case reste non géocodée, retentée au prochain passage
        break;
      }
      await pool.query(
        `INSERT INTO tile_places (z, x, y, city) VALUES ($1, $2, $3, $4)
         ON CONFLICT (z, x, y) DO NOTHING`,
        [t.z, t.x, t.y, city]
      );
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
  })()
    .catch((e) => console.error("[villes]", e.message))
    .finally(() => { running = false; });
}
