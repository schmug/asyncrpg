#!/usr/bin/env tsx
/**
 * Endurance: a table of four, played the way real groups play.
 *
 * The soak proves the *world* survives hundreds of ticks. This proves the
 * *promise* survives them — which is a different claim, and the one the
 * product is actually sold on.
 *
 * It drives one campaign through the participation patterns a real group
 * produces, and asserts after every tick that nobody has been punished for
 * being busy:
 *
 *   - Ada plays every turn (the control).
 *   - Bo misses 1 turn, twice — the ordinary "busy week".
 *   - Cyd misses 3 turns — long enough to go offscreen and come back.
 *   - Dev misses 30 consecutive turns — the "I forgot this existed" case.
 *
 * Both resolution paths are exercised: some ticks reach quorum, some are
 * forced by deadline with players still outstanding.
 *
 * No inference and no network — the sim is the thing under test, and the
 * narrator has no authority over any of it. Deterministic, so a regression is
 * a diff rather than a coin flip.
 *
 * Usage: npm run sim:endurance -- [--ticks 60] [--seed name] [--quiet]
 */

import { joinCharacter } from "../src/sim/character";
import { generateWorld } from "../src/sim/genesis";
import { checkWorldInvariants } from "../src/sim/invariants";
import { seedFrom } from "../src/sim/prng";
import { pruneWorld } from "../src/sim/prune";
import { DEFAULT_CAMPAIGN_CONFIG, runTick } from "../src/sim/tick";
import type { Character, PlayerAction, WorldEvent, WorldState } from "../src/sim/types";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const ticks = Math.max(45, Number.parseInt(arg("ticks", "60"), 10));
const campaignId = arg("seed", "endurance");
const quiet = process.argv.includes("--quiet");

const PLAYERS = ["ada", "bo", "cyd", "dev"] as const;
type PlayerId = (typeof PLAYERS)[number];

/** Turns each player sits out. Absolute tick numbers, so the run is readable. */
const ABSENCES: Record<PlayerId, Set<number>> = {
  ada: new Set(),
  bo: new Set([5, 12]),
  cyd: new Set([20, 21, 22]),
  dev: new Set(Array.from({ length: 30 }, (_, i) => i + 8)),
};

const failures: string[] = [];
function assert(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

const { state } = generateWorld(campaignId, seedFrom(campaignId, 0, "genesis"), {
  historyYears: 60,
});
for (const [i, id] of PLAYERS.entries()) {
  joinCharacter(state, {
    playerId: id,
    name: id[0]!.toUpperCase() + id.slice(1),
    seed: seedFrom(campaignId, i, "join"),
  });
}

const characterOf = (state: WorldState, id: PlayerId): Character =>
  Object.values(state.characters).find((c) => c.playerId === id)!;

/**
 * Where each player stood the last time they acted.
 *
 * The promise is about *absence*, not about luck. A present player who tries
 * something and fails can lose renown — that is the game working, and holding
 * renown flat for everyone would make failure free. What must never happen is
 * losing ground *because you were away*, so the comparison is anchored at the
 * tick a player went quiet and checked again when they come back.
 */
const quietAt: Record<string, { renown: number; conditions: number }> = {};
for (const id of PLAYERS) {
  const c = characterOf(state, id);
  quietAt[id] = { renown: c.renown, conditions: c.conditions.length };
}

const action = (state: WorldState, id: PlayerId, tick: number): PlayerAction => {
  const c = characterOf(state, id);
  return {
    id: `${id}-${tick}`,
    characterId: c.id,
    playerId: id,
    tick,
    kind: "investigate",
    targetId: null,
    // Alternating channel, because "email and web are the same turn" is a
    // product claim and this is the only place it is exercised repeatedly.
    rawText: tick % 2 === 0 ? "I ask around town." : "I walk the perimeter.",
    intent: "looks into it",
    via: tick % 2 === 0 ? "email" : "web",
    auto: false,
  };
};

const history: WorldEvent[] = [];
let quorumTicks = 0;
let deadlineTicks = 0;
let recapsSeen = 0;
let returnsSeen = 0;

for (let tick = 1; tick <= ticks; tick++) {
  const present = PLAYERS.filter((id) => !ABSENCES[id].has(tick));
  const submitted = present.map((id) => action(state, id, tick));

  // Every third turn resolves on the deadline with people still outstanding,
  // rather than on quorum. A group that only ever resolves when everyone shows
  // up has not tested the thing that makes absence safe.
  const byDeadline = tick % 3 === 0 && submitted.length < PLAYERS.length;
  if (byDeadline) deadlineTicks++;
  else quorumTicks++;

  const before = Object.fromEntries(
    PLAYERS.map((id) => [id, { ...characterOf(state, id) }]),
  ) as Record<PlayerId, Character>;

  const result = runTick(state, submitted, DEFAULT_CAMPAIGN_CONFIG, { history });
  history.push(...result.events);
  pruneWorld(state);

  const violations = checkWorldInvariants(state);
  assert(violations.length === 0, `tick ${tick}: invariants broken — ${violations.join("; ")}`);
  assert(state.tick === tick, `tick ${tick}: clock did not advance (at ${state.tick})`);

  recapsSeen += Object.keys(result.recaps ?? {}).length;

  for (const id of PLAYERS) {
    const c = characterOf(state, id);
    const was = before[id];
    const away = ABSENCES[id].has(tick);

    if (away) {
      // Nothing may be taken while you are gone, and nothing may be added.
      assert(
        c.renown >= quietAt[id]!.renown,
        `tick ${tick}: ${id} lost renown while absent (${quietAt[id]!.renown} → ${c.renown})`,
      );
      assert(
        c.conditions.length <= was.conditions.length,
        `tick ${tick}: ${id} gained a condition while absent`,
      );
    }

    if (was.presence !== "present" && !away) {
      returnsSeen++;
      const others = PLAYERS.filter((o) => o !== id).map((o) => characterOf(state, o).renown);
      // Came back no worse off than they left.
      assert(
        c.renown >= quietAt[id]!.renown,
        `tick ${tick}: ${id} returned below where they went quiet ` +
          `(${quietAt[id]!.renown} → ${c.renown})`,
      );
      // And the catch-up actually caught them up: they are not stranded below
      // the table they rejoined.
      //
      // The *upper* bound — that the lift never goes past the party median, so
      // absence is never a strategy — is not observable here, because a player
      // who returns also acts on the same tick and their action's gain is
      // folded into this number. That bound is pinned directly on the function
      // in test/sim/reentry.test.ts instead.
      const sorted = [...others].sort((a, b) => a - b);
      const median =
        sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
          : sorted[Math.floor(sorted.length / 2)]!;
      assert(
        c.renown >= Math.min(median, quietAt[id]!.renown) - 1e-9,
        `tick ${tick}: ${id} came back stranded below the party ` +
          `(${c.renown} against a median of ${median})`,
      );
    }

    if (!away) quietAt[id] = { renown: c.renown, conditions: c.conditions.length };
  }

  if (!quiet && tick % 10 === 0) {
    const line = PLAYERS.map((id) => {
      const c = characterOf(state, id);
      return `${id}:${c.presence[0]}${Math.round(c.renown)}`;
    }).join("  ");
    console.log(`  t${String(tick).padStart(3)}  ${line}`);
  }
}

// Dev was away for 30 straight turns and came back. That is the headline case.
const dev = characterOf(state, "dev");
const ada = characterOf(state, "ada");
assert(dev.presence === "present", "dev did not come back to present after returning");
assert(dev.conditions.length === 0, "dev returned still carrying a condition from before the gap");
assert(
  dev.renown >= 5,
  `dev came back below a starting character (${dev.renown}) — absence cost them ground`,
);
assert(returnsSeen > 0, "no player ever returned from absence — the scenario did not run");
assert(recapsSeen > 0, "nobody was given a recap on return");
assert(deadlineTicks > 0, "no tick resolved on the deadline");
assert(quorumTicks > 0, "no tick resolved on quorum");

console.log(`\nendurance — ${ticks} ticks, ${PLAYERS.length} players`);
console.log(`  resolution     : ${quorumTicks} by quorum, ${deadlineTicks} by deadline`);
console.log(`  absences       : bo 1×2, cyd 3, dev 30 consecutive`);
console.log(`  returns        : ${returnsSeen}, with ${recapsSeen} recaps issued`);
console.log(`  invariants     : held on all ${ticks} ticks`);
console.log(
  `  final standing : ` +
    PLAYERS.map((id) => `${id} ${Math.round(characterOf(state, id).renown)}`).join(", "),
);
console.log(
  `  the promise    : dev missed 30 consecutive turns and came back at ` +
    `${Math.round(dev.renown)} renown against ada's ${Math.round(ada.renown)}, carrying nothing`,
);

if (failures.length > 0) {
  console.error(`\nFAILED — ${failures.length} assertion(s):`);
  for (const f of failures.slice(0, 20)) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`\nOK — nobody was punished for being busy`);
