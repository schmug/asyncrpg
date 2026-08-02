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

import { joinCharacter } from "../src/sim/character";
import { generateWorld } from "../src/sim/genesis";
import { checkWorldInvariants } from "../src/sim/invariants";
import { Rng, seedFrom } from "../src/sim/prng";
import { DEFAULT_CAMPAIGN_CONFIG, runTick } from "../src/sim/tick";
import type { ActionKind, PlayerAction, WorldEvent, WorldState } from "../src/sim/types";

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

const ACTION_KINDS_POOL: ActionKind[] = ["aid", "parley", "scout", "confront", "trade", "guard", "study"];

/**
 * A table of four with realistic participation:
 *   p0 shows up nearly always, p1 about half the time, p2 rarely,
 *   p3 plays for a while and then vanishes entirely partway through.
 *
 * That last one is the case the whole design exists to handle, so the soak
 * had better exercise it rather than assuming everyone is diligent.
 */
function submissionsFor(state: WorldState, t: number, rng: Rng): PlayerAction[] {
  const out: PlayerAction[] = [];
  const chars = Object.values(state.characters).sort((a, b) => a.id.localeCompare(b.id));
  const participation = [0.9, 0.5, 0.12, t < ticks * 0.3 ? 0.7 : 0];
  chars.forEach((c, i) => {
    if (!rng.chance(participation[i] ?? 0.3)) return;
    out.push({
      id: `soak-${c.id}-${t}`,
      characterId: c.id,
      playerId: c.playerId,
      tick: t,
      kind: rng.pick(ACTION_KINDS_POOL),
      targetId: null,
      rawText: "I do what needs doing.",
      intent: "does what needs doing",
      via: "web",
      auto: false,
    });
  });
  return out;
}

function play(id: string, n: number): { state: WorldState; events: WorldEvent[]; history: WorldEvent[] } {
  const { state, events: history } = generateWorld(id, seedFrom(id, 0, "genesis"), { historyYears: 80 });
  for (let i = 0; i < 4; i++) {
    joinCharacter(state, { playerId: `p${i}`, name: `Player ${i}`, seed: seedFrom(id, i, "join") });
  }

  const violationsAtGenesis = checkWorldInvariants(state);
  if (violationsAtGenesis.length > 0) {
    console.error(`FAIL: genesis violated invariants:\n  - ${violationsAtGenesis.join("\n  - ")}`);
    process.exit(1);
  }

  const events: WorldEvent[] = [];
  for (let t = 1; t <= n; t++) {
    const rng = new Rng(seedFrom(id, t, "soak-submissions"));
    const result = runTick(state, submissionsFor(state, t, rng), DEFAULT_CAMPAIGN_CONFIG, {
      history: events,
    });
    events.push(...result.events);

    const violations = checkWorldInvariants(state);
    if (violations.length > 0) {
      console.error(`FAIL: tick ${t} violated invariants:\n  - ${violations.join("\n  - ")}`);
      process.exit(1);
    }
  }
  return { state, events, history };
}

const { state, events: all, history } = play(campaignId, ticks);

// Determinism: an identical replay must produce an identical world.
const replay = play(campaignId, ticks);
if (JSON.stringify(replay.state) !== JSON.stringify(state)) {
  console.error("FAIL: replay diverged — the simulation is not deterministic");
  process.exit(1);
}

// The core promise, asserted mechanically: the player who stopped showing up
// must not have been degraded in any way by having stopped.
const quitter = Object.values(state.characters).find((c) => c.playerId === "p3");
if (!quitter) {
  console.error("FAIL: soak lost a character");
  process.exit(1);
}
if (quitter.renown < 5 || quitter.conditions.length > 0) {
  console.error(
    `FAIL: absent player was penalised — renown ${quitter.renown}, conditions [${quitter.conditions}]`,
  );
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
console.log(
  `  absent player  : presence=${quitter.presence} renown=${quitter.renown.toFixed(1)} ` +
    `conditions=[${quitter.conditions.join(", ")}] — unpenalised`,
);

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
