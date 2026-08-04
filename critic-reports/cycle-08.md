```json
{
  "scores": { "product": 7, "async": 8, "narrative": 6, "ux": 7, "rigor": 7 },
  "verdict": "fail",
  "summary": "asyncrpg is a real, working product with a complete create/join/act/resolve/read loop, strong absence semantics, and unusually serious verification for a small app. It is not professionally shippable yet because fresh production evidence shows malformed model prose in the public chronicle, the live validator/smoke harness misses those artifacts, and real Gmail/Outlook deliverability is still explicitly pending. The core architecture claim is mostly borne out: simulation state is deterministic canon, and model output is constrained to intent parsing and prose.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "narrative",
      "title": "Malformed prose reaches the public chronicle",
      "detail": "live-capture/generated-narration.txt contains shipped corruption: bracket/code tails around line 66, long soft-hyphen/control filler around line 200, a stray closing brace around line 222, and ideographic/CJK artifacts around line 240. src/dm/narrate.ts only rejects the narrower ARTIFACT_PATTERNS at lines 249-257, so usable() at lines 272-279 accepts prose that visibly breaks immersion. Done means expanding normalization/validation, adding regression tests from these exact captures, preventing future writes, and repairing or regenerating existing affected beats."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Smoke harness gives a false clean bill on prose corruption",
      "detail": "live-capture/smoke-output.txt lines 22-30 reports the public chronicle is free of prose artifacts, while live-capture/generated-narration.txt shows artifacts it did not detect. scripts/smoke.mjs mirrors the same incomplete pattern list at lines 240-254. Done means the production smoke check must catch every known artifact class, fail on suspicious non-prose Unicode/control runs and unmatched syntax tails, and include fixture tests proving the live extractor cannot pass on dirty prose."
    },
    {
      "severity": "major",
      "category": "ux",
      "title": "Primary email UX lacks real-inbox deliverability proof",
      "detail": "live-capture/email-e2e-output.txt proves a real two-zone Cloudflare loop, but lines 33-34 explicitly say Gmail/Outlook spam handling is not covered. live-capture/deliverability.md lines 23-28 still lists Gmail and Outlook results as pending. For a play-by-email product, done means seed-list or documented manual evidence for Gmail and Outlook sign-in plus turn emails, including placement, timing, DKIM/SPF/DMARC details, and remediation if either lands outside the inbox."
    },
    {
      "severity": "major",
      "category": "product",
      "title": "Chronicle quality is not yet months-shippable",
      "detail": "The sim is real and consequential, but the public demo chronicle is the product artifact and currently includes visible generation garbage plus recurring motif/action phrasing in live-capture/generated-narration.txt. A real group may tolerate a templated fallback; they will not trust a long-term canon archive that occasionally prints machine detritus. Done means a clean regenerated demo chronicle, stronger prose QA gates, and review of repetition in generated beats before using this as the public exemplar."
    },
    {
      "severity": "major",
      "category": "product",
      "title": "Email deliverability is still a launch dependency",
      "detail": "The app can be played from the web if email fails, and delivery failures are surfaced, but the claimed primary channel is inbox play. Without Gmail/Outlook evidence, a group signup can fail at the first magic link or miss turn nudges despite the internal loop passing. Done means launch readiness requires successful real-provider delivery checks and an operator runbook for reputation, quota, bounce, and spam-placement failures."
    },
    {
      "severity": "minor",
      "category": "ux",
      "title": "First-run surface is text-heavy",
      "detail": "The signed-out mobile screenshot is clear but dense, and the campaign screen stacks many sections vertically. This does not block play, but it raises onboarding friction for non-technical players. Done means preserving the current clarity while tightening copy, keeping the action prompt/latest beat/character sheet dominant, and verifying screenshots at small mobile heights."
    },
    {
      "severity": "minor",
      "category": "rigor",
      "title": "Stale failure screenshot can mislead review",
      "detail": "live-capture/ui/99-failure.png shows a partially rendered home state even though live-capture/ui-smoke-output.txt reports 34/34 passing. If this is a stale artifact from a previous failed run, the bundle should not include it as fresh evidence. Done means cleaning the screenshot output directory before capture or recording explicitly which screenshots are current failures."
    }
  ]
}
```
