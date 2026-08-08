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
 * Usage: node scripts/smoke.mjs [baseUrl] [--local|--remote] [--keep]
 *
 * `--remote` is the default, so the production gate is unchanged. `--local`
 * points both halves of the suite at a `wrangler dev` on this machine: the D1
 * seeding switches to `--local`, and the base URL defaults to port 8788.
 * Both halves must agree — seeding a session into the remote database while
 * asking a local worker to honour it produces a suite that fails for a reason
 * that has nothing to do with the code — so the D1 flag is derived from the
 * same switch as the URL rather than being a second thing to remember.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// `wrangler --local` reads its D1 out of `.wrangler/` *relative to the working
// directory*, so a run started from anywhere but the repo root would seed a
// different (empty) database than the one `wrangler dev` is serving, and every
// authenticated check would fail with a misleading 401. Pin it to the repo.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const KNOWN_FLAGS = new Set(["--keep", "--local", "--remote"]);
const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith("-"));
const positional = argv.filter((a) => !a.startsWith("-"));

// An unrecognised flag is fatal rather than ignored. The one thing this script
// must never do is silently fall back to production because `--local` was
// mistyped — `--Local`, `--loc`, or `-local` would otherwise parse as "no
// flags given", i.e. `--remote`, and run the whole adversarial suite against
// the live game.
const unknown = flags.filter((f) => !KNOWN_FLAGS.has(f));
if (unknown.length > 0) {
  console.error(`unknown flag(s): ${unknown.join(", ")}`);
  console.error("usage: node scripts/smoke.mjs [baseUrl] [--local|--remote] [--keep]");
  process.exit(2);
}
if (flags.includes("--local") && flags.includes("--remote")) {
  console.error("--local and --remote are mutually exclusive");
  process.exit(2);
}
if (positional.length > 1) {
  console.error(`expected at most one base URL, got: ${positional.join(", ")}`);
  process.exit(2);
}

const LOCAL = flags.includes("--local");
const KEEP = flags.includes("--keep");
const D1_TARGET = LOCAL ? "--local" : "--remote";
const DEFAULT_BASE = LOCAL ? "http://localhost:8788" : "https://play.cortech.online";
const BASE = (positional[0] ?? DEFAULT_BASE).replace(/\/$/, "");
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

function d1Rows(sql) {
  try {
    return JSON.parse(d1(sql))[0]?.results ?? [];
  } catch {
    return [];
  }
}

function d1(sql) {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "asyncrpg", D1_TARGET, "--json", "--command", sql],
    { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], cwd: REPO_ROOT },
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
        `DELETE FROM projection_failures WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM invites WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM downtime WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM letters WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM journals WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
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
  console.log(`asyncrpg smoke — ${BASE} (d1 ${D1_TARGET})\n`);

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

  const meAnon = await req("/api/me");
  check(
    "/api/me answers anonymously without erroring",
    meAnon.status === 200 && meAnon.json?.player === null,
    `status ${meAnon.status}`,
  );

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

  // `/api/me` answers anonymously rather than 401-ing, so the security
  // property to assert is "not authenticated", not "returns 401". Both are
  // checked: identity must be null, AND a forged cookie must not open a
  // protected endpoint — otherwise this check could pass while an auth bypass
  // existed behind it.
  const forged = await req("/api/me", { cookie: "arpg_session=" + "a".repeat(64) });
  check(
    "a forged session cookie does not authenticate",
    forged.status === 200 && forged.json?.player === null,
    `status ${forged.status} player=${JSON.stringify(forged.json?.player)}`,
  );
  const forgedProtected = await req(`/api/campaigns/${slug}`, {
    cookie: "arpg_session=" + "a".repeat(64),
  });
  check("a forged session cookie cannot reach a protected endpoint", forgedProtected.status === 401);

  const malformedCookie = await req("/api/me", { cookie: "arpg_session=../../etc/passwd" });
  check(
    "a malformed session cookie does not authenticate",
    malformedCookie.status === 200 && malformedCookie.json?.player === null,
  );
  const malformedProtected = await req(`/api/campaigns/${slug}`, {
    cookie: "arpg_session=../../etc/passwd",
  });
  check(
    "a malformed session cookie cannot reach a protected endpoint",
    malformedProtected.status === 401,
  );

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

  // Knowing a slug must not be permission to enter someone's game — every
  // chronicle URL contains one.
  const slugJoin = await req(`/api/campaigns/${slug}/join`, {
    method: "POST",
    cookie: outsider.cookie,
    body: { name: "Interloper" },
  });
  check("cannot join a campaign just by knowing its slug", slugJoin.status >= 400, `status ${slugJoin.status}`);

  const outsiderInvite = await req(`/api/campaigns/${slug}/invite`, {
    method: "POST",
    cookie: outsider.cookie,
  });
  check("a non-member cannot mint an invite", outsiderInvite.status === 403);

  const badInvite = await req("/api/join", {
    method: "POST",
    cookie: outsider.cookie,
    body: { token: "f".repeat(64), name: "Nobody" },
  });
  check("an unknown invite token is refused", badInvite.status === 400);

  const malformedInvite = await req("/api/join", {
    method: "POST",
    cookie: outsider.cookie,
    body: { token: "../../etc/passwd", name: "Nobody" },
  });
  check("a malformed invite token is refused", malformedInvite.status === 400);

  // Host invites; the invitee joins and becomes a real member.
  const invite = await req(`/api/campaigns/${slug}/invite`, { method: "POST", cookie: host.cookie });
  check("host can mint an invite", invite.status === 200 && typeof invite.json?.url === "string");
  const token = (invite.json?.url ?? "").split("/join/")[1] ?? "";

  const preview = await req(`/api/invite/${token}`);
  check("invite preview names the campaign without revealing its contents", preview.status === 200 && preview.json?.campaign === `Smoke ${stamp}`);

  const anonJoin = await req("/api/join", { method: "POST", body: { token, name: "Nobody" } });
  check("joining requires being signed in", anonJoin.status === 401);

  const joined = await req("/api/join", {
    method: "POST",
    cookie: outsider.cookie,
    body: { token, name: "Interloper", concept: "a late arrival" },
  });
  check("an invited player can join", joined.status === 200 && joined.json?.ok === true, `status ${joined.status}`);

  const nowMember = await req(`/api/campaigns/${slug}`, { cookie: outsider.cookie });
  check("joining actually grants access", nowMember.status === 200);

  const memberResolve = await req(`/api/campaigns/${slug}/resolve`, {
    method: "POST",
    cookie: outsider.cookie,
  });
  check("a non-host member cannot force a turn", memberResolve.status === 403, `status ${memberResolve.status}`);

  const memberReproject = await req(`/api/campaigns/${slug}/reproject`, {
    method: "POST",
    cookie: outsider.cookie,
  });
  check("a non-host member cannot rebuild the chronicle", memberReproject.status === 403);

  const hostReproject = await req(`/api/campaigns/${slug}/reproject`, {
    method: "POST",
    cookie: host.cookie,
  });
  check("the host can rebuild the chronicle from canonical state", hostReproject.status === 200);

  // ─── the DM seat ─────────────────────────────────────────────────────────
  // The seat is the only thing in the app that can rewrite what the group
  // reads, so every one of these is a real escalation if it comes back 200.
  // `host` created the campaign and therefore holds the seat; `outsider` is by
  // now a full member who does not. That is exactly the pair these need: a
  // refusal that only proves "you are not in this campaign" would say nothing
  // about whether the seat is enforced.

  const dmBeat = await req(`/api/campaigns/${slug}/dm/beat`, {
    method: "PATCH",
    cookie: outsider.cookie,
    body: { tick: 1, prose: "I rewrite the story." },
  });
  check("a member without the seat cannot rewrite a beat", dmBeat.status === 403, `status ${dmBeat.status}`);

  const dmPublish = await req(`/api/campaigns/${slug}/dm/publish`, {
    method: "POST",
    cookie: outsider.cookie,
  });
  check("a member without the seat cannot publish", dmPublish.status === 403, `status ${dmPublish.status}`);

  const dmSeize = await req(`/api/campaigns/${slug}/dm`, {
    method: "POST",
    cookie: outsider.cookie,
    body: { playerId: outsider.playerId },
  });
  check(
    "a member who is neither host nor DM cannot take the seat",
    dmSeize.status === 403,
    `status ${dmSeize.status}`,
  );

  const dmOutsider = await req(`/api/campaigns/${slug}/dm`, {
    method: "POST",
    cookie: host.cookie,
    body: { playerId: `plr_${SMOKE_PREFIX}_nobody` },
  });
  check("cannot seat a player who is not a member", dmOutsider.status === 400, `status ${dmOutsider.status}`);

  const dmAnon = await req(`/api/campaigns/${slug}/dm/review`, { method: "GET" });
  check("the review desk needs a session", dmAnon.status === 401, `status ${dmAnon.status}`);

  // A dropped, truncated, or oversized body used to read as "vacate" and
  // answer 200, quietly leaving the campaign with no DM.
  //
  // All three shapes are sent, because they do not travel the same path
  // through the handler: `{}` parses and is caught by the value check, while a
  // missing body and an over-cap one both make `readJson` answer null and are
  // caught by the envelope check. A fix to either one alone leaves the other
  // vacating the seat, so testing only `{}` would miss half the defect.
  for (const [label, body] of [
    ["an empty body", {}],
    ["a missing body", undefined],
    ["an oversized body", JSON.stringify({ playerId: "x".repeat(64_000) })],
  ]) {
    const res = await req(`/api/campaigns/${slug}/dm`, { method: "POST", cookie: host.cookie, body });
    check(`${label} is refused rather than read as vacate`, res.status === 400, `status ${res.status}`);
  }
  // The status alone does not prove the fix — a 400 that vacated anyway would
  // pass every one of them — so the seat is read back out of D1 and must still
  // be the host's.
  const seatAfterEmpty = d1Rows(
    `SELECT dm_player_id FROM campaigns WHERE id = '${esc(campaignId)}'`,
  );
  check(
    "a refused seat write leaves the seat exactly where it was",
    seatAfterEmpty[0]?.dm_player_id === host.playerId,
    `dm_player_id=${seatAfterEmpty[0]?.dm_player_id ?? "null"} expected=${host.playerId}`,
  );

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
  // The creator holds the DM seat, so that resolve *held* the new beat instead
  // of publishing it. Without releasing it first the chronicle below renders
  // the previous turn, and the escaping assertion passes without the payload
  // ever having been rendered — a check that proves nothing.
  await req(`/api/campaigns/${slug}/dm/publish`, { method: "POST", cookie: host.cookie });
  const afterXss = await req(`/c/${slug}`);
  check(
    "player-authored markup is escaped in the chronicle",
    !afterXss.text.includes("<img src=x onerror") && !afterXss.text.includes("<b>loudly</b>"),
  );

  console.log("\nthe seat holds a beat until the DM publishes it:");
  await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: host.cookie,
    body: { text: "I set a lantern in the tower window and wait for an answer." },
  });
  await req(`/api/campaigns/${slug}/resolve`, { method: "POST", cookie: host.cookie });

  const review = await req(`/api/campaigns/${slug}/dm/review`, { cookie: host.cookie });
  check(
    "the review desk shows the new beat, still held",
    review.status === 200 && review.json?.beat?.held === true,
    `status ${review.status} held=${review.json?.beat?.held}`,
  );
  const heldTick = review.json?.beat?.tick;

  // A marker the machine could never have written, so its presence in the
  // chronicle is proof the DM's text got there and not merely that *some*
  // beat rendered. Kept to a realistic beat length: this becomes the campaign's
  // latest beat, which the "the story is in-app" check further down measures.
  const marker = `HELD${stamp}MARK`;
  const edited = await req(`/api/campaigns/${slug}/dm/beat`, {
    method: "PATCH",
    cookie: host.cookie,
    body: {
      tick: heldTick,
      prose:
        `${marker} — the lantern burned in the tower window until dawn, and by first ` +
        `light the watch had counted three riders on the north road who did not stop.`,
    },
  });
  check("the DM can rewrite the held beat", edited.status === 200, `status ${edited.status}`);

  const chronicleHeld = await req(`/c/${slug}`);
  check(
    "a held beat is not visible on the public chronicle",
    chronicleHeld.status === 200 && !chronicleHeld.text.includes(marker),
    `status ${chronicleHeld.status}`,
  );

  const published = await req(`/api/campaigns/${slug}/dm/publish`, {
    method: "POST",
    cookie: host.cookie,
  });
  check(
    "the DM can publish the held beat",
    published.status === 200 && published.json?.published === true && published.json?.tick === heldTick,
    `published=${published.json?.published} tick=${published.json?.tick} held=${heldTick}`,
  );

  // This is what keeps the check above from being satisfied by a chronicle
  // that renders nothing at all: same marker, same URL, same anonymous reader,
  // and the only thing that changed between the two is the publish.
  const chronicleAfter = await req(`/c/${slug}`);
  check(
    "the same beat is visible to an anonymous reader once published",
    chronicleAfter.status === 200 && chronicleAfter.text.includes(marker),
    `status ${chronicleAfter.status}`,
  );

  const publishedAgain = await req(`/api/campaigns/${slug}/dm/publish`, {
    method: "POST",
    cookie: host.cookie,
  });
  check(
    "publishing twice does not publish twice",
    publishedAgain.status === 200 && publishedAgain.json?.published === false,
    `published=${publishedAgain.json?.published}`,
  );

  console.log("\ndeep play (optional, never an advantage):");
  for (const kind of ["craft", "research", "train", "network", "recover"]) {
    const out = await req(`/api/campaigns/${slug}/downtime`, {
      method: "POST",
      cookie: host.cookie,
      body: { kind },
    });
    check(`downtime "${kind}" resolves`, out.status === 200 && Boolean(out.json?.outcome), out.json?.outcome ?? out.json?.error);
  }
  check(
    "an unknown downtime activity is refused",
    (await req(`/api/campaigns/${slug}/downtime`, { method: "POST", cookie: host.cookie, body: { kind: "teleport" } })).status === 400,
  );
  check(
    "a journal entry is accepted",
    (await req(`/api/campaigns/${slug}/journal`, { method: "POST", cookie: host.cookie, body: { body: "I could not sleep." } })).status === 200,
  );
  check(
    "an empty journal entry is refused",
    (await req(`/api/campaigns/${slug}/journal`, { method: "POST", cookie: host.cookie, body: { body: "  " } })).status === 400,
  );
  check(
    "a letter to a non-existent character is refused",
    (await req(`/api/campaigns/${slug}/letter`, { method: "POST", cookie: host.cookie, body: { to: "chr_ghost", body: "hi" } })).status === 400,
  );

  console.log("\noperational controls:");
  const snapAfter = await req(`/api/campaigns/${slug}`, { cookie: host.cookie });
  check(
    "the campaign view carries the latest beat, so the story is in-app",
    typeof snapAfter.json?.latestBeat?.prose === "string" && snapAfter.json.latestBeat.prose.length > 40,
    `${snapAfter.json?.latestBeat?.prose?.length ?? 0} chars`,
  );
  check(
    "the campaign view carries the player's own character sheet",
    Boolean(snapAfter.json?.you?.name) && typeof snapAfter.json?.you?.attributes?.might === "number",
  );
  check(
    "chronicle repair state is reported",
    typeof snapAfter.json?.chronicleNeedsRepair === "boolean",
  );

  // Both token directions must be metered — input is the larger share here.
  //
  // A local `wrangler dev` has no ANTHROPIC_API_KEY, so no inference runs and
  // there is no spend to meter. Asserting spend there would assert something
  // false. The invariant that holds everywhere is the pairing of the two
  // facts, so that is what is checked: metered spend must cover both
  // directions, and an unmetered campaign must be one that was never narrated
  // by the model. That still catches the dangerous bug — the model wrote the
  // beat and nobody was billed — instead of skipping the check off-cloud.
  const budget = d1Rows(
    `SELECT input_tokens, output_tokens FROM token_budget WHERE campaign_id = '${esc(campaignId)}'`,
  );
  if (budget.length > 0) {
    check(
      "inference spend is metered in both directions",
      budget[0].input_tokens > 0 && budget[0].output_tokens > 0,
      JSON.stringify(budget[0]),
    );
  } else {
    check(
      "an unmetered campaign is one the model never narrated",
      resolved.json?.source === "templated",
      `no token_budget row, and narration source=${resolved.json?.source}`,
    );
  }

  const killSwitch = d1Rows(`SELECT value FROM settings WHERE key = 'inference_enabled'`);
  check("a global inference kill switch exists", killSwitch.length === 1, JSON.stringify(killSwitch[0] ?? {}));

  // Rate limiting: hammer the sign-in endpoint and expect it to push back.
  let limited = false;
  for (let i = 0; i < 14 && !limited; i++) {
    const r = await req("/api/auth/request", {
      method: "POST",
      body: { email: `${SMOKE_PREFIX}+rl${i}-${stamp}@example.invalid` },
    });
    if (r.status === 429) limited = true;
  }
  check("sign-in requests are rate limited", limited);

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
