/**
 * Magic-link authentication.
 *
 * No passwords: email is already the identity and already the channel, so
 * adding a password would be a second secret to lose for no gain.
 *
 * Only SHA-256 hashes of tokens are stored. A dump of the database cannot be
 * replayed as a login, and login tokens are single-use so a link forwarded or
 * left in a mailbox stops working the moment it is redeemed.
 */

import type { Env } from "./env";

const LOGIN_TTL_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = "arpg_session";

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Short, unambiguous code for email subject lines. No vowels: no accidental words. */
export function shortCode(length = 7): string {
  const alphabet = "23456789bcdfghjkmnpqrstvwxz";
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => alphabet[b % alphabet.length]).join("");
}

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  // Deliberately permissive but structural: exactly one @, non-empty sides,
  // a dot in the domain, no whitespace.
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value)) return null;
  if (value.length > 254) return null;
  return value;
}

/** Title-case an email local part into something usable as a name. */
export function defaultDisplayName(email: string): string {
  const local = (email.split("@")[0] ?? "player").replace(/[._+-]+/g, " ").trim();
  return (
    local
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ")
      .slice(0, 60) || "Player"
  );
}

export async function findOrCreatePlayer(env: Env, email: string): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM players WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = `plr_${randomToken(8)}`;
  await env.DB.prepare(
    "INSERT INTO players (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
  )
    // The local part becomes the default character name if they never set
    // one, and "kestrel" reads as a typo in prose where every other name is
    // capitalised.
    .bind(id, email, defaultDisplayName(email), new Date().toISOString())
    .run();
  return id;
}

/** Mint a single-use login token. Returns the plaintext, which is emailed once. */
export async function mintLoginToken(env: Env, playerId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(
    "INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) VALUES (?, ?, 'login', ?)",
  )
    .bind(await hash(token), playerId, Date.now() + LOGIN_TTL_MS)
    .run();
  return token;
}

/**
 * Redeem a login token for a session. Returns null if unknown, expired, or
 * already used — the three cases are deliberately indistinguishable to the
 * caller so a probe cannot learn which tokens ever existed.
 */
export async function redeemLoginToken(env: Env, token: string): Promise<string | null> {
  const tokenHash = await hash(token);
  const row = await env.DB.prepare(
    "SELECT player_id, expires_at, used_at FROM auth_tokens WHERE token_hash = ? AND purpose = 'login'",
  )
    .bind(tokenHash)
    .first<{ player_id: string; expires_at: number; used_at: number | null }>();

  if (!row || row.used_at !== null || row.expires_at < Date.now()) return null;

  // Mark used atomically: the UPDATE only matches while used_at is still null,
  // so two concurrent redemptions cannot both mint a session.
  const claimed = await env.DB.prepare(
    "UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL",
  )
    .bind(Date.now(), tokenHash)
    .run();
  if (claimed.meta.changes !== 1) return null;

  const session = randomToken();
  await env.DB.prepare(
    "INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) VALUES (?, ?, 'session', ?)",
  )
    .bind(await hash(session), row.player_id, Date.now() + SESSION_TTL_MS)
    .run();
  return session;
}

export interface Session {
  playerId: string;
  email: string;
  displayName: string;
}

export async function sessionFrom(env: Env, request: Request): Promise<Session | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{16,128})`).exec(cookie);
  const token = match?.[1];
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT t.player_id, t.expires_at, p.email, p.display_name
     FROM auth_tokens t JOIN players p ON p.id = t.player_id
     WHERE t.token_hash = ? AND t.purpose = 'session'`,
  )
    .bind(await hash(token))
    .first<{ player_id: string; expires_at: number; email: string; display_name: string }>();

  if (!row || row.expires_at < Date.now()) return null;
  return { playerId: row.player_id, email: row.email, displayName: row.display_name };
}

export async function revokeSession(env: Env, request: Request): Promise<void> {
  const cookie = request.headers.get("cookie") ?? "";
  const token = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]{16,128})`).exec(cookie)?.[1];
  if (!token) return;
  await env.DB.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").bind(await hash(token)).run();
}

export function sessionCookie(token: string, secure = true): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export const clearedCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;

// ─── invitations ─────────────────────────────────────────────────────────

export const INVITE_TTL_DAYS = 30;

/** Mint an invite link. Only the hash is stored; the plaintext is returned once. */
export async function mintInvite(env: Env, campaignId: string, hostId: string): Promise<string> {
  const token = randomToken();
  await env.DB.prepare(
    `INSERT INTO invites (token_hash, campaign_id, created_by, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      await hash(token),
      campaignId,
      hostId,
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
      new Date().toISOString(),
    )
    .run();
  return token;
}

/** Read an invite without consuming it, for the "you've been invited to X" screen. */
export async function peekInvite(
  env: Env,
  token: string,
): Promise<{ campaignId: string; campaignName: string } | null> {
  if (!/^[a-f0-9]{16,128}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT i.campaign_id, c.name FROM invites i JOIN campaigns c ON c.id = i.campaign_id
     WHERE i.token_hash = ? AND i.revoked_at IS NULL AND i.expires_at > ? AND i.uses < i.max_uses`,
  )
    .bind(await hash(token), Date.now())
    .first<{ campaign_id: string; name: string }>();
  return row ? { campaignId: row.campaign_id, campaignName: row.name } : null;
}

/**
 * Consume one use of an invite.
 *
 * The use counter increments in the same statement that checks the bound, so
 * concurrent redemptions cannot together exceed `max_uses`.
 */
export async function redeemInvite(
  env: Env,
  token: string,
): Promise<{ campaignId: string } | null> {
  if (!/^[a-f0-9]{16,128}$/.test(token)) return null;
  const tokenHash = await hash(token);
  const claimed = await env.DB.prepare(
    `UPDATE invites SET uses = uses + 1
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? AND uses < max_uses`,
  )
    .bind(tokenHash, Date.now())
    .run();
  if (claimed.meta.changes !== 1) return null;

  const row = await env.DB.prepare("SELECT campaign_id FROM invites WHERE token_hash = ?")
    .bind(tokenHash)
    .first<{ campaign_id: string }>();
  return row ? { campaignId: row.campaign_id } : null;
}

/** Best-effort cleanup so the token table does not grow forever. */
export async function purgeExpiredTokens(env: Env): Promise<void> {
  try {
    await env.DB.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").bind(Date.now()).run();
    await env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(Date.now()).run();
    await env.DB.prepare("DELETE FROM reply_bindings WHERE expires_at < ?").bind(Date.now()).run();
  } catch {
    /* housekeeping only */
  }
}
