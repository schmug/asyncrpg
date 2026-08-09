# DM Slice 1 — Build DAG

Execution DAG for [`2026-08-08-dm-role-slice-1.md`](./2026-08-08-dm-role-slice-1.md).
The implementation plan defines *what* each task does; this defines *what can
run at the same time as what*, and why.

**Baseline at branch point:** `npm test` 182 passing, `npm run typecheck` clean,
commit `9d410aa`.

## File ownership — the constraint that shapes everything

The ten plan tasks touch four files repeatedly:

| File | Plan tasks that modify it |
|---|---|
| `src/index.ts` | 2, 4, 5, 6, 9 |
| `src/campaign-do.ts` | 3, 7, 8 |
| `src/web/chronicle.ts` | 4, 5 |
| `test/integration/dm-window.test.ts` | 3, 7, 8 |
| `test/integration/dm-edit.test.ts` | 5, 6 |
| `src/dm/seat.ts` | 2, 7 |

Five of ten tasks edit `src/index.ts`; three edit `src/campaign-do.ts`. Running
those concurrently in separate worktrees produces guaranteed conflicts on every
merge, and the conflicts land in a 460-line router and an 830-line Durable
Object — the two files where a bad three-way merge is hardest to spot.

**So the tasks are regrouped into nodes by file ownership, not by feature.** One
node owns a file for the duration. This is the difference between parallelism
that helps and parallelism that just moves work from implementation to conflict
resolution.

## Nodes

| Node | Plan tasks | Owns (exclusive) | Also creates |
|---|---|---|---|
| **N1** foundation | 1 | `migrations/0005_dm.sql` | `test/helpers/schema.ts` |
| **N2** seat | 2 | `src/dm/seat.ts`, `src/index.ts` | `test/helpers/session.ts`, `test/integration/dm-seat.test.ts` |
| **N3** phase machine | 3 | `src/campaign-do.ts` | `test/integration/dm-window.test.ts` |
| **N4** router | 4, 5, 6 | `src/index.ts`, `src/web/chronicle.ts` | `test/integration/dm-visibility.test.ts`, `test/integration/dm-edit.test.ts` |
| **N5** durable object | 7, 8 | `src/campaign-do.ts`, `src/email/outbound.ts`, `src/dm/seat.ts` | `test/integration/dm-notice.test.ts` |
| **N6** UI | 9 | `public/*`, `scripts/ui-smoke.mjs` | — |
| **N7** smoke | 10 (checks) | `scripts/smoke.mjs` | — |
| **N8** docs | 10 (prose) | `README.md`, `docs/specs/*`, `docs/HANDOFF.md` | — |

N6 also appends one line to `src/index.ts` (`windowClosesAt` in the campaign
GET). That is a one-line addition to a file N4 owns, so **N6 runs after N4 is
merged**, never beside it.

## The DAG

```
N1 ──► N2 ──► N3 ──┬──► N4 (router) ──────┬──► N6 (UI) ───┐
                   │                      │               ├──► N7 (smoke) ──► ✅
                   └──► N5 (durable obj) ─┘   N8 (docs) ──┘
```

| Node | Depends on | Why |
|---|---|---|
| N1 | — | |
| N2 | N1 | needs `test/helpers/schema.ts` and the seat columns |
| N3 | N2 | imports `getSeat`, `resolveWindowMs` from `src/dm/seat.ts` |
| N4 | N2, N3 | routes call `publishHeldBeat` / `reviewState`; tests drive real ticks |
| N5 | N3 | replaces the `#countMissedWindow` stubs N3 leaves behind |
| N6 | N4 | touches `src/index.ts`, which N4 owns until merged |
| N7 | N4, N5, N6 | smokes endpoints that must exist and be deployed |
| N8 | N4, N5 | describes what actually shipped |

## Concurrency — honestly, two lanes

**Maximum useful parallelism is 2, not 4.** N1→N2→N3 is a hard serial chain
(each imports the previous one's exports), and it is 3 of 8 nodes. After it:

| Wave | Concurrent | Lanes |
|---|---|---|
| 1 | N1 | 1 |
| 2 | N2 | 1 |
| 3 | N3 | 1 |
| 4 | **N4 ∥ N5** | 2 |
| 5 | **N6 ∥ N8** | 2 |
| 6 | N7 | 1 |

Waves 1–3 run in the branch worktree directly. There is nothing to isolate — a
worktree per node would add an `npm ci` and a merge for zero concurrency. Waves
4 and 5 run in real worktrees, because those nodes genuinely run beside each
other and must not see each other's tree.

## Verification commands

Each node is done when **its own command passes and the full suite still
passes.** The full suite is not optional per node: N3 and N5 modify the shared
tick path, and a node that greens its own test while reddening `tick.test.ts`
has broken the simulation, which is the one thing this project does not trade.

| Node | Node verification | Gate |
|---|---|---|
| N1 | `npm test -- test/integration/dm-migration.test.ts` | + `npm test && npm run typecheck` |
| N2 | `npm test -- test/integration/dm-seat.test.ts` | + `npm test && npm run typecheck` |
| N3 | `npm test -- test/integration/dm-window.test.ts` | + `npm test && npm run typecheck` |
| N4 | `npm test -- test/integration/dm-visibility.test.ts test/integration/dm-edit.test.ts` | + `npm test && npm run typecheck` |
| N5 | `npm test -- test/integration/dm-window.test.ts test/integration/dm-notice.test.ts` | + `npm test && npm run typecheck` |
| N6 | `node scripts/ui-smoke.mjs http://localhost:8787` | + `npm test && npm run typecheck` |
| N7 | `node scripts/smoke.mjs http://localhost:8787` | + full suite |
| N8 | `npm run sim:soak -- --ticks 500` unchanged | + full suite |

**Integration gate after every merge:** `npm test && npm run typecheck && npm run sim:soak -- --ticks 500`.
The soak must be byte-identical to baseline — slice 1 touches no file under
`src/sim/`, so any soak difference means a node reached somewhere it should not
have.

## Review mandate

No node is accepted on the implementer's word. A reviewer that did not write the
code must empirically verify — run the commands, not read them — against these
defect classes:

- **(a) CSS specificity / inheritance collisions** — a new rule silently
  overriding an existing one. Live for N6 only.
- **(b) Key-normalization and dedup bugs** — two logically identical records
  treated as distinct. Live for N1 (the `published_at` backfill), N2 (seat
  identity), N5 (missed-window counting).
- **(c) Misused CLI/API flags that fail only at runtime** — live for N1
  (`wrangler d1 migrations apply`), N7 (`wrangler d1 execute --remote --json`),
  N6 (Playwright).
- **(d) Stale tests, fixtures, or seed scripts left behind** — live for N5,
  which is required to delete the `#countMissedWindow` stubs N3 introduced.
- **(e) Claims not enforced by any check** — live for N8 especially: the
  reworded promise must be backed by a test that actually runs, not asserted in
  prose.

## Known descopes

Tracked here so Phase 5 files them rather than losing them:

- Spec §9 "DM leaves the campaign → seat reverts to host" — no leave-campaign
  flow exists in the app, so there is nothing to hook. Belongs to whoever builds
  membership removal.
- Slice 2 (typed canon ops) and slice 3 (free-text front door) are specced and
  unbuilt by design.
