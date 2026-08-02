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
- A tick **always resolves, or the campaign visibly halts and can be resumed.**
  It never silently stops moving. See §8.

## 5. Absence — the no-penalty promise

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

- Outbound from `dm@cortech.online`.
- Every beat carries an HMAC reply capability over `(campaignId, playerId,
  tick)` — 16 base32 characters, 60 bits of tag — minted in
  `src/email/token.ts`.

#### Where the capability rides, and why it is not the Reply-To

This was specified as `Reply-To: play+<token>@…`, which is where a capability
belongs. Two Cloudflare constraints made that unavailable:

- **Email Routing matches rules on exact addresses.** A plus-addressed reply
  is not covered by the `rpg@cortech.online` rule, and the apex catch-all on
  this zone is already routed to an unrelated Worker — so a plus-addressed
  reply would be delivered somewhere else entirely. Fixing that is a zone-level
  change owned by the domain's owner, not by this app.
- **Email Sending rejects a caller-supplied `Message-ID`** ("Only whitelisted
  headers and X-\* headers are accepted"), so the threading id cannot be chosen
  by us either; it is read back off the send response.

The subject code is the one carrier that survives every mail client's reply
without a zone change, so the capability rides there:
`[Ashfall #<token>] Tick 14 — …`. A subject is a weaker place to keep a secret
than an address — it is quoted into forwards and shown in notifications — so
possession of a token is deliberately **not sufficient on its own**.

#### What inbound verification actually requires

`src/email/inbound.ts` requires **all** of:

1. **DMARC-authenticated sender.** Cloudflare Email Routing enforces
   SPF/DKIM/DMARC before the handler runs. The envelope sender is checked
   first, then the header `From` — the fallback is necessary because Cloudflare
   rewrites the envelope sender of its own outbound mail to
   `bounces@cf-bounce.<domain>`, and safe only because DMARC is precisely an
   alignment check on the header `From` domain. Without that enforcement in
   front, this fallback would be spoofable.
2. **The sender is a registered player and a member of the bound campaign.**
3. **The token authenticates the binding it resolves to** — a token edited to
   name another player or an earlier tick no longer verifies, and is treated as
   absent rather than as proof.
4. **The binding's tick is current or the one just past** (replay defense); an
   older reply bounces with a pointer to the current turn.

A leaked or forwarded email alone therefore does not let a third party act as
that player: they would also have to pass DMARC as that player's address.

#### The two accepted weakenings, stated plainly

- **Fresh mail from a player in exactly one campaign is accepted with no
  token.** This is a deliberate product decision, not an oversight: "just email
  us what you do" is the primary channel's whole appeal, and the sender is
  already DMARC-authenticated and a known member. A player in several campaigns
  gets no such guess and must reply to a beat.
- **Tokens minted before this scheme, or while no secret was configured, cannot
  be verified** and rest on the stored binding alone. Rejecting them would
  invalidate every beat already sitting in someone's inbox; they age out with
  their 90-day expiry.

Each of spoofing, forwarding, replay, and ambiguity has a test in
`test/integration/email-handler.test.ts`, and the token's own properties in
`test/email/token.test.ts`.
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

**The tick always resolves, or the campaign says out loud that it cannot.**
There is no state in which a campaign silently wedges — which is the claim that
actually matters, and is weaker than the one this section used to make.

| Failure | Behavior |
|---|---|
| LLM output unusable (spliced, truncated, fenced) | fall back to templated prose generated directly from sim events; tick still advances |
| LLM unreachable / budget exceeded | same templated fallback; tick still advances |
| Email send fails | retried, then recorded in `delivery_failures` and shown to the player it was owed to; the beat remains readable on the web |
| Inline resolve fails after an action is accepted | the action is already stored; the alarm resolves the tick instead. Late, not lost |
| DO alarm fails | platform retries alarms |
| A tick would violate a world invariant | rolled back whole, a "blocked" beat is written, pending actions cleared, and the tick retried on the next alarm |
| **The same tick fails its invariants 3 times running** | **the campaign halts and stops scheduling** |

That last row is the honest exception. Clearing the pending queue changes the
inputs, so a violation caused by a player's action is genuinely fixed by
retrying. One caused by deterministic world drift is not: the same state
produces the same drift and the same rejection on every alarm, forever. A
campaign that looks alive and never moves is worse than one that admits it has
stopped, so after `BLOCKED_TICK_LIMIT` consecutive rejections it halts, reports
the violations in its snapshot, and offers the host `resume()`.

The policy is a pure function (`blockedTickPolicy`) with tests in
`test/integration/blocked-ticks.test.ts`, including that no path through it
reschedules indefinitely — "does not loop forever" is otherwise only observable
by waiting forever.

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
