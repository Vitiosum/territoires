import { pool } from "./db.js";

const STRAVA = "https://www.strava.com/api/v3";

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
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: a.refresh_token,
    }),
  });
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

// Stream lat/lng d'une activité -> [[lat,lng], ...] ou null si pas de GPS
export async function fetchLatLngStream(athleteId, activityId) {
  try {
    const data = await api(
      athleteId,
      `/activities/${activityId}/streams?keys=latlng&key_by_type=true`
    );
    return data?.latlng?.data ?? null;
  } catch (e) {
    if (e.rateLimited) throw e;
    return null; // activité sans GPS (home trainer, etc.)
  }
}
