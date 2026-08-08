# Email keyword links — Design Spec

**Date:** 2026-08-08
**Status:** Approved, not yet built
**Branch:** `claude/email-keyword-links-c78541`

## 1. Problem

A player reads a beat and hits a name they no longer place. *The Ashen Coil —
weren't they the ones we crossed at Vresford? Or is that the other cult?*

Today they have three bad options: scroll back through weeks of email, open the
chronicle and hunt a grid of stat cards, or shrug and reply anyway. The third is
what actually happens, and it quietly erodes the thing the product is selling —
that a campaign stays coherent across months.

The user story:

> Someone forgets what an in-universe group is, or why it matters, and wants to
> know — without leaving the email they are already reading.

## 2. Solution

Names in a beat email become links to a per-entity dossier page, and the email
carries a plain "who's who" recap of those same names so the affordance survives
in the plain-text part.

Three properties constrain the whole design:

> **The dossier reveals nothing the group has not already read.** It re-indexes
> the chronicle; it does not disclose from canon.

> **When detection finds nothing, the email is byte-identical to today's.**

> **Escaping is never weakened.** Segments are escaped individually, so a match
> can never straddle an escape sequence.

## 3. Why this is cheap here

- **Names are globally unique per world.** `NameForge` draws without
  replacement (`src/sim/names.ts:92`) — the comment there already notes that
  collisions would break "entity lookup by name in the chronicle". Name →
  entity is therefore unambiguous, with no disambiguation logic.
- **Names are distinctive.** Generated morphology (`House Vresk`, `The Iron
  Spears`, `Thornreach`) collides with English rarely enough that
  word-boundary matching is safe.
- **The fan-out already holds canon.** `#fanOut` (`src/campaign-do.ts:548`)
  receives the full `WorldState` and the shared `beat.prose`, so detection runs
  once per tick with no database read and no inference.
- **Dossier data is already projected.** `entities` is refreshed per tick
  (`migrations/0001_init.sql:71`), described in-schema as existing so the
  chronicle can render "who is this?".

## 4. Scope

**In scope:** the five world-entity kinds — `faction`, `npc`, `settlement`,
`region`, `threat`.

**Out of scope**, each a clean follow-up issue:

- Player characters (`chr_`). Their names are the ones a player least forgets,
  they are the only player-authored names in the set, and linking your own
  party reads oddly.
- A game-vocabulary glossary (renown, drifting, offscreen, quorum). A different
  mechanism — static content, not per-campaign lookup.
- Linkifying prose on the chronicle page itself.
- Making the chronicle's existing dossier cards link to their pages.

## 5. Architecture

```
tick resolves
 └─ #fanOut(state, beat, …)
      ├─ findMentions(beat.prose, state)      ← once per tick, pure, no I/O
      └─ per member: sendBeat({ …, mentions })
           ├─ linkify(prose, mentions)  → HTML part
           └─ whosWho(mentions)         → HTML part + text part

GET /c/<slug>/who/<entity_id>  → renderDossier(env, campaign, entityId)
```

| File | Change |
|---|---|
| `src/lore/mentions.ts` | **new**, pure — `findMentions`, `blurbFor`, `tokenize` |
| `src/web/dossier.ts` | **new** — renders one entity page |
| `src/email/outbound.ts` | `BeatMail.mentions`; linkify + who's-who |
| `src/campaign-do.ts` | one call in `#fanOut`; bind `target_ids` in `#writeEvents` |
| `src/index.ts` | one route |
| `migrations/0005_event_targets.sql` | **new** — `events.target_ids` |

`src/lore/` rather than `src/sim/` because this is the read-side for humans and
never touches canon; not `src/web/` because email consumes it too.

## 6. Detection rules

Applied in order, against `WorldState` directly:

1. **Eligible kinds:** `faction`, `npc`, `settlement`, `region`, `threat`.
   Unrevealed threats are excluded, mirroring the rule already enforced at
   `src/campaign-do.ts:660`.
2. **Dead NPCs remain eligible.** "Who was that again?" is most often about
   someone who died six ticks ago. This diverges deliberately from the
   chronicle grid, which filters the dead (`src/web/chronicle.ts:189`).
3. **Player characters are never matched.**
4. **Longest name first**, so `House Vresk` wins over a bare `Vresk`. Matched
   spans never overlap.
5. **Word-boundary anchored and case-insensitive.** Entities whose name is
   shorter than 4 characters are not eligible for matching at all.
   `Vresking` does not match `Vresk`.
6. **First occurrence only** per entity, **capped at 8 distinct entities** per
   email. Beyond that the prose becomes hyperlink salad, and link density is
   the fastest route to a spam folder.

`findMentions` is **total**: it never throws and returns `[]` for any
unexpected input.

### Blurbs

One deterministic line per kind, from identity facts only — no agenda, no
progress, no relation values:

| Kind | Blurb |
|---|---|
| faction | `cult · seated at Vresford` (`· broken and scattered` when defunct) |
| npc | `steward of House Vresk, at Vresford` (`· died` when not alive) |
| settlement | `a town in Thornreach` (`· abandoned` when razed) |
| region | `forest · dangerous` |
| threat | `a blight in Thornreach` (`· ended` when resolved) |

Numbers are banded into prose, following `renownLabel`
(`src/sim/character.ts:105`), which is the established pattern for surfacing a
0–100 field to a reader. Both helpers live in `src/lore/mentions.ts`:

```
sizeLabel(population)    ≥ 5000 a city · ≥ 1500 a town
                         ≥ 400  a village · else a hamlet

dangerLabel(danger)      ≥ 70 perilous · ≥ 45 dangerous
                         ≥ 20 uneasy · else quiet
```

Raw `prosperity`, `unrest`, `defense`, `power`, `treasury`, and `severity`
values never appear in a blurb or on the dossier page.

## 7. Closing the projection gap

`WorldEvent.targetIds` is populated at 20+ sites across the sim
(`src/sim/drift.ts:135`, `src/sim/actions.ts:352`, …), but `#writeEvents`
(`src/campaign-do.ts:633`) binds only `actor_id`, `region_id`, `summary`,
`significance`, and `data`. **`targetIds` never reaches D1.**

This blocks the feature directly. Most events *about* a faction, settlement, or
threat name it in `targetIds`, not `actorId` — a prosperity shift is
`{ targetIds: [s.id] }` with no actor at all (`src/sim/drift.ts:645`). D1 can
currently answer "what did House Vresk do" but not "what happened to House
Vresk", and the second is most of what a dossier is for.

**Fix:** `migrations/0005_event_targets.sql` adds
`target_ids TEXT NOT NULL DEFAULT '[]'` (no index — a `json_each` residual
predicate cannot use one on a JSON blob column, and `idx_events_tick` already
serves the campaign+tick narrowing); `#writeEvents` binds
`JSON.stringify(e.targetIds)`.

**Backfill — corrected 2026-08-08 after adversarial review.** This section
originally claimed backfill needed "no new machinery", because `reproject()`
(`src/campaign-do.ts:802`) replays the DO's retained `history` through
`#writeEvents`. **That was false, and it was asserted without anyone running
it.** `#writeEvents` ended in `ON CONFLICT(campaign_id, event_id) DO NOTHING`,
and every row needing backfill is by definition already in D1 — that is *why*
its `target_ids` is `'[]'`. The conflict fired and the row was left untouched;
verified against local D1, the dossier query returned zero rows after a replay
carrying real ids.

The backfill therefore **does** require a change: the conflict clause becomes
`DO UPDATE SET target_ids = excluded.target_ids`. Only `target_ids` is
updated — events are otherwise immutable, and widening the upsert is out of
scope. `#writeEntities` (`src/campaign-do.ts:668`) already uses `DO UPDATE SET`
for precisely this reason; `#writeEvents` was written `DO NOTHING` when events
were append-only, and adding a backfillable column broke that premise.

With that change, `POST /api/campaigns/:slug/reproject` does repair existing
campaigns. Events older than the DO's retained history keep an empty
`target_ids`; their summaries still name the entity, so the dossier is thinner,
not wrong.

**Deploy ordering (documented, not automated).** `wrangler deploy` does not
apply D1 migrations and CI does not either. Because `#writeEvents` swallows
failures into `#recordProjectionFailure`, a deploy that lands before this
migration silently stops projecting *every* event of *every* tick while
dashboards stay green. The migration file and `docs/HANDOFF.md` carry the
warning; enforcing it is tracked as a follow-up issue rather than automated,
so that no deploy path gains the power to alter production schema.

## 8. The dossier page

### Route and access

```
GET /c/<slug>/who/<entity_id>
```

`entity_id` matches `(?:rgn|stl|fac|npc|thr)_[a-z0-9_-]{1,40}`. `chr_` is
excluded — characters are not linked, so the page would be unreachable, and a
character's disclosure story (bonds, conditions) is a separate question.

Access reuses the check at `src/index.ts:186` verbatim: public chronicle, or a
signed-in member. Unknown **or unrevealed** entity returns **404, not 403**, so
the URL cannot be used to probe whether a threat exists.

### Content

Three blocks, reusing the chronicle's CSS:

1. **Identity** — name, kind label, blurb facts (seat, role, region, alive/dead).
2. **What the chronicle records** — events where `actor_id = ?` OR `target_ids`
   contains the id, plus `region_id = ?` when the entity *is* a region. Newest
   first, capped at 40, rendered as the existing `ol.tl` timeline. Tick 0 goes
   in a separate "Before you arrived" block, matching `src/web/chronicle.ts:93`.
3. **Back to the chronicle.**

No agenda kind or target, no progress percentage, no relation or attitude
values, no raw danger or severity numbers.

## 9. Email rendering

### HTML part

`paragraphs()` (`src/email/outbound.ts:24`) becomes tokenize → escape each
segment → join. Tokenizing on **raw** text before escaping means a match can
never straddle an escape sequence and nothing is double-escaped.

Link style is deliberately quiet:

```
color:inherit;text-decoration:underline;
text-decoration-color:#c9b9a5;text-underline-offset:2px
```

A faint underline reads as *reference*, not *call to action*. The existing
accent-coloured "Read the chronicle" link remains the one loud link.

Deliverability: anchor text is always the entity name and every href points at
`PUBLIC_ORIGIN` — no display/href mismatch, no redirectors. The cap of 8 holds
total link count to roughly ten.

### Who's-who block

Rendered below the prompt and the "just reply" line so it never competes with
the call to action. Same list and order in both parts.

```
Who's who in this turn:
  · The Ashen Coil — cult, seated at Vresford
    https://play.cortech.online/c/demo/who/fac_2
  · Sera Coldwater — steward of House Vresk, at Vresford
    https://play.cortech.online/c/demo/who/npc_7
```

## 10. Failure behaviour

| Failure | Behaviour |
|---|---|
| `scanProse` finds nothing | Email byte-identical to today's |
| `scanProse` hits malformed state | Returns `{ mentions: [], segments: [{ type: "text", value: prose }] }`. The fallback is a **single text segment, not an empty list** — an empty list would break the segment round-trip the email body is rebuilt from. Same visible outcome as above |
| An entity row is malformed | `blurbFor` returns `""`. Consumers must treat an empty blurb as *omit the subtitle*, not *render an empty element* |
| Entity absent from `entities` (projection lag) | Soft 404: "This entry hasn't been recorded yet", with a link back. A link in a *sent* email is permanent; a bare 404 is a broken promise |
| Events query fails | Identity block renders; no 500 |
| Chronicle is private | 403, same as the chronicle itself |

## 11. Testing

Tests are written before the implementation, per the repo's loop.

**`test/lore/mentions.test.ts`**

- longest match wins — `House Vresk`, not `Vresk`
- first occurrence only; a second mention stays unlinked
- cap of 8 enforced
- word boundary — `Vresking` does not match `Vresk`
- unrevealed threat never matched
- dead NPC still matched
- player characters never matched
- an entity named `<script>alert(1)</script>` comes back **raw and unescaped** —
  see the re-scoping note below
- empty prose, or a world with no entities, returns `[]`
- `sizeLabel` and `dangerLabel` band at their stated boundaries, and no blurb
  contains a digit drawn from a 0–100 field
- **totality** (added after review): a missing state bucket, a row with no
  `name`, a row with no `kind`, a non-object row, a row with no id, and a
  `null`/non-object state each return without throwing, and the segment
  round-trip still holds

> **Re-scoped 2026-08-08.** This list originally read "an entity named
> `<script>alert(1)</script>` yields no raw tag in output", asserted against
> this module. That is the opposite of the correct contract. `scanProse`
> returns segments *raw* precisely so the caller can escape each one
> individually — escaping here would double-escape downstream. The no-raw-tag
> assertion belongs to `test/email/outbound.test.ts`, where it now lives; this
> module instead asserts the raw contract explicitly so the boundary is
> documented rather than assumed.

**`test/email/outbound.test.ts`** (new)

- HTML part contains a correct `<a href>` with an escaped label
- text part carries the who's-who block with resolvable URLs
- **zero mentions ⇒ output identical to the pre-change baseline**
- prose containing `&` and `<` stays correctly escaped around a link
- **an entity named `<script>alert(1)</script>` yields no raw tag in either
  MIME part** — moved here from the `mentions` list above

**`test/web/dossier.test.ts`**

- public chronicle → 200 with identity and events
- private chronicle, no session → 403
- unknown entity → 404
- unrevealed threat id → 404
- an event linked **only** via `target_ids` appears — proves §7 closed
- disclosure assertion: output contains no agenda kind or progress, and no
  `treasury`, `power`, `severity`, `danger`, or relation/attitude value

**Gates:** `npm test` (167 now, roughly +20), `npm run typecheck`,
`npm run sim:soak` (unchanged — `src/sim` is not touched), `scripts/smoke.mjs`.

## 12. Open decisions

None. Scope, destination, plain-text handling, and disclosure level were all
settled during design.
