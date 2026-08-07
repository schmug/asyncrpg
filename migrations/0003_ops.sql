-- Operational controls the critic found missing.

-- A kill switch that does not require a redeploy.
--
-- The spec promised a global inference disable; there was only a per-campaign
-- token cap. An env var would have needed a deploy to flip, which is the wrong
-- shape for something you reach for when spend is running away right now.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value, updated_at)
  VALUES ('inference_enabled', '1', datetime('now'));

-- Projection failures, recorded rather than swallowed.
--
-- D1 write failures during projection were caught and dropped so a blip could
-- not wedge a tick. That is right, but it meant the public chronicle could
-- drift from canonical DO state with nothing anywhere saying so. Now the drift
-- is a row, visible in the campaign snapshot and repairable via reproject.
CREATE TABLE IF NOT EXISTS projection_failures (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  tick        INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projfail_open
  ON projection_failures(campaign_id) WHERE resolved_at IS NULL;

-- Cheap abuse control on the two unauthenticated-ish surfaces: sign-in
-- requests and action submissions. Counts per (key, minute-bucket).
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket     TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_expiry ON rate_limits(expires_at);
