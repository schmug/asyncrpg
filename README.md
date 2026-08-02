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

## Playing

A host creates a campaign and gets an invite link. Everyone else opens it,
signs in with their email, and names a character. From then on the story
arrives by email and you reply to it; the web app is there if you want it.

A turn resolves when **a quorum of players has acted or the deadline passes**,
whichever comes first — so an eager group moves fast and a slow group still
moves. Quorum counts only players who are currently present, or a half-dormant
group could never reach it.

Between turns there is optional depth: downtime, in-character letters, and
private scenes that join the chronicle. None of it changes your attributes or
skills, and the tests enforce that — a bonus for showing up is a penalty for
not showing up, just written the other way round.

## Status

Deployed at [play.cortech.online](https://play.cortech.online) and playable end
to end. A public demo chronicle lives at
[/c/demo](https://play.cortech.online/c/demo).

Development is gated by an independent third-party critic (`codex`, fresh
context, read-only sandbox) that scores five rubric categories against a clean
clone plus a live-capture bundle on every cycle. The bar is every category ≥ 8
on two consecutive cycles.

| Gate | What it proves |
|---|---|
| `npm test` | 167 tests, including the absence promise and the world invariants |
| `npm run sim:soak` | 1000+ deterministic ticks, invariants held, replay identical, state bounded |
| `scripts/smoke.mjs` | 61 checks against production, most of them adversarial |
| `scripts/ui-smoke.mjs` | 28 checks driving the real app at a mobile viewport, service workers blocked |
| `scripts/email-e2e.mjs` | 15 checks on live mail configuration and real outbound delivery |

`scripts/email-e2e.mjs` states plainly which hop it does **not** cover (the
inbound SMTP delivery itself) rather than implying end-to-end proof it cannot
provide; that path's logic is covered by
`test/integration/email-handler.test.ts`.
