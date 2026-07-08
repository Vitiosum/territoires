import pg from "pg";

// Clever Cloud injecte POSTGRESQL_ADDON_URI automatiquement quand l'addon est lié
const connectionString =
  process.env.POSTGRESQL_ADDON_URI || process.env.DATABASE_URL;

if (!connectionString) {
  console.error("POSTGRESQL_ADDON_URI manquant. Lie un addon PostgreSQL.");
  process.exit(1);
}

// max: 3 — le plan DEV de l'addon PostgreSQL limite les connexions, et
// pendant un déploiement l'ancienne instance garde les siennes ouvertes.
export const pool = new pg.Pool({ connectionString, max: 3 });
pool.on("error", (e) => console.error("pg pool:", e.message));

// Migration ponctuelle : exécutée UNE fois par base (marqueur en table),
// aucune discipline opérateur requise (pas de variable d'env à retirer).
export async function once(key, fn) {
  const { rowCount } = await pool.query(
    "INSERT INTO app_migrations (key) VALUES ($1) ON CONFLICT DO NOTHING",
    [key]
  );
  if (rowCount) {
    console.log(`[migration] ${key}`);
    await fn();
  }
}

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

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
    -- (athlete_id, start_date) : couvre les filtres ?since, les tops hebdo
    -- et le tri de /api/activities — l'index athlete_id seul est redondant
    CREATE INDEX IF NOT EXISTS idx_activities_athlete_date ON activities(athlete_id, start_date DESC);
    DROP INDEX IF EXISTS idx_activities_athlete;
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
    ALTER TABLE athletes ADD COLUMN IF NOT EXISTS sex TEXT; -- 'M' / 'F' (Strava)
    ALTER TABLE tiles ADD COLUMN IF NOT EXISTS sport_type TEXT;
    ALTER TABLE tiles ADD COLUMN IF NOT EXISTS sports TEXT[];
    ALTER TABLE tiles ADD COLUMN IF NOT EXISTS enclave BOOLEAN NOT NULL DEFAULT false;

    -- Territoire partagé (turf war) : une seule case globale par (z,x,y),
    -- détenue par le dernier athlète l'ayant capturée (parcourue ou encerclée).
    CREATE TABLE IF NOT EXISTS territory (
      z INT NOT NULL,
      x INT NOT NULL,
      y INT NOT NULL,
      owner_id BIGINT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
      captured_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (z, x, y)
    );
    CREATE INDEX IF NOT EXISTS idx_territory_owner ON territory(owner_id);
    ALTER TABLE territory ADD COLUMN IF NOT EXISTS stolen_from BIGINT; -- précédent propriétaire (NULL = prise sauvage)

    -- Commune de chaque case (géocodage inverse Nominatim, en tâche de
    -- fond, 1 req/s) ; city = '' quand le point ne tombe dans aucune ville
    CREATE TABLE IF NOT EXISTS tile_places (
      z INT NOT NULL,
      x INT NOT NULL,
      y INT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (z, x, y)
    );

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

    -- Suppression de compte (conformité accord API Strava) : un clan créé
    -- par l'athlète supprimé survit, créateur mis à NULL
    ALTER TABLE clans DROP CONSTRAINT IF EXISTS clans_created_by_fkey;
    ALTER TABLE clans ADD CONSTRAINT clans_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES athletes(id) ON DELETE SET NULL;
  `);
  console.log("Schéma OK");
}
