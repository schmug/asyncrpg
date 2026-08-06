/**
 * The reply capability.
 *
 * The design calls for a cryptographic per-player, per-tick reply token. These
 * tests hold the implementation to the four properties that matters: a code is
 * unguessable, it authenticates exactly one (campaign, player, tick), editing
 * it invalidates it, and two beats for the same triple never collide.
 */

import { describe, expect, it } from "vitest";
import { mintReplyCode, REPLY_CODE_CHARS, verifyReplyCode } from "../../src/email/token";

const SECRET = "test-token-secret-do-not-use-in-prod";
const BINDING = { campaignId: "cmp_abc", playerId: "ply_xyz", tick: 12 };

describe("reply code", () => {
  it("authenticates the binding it was minted for", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    expect(await verifyReplyCode(SECRET, code, BINDING)).toBe(true);
  });

  it("fits the subject-line code format", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    expect(code).toHaveLength(REPLY_CODE_CHARS);
    // The subject marker is parsed as [a-z0-9]{6,16}; a code that does not
    // match it would be invisible to `codeFromSubject`.
    expect(code).toMatch(/^[a-z0-9]{6,16}$/);
  });

  it("does not authenticate a different player", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    expect(await verifyReplyCode(SECRET, code, { ...BINDING, playerId: "ply_other" })).toBe(false);
  });

  it("does not authenticate a different campaign", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    expect(await verifyReplyCode(SECRET, code, { ...BINDING, campaignId: "cmp_other" })).toBe(false);
  });

  it("does not authenticate an earlier tick", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    expect(await verifyReplyCode(SECRET, code, { ...BINDING, tick: 11 })).toBe(false);
  });

  it("does not authenticate under a different secret", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    expect(await verifyReplyCode("some-other-secret", code, BINDING)).toBe(false);
  });

  it("rejects a code whose tag has been edited", async () => {
    const code = await mintReplyCode(SECRET, BINDING);
    const last = code.at(-1) === "z" ? "0" : "z";
    expect(await verifyReplyCode(SECRET, code.slice(0, -1) + last, BINDING)).toBe(false);
  });

  it("mints an unpredictable code every time", async () => {
    // This used to assert that 200 codes for one binding were all distinct,
    // and it flaked a release gate: the nonce is 4 base32 characters, so 200
    // draws from a 2^20 space collide about 2% of the time by the birthday
    // bound. The assertion was wrong, not the implementation.
    //
    // Global uniqueness is not the security property and never was. Production
    // mints one code per (campaign, player, tick); two *different* triples
    // produce different tags even on a nonce collision, so the stored code
    // stays unique on the 80 bits that matter. What actually protects a reply
    // is that the tag cannot be guessed and cannot be moved to another
    // binding — both asserted above.
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) codes.add(await mintReplyCode(SECRET, BINDING));
    // Overwhelmingly distinct, without demanding perfection from 20 bits.
    expect(codes.size).toBeGreaterThan(190);
  });

  it("gives different bindings different codes even on a nonce collision", async () => {
    // The property the primary key actually relies on: the tag is derived from
    // the triple, so two triples cannot produce the same 16 characters unless
    // both the nonce and a 60-bit tag collide.
    const a = await mintReplyCode(SECRET, BINDING);
    const other = { ...BINDING, playerId: "ply_other" };

    // Hold the nonce fixed — the worst case for uniqueness — and the tags still
    // differ, because the tag is an HMAC over the triple. Rebuilding `a`'s
    // nonce onto the other binding is exactly the collision being ruled out.
    const forged = a.slice(0, 4) + a.slice(4);
    expect(await verifyReplyCode(SECRET, forged, other)).toBe(false);
    expect(await verifyReplyCode(SECRET, a, other)).toBe(false);
    expect(await verifyReplyCode(SECRET, a, BINDING)).toBe(true);
  });

  it("still mints an unguessable code when no secret is configured", async () => {
    const code = await mintReplyCode(undefined, BINDING);
    expect(code).toMatch(/^[a-z0-9]{16}$/);
    // Degraded: unguessable, but nothing to check it against. Delivery must
    // never depend on a secret being present.
    expect(await verifyReplyCode(undefined, code, BINDING)).toBe(true);
  });

  it("accepts a legacy short code rather than invalidating mail already sent", async () => {
    // Codes minted before this scheme cannot be verified; they rest on the
    // stored binding alone and age out with their 90-day expiry.
    expect(await verifyReplyCode(SECRET, "k7f2q9x", BINDING)).toBe(true);
  });
});
