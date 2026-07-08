import { pool } from "./db.js";

const STRAVA = "https://www.strava.com/api/v3";
// Un appel Strava qui pend bloquerait la file de sync (mono-worker) jusqu'à
// 5 min (timeout undici par défaut) : on coupe à 15 s, l'erreur tombe dans
// les chemins d'erreur existants.
const TIMEOUT = () => AbortSignal.timeout(15_000);

export function authorizeUrl(baseUrl) {
  const p = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: `${baseUrl}/auth/callback`,
    response_type: "code",
    approval_prompt: "auto",
    scope: "read,activity:read_all",
  });
  return `https://www.strava.com/oauth/authorize?${p}`;
}

export async function exchangeCode(code) {
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: TIMEOUT(),
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`OAuth exchange: ${res.status}`);
  return res.json();
}

// Renvoie un access token valide, rafraîchit si expiré
export async function getValidToken(athleteId) {
  const { rows } = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM athletes WHERE id=$1",
    [athleteId]
  );
  if (!rows.length) throw new Error("Athlète inconnu");
  const a = rows[0];
  const now = Math.floor(Date.now() / 1000);
  if (Number(a.expires_at) > now + 60) return a.access_token;

  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: TIMEOUT(),
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
    }),
  });
  // même contrat que api() : la file de sync re-queue + pause 15 min au
  // lieu de marquer l'athlète en erreur
  if (res.status === 429) {
    const err = new Error("Rate limit Strava (refresh token)");
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Token refresh: ${res.status}`);
  const t = await res.json();
  await pool.query(
    "UPDATE athletes SET access_token=$1, refresh_token=$2, expires_at=$3 WHERE id=$4",
    [t.access_token, t.refresh_token, t.expires_at, athleteId]
  );
  return t.access_token;
}

async function api(athleteId, path) {
  const token = await getValidToken(athleteId);
  const res = await fetch(`${STRAVA}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: TIMEOUT(),
  });
  if (res.status === 429) {
    const err = new Error("Rate limit Strava");
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) throw new Error(`Strava ${path}: ${res.status}`);
  return res.json();
}

export function fetchActivitiesPage(athleteId, page, perPage = 200) {
  return api(athleteId, `/athlete/activities?page=${page}&per_page=${perPage}`);
}

// Détail d'une activité (webhook) : métadonnées + polyline en 1 requête
export async function fetchActivity(athleteId, activityId) {
  try {
    return await api(athleteId, `/activities/${activityId}`);
  } catch (e) {
    // rate limit et timeout sont TRANSITOIRES : on relance la sync plus tard
    // au lieu de marquer l'activité « traitée sans tuiles » définitivement
    if (e.rateLimited || e.name === "TimeoutError" || e.name === "AbortError") throw e;
    return null;
  }
}
