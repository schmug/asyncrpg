-- asyncrpg — D1 read model.
--
-- Canonical world state lives in each campaign's Durable Object. D1 holds the
-- projection: everything that must be queryable across campaigns, or readable
-- by someone who is not logged in, without waking a DO.

CREATE TABLE IF NOT EXISTS players (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  cadence         TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  quorum_fraction REAL NOT NULL DEFAULT 0.5,
  tick            INTEGER NOT NULL DEFAULT 0,
  -- Epoch millis of the current tick deadline. Mirrors the DO's alarm so the
  -- web app can show a countdown without waking the object.
  deadline_at     INTEGER,
  -- Chronicles are readable by anyone with the link when this is 1.
  public_chronicle INTEGER NOT NULL DEFAULT 1,
  created_by      TEXT NOT NULL REFERENCES players(id),
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  player_id     TEXT NOT NULL REFERENCES players(id),
  character_id  TEXT NOT NULL,
  character_name TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player','host')),
  joined_at     TEXT NOT NULL,
  PRIMARY KEY (campaign_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_player ON memberships(player_id);

-- One row per simulation event. This is the chronicle.
CREATE TABLE IF NOT EXISTS events (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  event_id     TEXT NOT NULL,
  tick         INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  actor_id     TEXT,
  region_id    TEXT,
  summary      TEXT NOT NULL,
  significance INTEGER NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  PRIMARY KEY (campaign_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_tick ON events(campaign_id, tick);
CREATE INDEX IF NOT EXISTS idx_events_significance ON events(campaign_id, significance DESC);

-- The narrated beat for each resolved tick.
CREATE TABLE IF NOT EXISTS beats (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  tick        INTEGER NOT NULL,
  prose       TEXT NOT NULL,
  situation   TEXT NOT NULL DEFAULT '',
  -- 'model' or 'templated' — surfaced honestly rather than hidden.
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (campaign_id, tick)
);

-- Entity dossiers, refreshed on each tick, so the chronicle can render
-- "who is this?" without replaying the whole event log.
CREATE TABLE IF NOT EXISTS entities (
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  entity_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  data        TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (campaign_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_entities_kind ON entities(campaign_id, kind);

-- Per-campaign monthly inference spend. Exceeding the cap degrades narration
-- to templated prose; it never blocks a tick.
CREATE TABLE IF NOT EXISTS token_budget (
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  month         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, month)
);

-- Magic-link login. Only the hash is stored, so a database read cannot be
-- replayed as a login.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  player_id  TEXT NOT NULL REFERENCES players(id),
  purpose    TEXT NOT NULL CHECK (purpose IN ('login','session')),
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_expiry ON auth_tokens(expires_at);

-- Binds an inbound email reply to (campaign, player, tick).
--
-- The obvious design — an HMAC in the address, `play+<token>@` — does not fit:
-- RFC 5321 caps a local part at 64 octets, and Cloudflare subaddressing is a
-- zone-wide setting we will not flip on a zone that already has an unrelated
-- catch-all worker. So the binding rides on the message instead of the address:
--   1. `message_id` — the Message-ID we sent. Replies echo it in In-Reply-To.
--      Invisible to the player and the primary path.
--   2. `code` — a short code in the subject line, for clients that drop
--      threading headers or players who compose a fresh mail.
-- Either match identifies the tick; the envelope sender must still match the
-- player, so neither alone is sufficient to act as someone else.
CREATE TABLE IF NOT EXISTS reply_bindings (
  code        TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  player_id   TEXT NOT NULL REFERENCES players(id),
  tick        INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reply_message_id ON reply_bindings(message_id);
CREATE INDEX IF NOT EXISTS idx_reply_expiry ON reply_bindings(expires_at);

-- Deep play: things to do between ticks that never disadvantage anyone who
-- skips them.
CREATE TABLE IF NOT EXISTS downtime (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  character_id TEXT NOT NULL,
  tick         INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  outcome      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downtime_campaign ON downtime(campaign_id, tick);

CREATE TABLE IF NOT EXISTS letters (
  id            TEXT PRIMARY KEY,
  campaign_id   TEXT NOT NULL REFERENCES campaigns(id),
  from_character TEXT NOT NULL,
  to_character  TEXT NOT NULL,
  tick          INTEGER NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_letters_campaign ON letters(campaign_id, tick);

CREATE TABLE IF NOT EXISTS journals (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  character_id TEXT NOT NULL,
  tick         INTEGER NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_journals_campaign ON journals(campaign_id, tick);
