/**
 * A campaign that cannot resolve must stop, not spin.
 *
 * Rejecting a tick that would corrupt canon is correct. Rescheduling forever
 * after rejecting it is not: if deterministic world drift caused the
 * violation, every subsequent alarm recomputes the same drift from the same
 * state and fails identically, and the group sees a campaign that looks alive
 * and never moves.
 */

import { describe, expect, it } from "vitest";
import { blockedTickPolicy } from "../../src/campaign-do";

describe("blocked tick policy", () => {
  it("keeps the clock running for the first failure", () => {
    // Clearing the pending queue changes the inputs, so a violation caused by
    // a player's action genuinely is fixed by trying again.
    const p = blockedTickPolicy(0, "blocked");
    expect(p).toEqual({ runs: 1, reschedule: true, halted: false });
  });

  it("gives it more than one chance", () => {
    expect(blockedTickPolicy(1, "blocked")).toMatchObject({ reschedule: true, halted: false });
  });

  it("halts rather than looping once retrying is clearly not working", () => {
    const p = blockedTickPolicy(2, "blocked");
    expect(p.halted).toBe(true);
    expect(p.reschedule).toBe(false);
  });

  it("stays halted rather than drifting back into rescheduling", () => {
    for (const runs of [3, 4, 10, 100]) {
      expect(blockedTickPolicy(runs, "blocked")).toMatchObject({
        reschedule: false,
        halted: true,
      });
    }
  });

  it("forgets the whole history as soon as a tick gets through", () => {
    expect(blockedTickPolicy(2, "resolved")).toEqual({ runs: 0, reschedule: true, halted: false });
  });

  it("never halts a campaign that is resolving", () => {
    let runs = 0;
    for (let i = 0; i < 50; i++) {
      const p = blockedTickPolicy(runs, "resolved");
      runs = p.runs;
      expect(p.halted).toBe(false);
    }
  });

  it("halts within a bounded number of attempts, whatever the starting point", () => {
    // The property that matters: no path through this reducer reschedules
    // indefinitely while ticks keep failing.
    let runs = 0;
    let attempts = 0;
    let policy = blockedTickPolicy(runs, "blocked");
    while (policy.reschedule && attempts < 1000) {
      runs = policy.runs;
      policy = blockedTickPolicy(runs, "blocked");
      attempts++;
    }
    expect(policy.halted).toBe(true);
    expect(attempts).toBeLessThan(10);
  });
});
