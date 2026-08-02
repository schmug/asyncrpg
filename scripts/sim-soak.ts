#!/usr/bin/env tsx
/**
 * Simulation soak.
 *
 * Runs a world for hundreds of ticks with the language model entirely switched
 * off, asserting invariants after every single one. This is the primary
 * evidence that the world model is real rather than decorative: if the sim can
 * survive 500 ticks without producing a contradiction, the narrator has
 * something solid to narrate.
 *
 * Usage: npm run sim:soak -- [--ticks 500] [--seed my-campaign] [--quiet]
 */

import { driftWorld } from "../src/sim/drift";
import { EventLog } from "../src/sim/events";
import { generateWorld } from "../src/sim/genesis";
import { checkWorldInvariants } from "../src/sim/invariants";
import { NameForge } from "../src/sim/names";
import { Rng, seedFrom } from "../src/sim/prng";
import type { WorldEvent } from "../src/sim/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const ticks = Number.parseInt(arg("ticks", "500"), 10);
const campaignId = arg("seed", "soak-campaign");
const quiet = process.argv.includes("--quiet");

if (!Number.isFinite(ticks) || ticks < 1) {
  console.error(`--ticks must be a positive integer, got ${arg("ticks", "500")}`);
  process.exit(1);
}

const { state, events: history } = generateWorld(campaignId, seedFrom(campaignId, 0, "genesis"), {
  historyYears: 80,
});

const violationsAtGenesis = checkWorldInvariants(state);
if (violationsAtGenesis.length > 0) {
  console.error(`FAIL: genesis violated invariants:\n  - ${violationsAtGenesis.join("\n  - ")}`);
  process.exit(1);
}

const forge = new NameForge([
  ...Object.values(state.regions).map((r) => r.name),
  ...Object.values(state.settlements).map((s) => s.name),
  ...Object.values(state.factions).map((f) => f.name),
  ...Object.values(state.npcs).map((n) => n.name),
  ...Object.values(state.threats).map((t) => t.name),
]);

const all: WorldEvent[] = [];
for (let t = 1; t <= ticks; t++) {
  state.tick = t;
  const log = new EventLog(t);
  driftWorld(state, new Rng(seedFrom(campaignId, t, "world")), log, forge);
  all.push(...log.events);

  const violations = checkWorldInvariants(state);
  if (violations.length > 0) {
    console.error(`FAIL: tick ${t} violated invariants:\n  - ${violations.join("\n  - ")}`);
    process.exit(1);
  }
}

// Determinism: an identical replay must produce an identical world.
const replay = generateWorld(campaignId, seedFrom(campaignId, 0, "genesis"), { historyYears: 80 });
const replayForge = new NameForge([
  ...Object.values(replay.state.regions).map((r) => r.name),
  ...Object.values(replay.state.settlements).map((s) => s.name),
  ...Object.values(replay.state.factions).map((f) => f.name),
  ...Object.values(replay.state.npcs).map((n) => n.name),
  ...Object.values(replay.state.threats).map((t) => t.name),
]);
for (let t = 1; t <= ticks; t++) {
  replay.state.tick = t;
  driftWorld(replay.state, new Rng(seedFrom(campaignId, t, "world")), new EventLog(t), replayForge);
}
if (JSON.stringify(replay.state) !== JSON.stringify(state)) {
  console.error("FAIL: replay diverged — the simulation is not deterministic");
  process.exit(1);
}

const byKind = new Map<string, number>();
for (const e of [...history, ...all]) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);

const living = Object.values(state.factions).filter((f) => !f.defunct).length;
const razed = Object.values(state.settlements).filter((s) => s.razed).length;
const resolved = Object.values(state.threats).filter((t) => t.resolved).length;

console.log(`sim soak — campaign "${campaignId}", ${ticks} ticks, no inference`);
console.log(`  genesis events : ${history.length}`);
console.log(`  play events    : ${all.length}`);
console.log(`  distinct kinds : ${byKind.size}`);
console.log(`  year reached   : ${state.year} (${state.season})`);
console.log(`  factions alive : ${living}/${Object.keys(state.factions).length}`);
console.log(`  towns razed    : ${razed}/${Object.keys(state.settlements).length}`);
console.log(`  threats ended  : ${resolved}/${Object.keys(state.threats).length}`);
console.log(`  invariants     : held on all ${ticks} ticks`);
console.log(`  determinism    : replay identical`);

if (!quiet) {
  console.log(`\nmost significant moments:`);
  for (const e of [...history, ...all].sort((a, b) => b.significance - a.significance).slice(0, 15)) {
    console.log(`  [${String(e.significance).padStart(3)}] t${e.tick} ${e.summary}`);
  }
}

// A world where nothing consequential ever happens is a failed generator, even
// if every invariant holds. Emergence is a requirement, not a nice-to-have.
const consequential = [...history, ...all].filter((e) => e.significance >= 60).length;
if (consequential < 5) {
  console.error(`\nFAIL: only ${consequential} consequential events in ${ticks} ticks — the world is inert`);
  process.exit(1);
}
console.log(`\nOK — ${consequential} consequential events`);
