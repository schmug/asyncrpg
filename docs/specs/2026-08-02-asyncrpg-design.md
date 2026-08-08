# asyncrpg — Design Spec

**Date:** 2026-08-02
**Status:** Approved, in build
**Live target:** https://play.cortech.online

## 1. Problem

Tabletop RPGs require synchronous scheduling. Adult groups cannot reliably get
5 people in a room — or a Discord call — on a recurring basis. Play-by-post
solves scheduling but introduces a new failure: the campaign stalls on whoever
is busiest, and a player who disappears for three weeks returns to a story that
either waited resentfully for them or moved on without them.

We want a group narrative that:

- advances on a clock the group chooses (daily, weekly, monthly), forever if
  they want;
- imposes **no mechanical penalty** for absence of any length;
- produces a durable, shareable artifact the group can reference and retell —
  not a chat log;
- is reachable from a phone with no app install, via email;
- rewards players who want to engage more, without punishing those who cannot.

## 2. Core architectural bet

> **The simulation is canon. The LLM is a narrator with no authority over state.**

The world is a deterministic simulation: `advance(state, seed, actions) →
{state', events[]}`, a pure function with no I/O and a seeded PRNG. It is
replayable and fully unit-testable without any inference calls.

The LLM has exactly two jobs, both schema-bounded:

1. **Intent parsing** — free text → typed `PlayerAction`.
2. **Narration** — resolved `WorldEvent[]` + state → prose.

> **Implementation note (2026-08-02):** this section originally specified that
> state deltas proposed by the model would be validated against sim rules and
> rejected if illegal. The implementation is stronger: **there is no delta
> channel at all.** The narrator returns prose and a bounded one-line scene
> description, and nothing else it produces is ever written to world state.
> There is no illegal write to catch because there is no write. What the model
> says happened and what the sim recorded cannot diverge, because the sim is
> what it was told.
>
> The intent parser is the only path by which model output influences state,
> and it is doubly constrained: the verb must be in a fixed enum, and the
> target must resolve to an entity that already exists (dead NPCs, razed
> settlements, and unrevealed threats deliberately do not resolve). An
> invented name yields an action with no target, never a new entity.

The model cannot invent a faction, resurrect a dead NPC, or teleport a party.

This is what makes months-long coherence possible: the baron the party snubbed
in tick 3 is a row with an agenda and a grudge value, not a sentence in a
summary that will be compacted away.

### Why not the alternatives

- *Pure LLM + memory doc*: drifts. The known failure is "my six-month campaign
  forgot who the villain was."
- *Light sim, LLM improvises*: cheaper, but the world stops being consistent
  precisely when a campaign gets long enough to be worth retelling.

## 3. Architecture

```
email in ──► Worker email()  ─┐
                              ├─► CampaignDO  ── alarm() = the tick clock
web/PWA  ──► Worker fetch()  ─┘   DO SQLite = canonical world state
                                        │
                                        ▼   tick resolution
                    1. sim.advance()          deterministic world drift → events
                    2. resolve player actions  seeded dice vs sim rules → events
                    3. absence policy          auto-act │ offscreen
                    4. LLM narrate             events + state → prose + deltas
                    5. validate deltas         illegal → reject, retry once,
                                               else sim-only templated prose
                    6. project → D1            the queryable chronicle
                    7. fan out                 email + web
```

### Storage split

| Store | Holds | Why |
|---|---|---|
| **DO SQLite** (one per campaign) | canonical world state, pending actions, tick log | single-writer, strongly consistent, colocated with the tick alarm |
| **D1** | chronicle projection, player→campaign index, budget ledger | publicly readable without waking a DO; cross-campaign queries |

Writes go to the DO (canon) and project into D1 (read model). The chronicle
page must render for a logged-out reader; that is why it cannot live only in
the DO.

### Scheduling

One Durable Object alarm per campaign. There is no cron, no job table, no
distributed lock — the DO's single-threaded execution *is* the lock.

## 4. The tick

A tick resolves when **quorum acts OR the deadline elapses**, whichever comes
first. An eager group moves fast; a slow group still moves.

- `quorum = ceil(activePlayers / 2)`, configurable per campaign.
- **`activePlayers` excludes offscreen players.** This is load-bearing: if
  dormant players counted toward quorum, a half-dormant group could never reach
  it and would always wait out the full deadline.
- Cadence options: `daily`, `weekly`, `monthly`. Changeable mid-campaign.
- A tick **always resolves.** See §8.

## 5. Absence — the no-penalty promise

> **Implementation note (2026-08-08):** this section's promise was written when
> the simulation was the only thing that could write canon. The human DM role
> specified in [`2026-08-08-dm-role-design.md`](./2026-08-08-dm-role-design.md)
> adds a second, bounded write path, so the promise splits. It is restated —
> more precisely, not more weakly — as:
>
> > The **simulation** never penalizes absence — never, for any length of
> > absence, costs you attributes, skills, renown, items, conditions, your life,
> > or access to anything. That is enforced by tests and proven by a 1500-tick
> > soak.
> >
> > A **human DM** has full authority over canon, and every edit they make is
> > recorded and attributed in the chronicle. Campaigns with no DM — and
> > campaigns whose DM edits nothing — get the promise absolutely.
>
> Everything below this note is the simulation-side promise, and it is unchanged
> and still enforced. `sim:soak` runs with zero DM ops, so it goes on proving
> exactly what it proved before.
>
> Slice 1 of the DM role — the seat, the review window, and prose editing — is
> the only part built. It touches world state not at all, so **as of this note
> every campaign gets the promise absolutely**, DM or no DM. The typed canon ops
> of §5 of that spec, which are what would make a DM's authority real, are
> specified and unbuilt.

| Missed ticks | Behavior |
|---|---|
| 1–2 | `drifting`: Haiku selects a low-risk action consistent with the character's `tendencies` and the current scene. The character stays in the scene. The chronicle marks the action `[drifting]` so the group can see it was not a real choice. |
| 3+ | `offscreen`: narratively sidelined with a generated in-fiction reason. State frozen. Excluded from quorum. |
| return, any time | Recap generated from chronicle deltas since `lastActedTick`; re-enters on the next tick. |

**Never, for any length of absence:** stat loss, item loss, death, removal, or
missed-content penalty.

### What "no penalty" precisely means

An independent review found the promise, as originally worded, overclaimed.
Stating it exactly:

**Guaranteed, and enforced by tests.** For any length of absence, a character
never loses attributes, skills, renown, items, or conditions; never dies or is
removed; and never has content locked away from them. An action the DM takes on
their behalf is floored *and capped* at a partial success, cannot apply a
condition, cannot reduce renown, and cannot advance the absence clock. There is
no level, no XP, and no gear treadmill to fall behind on. A player who joins at
tick 200 starts from the same spread as one who joined at tick 1.

**Not guaranteed, and deliberately so.** A player who plays more accrues more
*story presence* — more entries in the chronicle, warmer relationships with
NPCs, a wider reputation. That is the point of the depth features, which were
requested precisely so that people who want to do more can. Renown feeds
difficulty, so a well-known character faces different situations, not easier
ones; and it is shown as a phrase rather than a score so it does not read as a
leaderboard.

The distinction is between *penalty* and *difference*. Being away costs you
nothing. Being present earns you a place in the story. A design where those two
were identical would have nothing for the engaged player to do, which was an
explicit requirement.


There is also **no XP ladder to fall behind on.** Advancement is reputation and
relationships recorded by the sim — you become *known for* things — not levels.
A player who misses 30 ticks is not mechanically behind the group; they simply
have fewer entries in the chronicle. This is a deliberate design choice in
service of the core promise, and it is also more faithful to the Dwarf
Fortress / Caves of Qud lineage than a level treadmill would be.

## 6. World simulation

### Entities

`Region`, `Settlement`, `Faction`, `NPC`, `Resource`, `Threat`, `Artifact`.
Each carries typed numeric/enum state — no free-text-only entities, because
free text cannot be simulated against.

### Genesis

At campaign creation, generate N years of world history from a seed:
faction rises and falls, settlement founding, wars, legendary figures, feuds.
This is deterministic simulation plus a light LLM naming pass. The group starts
inside a world that already has a past to discover.

### Advance

Per tick, deterministic rules run independent of players: faction agendas
progress, resources deplete, threats escalate, NPC relationships shift on
grudge/favor values. Emits `WorldEvent[]`.

The world moves whether or not anyone shows up. That is the Dwarf Fortress
property, and it is also what makes absence safe — nothing is *waiting* on you.

### Action resolution

Typed actions resolve against sim rules with a seeded PRNG. Same seed + same
state + same actions ⇒ same outcome, always.

### Soak

`npm run sim:soak` runs 500 ticks with no LLM and dumps a chronicle. This
proves emergence deterministically and at zero inference cost, and is the
primary evidence that the world model is real rather than decorative.

## 7. Channels

### Email (primary)

- Outbound from `dm@play.cortech.online`.
- `Reply-To: play+<token>@play.cortech.online` where `token` is an HMAC-signed
  `(campaignId, playerId, tickId)`.
- Inbound verification requires **all** of:
  1. valid HMAC over the token payload;
  2. envelope sender matches the player's registered address;
  3. tick is current or next (replay defense).

  A leaked email alone must not let a third party act as that player.
- Parsing: `postal-mime`, then quoted-reply stripping (`>` prefixes,
  `On … wrote:` lead-ins, `-- ` signature delimiter).
- Threading: `In-Reply-To` / `References` keep a campaign as one mail thread.

`play.cortech.online` is onboarded as its own Email Routing + Email Sending
subdomain. The apex `cortech.online` catch-all (→ Worker `agentic-inbox`) is
**not** modified.

### Web PWA (advanced surface)

Mobile-first. Magic-link auth over the same email channel — no passwords.
Shows the live scene, action composer, character sheet, party status, downtime
actions, letters, journal, and the chronicle.

### Chronicle

Public read-only page per campaign: timeline of events, entity dossiers,
character histories, world map summary. This is the shareable artifact.

## 8. Failure posture

**The tick always resolves.** There is no state in which a campaign wedges.

| Failure | Behavior |
|---|---|
| LLM emits invalid delta | retry once with the validation error appended; then fall back to templated prose generated directly from sim events |
| LLM unreachable / budget exceeded | same templated fallback; tick still advances |
| Email send fails | retried; the beat remains readable on the web |
| DO alarm fails | platform retries alarms |

Cost control: per-campaign monthly token budget plus a global kill switch, both
in D1. Exceeding either degrades narration quality — it never blocks play.

## 9. Verification ladder

1. **Unit/integration** — Vitest with `@cloudflare/vitest-pool-workers` against
   real Durable Objects and real D1.
2. **HTTP smoke** — happy path plus adversarial: forged tokens, replayed ticks,
   cross-campaign access, duplicate submissions. Test data uses a reserved
   prefix and is cleaned up.
3. **Browser UI smoke** — Playwright at mobile viewport, real taps through the
   core flow, touch-target and a11y audits, console-error gate, screenshots.
   **Service workers are blocked in the smoke context** — offline emulation does
   not reach SW-mediated fetches, so an outage drill would silently test nothing.
4. **Email round trip** — the game mails a beat to a reserved address on a
   *second* onboarded zone; Cloudflare delivers it back to the Worker; the
   Worker replies; Cloudflare delivers that to the Worker; the reply becomes a
   turn. Two zones and two real deliveries, so no part of the mail path can be
   broken without this failing. (Originally scoped as a same-domain
   subaddress loop, which does not work: Cloudflare subaddressing is a
   zone-wide setting, and a single zone would not exercise cross-zone routing.)
5. **Sim soak** — 500 deterministic ticks, no LLM.

A broken verification harness is a P0 defect, not an inconvenience.

## 10. Scope

### In v1

Campaign creation with world genesis; n-player parties; daily/weekly/monthly
cadence; quorum + deadline ticks; graduated absence; email play; mobile web
PWA; chronicle; downtime actions; in-character letters; solo scenes and
journals; magic-link auth; budget controls.

### Explicitly out of v1

Chronicle curation (annotation, legend-naming, moment voting); SMS; public
self-serve signup; billing; generated images; voice. These are filed as issues
rather than silently dropped.

## 11. Ship gate

Independent critic: `codex exec` (`gpt-5.5`), fresh context, read-only sandbox,
clean clone plus live-capture bundle. Five categories, 1–10:

1. `product` — Product fitness: does it deliver an async, n-player, LLM-DM'd RPG?
2. `async` — Async & absence resilience: is the no-penalty promise real in code?
3. `narrative` — Narrative & world-sim quality: is the sim canon and the
   chronicle worth retelling?
4. `ux` — Mobile + email UX: can a non-technical player play from a phone?
5. `rigor` — Engineering rigor & security: tests, adversarial resistance, error
   handling, cost controls.

**Gate:** every category ≥ 8 on two consecutive cycles. Cap 12 cycles; on cap,
stop and report gaps.
