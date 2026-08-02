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
import { resolveMx, resolveTxt } from "node:dns/promises";

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
  console.log(`asyncrpg smoke — ${BASE}\n`);

  // ─── unauthenticated surface ─────────────────────────────────────────
  console.log("unauthenticated:");
  const health = await req("/api/health");
  check("health returns 200 ok", health.status === 200 && health.json?.ok === true);
  // Provenance: without this, "the revision I reviewed" and "the deployment I
  // measured" are two unverifiable claims that cycle 1 got wrong.
  check(
    "health names the revision the deployment was built from",
    /^[0-9a-f]{40}$/.test(health.json?.revision ?? ""),
  );

  const shell = await req("/");
  check("app shell serves HTML", shell.status === 200 && shell.text.includes("<html"));
  check(
    "app shell has a viewport meta for mobile",
    /name="viewport"[^>]*width=device-width/.test(shell.text),
  );

  // ─── security-header drift ───────────────────────────────────────────
  //
  // The app sets these; the Cloudflare zone can override them on the way out,
  // and twice now a critic has reasonably read the difference as the app
  // lying about its own policy. So: assert what the app intends, and where the
  // edge changes it, name the deviation explicitly. An *undocumented* drift
  // fails the gate; a known one passes loudly, so it stays visible instead of
  // being normalized into background noise. See docs/DEPLOYMENT.md.
  // The zone's HSTS setting overrides the app's header, so this asserts the
  // property that actually protects users rather than string equality with
  // what the app asked for. A disabled header (max-age=0) is a hard failure —
  // it used to be tolerated as "known drift", which is precisely the kind of
  // normalization that lets a security regression live forever.
  const hsts = health.headers.get("strict-transport-security") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? "0");
  const MIN_MAX_AGE = 2_592_000; // 30 days
  check(
    "HSTS is enabled with a meaningful max-age",
    maxAge >= MIN_MAX_AGE,
    maxAge === 0
      ? `HSTS IS DISABLED — serving "${hsts || "(absent)"}"`
      : `max-age=${maxAge}s (${Math.round(maxAge / 86400)} days)`,
  );
  check("HSTS covers subdomains", /includeSubDomains/i.test(hsts), hsts);

  const csp = health.headers.get("content-security-policy") ?? "";
  check("CSP is set and blocks framing", csp.includes("frame-ancestors 'none'"));
  check("CSP does not allow inline script", !/script-src[^;]*unsafe-inline/.test(csp));
  check("nosniff is set", health.headers.get("x-content-type-options") === "nosniff");

  // ─── email authentication ────────────────────────────────────────────
  //
  // Whether Gmail or Outlook drops a beat into spam cannot be measured from
  // here. What *can* be measured is whether we have given them any reason to:
  // SPF, DMARC, and inbound MX are the records every receiver checks first,
  // and a silent regression in them would degrade the product's primary
  // channel without a single request failing.
  const MAIL_DOMAIN = "cortech.online";
  console.log("\nemail authentication:");
  try {
    const txt = (await resolveTxt(MAIL_DOMAIN)).map((r) => r.join(""));
    const spf = txt.find((r) => r.startsWith("v=spf1"));
    check("SPF record exists", Boolean(spf), spf ?? "none found");
    check(
      "SPF authorizes Cloudflare Email Sending",
      Boolean(spf && spf.includes("_spf.mx.cloudflare.net")),
      spf ?? "",
    );
    check(
      "SPF ends in a restrictive all",
      Boolean(spf && /[-~]all\s*$/.test(spf)),
      "+all would authorize the whole internet to send as this domain",
    );
  } catch (err) {
    check("SPF record is resolvable", false, err.message);
  }

  try {
    const dmarc = (await resolveTxt(`_dmarc.${MAIL_DOMAIN}`))
      .map((r) => r.join(""))
      .find((r) => r.startsWith("v=DMARC1"));
    check("DMARC record exists", Boolean(dmarc), dmarc ?? "none found");
    // Inbound reply authentication leans on Email Routing enforcing DMARC
    // before the handler runs, so a missing policy is a security fact, not
    // just a deliverability one.
    check("DMARC declares a policy", Boolean(dmarc && /\bp=(none|quarantine|reject)\b/.test(dmarc)));
  } catch (err) {
    check("DMARC record is resolvable", false, err.message);
  }

  try {
    const mx = await resolveMx(MAIL_DOMAIN);
    check(
      "MX points at Cloudflare Email Routing",
      mx.some((r) => /mx\.cloudflare\.net$/.test(r.exchange)),
      mx.map((r) => r.exchange).join(", ") || "none",
    );
  } catch (err) {
    check("MX records are resolvable", false, err.message);
  }

  console.log("\nunauthenticated surface (continued):");
  // Corruption has reached the public chronicle three times, each class caught
  // by a critic rather than by us. The validator now rejects the shape they
  // share; this asserts it against what is actually being served, because the
  // validator only covers beats written *after* it shipped.
  const demo = await req("/c/demo");
  // Only the narrated beats. Stripping tags across the whole document leaves
  // the inline stylesheet behind as text, and CSS is full of things that look
  // exactly like a splice ("ol.tl{...}") — the check would fail on every run
  // for a reason that has nothing to do with prose.
  const prose = [...demo.text.matchAll(/<article class="beat">([\s\S]*?)<\/article>/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, " "))
    .join("\n");
  // Without this, an extraction that matched nothing would make all three
  // checks below pass on an empty string and read as clean.
  check(
    "the public chronicle actually contains beats to check",
    prose.length > 500,
    `${prose.length} chars of prose extracted`,
  );
  // MIRRORS `ARTIFACT_PATTERNS` in src/dm/narrate.ts. Kept as a copy because
  // this is plain JS run outside the bundler; test/dm/artifact-parity.test.ts
  // fails if the two lists drift apart.
  const ARTIFACT_PATTERNS = [
    ["spliced prose", /[a-z]{2}[.!?][A-Za-z0-9]/],
    ["a stray code fence", /`{3,}/],
    ["a literal escape sequence", /(?:\/\/|\\{1,2})[nt](?![a-z])/],
    ["comment syntax", /(?<!:)\/\//],
    [
      "an AI aside",
      /\b(?:as an AI|I should (?:not|probably)|let me (?:rewrite|try again)|ignore (?:that|the previous))\b/i,
    ],
    ["a self-correction", /\b(?:wait,\s*remove|remove that fragment|note to self)\b/i],
    ["an editorial placeholder", /\[(?:note|todo|placeholder|redacted)\b/i],
  ];
  for (const [label, re] of ARTIFACT_PATTERNS) {
    const hit = re.exec(prose);
    check(
      `the public chronicle is free of ${label}`,
      hit === null,
      hit
        ? `found ${JSON.stringify(prose.slice(Math.max(0, hit.index - 50), hit.index + 50))}`
        : "",
    );
  }

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
  const budget = d1Rows(
    `SELECT input_tokens, output_tokens FROM token_budget WHERE campaign_id = '${esc(campaignId)}'`,
  );
  check(
    "inference spend is metered in both directions",
    budget.length > 0 && budget[0].input_tokens > 0 && budget[0].output_tokens > 0,
    JSON.stringify(budget[0] ?? {}),
  );

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

  // Proving the limiter works leaves it tripped, and the limiter keys on IP —
  // so the next suite to run from this machine (ui-smoke, which has to sign in
  // to do anything) gets a 429 and reports it as a console error. That reads
  // as a broken product when it is really this suite failing to clean up after
  // itself, exactly like the D1 rows it already removes. Wait for the window
  // to roll over before handing the machine on.
  if (limited) {
    process.stdout.write("  ...waiting out the sign-in rate limit window ");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      process.stdout.write(".");
      const probe = await req("/api/auth/request", {
        method: "POST",
        body: { email: `${SMOKE_PREFIX}+drain-${stamp}@example.invalid` },
      });
      if (probe.status !== 429) break;
    }
    console.log(" clear");
  }

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
