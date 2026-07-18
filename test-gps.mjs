// Tests du filtre GPS + réparation + push, sur un PostgreSQL local :
//   POSTGRESQL_ADDON_URI="postgres://user:pass@localhost:5432/db" APP_SECRET=x node test-gps.mjs
// (variables passées AU PROCESS : les imports ESM lisent l'env avant ce fichier)
// ⚠️ le test TRUNCATE la table athletes : jamais sur la base de prod.

import assert from "node:assert";
import { pool, migrate } from "./lib/db.js";
import { tilesForTrack, splitTrackOnJumps, haversineM } from "./lib/tiles.js";
import { capturedTiles } from "./lib/fill.js";
import { repairGpsJumps, captureTerritory } from "./lib/sync.js";
import { ensurePushSchema, sendToAthlete } from "./lib/push.js";

// --- outils : générer une trace réaliste + encoder en polyline Strava ---
function makeTrack(startLat, startLng, nPts, stepM = 150, heading = 0.3) {
  const pts = [[startLat, startLng]];
  for (let i = 1; i < nPts; i++) {
    const [lat, lng] = pts[i - 1];
    // pas ~stepM avec un léger bruit de cap (comme un vrai GPS)
    const h = heading + Math.sin(i / 7) * 0.5;
    pts.push([
      lat + (stepM / 111320) * Math.cos(h),
      lng + (stepM / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.sin(h),
    ]);
  }
  return pts;
}
function encodePolyline(pts) {
  let out = "", pLat = 0, pLng = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = "";
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lng] of pts) {
    const iLat = Math.round(lat * 1e5), iLng = Math.round(lng * 1e5);
    out += enc(iLat - pLat) + enc(iLng - pLng);
    pLat = iLat; pLng = iLng;
  }
  return out;
}

// --- 1) unitaires : découpe et tuiles ---
const clean = makeTrack(47.2, -1.55, 80); // ~12 km autour de Nantes
assert.strictEqual(splitTrackOnJumps(clean).length, 1, "trace saine : 1 seul morceau");
const cleanTiles = tilesForTrack(clean).size;

// décrochage : Nantes -> saut ~190 km -> reprise vers Paris (40 pts)
const resume = makeTrack(48.6, 1.9, 40);
const glitch = [...clean, ...resume];
const parts = splitTrackOnJumps(glitch);
assert.strictEqual(parts.length, 2, "saut détecté : 2 morceaux");
const gTiles = tilesForTrack(glitch);
const resumeTiles = tilesForTrack(resume).size;
// AVANT le fix, l'interpolation ajoutait ~120 cases le long de la diagonale
assert.ok(
  gTiles.size <= cleanTiles + resumeTiles,
  `pas de ligne fantôme : ${gTiles.size} <= ${cleanTiles + resumeTiles}`
);

// spike GPS isolé (aller-retour à 200 km) : aucune case là-bas
const spike = [...clean.slice(0, 40), [49.0, 0.5], ...clean.slice(40)];
const sTiles = tilesForTrack(spike);
for (const k of sTiles) {
  const [x] = k.split(":").map(Number);
  // le spike (lng 0.5) tomberait vers x=8215 ; la trace saine reste < 8140
  assert.ok(x < 8180, `case fantôme du spike : ${k}`);
}
assert.strictEqual(sTiles.size, tilesForTrack(clean).size, "spike neutralisé");

// fill.js : l'encerclement ne soude pas la fausse ligne
const loop = [...makeTrack(47.3, -1.5, 60, 150, 0), ...makeTrack(47.38, -1.42, 60, 150, Math.PI / 2)];
const { captured } = capturedTiles([glitch]);
let far = 0;
for (const k of captured) if (Number(k.split(":")[0]) > 8180) far++;
// la reprise vers Paris (lng 1.9 -> x ~8278) reste légitime : on vérifie
// seulement qu'aucune case n'apparaît le long de la diagonale (lng 0..1.5)
for (const k of captured) {
  const x = Number(k.split(":")[0]);
  assert.ok(x < 8140 || x > 8230, `case sur la diagonale fantôme : ${k}`);
}
console.log("✓ unitaires : découpe, tuiles, spike, encerclement");

// --- 2) intégration : réparation rétroactive en base ---
await migrate();
await ensurePushSchema();
await pool.query("TRUNCATE athletes CASCADE");
await pool.query(
  `INSERT INTO athletes (id, firstname, lastname, access_token, refresh_token, expires_at, consent_at)
   VALUES (111, 'Loïc', 'P', 't', 'r', 9999999999, now()),
          (222, 'Benoit', 'P', 't', 'r', 9999999999, now())`
);
// benoit a l'activité au GPS pourri (la diagonale de la capture d'écran)
await pool.query(
  `INSERT INTO activities (id, athlete_id, name, sport_type, start_date, distance_m, polyline, processed)
   VALUES (1, 222, 'Sortie glitch', 'Ride', now() - interval '10 days', 12000, $1, true),
          (2, 111, 'Sortie saine', 'Ride', now() - interval '3 days', 12000, $2, true)`,
  [encodePolyline(glitch), encodePolyline(clean)]
);
// on simule l'ANCIEN état : cases posées avec l'ancienne interpolation
// (sans découpe) — on les reconstruit à la main le long de la diagonale
const oldStyle = new Set(tilesForTrack(clean)); // approximation suffisante :
for (let i = 0; i <= 100; i++) {
  // diagonale Nantes->Chartres à z14
  const x = Math.round(8123 + (8270 - 8123) * (i / 100));
  const y = Math.round(5859 + (5589 - 5859) * (i / 100));
  oldStyle.add(`${x}:${y}`);
}
const xs = [], ys = [];
for (const k of oldStyle) { const [x, y] = k.split(":").map(Number); xs.push(x); ys.push(y); }
await pool.query(
  `INSERT INTO tiles (athlete_id, z, x, y) SELECT 222, 14, u.x, u.y FROM unnest($1::int[], $2::int[]) u(x,y)`,
  [xs, ys]
);
await pool.query(
  `INSERT INTO territory (z, x, y, owner_id, captured_at) SELECT 14, u.x, u.y, 222, now() - interval '10 days' FROM unnest($1::int[], $2::int[]) u(x,y)`,
  [xs, ys]
);
const before = (await pool.query("SELECT count(*)::int n FROM territory WHERE owner_id=222")).rows[0].n;
await repairGpsJumps();
const after = (await pool.query("SELECT count(*)::int n FROM territory WHERE owner_id=222")).rows[0].n;
const tilesAfter = (await pool.query("SELECT count(*)::int n FROM tiles WHERE athlete_id=222")).rows[0].n;
console.log(`✓ réparation : territoire benoit ${before} -> ${after} cases, perso ${tilesAfter}`);
assert.ok(after < before - 60, "la diagonale fantôme a été élaguée");
const diag = (await pool.query(
  "SELECT count(*)::int n FROM territory WHERE owner_id=222 AND x BETWEEN 8150 AND 8230"
)).rows[0].n;
assert.strictEqual(diag, 0, "plus aucune case sur la diagonale");

// --- 3) vol de cases : notif agrégée (sans abonnement : sent=0, pas de crash) ---
await captureTerritory(111); // Loïc repasse sur des cases de benoit (traces proches)
const r = await sendToAthlete(111, { title: "t", body: "b" });
assert.deepStrictEqual(r, { sent: 0 }, "push désactivé sans VAPID : no-op propre");
console.log("✓ intégration : réparation + captureTerritory + push no-op");
await pool.end();
console.log("TOUS LES TESTS PASSENT");
