# Parallel build plan — email keyword links

**Source spec:** `docs/specs/2026-08-08-email-keyword-links-design.md`
**Source task detail:** `.claude/plans/2026-08-08-email-keyword-links.md` (full TDD steps + code per node)
**Branch:** `claude/email-keyword-links-c78541`
**Baseline:** 182 tests / 9 files passing; `npm run typecheck` clean; `sim:soak` deterministic.

This file is the DAG and the concurrency contract. The per-node implementation
detail lives in the task plan above; nodes reference it by task number.

---

## Node table

| Node | Scope | Files touched | Verification command | Depends on |
|---|---|---|---|---|
| **N1** | Project `WorldEvent.targetIds` into D1. Closes #7. | `migrations/0005_event_targets.sql` **(new)**<br>`src/campaign-do.ts` **(mod: `#writeEvents`, ~L620-651)**<br>`test/integration/projection.test.ts` **(new)** | `npx vitest run test/integration/projection.test.ts` | — |
| **N2** | Banding labels, blurbs, `dossierPath`, shared test fixture. | `src/lore/mentions.ts` **(new)**<br>`test/lore/fixtures.ts` **(new)**<br>`test/lore/mentions.test.ts` **(new)** | `npx vitest run test/lore/mentions.test.ts` | — |
| **N3** | Prose scanning: `scanProse`, `Segment`, `MentionScan`, `MAX_MENTIONS`. | `src/lore/mentions.ts` **(mod: append)**<br>`test/lore/mentions.test.ts` **(mod: append)** | `npx vitest run test/lore/mentions.test.ts` | N2 |
| **N4** | Dossier page + route. | `src/web/dossier.ts` **(new)**<br>`src/index.ts` **(mod: +1 route after L190, +1 import at L29)**<br>`test/web/dossier.test.ts` **(new)** | `npx vitest run test/web/dossier.test.ts` | N1, N2 |
| **N5** | Linkified HTML + who's-who in both MIME parts; tick wiring. | `src/email/outbound.ts` **(mod)**<br>`src/campaign-do.ts` **(mod: `#fanOut` ~L548-588, +1 import at L25)**<br>`test/email/outbound.test.ts` **(new)** | `npx vitest run test/email/outbound.test.ts` | N1, N2, N3, N4 |
| **N6** | Full-gate verification + running-app check + PR. | none | `npm test && npm run typecheck && npm run sim:soak -- --ticks 500` | N1–N5 |

---

## Overlapping-file analysis

Three genuine file collisions exist. **All three are already serialized by a
semantic dependency edge**, so no additional ordering constraint is needed —
but each is called out so integration knows where to expect a rebase.

| Nodes | Shared file | Regions | Resolution |
|---|---|---|---|
| **N2 ↔ N3** | `src/lore/mentions.ts`, `test/lore/mentions.test.ts` | N3 appends to both | Serialized by N3→N2 (N3 imports `blurbFor`, `Mention`, `LinkableKind`). Same-file, append-only. |
| **N1 ↔ N5** | `src/campaign-do.ts` | N1: `#writeEvents` ~L620-651. N5: `#fanOut` ~L548-588 + import block L25. | Serialized by N5→N1. Regions are ~70 lines apart and disjoint; a rebase is expected to be clean but must be confirmed, not assumed. |
| **N4 ↔ N5** | none directly | — | N5→N4 is a *product* edge, not a compile edge: mail must not link to a route that does not exist yet. Enforced by ordering, not by the compiler. |

**Non-overlapping and therefore safe to parallelize:**

- N1 and N2 share no file. `src/campaign-do.ts` + migrations vs `src/lore/**`.
- N3 and N4 share no file. `src/lore/mentions.ts` vs `src/web/dossier.ts` + `src/index.ts`.

---

## Execution waves

```
wave 1 ── N1 (targetIds → D1)  ∥  N2 (blurbs + fixture)
             │                        │
             ├────────────┬───────────┤
             ▼            ▼           ▼
wave 2 ──          N4 (dossier)  ∥  N3 (scanProse)
                        │            │
                        └─────┬──────┘
                              ▼
wave 3 ──                   N5 (email)
                              │
                              ▼
wave 4 ──                   N6 (gates + PR)
```

**Maximum achievable width is 2, not 4.** Five implementation nodes over a
critical path of four (`N2 → N3 → N5 → N6`, and equally `N1 → N4 → N5 → N6`)
leaves exactly two disjoint pairs. Dispatching four agents would mean either
splitting a node mid-file — which reintroduces the `src/lore/mentions.ts`
collision the DAG exists to avoid — or inventing work the spec does not call
for. Two waves of two is the real parallelism available; the remaining nodes
are genuinely sequential.

---

## Plan correction applied before dispatch

The task plan had `test/email/outbound.test.ts` importing the `world()` helper
directly from `test/lore/mentions.test.ts`. Importing one test file from
another makes Vitest execute that file's `describe` blocks a second time inside
the importer, inflating counts and coupling two nodes' test files.

**Fixed:** N2 creates `test/lore/fixtures.ts` exporting `world()`. Both
`test/lore/mentions.test.ts` and `test/email/outbound.test.ts` import from
there. This also removes a would-be N5→N2 *test-file* dependency, leaving only
the code dependency.

---

## Contract for every implementation agent

1. **TDD, strictly.** Write the failing test, run it, confirm it fails *for the
   stated reason* — not a typo or a bad import — then implement, then re-run.
2. The node's verification command must pass, and `npm run typecheck` must be
   clean, before reporting back.
3. **`src/sim/` is off limits.** If a node appears to need a sim change, stop
   and report rather than editing.
4. Do not modify a file outside the node's declared file list. If the node
   cannot be completed without doing so, stop and report.
5. Commit with a conventional prefix. Do not merge, do not push, do not open a PR.
6. Report: files changed, a diff summary, verbatim verification output, and
   anything encountered that contradicts the plan.

## Contract for every reviewer agent

A reviewer never reviews code it wrote. Mandate and defect classes are in the
dispatch prompt; the binding rule is **empirical verification — run the
commands, do not reason from reading alone.** A node is accepted only on a
`PASS` verdict.
