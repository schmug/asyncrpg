#!/usr/bin/env node
/**
 * Email path verification against production — now including the inbound hop.
 *
 * WHAT THIS COVERS
 *   The full round trip through real Cloudflare Email Routing, across two
 *   independent zones:
 *
 *     1. the game sends a beat to a reserved mailbox on q-r.contact
 *     2. Email Routing delivers it back to the Worker            (real hop #1)
 *     3. the loopback records it and replies to rpg@cortech.online
 *     4. Email Routing delivers that to the Worker               (real hop #2)
 *     5. normal inbound handling submits the action
 *
 *   Every assertion below is on bytes that actually traversed Cloudflare's
 *   mail path. Earlier versions of this script could only prove the outbound
 *   half and said so; that gap is now closed.
 *
 *   Also still covers: the outbound half in isolation. A `reply_bindings` row is written only after
 *   `env.EMAIL.send()` returns without throwing, so the presence of a row with
 *   a Message-ID is evidence that Cloudflare Email Sending accepted the
 *   message for the campaign's real recipients — not that a function was
 *   called. It also verifies the routing rule is installed and points at this
 *   Worker, and that bindings are looked up by the same keys the inbound
 *   handler uses.
 *
 * STILL NOT COVERED
 *   Delivery to third-party mailboxes (Gmail, Outlook) and their spam
 *   handling. Nothing self-hosted can prove that; it needs seed-list testing.
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
  } catch (err) {
    // Swallowing this made a foreign-key failure look like "no rows", which
    // sent an earlier debugging pass in entirely the wrong direction.
    console.error(`  (d1 query failed: ${String(err.stderr || err.stdout || err.message).slice(0, 200)})`);
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
      `DELETE FROM auth_tokens WHERE player_id IN (SELECT id FROM players WHERE email LIKE 'rpg-sink%' OR email LIKE '%rpgloop%');` +
        `DELETE FROM memberships WHERE player_id IN (SELECT id FROM players WHERE email LIKE 'rpg-sink%' OR email LIKE '%rpgloop%');` +
        `DELETE FROM projection_failures WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM reply_bindings WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM events WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM beats WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM entities WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM token_budget WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM email_loopback WHERE to_address LIKE '%rpgloop%' OR from_address LIKE '%rpgloop%';` +
        `DELETE FROM invites WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${PREFIX}%');` +
        `DELETE FROM campaigns WHERE slug LIKE '${PREFIX}%';` +
        `DELETE FROM players WHERE email LIKE 'rpg-sink%' OR email LIKE '%rpgloop%';`,
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

  // ─── the full round trip, through real SMTP, twice ───────────────────
  console.log("\ninbound hop (real Email Routing, two zones):");

  const LOOPBACK = "rpgloop@q-r.contact";
  const before = Date.now();
  const loopSlug = `${PREFIX}loop-${stamp}`;
  const loopToken = randomBytes(32).toString("hex");
  // INSERT OR REPLACE would delete any existing row for this address, which
  // memberships reference — a foreign-key failure. Insert only if absent, then
  // use whichever id is actually live.
  d1(
    `INSERT OR IGNORE INTO players (id, email, display_name, created_at) ` +
      `VALUES ('plr_${PREFIX}loop', '${esc(LOOPBACK)}', 'Loopback', '${new Date().toISOString()}');`,
  );
  const loopPlayer = d1Rows(`SELECT id FROM players WHERE email = '${esc(LOOPBACK)}'`)[0]?.id;
  if (!loopPlayer) throw new Error("could not seed the loopback player");
  d1(
    `INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) ` +
      `VALUES ('${sha256(loopToken)}','${esc(loopPlayer)}','session',${Date.now() + 3600_000});`,
  );
  const loopCookie = `arpg_session=${loopToken}`;

  const loopCampaign = await req("/api/campaigns", {
    method: "POST",
    cookie: loopCookie,
    body: { name: `Loop ${stamp}`, slug: loopSlug, cadence: "weekly" },
  });
  check("loopback campaign created", loopCampaign.status === 201, `status ${loopCampaign.status}`);
  const loopId = loopCampaign.json?.campaignId;

  // A solo player is their own quorum, so this resolves a tick and mails the
  // beat to the loopback address.
  await req(`/api/campaigns/${loopSlug}/action`, {
    method: "POST",
    cookie: loopCookie,
    body: { text: "I set out at dawn." },
  });

  const waitFor = async (label, sql, timeoutMs = 180_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = d1Rows(sql);
      if (rows.length > 0) return rows;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return [];
  };

  const received = await waitFor(
    "beat delivered",
    `SELECT subject, from_address, message_id FROM email_loopback
     WHERE direction='received' AND created_at > '${new Date(before).toISOString()}'`,
  );
  check(
    "a beat we sent was really delivered back through Email Routing",
    received.length > 0,
    received[0]?.subject?.slice(0, 60) ?? "nothing arrived within 3 minutes",
  );
  // Cloudflare rewrites the envelope sender to a bounce address on mail it
  // sends, so the game's own address appears in the header From, not the
  // envelope. This assertion exists to pin that behaviour down: the inbound
  // handler depends on it.
  check(
    "the delivered beat identifies the game in its header From",
    received.length > 0 && /header: .*dm@/.test(received[0].from_address ?? ""),
    received[0]?.from_address ?? "",
  );
  check(
    "Cloudflare rewrote the envelope sender to a bounce address (why header From is needed)",
    received.length > 0 && /^bounces@cf-bounce/.test(received[0].from_address ?? ""),
    (received[0]?.from_address ?? "").split(" ")[0] ?? "",
  );
  check(
    "the delivered beat carries the subject code used for reply binding",
    received.length > 0 && /#[a-z0-9]{6,16}\]/.test(received[0].subject ?? ""),
    received[0]?.subject?.slice(0, 70) ?? "",
  );

  const replied = await waitFor(
    "loopback replied",
    `SELECT subject FROM email_loopback WHERE direction='replied' AND created_at > '${new Date(before).toISOString()}'`,
    60_000,
  );
  check("the loopback sent a reply back to the game", replied.length > 0);

  // The reply travels back through Email Routing into email(), where normal
  // inbound handling submits it. Its arrival is what proves the inbound hop.
  const landed = await waitFor(
    "inbound action landed",
    `SELECT event_id, summary FROM events
     WHERE campaign_id='${esc(loopId)}' AND kind='player_action'
       AND summary LIKE '%first light%'`,
  );
  check(
    "a reply sent by real email became a turn in the campaign",
    landed.length > 0,
    landed[0]?.summary?.slice(0, 80) ?? "the reply never reached the handler",
  );

  console.log("\nSTILL NOT COVERED: deliverability to third-party mailboxes (Gmail, Outlook)");
  console.log("  and their spam handling — that needs seed-list testing, not a self-test.");
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
