# asyncrpg

An asynchronous, multiplayer, play-by-email tabletop RPG with a simulated world
and a language model as narrator. One person in the group can also hold a
**DM seat** and edit the story before the group reads it — see
[The DM seat](#the-dm-seat).

Your group picks a cadence — daily, weekly, or monthly — and the story advances
on that clock, forever if you want. Miss a week because life happened and
nothing bad occurs: your character keeps acting in character, then quietly
steps offscreen, then rejoins with a recap whenever you come back.

Precisely:

> The **simulation** never penalizes absence — never, for any length of absence,
> costs you attributes, skills, renown, items, conditions, your life, or access
> to anything. That is enforced by tests and proven by a 1500-tick soak.
>
> A **human DM** has full authority over canon, and every edit they make is
> recorded and attributed in the chronicle. Campaigns with no DM — and campaigns
> whose DM edits nothing — get the promise absolutely.

There is also no XP ladder to fall behind on. Absence does mean fewer entries in
the chronicle than someone who played every week — story presence is the one
thing engagement buys, and it buys nothing mechanical. See the spec for why that
line is drawn where it is.

Today the second paragraph describes the design, not shipped behaviour: **no DM
can change world state yet.** The seat that ships now reaches prose and timing
only, so every campaign currently gets the promise absolutely. The typed canon
ops that would make a DM's authority real are specified in
[`docs/specs/2026-08-08-dm-role-design.md`](docs/specs/2026-08-08-dm-role-design.md)
and are not built.

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

The DM seat does not weaken this. A human DM edits prose, and the design that
would eventually let one edit canon routes every change through the same typed,
validated, recorded shape the simulation already uses — never through model
output. "Nothing untyped writes to canon" is the invariant, and it does not
move.

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
                    7. hold for review      only if the campaign has a DM
                    8. fan out              email + web
```

A tick resolves when **quorum acts or the deadline elapses**, whichever comes
first — so an eager group moves fast and a slow group still moves. Quorum
excludes offscreen players, or a half-dormant group could never reach it, and
quorum reached during a review window does not resolve the next turn early.

Step 7 moves nothing: canon has already advanced and the beat is already written
by the time it runs, so only delivery waits. Campaigns with no DM skip it.

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

## The DM seat

A campaign can have one human DM. The seat is **not** the same thing as the
host: the host owns the campaign, mints invites, and holds the ops controls; the
DM shapes the story.

- It **defaults to the campaign creator**, so a new campaign has a DM without
  anyone configuring anything.
- It **transfers to any member**. The sitting DM or the host can move it.
- The **host can always reclaim it.** That is the un-loseable backstop — a seat
  can never be handed away irrecoverably.
- It **can be vacated**, and a campaign with no DM behaves exactly as it did
  before this feature existed: beats publish and fan out the moment a tick
  resolves.

### The review window

When a campaign has a DM, a resolved beat is written but held back briefly
before the group sees it.

The tick itself is unaffected. **Canon still advances exactly on the cadence
clock** — the simulation runs, actions resolve, events are recorded and
projected on the same schedule as always. Only *publication* waits. The window
is carved out of the *front* of the next cycle rather than added to it, so a
weekly campaign that resolves Sunday 09:00 with a 24-hour window publishes
Monday 09:00 and still resolves the following Sunday 09:00. Players get six days
instead of seven; the clock never drifts.

| Cadence | Default window | Cap |
|---|---|---|
| daily | 2h | 8h |
| weekly | 24h | 56h |
| monthly | 72h | 10 days |

The window is configurable per campaign and clamped to the cap for the cadence,
which is a third of the cycle in each case — past that the story stops feeling
like it runs on a clock. Left unset it tracks the cadence default, so changing
cadence does the right thing without a second edit.

A window of **0** is a first-class setting, not a degenerate one: it reproduces
today's timing and fan-out exactly, for a group that wants a DM without any
latency.

Within the window the DM reads the held beat and can rewrite its prose, or
publish immediately. Doing nothing is also fine — when the window expires the
beat publishes as written. Publication is idempotent, and a held beat is
published by the next tick's resolution before anything else happens, so no
combination of a lost alarm, a duplicated publish, or a silent DM can leave a
resolved beat unseen or mail it twice.

### What a DM cannot do yet

**A DM cannot change world state.** What ships today reaches prose and timing
only. The typed canon ops (`npc.set`, `faction.set`, `chronicle.add`, and the
rest), the undo log, and the plain-English front door that proposes ops for
confirmation are all specified in
[`docs/specs/2026-08-08-dm-role-design.md`](docs/specs/2026-08-08-dm-role-design.md)
§5 and §6 — and none of them are built. Until they are, the simulation remains
the only thing that writes canon, and the absence promise above holds
absolutely for every campaign.

Also specified and not yet built: reverting the seat to the host after three
consecutive review windows expire untouched. Today an expired window costs the
DM nothing.

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
| `npm test` | 264 tests, including the absence promise, the world invariants, and the DM seat and review window |
| `npm run sim:soak -- --ticks 1500` | 1500 deterministic ticks, invariants held on every one, replay identical, an absent player unpenalised, economy and state size bounded |
| `scripts/smoke.mjs` | 61 checks against production, most of them adversarial |
| `scripts/ui-smoke.mjs` | 28 checks driving the real app at a mobile viewport, service workers blocked |
| `scripts/email-e2e.mjs` | 22 checks including a full round trip through real Cloudflare Email Routing |

The email test is a genuine loop, not a simulation of one: the game mails a
beat to a reserved address on a **second** onboarded zone, Cloudflare delivers
it back to the Worker, the Worker replies, Cloudflare delivers *that* to the
Worker, and the reply becomes a turn. Two zones, two real deliveries.

It caught a bug nothing else could have. The inbound handler authenticated on
the SMTP envelope sender — but Cloudflare rewrites that to
`bounces@cf-bounce.<domain>` on mail it sends, so every legitimate reply was
being rejected as an unregistered address. Identification now falls back to the
header From, which is safe here specifically because Email Routing enforces
SPF/DKIM/DMARC before the handler ever runs.

Still not covered: deliverability to third-party mailboxes and their spam
handling. That needs seed-list testing, not a self-test.
