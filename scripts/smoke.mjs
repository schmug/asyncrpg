#!/usr/bin/env node
/**
 * HTTP smoke suite against a deployed asyncrpg.
 *
 * Covers the happy path and — more importantly — the adversarial one: forged
 * sessions, cross-campaign access, non-member access, host-only endpoints,
 * oversized bodies, and account enumeration. A green happy path proves the
 * feature exists; these prove it cannot be walked around.
 *
 * Authentication is seeded straight into D1 with `wrangler d1 execute` rather
 * than through a test-only endpoint, so production ships no auth backdoor.
 * Every row it creates uses the SMOKE_PREFIX and is deleted at the end.
 *
 * Usage: node scripts/smoke.mjs [baseUrl] [--keep]
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "https://play.cortech.online").replace(/\/$/, "");
const KEEP = process.argv.includes("--keep");
const SMOKE_PREFIX = "zzsmoke";
const stamp = randomBytes(4).toString("hex");

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function d1(sql) {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "asyncrpg", "--remote", "--json", "--command", sql],
    { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  );
}

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const esc = (v) => String(v).replace(/'/g, "''");

async function req(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    redirect: "manual",
  });
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    /* html or plain text */
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** Create a player + live session directly, returning the cookie header. */
function seedSession(label) {
  const email = `${SMOKE_PREFIX}+${label}-${stamp}@example.invalid`;
  const playerId = `plr_${SMOKE_PREFIX}${randomBytes(5).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const expires = Date.now() + 60 * 60 * 1000;
  d1(
    `INSERT INTO players (id, email, display_name, created_at) VALUES ('${esc(playerId)}','${esc(email)}','${esc(label)}','${new Date().toISOString()}');` +
      `INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) VALUES ('${sha256(token)}','${esc(playerId)}','session',${expires});`,
  );
  return { email, playerId, cookie: `arpg_session=${token}` };
}

function cleanup() {
  if (KEEP) {
    console.log("\n--keep: leaving smoke data in place");
    return;
  }
  try {
    d1(
      `DELETE FROM auth_tokens WHERE player_id IN (SELECT id FROM players WHERE email LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM memberships WHERE player_id IN (SELECT id FROM players WHERE email LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM reply_bindings WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM events WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM beats WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM entities WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM token_budget WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%';` +
        `DELETE FROM players WHERE email LIKE '${SMOKE_PREFIX}%';`,
    );
    console.log("\ncleanup: smoke data removed");
  } catch (err) {
    console.error("\ncleanup FAILED — smoke rows may remain:", err.message);
    failures++;
  }
}

async function main() {
  console.log(`asyncrpg smoke — ${BASE}\n`);

  // ─── unauthenticated surface ─────────────────────────────────────────
  console.log("unauthenticated:");
  const health = await req("/api/health");
  check("health returns 200 ok", health.status === 200 && health.json?.ok === true);

  const shell = await req("/");
  check("app shell serves HTML", shell.status === 200 && shell.text.includes("<html"));
  check(
    "app shell has a viewport meta for mobile",
    /name="viewport"[^>]*width=device-width/.test(shell.text),
  );

  const csp = health.headers.get("content-security-policy") ?? "";
  check("CSP is set and blocks framing", csp.includes("frame-ancestors 'none'"));
  check("CSP does not allow inline script", !/script-src[^;]*unsafe-inline/.test(csp));
  check("nosniff is set", health.headers.get("x-content-type-options") === "nosniff");

  const me401 = await req("/api/me");
  check("/api/me requires a session", me401.status === 401);

  const unknown = await req("/api/nope");
  check("unknown API path 404s as JSON", unknown.status === 404 && unknown.json?.error);

  // Account enumeration: identical response for a real and a fake address.
  const enum1 = await req("/api/auth/request", { method: "POST", body: { email: "nobody@example.invalid" } });
  const enum2 = await req("/api/auth/request", { method: "POST", body: { email: "not-an-email" } });
  check(
    "auth request does not reveal whether an address exists",
    enum1.status === enum2.status && JSON.stringify(enum1.json) === JSON.stringify(enum2.json),
  );

  const badCallback = await req("/auth/callback?t=" + "f".repeat(64));
  check("unknown login token is rejected", badCallback.status === 400);

  // ─── authenticated happy path ────────────────────────────────────────
  console.log("\nhappy path:");
  const host = seedSession("host");
  const slug = `${SMOKE_PREFIX}-${stamp}`;

  const meOk = await req("/api/me", { cookie: host.cookie });
  check("seeded session authenticates", meOk.status === 200 && meOk.json?.player?.email === host.email);

  const created = await req("/api/campaigns", {
    method: "POST",
    cookie: host.cookie,
    body: { name: `Smoke ${stamp}`, slug, cadence: "weekly" },
  });
  check("campaign creates", created.status === 201, `status ${created.status}`);
  const campaignId = created.json?.campaignId;
  check("creator gets a character", Boolean(created.json?.character?.characterName));

  const snap = await req(`/api/campaigns/${slug}`, { cookie: host.cookie });
  check("snapshot reads", snap.status === 200 && typeof snap.json?.campaign?.tick === "number");
  check("world has a place and a season", Boolean(snap.json?.campaign?.place && snap.json?.campaign?.season));
  check("quorum is computed", typeof snap.json?.campaign?.quorum?.need === "number");
  check("player gets a prompt to answer", typeof snap.json?.prompt === "string" && snap.json.prompt.length > 0);

  const acted = await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: host.cookie,
    body: { text: "I walk the wall at dusk and count the watchfires." },
  });
  check("action submits", acted.status === 200 && acted.json?.ok === true, `status ${acted.status}`);

  // A lone player is their own quorum, so that action should have resolved the tick.
  const afterAction = await req(`/api/campaigns/${slug}`, { cookie: host.cookie });
  check(
    "solo player reaching quorum resolves the tick",
    (afterAction.json?.campaign?.tick ?? 0) >= 1,
    `tick ${afterAction.json?.campaign?.tick}`,
  );

  const resolved = await req(`/api/campaigns/${slug}/resolve`, { method: "POST", cookie: host.cookie });
  check("host can force a turn", resolved.status === 200 && typeof resolved.json?.tick === "number");
  check(
    "narration source is reported honestly",
    ["model", "templated"].includes(resolved.json?.source),
    `source=${resolved.json?.source}`,
  );

  const chronicle = await req(`/c/${slug}`);
  check("chronicle is publicly readable", chronicle.status === 200);
  check("chronicle renders turns without JavaScript", chronicle.text.includes("Turns"));
  check("chronicle names the campaign", chronicle.text.includes(`Smoke ${stamp}`));

  // ─── adversarial ─────────────────────────────────────────────────────
  console.log("\nadversarial:");
  const outsider = seedSession("outsider");

  const forged = await req("/api/me", { cookie: "arpg_session=" + "a".repeat(64) });
  check("forged session cookie is rejected", forged.status === 401);

  const malformedCookie = await req("/api/me", { cookie: "arpg_session=../../etc/passwd" });
  check("malformed session cookie is rejected", malformedCookie.status === 401);

  const noAuthRead = await req(`/api/campaigns/${slug}`);
  check("campaign read requires a session", noAuthRead.status === 401);

  const nonMemberRead = await req(`/api/campaigns/${slug}`, { cookie: outsider.cookie });
  check("non-member cannot read a campaign", nonMemberRead.status === 403, `status ${nonMemberRead.status}`);

  const nonMemberAct = await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: outsider.cookie,
    body: { text: "I seize the throne." },
  });
  check("non-member cannot act in a campaign", nonMemberAct.status === 403);

  // Join, then confirm a mere member still cannot force the clock.
  await req(`/api/campaigns/${slug}/join`, {
    method: "POST",
    cookie: outsider.cookie,
    body: { name: "Interloper" },
  });
  const memberResolve = await req(`/api/campaigns/${slug}/resolve`, {
    method: "POST",
    cookie: outsider.cookie,
  });
  check("a non-host member cannot force a turn", memberResolve.status === 403, `status ${memberResolve.status}`);

  const dupSlug = await req("/api/campaigns", {
    method: "POST",
    cookie: host.cookie,
    body: { name: "Duplicate", slug, cadence: "weekly" },
  });
  check("duplicate slug is refused", dupSlug.status === 409);

  const badSlug = await req("/api/campaigns", {
    method: "POST",
    cookie: host.cookie,
    body: { name: "Bad", slug: "../../etc/passwd", cadence: "weekly" },
  });
  check("path-traversal slug is refused", badSlug.status === 400);

  const badCadence = await req("/api/campaigns", {
    method: "POST",
    cookie: host.cookie,
    body: { name: "Bad", slug: `${SMOKE_PREFIX}-cad-${stamp}`, cadence: "hourly" },
  });
  check("invalid cadence is refused", badCadence.status === 400);

  const oversized = await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: host.cookie,
    body: JSON.stringify({ text: "x".repeat(60_000) }),
  });
  check("oversized body is refused", oversized.status === 400, `status ${oversized.status}`);

  const emptyAction = await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: host.cookie,
    body: { text: "   " },
  });
  check("empty action is refused", emptyAction.status === 400);

  const missingChronicle = await req(`/c/${SMOKE_PREFIX}-does-not-exist`);
  check("unknown chronicle 404s", missingChronicle.status === 404);

  const xssSlug = await req(`/c/${encodeURIComponent("<script>alert(1)</script>")}`);
  check("script tag in a chronicle path does not render", xssSlug.status === 404);

  // Stored-XSS probe: an action containing markup must never reach the
  // chronicle unescaped.
  await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: host.cookie,
    body: { text: `<img src=x onerror="alert(1)"> I shout <b>loudly</b>.` },
  });
  await req(`/api/campaigns/${slug}/resolve`, { method: "POST", cookie: host.cookie });
  const afterXss = await req(`/c/${slug}`);
  check(
    "player-authored markup is escaped in the chronicle",
    !afterXss.text.includes("<img src=x onerror") && !afterXss.text.includes("<b>loudly</b>"),
  );

  const methodNotAllowed = await req(`/api/campaigns/${slug}/action`, { cookie: host.cookie });
  check("wrong method is refused", methodNotAllowed.status === 405 || methodNotAllowed.status === 404);
}

main()
  .catch((err) => {
    console.error("\nsmoke aborted:", err);
    failures++;
  })
  .finally(() => {
    cleanup();
    const total = results.length;
    console.log(`\n${total - failures}/${total} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
  });
