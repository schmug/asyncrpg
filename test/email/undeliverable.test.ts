/**
 * Addresses that can never receive mail.
 *
 * Delivering to an RFC 2606 / RFC 6761 reserved domain is not a risk of
 * bouncing — it is a guaranteed hard bounce, by standard, every time. And a
 * bounce rate is what a sending domain's reputation is measured in.
 *
 * On 2026-08-03 this account hit an 83.5% bounce rate and a "sending may be
 * paused" warning: 780 of 934 messages failed, because every test harness
 * addresses its players at `@example.invalid` and the app faithfully tried to
 * deliver to all of them. Losing the domain's ability to send mail would have
 * taken the product's primary channel with it.
 */

import { describe, expect, it } from "vitest";
import { isUndeliverable } from "../../src/email/parse";

describe("isUndeliverable", () => {
  it.each([
    "zzsmoke+rl3-a1b2@example.invalid",
    "demo+ada@example.invalid",
    "someone@example.com",
    "someone@example.net",
    "someone@example.org",
    "someone@my.test",
    "someone@thing.example",
    "someone@localhost",
    "root@localhost",
  ])("refuses %s", (address) => {
    expect(isUndeliverable(address)).toBe(true);
  });

  it.each([
    "games@coryrank.in",
    "dm@cortech.online",
    "rpgloop@q-r.contact",
    "someone@gmail.com",
    "a.b+tag@sub.domain.co.uk",
    "Player Name <player@example.io>",
  ])("allows %s", (address) => {
    expect(isUndeliverable(address)).toBe(false);
  });

  it("refuses anything that is not an address at all", () => {
    for (const bad of ["", null, undefined, "no-at-sign", "@nolocal.com", "trailing@dot."]) {
      expect(isUndeliverable(bad as string)).toBe(true);
    }
  });

  it("does not refuse a domain merely containing a reserved word", () => {
    // `example.io` and `invalid-name.com` are ordinary registrable domains.
    expect(isUndeliverable("a@example.io")).toBe(false);
    expect(isUndeliverable("a@invalid-name.com")).toBe(false);
    expect(isUndeliverable("a@testing.com")).toBe(false);
  });
});
