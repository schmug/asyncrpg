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
> to anything. Conditions actually *heal* while you are offscreen, because an
> injury preserved because you were busy is a penalty wearing a different coat,
> and when you come back `restoreStanding` lifts your renown and your bonds to
> the **middle of the party** — never past it: you are not rewarded for being
> away and cannot overtake the people who showed up; you simply do not resume
> from behind. All of that is enforced by tests and proven by a 1500-tick soak.
>
> A **human DM** has full authority over canon, and every edit they make is
> recorded and attributed in the chronicle. Campaigns with no DM — and campaigns
> whose DM edits nothing — get the promise absolutely.

There is no XP ladder to fall behind on either. What showing up buys is *story*:
the people who played are the ones the chronicle is about, permanently. That is
the only asymmetry, it is deliberate, and it is worth nothing mechanically. See
the spec for why the line is drawn there.

Today the second paragraph describes the design, not shipped behaviour: **no DM
can change world state yet.** The seat that ships reaches prose, timing, and the
seat itself, so every campaign currently gets the promise absolutely. The typed
canon ops that would make a DM's authority real are specified in
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
action, and turn resolved events into prose. **It is never asked for a state
change at all** — there is no channel through which one could arrive. Its
action output is one verb from a fixed enum plus a target the sim resolves
against entities that already exist, and its narration output is prose that is
read, never written back. A model that invents "the Duke of Nowhere" produces
an action with no target, never a new entity. It cannot invent a faction,
resurrect a dead NPC, or move your party across the map, because nothing it
emits is a state edit.

That is a stronger guarantee than validating proposed deltas and rejecting the
illegal ones: there is no delta path to get wrong.

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
                    4. LLM narrate          events + state → prose + one scene
                                            line (read, never written back);
                                            unusable → templated fallback
                    5. project → D1         the queryable chronicle
                    6. hold for review      only if the campaign has a DM
                    7. fan out              email + web
```

There is no delta channel to validate, because there is none to propose on.
The narrator is asked for exactly two strings — the beat's prose and a bounded
one-line scene description — and neither is ever written to world state. Output
that is empty, mangled, or over budget falls through to templated prose
generated directly from the same simulation events, so a tick always resolves.

A tick resolves when **quorum acts or the deadline elapses**, whichever comes
first — so an eager group moves fast and a slow group still moves. Quorum
excludes offscreen players, or a half-dormant group could never reach it, and
quorum reached during a review window does not resolve the next turn early.

Step 6 moves nothing: canon has already advanced and the beat is already written
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
npm run smoke:local  # HTTP smoke against a local worker + local D1
```

`smoke:local` targets `http://localhost:8788`, so start the worker on that port
(`npx wrangler dev --port 8788`). The suite refuses to guess a target: it picks
its D1 database from the base URL's host, and `npm run smoke --local` does not
work because npm eats the flag before the script sees it.

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

When a window opens the DM is emailed the held beat, a link to it, and the time
it publishes on its own. That mail is best-effort by design: the window closes
on its alarm whether or not it was delivered, so a bounce costs a notification
and never a turn.

Within the window the DM reads the held beat and can rewrite its prose, or
publish immediately. Doing nothing is also fine — when the window expires the
beat publishes as written. Publication is idempotent, and a held beat is
published by the next tick's resolution before anything else happens, so no
combination of a lost alarm, a duplicated publish, or a silent DM can leave a
resolved beat unseen or mail it twice.

### The seat reverts if nobody is sitting in it

Three consecutive windows that expire untouched hand the seat back to the host.
Going quiet costs the DM nothing else — it just moves the chair to someone who
is there, which is the same principle the absence policy applies to players.

"Untouched" is narrow and deliberate. Rewriting the beat breaks the streak, and
so does publishing early; only a window that ran out its clock with no edit
counts against the seat. A seat vacated mid-window is not charged for the
silence, and a reverted host starts from a clean slate — the count is zeroed and
the window returns to the cadence default, exactly as it would for any other
incoming DM.

### The DM's controls

Five endpoints, all under `/api/campaigns/:slug`:

| Method | Path | Who | Does |
|---|---|---|---|
| `POST` | `/dm` | host or DM | assign the seat, or vacate it with `{ playerId: null }` |
| `GET` | `/dm/review` | DM | the latest beat, whether it is held, and when the window closes |
| `PATCH` | `/dm/beat` | DM | rewrite prose; keeps `original_prose`, records `revised_by` |
| `POST` | `/dm/publish` | DM | publish now, collapsing the window |
| `PATCH` | `/dm/window` | DM | set the window, clamped to the cadence cap and told when clamped |

Everything under `/dm/` answers a uniform **403** to anyone who is not the
sitting DM. A non-member and a member without the seat get the identical
refusal, so neither response becomes an oracle for who is in a campaign.

### In the app

The campaign view carries a DM panel, and it shows two different things to two
different people. The sitting DM gets the review desk: the held beat in an
editable box, when it publishes on its own, **Save changes**, and **Send it to
the group**. A host who is not the DM gets only the seat control, so a campaign
can never end up with a DM nobody can replace. Everyone else sees no panel at
all — and has no held prose in their response to begin with, because the server
filters it out before the page ever runs.

Handing the seat over is a dropdown of the cast plus "Nobody — publish turns
immediately", which is the vacate path rather than a separate control.

The window length is not settable in the app yet; it is `PATCH /dm/window` only.

### What a DM cannot do yet

**A DM cannot change world state.** What ships today reaches prose, timing, and
the seat itself. The typed canon ops (`npc.set`, `faction.set`, `chronicle.add`,
and the rest), the undo log, and the plain-English front door that proposes ops
for confirmation are all specified in
[`docs/specs/2026-08-08-dm-role-design.md`](docs/specs/2026-08-08-dm-role-design.md)
§5 and §6 — and none of them are built. Until they are, the simulation remains
the only thing that writes canon, and the absence promise above holds
absolutely for every campaign.

## Status

Deployed at [play.cortech.online](https://play.cortech.online) and playable end
to end. A public demo chronicle lives at
[/c/demo](https://play.cortech.online/c/demo).

**The DM seat is newer than that deployment.** It is merged and tested on a
feature branch and is not on `main`, so read [The DM seat](#the-dm-seat) as
branch behaviour — verified against the code and the local gates — unless you
have checked the live deployment yourself. The gate table below distinguishes
what was actually run from what was only counted.

Development is gated by an independent third-party critic (`codex`, fresh
context, read-only sandbox) that scores five rubric categories against a clean
clone plus a live-capture bundle on every cycle. The bar is every category ≥ 8
on two consecutive cycles.

| Gate | What it proves |
|---|---|
| `npm test` | 577 tests across 27 files, including the absence promise, the world invariants, and the DM seat, review window, and seat reversion |
| `npm run typecheck` | clean |
| `npm run sim:soak -- --ticks 1500` | 1500 deterministic ticks, invariants held on every one, replay identical, an absent player unpenalised, economy and state size bounded |
| `npm run sim:endurance` | 4 players over 60 ticks — quorum and deadline resolution, absences of 1/3/30 turns, re-entry recaps, and the no-penalty promise asserted every turn |
| `scripts/smoke.mjs` | 95 assertions against a served target, most of them adversarial |
| `scripts/ui-smoke.mjs` | 60 assertions driving the real app at a mobile viewport, service workers blocked |
| `scripts/email-e2e.mjs` | 23 assertions including a full round trip through real Cloudflare Email Routing |

The first three rows were run against this revision. The rest were not:
`sim:endurance` arrived with a merge from `main` and has not been re-run here,
and the last three each need a served target — the email suite needs real
Cloudflare Email Routing besides. Their numbers are **assertion call sites
counted in the scripts themselves**, not the totals a run prints —

```bash
grep -cE '^[[:space:]]*(await )?check\(' scripts/smoke.mjs scripts/ui-smoke.mjs scripts/email-e2e.mjs
```

— and a run reports a slightly higher number, because a few of those sites
execute inside loops. Treat them as the shape of the coverage, not as a passing
score.

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
