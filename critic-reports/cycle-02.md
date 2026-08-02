```json
{
  "scores": { "product": 7, "async": 6, "narrative": 6, "ux": 6, "rigor": 7 },
  "verdict": "fail",
  "summary": "asyncrpg has a real deterministic simulation, a working web loop, invite-based joining, public chronicles, and serious tests. It is not yet professionally shippable: the primary email channel is not live-proven end to end, absence still creates social/progression gaps through renown and bonds, narrative quality has production-visible defects, and several operational/security claims are softer than the spec.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "product",
      "title": "Primary email loop is not proven end to end",
      "detail": "live-capture/email-e2e-output.txt explicitly says the inbound SMTP hop is not covered; scripts/email-e2e.mjs:14-23 documents the same gap. Done means a production capture proves outbound beat delivery, user reply through Cloudflare Email Routing, inbound handler execution, accepted action, tick resolution, and resulting fan-out/chronicle update."
    },
    {
      "severity": "blocker",
      "category": "async",
      "title": "No-penalty promise is not absolute",
      "detail": "Active play and downtime still accumulate social/progression advantages: action success changes character renown in src/sim/actions.ts:283-290, downtime train raises renown and network raises bonds/attitudes in src/sim/downtime.ts:95-113. A 30-tick absent player avoids stat loss, but returns socially behind. Done means either remove these as progression axes, add robust catch-up/normalization, or narrow the product promise honestly."
    },
    {
      "severity": "major",
      "category": "async",
      "title": "Tick-always-resolves claim has an exception path",
      "detail": "If invariants fail, src/campaign-do.ts:389-409 rolls back, clears pending, returns source='blocked', and leaves the tick unchanged. If deterministic world drift caused the violation, future alarms can repeat the same failed computation. Done means every alarm advances canon or records a sim-failure beat while safely quarantining the bad rule/input."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Reply authentication diverges from spec-grade HMAC binding",
      "detail": "The spec requires an HMAC Reply-To token, but implementation uses reply_bindings plus Message-ID/subject code, and even accepts fresh mail from a one-campaign player in src/email/inbound.ts:100-120. Done means implement a cryptographic per-player per-tick reply capability, or prove the replacement resists spoofing, replay, forwarding, and ambiguity at the same standard."
    },
    {
      "severity": "major",
      "category": "narrative",
      "title": "Production narration has visible corruption and awkward canon lines",
      "detail": "live-capture/generated-narration.txt and chronicle-demo.html.txt contain 'he'd finished.732', duplicated names such as 'Bram Ashfoot Bram...', lower-case character names, and templated fallback that reads like a changelog. Done means validators catch numeric/splice artifacts, action summaries are grammatically normalized before persistence, and a golden capture demonstrates clean multi-turn prose."
    },
    {
      "severity": "major",
      "category": "narrative",
      "title": "Simulation is real but not yet months-quality",
      "detail": "The sim has typed entities and compounding effects, but the demo chronicle shows inflated settlements, many dead NPC dossier cards, factions saturated at power/treasury 100, and generic events. Done means long-run tuning, dossier pruning/curation, and multi-campaign captures where the chronicle reads like a memorable campaign rather than mostly generated ledger state."
    },
    {
      "severity": "major",
      "category": "ux",
      "title": "Mobile app surface is too thin for the claimed PWA",
      "detail": "The captured campaign view shows prompt, quorum, party, invite, and side forms, but not the latest beat, real character sheet, world dossiers, map summary, or meaningful return recap in-app. public/index.html:104-195 and public/app.js:139-200 confirm the limited surface. Done means a non-technical player can understand current canon, their character, party state, and consequences without jumping to a separate chronicle."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Cost controls are incomplete and fail open",
      "detail": "src/campaign-do.ts:148-181 checks only output_tokens, defaults to allowing spend on budget-table failure, and I found no implemented global kill switch despite the spec. Done means input plus output budgets, a real global inference disable, abuse/rate limits on auth and actions, and observable budget failures that degrade to templated narration."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Chronicle projection can silently lose canon",
      "detail": "Projection writes in src/campaign-do.ts:531-575 and 595-605 swallow D1 failures, while reproject only restores current entities and recent in-DO history. A public chronicle can drift from canonical DO state without alerting. Done means durable projection retry/audit, visible degraded state, and full replay or sufficient retained event history to rebuild the public artifact."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Live security headers do not match intent",
      "detail": "src/index.ts:43-65 sets HSTS max-age=31536000, but live-capture/health.txt and chronicle-demo.html.txt show strict-transport-security: max-age=0. Done means production headers match policy, are gated in smoke tests, and any Cloudflare override is fixed or explicitly documented."
    },
    {
      "severity": "minor",
      "category": "product",
      "title": "Revision-to-deployment provenance is weak",
      "detail": "live-capture/gates.txt names revision 4135360, but the deployment list only shows opaque Worker versions with no commit tag. Done means capture includes a deployed build identifier or endpoint proving the running Worker corresponds to the revision under review."
    }
  ]
}
```
