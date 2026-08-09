# Handoff — asyncrpg critic-gated build

**Written 2026-08-02. Amended 2026-08-08** for the human DM slice.

The pre-DM work is committed and deployed. The DM slice is committed to
`claude/scenario-creator-dm-906a14` and **has not been deployed** — read
"landed" throughout as "landed on that branch".

Everything below was verified against **`4a91314`**. That branch was being
written by several agents in parallel while this was amended, so check
`git log` before trusting a line count or a file pointer.

## Where things stand

Live at **https://play.cortech.online** (repo `schmug/asyncrpg`).
PR [#1](https://github.com/schmug/asyncrpg/pull/1) — the tick engine — is merged
to `main`. The human DM work lives on `claude/scenario-creator-dm-906a14`, 27
commits ahead of `main` at `4a91314` and **not deployed**: everything below
marked "landed" means landed on that branch, verified by reading the code and
running the local gates, not observed in production.
Public demo chronicle: `/c/demo`.

The build follows the `shipofclaudius:critic-gated-build` skill. The ship gate,
agreed with the user, is **every rubric category ≥ 8 on two consecutive critic
cycles**, cap 12 cycles. Check-ins: first deploy (done) and completion.

### Score trajectory

| Cycle | product | async | narrative | ux | rigor | verdict |
|---|---|---|---|---|---|---|
| 1 | 6 | 7 | 7 | 6 | 6 | fail |
| 2 | 7 | 6 | 6 | 6 | 7 | fail |
| 3 | — | — | — | — | — | **not yet run** |

Reports are committed in `critic-reports/`. Cycle 3's fixes are all landed and
deployed; **the next action is to run cycle 3.**

```bash
node scripts/seed-demo.mjs https://play.cortech.online --ticks 6   # fresh prose to judge
node scripts/critic.mjs 03
```

The critic is `codex exec` (gpt-5.5) in a read-only sandbox against a clean
clone plus a live-capture bundle. It takes 20–40 minutes; run it in the
background and read `critic-reports/cycle-03.json`.

## Current gates (run against `4a91314`, 2026-08-08)

| Command | Result |
|---|---|
| `npm test` | **362 passing**, 0 failing, 15 files |
| `npm run typecheck` | clean |
| `npm run sim:soak -- --ticks 1500` | invariants hold on all 1500, replay identical, absent player unpenalised, economy and state size bounded |
| `npm run smoke:local` / `node scripts/smoke.mjs <url>` | **77 assertion sites** — not run for this revision |
| `node scripts/ui-smoke.mjs <url>` | **59 assertion sites** — not run for this revision |
| `node scripts/email-e2e.mjs <url>` | **23 assertion sites** — not run for this revision |

The first three rows were run against `4a91314`. The last three were
not, because each needs a served target and the email suite needs real
Cloudflare Email Routing besides. Their figures are assertion call sites counted
statically —

```bash
grep -cE '^[[:space:]]*(await )?check\(' scripts/smoke.mjs scripts/ui-smoke.mjs scripts/email-e2e.mjs
```

— and a run prints a slightly higher number, because a few of those sites are
inside loops. The previously recorded 67/34/22 (and the README's 61/28/22) both
predate this work and neither could be reconciled without a deployment, so they
were replaced with a number that is reproducible from the repo rather than
carried forward. **These are coverage counts, not passing scores.** Run the
suites and record real `N/N` figures before the next critic cycle.

`smoke.mjs` derives its D1 target from the base URL's host — loopback means the
local database, anything else means the deployed one — and refuses to run with
no target named at all. `npm run smoke --local` does not work; npm consumes the
flag. Use `npm run smoke:local` (against `http://localhost:8788`) or
`npm run smoke:prod`.

**Always deploy before running the critic.** Cycle 1 produced a false finding
because the cloned repo and the live deployment were different revisions. The
capture bundle now records `git status --porcelain` and `wrangler deployments
list` so a skew is visible, but the fix is to not create one.

## What cycle 3 addressed (landed, unjudged)

- **Cost controls** — input *and* output tokens metered (input was unmetered
  and is the larger share); global kill switch in `settings.inference_enabled`
  so spend can be stopped without a deploy; rate limits on sign-in and actions.
- **Projection durability** — D1 failures are recorded in `projection_failures`
  instead of swallowed, surfaced to the host as `chronicleNeedsRepair`, and
  cleared by the existing host-only `/reproject`.
- **Blocked ticks** — a tick that fails invariants now writes a beat saying so,
  rather than advancing nothing silently.
- **App surface** — the latest beat and a real character sheet (attributes,
  skills, tendencies, conditions, named bonds) now render in-app. Previously
  you had to leave for the chronicle to find out what happened.
- **Economy rebalance (the big one).** The demo world had every settlement at
  prosperity 100 with 200k–500k population (they start at 200–9,000), and every
  living faction at power *and* treasury 100. Population growth was unbounded
  compounding and prosperity had no equilibrium. Now: logistic growth against a
  carrying capacity, prosperity mean-reverting toward a sustainable target with
  a floor that does not depend on the ruling faction (the three variables are
  circularly coupled and spiral *down* as readily as up), and faction upkeep
  scaling with power and holdings. Guarded by new soak assertions.
- **Absence heals.** The 1500-tick soak caught a real promise violation:
  conditions are cleared by *acting*, so a player who stopped while wounded
  stayed wounded forever. Offscreen characters now shed conditions over time.
  The soak measures the promise from the tick a player goes quiet rather than
  against an absolute floor.
- **Dossier** — dead NPCs no longer flood the "People" grid (26 of 28 cards
  were dead); the notable dead get a capped "Remembered" section.

## The human DM role — slice 1 (landed)

Spec: [`docs/specs/2026-08-08-dm-role-design.md`](specs/2026-08-08-dm-role-design.md).
Plan: `docs/plans/2026-08-08-dm-role-slice-1.md`. The spec phases the feature
into three slices; **only slice 1 is built.**

What slice 1 landed:

- **The DM seat** — `campaigns.dm_player_id`, a single column, so "exactly one
  DM" is structural rather than a rule someone has to enforce. It defaults to
  the campaign creator at create time (`src/index.ts:262`), moves by host or by
  the sitting DM to any member, is reclaimable by the host unconditionally, and
  can be vacated. `src/dm/seat.ts`; the `/dm` handler is `src/index.ts:314`.
- **The review window** — the DO alarm became a two-phase machine
  (`phase=open` → resolve; `phase=review` → publish). A resolved beat is written
  with `published_at` NULL, held, and fanned out when the window closes.
  `#openReviewWindow` (`src/campaign-do.ts:873`), `publishHeldBeat`
  (`:667`), `#scheduleNextTick` (`:847`). Defaults and caps — 2h/8h daily,
  24h/56h weekly, 72h/10d monthly — live only in `src/dm/seat.ts:17-31`.
- **The endpoints.** All five are merged and tested, under
  `/api/campaigns/:slug`:

  | Method | Path | `src/index.ts` |
  |---|---|---|
  | `POST` | `/dm` — assign or vacate the seat | `:314` |
  | `GET` | `/dm/review` — the latest beat, held-ness, window close time | `:382` |
  | `PATCH` | `/dm/beat` — rewrite prose | `:422` |
  | `POST` | `/dm/publish` — publish now | `:457` |
  | `PATCH` | `/dm/window` — set the window, clamped and reported | `:462` |

  Everything under `/dm/` answers a **uniform 403** (`src/index.ts:362-366`), by
  design: a non-member and a seatless member get identical refusals, so neither
  becomes an oracle for campaign membership. That check sits *ahead* of the
  general membership check, and `/dm/*` is rate-limited at 30/min per player
  (`:378`) against `/action`'s 12. The router allows a second path segment under
  `/dm` and nowhere else (`:288`).
- **Prose editing and attribution** — `beats.original_prose` and
  `beats.revised_by` keep "who generated it" and "who edited it" as separate
  facts; `beats.source` keeps its old meaning. `original_prose` is set once via
  `COALESCE`, so it stays what the machine wrote. Editing a published beat is
  supported and never re-sends mail — only `publishHeldBeat` sends.
- **Seat reversion after three untouched windows** — built, not stubbed.
  `#countMissedWindow` (`src/campaign-do.ts:793`) and `#resetMissedWindows`
  (`:828`); the threshold is `MISSED_WINDOWS_BEFORE_REVERT = 3` in
  `src/dm/seat.ts:34`. "Untouched" means `revised_by IS NULL` on a window that
  *expired* (`src/campaign-do.ts:757`), so a rewrite breaks the streak and so
  does publishing early — `/dm/publish` calls `publishHeldBeat()` without
  `expired`, which resets. The bump is a single `UPDATE … RETURNING` guarded by
  `dm_player_id IS NOT NULL`: read-then-write lost counts when two windows were
  in flight, and a seat vacated mid-window must not be charged. Reversion goes
  through `setSeat`, which zeroes the count and returns the window to the
  cadence default. **The host is not emailed on reversion** — spec §9 says
  "notified"; the code only logs (`:818`). That gap is real.
- **The held-beat notice** — when a window opens the DM is mailed the beat, a
  link, and the publish time (`#notifyDm`, `src/campaign-do.ts:893`;
  `reviewNoticeSubject` at `src/email/outbound.ts:196`, `reviewNoticeBody` at
  `:222`, `sendReviewNotice` at `:272`).
  Detached and swallowed on purpose: the window closes on its alarm regardless,
  so a bounce costs a notification, never a turn.

  The link points at `#/c/<slug>` (`reviewUrl`, `src/email/outbound.ts:218`),
  which is exactly what the app's hash router matches —
  `^#/c/([a-z0-9-]{2,31})$`, no trailing segment (`public/app.js:641`).
  **Do not turn this into a `/review` sub-route.** It shipped that way once: an
  unmatched hash falls through to `renderHome`, so the DM landed on their
  campaign list instead of the beat they had just been emailed about. There is
  no separate review screen to route to in any case — the desk renders inline on
  the campaign page for whoever holds the seat (`#dm-box`,
  `public/index.html:122-140`; `renderDm`, `public/app.js:279`), so the campaign
  link already arrives at it. `test/integration/dm-notice.test.ts` asserts the
  composed URL matches the router's pattern, so the two cannot drift apart again
  silently — though it holds its own copy of the regex (the router lives in
  browser code with no module boundary), so changing `public/app.js:641` still
  needs a matching edit there.
- **Held beats are invisible to everyone but the DM** — the chronicle filters
  `published_at IS NOT NULL` unless the viewer holds the seat
  (`src/web/chronicle.ts:112`), and the campaign GET applies the same filter
  (`src/index.ts:512-515`). `/dm/review` is the one read path in the router that
  may return an unpublished beat, and the seat check above it is what makes that
  safe.
- **Migration** `migrations/0005_dm.sql`, including the backfill that sets
  `published_at = created_at` on every existing beat. Without it every
  historical beat vanishes from the chronicle.
- **The in-app panel** — `#dm-box` in `public/index.html:122-140`, rendered by
  `renderDm` (`public/app.js:279`). Two audiences on purpose: the seated DM gets
  the review desk (held prose in a 20 KB-capped textarea, the publish-on-its-own
  line, **Save changes** → `PATCH /dm/beat`, **Send it to the group** →
  `POST /dm/publish`); a host who is not the DM gets the seat control alone,
  which is exactly who `POST /dm` accepts. The seat select lists the cast plus
  "Nobody — publish turns immediately", explicitly selected when the seat is
  empty so an untouched "Hand it over" cannot hand the story to whoever sorts
  first. Prose reaches the DOM through `.value` / `.textContent`, never
  `innerHTML`. `emptyDmPanel` (`:254`) clears the box on *both* paths that leave
  nothing to review, including navigating to a campaign you merely play in —
  hiding the panel does not empty it. **`PATCH /dm/window` has no UI**; the
  window line is display-only.
- **Tests** — 180 of the 362 are the DM slice: `test/integration/dm-seat.test.ts`
  (49), `dm-window.test.ts` (47, including seat reversion),
  `dm-edit.test.ts` (43), `dm-visibility.test.ts` (20), `dm-notice.test.ts` (11),
  `dm-migration.test.ts` (10). `scripts/smoke.mjs` gained adversarial DM
  coverage (+389 lines vs `main`) and can now run against a local dev worker;
  `scripts/ui-smoke.mjs` gained +236, including a second account navigating into
  a campaign it only plays in and asserting the panel is empty on arrival *and*
  on the return trip.

Things that are easy to get wrong here and are already decided:

- **The cadence clock does not move.** The window is carved out of the front of
  the next cycle, never added to it. Canon advances on schedule; only delivery
  waits. There is a test for the no-drift property — do not "fix" it by adding
  the window to the deadline.
- **A vacant seat means today's behaviour, exactly.** `#reviewWindowMs` returns
  0 when `dm_player_id` is NULL, and a window of 0 skips the review phase
  entirely. A D1 read failure there also returns 0 — a blip in the read model
  must degrade to publishing, never to a beat sitting unseen.
- **Publication is idempotent and self-healing.** It is keyed on
  `published_at IS NULL`, `phase` is cleared before any mail is sent, and the
  next tick's resolution publishes a still-held beat *before* advancing canon.
  Between those there is no state in which a resolved beat is never seen.
- **Quorum during a review window does not resolve the next turn.**

**Slices 2 and 3 are specified in full and unbuilt.** Nothing from either is on
this branch — no `DmOp` type, no `dm_edits` table, no `/dm/ops`, `/dm/propose`,
`/dm/undo`, or `/dm/renarrate` handler. Spec §8 lists those four endpoints
alongside the five that exist; do not read that table as an inventory of what
ships.

- **Slice 2 — typed canon ops.** `DmOp[]` validated against
  `checkWorldInvariants`, clamping, the `dm_edits` audit table with
  `prior_value` for exact undo, chronicle attribution. This is the slice that
  actually gives a DM authority over world state. Until it ships, the
  simulation is still the only writer of canon.
- **Slice 3 — the free-text front door.** Haiku proposes typed ops on the web
  for confirmation; email applies with a receipt and a one-click undo. No new
  authority — it is an ergonomic layer over slice 2's ops.

**The README and spec §5 describe exactly this split**, and the wording matters:
the critic's `async` category scores "is the no-penalty promise real in code?"
and reads any vagueness as a regression. The README states plainly that no DM
can change world state yet — the seat reaches prose, timing, and the seat
itself — so every campaign currently gets the promise absolutely. If slice 2
lands, that sentence has to change with it.

The overclaim to guard against is the opposite one: **do not let the docs imply
a DM can touch canon.** Two things verified on this branch hold that line. The
narrator has no state channel: its JSON schema is exactly `{ prose, situation }`
(`src/dm/narrate.ts:57-68`), `situation` is truncated to 200 characters, and
unusable output falls through to `src/dm/fallback.ts`. And `/dm/beat`'s only
write is an `UPDATE beats` (`src/index.ts:444-452`) — the chronicle projection,
not the world.

## Outstanding findings from cycle 2

Read `critic-reports/cycle-02.json` for full detail. Not yet addressed:

1. ~~**Inbound email E2E (blocker)**~~ — **CLOSED.** The owner has four
   onboarded zones, which made a real loop possible: the game mails a beat to
   `rpgloop@q-r.contact`, Cloudflare delivers it back to the Worker, the
   loopback replies to `rpg@cortech.online`, Cloudflare delivers that to the
   Worker, and the reply becomes a turn. See `src/email/loopback.ts` and the
   "inbound hop" section of `scripts/email-e2e.mjs`. It immediately found a
   real bug: Cloudflare rewrites the SMTP envelope sender to
   `bounces@cf-bounce.<domain>`, so authenticating on the envelope alone was
   rejecting every legitimate reply.
2. **Reply auth vs. the spec's HMAC token.** The spec called for an HMAC
   Reply-To token; the implementation uses `reply_bindings` keyed by
   Message-ID + subject code, because Cloudflare rejects a caller-set
   `Message-ID` and RFC 5321 caps the local part at 64 octets. The reasoning is
   in `migrations/0001_init.sql` and `src/email/parse.ts`. Either argue the
   replacement meets the same bar with evidence, or update the spec — but the
   critic will keep raising it while the two disagree.
3. **HSTS mismatch — user's zone.** The app sends `max-age=31536000`;
   production serves `max-age=0` because the `cortech.online` zone overrides
   it. Same story with Cloudflare Analytics auto-injection, which forced one
   extra CSP host. Both are the domain owner's call.
4. **"Months-quality" simulation.** Partly addressed by the economy rebalance,
   but the critic wants multi-campaign captures that read like memorable
   campaigns. Consider seeding two or three demo worlds with different seeds
   and including all of them in the bundle.

## Things worth knowing before you change anything

- **The user's explicit requirements**, from intake: email-first with a mobile
  web app; quorum-or-deadline ticks; simulation is canon and the model narrates;
  graduated absence with no penalty; downtime, in-character letters, and solo
  journals; private beta, no public signup or billing.
- **The no-penalty promise is stated precisely** in `docs/specs/...#5` and the
  README. Absence costs nothing; engagement earns story presence, not power.
  The critic reads any differential as a penalty — the honest answer is the
  precise wording, not removing the depth features the user asked for. Since
  2026-08-08 the promise is **split**: the *simulation* never penalizes absence
  (tests plus the 1500-tick soak), and a *human DM* has recorded, attributed
  authority over canon. Copy the wording from
  `docs/specs/2026-08-08-dm-role-design.md` §10 verbatim wherever it appears —
  it is load-bearing and a paraphrase reads as a regression.
- **Determinism is load-bearing.** No `Math.random()` anywhere in `src/sim`.
  Entity ids are positional on `(tick, sequence)`; a previous size-derived
  scheme silently overwrote live entities once pruning could delete things.
- **Cloudflare gotchas already paid for:** subdomains cannot be onboarded to
  Email Sending/Routing via API (Dashboard only), a caller-set `Message-ID` is
  rejected, **the SMTP envelope sender is rewritten to
  `bounces@cf-bounce.<domain>` on outbound mail** (so never authenticate on it
  alone), `INSERT OR REPLACE` on a row other tables reference is a foreign-key
  failure, `output_config.effort` is rejected by Haiku 4.5, Sonnet 5 rejects
  non-default `temperature`/`top_p`/`top_k`, and structured-output JSON Schema
  forbids `minimum`/`maximum`. Deploys take ~20–30s to propagate — testing
  immediately after `wrangler deploy` produced three separate false failures.
- **Secrets** are set: `ANTHROPIC_API_KEY` is live (the user set it). Narration
  degrades to templated prose without it, and that path is tested.

## Repo map

```
src/sim/       deterministic world model — pure, no I/O
  prng • types • invariants • names • genesis • drift • actions
  character • tick • downtime • prune • events
src/dm/        narrate (Sonnet 5) • intent (Haiku 4.5) • fallback (no inference)
               seat (the human DM seat + review-window defaults and caps)
src/email/     parse • inbound • outbound • loopback (inbound-path proof)
src/web/       chronicle (server-rendered, no-JS readable)
src/           index (router) • campaign-do (the campaign) • auth • env
public/        mobile PWA, no framework, no inline script
scripts/       critic • smoke • ui-smoke • email-e2e • sim-soak • seed-demo
docs/specs/    the approved design, with implementation notes where reality differed
```
