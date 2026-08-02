# asyncrpg

An asynchronous, multiplayer, play-by-email tabletop RPG with a simulated world
and a language model as dungeon master.

Your group picks a cadence — daily, weekly, or monthly — and the story advances
on that clock, forever if you want. Miss a week because life happened and
nothing bad occurs: your character keeps acting in character, then quietly
steps offscreen, then rejoins with a recap whenever you come back. There is no
XP ladder to fall behind on and no penalty of any kind for absence.

Play from your inbox. A richer web interface is there if you want it.

## The core idea

> **The simulation is canon. The LLM is a narrator with no authority over state.**

The world is a deterministic simulation — a pure function with a seeded PRNG,
no I/O, and no `Math.random()` anywhere. Factions pursue agendas, threats
escalate, settlements prosper and revolt, NPCs remember exactly how you treated
them. All of it advances whether or not anyone shows up.

The model does two schema-bounded jobs: turn what you typed into a typed
action, and turn resolved events into prose. Any state change it proposes is
validated against the sim's rules and **rejected if illegal**. It cannot invent
a faction, resurrect a dead NPC, or move your party across the map.

That constraint is what buys coherence over months of play. The baron your
party snubbed in tick 3 is a row with a grudge value, not a sentence in a
summary that will eventually be compacted away.

It also means the game degrades gracefully rather than breaking: with the API
key removed entirely, ticks still resolve and the chronicle is still readable,
because every event carries a deterministic summary written by the sim itself.

## Try the simulation without deploying anything

```bash
npm install
npm run sim:soak -- --ticks 500
```

This generates a world, simulates 80 years of history before play begins, runs
500 ticks, asserts every invariant after each one, and replays the whole thing
to prove determinism. No API key, no network, no inference.

## Architecture

```
email in ──► Worker email()  ─┐
                              ├─► CampaignDO  ── alarm() = the tick clock
web/PWA  ──► Worker fetch()  ─┘   DO SQLite = canonical world state
                                        │
                                        ▼   tick resolution
                    1. sim drift            deterministic world advance → events
                    2. player actions       seeded dice vs sim rules → events
                    3. absence policy       auto-act │ offscreen
                    4. LLM narrate          events + state → prose + deltas
                    5. validate deltas      illegal → reject → templated fallback
                    6. project → D1         the queryable chronicle
                    7. fan out              email + web
```

A tick resolves when **quorum acts or the deadline elapses**, whichever comes
first — so an eager group moves fast and a slow group still moves. Quorum
excludes offscreen players, or a half-dormant group could never reach it.

| Store | Holds |
|---|---|
| Durable Object SQLite (one per campaign) | canonical world state, pending actions |
| D1 | chronicle projection, player index, token budgets |

## Layout

```
src/sim/      deterministic world model — pure, no I/O, fully testable
  prng.ts       seeded RNG; the basis of every replayability claim
  types.ts      the canonical world model
  invariants.ts the contract every write path must satisfy
  names.ts      procedural naming, no inference
  genesis.ts    world creation + simulated pre-play history
  drift.ts      per-tick world advance (used for history AND live play)
docs/specs/   the design spec this was built against
scripts/      sim soak, smoke tests, critic harness
```

## Development

```bash
npm test           # vitest against real Durable Objects and D1
npm run typecheck  # tsc over src/test and scripts separately
npm run sim:soak   # 500 deterministic ticks + invariant + replay checks
npm run dev        # local worker
```

## Status

In active development against `docs/specs/2026-08-02-asyncrpg-design.md`, gated
by an independent third-party critic that scores five rubric categories on
every deploy. Not yet playable end to end.
