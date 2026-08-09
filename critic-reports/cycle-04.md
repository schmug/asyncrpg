```json
{
  "scores": {
    "product": 7,
    "async": 8,
    "narrative": 7,
    "ux": 7,
    "rigor": 6
  },
  "verdict": "fail",
  "summary": "asyncrpg is substantially more real than a prototype: the sim, absence policy, invite join, email reply path, mobile UI, and chronicle all exist in code and in capture evidence. It is not professionally shippable yet because the production HTTP smoke suite fails on normal action submission, the primary email channel lacks real mailbox deliverability evidence, live narration contains visible artifacts, and the deployed security posture has a known HSTS regression.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "rigor",
      "title": "Production happy path smoke is failing",
      "detail": "live-capture/smoke-output.txt shows /api/campaigns/:slug/action returning status 500 and the solo quorum tick staying at 0, with the suite exiting 73/75 non-zero. Done means root-causing the 500 from production logs, adding the missing regression coverage, and capturing a fresh production smoke run with 0 failures."
    },
    {
      "severity": "major",
      "category": "product",
      "title": "Core loop is not yet proven durable for real groups",
      "detail": "The code implements create, invite, join, act, resolve, read, and email reply, but the live evidence is a 7-turn demo plus one email loopback reply; it does not prove months of n-player play with quorum, deadlines, late joins, long absence, and re-entry over real channels. Done means an accelerated staging endurance capture with 3+ players across quorum and deadline ticks, 1/3/30 missed ticks, re-entry recaps, and repeated email/web play."
    },
    {
      "severity": "major",
      "category": "ux",
      "title": "Primary email deliverability is unverified",
      "detail": "live-capture/email-e2e-output.txt explicitly says Gmail/Outlook spam handling is still not covered. Since email is the primary play surface, SPF/DMARC plus Cloudflare loopback is not enough. Done means seed-list delivery tests against major mailbox providers, monitored bounce/spam results, and user-visible recovery guidance for real mailbox failures."
    },
    {
      "severity": "major",
      "category": "narrative",
      "title": "Live narration ships visible model artifacts",
      "detail": "live-capture/generated-narration.txt and chronicle-demo.html.txt contain a literal //n inside Tick 6 prose. src/dm/narrate.ts validates truncation and fences but not slash-escaped newline artifacts. Done means rejecting or normalizing these artifacts before storage, adding a regression test, and repairing affected public beats."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Live HSTS is disabled",
      "detail": "live-capture/health.txt serves strict-transport-security: max-age=0; includeSubDomains; preload, while src/index.ts intends a one-year HSTS policy. The smoke suite labels this as known drift, but professional deployment should not normalize a disabled transport security header. Done means fixing the Cloudflare zone override or deployment config so production serves the intended HSTS policy."
    },
    {
      "severity": "minor",
      "category": "async",
      "title": "Short absences do not get social catch-up",
      "detail": "restoreStanding runs only when a character returns from offscreen in src/sim/tick.ts, while active players can gain renown/bonds through actions and downtime. This is probably an intentional story-presence asymmetry, but the promise should explicitly distinguish 1-2 missed drifting ticks from 3+ offscreen return. Done means either codifying that distinction in product copy/tests or applying the same catch-up rule on any return from absence."
    }
  ]
}
```
