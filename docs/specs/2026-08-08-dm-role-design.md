# asyncrpg — Human DM Role

**Date:** 2026-08-08
**Status:** Approved, not yet built
**Extends:** [`2026-08-02-asyncrpg-design.md`](./2026-08-02-asyncrpg-design.md)

## 1. Problem

The campaign creator has no way to improve the story. If a tick narrates badly,
misses the obvious dramatic beat, or resolves in a way that is technically legal
and narratively flat, the group reads it and moves on. The only lever is waiting
for the next tick.

Real tabletop groups solve this with a person. We want the same: the creator
holds a **DM seat** with authority to edit the story — and can hand that seat to
whoever in the group actually wants to run things.

Two constraints make this non-trivial:

1. The project's central bet is that **nothing untyped writes to canon**
   (§2 of the base spec). A human editor is a new write path.
2. The project promises **the tick always resolves** (§8). A human review step
   is a human on the critical path.

This spec resolves both without weakening either.

## 2. Core claim

> **The simulation is canon. The model has no authority over state. A human DM
> has bounded, recorded, invariant-checked authority.**

Canon changes today through exactly two typed, ordered, recorded inputs:
deterministic drift, and player actions. The DM becomes a **third input of the
same shape** — a `DmOp[]`, typed, validated against `checkWorldInvariants`,
recorded in sequence, replayable.

The determinism claim does not weaken. It restates:

| | |
|---|---|
| Before | `replay(seed, actions) → identical state` |
| After | `replay(seed, actions, dmOps) → identical state` |

`sim:soak` continues to run with zero DM ops, so it still proves the simulation
itself is untouched by this feature.

What is being relaxed is "only the sim writes." What is **not** relaxed is
"untyped things can write." The model still never writes state — not through
narration, and not through the free-text front door, where it only *proposes*
ops that a human confirms.

### Why not the alternatives

- *Prose-only editing.* Zero risk, and it was the first option considered. It
  cannot express "the baron actually dies of those wounds," which is most of
  what a DM is for. A DM who can only change how a turn reads, never what
  happened, will eventually write prose that contradicts state — the exact
  divergence the base architecture exists to prevent.
- *Free text applied directly to state.* Puts model output back into canon.
  This is the one thing the base design refuses, and the refusal is why
  six-month campaigns stay coherent.
- *Raw state editing.* Maximum expressiveness, no ceiling on damage. One bad
  paste corrupts a campaign that has been running for months, and nothing in
  the audit trail explains what the DM meant.

## 3. The DM seat

| Property | Decision |
|---|---|
| Relationship to host | **Distinct.** Host owns the campaign, mints invites, holds ops controls. DM edits the story. |
| Holders | **Exactly one**, structurally — a single `campaigns.dm_player_id` column. |
| Default | The campaign creator. |
| Transfer | The current DM or the host may assign it to any member, at any time. |
| Reclaim | The host can always take it back. This is the un-loseable backstop. |
| Vacancy | The seat may be **empty**. A DM-less campaign behaves exactly as the system does today. |
| Playing | The DM keeps their character and plays normally. Every edit is attributed, so a DM favouring their own PC is visible rather than prevented. |

A DM who is absent is not a problem the system needs to solve harshly — the
review window simply times out (§4). But a *permanently* absent DM would leave
the seat dead, so after **three consecutive windows expiring untouched** the seat
reverts to the host and the host is notified. This mirrors the product's own
absence philosophy: going quiet costs nothing, it just hands the chair to
someone who is there.

`memberships.role` remains vestigial. It is written at join time and read
nowhere; authorization lives on `campaigns.created_by` (host) and
`campaigns.dm_player_id` (DM). Leave it, and say so in the migration — SQLite
cannot alter a CHECK constraint, and churning the table earns nothing.

## 4. The review window

The Durable Object has exactly one alarm, and today it means "resolve the tick."
It becomes a two-phase machine.

```
phase=open   alarm ──► resolveTick()
                       canon advances, beat narrated and written HELD
                       (not published, not mailed)
                       notify the DM only
                       ──► phase=review, alarm = now + reviewWindow

phase=review alarm ──► publish the beat, fan out to players
             (or DM  ──► phase=open, alarm = the next tick deadline
              publishes
              early)
```

**The cadence deadline is absolute.** The window is carved out of the *front* of
the next cycle, never added to it. A weekly campaign resolving Sunday 09:00 with
a 24h window publishes Monday 09:00 and still resolves the following Sunday
09:00. Players get six days instead of seven; the clock never drifts.

| Cadence | Default window | Hard cap |
|---|---|---|
| daily | 2h | 8h (⅓ of cadence) |
| weekly | 24h | 56h |
| monthly | 72h | 10d |

`campaigns.review_window_ms` NULL means "use the cadence default," so changing
cadence does the right thing without a second edit.

### Window zero, and editing after publication

A window of **0** skips the `review` phase entirely: the beat publishes and
fans out exactly as it does today, and the DM edits afterward. This is a
first-class mode, not a degenerate case — a group that trusts the narrator and
wants zero latency should be able to have both a DM and today's timing.

Editing after publication is therefore always available, at any window length,
for any past tick. It behaves identically to editing during the window, with one
honest difference: **mail already sent cannot be unsent.** The chronicle and the
web app show the revised version; the email in someone's inbox shows what was
sent. The app says so plainly when the DM edits a published beat, rather than
implying a reach it does not have.

Ops applied to a *past* tick are recorded against that tick's `seq` sequence but
apply to current world state — the sim has no rewind, and pretending otherwise
would break replay. The audit row records both, so "edited tick 12 on tick 15"
is legible later.

### Two things that could have been bugs and are not

**Early quorum** just opens the window early. The beat lands sooner. No special
case is needed.

**Actions submitted during the window** are already correct. `pending` stores
raw text and does not parse it until the *next* resolution
(`campaign-do.ts` `resolveTick`), so an action written mid-window automatically
resolves against post-edit canon. The app shows "the DM is working on this
turn"; submission stays open, because a player with thirty seconds on their
phone should never be locked out.

### Publication is idempotent and self-healing

A lost review alarm must not strand a beat forever. Publication is keyed on
`beats.published_at IS NULL` and is safe to call twice. The next tick's
resolution publishes any still-held beat **before** doing anything else. Between
those two properties there is no state in which a resolved beat is never seen.

## 5. Ops

Every op names a field the simulation already reasons about, so nothing the DM
writes is free text the world cannot act on.

| Op | Reaches |
|---|---|
| `npc.create` · `npc.set` | name, role, faction, location, `alive`, traits, `attitudes[chr]`, renown |
| `faction.create` · `faction.set` | power, treasury, seat, `relations[fac]`, `defunct`, agenda (kind/target/progress/urgency) |
| `settlement.set` | population, prosperity, defense, unrest, controller, `razed` |
| `region.set` | danger, controller |
| `threat.create` · `threat.set` | kind, region, severity, growthRate, `revealed`, `resolved` |
| `character.set` | conditions, renown, `bonds[id]`, location, presence, attributes, skills |
| `scene.set` | region, settlement, situation, tension |
| `chronicle.add` | a `WorldEvent` with a hand-written summary and significance — **no numeric change** |

`chronicle.add` earns its place: it is the escape hatch that stops a DM from
abusing numeric ops to express a story beat the sim has no rule for. Without it,
"the innkeeper finally forgives you" becomes an arbitrary `attitudes` nudge that
means nothing to the simulation and reads as noise in the audit log.

Two deliberate omissions:

- **No deletes.** Entities retire the way the sim already retires them —
  `defunct`, `razed`, `alive: false`, `resolved`. Deletion breaks references
  that `checkWorldInvariants` would then reject anyway; better not to offer the
  footgun.
- **No region creation.** Region adjacency is symmetry-checked
  (`invariants.ts`), and safe rewiring is more surface than the feature is
  worth. Settlements, threats, factions, and NPCs cover the expressive need.

### Applying an op

1. Apply to a `structuredClone` of world state.
2. **Clamp** numerics to the ranges `invariants.ts` already declares, and tell
   the DM: *"power set to 100, clamped from 150."* An honest fat-finger should
   not be a rejection.
3. Run `checkWorldInvariants`. Violations reject **the op**, not the world — the
   DM sees the reasons, state is untouched, the window stays open.
4. Record `(tick, seq, dmPlayerId, op, note, priorValue, applied, rejectedWhy)`.

Step 3 is deliberately a different granularity from the tick path, which
discards the whole turn on violation. A tick is a machine-generated batch; an op
is one human edit. Rejecting the edit is the proportionate response.

Step 4's `priorValue` is what makes every op exactly reversible. It costs one
column and pays for itself in the email flow (§6).

New entities take ids from the **same positional scheme** the sim uses,
continuing the tick's sequence counter, so a DM-created entity can never collide
with a sim-created one. (A size-derived scheme silently overwrote live entities
once pruning could delete things; that lesson is recorded in `HANDOFF.md` and
must not be relearned.)

`chronicle.add` writes a real `WorldEvent` into both the DO's `history` and the
D1 `events` table, with `kind` from the existing `EVENT_KINDS` enum. It is a
first-class event, not an annotation: it appears in the chronicle, it is
available to the narrator on subsequent ticks, and it is pruned by the same
rules. An event the narrator cannot see is an event that did not happen.

### Prose after a canon edit

An op applied during the window can contradict prose that was narrated *before*
it. A beat saying the baron survives, over a world where the DM just killed him,
is precisely the state/prose divergence this architecture exists to prevent —
and it would be self-inflicted.

So the first applied op of a window marks the held beat **stale**, and the DM
gets three ways out:

| Choice | Behavior |
|---|---|
| Rewrite by hand | `PATCH /dm/beat` — clears stale, sets `revised_by` |
| Re-narrate | `POST /dm/renarrate` — regenerates from post-edit facts via the normal `narrateBeat` path, budget-guarded, falling back to templated prose exactly as a tick does |
| Publish anyway | allowed, with a warning. Sometimes the edit does not touch what the prose says. |

Re-narration is **never automatic**, because automatic regeneration would
silently discard prose the DM had already hand-edited. Staleness is surfaced;
resolving it is a choice.

## 6. The free-text front door

Typed ops are the only thing that touches canon. Natural language is an
ergonomic layer on top, using the same doubly-constrained pattern as
`src/dm/intent.ts`: the verb comes from a fixed enum, and the target must
resolve to an entity that already exists.

Two ergonomics, identical authority:

| Surface | Flow |
|---|---|
| **Web** | DM writes plain words → Haiku proposes typed ops → ops rendered for review → DM confirms → applied. Nothing lands untranslated. |
| **Email** | DM replies to the held-beat notification in plain words → ops apply → a receipt returns with an undo link. One round trip instead of two; `priorValue` makes undo exact. |

The asymmetry is intentional. On the web, a confirm step costs one tap. Over
email it costs a full round trip, which on a monthly cadence is absurd — so
email trades pre-confirmation for exact, one-click reversal. In both cases the
DM's own words are the authority and the model is only translating.

For `*.create` ops the target does not yet exist, so those are **always**
proposal-only with the full typed op shown, on every surface.

## 7. Schema

```sql
-- migrations/0005_dm.sql
ALTER TABLE campaigns ADD COLUMN dm_player_id     TEXT REFERENCES players(id);
ALTER TABLE campaigns ADD COLUMN review_window_ms INTEGER;  -- NULL = cadence default

ALTER TABLE beats ADD COLUMN published_at   TEXT;  -- NULL = held in DM review
ALTER TABLE beats ADD COLUMN revised_by     TEXT REFERENCES players(id);
ALTER TABLE beats ADD COLUMN original_prose TEXT;  -- what the model or template wrote
-- Set when a canon op lands after narration: the prose may now contradict state.
ALTER TABLE beats ADD COLUMN narration_stale INTEGER NOT NULL DEFAULT 0;

-- Without this every historical beat vanishes from the chronicle.
UPDATE beats SET published_at = created_at WHERE published_at IS NULL;

CREATE TABLE dm_edits (
  id           TEXT PRIMARY KEY,
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id),
  tick         INTEGER NOT NULL,
  seq          INTEGER NOT NULL,   -- order within the tick; replay depends on it
  dm_player_id TEXT NOT NULL REFERENCES players(id),
  op           TEXT NOT NULL,      -- the typed op, JSON
  note         TEXT NOT NULL DEFAULT '',  -- the DM's own words, if they used the front door
  prior_value  TEXT,               -- what the field held before; makes undo exact
  applied      INTEGER NOT NULL,   -- 0 when rejected by invariants
  rejected_why TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_dm_edits_campaign ON dm_edits(campaign_id, tick, seq);
```

Canonical ops live in DO storage keyed by tick, alongside `history`. `dm_edits`
is the D1 projection — queryable, publicly readable where the chronicle is
public, and repairable by the existing host-only `/reproject`.

`beats.source` keeps its existing meaning (`model` / `templated` / `blocked`) —
who *generated* the prose. `revised_by` records who *edited* it. Both facts
matter and neither should overwrite the other.

### Read paths that must change

| Path | Change |
|---|---|
| `src/web/chronicle.ts` | filter `published_at IS NOT NULL` |
| `index.ts` campaign GET (`latestBeat`) | same filter, **except** for the DM, who sees the held beat |
| fan-out | already gated by the phase machine; no filter needed |

## 8. Endpoints

All under the existing `/api/campaigns/:slug` prefix, following the current
router shape.

| Method | Path | Who | Does |
|---|---|---|---|
| `POST` | `/dm` | host or DM | assign the seat (`{ playerId }`) or vacate (`{ playerId: null }`) |
| `PATCH` | `/dm/window` | DM | set `review_window_ms`, clamped to the cadence cap |
| `GET` | `/dm/review` | DM | the held beat, the tick's events, and the current edit log |
| `PATCH` | `/dm/beat` | DM | rewrite prose; retains `original_prose`, sets `revised_by` |
| `POST` | `/dm/renarrate` | DM | regenerate prose from post-edit facts; budget-guarded, templated fallback |
| `POST` | `/dm/ops` | DM | apply typed ops; returns per-op applied/rejected with reasons |
| `POST` | `/dm/propose` | DM | free text → proposed typed ops (no state change) |
| `POST` | `/dm/undo` | DM | reverse an op by id, using `prior_value` |
| `POST` | `/dm/publish` | DM | publish now, collapsing the window |

Rate-limited on the same mechanism as actions. Every one is 403 for a member
who does not hold the seat and 404 for a non-member, matching existing
behaviour.

## 9. Failure posture

The base spec's guarantee extends: **the tick always resolves, and the beat
always publishes.**

| Failure | Behavior |
|---|---|
| DM never shows up | window times out, beat publishes unedited |
| Op violates invariants | op rejected with reasons; world untouched; window stays open |
| DM writes bad prose | it ships — they are the DM. `original_prose` is retained, so it is recoverable |
| Review alarm lost | the next resolution publishes any held beat first |
| DM misses 3 consecutive windows | seat reverts to host, host notified |
| DM leaves the campaign | seat reverts to host |
| Free-text parse fails | no ops proposed; the DM is told, and the typed editor still works |
| Held-beat notification bounces | window still times out on schedule; publication never depends on mail |
| Re-narration fails or is over budget | templated prose from post-edit facts, exactly as a tick degrades; staleness still clears |
| Window expires while the beat is stale | it publishes stale. The DM was warned and chose not to act; a beat nobody ever sees is worse |

## 10. The reworded promise

The base spec's §5 promise was absolute. With a human DM holding canon
authority it can no longer be, so it splits — which states the claim more
precisely rather than weakening it. README and base spec §5 both change to:

> The **simulation** never penalizes absence — never, for any length of absence,
> costs you attributes, skills, renown, items, conditions, your life, or access
> to anything. That is enforced by tests and proven by a 1500-tick soak.
>
> A **human DM** has full authority over canon, and every edit they make is
> recorded and attributed in the chronicle. Campaigns with no DM — and campaigns
> whose DM edits nothing — get the promise absolutely.

This must be unambiguous in the README. The critic's `async` category scores
"is the no-penalty promise real in code?", and a vaguely-worded split will read
as a regression rather than a design decision.

The existing absence tests are **rescoped, not deleted**: they assert the
property of `runTick` and the soak, both of which remain DM-free. Nothing that
proves the sim-side promise today stops proving it.

## 11. Testing

Existing sim tests and `sim:soak` are unchanged and still prove the sim-side
promise. New coverage:

**Ops**
- every op type applied to a genesis world leaves `checkWorldInvariants` empty
- an op that would violate invariants is rejected and state is byte-identical
- clamping reports the clamp rather than silently altering intent
- `undo` restores the exact prior value, including for `*.create`
- a DM-created entity id never collides with a sim-created one in the same tick

**Determinism**
- `replay(seed, actions, dmOps)` is identical across runs with ops interleaved
- ops recorded out of `seq` order replay in `seq` order, not arrival order

**Window**
- timeout publishes exactly once; early publish publishes exactly once
- a held beat is invisible to a second member and to a logged-out chronicle reader
- the DM sees the held beat
- a lost review alarm is healed by the next resolution
- the cadence deadline does not drift after a full-length window
- a window of 0 reproduces today's timing and fan-out exactly
- an applied op marks the held beat stale; re-narration clears it; hand-editing
  clears it; neither is triggered automatically
- re-narration with the budget exhausted falls back to templated prose and still
  clears staleness
- editing a published beat updates the chronicle and does not re-send mail

**Seat**
- only the DM can edit; the host can reclaim; an ex-DM is locked out immediately
- three expired windows revert the seat and notify the host
- a vacated seat restores present-day behaviour end to end

**Smoke (adversarial)**
- non-DM member POSTs an op → 403
- forged campaign id → 404
- publish replayed after publication → no duplicate mail

## 12. Phasing

Three slices, each independently shippable and independently valuable.

| Slice | Contents | Touches canon |
|---|---|---|
| **1** | Seat, designation, review window, hold/timeout/publish, prose editing, attribution | no |
| **2** | Typed ops, validation, audit, undo, chronicle attribution, reworded promise | yes |
| **3** | Free-text front door: Haiku proposal on web, apply-with-receipt over email | no new authority |

Slice 1 delivers most of the felt quality improvement — a DM who can hold and
rewrite a bad beat — while touching world state not at all. If slices 2 and 3
never ship, slice 1 is still a coherent feature.

## 13. Out of scope

- Multiple simultaneous DMs. One seat, structurally enforced. Co-DMing is a real
  want but needs conflict resolution on concurrent edits to the same beat.
- DM-authored branching or prepared content ("next tick, they arrive at the
  ruin"). This spec is about editing what happened, not scripting what will.
- Player-visible edit history beyond attribution. The `dm_edits` log exists and
  is queryable; a browsable diff UI is a later question.
- Region creation and entity deletion, for the reasons in §5.
