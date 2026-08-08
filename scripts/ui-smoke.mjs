#!/usr/bin/env node
/**
 * Browser UI smoke at a mobile viewport.
 *
 * Drives the real deployed app with real taps, then runs programmatic
 * touch-target and accessibility audits and a console-error gate. Screenshots
 * land in critic-reports/ui/ so the interface can be judged rather than
 * described.
 *
 * Service workers are blocked in this context: offline emulation and request
 * routing do not reach SW-mediated fetches, so an outage drill against a page
 * a service worker has claimed silently tests nothing.
 *
 * Usage: node scripts/ui-smoke.mjs [baseUrl]
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://play.cortech.online").replace(/\/$/, "");
const OUT = "critic-reports/ui";
const SMOKE_PREFIX = "zzuismoke";
const stamp = randomBytes(4).toString("hex");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("playwright is not installed — UI smoke skipped");
  console.log("install with: npx playwright install --with-deps chromium");
  process.exit(0);
}

const results = [];
let failures = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/**
 * A local dev server is backed by the local D1, not the deployed one.
 *
 * The flag has to follow the target or the suite is worse than broken: seeding
 * a session in the remote database and then handing that cookie to
 * `wrangler dev` authenticates nobody, and every signed-in check fails for a
 * reason that has nothing to do with the app — while the rows, and the
 * cleanup's DELETEs, land in production.
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

function seedSession(label) {
  const email = `${SMOKE_PREFIX}+${label}-${stamp}@example.invalid`;
  const playerId = `plr_${SMOKE_PREFIX}${randomBytes(5).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  d1(
    `INSERT INTO players (id, email, display_name, created_at) VALUES ('${esc(playerId)}','${esc(email)}','${esc(label)}','${new Date().toISOString()}');` +
      `INSERT INTO auth_tokens (token_hash, player_id, purpose, expires_at) VALUES ('${sha256(token)}','${esc(playerId)}','session',${Date.now() + 3600_000});`,
  );
  return { email, playerId, token };
}

/**
 * A signed-in API call made outside the browser, as a given session token.
 *
 * The stale-draft check needs a second campaign that the browser's player is
 * only a member of, which takes another account, a campaign, an invitation and
 * a join. Driving all four through the UI would re-test the invite flow and
 * add a minute to the run for a fixture, not a finding. The assertion that
 * matters still happens in the browser.
 */
async function apiAs(token, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `arpg_session=${token}` },
    body: JSON.stringify(body ?? {}),
  });
  const out = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`POST ${path} → ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
  return out;
}

function cleanup() {
  try {
    d1(
      `DELETE FROM auth_tokens WHERE player_id IN (SELECT id FROM players WHERE email LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM invites WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM memberships WHERE player_id IN (SELECT id FROM players WHERE email LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM events WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM beats WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM entities WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM reply_bindings WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM token_budget WHERE campaign_id IN (SELECT id FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%');` +
        `DELETE FROM campaigns WHERE slug LIKE '${SMOKE_PREFIX}%';` +
        `DELETE FROM players WHERE email LIKE '${SMOKE_PREFIX}%';`,
    );
    console.log("\ncleanup: UI smoke data removed");
  } catch (err) {
    console.error("\ncleanup FAILED:", err.message);
    failures++;
  }
}

/**
 * The touch-target bar, named once so per-control checks and the sweep below
 * cannot drift apart. Height is the binding constraint; a generous width floor
 * would fail every inline link, but a control only a few px wide is not a
 * target whatever its height.
 */
const MIN_TOUCH_HEIGHT = 44;
const MIN_TOUCH_WIDTH = 24;

/** Every interactive control must clear MIN_TOUCH_HEIGHT/WIDTH CSS px. */
const TOUCH_TARGET_AUDIT = `(() => {
  const bad = [];
  const sel = 'a, button, input, textarea, select, summary, [role="button"]';
  for (const el of document.querySelectorAll(sel)) {
    if (el.hidden || el.closest('[hidden]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    // Skip visually-hidden controls (clipped skip links and the like): they
    // are not touch targets, and a 1x1 clipped box is not an undersized one.
    if (r.width <= 4 || r.height <= 4) continue;
    if (r.height < ${MIN_TOUCH_HEIGHT} || r.width < ${MIN_TOUCH_WIDTH}) {
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
      const label = (el.textContent || '').trim().slice(0, 24);
      bad.push(el.tagName.toLowerCase() + id + cls +
        ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
        (label ? ' "' + label + '"' : ''));
    }
  }
  return bad;
})()`;

const A11Y_AUDIT = `(() => {
  const issues = [];
  if (!document.documentElement.lang) issues.push('<html> has no lang');
  if (!document.title) issues.push('no <title>');
  if (!document.querySelector('meta[name=viewport]')) issues.push('no viewport meta');
  // Only visible headings count: this is a single-page app, so inactive
  // views keep their own <h1> in the DOM behind [hidden].
  const visibleH1 = [...document.querySelectorAll('h1')]
    .filter((h) => !h.closest('[hidden]') && h.getBoundingClientRect().height > 0);
  if (visibleH1.length !== 1) {
    issues.push('expected exactly one visible <h1>, found ' + visibleH1.length);
  }
  for (const img of document.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) issues.push('img without alt: ' + (img.currentSrc || img.src));
  }
  for (const f of document.querySelectorAll('input, textarea, select')) {
    if (f.type === 'hidden') continue;
    const labelled = f.labels?.length || f.getAttribute('aria-label') || f.getAttribute('aria-labelledby');
    if (!labelled) issues.push('unlabelled field: ' + (f.id || f.name || f.type));
  }
  for (const b of document.querySelectorAll('button')) {
    if (b.hidden || b.closest('[hidden]')) continue;
    if (!b.textContent.trim() && !b.getAttribute('aria-label')) issues.push('button with no accessible name');
  }
  return issues;
})()`;

mkdirSync(OUT, { recursive: true });
console.log(`asyncrpg UI smoke — ${BASE} (mobile viewport)\n`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: "block",
});

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const badResponses = [];
context.on("page", (p) => {
  p.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  p.on("pageerror", (e) => pageErrors.push(String(e)));
  p.on("requestfailed", (r) => failedRequests.push(`${r.url()} ${r.failure()?.errorText ?? ""}`));
  // Console messages do not carry the URL, so record non-2xx responses
  // separately — otherwise a failing gate cannot say what actually failed.
  p.on("response", (r) => {
    if (r.status() >= 400) badResponses.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
});

const page = await context.newPage();

try {
  // ─── signed out ────────────────────────────────────────────────────────
  console.log("signed out:");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.screenshot({ path: `${OUT}/01-signed-out.png`, fullPage: true });

  check("landing page shows the sign-in form", await page.locator("#signin-form").isVisible());
  check(
    "headline states the core promise",
    (await page.locator("h1").first().innerText()).length > 0,
    (await page.locator("h1").first().innerText()).slice(0, 60),
  );

  const swBlocked = await page.evaluate(
    "navigator.serviceWorker ? navigator.serviceWorker.controller === null : true",
  );
  check("no service worker controls the page (outage drills are meaningful)", swBlocked === true);

  let touchIssues = await page.evaluate(TOUCH_TARGET_AUDIT);
  check("all touch targets >= 44px tall (signed out)", touchIssues.length === 0, touchIssues.join("; "));

  let a11y = await page.evaluate(A11Y_AUDIT);
  check("no accessibility issues (signed out)", a11y.length === 0, a11y.join("; "));

  // Keyboard reachability: the primary action must be tabbable.
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const focusedTag = await page.evaluate("document.activeElement?.tagName?.toLowerCase() ?? ''");
  check("keyboard focus reaches interactive controls", ["a", "input", "button"].includes(focusedTag), focusedTag);

  // The form must not silently swallow a submission.
  await page.locator("#email").fill(`${SMOKE_PREFIX}+ui-${stamp}@example.invalid`);
  await page.locator('#signin-form button[type="submit"]').tap();
  await page.waitForFunction("document.getElementById('status')?.textContent?.trim().length > 0", {
    timeout: 15000,
  });
  const signinStatus = (await page.locator("#status").innerText()).trim();
  check("sign-in gives feedback", signinStatus.length > 0, signinStatus.slice(0, 70));
  await page.screenshot({ path: `${OUT}/02-signin-submitted.png`, fullPage: true });

  // ─── signed in ─────────────────────────────────────────────────────────
  console.log("\nsigned in:");
  const host = seedSession("host");
  await context.addCookies([
    {
      name: "arpg_session",
      value: host.token,
      domain: new URL(BASE).hostname,
      path: "/",
      httpOnly: true,
      // Mirrors what the app itself sets: `sessionCookie(token, isHttps)` drops
      // Secure over plain http so a local dev server can hold a session.
      secure: BASE.startsWith("https:"),
      sameSite: "Lax",
    },
  ]);

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  check("signed-in home renders", await page.locator("#view-home").isVisible());
  check("sign-out is offered", await page.locator("#signout").isVisible());
  await page.screenshot({ path: `${OUT}/03-home-empty.png`, fullPage: true });

  const slug = `${SMOKE_PREFIX}-${stamp}`;
  // The create form lives in a <details>. Tapping the summary is what a real
  // user does, but the disclosure animation can leave the field unstable, so
  // wait for it to actually be visible before typing.
  await page.locator("#create-details summary").tap();
  // Touch emulation does not reliably toggle a <details> disclosure, and the
  // disclosure is not what this suite is testing — force it open if the tap
  // did not take, so a flaky widget cannot mask a real failure downstream.
  if (!(await page.locator("#create-details").getAttribute("open"))) {
    await page.evaluate("document.getElementById('create-details').open = true");
  }
  await page.locator("#c-name").waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("#c-name").fill("UI Smoke Hold");
  const autoSlug = await page.locator("#c-slug").inputValue();
  check("slug auto-fills from the campaign name", autoSlug.length > 0, autoSlug);
  await page.locator("#c-slug").fill(slug);
  await page.screenshot({ path: `${OUT}/04-create-form.png`, fullPage: true });

  await page.locator('#create-form button[type="submit"]').tap();
  await page.waitForFunction(
    `location.hash === '#/c/${slug}' || document.getElementById('status')?.className?.includes('err')`,
    { timeout: 90_000 },
  );
  check("creating a campaign navigates into it", page.url().includes(`#/c/${slug}`), page.url());

  await page.waitForSelector("#view-campaign:not([hidden])", { timeout: 30_000 });
  const title = await page.locator("#c-title").innerText();
  check("campaign view shows its name", title.includes("UI Smoke Hold"), title);
  const where = await page.locator("#c-where").innerText();
  check("scene names a place and a season", where.length > 10, where.slice(0, 80));
  const clock = await page.locator("#c-clock").innerText();
  check("clock explains when the turn resolves", /resolves/i.test(clock), clock.replace(/\n/g, " ").slice(0, 90));
  check("quorum is explained in plain language", /acted/i.test(clock));
  const promptText = await page.locator("#action-label").innerText();
  check("player is asked a specific question", promptText.length > 5, promptText);
  await page.screenshot({ path: `${OUT}/05-campaign.png`, fullPage: true });

  touchIssues = await page.evaluate(TOUCH_TARGET_AUDIT);
  check("all touch targets >= 44px tall (campaign)", touchIssues.length === 0, touchIssues.join("; "));
  a11y = await page.evaluate(A11Y_AUDIT);
  check("no accessibility issues (campaign)", a11y.length === 0, a11y.join("; "));

  // ─── take a turn ───────────────────────────────────────────────────────
  console.log("\ntaking a turn:");
  await page.locator("#action").fill("I walk the wall at dusk and count the watchfires.");
  await page.locator('#action-form button[type="submit"]').tap();
  await page.waitForFunction("document.getElementById('status')?.textContent?.trim().length > 0", {
    timeout: 120_000,
  });
  const turnStatus = (await page.locator("#status").innerText()).trim();
  check("submitting a turn confirms in plain language", turnStatus.length > 0, turnStatus.slice(0, 80));
  check("confirmation is not an error", !(await page.locator("#status").getAttribute("class")).includes("err"));
  await page.screenshot({ path: `${OUT}/06-turn-submitted.png`, fullPage: true });

  // The app must be understandable on its own — the story, your character,
  // and your position, without leaving for the chronicle.
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#view-campaign:not([hidden])", { timeout: 30_000 });
  const beatVisible = await page.locator("#beat-box").isVisible();
  check("the latest beat is shown in the app", beatVisible);
  if (beatVisible) {
    const beatText = await page.locator("#beat").innerText();
    check("the beat has readable prose", beatText.length > 60, `${beatText.length} chars`);
  }
  await page.locator("#sheet-details summary").tap();
  if (!(await page.locator("#sheet-details").getAttribute("open"))) {
    await page.evaluate("document.getElementById('sheet-details').open = true");
  }
  const sheetText = await page.locator("#sheet").innerText();
  check("the character sheet is reachable in the app", sheetText.length > 30, sheetText.slice(0, 60).replace(/\n/g, " "));
  check("the sheet shows attributes", /might/i.test(sheetText));
  await page.screenshot({ path: `${OUT}/06b-beat-and-sheet.png`, fullPage: true });

  // ─── the DM's review desk ──────────────────────────────────────────────
  // The creator holds the seat by default and quorum is one, so submitting the
  // turn above resolved it — and a campaign with a seated DM holds its beat
  // rather than sending it. This is that beat, at the desk it is held at.
  console.log("\nthe DM's review desk:");
  check("DM panel renders for the seat holder", await page.locator("#dm-box").isVisible());
  const dmHeading = (await page.locator("#dm-heading").innerText()).trim();
  check("the panel says whose desk this is", dmHeading.length > 0, dmHeading);

  const reviewVisible = await page.locator("#dm-review").isVisible();
  check("a held turn is offered for review", reviewVisible);
  check("the idle line gives way to the held turn", !(await page.locator("#dm-idle").isVisible()));

  let draft = "";
  if (reviewVisible) {
    draft = await page.locator("#dm-prose").inputValue();
    check("the held prose is editable, not just displayed", draft.length > 60, `${draft.length} chars`);
    const dmTick = (await page.locator("#dm-tick").innerText()).trim();
    check("the panel names the turn that is waiting", /^\d+$/.test(dmTick), `turn ${dmTick}`);
    const windowLine = (await page.locator("#dm-window").innerText()).trim();
    // Deliberately not the bare phrase "publishes on its own". The app prints
    // that phrase either way: with a deadline it says *when*, and without one
    // it falls back to "Publishes on its own if you do nothing." A check that
    // matched only the phrase passed just as happily with `windowClosesAt`
    // deleted from the campaign GET — which made the field, and the
    // `reviewState()` RPC that exists to produce it, ungated. The deadline is
    // the thing under test, so the line must carry a time derived from it.
    check(
      "the DM is told when it publishes itself if they do nothing",
      /publishes on its own (?:in \d+ (?:minute|hour|day)s?|any moment now) if you do nothing/i.test(windowLine),
      windowLine,
    );
    // Nobody but the seat holder has been told this turn exists yet, and the
    // panel has to say so — a DM who thinks it already went out will not edit.
    check("the held turn is labelled as unseen", /nobody has seen this/i.test(await page.locator("#dm-review label").innerText()));
  }

  // The seat control lives behind a disclosure, as elsewhere in this app.
  await page.locator("#dm-seat-details summary").tap();
  if (!(await page.locator("#dm-seat-details").getAttribute("open"))) {
    await page.evaluate("document.getElementById('dm-seat-details').open = true");
  }
  check("DM seat can be handed to another member", await page.locator("#dm-seat-to").isVisible());
  const holder = (await page.locator("#dm-holder").innerText()).trim();
  check("the panel names who holds the seat", /seat/i.test(holder), holder);

  // Every DM control has to be tappable at a mobile viewport, same bar as the
  // rest of the app. Checked by id as well as by the sweep below, so a failure
  // names the control rather than a selector.
  for (const id of ["dm-save", "dm-publish", "dm-seat-btn"]) {
    const box = await page.locator(`#${id}`).boundingBox();
    check(
      `${id} meets the touch-target minimum`,
      Boolean(box) && box.height >= MIN_TOUCH_HEIGHT && box.width >= MIN_TOUCH_WIDTH,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "not found",
    );
  }
  await page.screenshot({ path: `${OUT}/06c-dm-panel.png`, fullPage: true });

  // The sweeps run with the panel and its disclosure open, so the DM's controls
  // are inside them rather than skipped as hidden.
  touchIssues = await page.evaluate(TOUCH_TARGET_AUDIT);
  check("all touch targets >= 44px tall (with beat and sheet)", touchIssues.length === 0, touchIssues.join("; "));
  a11y = await page.evaluate(A11Y_AUDIT);
  check("no accessibility issues (with beat and sheet)", a11y.length === 0, a11y.join("; "));

  // ─── leaving the desk for a campaign you do not run ────────────────────
  // Same page, same nodes. This is a single-page app, so moving from a
  // campaign you run to one you only play in re-renders the DM panel instead
  // of rebuilding it — and hiding the panel is not emptying it. The held
  // prose of the campaign you left has no business still sitting in the DOM
  // of the campaign you arrived at.
  if (reviewVisible) {
    console.log("\nmoving to a campaign you do not run:");
    const guestSlug = `${slug}-two`;
    const guest = seedSession("guest");
    await apiAs(guest.token, "/api/campaigns", {
      name: "UI Smoke Guest",
      slug: guestSlug,
      cadence: "weekly",
    });
    const invite = await apiAs(guest.token, `/api/campaigns/${guestSlug}/invite`);
    const inviteToken = /#\/join\/([a-f0-9]{16,128})$/.exec(invite.url ?? "")?.[1] ?? "";
    await apiAs(host.token, "/api/join", { token: inviteToken, name: "Visiting Player" });

    await page.evaluate(`location.hash = '#/c/${guestSlug}'`);
    await page.waitForFunction(
      "document.getElementById('c-title')?.textContent === 'UI Smoke Guest'",
      { timeout: 30_000 },
    );
    // The precondition, not decoration: if the viewer somehow ran this
    // campaign too, the panel would be populated for a good reason and the
    // assertion below would prove nothing.
    check(
      "the DM panel is not offered in a campaign you do not run",
      !(await page.locator("#dm-box").isVisible()),
    );
    const leftBehind = await page.evaluate(`(() => {
      const out = [];
      for (const id of ['dm-prose', 'dm-tick', 'dm-window', 'dm-holder', 'dm-seat-to']) {
        const el = document.getElementById(id);
        // A textarea carries its draft on .value and a <select> its selected
        // playerId, while the caption elements carry text — read both, so a
        // field cannot look empty merely because it is the wrong kind of node.
        const content = String(el.value ?? '') + (el.textContent ?? '');
        if (content.trim()) out.push(id + '=' + content.trim().slice(0, 40));
      }
      return out;
    })()`);
    check(
      "no held draft is left in the DOM after moving to a campaign you do not run",
      leftBehind.length === 0,
      leftBehind.join(" | "),
    );
    await page.screenshot({ path: `${OUT}/06c2-other-campaign.png`, fullPage: true });

    // Emptying the panel must not be a one-way door: coming back has to put
    // the DM at the desk they left, with the same turn still waiting.
    await page.evaluate(`location.hash = '#/c/${slug}'`);
    await page.waitForSelector("#dm-review:not([hidden])", { timeout: 30_000 });
    check(
      "returning to your own campaign restores the held turn",
      (await page.locator("#dm-prose").inputValue()).length > 60,
    );
  }

  // ─── editing, then sending ─────────────────────────────────────────────
  if (reviewVisible) {
    const MARK = `The DM rewrote this. ${stamp}`;
    await page.locator("#dm-prose").fill(`${draft}\n\n${MARK}`);
    await page.locator("#dm-save").tap();
    await page.waitForFunction("document.getElementById('status')?.textContent?.trim().length > 0", {
      timeout: 30_000,
    });
    const saveStatus = (await page.locator("#status").innerText()).trim();
    check("saving an edit confirms in plain language", /saved/i.test(saveStatus), saveStatus.slice(0, 70));

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#view-campaign:not([hidden])", { timeout: 30_000 });
    check("the edit survives a reload", (await page.locator("#dm-prose").inputValue()).includes(MARK));
    // An edit is not a send: the turn must still be waiting afterwards.
    check("saving does not publish the turn", await page.locator("#dm-review").isVisible());

    await page.locator("#dm-publish").tap();
    await page.waitForFunction("document.getElementById('status')?.textContent?.includes('Sent')", {
      timeout: 60_000,
    });
    check("sending it confirms in plain language", (await page.locator("#status").innerText()).trim().slice(0, 70).length > 0, (await page.locator("#status").innerText()).trim().slice(0, 70));

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("#view-campaign:not([hidden])", { timeout: 30_000 });
    check("the desk empties once the turn is sent", !(await page.locator("#dm-review").isVisible()));
    check("the panel falls back to its idle line", await page.locator("#dm-idle").isVisible());
    // The point of publishing: the DM's own words are what the group now reads.
    check("the published beat carries the DM's edit", (await page.locator("#beat").innerText()).includes(MARK));
    check("the beat is no longer flagged as unsent", !(await page.locator("#beat").innerText()).includes("not sent to the group yet"));
    await page.screenshot({ path: `${OUT}/06d-dm-published.png`, fullPage: true });
  }

  // ─── chronicle ─────────────────────────────────────────────────────────
  // The campaign this suite just built, not the seeded `/c/demo`. The demo is a
  // fixture the suite neither creates nor cleans up, so against any base where
  // nobody has seeded it — a local dev server, a fresh environment — these
  // checks fail for a reason that has nothing to do with the app. This
  // campaign's chronicle is public by default and its contents are known, which
  // is what lets the last check below exist at all.
  const chronicleUrl = `${BASE}/c/${slug}`;
  console.log("\nchronicle:");
  const chronicle = await context.newPage();
  await chronicle.goto(chronicleUrl, { waitUntil: "networkidle" });
  const chronicleText = await chronicle.locator("body").innerText();
  check("public chronicle renders", chronicleText.length > 200, `${chronicleText.length} chars`);
  check("chronicle shows narrated turns", /Turns/i.test(chronicleText));
  check("chronicle shows turning points", /Turning points/i.test(chronicleText));
  // Publishing is what puts a held turn in front of the group, and the
  // chronicle is where the group reads it. Nothing else in this suite proves
  // the DM's rewrite reaches a reader who is not the DM.
  check(
    "the chronicle carries the turn the DM sent",
    !reviewVisible || /The DM rewrote this\./.test(chronicleText),
  );
  check(
    "the chronicle does not show a turn as held once it is sent",
    !/held for review/i.test(chronicleText),
  );
  await chronicle.screenshot({ path: `${OUT}/07-chronicle.png`, fullPage: true });

  // No-JS readability: the chronicle is the shareable artifact, so it must
  // survive a reader with scripting disabled.
  const noJs = await browser.newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: false,
    serviceWorkers: "block",
  });
  const noJsPage = await noJs.newPage();
  await noJsPage.goto(chronicleUrl, { waitUntil: "domcontentloaded" });
  const noJsText = await noJsPage.locator("body").innerText();
  check("chronicle is readable with JavaScript disabled", noJsText.length > 200, `${noJsText.length} chars`);
  await noJsPage.screenshot({ path: `${OUT}/08-chronicle-nojs.png`, fullPage: true });
  await noJs.close();

  // ─── dark mode ─────────────────────────────────────────────────────────
  const dark = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    serviceWorkers: "block",
  });
  const darkPage = await dark.newPage();
  await darkPage.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const bg = await darkPage.evaluate("getComputedStyle(document.body).backgroundColor");
  check("dark mode is honoured", bg !== "rgb(246, 243, 236)", bg);
  await darkPage.screenshot({ path: `${OUT}/09-dark.png`, fullPage: true });
  await dark.close();

  // ─── console gate ──────────────────────────────────────────────────────
  console.log("\nruntime health:");
  check("no uncaught page errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  check(
    "no console errors",
    consoleErrors.length === 0,
    [...consoleErrors.slice(0, 3), ...badResponses.slice(0, 3)].join(" | "),
  );
  check("no failed network requests", failedRequests.length === 0, failedRequests.slice(0, 3).join(" | "));
} catch (err) {
  check("ui smoke completed without throwing", false, String(err).slice(0, 300));
  try {
    await page.screenshot({ path: `${OUT}/99-failure.png`, fullPage: true });
  } catch {
    /* best effort */
  }
} finally {
  await browser.close();
  cleanup();
  console.log(`\nscreenshots: ${OUT}/`);
  console.log(`${results.length - failures}/${results.length} checks passed`);
  process.exit(failures > 0 ? 1 : 0);
}
