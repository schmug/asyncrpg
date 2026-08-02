#!/usr/bin/env node
/**
 * Email path verification against production.
 *
 * WHAT THIS COVERS
 *   The outbound half, for real. A `reply_bindings` row is written only after
 *   `env.EMAIL.send()` returns without throwing, so the presence of a row with
 *   a Message-ID is evidence that Cloudflare Email Sending accepted the
 *   message for the campaign's real recipients — not that a function was
 *   called. It also verifies the routing rule is installed and points at this
 *   Worker, and that bindings are looked up by the same keys the inbound
 *   handler uses.
 *
 * WHAT THIS DOES NOT COVER, AND WHY
 *   The inbound SMTP hop. Proving it end to end requires a mailbox that can
 *   receive at a Cloudflare-verified destination and be read back
 *   programmatically; there isn't one available to this harness, and pointing
 *   test mail at the domain owner's real forwarding address is not acceptable.
 *   The inbound handler is instead covered by integration tests that run the
 *   real exported `email()` function over real MIME fixtures against a real
 *   database — see test/integration/email-handler.test.ts. That is genuine
 *   coverage of the parsing, authorization, and rejection logic; it is not
 *   proof that Cloudflare delivers to it.
 *
 * This distinction is stated rather than blurred: a harness that implies more
 * coverage than it has is worse than one that admits the gap.
 *
 * Usage: node scripts/email-e2e.mjs [baseUrl]
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "https://play.cortech.online").replace(/\/$/, "");
const PREFIX = "zzmail";
const stamp = randomBytes(4).toString("hex");

const results = [];
let failures = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok });
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const esc = (v) => String(v).replace(/'/g, "''");

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout: 150_000, stdio: ["ignore", "pipe", "pipe"] });
}
function d1(sql) {
  return run("npx", ["wrangler", "d1", "execute", "asyncrpg", "--remote", "--json", "--command", sql]);
}
function d1Rows(sql) {
  try {
    return JSON.parse(d1(sql))[0]?.results ?? [];
  } catch {
    return [];
  }
}

async function req(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, json, text };
}

function cleanup() {
  try {
    d1(
      `DELETE FROM auth_tokens WHERE player_id IN (SELECT id FROM players WHERE email LIKE 'rpg-sink%');` +
        `DELETE FROM memberships WHERE player_id IN (SELECT id FROM players WHERE email LIKE 'rpg-sink%');` +
        `DELETE FROM reply_bindings WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM events WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM beats WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM entities WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM token_budget WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM invites WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM campaigns WHERE slug LIKE '${PREFIX}%';` +
        `DELETE FROM players WHERE email LIKE 'rpg-sink%';`,
    );
    console.log("\ncleanup: email test data removed");
  } catch (err) {
    console.error("\ncleanup FAILED:", err.message);
    failures++;
  }
}

async function main() {
  console.log(`asyncrpg email path — ${BASE}\n`);

  // ─── routing configuration ───────────────────────────────────────────
  console.log("routing configuration (live Cloudflare state):");
  let rules = "";
  try {
    rules = run("npx", ["wrangler", "email", "routing", "rules", "list", "cortech.online"]);
  } catch (err) {
    rules = String(err.stdout ?? "") + String(err.stderr ?? "");
  }
  check("inbound rule exists for rpg@cortech.online", /to:rpg@cortech\.online/.test(rules));
  check("inbound rule points at this Worker", /worker:asyncrpg/.test(rules));

  // Regression guard: this Worker must not have taken over the zone's
  // pre-existing catch-all, which belongs to an unrelated application.
  check(
    "pre-existing catch-all still routes to agentic-inbox (not hijacked)",
    /Catch-all rule:.*worker:agentic-inbox/.test(rules),
    /Catch-all rule:.*/.exec(rules)?.[0] ?? "no catch-all line found",
  );

  let sending = "";
  try {
    sending = run("npx", ["wrangler", "email", "sending", "list"]);
  } catch (err) {
    sending = String(err.stdout ?? "");
  }
  check("outbound sending is enabled on the mail domain", /cortech\.online.*\byes\b/.test(sending));

  // ─── outbound, for real ──────────────────────────────────────────────
  console.log("\noutbound delivery:");
  const slug = `${PREFIX}-${stamp}`;
  const players = ["alpha", "beta"].map((label) => {
    // A real, deliverable address on a zone we control, routed to `drop`.
    // `.invalid` addresses cannot be delivered to, so Email Sending rejects
    // them and nothing is proved about the outbound path.
    const email = `rpg-sink+${label}-${stamp}@cortech.online`;
    const playerId = `plr_${PREFIX}${randomBytes(5).toString("hex")}`;
    const token = randomBytes(32).toString("hex");
    d1(
      `INSERT INTO players (id, email, display_name, created_at) VALUES ('${esc(playerId)}','${esc(email)}','${esc(label)}','${new Date().toISOString()}');` +
        `INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) VALUES ('${sha256(token)}','${esc(playerId)}','session',${Date.now() + 3600_000});`,
    );
    return { label, email, playerId, cookie: `arpg_session=${token}` };
  });

  const created = await req("/api/campaigns", {
    method: "POST",
    cookie: players[0].cookie,
    body: { name: `Mail ${stamp}`, slug, cadence: "weekly" },
  });
  check("campaign created for the mail test", created.status === 201, `status ${created.status}`);
  const campaignId = created.json?.campaignId;

  // Joining is invite-only, so the second player has to be invited in — the
  // same path a real group uses.
  const invite = await req(`/api/campaigns/${slug}/invite`, { method: "POST", cookie: players[0].cookie });
  check("host can mint an invite for the mail test", invite.status === 200, `status ${invite.status}`);
  const token = (invite.json?.url ?? "").split("/join/")[1] ?? "";
  const joined = await req("/api/join", {
    method: "POST",
    cookie: players[1].cookie,
    body: { token, name: "Beta" },
  });
  check("second player joined by invitation", joined.status === 200, `status ${joined.status}`);

  await req(`/api/campaigns/${slug}/action`, {
    method: "POST",
    cookie: players[0].cookie,
    body: { text: "I send word ahead to the next town." },
  });
  await req(`/api/campaigns/${slug}/resolve`, { method: "POST", cookie: players[0].cookie });

  // Fan-out runs detached via waitUntil, so poll rather than assume.
  let bindings = [];
  for (let i = 0; i < 20 && bindings.length === 0; i++) {
    bindings = d1Rows(
      `SELECT code, message_id, player_id, tick FROM reply_bindings WHERE campaign_id='${esc(campaignId)}'`,
    );
    if (bindings.length === 0) await new Promise((r) => setTimeout(r, 3000));
  }

  check(
    "outbound send succeeded for every member (binding rows written)",
    bindings.length >= 2,
    `${bindings.length} bindings for 2 members`,
  );
  check(
    "each binding carries a Message-ID for In-Reply-To matching",
    bindings.length > 0 && bindings.every((b) => /@/.test(b.message_id ?? "")),
    bindings[0]?.message_id ?? "none",
  );
  check(
    "each binding carries a short subject code",
    bindings.length > 0 && bindings.every((b) => /^[a-z0-9]{6,16}$/.test(b.code ?? "")),
    bindings[0]?.code ?? "none",
  );
  check(
    "bindings are per-player, not shared",
    new Set(bindings.map((b) => b.player_id)).size === bindings.length,
  );
  check(
    "bindings are addressed to the members of this campaign",
    bindings.every((b) => players.some((p) => p.playerId === b.player_id)),
  );

  // ─── lookup keys the inbound handler relies on ───────────────────────
  console.log("\nbinding lookup (the keys inbound resolution uses):");
  if (bindings.length > 0) {
    const b = bindings[0];
    check(
      "lookup by Message-ID resolves to the right player and tick",
      d1Rows(
        `SELECT player_id, tick FROM reply_bindings WHERE message_id='${esc(b.message_id)}' AND expires_at > ${Date.now()}`,
      )[0]?.player_id === b.player_id,
    );
    check(
      "lookup by subject code resolves to the right player",
      d1Rows(
        `SELECT player_id FROM reply_bindings WHERE code='${esc(b.code)}' AND expires_at > ${Date.now()}`,
      )[0]?.player_id === b.player_id,
    );
    check(
      "an unknown Message-ID resolves to nothing",
      d1Rows(`SELECT player_id FROM reply_bindings WHERE message_id='no-such-id@nowhere'`).length === 0,
    );
  } else {
    check("binding lookup could be exercised", false, "no bindings were written");
  }

  console.log("\nNOT COVERED BY THIS SCRIPT: the inbound SMTP hop.");
  console.log("  Proving it end to end needs a Cloudflare-verified mailbox this harness can read.");
  console.log("  The inbound handler's parsing, authorization, and rejection logic is covered by");
  console.log("  test/integration/email-handler.test.ts, which runs the real exported email()");
  console.log("  function over real MIME fixtures against a real database.");
}

main()
  .catch((err) => {
    console.error("\nemail check aborted:", err.message);
    failures++;
  })
  .finally(() => {
    cleanup();
    console.log(`\n${results.length - failures}/${results.length} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
  });
