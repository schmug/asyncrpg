```json
{
  "scores": { "product": 7, "async": 7, "narrative": 7, "ux": 7, "rigor": 7 },
  "verdict": "fail",
  "summary": "asyncrpg is a serious, working prototype with a real deterministic simulation, real web and email submission paths, good security posture, and strong absence mechanics in code. It is not yet professionally shippable for the claimed play-by-email product: real inbox deliverability is unproven, offscreen players are still prompted every tick, lifecycle failure modes can leave orphaned campaigns, and narration quality/faithfulness is not gated as strongly as state authority is.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "ux",
      "title": "Prove real inbox deliverability",
      "detail": "live-capture/email-e2e-output.txt proves Cloudflare loopback only and explicitly says Gmail/Outlook spam placement is not covered; live-capture/deliverability.md has pending Gmail and Outlook results. Done means seed-list tests or documented manual gates for Gmail, Outlook, and at least one other major provider covering sign-in links, beat delivery, reply threading, inbox/spam placement, and DKIM/SPF/DMARC alignment."
    },
    {
      "severity": "major",
      "category": "async",
      "title": "Offscreen players still receive full turn prompts",
      "detail": "src/campaign-do.ts:721-740 fans out every beat to every member and calls promptFor(character, state) regardless of presence. That undermines the social side of 'quietly steps offscreen': a busy player keeps getting nudged as if it is still their turn. Done means offscreen players receive a lower-pressure digest/recap or notification preference, not repeated action prompts, while preserving easy re-entry."
    },
    {
      "severity": "major",
      "category": "product",
      "title": "Campaign creation is not recoverable as a lifecycle",
      "detail": "src/index.ts:287-302 writes the campaign row, initializes the Durable Object, joins the host, then writes membership; src/campaign-do.ts:274-312 schedules the clock during init and join. A failure between these steps can leave a campaign/world/clock that the creator cannot access or repair. Done means creation is a recoverable saga with idempotent repair/cleanup, membership established before the clock is live, and tests for each partial-failure point."
    },
    {
      "severity": "major",
      "category": "narrative",
      "title": "Narration is readable but not yet artifact-grade",
      "detail": "live-capture/generated-narration.txt is pleasant prose, but many turns repeat the same Peirmarket market rhythm, the same two-character paragraph structure, and similar partial-success phrasing. src/dm/narrate.ts:319-389 validates corruption, length, and repertoire, but not factual coverage, contradiction, or invented concrete detail. Done means captured chronicle review gates for repetition and entity/outcome fidelity, plus a post-generation fact check or stricter renderer fallback when the prose adds unsupported people, actions, or stakes."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Inference budget control fails open",
      "detail": "src/campaign-do.ts:214-218 returns true when the budget table check fails, allowing model spend precisely when accounting is unavailable. For a long-running game with per-campaign narration, this is not a professional cost-control posture. Done means budget-check failure degrades to templated narration or uses a separately reliable kill switch, with a visible operator/player degradation reason and tests."
    },
    {
      "severity": "major",
      "category": "ux",
      "title": "First-run controls need clearer affordances",
      "detail": "live-capture/ui/05-campaign.png shows important sections such as 'How this works', 'Change the pace', downtime, and private scenes as terse headings/collapsed controls. The UI smoke proves accessibility basics, but a non-technical first-time host may not understand what is interactive or what to do next after creating a game. Done means obvious disclosure affordances, clearer invite/pace setup flow, and captured mobile screenshots showing the expected host and player first-run paths."
    },
    {
      "severity": "minor",
      "category": "rigor",
      "title": "Keep the strong gates but add failure-injection coverage",
      "detail": "The repo has good tests and live smoke evidence, including 282 passing tests and a 1000-tick deterministic soak. The remaining gaps are edge failures: D1 write failures during create/join/projection, email provider failures after acceptance, stale reply bindings, and budget-store outages. Done means integration tests or harness cases that inject those failures and assert the campaign remains playable with visible repair paths."
    }
  ]
}
```
