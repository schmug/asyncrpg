#!/usr/bin/env node
/**
 * Seed a public demo campaign with several turns of real play.
 *
 * Exists so the chronicle can be judged on actual prose rather than on a
 * promise that prose would appear. Idempotent: re-running resets the demo.
 *
 * Usage: node scripts/seed-demo.mjs [baseUrl] [--slug demo] [--ticks 6]
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "https://play.cortech.online").replace(/\/$/, "");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const SLUG = arg("slug", "demo");
const TICKS = Number.parseInt(arg("ticks", "6"), 10);

/**
 * A local dev server is backed by the local D1, not the deployed one.
 *
 * The flag has to follow the target or the seed is worse than useless: the
 * players and their sessions land in the remote database while the HTTP calls
 * that drive the play go to `wrangler dev`, which authenticates nobody — and
 * the reset below, which is what makes re-running idempotent, deletes the
 * *deployed* demo on its way past.
 */
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE);

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const esc = (v) => String(v).replace(/'/g, "''");

function d1(sql) {
  return execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      "asyncrpg",
      LOCAL ? "--local" : "--remote",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/**
 * Demo players use `.invalid` addresses (RFC 2606 — guaranteed never to
 * resolve), so the fan-out cannot deliver mail to a real stranger.
 */
const CAST = [
  { label: "kestrel", name: "Kestrel Vane", concept: "a courier who reads the letters she carries" },
  { label: "bram", name: "Bram Ashfoot", concept: "a hedge-doctor with a debt he will not name" },
  { label: "sela", name: "Sela of the Weir", concept: "a marsh guide who trusts water over people" },
];

const SCRIPT = [
  ["I ask around the market for anyone who remembers the old road being closed.", "I check the stores and count what's actually left.", "I walk the waterline looking for tracks that don't belong."],
  ["I go and speak to whoever holds authority here, politely, and ask what they want from us.", "I set up where the sick can find me and start listening to what people say while I work.", "I take the high ground before dusk and watch the approach."],
  ["I press harder — someone knows more than they're saying.", "I trade for medicine, and I overpay if I have to.", "I follow the tracks out past the last field."],
  ["I try to get the two sides talking before this turns into something.", "I tend whoever got hurt, whichever side they're on.", "I go back for a second look at what I found."],
  ["I stand between them and refuse to move.", "I keep working. Someone has to.", "I put myself between the danger and the town."],
  ["I write down everything that happened while it's fresh.", "I sit with the ones who lost someone.", "I check the water one more time before I sleep."],
];

function seedPlayer(label, displayName) {
  const email = `demo+${label}@example.invalid`;
  const playerId = `plr_demo${label}`;
  const token = randomBytes(32).toString("hex");
  d1(
    `INSERT OR REPLACE INTO players (id, email, display_name, created_at) VALUES ('${esc(playerId)}','${esc(email)}','${esc(displayName)}','${new Date().toISOString()}');` +
      `INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) VALUES ('${sha256(token)}','${esc(playerId)}','session',${Date.now() + 3600_000});`,
  );
  return { playerId, cookie: `arpg_session=${token}` };
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

async function main() {
  console.log(`seeding demo "${SLUG}" on ${BASE}\n`);

  // Reset so re-running is idempotent.
  d1(
    `DELETE FROM auth_tokens WHERE player_id LIKE 'plr_demo%';` +
      `DELETE FROM memberships WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM events WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM beats WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM entities WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM reply_bindings WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM token_budget WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM invites WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM downtime WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM letters WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM journals WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug='${esc(SLUG)}');` +
      `DELETE FROM campaigns WHERE slug='${esc(SLUG)}';`,
  );

  const players = CAST.map((c) => ({ ...c, ...seedPlayer(c.label, c.name) }));
  const host = players[0];

  const created = await req("/api/campaigns", {
    method: "POST",
    cookie: host.cookie,
    body: { name: "The Long Thaw", slug: SLUG, cadence: "weekly" },
  });
  if (created.status !== 201) throw new Error(`create failed: ${created.status} ${created.text}`);
  console.log(`created campaign ${SLUG}`);

  // Joining is invite-only, so the demo walks the same path a real group does.
  const invite = await req(`/api/campaigns/${SLUG}/invite`, { method: "POST", cookie: host.cookie });
  if (invite.status !== 200) throw new Error(`invite failed: ${invite.text}`);
  const token = (invite.json?.url ?? "").split("/join/")[1] ?? "";
  for (const p of players.slice(1)) {
    const joined = await req("/api/join", {
      method: "POST",
      cookie: p.cookie,
      body: { token, name: p.name, concept: p.concept },
    });
    if (joined.status !== 200) throw new Error(`join failed for ${p.label}: ${joined.text}`);
  }
  console.log(`joined ${players.length} players`);

  for (let t = 0; t < TICKS; t++) {
    const lines = SCRIPT[t % SCRIPT.length];
    // Deliberately uneven participation: Sela goes quiet from turn 3 so the
    // chronicle shows the absence policy working rather than just claiming it.
    const acting = t >= 3 ? players.slice(0, 2) : players;
    let resolvedByQuorum = false;
    for (let i = 0; i < acting.length; i++) {
      const out = await req(`/api/campaigns/${SLUG}/action`, {
        method: "POST",
        cookie: acting[i].cookie,
        body: { text: lines[i] ?? lines[0] },
      });
      if (out.json?.resolvedNow) resolvedByQuorum = true;
    }

    // Quorum usually fires partway through the loop. Forcing a turn on top of
    // that produces an empty tick where everyone drifts, which would make the
    // demo chronicle look like nobody ever plays.
    let tick;
    let source;
    let drifted = 0;
    if (resolvedByQuorum) {
      const snap = await req(`/api/campaigns/${SLUG}`, { cookie: host.cookie });
      tick = snap.json?.campaign?.tick;
      source = "quorum";
      drifted = (snap.json?.campaign?.cast ?? []).filter((c) => c.presence !== "present").length;
    } else {
      const resolved = await req(`/api/campaigns/${SLUG}/resolve`, {
        method: "POST",
        cookie: host.cookie,
      });
      tick = resolved.json?.tick;
      source = resolved.json?.source;
      drifted = resolved.json?.drifted?.length ?? 0;
    }
    console.log(`  tick ${tick ?? "?"} — resolved by ${source}${drifted ? ` (${drifted} away)` : ""}`);
  }

  // Sessions were only needed to drive the seed; leave none behind.
  d1(`DELETE FROM auth_tokens WHERE player_id LIKE 'plr_demo%';`);

  const chronicle = await req(`/c/${SLUG}`);
  console.log(`\nchronicle: ${BASE}/c/${SLUG} (${chronicle.status}, ${chronicle.text.length} bytes)`);
}

main().catch((err) => {
  console.error("seed failed:", err.message);
  process.exit(1);
});
