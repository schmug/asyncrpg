-- Invitations.
--
-- Before this, joining a campaign required only knowing its slug — which is in
-- every chronicle URL. A guessable slug was effectively an open door into a
-- private group's game. Joining now requires a capability the host issued.

CREATE TABLE IF NOT EXISTS invites (
  -- Only the hash is stored, so a database read cannot be replayed as an
  -- invitation. The plaintext exists exactly once, in the link the host shares.
  token_hash  TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  created_by  TEXT NOT NULL REFERENCES players(id),
  -- Group invites are normally shared in one thread, so a link is reusable up
  -- to a bound rather than single-use. The bound stops a leaked link from
  -- being an unlimited door.
  max_uses    INTEGER NOT NULL DEFAULT 12,
  uses        INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_campaign ON invites(campaign_id);
CREATE INDEX IF NOT EXISTS idx_invites_expiry ON invites(expires_at);
