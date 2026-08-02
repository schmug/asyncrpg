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

const sha256 = (v) => createHash("sha256").update(v).digest("hex");
const esc = (v) => String(v).replace(/'/g, "''");
function d1(sql) {
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "asyncrpg", "--remote", "--json", "--command", sql],
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

function cleanup() {
  try {
    d1(
      `DELETE FROM auth_tokens WHERE player_id IN (SELECT id FROM players WHERE email LIKE '${SMOKE_PREFIX}%');` +
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

/** Every interactive control must clear 44x44 CSS px. */
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
    if (r.height < 44 || r.width < 24) {
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
      secure: true,
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

  touchIssues = await page.evaluate(TOUCH_TARGET_AUDIT);
  check("all touch targets >= 44px tall (with beat and sheet)", touchIssues.length === 0, touchIssues.join("; "));
  a11y = await page.evaluate(A11Y_AUDIT);
  check("no accessibility issues (with beat and sheet)", a11y.length === 0, a11y.join("; "));

  // ─── chronicle ─────────────────────────────────────────────────────────
  console.log("\nchronicle:");
  const chronicle = await context.newPage();
  await chronicle.goto(`${BASE}/c/demo`, { waitUntil: "networkidle" });
  const chronicleText = await chronicle.locator("body").innerText();
  check("public chronicle renders", chronicleText.length > 200, `${chronicleText.length} chars`);
  check("chronicle shows narrated turns", /Turns/i.test(chronicleText));
  check("chronicle shows turning points", /Turning points/i.test(chronicleText));
  await chronicle.screenshot({ path: `${OUT}/07-chronicle.png`, fullPage: true });

  // No-JS readability: the chronicle is the shareable artifact, so it must
  // survive a reader with scripting disabled.
  const noJs = await browser.newContext({
    viewport: { width: 390, height: 844 },
    javaScriptEnabled: false,
    serviceWorkers: "block",
  });
  const noJsPage = await noJs.newPage();
  await noJsPage.goto(`${BASE}/c/demo`, { waitUntil: "domcontentloaded" });
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
