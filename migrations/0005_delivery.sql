-- Email is the primary channel, which makes a delivery failure a lost turn
-- rather than a log line. Sending already retried once and logged on the second
-- failure, but a total mail outage looked identical to a quiet week: every
-- dashboard green, nobody playing.
--
-- Now each failed beat is a row. It is surfaced to the player it was owed to
-- (so "I never got my email" has an answer in the app rather than in support),
-- cleared when a later beat to the same player succeeds, and countable by the
-- host so an outage is visible while it is happening.
CREATE TABLE IF NOT EXISTS delivery_failures (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  player_id   TEXT NOT NULL,
  tick        INTEGER NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'beat',
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_delivfail_open
  ON delivery_failures(campaign_id, player_id) WHERE resolved_at IS NULL;
