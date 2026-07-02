import pg from "pg";

// Clever Cloud injecte POSTGRESQL_ADDON_URI automatiquement quand l'addon est lié
const connectionString =
  process.env.POSTGRESQL_ADDON_URI || process.env.DATABASE_URL;

if (!connectionString) {
  console.error("POSTGRESQL_ADDON_URI manquant. Lie un addon PostgreSQL.");
  process.exit(1);
}

export const pool = new pg.Pool({ connectionString, max: 5 });

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS athletes (
      id BIGINT PRIMARY KEY,
      firstname TEXT,
      lastname TEXT,
      profile TEXT,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'idle', -- idle | queued | syncing | done | error
      sync_done INT NOT NULL DEFAULT 0,
      sync_total INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS activities (
      id BIGINT PRIMARY KEY,
      athlete_id BIGINT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      name TEXT,
      sport_type TEXT,
      start_date TIMESTAMPTZ,
      distance_m DOUBLE PRECISION,
      polyline TEXT,
      processed BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS idx_activities_athlete ON activities(athlete_id);
    CREATE INDEX IF NOT EXISTS idx_activities_pending ON activities(athlete_id) WHERE NOT processed;

    CREATE TABLE IF NOT EXISTS tiles (
      athlete_id BIGINT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      z INT NOT NULL,
      x INT NOT NULL,
      y INT NOT NULL,
      first_activity_id BIGINT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (athlete_id, z, x, y)
    );
    ALTER TABLE tiles ADD COLUMN IF NOT EXISTS sport_type TEXT;
    ALTER TABLE tiles ADD COLUMN IF NOT EXISTS sports TEXT[];
    UPDATE tiles SET sports = ARRAY[sport_type] WHERE sports IS NULL AND sport_type IS NOT NULL;

    CREATE TABLE IF NOT EXISTS clans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_by BIGINT REFERENCES athletes(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS clan_members (
      clan_id INT NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
      athlete_id BIGINT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (clan_id, athlete_id)
    );
  `);
  console.log("Schéma OK");
}
