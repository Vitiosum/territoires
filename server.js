import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { pool, migrate } from "./lib/db.js";
import { authorizeUrl, exchangeCode } from "./lib/strava.js";
import {
  enqueueFullSync,
  enqueueSingleActivity,
  resumeInterrupted,
  captureTerritory,
} from "./lib/sync.js";
import { tileToPolygon, tilesForTrack, decodePolyline, tileAreaKm2, tileCenter, ZOOM } from "./lib/tiles.js";
import { countryOf } from "./lib/countries.js";
import { fillEnclaves } from "./lib/enclaves.js";

// L'auth repose entièrement sur le cookie signé : sans secret propre, on
// refuse de démarrer (comme db.js pour l'URI) plutôt que d'utiliser un
// secret public qui rendrait les sessions forgeables.
if (!process.env.APP_SECRET) {
  console.error("APP_SECRET manquant. clever env set APP_SECRET \"$(openssl rand -hex 32)\"");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cookieParser(process.env.APP_SECRET));
app.use(express.static("public"));

// Express 4 ne rattrape pas les rejets des handlers async : un rejet non
// géré (ex. coupure PostgreSQL transitoire) tuerait le process. On enrobe
// donc chaque handler pour router les rejets vers le middleware d'erreur.
for (const method of ["get", "post"]) {
  const orig = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    orig(
      path,
      ...handlers.map((h) =>
        h.length >= 4 ? h : (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)
      )
    );
}

// Clever Cloud : PORT=8080 attendu par défaut
const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// --- Session minimaliste : cookie signé contenant l'id athlète ---
function currentAthleteId(req) {
  const id = req.signedCookies?.aid;
  return id ? Number(id) : null;
}
function requireAuth(req, res, next) {
  const id = currentAthleteId(req);
  if (!id) return res.status(401).json({ error: "not_authenticated" });
  req.athleteId = id;
  next();
}

// --- OAuth Strava ---
app.get("/auth/strava", (req, res) => res.redirect(authorizeUrl(BASE_URL)));

app.get("/auth/callback", async (req, res) => {
  try {
    if (req.query.error) return res.redirect("/?error=denied");
    const t = await exchangeCode(req.query.code);
    const a = t.athlete;
    await pool.query(
      `INSERT INTO athletes (id, firstname, lastname, profile, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         firstname=EXCLUDED.firstname, lastname=EXCLUDED.lastname, profile=EXCLUDED.profile,
         access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
         expires_at=EXCLUDED.expires_at`,
      [a.id, a.firstname, a.lastname, a.profile, t.access_token, t.refresh_token, t.expires_at]
    );
    res.cookie("aid", String(a.id), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 365 * 24 * 3600 * 1000,
    });
    // Sync automatique dès la connexion : "un bouton et tout arrive"
    enqueueFullSync(a.id);
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.redirect("/?error=oauth");
  }
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("aid");
  res.json({ ok: true });
});

// --- API ---
app.get("/api/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, firstname, lastname, profile, sync_status, sync_done, sync_total
     FROM athletes WHERE id=$1`,
    [req.athleteId]
  );
  if (!rows.length) return res.status(401).json({ error: "unknown" });
  res.json(rows[0]);
});

app.post("/api/sync", requireAuth, (req, res) => {
  enqueueFullSync(req.athleteId);
  res.json({ ok: true });
});

// ?since=YYYY-MM-DD : stats de la période (activités filtrées, cases
// recalculées depuis les polylines, comme /api/tiles?since)
app.get("/api/stats", requireAuth, async (req, res) => {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || "")
    ? req.query.since
    : null;
  if (since) {
    const { rows: acts } = await pool.query(
      `SELECT count(*)::int AS activities, coalesce(sum(distance_m),0) AS distance_m
       FROM activities WHERE athlete_id=$1 AND start_date >= $2`,
      [req.athleteId, since]
    );
    const { rows: polys } = await pool.query(
      `SELECT polyline FROM activities
       WHERE athlete_id=$1 AND polyline IS NOT NULL AND start_date >= $2`,
      [req.athleteId, since]
    );
    const keys = new Set();
    for (const a of polys)
      for (const k of tilesForTrack(decodePolyline(a.polyline))) keys.add(k);
    let area_km2 = 0;
    for (const k of keys) {
      const [x, y] = k.split(":").map(Number);
      area_km2 += tileAreaKm2(x, y, ZOOM);
    }
    return res.json({ ...acts[0], tiles: keys.size, area_km2, period: since });
  }
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM tiles WHERE athlete_id=$1) AS tiles,
       (SELECT count(*)::int FROM activities WHERE athlete_id=$1) AS activities,
       (SELECT coalesce(sum(distance_m),0) FROM activities WHERE athlete_id=$1) AS distance_m`,
    [req.athleteId]
  );
  const { rows: coords } = await pool.query(
    "SELECT x, y, z FROM tiles WHERE athlete_id=$1",
    [req.athleteId]
  );
  const area_km2 = coords.reduce((a, t) => a + tileAreaKm2(t.x, t.y, t.z), 0);

  // Streak : semaines consécutives (en remontant depuis cette semaine)
  // avec au moins une nouvelle case conquise. On compare des dates ISO
  // (texte) plutôt que des timestamps pour être insensible au fuseau
  // (le parsing d'une colonne DATE de pg dépendait du TZ du process).
  const { rows: weeks } = await pool.query(
    `SELECT DISTINCT to_char(date_trunc('week', a.start_date), 'YYYY-MM-DD') AS w
     FROM tiles t JOIN activities a ON a.id = t.first_activity_id
     WHERE t.athlete_id=$1 AND a.start_date IS NOT NULL`,
    [req.athleteId]
  );
  let streak = 0;
  if (weeks.length) {
    const have = new Set(weeks.map((r) => r.w));
    const monday = new Date();
    monday.setUTCHours(0, 0, 0, 0);
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    const iso = (d) => d.toISOString().slice(0, 10);
    // la semaine en cours peut ne pas encore avoir de sortie sans casser le streak
    if (!have.has(iso(monday))) monday.setUTCDate(monday.getUTCDate() - 7);
    while (have.has(iso(monday))) {
      streak++;
      monday.setUTCDate(monday.getUTCDate() - 7);
    }
  }
  res.json({ ...rows[0], area_km2, streak });
});

// Répartition par pays : cases, km², % du pays conquis, km parcourus
app.get("/api/countries", requireAuth, async (req, res) => {
  const { rows: tiles } = await pool.query(
    "SELECT x, y, z FROM tiles WHERE athlete_id=$1",
    [req.athleteId]
  );
  const byCountry = new Map();
  const bucket = (c) => {
    if (!byCountry.has(c.name)) {
      byCountry.set(c.name, {
        name: c.name, flag: c.flag, country_km2: c.areaKm2,
        tiles: 0, area_km2: 0, km: 0, activities: 0, bounds: null,
      });
    }
    return byCountry.get(c.name);
  };
  for (const t of tiles) {
    const center = tileCenter(t.x, t.y, t.z);
    let c = countryOf(...center);
    if (!c) {
      // case côtière : le centre tombe "en mer", on tente les coins
      for (const corner of tileToPolygon(t.x, t.y, t.z)[0].slice(0, 4)) {
        c = countryOf(corner[0], corner[1]);
        if (c) break;
      }
    }
    if (!c) continue;
    const b = bucket(c);
    b.tiles++;
    b.area_km2 += tileAreaKm2(t.x, t.y, t.z);
    // emprise de TES cases dans le pays, pour le bouton "Y aller"
    if (!b.bounds) b.bounds = [center[0], center[1], center[0], center[1]];
    else {
      b.bounds[0] = Math.min(b.bounds[0], center[0]);
      b.bounds[1] = Math.min(b.bounds[1], center[1]);
      b.bounds[2] = Math.max(b.bounds[2], center[0]);
      b.bounds[3] = Math.max(b.bounds[3], center[1]);
    }
  }
  // km par pays : chaque activité est rattachée au pays de son point de départ
  const { rows: acts } = await pool.query(
    `SELECT distance_m, polyline FROM activities
     WHERE athlete_id=$1 AND polyline IS NOT NULL`,
    [req.athleteId]
  );
  for (const a of acts) {
    const pts = decodePolyline(a.polyline);
    if (!pts.length) continue;
    // départ, milieu puis fin : robuste aux départs côtiers ou en mer
    let c = null;
    for (const i of [0, Math.floor(pts.length / 2), pts.length - 1]) {
      c = countryOf(pts[i][1], pts[i][0]);
      if (c) break;
    }
    if (!c) continue;
    const b = bucket(c);
    b.km += (a.distance_m || 0) / 1000;
    b.activities++;
  }
  const out = [...byCountry.values()]
    .map((c) => ({ ...c, pct: (100 * c.area_km2) / c.country_km2 }))
    .sort((a, b) => b.pct - a.pct);
  res.json(out);
});

// Top public pour l'écran d'accueil (prénom + initiale, sans auth)
app.get("/api/leaderboard/public", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.firstname, a.lastname,
       (SELECT count(*)::int FROM tiles t WHERE t.athlete_id=a.id) AS tiles
     FROM athletes a ORDER BY tiles DESC, a.id LIMIT 5`
  );
  const { rows: n } = await pool.query("SELECT count(*)::int AS n FROM athletes");
  res.json({
    top: rows
      .filter((r) => r.tiles > 0)
      .map((r) => ({
        name: `${r.firstname || ""} ${(r.lastname || "").slice(0, 1)}${r.lastname ? "." : ""}`.trim(),
        tiles: r.tiles,
      })),
    players: n[0].n,
  });
});

// Classement global joueurs : top 10 + ta position, en % du leader
app.get("/api/leaderboard", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.firstname, a.lastname,
       (SELECT count(*)::int FROM tiles t WHERE t.athlete_id=a.id) AS tiles
     FROM athletes a
     ORDER BY tiles DESC, a.id
     LIMIT 100`
  );
  const top = rows.slice(0, 10);
  const rank = rows.findIndex((r) => Number(r.id) === req.athleteId) + 1;
  const me = rows.find((r) => Number(r.id) === req.athleteId) || null;
  res.json({ top, total: rows.length, me: me ? { ...me, rank } : null });
});

// Classement clans : somme des cases des membres
app.get("/api/leaderboard/clans", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, count(m.athlete_id)::int AS members,
       coalesce(sum((SELECT count(*) FROM tiles t WHERE t.athlete_id=m.athlete_id)),0)::int AS tiles
     FROM clans c LEFT JOIN clan_members m ON m.clan_id = c.id
     GROUP BY c.id, c.name
     ORDER BY tiles DESC, c.id
     LIMIT 10`
  );
  res.json(rows);
});

// Turf war : carte du territoire partagé, colorée par propriétaire.
// Chaque case z14 a un seul propriétaire (le dernier l'ayant capturée).
app.get("/api/territory", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.z, t.x, t.y, t.owner_id, a.firstname, a.lastname
     FROM territory t JOIN athletes a ON a.id = t.owner_id`
  );
  res.json({
    type: "FeatureCollection",
    features: rows.map((t) => ({
      type: "Feature",
      properties: {
        owner: Number(t.owner_id),
        name: `${t.firstname || ""} ${t.lastname || ""}`.trim(),
        mine: Number(t.owner_id) === req.athleteId,
      },
      geometry: { type: "Polygon", coordinates: tileToPolygon(t.x, t.y, t.z) },
    })),
  });
});

// Recalcule le territoire de l'athlète depuis ses traces déjà stockées
// (sans re-solliciter Strava) : sert à peupler la carte à la 1re ouverture.
app.post("/api/territory/refresh", requireAuth, async (req, res) => {
  await captureTerritory(req.athleteId);
  res.json({ ok: true });
});

// Classement territoire : surface détenue par athlète (cases + km²)
app.get("/api/leaderboard/territory", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.owner_id, a.firstname, a.lastname, t.x, t.y, t.z
     FROM territory t JOIN athletes a ON a.id = t.owner_id`
  );
  const by = new Map();
  for (const t of rows) {
    const id = Number(t.owner_id);
    if (!by.has(id))
      by.set(id, { id, name: `${t.firstname || ""} ${t.lastname || ""}`.trim(), tiles: 0, area_km2: 0 });
    const o = by.get(id);
    o.tiles++;
    o.area_km2 += tileAreaKm2(t.x, t.y, t.z);
  }
  const out = [...by.values()].sort((a, b) => b.tiles - a.tiles);
  const rank = out.findIndex((o) => o.id === req.athleteId) + 1;
  res.json({ top: out.slice(0, 10), me: rank ? { ...out[rank - 1], rank } : null, total: out.length });
});

// Sports réellement présents dans l'historique (pour les chips de filtre)
app.get("/api/sports", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sport_type, count(*)::int AS n FROM activities
     WHERE athlete_id=$1 AND sport_type IS NOT NULL
     GROUP BY sport_type ORDER BY n DESC`,
    [req.athleteId]
  );
  res.json(rows);
});

// Tuiles capturées -> GeoJSON pour MapLibre (avec le sport de capture).
// ?since=YYYY-MM-DD : recalcule les cases depuis les traces des activités
// de la période (ex. depuis le 1er janvier), sans toucher à l'historique.
app.get("/api/tiles", requireAuth, async (req, res) => {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || "")
    ? req.query.since
    : null;
  if (since) {
    const { rows } = await pool.query(
      `SELECT sport_type, polyline FROM activities
       WHERE athlete_id=$1 AND polyline IS NOT NULL AND start_date >= $2`,
      [req.athleteId, since]
    );
    const byTile = new Map(); // "x:y" -> Set des sports
    for (const a of rows) {
      const sport = a.sport_type || "Autre";
      for (const key of tilesForTrack(decodePolyline(a.polyline))) {
        if (!byTile.has(key)) byTile.set(key, new Set());
        byTile.get(key).add(sport);
      }
    }
    return res.json({
      type: "FeatureCollection",
      features: [...byTile].map(([key, sports]) => {
        const [x, y] = key.split(":").map(Number);
        const arr = [...sports].sort();
        return {
          type: "Feature",
          properties: { sport: arr[0], sports: arr },
          geometry: { type: "Polygon", coordinates: tileToPolygon(x, y, ZOOM) },
        };
      }),
    });
  }
  const { rows } = await pool.query(
    "SELECT z, x, y, sport_type, sports, enclave FROM tiles WHERE athlete_id=$1",
    [req.athleteId]
  );
  res.json({
    type: "FeatureCollection",
    features: rows.map((t) => ({
      type: "Feature",
      properties: t.enclave
        ? { enclave: true, sports: [] }
        : {
            sport: t.sport_type || "Autre",
            sports: t.sports?.length ? t.sports : [t.sport_type || "Autre"],
          },
      geometry: { type: "Polygon", coordinates: tileToPolygon(t.x, t.y, t.z) },
    })),
  });
});

// --- Clans ---
app.post("/api/clans", requireAuth, async (req, res) => {
  const name = (req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name_required" });
  const code = crypto.randomBytes(4).toString("hex");
  const { rows } = await pool.query(
    "INSERT INTO clans (name, invite_code, created_by) VALUES ($1,$2,$3) RETURNING id, name, invite_code",
    [name, code, req.athleteId]
  );
  // Un athlète n'appartient qu'à un clan à la fois : sinon ses cases
  // comptent dans chaque clan (classement faussé) et « mon clan » devient
  // non déterministe. On quitte l'ancien avant de rejoindre le nouveau.
  await pool.query("DELETE FROM clan_members WHERE athlete_id=$1", [req.athleteId]);
  await pool.query(
    "INSERT INTO clan_members (clan_id, athlete_id) VALUES ($1,$2)",
    [rows[0].id, req.athleteId]
  );
  res.json(rows[0]);
});

app.post("/api/clans/join", requireAuth, async (req, res) => {
  const code = (req.body?.code || "").trim();
  const { rows } = await pool.query(
    "SELECT id, name FROM clans WHERE invite_code=$1",
    [code]
  );
  if (!rows.length) return res.status(404).json({ error: "unknown_code" });
  await pool.query("DELETE FROM clan_members WHERE athlete_id=$1", [req.athleteId]);
  await pool.query(
    "INSERT INTO clan_members (clan_id, athlete_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [rows[0].id, req.athleteId]
  );
  res.json(rows[0]);
});

// Mon clan + classement : metric = km | tiles
app.get("/api/clans/me", requireAuth, async (req, res) => {
  const { rows: cl } = await pool.query(
    `SELECT c.id, c.name, c.invite_code FROM clans c
     JOIN clan_members m ON m.clan_id = c.id
     WHERE m.athlete_id=$1 ORDER BY m.joined_at DESC LIMIT 1`,
    [req.athleteId]
  );
  if (!cl.length) return res.json(null);
  const clan = cl[0];
  const { rows: board } = await pool.query(
    `SELECT a.id, a.firstname, a.lastname,
       coalesce((SELECT sum(distance_m) FROM activities WHERE athlete_id=a.id),0)::float AS km_m,
       (SELECT count(*)::int FROM tiles WHERE athlete_id=a.id) AS tiles
     FROM clan_members m JOIN athletes a ON a.id = m.athlete_id
     WHERE m.clan_id=$1`,
    [clan.id]
  );
  res.json({ ...clan, members: board });
});

// Traces des activités (polylines encodées, décodées côté client)
app.get("/api/activities", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, sport_type, start_date, distance_m, polyline
     FROM activities WHERE athlete_id=$1 AND polyline IS NOT NULL
     ORDER BY start_date DESC LIMIT 2000`,
    [req.athleteId]
  );
  res.json(rows);
});

// --- Webhook Strava ---
// Validation de l'abonnement (GET avec hub.challenge)
app.get("/webhook/strava", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === (process.env.STRAVA_VERIFY_TOKEN || "")
  ) {
    return res.json({ "hub.challenge": req.query["hub.challenge"] });
  }
  res.sendStatus(403);
});

// Événements : nouvelle activité -> on la traite automatiquement
app.post("/webhook/strava", async (req, res) => {
  res.sendStatus(200); // répondre vite, traiter ensuite
  const ev = req.body;
  try {
    if (ev?.object_type === "activity" && ev.aspect_type === "create") {
      await enqueueSingleActivity(Number(ev.owner_id), Number(ev.object_id));
    }
  } catch (e) {
    console.error("webhook:", e.message);
  }
});

// Middleware d'erreur : renvoie 500 propre au lieu de laisser pendre la
// requête (les rejets async y arrivent via l'enrobage ci-dessus).
app.use((err, req, res, next) => {
  console.error("route:", err.message);
  if (!res.headersSent) res.status(500).json({ error: "server" });
});

// Filet de sécurité ultime : on log au lieu de crasher sur un rejet ou une
// exception échappée (worker de sync, callback…), pour tenir en démo.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// --- Démarrage ---
await migrate();
// Les cases encerclées ne comptent plus dans la carte perso : on purge les
// lignes enclave (les cases encerclées y avaient été versées avec le même
// flag) puis on ressème aussitôt les petites enclaves légitimes (lacs…,
// fillEnclaves plafonné à 20 cases). Idempotent, quelques ms par athlète.
{
  const { rows: allAthletes } = await pool.query("SELECT id FROM athletes");
  await pool.query("DELETE FROM tiles WHERE enclave");
  for (const a of allAthletes) {
    await fillEnclaves(Number(a.id)).catch((e) => console.error("enclaves:", e.message));
  }
}
await resumeInterrupted();
app.listen(PORT, () => console.log(`Territoires sur :${PORT}`));
