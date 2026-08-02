import { describe, expect, it } from "vitest";
import {
  buildSubject,
  campaignLocalPart,
  codeFromSubject,
  localPart,
  referencedMessageIds,
  sameAddress,
  slugFromLocalPart,
  stripQuotedReply,
} from "../../src/email/parse";

describe("subject codes", () => {
  it("round-trips through a built subject", () => {
    const subject = buildSubject("Ashfall", 14, "k7f2q9x", "The Baron's Envoy");
    expect(codeFromSubject(subject)).toBe("k7f2q9x");
  });

  it("survives the Re: prefixes clients add", () => {
    const subject = buildSubject("Ashfall", 14, "k7f2q9x", "The Envoy");
    for (const prefix of ["Re: ", "RE: ", "Fwd: Re: ", "AW: ", "Re : "]) {
      expect(codeFromSubject(prefix + subject)).toBe("k7f2q9x");
    }
  });

  it("survives a campaign name containing punctuation", () => {
    expect(codeFromSubject(buildSubject("Ash & Iron — Book II", 3, "abc123", "x"))).toBe("abc123");
  });

  it("is case-insensitive and normalizes to lowercase", () => {
    expect(codeFromSubject("[Ashfall #K7F2Q9X] Tick 1 — x")).toBe("k7f2q9x");
  });

  it("returns null when there is no code", () => {
    expect(codeFromSubject("Re: dinner tomorrow")).toBeNull();
    expect(codeFromSubject("")).toBeNull();
    expect(codeFromSubject(null)).toBeNull();
    expect(codeFromSubject("[Ashfall] Tick 14")).toBeNull();
  });

  it("does not match something too short to be a real code", () => {
    expect(codeFromSubject("[x #abc] hi")).toBeNull();
  });
});

describe("referencedMessageIds", () => {
  it("extracts from In-Reply-To", () => {
    expect(referencedMessageIds({ inReplyTo: "<abc@play.cortech.online>" })).toEqual([
      "abc@play.cortech.online",
    ]);
  });

  it("prefers In-Reply-To, then walks References newest-first", () => {
    expect(
      referencedMessageIds({
        inReplyTo: "<c@x>",
        references: "<a@x> <b@x> <c@x>",
      }),
    ).toEqual(["c@x", "b@x", "a@x"]);
  });

  it("handles missing, empty, and malformed headers", () => {
    expect(referencedMessageIds({})).toEqual([]);
    expect(referencedMessageIds({ inReplyTo: "", references: null })).toEqual([]);
    expect(referencedMessageIds({ inReplyTo: "not-bracketed" })).toEqual([]);
  });
});

describe("stripQuotedReply", () => {
  it("keeps a plain top-posted reply", () => {
    const raw = [
      "I walk up to the gate and ask for the steward by name.",
      "",
      "On Mon, 4 Aug 2026 at 09:12, Ashfall <dm@play.cortech.online> wrote:",
      "> The envoy waits at the gate, mud to the knee.",
      "> Nobody has spoken for a while.",
    ].join("\n");
    expect(stripQuotedReply(raw)).toBe("I walk up to the gate and ask for the steward by name.");
  });

  it("handles CRLF line endings", () => {
    const raw = "I wait and watch.\r\n\r\nOn Mon wrote:\r\n> quoted\r\n";
    expect(stripQuotedReply(raw)).toBe("I wait and watch.");
  });

  it("strips an RFC 3676 signature", () => {
    expect(stripQuotedReply("I go north.\n\n-- \nSent from a phone")).toBe("I go north.");
    expect(stripQuotedReply("I go north.\n\n--\nCory")).toBe("I go north.");
  });

  it("strips Outlook-style original-message separators", () => {
    const raw = "I refuse the offer.\n\n-----Original Message-----\nFrom: Ashfall\nblah";
    expect(stripQuotedReply(raw)).toBe("I refuse the offer.");
  });

  it("strips a forwarded From: block", () => {
    expect(stripQuotedReply("Hold the line.\n\nFrom: Ashfall <dm@x>\nSent: whenever")).toBe(
      "Hold the line.",
    );
  });

  it("strips mobile client boilerplate", () => {
    expect(stripQuotedReply("Yes, do it.\n\nSent from my iPhone")).toBe("Yes, do it.");
    expect(stripQuotedReply("Yes, do it.\n\nGet Outlook for Android")).toBe("Yes, do it.");
  });

  it("drops interleaved quoted lines", () => {
    const raw = "> the envoy waits\nI ignore him.\n> nobody speaks\nAnd I keep walking.";
    expect(stripQuotedReply(raw)).toBe("I ignore him.\nAnd I keep walking.");
  });

  it("recovers something rather than nothing when a player bottom-posts inside the quote", () => {
    // Everything before the cutoff is empty; naive stripping yields "".
    const raw = [
      "On Mon, 4 Aug 2026, Ashfall wrote:",
      "> The envoy waits at the gate.",
      "",
      "I let him wait.",
    ].join("\n");
    const out = stripQuotedReply(raw);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("I let him wait.");
  });

  it("returns the original text rather than nothing when everything looks quoted", () => {
    const raw = "> only quoted content here\n> and more of it";
    expect(stripQuotedReply(raw).length).toBeGreaterThan(0);
  });

  it("handles an empty body without throwing", () => {
    expect(stripQuotedReply("")).toBe("");
    expect(stripQuotedReply("   \n\n  ")).toBe("");
  });

  it("preserves multi-paragraph intent", () => {
    const raw = "I do two things.\n\nFirst I check the door.\nThen I listen.\n\nOn Mon wrote:\n> x";
    expect(stripQuotedReply(raw)).toBe("I do two things.\n\nFirst I check the door.\nThen I listen.");
  });
});

describe("sameAddress", () => {
  it("matches identical addresses", () => {
    expect(sameAddress("a@b.com", "a@b.com")).toBe(true);
  });

  it("ignores case and surrounding display names", () => {
    expect(sameAddress("Cory <A@B.COM>", "a@b.com")).toBe(true);
  });

  it("ignores a plus tag on either side", () => {
    expect(sameAddress("a+game@b.com", "a@b.com")).toBe(true);
  });

  it("does not match different addresses", () => {
    expect(sameAddress("a@b.com", "a@c.com")).toBe(false);
    expect(sameAddress("a@b.com", "z@b.com")).toBe(false);
  });

  it("is false for null, empty, or malformed input rather than throwing", () => {
    expect(sameAddress(null, "a@b.com")).toBe(false);
    expect(sameAddress("a@b.com", undefined)).toBe(false);
    expect(sameAddress("", "")).toBe(false);
    expect(sameAddress("nonsense", "nonsense")).toBe(false);
    expect(sameAddress("@b.com", "@b.com")).toBe(false);
  });
});

describe("campaign inbox addressing", () => {
  it("round-trips a slug through the local part", () => {
    expect(slugFromLocalPart(campaignLocalPart("ashfall"))).toBe("ashfall");
  });

  it("tolerates a plus tag added by a forwarding chain", () => {
    expect(slugFromLocalPart("rpg-ashfall+spam")).toBe("ashfall");
  });

  it("returns null for an unrelated address", () => {
    expect(slugFromLocalPart("security")).toBeNull();
    expect(slugFromLocalPart(null)).toBeNull();
  });

  it("extracts the local part from a full address", () => {
    expect(localPart("RPG-Ashfall@cortech.online")).toBe("rpg-ashfall");
    expect(localPart("Ashfall <rpg-ashfall@cortech.online>")).toBe("rpg-ashfall");
    expect(localPart("garbage")).toBeNull();
  });
});
