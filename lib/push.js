// Notifications push web (VAPID) — nécessite : npm i web-push
// Env : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:toi@…)
import webpush from "web-push";
import { pool } from "./db.js";

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
const enabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (enabled) {
  webpush.setVapidDetails(
    VAPID_SUBJECT || "mailto:contact@example.com",
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn("[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes — push désactivé");
}

export function pushEnabled() {
  return enabled;
}

export async function ensurePushSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      athlete_id BIGINT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `);
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_push_athlete ON push_subscriptions(athlete_id)"
  );
}

// sub = objet PushSubscription.toJSON() envoyé par le navigateur
export async function saveSubscription(athleteId, sub) {
  if (!sub || !sub.endpoint || !sub.keys) throw new Error("subscription invalide");
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, athlete_id, p256dh, auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET
       athlete_id = EXCLUDED.athlete_id,
       p256dh     = EXCLUDED.p256dh,
       auth       = EXCLUDED.auth`,
    [sub.endpoint, athleteId, sub.keys.p256dh, sub.keys.auth]
  );
}

export async function deleteSubscription(endpoint) {
  await pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

// payload : { title, body, tag?, url? } — gardé < 4 Ko
export async function sendToAthlete(athleteId, payload) {
  if (!enabled) return { sent: 0 };
  const { rows } = await pool.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE athlete_id = $1",
    [athleteId]
  );
  const body = JSON.stringify(payload);
  let sent = 0;
  await Promise.allSettled(
    rows.map(async (r) => {
      try {
        await webpush.sendNotification(
          { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
          body,
          { TTL: 3600 }
        );
        sent++;
      } catch (e) {
        // Abonnement expiré ou révoqué : on nettoie
        if (e.statusCode === 404 || e.statusCode === 410) {
          await deleteSubscription(r.endpoint).catch(() => {});
        } else {
          console.error("[push] envoi raté", e.statusCode || e.message);
        }
      }
    })
  );
  return { sent };
}
