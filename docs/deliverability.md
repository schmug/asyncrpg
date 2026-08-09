# Real-inbox deliverability

Everything up to the receiving provider is automated and proven on every cycle:
`scripts/email-e2e.mjs` drives a full two-zone round trip through real
Cloudflare Email Routing — outbound send, inbound delivery, handler execution,
accepted action, tick resolution — and `scripts/smoke.mjs` asserts SPF, DMARC,
and MX on every run.

What no self-test can reach is the last hop: whether Gmail, Outlook, or Yahoo
put the mail in the inbox or the spam folder. That is a judgement made inside
someone else's system, about a domain's reputation, and it needs real accounts
at those providers. This file records that manual check.

## How to run it

1. Sign in at <https://play.cortech.online> with a **Gmail** address.
2. Do the same with an **Outlook/Hotmail** address.
3. For each, record below: did the sign-in link arrive, how long did it take,
   and did it land in Inbox, Promotions/Other, or Spam?
4. If either lands in spam, the first thing to check is whether the message is
   DKIM-signed by `cortech.online` (Gmail: "Show original").

## Results

| Date | Provider | Address | Arrived | Time | Placement | Notes |
|---|---|---|---|---|---|---|
| _pending_ | Gmail | — | — | — | — | awaiting owner check |
| _pending_ | Outlook | — | — | — | — | awaiting owner check |

## Mitigations already in place, whatever the result

- **The turn is never lost to mail.** Every beat is readable in the web app;
  the email is a nudge, not the only copy.
- **Failed sends are recorded**, not just logged — `delivery_failures`, shown
  to the player they were owed to with the reassurance that the turn is safe.
- **The sign-in screen says what to do** when a link does not arrive: check
  spam, the exact sender address to whitelist (`dm@cortech.online`), ask for
  another link, and the corporate-mail dead end.
- **SPF, DMARC and MX are gated** in the smoke suite, so the records a receiver
  checks first cannot regress silently.
