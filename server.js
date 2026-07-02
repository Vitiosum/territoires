import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { pool, migrate } from "./lib/db.js";
import { authorizeUrl, exchangeCode } from "./lib/strava.js";
import {
  enqueueFullSync,
  enqueueSingleActivity,
  resumeInterrupted,
} from "./lib/sync.js";
import { tileToPolygon } from "./lib/tiles.js";

const app = express();
app.use(express.json());
app.use(cookieParser(process.env.APP_SECRET || "dev-secret"));
app.use(express.static("public"));

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

app.get("/api/stats", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM tiles WHERE athlete_id=$1) AS tiles,
       (SELECT count(*)::int FROM activities WHERE athlete_id=$1) AS activities,
       (SELECT coalesce(sum(distance_m),0) FROM activities WHERE athlete_id=$1) AS distance_m`,
    [req.athleteId]
  );
  res.json(rows[0]);
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

// Tuiles capturées -> GeoJSON pour MapLibre (avec le sport de capture)
app.get("/api/tiles", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT z, x, y, sport_type, sports FROM tiles WHERE athlete_id=$1",
    [req.athleteId]
  );
  res.json({
    type: "FeatureCollection",
    features: rows.map((t) => ({
      type: "Feature",
      properties: {
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
     WHERE m.athlete_id=$1 LIMIT 1`,
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

// --- Démarrage ---
await migrate();
await resumeInterrupted();
app.listen(PORT, () => console.log(`Territoires sur :${PORT}`));

// Petit utilitaire pour créer l'abonnement webhook (voir README)
export function _unused() {
  crypto.randomBytes(1);
}
