Fail. This is much closer to a real shippable beta than a toy: the core loop exists, the sim is genuinely deterministic, absence handling is enforced in code, and the auth/email/security posture is serious. But I would not call it professional-quality shippable yet because the live chronicle still contains a visible model artifact, long-running chronicle/recap access is truncated, and the primary email UX still lacks real Gmail/Outlook deliverability evidence.

The strongest parts are the absence mechanics and state authority boundary. The weakest parts are month-scale artifact durability and verification blind spots: the gates pass while the capture bundle itself contains prose that should have failed a narrative quality gate.

```json
{
  "scores": {
    "product": 7,
    "async": 7,
    "narrative": 7,
    "ux": 7,
    "rigor": 7
  },
  "verdict": "fail",
  "summary": "asyncrpg has a real end-to-end loop and a credible deterministic simulation, with materially strong absence handling and model/state separation. It is not yet professionally shippable because months-long chronicle/recap behavior is truncated, real inbox deliverability remains unproven, and live generated narration still includes an editor-artifact fragment that the current gates missed.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "narrative",
      "title": "Live narration still contains model/editor artifact",
      "detail": "live-capture/generated-narration.txt tick 4 and live-capture/chronicle-demo.html.txt show `// wait, remove that fragment.` in public prose. src/dm/narrate.ts:167-217 normalizes fences and slash-n/t artifacts and detects punctuation splices, but does not reject editor asides like this. Done means live prose validation catches and falls back or repairs this class, the demo chronicle is clean, and the smoke gate asserts it."
    },
    {
      "severity": "blocker",
      "category": "product",
      "title": "Chronicle is not a full months-long artifact",
      "detail": "src/web/chronicle.ts:226-228 renders only the latest 25 beats; events, journals, and letters are also capped at small fixed limits in src/web/chronicle.ts:234-271. A daily or active campaign loses navigable public access to older play within weeks, which undercuts the promised durable chronicle. Done means paginated or chaptered access to the complete campaign history, with no-JS rendering preserved."
    },
    {
      "severity": "major",
      "category": "async",
      "title": "Long-absence recaps are bounded by recent DO history",
      "detail": "src/campaign-do.ts:591 stores only the last 400 events, and src/sim/character.ts:265-275 builds recaps only from the supplied history. A player returning after a very long absence can receive an incomplete recap even though the promise says return any time with a recap. Done means recaps are built from the durable D1 chronicle or another complete per-campaign event source, with tests beyond the retained-history window."
    },
    {
      "severity": "major",
      "category": "ux",
      "title": "Primary email channel lacks real mailbox deliverability proof",
      "detail": "live-capture/email-e2e-output.txt explicitly says Gmail/Outlook spam handling is still not covered, and docs/deliverability.md records Gmail and Outlook results as pending. Since sign-in and play are email-first, this is a launch risk for nontechnical users. Done means seed-list tests or documented manual checks for Gmail and Outlook, including placement, latency, and DKIM/SPF/DMARC evidence."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Verification gates missed a visible production-quality defect",
      "detail": "live-capture/smoke-output.txt passes chronicle corruption checks, but the same capture bundle contains the `// wait, remove that fragment.` artifact. The harness checks code fences, escape sequences, and splice patterns, but not meta/editorial asides. Done means the live-capture smoke suite fails on this exact artifact class and similar model self-corrections before a critic sees them."
    },
    {
      "severity": "minor",
      "category": "product",
      "title": "Cadence and quorum are not changeable after creation",
      "detail": "public/index.html:97-102 and src/index.ts:242-270 support cadence only at campaign creation; quorum_fraction exists in migrations/0001_init.sql:18-20 and CampaignInit, but there is no host UI/API to edit cadence or quorum mid-campaign. The spec says cadence is changeable and quorum configurable. Done means host controls and tests for updating cadence/quorum without breaking existing alarms."
    }
  ]
}
```
