import express from "express";
import compression from "compression";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import { pool, migrate, once } from "./lib/db.js";
import { authorizeUrl, exchangeCode, getValidToken } from "./lib/strava.js";
import {
  enqueueFullSync,
  enqueueSingleActivity,
  resumeInterrupted,
  captureTerritory,
  deleteAthleteData,
  removeActivity,
  repairCapturedAt,
} from "./lib/sync.js";
import { tileToPolygon, tilesForTrack, decodePolyline, tileAreaKm2, tileRowAreaKm2, tileCenter, ZOOM } from "./lib/tiles.js";
import { countryOf } from "./lib/countries.js";
import { geocodePendingTiles } from "./lib/places.js";

// L'auth repose entièrement sur le cookie signé : sans secret propre, on
// refuse de démarrer (comme db.js pour l'URI) plutôt que d'utiliser un
// secret public qui rendrait les sessions forgeables.
if (!process.env.APP_SECRET) {
  console.error("APP_SECRET manquant. clever env set APP_SECRET \"$(openssl rand -hex 32)\"");
  process.exit(1);
}

const app = express();
app.disable("x-powered-by");
// en-têtes de sécurité de base (pas de CSP : unpkg/Fonts/OSM à inventorier)
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
// gzip : /api/tiles et /api/activities renvoient des Mo de GeoJSON et de
// polylines, texte répétitif qui compresse très bien
app.use(compression());
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

const countriesCache = new Map(); // athleteId -> { key, data } (voir /api/countries)

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
      `INSERT INTO athletes (id, firstname, lastname, profile, sex, access_token, refresh_token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET
         firstname=EXCLUDED.firstname, lastname=EXCLUDED.lastname, profile=EXCLUDED.profile,
         sex=coalesce(EXCLUDED.sex, athletes.sex),
         access_token=EXCLUDED.access_token, refresh_token=EXCLUDED.refresh_token,
         expires_at=EXCLUDED.expires_at`,
      [a.id, a.firstname, a.lastname, a.profile, a.sex || null, t.access_token, t.refresh_token, t.expires_at]
    );
    res.cookie("aid", String(a.id), {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: BASE_URL.startsWith("https"), // jamais en clair hors dev local
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

// Droit à l'effacement (accord API Strava) : révoque le token côté Strava
// puis supprime toutes les données de l'athlète.
app.post("/api/me/delete", requireAuth, async (req, res) => {
  try {
    const token = await getValidToken(req.athleteId);
    await fetch("https://www.strava.com/oauth/deauthorize", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    // token déjà invalide/révoqué : on supprime quand même nos données
    console.error("deauthorize:", e.message);
  }
  await deleteAthleteData(req.athleteId);
  res.clearCookie("aid");
  res.json({ ok: true });
});

// --- API ---
const sexBackfillTried = new Set(); // un seul essai par athlète et par process
app.get("/api/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, firstname, lastname, profile, sex, sync_status, sync_done, sync_total
     FROM athletes WHERE id=$1`,
    [req.athleteId]
  );
  if (!rows.length) return res.status(401).json({ error: "unknown" });
  const me = rows[0];
  // Connexion = synchronisation : si la sync n'a jamais abouti (jamais
  // lancée, ou terminée en erreur), on la relance automatiquement à
  // l'ouverture de l'app — personne ne doit avoir à chercher un bouton
  // pour voir sa carte. Les statuts queued/syncing/done ne relancent rien.
  if (me.sync_status === "idle" || me.sync_status === "error") {
    enqueueFullSync(req.athleteId);
    me.sync_status = "queued";
  }
  // comptes connectés avant l'ajout de la colonne : on récupère le sexe
  // une fois auprès de Strava, sans exiger de reconnexion
  if (!me.sex && !sexBackfillTried.has(req.athleteId)) {
    sexBackfillTried.add(req.athleteId);
    try {
      const token = await getValidToken(req.athleteId);
      const r = await fetch("https://www.strava.com/api/v3/athlete", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) {
        const a = await r.json();
        if (a.sex) {
          await pool.query("UPDATE athletes SET sex=$1 WHERE id=$2", [a.sex, req.athleteId]);
          me.sex = a.sex;
        }
      }
    } catch (e) {
      console.error("sex backfill:", e.message);
    }
  }
  res.json(me);
});

app.post("/api/sync", requireAuth, (req, res) => {
  enqueueFullSync(req.athleteId);
  countriesCache.delete(req.athleteId);
  res.json({ ok: true });
});

// ?since=YYYY-MM-DD : stats de la période (activités filtrées, cases
// recalculées depuis les polylines, comme /api/tiles?since)
app.get("/api/stats", requireAuth, async (req, res) => {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || "")
    ? req.query.since
    : null;
  if (since) {
    // une seule requête : le count et la somme se déduisent des lignes
    const { rows: acts } = await pool.query(
      `SELECT distance_m, polyline FROM activities
       WHERE athlete_id=$1 AND start_date >= $2`,
      [req.athleteId, since]
    );
    const distance_m = acts.reduce((t, a) => t + (a.distance_m || 0), 0);
    const keys = new Set();
    for (const a of acts)
      if (a.polyline)
        for (const k of tilesForTrack(decodePolyline(a.polyline))) keys.add(k);
    let area_km2 = 0;
    for (const k of keys) {
      const [x, y] = k.split(":").map(Number);
      area_km2 += tileAreaKm2(x, y, ZOOM);
    }
    return res.json({ activities: acts.length, distance_m, tiles: keys.size, area_km2, period: since });
  }
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM tiles WHERE athlete_id=$1) AS tiles,
       (SELECT count(*)::int FROM activities WHERE athlete_id=$1) AS activities,
       (SELECT coalesce(sum(distance_m),0) FROM activities WHERE athlete_id=$1) AS distance_m`,
    [req.athleteId]
  );
  // La surface d'une case ne dépend que de sa latitude (donc de y) : on
  // agrège par (z, y) côté SQL — quelques centaines de lignes au lieu de
  // dizaines de milliers.
  const { rows: byY } = await pool.query(
    "SELECT z, y, count(*)::int AS n FROM tiles WHERE athlete_id=$1 GROUP BY z, y",
    [req.athleteId]
  );
  const area_km2 = byY.reduce((a, r) => a + r.n * tileRowAreaKm2(r.y, r.z), 0);

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

// Répartition par pays : cases, km², % du pays conquis, km parcourus.
// Le calcul décode toutes les polylines et fait du point-dans-polygone à
// chaque appel : on met le résultat en cache, invalidé quand (nb cases,
// nb activités AVEC trace) bouge — compter les polylines non nulles couvre
// le backfill d'une activité webhook qui ne crée aucune nouvelle case —
// et invalidé explicitement par le webhook et les resyncs.
app.get("/api/countries", requireAuth, async (req, res) => {
  const { rows: v } = await pool.query(
    `SELECT (SELECT count(*) FROM tiles WHERE athlete_id=$1) || ':' ||
            (SELECT count(*) FROM activities WHERE athlete_id=$1 AND polyline IS NOT NULL) AS key`,
    [req.athleteId]
  );
  const hit = countriesCache.get(req.athleteId);
  if (hit && hit.key === v[0].key) return res.json(hit.data);

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
  if (countriesCache.size > 500) countriesCache.delete(countriesCache.keys().next().value); // borne mémoire (FIFO)
  countriesCache.set(req.athleteId, { key: v[0].key, data: out });
  res.json(out);
});

// Carte publique de l'accueil : le territoire conquis, ANONYMISÉ — les
// polygones et un index de propriétaire opaque (pour varier les couleurs),
// aucun nom ni identifiant réel (conformité affichage Strava).
app.get("/api/territory/public", async (req, res) => {
  const { rows } = await pool.query("SELECT z, x, y, owner_id FROM territory");
  const idx = new Map(); // owner_id -> index anonyme, stable dans la réponse
  res.json({
    type: "FeatureCollection",
    features: rows.map((t) => {
      if (!idx.has(t.owner_id)) idx.set(t.owner_id, idx.size);
      return {
        type: "Feature",
        properties: { o: idx.get(t.owner_id) },
        geometry: { type: "Polygon", coordinates: tileToPolygon(t.x, t.y, t.z) },
      };
    }),
  });
});

// Top public pour l'écran d'accueil (prénom + initiale, sans auth)
app.get("/api/leaderboard/public", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.firstname, a.lastname, a.sex, count(*) OVER ()::int AS players,
       (SELECT count(*)::int FROM tiles t WHERE t.athlete_id=a.id) AS tiles
     FROM athletes a ORDER BY tiles DESC, a.id LIMIT 5`
  );
  res.json({
    top: rows
      .filter((r) => r.tiles > 0)
      .map((r) => ({
        name: `${r.firstname || ""} ${(r.lastname || "").slice(0, 1)}${r.lastname ? "." : ""}`.trim(),
        tiles: r.tiles,
        sex: r.sex,
      })),
    players: rows.length ? rows[0].players : 0,
  });
});

// Classement global joueurs : top 10 + ta position, en % du leader
app.get("/api/leaderboard", requireAuth, async (req, res) => {
  // ?since=YYYY-MM-DD : mode SAISON — seules comptent les cases dont la
  // première conquête date de la période (les gros historiques repartent
  // de zéro chaque année, comme tout le monde)
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || "")
    ? req.query.since
    : null;
  const { rows } = await pool.query(
    since
      ? `SELECT a.id, a.firstname, a.lastname, a.sex,
           (SELECT count(*)::int FROM tiles t
              JOIN activities act ON act.id = t.first_activity_id
            WHERE t.athlete_id = a.id AND act.start_date >= $1) AS tiles
         FROM athletes a
         ORDER BY tiles DESC, a.id
         LIMIT 100`
      : `SELECT a.id, a.firstname, a.lastname, a.sex,
           (SELECT count(*)::int FROM tiles t WHERE t.athlete_id=a.id) AS tiles
         FROM athletes a
         ORDER BY tiles DESC, a.id
         LIMIT 100`,
    since ? [since] : []
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
// Chaque case raconte son histoire : propriétaire, clan, date de prise,
// à qui elle a été volée, commune — le clic sur la carte affiche tout.
app.get("/api/territory", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.z, t.x, t.y, t.owner_id, t.captured_at, a.firstname, a.lastname,
            sf.firstname AS sf_firstname, sf.lastname AS sf_lastname,
            cm.clan_id, c.name AS clan_name, p.city
     FROM territory t
     JOIN athletes a ON a.id = t.owner_id
     LEFT JOIN athletes sf ON sf.id = t.stolen_from
     LEFT JOIN clan_members cm ON cm.athlete_id = t.owner_id
     LEFT JOIN clans c ON c.id = cm.clan_id
     LEFT JOIN tile_places p ON p.z = t.z AND p.x = t.x AND p.y = t.y`
  );
  const short = (f, l) => (f || l ? `${f || ""} ${(l || "").slice(0, 1)}${l ? "." : ""}`.trim() : null);
  res.json({
    type: "FeatureCollection",
    features: rows.map((t) => ({
      type: "Feature",
      properties: {
        owner: Number(t.owner_id),
        name: `${t.firstname || ""} ${t.lastname || ""}`.trim(),
        mine: Number(t.owner_id) === req.athleteId,
        capturedAt: t.captured_at,
        stolenFrom: short(t.sf_firstname, t.sf_lastname),
        clan: t.clan_id ? Number(t.clan_id) : null,
        clanName: t.clan_name || null,
        city: t.city || null,
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
    `SELECT t.owner_id, a.firstname, a.lastname, a.sex, t.z, t.y, count(*)::int AS n
     FROM territory t JOIN athletes a ON a.id = t.owner_id
     GROUP BY t.owner_id, a.firstname, a.lastname, a.sex, t.z, t.y`
  );
  const by = new Map();
  for (const t of rows) {
    const id = Number(t.owner_id);
    if (!by.has(id))
      by.set(id, { id, name: `${t.firstname || ""} ${t.lastname || ""}`.trim(), sex: t.sex, tiles: 0, area_km2: 0 });
    const o = by.get(id);
    o.tiles += t.n;
    o.area_km2 += t.n * tileRowAreaKm2(t.y, t.z);
  }
  const out = [...by.values()].sort((a, b) => b.tiles - a.tiles);
  const rank = out.findIndex((o) => o.id === req.athleteId) + 1;
  // cases qui M'ont été volées cette semaine : le rappel qui fait ressortir le vélo
  const { rows: lost } = await pool.query(
    `SELECT count(*)::int AS n FROM territory
     WHERE stolen_from = $1 AND owner_id <> $1 AND captured_at >= date_trunc('week', now())`,
    [req.athleteId]
  );
  res.json({
    top: out.slice(0, 10),
    me: rank ? { ...out[rank - 1], rank, lost_week: lost[0].n } : null,
    total: out.length,
  });
});

// Mes villes (cases perso par commune) + le « Roi » de chaque ville :
// le plus gros détenteur sur la carte partagée (turf war).
app.get("/api/cities", requireAuth, async (req, res) => {
  const { rows: mine } = await pool.query(
    `SELECT p.city, count(*)::int AS tiles
     FROM tiles t JOIN tile_places p ON p.z = t.z AND p.x = t.x AND p.y = t.y
     WHERE t.athlete_id = $1 AND p.city <> ''
     GROUP BY p.city
     ORDER BY tiles DESC
     LIMIT 100`,
    [req.athleteId]
  );
  const { rows: kings } = await pool.query(
    `SELECT DISTINCT ON (city) city, owner_id, firstname, lastname, n FROM (
       SELECT p.city, te.owner_id, a.firstname, a.lastname, count(*)::int AS n
       FROM territory te
       JOIN tile_places p ON p.z = te.z AND p.x = te.x AND p.y = te.y
       JOIN athletes a ON a.id = te.owner_id
       WHERE p.city <> ''
       GROUP BY p.city, te.owner_id, a.firstname, a.lastname
     ) sub
     ORDER BY city, n DESC, owner_id`
  );
  const kingBy = new Map(kings.map((k) => [k.city, k]));
  // avancement du géocodage : le client affiche « en cours » si incomplet
  const { rows: prog } = await pool.query(
    `SELECT (SELECT count(*) FROM territory)::int AS total,
            (SELECT count(*) FROM territory te
             WHERE EXISTS (SELECT 1 FROM tile_places p WHERE p.z=te.z AND p.x=te.x AND p.y=te.y))::int AS geocoded`
  );
  res.json({
    geocoding: prog[0].geocoded < prog[0].total,
    cities: mine.map((c) => {
      const k = kingBy.get(c.city);
      return {
        city: c.city,
        tiles: c.tiles,
        king: k
          ? {
              id: Number(k.owner_id),
              name: `${k.firstname || ""} ${(k.lastname || "").slice(0, 1)}${k.lastname ? "." : ""}`.trim(),
              tiles: k.n,
            }
          : null,
      };
    }),
  });
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

// Lignes tiles -> FeatureCollection MapLibre (partagé avec la vue coéquipier)
function tilesToGeoJSON(rows) {
  return {
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
  };
}

// Carte d'un coéquipier : visible uniquement entre membres du MÊME clan
// (contrôle côté serveur, pas seulement à l'affichage).
app.get("/api/clans/member/:id/tiles", requireAuth, async (req, res) => {
  const otherId = Number(req.params.id);
  const { rows: same } = await pool.query(
    `SELECT 1 FROM clan_members m1
     JOIN clan_members m2 ON m2.clan_id = m1.clan_id
     WHERE m1.athlete_id = $1 AND m2.athlete_id = $2 LIMIT 1`,
    [req.athleteId, otherId]
  );
  if (!same.length) return res.status(403).json({ error: "not_clanmate" });
  const { rows } = await pool.query(
    "SELECT z, x, y, sport_type, sports, enclave FROM tiles WHERE athlete_id=$1",
    [otherId]
  );
  res.json(tilesToGeoJSON(rows));
});

// Nom d'un clan par code d'invitation (lien de parrainage, avant connexion)
app.get("/api/clans/info", async (req, res) => {
  const code = (req.query.code || "").trim();
  if (!code) return res.json(null);
  const { rows } = await pool.query("SELECT name FROM clans WHERE invite_code=$1", [code]);
  res.json(rows.length ? { name: rows[0].name } : null);
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
  res.json(tilesToGeoJSON(rows));
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
    `SELECT a.id, a.firstname, a.lastname, a.sex,
       coalesce((SELECT sum(distance_m) FROM activities WHERE athlete_id=a.id),0)::float AS km_m,
       (SELECT count(*)::int FROM tiles WHERE athlete_id=a.id) AS tiles
     FROM clan_members m JOIN athletes a ON a.id = m.athlete_id
     WHERE m.clan_id=$1`,
    [clan.id]
  );
  // Tops hebdo (depuis lundi) : km, plus longue sortie, nouvelles cases
  // (première conquête), territoire pris — pour dynamiser le clan au-delà
  // des totaux cumulés.
  const { rows: weekly } = await pool.query(
    `SELECT a.id, a.firstname, a.lastname, a.sex,
       coalesce(sum(act.distance_m), 0)::float AS week_m,
       coalesce(max(act.distance_m), 0)::float AS longest_m,
       (SELECT count(*)::int FROM tiles t JOIN activities fa ON fa.id = t.first_activity_id
         WHERE t.athlete_id = a.id AND fa.start_date >= date_trunc('week', now())) AS new_tiles,
       (SELECT count(*)::int FROM territory te
         WHERE te.owner_id = a.id AND te.captured_at >= date_trunc('week', now())) AS territory,
       (SELECT count(*)::int FROM territory te
         WHERE te.owner_id = a.id AND te.stolen_from IS NOT NULL AND te.stolen_from <> a.id
           AND te.captured_at >= date_trunc('week', now())) AS stolen
     FROM clan_members m
     JOIN athletes a ON a.id = m.athlete_id
     LEFT JOIN activities act ON act.athlete_id = a.id AND act.start_date >= date_trunc('week', now())
     WHERE m.clan_id=$1
     GROUP BY a.id, a.firstname, a.lastname, a.sex`,
    [clan.id]
  );
  res.json({ ...clan, members: board, weekly });
});

// Traces des activités (polylines encodées, décodées côté client)
app.get("/api/activities", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT sport_type, start_date, polyline
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

// Événements : création traitée automatiquement ; conformité accord API :
// suppression et passage en privé d'une activité sont répercutés, et la
// révocation de l'accès (settings/apps sur Strava) efface toutes les
// données de l'athlète.
const WEBHOOK_SUB_ID = Number(process.env.STRAVA_SUBSCRIPTION_ID || 0);
app.post("/webhook/strava", async (req, res) => {
  res.sendStatus(200); // répondre vite, traiter ensuite
  const ev = req.body;
  // Sans contrôle, n'importe qui pourrait forger un événement authorized:false
  // et effacer les données d'un athlète : on vérifie l'id d'abonnement Strava.
  if (WEBHOOK_SUB_ID && Number(ev?.subscription_id) !== WEBHOOK_SUB_ID) return;
  // Sans id d'abonnement configuré, les événements DESTRUCTIFS sont refusés
  // (fail-closed) : un POST forgé ne doit jamais pouvoir effacer des données.
  const trusted = WEBHOOK_SUB_ID > 0;
  if (!trusted) console.warn("[webhook] STRAVA_SUBSCRIPTION_ID absent : seuls les 'create' sont acceptés");
  try {
    if (ev?.object_type === "activity") {
      if (ev.aspect_type === "create") {
        await enqueueSingleActivity(Number(ev.owner_id), Number(ev.object_id));
        countriesCache.delete(Number(ev.owner_id));
      } else if (
        trusted &&
        (ev.aspect_type === "delete" ||
          (ev.aspect_type === "update" && ev.updates?.private === "true"))
      ) {
        await removeActivity(Number(ev.owner_id), Number(ev.object_id));
        countriesCache.delete(Number(ev.owner_id));
      }
    } else if (
      trusted &&
      ev?.object_type === "athlete" &&
      ev.aspect_type === "update" &&
      ev.updates?.authorized === "false"
    ) {
      await deleteAthleteData(Number(ev.owner_id));
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
// réparation ponctuelle des dates de prise du territoire (exécutée une
// seule fois par base, marqueur dans app_migrations)
await once("2026-07-repair-territory-captured-at", repairCapturedAt).catch(console.error);
await resumeInterrupted();
geocodePendingTiles(); // rattrapage communes en arrière-plan
app.listen(PORT, () => console.log(`Territoires sur :${PORT}`));
