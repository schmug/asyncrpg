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
import { pruneWorld } from "../src/sim/prune";
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

/** Snapshot of the things the no-penalty promise covers. */
function promiseState(state: WorldState, playerId: string) {
  const c = Object.values(state.characters).find((x) => x.playerId === playerId);
  if (!c) return null;
  return {
    renown: c.renown,
    conditions: c.conditions.length,
    attributes: JSON.stringify(c.attributes),
    skills: JSON.stringify(c.skills),
  };
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
  // The promise is about what absence costs, so it is measured from the moment
  // the player stops playing — not against an absolute floor, which would
  // wrongly count risks they took while present.
  let atDeparture: ReturnType<typeof promiseState> = null;

  for (let t = 1; t <= n; t++) {
    const rng = new Rng(seedFrom(id, t, "soak-submissions"));
    const result = runTick(state, submissionsFor(state, t, rng), DEFAULT_CAMPAIGN_CONFIG, {
      history: events,
    });
    events.push(...result.events);
    // Exercise the same bounding the Durable Object applies, so the soak
    // measures the state size a real campaign would actually persist.
    pruneWorld(state);

    const violations = checkWorldInvariants(state);
    if (violations.length > 0) {
      console.error(`FAIL: tick ${t} violated invariants:\n  - ${violations.join("\n  - ")}`);
      process.exit(1);
    }

    // p3 stops at 30% of the run; capture their state the tick they go quiet,
    // then assert nothing about them gets worse for the rest of the campaign.
    const cutoff = Math.floor(ticks * 0.3);
    if (t === cutoff) atDeparture = promiseState(state, "p3");
    if (atDeparture && t > cutoff) {
      const now = promiseState(state, "p3");
      if (!now) {
        console.error(`FAIL: tick ${t}: the absent player's character disappeared`);
        process.exit(1);
      }
      const worse: string[] = [];
      if (now.renown < atDeparture.renown - 0.001) {
        worse.push(`renown ${atDeparture.renown.toFixed(1)} -> ${now.renown.toFixed(1)}`);
      }
      if (now.conditions > atDeparture.conditions) {
        worse.push(`conditions ${atDeparture.conditions} -> ${now.conditions}`);
      }
      if (now.attributes !== atDeparture.attributes) worse.push("attributes changed");
      if (now.skills !== atDeparture.skills) worse.push("skills changed");
      if (worse.length > 0) {
        console.error(
          `FAIL: tick ${t}: absence made the quiet player worse off — ${worse.join("; ")}`,
        );
        process.exit(1);
      }
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
if (quitter.conditions.length > 0) {
  console.error(
    `FAIL: absent player is still carrying conditions after a long absence: [${quitter.conditions}]`,
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

// An endless campaign has to fit in a Durable Object row forever. Unbounded
// growth here is a slow-motion outage, so the soak fails on it rather than
// reporting it.
// Economy sanity. A world where every settlement sits at prosperity 100 with
// a population of half a million, and every faction at power 100, has no
// scarcity and therefore no politics — it passes every invariant and is still
// a failed simulation. This is the guard for that.
const towns = Object.values(state.settlements).filter((s) => !s.razed);
const livingFactions = Object.values(state.factions).filter((f) => !f.defunct);
const maxedTowns = towns.filter((s) => s.prosperity >= 99).length;
const maxedFactions = livingFactions.filter((f) => f.power >= 99).length;
const biggest = towns.reduce((m, s) => Math.max(m, s.population), 0);
const POP_CEILING = 60_000;

console.log(
  `  economy       : prosperity ${towns.length ? Math.round(towns.reduce((a, s) => a + s.prosperity, 0) / towns.length) : 0} avg, ` +
    `largest town ${biggest.toLocaleString()}, ` +
    `faction power ${livingFactions.length ? Math.round(livingFactions.reduce((a, f) => a + f.power, 0) / livingFactions.length) : 0} avg`,
);

if (towns.length > 1 && maxedTowns === towns.length) {
  console.error(`\nFAIL: every settlement saturated at prosperity 100 — the economy has no ceiling`);
  process.exit(1);
}
if (livingFactions.length > 1 && maxedFactions === livingFactions.length) {
  console.error(`\nFAIL: every faction saturated at power 100 — nobody can threaten anybody`);
  process.exit(1);
}
if (biggest > POP_CEILING) {
  console.error(`\nFAIL: largest settlement reached ${biggest} — population growth is unbounded`);
  process.exit(1);
}

const stateBytes = JSON.stringify(state).length;
const STATE_CEILING = 500_000;
console.log(
  `  state size     : ${(stateBytes / 1024).toFixed(1)} KiB ` +
    `(${Object.keys(state.npcs).length} npcs, ${Object.keys(state.factions).length} factions, ` +
    `${Object.keys(state.threats).length} threats)`,
);
if (stateBytes > STATE_CEILING) {
  console.error(`\nFAIL: world state grew to ${stateBytes} bytes, over the ${STATE_CEILING} ceiling`);
  process.exit(1);
}

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
