```json
{
  "scores": { "product": 8, "async": 9, "narrative": 8, "ux": 7, "rigor": 7 },
  "verdict": "fail",
  "summary": "asyncrpg is a real product, not a README illusion: campaign creation, joining, web actions, email replies, deterministic ticks, public chronicle, absence handling, and model-bounded narration are all present and mostly credible. The absence promise is unusually well enforced in code, and the simulation has real typed state with compounding consequences. I would not ship it at professional quality yet because the reviewed release bundle contains a red test gate, the mail-first UX still lacks Gmail/Outlook deliverability evidence, and the security smoke checks miss that the actual app shell is served without the asserted CSP/X-Frame headers.",
  "requiredFixes": [
    {
      "severity": "blocker",
      "category": "rigor",
      "title": "Reviewed release has a failing test gate",
      "detail": "live-capture/gates.txt records `npm test` exiting nonzero on revision 2e9f5b7, with `test/email/token.test.ts:59` failing because 200 minted reply codes produced only 199 unique values. The implementation uses a 4-character nonce in `src/email/token.ts`, so the test is asserting a probabilistic property too strongly. Done means the reviewed revision has a green local test gate, and either the nonce/collision handling is strengthened or the test is rewritten to assert the real security property without random flake."
    },
    {
      "severity": "major",
      "category": "rigor",
      "title": "Security-header smoke tests the wrong surface",
      "detail": "live-capture/index.html.txt shows `/` has no CSP, no Referrer-Policy, and no X-Frame-Options, while `scripts/smoke.mjs` checks those headers on `/api/health` instead. The public chronicle has the hardened headers, but the actual app shell does not. Done means the static app shell is served with the same security headers, and the smoke gate asserts headers on `/`, `/c/demo`, and representative API responses."
    },
    {
      "severity": "major",
      "category": "ux",
      "title": "Mailbox deliverability is still unproven",
      "detail": "live-capture/email-e2e-output.txt proves a real two-zone Cloudflare round trip and confirms replies become turns, but it explicitly says Gmail/Outlook spam handling is not covered. Since sign-in and turn play are email-first, this is a shippability gap, not a nice-to-have. Done means seed-list or equivalent monitoring proves sign-in links, beat emails, and replies work acceptably through major consumer mailbox providers."
    },
    {
      "severity": "major",
      "category": "product",
      "title": "Mail capacity is not production-ready",
      "detail": "docs/DEPLOYMENT.md documents a real account-wide Cloudflare Email Sending quota failure: one 32-turn, 3-player seed run exhausted the daily allowance and blocked later beats and sign-in links. The app degrades honestly when delivery fails, but a mail-first game needs capacity sized for expected concurrent campaigns. Done means the quota is raised or enforced with admission limits, alerts, and operator-visible budget/capacity dashboards."
    },
    {
      "severity": "minor",
      "category": "narrative",
      "title": "Long chronicle samples remain repetitive",
      "detail": "live-capture/generated-narration.txt is readable and mostly faithful, but the Peirmarket sample repeats the same market texture, Bram/Kestrel rhythms, and partial-success phrasing across many turns. Done means multi-campaign live captures show stronger scene movement and consequence variety without loosening the rule that simulated facts are canon."
    }
  ]
}
```
