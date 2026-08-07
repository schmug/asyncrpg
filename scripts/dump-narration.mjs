#!/usr/bin/env node
/**
 * Dump the demo campaign's real generated narration as plain text.
 *
 * Narrative quality cannot be judged from a schema or a test name — it has to
 * be read. This puts the actual prose in front of the critic.
 *
 * Usage: node scripts/dump-narration.mjs [baseUrl] [slug]
 */

const BASE = (process.argv[2] ?? "https://play.cortech.online").replace(/\/$/, "");
const SLUG = process.argv[3] ?? "demo";

const unescape = (s) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const res = await fetch(`${BASE}/c/${SLUG}`);
const html = await res.text();
console.log(`source: ${BASE}/c/${SLUG}  (HTTP ${res.status}, ${html.length} bytes)\n`);

if (res.status !== 200) {
  console.log("chronicle unavailable — no narration to show");
  process.exit(0);
}

const beats = [...html.matchAll(/<article class="beat">([\s\S]*?)<\/article>/g)];
console.log(`${beats.length} narrated turns\n`);

for (const [, block] of beats) {
  const tick = /Tick (\d+)/.exec(block)?.[1] ?? "?";
  const templated = block.includes("recorded without narration");
  console.log("=".repeat(72));
  console.log(`TICK ${tick}${templated ? "   [templated — no model narration for this turn]" : ""}`);
  console.log("=".repeat(72));
  for (const [, p] of block.matchAll(/<p>([\s\S]*?)<\/p>/g)) {
    const text = unescape(p.replace(/<[^>]+>/g, "")).trim();
    if (text && !/^Tick \d+/.test(text)) console.log(`${text}\n`);
  }
}

// Turning points give the critic a read on whether the simulation compounds.
const timeline = [...html.matchAll(/<li class="[^"]*"><span class="n">t(\d+)<\/span>([\s\S]*?)<\/li>/g)];
if (timeline.length) {
  console.log("=".repeat(72));
  console.log("TURNING POINTS (simulation events, significance >= 55)");
  console.log("=".repeat(72));
  for (const [, tick, summary] of timeline) {
    console.log(`  t${tick.padStart(3)}  ${unescape(summary.replace(/<[^>]+>/g, "")).trim()}`);
  }
}
