Fail. The foundations are real, especially the deterministic sim and absence mechanics, but this is not professionally shippable yet.

```json
{
  "scores": {
    "product": 6,
    "async": 7,
    "narrative": 7,
    "ux": 6,
    "rigor": 6
  },
  "verdict": "fail",
  "summary": "asyncrpg has a credible deterministic simulation, a working solo web loop, good mobile basics, strong mechanical absence handling, and genuinely readable model narration. It is not yet a shippable asynchronous multiplayer RPG: group onboarding is incomplete, the email path is not end-to-end proven, stale email replies can submit current actions, the model still writes a scene field into canonical state, and the verification bundle contains a nonzero smoke failure.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "product",
      "title": "No shippable multiplayer onboarding",
      "detail": "The UI only lists existing memberships and creates solo campaigns (`public/app.js:78`, `public/app.js:102`, `public/app.js:219`), while `/join` is a backend-only route that any signed-in user with a slug can call before membership checks (`src/index.ts:223`). Done means hosts can invite players from the app/email, invitees can join without API knowledge, and join authorization is explicit rather than open-by-slug."
    },
    {
      "severity": "blocker",
      "category": "product",
      "title": "Primary email loop is not production-proven or retried",
      "detail": "The live email capture explicitly does not cover the inbound SMTP hop (`live-capture/email-e2e-output.txt:22`), and outbound send failure is logged and dropped without retry (`src/email/outbound.ts:118`). Done means a real inbound delivery test or equivalent operational proof exists, failed sends are retried/backed off, and players/hosts can see delivery failures."
    },
    {
      "severity": "blocker",
      "category": "narrative",
      "title": "Narrator still writes canonical scene state",
      "detail": "The central claim says the model has no state authority, but `resolveTick` writes `beat.situation` back into `result.state.scene.situation` (`src/campaign-do.ts:344`). `beat.situation` comes from model output when narration succeeds (`src/dm/narrate.ts:227`). Done means model-written scene text is kept in the read-model/beat only, or is deterministically derived/validated before becoming canonical world state."
    },
    {
      "severity": "major",
      "category": "async",
      "title": "Stale email reply replay defense is missing",
      "detail": "Inbound email looks up a binding with a stored `tick` (`src/email/inbound.ts:31`) but never checks that tick against the campaign's current or next tick before submitting (`src/email/inbound.ts:151`). Done means old replies are rejected or handled as explicit late context, with tests proving current/next acceptance and stale replay rejection."
    },
    {
      "severity": "major",
      "category": "async",
      "title": "A deterministic invariant failure can wedge a campaign",
      "detail": "If `checkWorldInvariants` fails, the DO rolls back and throws (`src/campaign-do.ts:336`), so the same alarm/manual resolve can retry the same deterministic bad tick forever. Done means invariant failures degrade to a safe no-op/admin-visible blocked state, or the tick records an error beat and schedules recovery without silently wedging the campaign."
    },
    {
      "severity": "major",
      "category": "async",
      "title": "Absence still has a visible progression/status penalty",
      "detail": "Active characters can gain renown while absent characters do not (`src/sim/actions.ts:283`), and the UI displays `known N/100` beside each party member (`public/app.js:176`). Done means renown is either not framed as a comparable progression score, absence recaps/re-entry avoid social demotion, or the product explicitly changes the no-progression-axis promise."
    },
    {
      "severity": "major",
      "category": "narrative",
      "title": "Chronicle is not yet a durable months-long artifact",
      "detail": "The captured prose is often good (`live-capture/generated-narration.txt:8`), but the turning-points section is dominated by tick-0 floods and repeated revolt/death lines (`live-capture/generated-narration.txt:82`). Done means the chronicle curates, groups, filters, and links events so it reads as campaign history rather than an unedited significance log."
    },
    {
      "severity": "major",
      "category": "product",
      "title": "Claimed v1 depth features are placeholders",
      "detail": "The schema has downtime, letters, and journals (`migrations/0001_init.sql:127`), but the app/API search shows only main turn submission and chronicle routes. Done means either implement these play surfaces end to end or remove them from v1/ship claims until they exist."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Verification harness is not green",
      "detail": "The production smoke bundle exits nonzero with 37/39 checks passing (`live-capture/smoke-output.txt:31`, `live-capture/smoke-output.txt:50`). The auth code likely treats forged cookies as anonymous on `/api/me`, but the gate and product expectation disagree. Done means the deployed smoke is green, or the adversarial check is rewritten to assert the intended anonymous behavior without hiding real auth bypasses."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Projection failures can erase the public chronicle with no repair path",
      "detail": "Beat, event, and entity projection failures are swallowed as recoverable (`src/campaign-do.ts:454`, `src/campaign-do.ts:487`), but there is no visible reconciliation job or operator alert. Done means D1 projection failures are observable and replayable from DO canonical state, so the public chronicle cannot silently diverge for a campaign."
    },
    {
      "severity": "minor",
      "category": "ux",
      "title": "First-run experience is too sparse for non-technical groups",
      "detail": "The mobile screenshots are readable and accessible, but first run only covers sign-in/create/submit; it does not explain inviting others, joining an existing campaign, email replies, or what happens after absence. Done means the first session includes host invite actions, clear join affordances, and email-oriented guidance without requiring documentation."
    }
  ]
}
```
