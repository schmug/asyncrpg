# Handoff — asyncrpg critic-gated build

**Written 2026-08-02.** The previous agent ran out of context mid-loop. Everything
below is committed and deployed; nothing is in flight.

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

## Current gates (all green as of the last deploy)

| Command | Result |
|---|---|
| `npm test` | 182 passing |
| `npm run typecheck` | clean |
| `npm run sim:soak -- --ticks 1500` | invariants hold, replay identical, economy and state size bounded |
| `node scripts/smoke.mjs <url>` | 67/67, mostly adversarial |
| `node scripts/ui-smoke.mjs <url>` | 34/34, mobile viewport, SWs blocked |
| `node scripts/email-e2e.mjs <url>` | 22/22, including the real two-zone round trip |

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
  precise wording, not removing the depth features the user asked for.
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
- **D1 migrations are not automated.** `wrangler deploy` does not apply them,
  and CI does not either — this is a deliberate, documented-not-automated
  decision, not an oversight. `#writeEvents` and `#writeEntities` swallow D1
  failures into `#recordProjectionFailure` on purpose (a D1 blip must not
  wedge a tick), which means a code deploy that lands before its matching
  migration does not error — it silently stops projecting on every tick while
  dashboards stay green. Run `wrangler d1 migrations apply` by hand, before
  deploying code that depends on the new column. `migrations/0005_event_targets.sql`
  carries this warning inline as the concrete example.

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
