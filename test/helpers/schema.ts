/**
 * Schema for tests that need real D1 tables.
 *
 * The workers test pool gives us a real D1 instance but does not run
 * `migrations/`, so the DDL is restated here. Keep it in sync when a migration
 * adds a column a test reads. Only the tables tests actually touch are
 * included — this is not a mirror of production.
 */

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS players (
     id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE,
     display_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS campaigns (
     id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
     cadence TEXT NOT NULL, quorum_fraction REAL NOT NULL DEFAULT 0.5,
     tick INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER,
     public_chronicle INTEGER NOT NULL DEFAULT 1,
     created_by TEXT NOT NULL, created_at TEXT NOT NULL,
     dm_player_id TEXT, review_window_ms INTEGER,
     dm_missed_windows INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS memberships (
     campaign_id TEXT NOT NULL, player_id TEXT NOT NULL, character_id TEXT NOT NULL,
     character_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
     joined_at TEXT NOT NULL, PRIMARY KEY (campaign_id, player_id))`,
  `CREATE TABLE IF NOT EXISTS beats (
     campaign_id TEXT NOT NULL, tick INTEGER NOT NULL, prose TEXT NOT NULL,
     situation TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_at TEXT NOT NULL,
     published_at TEXT, revised_by TEXT, original_prose TEXT,
     PRIMARY KEY (campaign_id, tick))`,
  `CREATE TABLE IF NOT EXISTS events (
     campaign_id TEXT NOT NULL, event_id TEXT NOT NULL, tick INTEGER NOT NULL,
     kind TEXT NOT NULL, actor_id TEXT, region_id TEXT, summary TEXT NOT NULL,
     significance INTEGER NOT NULL, data TEXT NOT NULL DEFAULT '{}',
     created_at TEXT NOT NULL, PRIMARY KEY (campaign_id, event_id))`,
  `CREATE TABLE IF NOT EXISTS entities (
     campaign_id TEXT NOT NULL, entity_id TEXT NOT NULL, kind TEXT NOT NULL,
     name TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
     PRIMARY KEY (campaign_id, entity_id))`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS token_budget (
     campaign_id TEXT NOT NULL, month TEXT NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (campaign_id, month))`,
  `CREATE TABLE IF NOT EXISTS projection_failures (
     id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, tick INTEGER NOT NULL,
     kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL, resolved_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     bucket TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS auth_tokens (
     token_hash TEXT PRIMARY KEY, player_id TEXT NOT NULL, purpose TEXT NOT NULL,
     expires_at INTEGER NOT NULL, used_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS reply_bindings (
     code TEXT PRIMARY KEY, message_id TEXT NOT NULL, campaign_id TEXT NOT NULL,
     player_id TEXT NOT NULL, tick INTEGER NOT NULL, expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL)`,
];

export async function applySchema(db: D1Database): Promise<void> {
  for (const stmt of STATEMENTS) await db.prepare(stmt).run();
}
