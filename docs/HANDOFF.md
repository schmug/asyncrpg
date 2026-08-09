# Handoff — asyncrpg critic-gated build

**Written 2026-08-02, closed 2026-08-07.** The loop ran to its 12-cycle cap.
Everything below is committed and deployed; nothing is in flight.

## Where things stand

Live at **https://play.cortech.online** (repo `schmug/asyncrpg`, branch
`feat/tick-engine`, PR [#1](https://github.com/schmug/asyncrpg/pull/1)).
Public demo chronicle: `/c/demo`.

The build follows the `shipofclaudius:critic-gated-build` skill. The ship gate,
agreed with the user, is **every rubric category ≥ 8 on two consecutive critic
cycles**, cap 12 cycles. Check-ins: first deploy (done) and completion.

### Score trajectory

| Cycle | product | async | narrative | ux | rigor | verdict |
|---|---|---|---|---|---|---|
| 1 | 6 | 7 | 7 | 6 | 6 | fail |
| 2 | 7 | 6 | 6 | 6 | 7 | fail |
| 3 | 7 | 7 | 6 | 7 | 6 | fail |
| 4 | 7 | 8 | 7 | 7 | 6 | fail |
| 5 | 8 | 8 | 7 | 7 | 7 | fail |
| 6 | 7 | 7 | 7 | 7 | 7 | fail |
| 7 | 7 | 7 | 8 | 7 | 8 | fail |
| 8 | 7 | 8 | 6 | 7 | 7 | fail |
| 9 | 7 | 7 | 7 | 7 | 7 | fail |
| 10 | 6 | 7 | 8 | 6 | 7 | fail |
| 11 | 8 | 9 | 8 | 7 | 7 | fail |
| 12 | 7 | 9 | 7 | 7 | 8 | fail |

**The loop reached its 12-cycle cap without meeting the gate** (every category
>= 8 on two consecutive cycles). Best single cycle was 11 at 8/9/8/7/7. No
category ever held >= 8 twice running.

Remaining work is filed as issues #2-#5. Nothing is in flight.

Reports are committed in `critic-reports/`. Every cycle-3 finding is landed,
deployed, and verified live.

```bash
npm run deploy                                                    # injects the revision
node scripts/seed-demo.mjs https://play.cortech.online --ticks 6   # fresh prose to judge
node scripts/critic.mjs 13   # only if the cap is lifted
```

**Seeding costs email.** Every tick mails every member, and Cloudflare's
sending quota is **account-wide and daily**. A 32-tick seed exhausted it on
2026-08-02 and broke all outbound mail — beats and sign-in links — until it
reset. `seed-demo` now prints its estimated cost. Do not seed a long chronicle
and then run the critic on the same day without checking `email-e2e` first.

**Commit and deploy before running the critic.** This is not advice, it is the
thing that cost cycle 3 a blocker: the gates and evidence commands in
`scripts/critic.mjs` run in the *working tree*, while the critic reads a clean
clone of HEAD. An unfinished test sitting uncommitted made `npm test` and
`npm run typecheck` record failures for code the reviewer could not see, and it
quite reasonably reported a red gate. The script now refuses to start on a
dirty tree (`--allow-dirty` to override).

The critic is `codex exec` (gpt-5.5) in a read-only sandbox against a clean
clone plus a live-capture bundle. It takes 20–40 minutes; run it in the
background and read `critic-reports/cycle-03.json`.

## Current gates (all green as of the last deploy)

| Command | Result |
|---|---|
| `npm test` | 287 passing |
| `npm run typecheck` | clean |
| `npm run sim:soak -- --ticks 1500` | invariants hold, replay identical, economy and state size bounded |
| `npm run sim:endurance` | 4 players, 60 ticks, quorum + deadline, absences of 1/3/30, the promise asserted every turn |
| `node scripts/smoke.mjs <url>` | 98/98, mostly adversarial; headers asserted on shell, API and chronicle |
| `node scripts/ui-smoke.mjs <url>` | 35/35, mobile viewport, SWs blocked |
| `node scripts/email-e2e.mjs <url>` | 22/22, including the real two-zone round trip |

Revision skew is now checkable rather than assumed: `/api/health` reports the
`GIT_REVISION` injected by `npm run deploy`, smoke asserts it is a real SHA,
and `gates.txt` prints `MATCH` or `SKEW` against the revision under review.
Cycle 1's false finding came from a skew nobody could see.

Note that `scripts/smoke.mjs` proves the sign-in rate limiter works by
exhausting it, and the limiter keys on IP. It now waits for the window to roll
over before exiting — without that, `ui-smoke` runs next, gets a 429 on
sign-in, and reports it as a console error.

## What cycles 4–7 addressed

Every finding from cycles 3, 4, 5, 6 and 7 is landed, deployed and verified
live. The most consequential, in order of how much they changed:

- **Downtime bought a mechanical edge (cycle 7 blocker).** `train` raised
  renown; `network` moved a character's bond *and* the NPC's reciprocal
  attitude. All three feed `difficultyFor`, so an optional activity was an
  advantage — which makes skipping it a cost. `restoreStanding` could never
  undo the NPC's half, so a missed month was permanent. Two tests actively
  blessed this; both rewritten, plus a general one that no downtime activity
  moves attributes, skills, renown, bonds, or attitudes. Downtime now yields
  story only. `research` still reveals threats (information the whole table
  gets) and `recover` still clears conditions (removing a minus).
- **Four separate prose-corruption classes** reached the public chronicle, one
  per cycle, each found by the critic rather than by the gates:
  `finished.732`, `evening.ot. of it.was`, `it does.MjM`, and
  `came for.// wait, remove that fragment.` They are now one named list,
  `ARTIFACT_PATTERNS` in `src/dm/narrate.ts`, mirrored in `scripts/smoke.mjs`
  so the *live* chronicle is checked too, with `test/dm/artifact-parity.test.ts`
  failing if the mirror drifts.
- **The chronicle rendered only the latest 25 turns**, so an active campaign
  lost public access to its own history within weeks. Now paged with
  `?before=<tick>`, plain anchors, no-JS intact.
- **Absence was socially unequal.** `restoreStanding()` lifts a returning
  player to the party *median* — never past it — on any return from absence.
- **Blocked ticks could loop forever**; a campaign now halts visibly after
  three consecutive invariant failures and the host can `resume()`.
- **Reply auth is the capability the spec called for**: an HMAC over
  (campaign, player, tick), verified before a binding is honored. It rides the
  subject line because Email Routing matches exact addresses and the apex
  catch-all belongs to another Worker.
- **Build provenance**: `/api/health` reports the deployed revision, and
  `gates.txt` prints MATCH or SKEW against the revision under review.
- **Long-absence recaps** reach past the DO's rolling event buffer into D1.
- **Cadence and quorum are changeable mid-campaign** (host-only `/pace`).
- **An endurance harness** (`npm run sim:endurance`) drives 4 players through
  60 ticks with absences of 1/3/30 turns.

### Older detail (cycle 3's fixes)

- **The first blocker was a process error, not a product defect.** An
  unfinished test was uncommitted while the critic captured evidence. See the
  warning above; `scripts/critic.mjs` now refuses to run on a dirty tree.
- **Build provenance.** `/api/health` reports the revision, injected at deploy
  time. Smoke asserts it; `gates.txt` reports MATCH or SKEW.
- **Markdown fences in canon.** Four live beats ended in a bare ``` — the model
  closing a fence it opened outside the JSON string. Prose is now normalized
  before validation. Stripped rather than rejected: the writing around the
  stray fence was sound, and falling back to templated prose over three
  backticks trades a good beat for a worse one.
- **Blocked ticks could loop forever.** Clearing pending fixes a violation
  caused by player input, but not one caused by deterministic drift. After
  three consecutive rejections the campaign halts explicitly and offers
  `resume()`. The policy is a pure function, `blockedTickPolicy`, because
  "does not loop forever" is otherwise only observable by waiting forever.
- **Absence was mechanically safe but socially unequal.** Renown and bonds
  accrue only by acting, so a returning player resumed behind.
  `restoreStanding()` lifts them to the party *median* on return — never past
  it. Absence is not rewarded; it just stops costing.
- **Reply auth now is the capability the spec called for.** An HMAC over
  (campaign, player, tick), verified before a binding is honored. It rides the
  subject line, not a plus-addressed `Reply-To`, because Email Routing matches
  exact addresses and the apex catch-all belongs to another Worker. Both the
  reasoning and the two accepted weakenings are in the spec and
  `src/email/token.ts`. `EMAIL_TOKEN_SECRET` is set in production.
- **Delivery failures are rows**, in `delivery_failures` (migration 0005),
  surfaced to the player they were owed to rather than only logged.
- **Header drift is gated.** Known zone overrides pass loudly; undocumented
  drift fails the suite. `docs/DEPLOYMENT.md` names what is the owner's.
- **The chronicle reads as a chronicle.** A "So far" orientation, and turns
  grouped into chapters named for what happened in them — with a kind-aware
  bar, because a routine action that rolls a critical success scores about the
  same as a settlement changing hands, and there is one of those most turns.
- **Narrative tics.** The tendency pool was too small to avoid collisions: a
  hedge-doctor and a marsh guide were both "unable to leave a locked door
  alone", and the narrator repeated it for both every turn. And one phrasing
  per outcome made six critical successes on one page read identically.
- **First-run orientation** in-app; README no longer describes a model-delta
  validation path that does not exist.

## Boundaries that are not the app's to fix

1. ~~**HSTS**~~ — **RESOLVED 2026-08-02.** The owner enabled it; production
   serves `max-age=2592000; includeSubDomains; preload`. The smoke gate now
   asserts the property (enabled, ≥30 days, covers subdomains) rather than
   tolerating drift, and a zero max-age is a hard failure.
1b. **Cloudflare's daily sending quota is account-wide.** A campaign's mail
   cost is `players × ticks`, and concurrent campaigns compete for one
   ceiling. Raising it is the owner's call. See `docs/DEPLOYMENT.md`.
2. **Cloudflare Analytics auto-injection**, which forced two Cloudflare hosts
   into an otherwise strict CSP. Owner's call.
3. **Third-party mailbox deliverability.** Gmail/Outlook spam placement cannot
   be self-tested. What is tested instead: the full two-zone round trip through
   real Email Routing, and SPF/DMARC/MX assertions in the smoke suite.
4. **"Months-quality" simulation.** Improved by chapters and the "So far"
   summary, but the critic has asked twice for multi-campaign captures. Seeding
   two or three demo worlds with different seeds into the bundle is the
   remaining move.

## Things worth knowing before you change anything

- **The user's explicit requirements**, from intake: email-first with a mobile
  web app; quorum-or-deadline ticks; simulation is canon and the model narrates;
  graduated absence with no penalty; downtime, in-character letters, and solo
  journals; private beta, no public signup or billing.
- **The no-penalty promise is stated precisely** in `docs/specs/...#5`, the
  README, and now the sign-in screen. Absence costs nothing; engagement earns
  story presence, not power. The critic read the social gap as a penalty twice,
  which was fair — `restoreStanding()` closes it rather than arguing about it.
  Do not close it by removing the depth features the user asked for.
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
src/email/     parse • inbound • outbound • loopback (inbound-path proof)
src/web/       chronicle (server-rendered, no-JS readable)
src/           index (router) • campaign-do (the campaign) • auth • env
public/        mobile PWA, no framework, no inline script
scripts/       critic • smoke • ui-smoke • email-e2e • sim-soak • seed-demo
docs/specs/    the approved design, with implementation notes where reality differed
```
