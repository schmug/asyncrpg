# Deployment, and the settings that are not the app's to change

asyncrpg runs as a single Cloudflare Worker on `play.cortech.online`, with mail
on the `cortech.online` apex. Some of its production posture is decided by zone
settings rather than by code. Those are listed here so the difference between
"the app is wrong" and "the zone is configured this way" is always checkable.

## Deploying

```bash
npm run deploy
```

That is `wrangler deploy --var GIT_REVISION:$(git rev-parse HEAD)`. The
revision is reported by `/api/health` and asserted by `scripts/smoke.mjs`, so
any review can prove which commit is actually serving traffic. **Deploy from a
committed tree** — a deployment whose revision is not in git makes every later
comparison meaningless.

Allow ~25 seconds for propagation before testing. Testing immediately after a
deploy has produced false failures more than once.

Then re-verify:

```bash
npm test && npm run typecheck && node scripts/smoke.mjs https://play.cortech.online
```

## Secrets

Set with `wrangler secret put`, never committed:

| Secret | Effect if unset |
|---|---|
| `ANTHROPIC_API_KEY` | Narration degrades to templated sim prose. Ticks still resolve. |
| `EMAIL_TOKEN_SECRET` | Reply codes are still 80 random bits, but cannot be verified. |
| `AUTH_TOKEN_SECRET` | Magic-link sessions fall back to the default derivation. |

## Zone settings the app cannot fix — owner's call

These are deviations between what the app asks for and what the edge serves.
`scripts/smoke.mjs` gates them: a **known** deviation passes with a loud note,
an **undocumented** one fails the suite.

### 1. HSTS — enabled at the zone, shorter than the app asks for

**Resolved 2026-08-02.** The owner enabled HSTS. Production now serves
`max-age=2592000; includeSubDomains; preload` (30 days).

The app's own header asks for `max-age=31536000` (one year), and the zone
setting wins — so the two still differ on paper. That is fine and deliberate:
30 days with `includeSubDomains` is the cautious ramp, because HSTS cannot be
withdrawn quickly once browsers have cached it.

The smoke suite therefore asserts the **property**, not the string: HSTS must
be present with `max-age` of at least 30 days and must cover subdomains. A
zero max-age is a hard failure. It used to pass as "known documented drift",
which is exactly how a disabled security header survives three review cycles.

If the zone is later raised to a full year, nothing needs to change here — the
gate already accepts it, and `preload` submission requires it.

### 2. Cloudflare Web Analytics auto-injection

- The zone rewrites a beacon script into every HTML response at the edge.
- Under a strict `script-src 'self'` the browser blocks it on every page load,
  which permanently reddens the console-error gate and makes it useless for
  catching real errors.
- The app therefore allows exactly two Cloudflare-owned hosts in its CSP
  (`static.cloudflareinsights.com`, `cloudflareinsights.com`) — the narrowest
  fix available from inside the app.
- **To tighten:** Cloudflare dashboard → Analytics → Web Analytics → disable
  automatic setup for `play.cortech.online`. The CSP entries can then be
  removed.

### 3. Email Routing and Email Sending are Dashboard-only

Subdomains cannot be onboarded to either via API. `cortech.online` (mail) and
`q-r.contact` (the loopback used to prove the inbound hop) were onboarded by
hand. Email Routing matches rules on **exact** addresses, and the apex
catch-all is routed to an unrelated Worker — which is why the reply capability
rides the subject line rather than a plus-addressed `Reply-To`. See
`src/email/token.ts`.

## What cannot be self-tested

Deliverability and spam placement at third-party mailboxes (Gmail, Outlook,
Yahoo) cannot be measured from inside this system. `scripts/email-e2e.mjs`
proves the full two-zone round trip through real Cloudflare Email Routing —
outbound send, inbound delivery, handler execution, accepted action, tick
resolution — which is everything up to the receiving provider's own filtering.

What the app does instead of guessing: authentication records are asserted in
the smoke suite, per-recipient send failures are recorded and surfaced in-app
rather than logged and forgotten, and every beat is readable on the web whether
or not its mail arrived. See `docs/specs/2026-08-02-asyncrpg-design.md` §7.
