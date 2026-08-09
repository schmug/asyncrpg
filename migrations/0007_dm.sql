-- The DM seat, and the review window that gives it something to do.
--
-- The seat is a single column rather than a `memberships.role` value, so
-- "exactly one DM per campaign" is structural rather than something application
-- code has to remember to enforce. `memberships.role` stays vestigial: it is
-- written at join time and read nowhere, authorization lives on
-- `campaigns.created_by` (host) and `campaigns.dm_player_id` (DM), and SQLite
-- cannot alter its CHECK constraint anyway.
ALTER TABLE campaigns ADD COLUMN dm_player_id TEXT REFERENCES players(id);

-- NULL means "use the cadence default" (2h daily / 24h weekly / 72h monthly),
-- so changing cadence does the right thing without a second edit. 0 means
-- publish immediately and let the DM edit afterwards.
ALTER TABLE campaigns ADD COLUMN review_window_ms INTEGER;

-- Consecutive review windows that expired without the DM touching anything.
-- At 3 the seat reverts to the host: going quiet should cost nothing, it should
-- just hand the chair to someone who is there.
ALTER TABLE campaigns ADD COLUMN dm_missed_windows INTEGER NOT NULL DEFAULT 0;

-- NULL = held in DM review, not yet visible to players and not yet mailed.
ALTER TABLE beats ADD COLUMN published_at TEXT;
-- Who rewrote the prose, if anyone. Attribution is the whole accountability
-- story for a DM who also plays a character.
ALTER TABLE beats ADD COLUMN revised_by TEXT REFERENCES players(id);
-- What the model or the template originally wrote, retained so a rewrite is
-- always recoverable.
ALTER TABLE beats ADD COLUMN original_prose TEXT;

-- Without this every beat written before this migration is NULL and therefore
-- "held", which empties the chronicle of every existing campaign.
UPDATE beats SET published_at = created_at WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_beats_published
  ON beats(campaign_id, published_at);
