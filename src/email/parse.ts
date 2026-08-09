/**
 * Turning a reply into an action.
 *
 * People reply to email in every possible way: top-posting above a quote,
 * bottom-posting below one, with a signature, from a phone that quotes
 * everything, or by composing a fresh message with the subject rewritten. All
 * of that has to become one sentence of intent, and getting it wrong means a
 * player's turn is a quoted copy of the DM's own prose.
 *
 * Pure functions, no I/O.
 */

/** Marker embedded in outbound subjects: `[Ashfall #k7f2q9x] Tick 14 — ...` */
const SUBJECT_CODE = /\[[^\]]*#([a-z0-9]{6,16})\]/i;

export function codeFromSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const m = SUBJECT_CODE.exec(subject);
  return m?.[1]?.toLowerCase() ?? null;
}

export function buildSubject(campaignName: string, tick: number, code: string, headline: string): string {
  return `[${campaignName} #${code}] Tick ${tick} — ${headline}`;
}

/**
 * `In-Reply-To` and `References` can each hold one or more angle-bracketed
 * ids. We want every candidate, most recent first — `References` is ordered
 * oldest-to-newest, so the last entry is the message actually replied to.
 */
export function referencedMessageIds(headers: {
  inReplyTo?: string | null;
  references?: string | null;
}): string[] {
  const grab = (raw: string | null | undefined): string[] =>
    raw ? [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1]!).filter(Boolean) : [];

  const inReplyTo = grab(headers.inReplyTo);
  const references = grab(headers.references).reverse();
  return [...new Set([...inReplyTo, ...references])];
}

/** Lines that mean "everything below here is quoted history". */
const CUTOFFS: RegExp[] = [
  // "On Mon, 4 Aug 2026 at 09:12, Ashfall <dm@…> wrote:" — possibly wrapped
  // across two lines, so we also match a bare trailing "wrote:".
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  /^\s*.{0,120}\bwrote:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*From:\s*.+$/i,
  /^\s*Sent from my \w+/i,
  /^\s*Get Outlook for \w+/i,
  // Signature delimiter, RFC 3676: exactly "-- " (trailing space often eaten).
  /^--\s?$/,
];

/**
 * Strip quoted history, signatures, and client boilerplate from a reply.
 *
 * Two failure modes, and they pull in opposite directions:
 *
 * A player who bottom-posts *inside* the quote has written something, and
 * dropping it because the cutoff came first would silently eat their turn. So
 * when the simple pass finds nothing, we salvage every non-quote line from
 * anywhere in the message.
 *
 * But when there genuinely is nothing — a reply that is only a signature, an
 * out-of-office, or a bare quote of the DM's own prose — returning the
 * original text would submit "Sent from my iPhone" as that player's action.
 * That is worse than returning nothing: an empty result gets a clear "that
 * reply had no action in it" bounce, which the player can act on.
 */
export function stripQuotedReply(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const kept: string[] = [];
  for (const line of lines) {
    if (CUTOFFS.some((re) => re.test(line))) break;
    // Drop quoted lines wherever they appear; some clients interleave.
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }

  const cleaned = kept.join("\n").trim();
  if (cleaned.length > 0) return cleaned;

  // Everything before the first cutoff was empty. Recover any unquoted,
  // non-boilerplate prose from further down the message.
  const salvage = lines
    .filter((l) => !/^\s*>/.test(l) && !CUTOFFS.some((re) => re.test(l)))
    .join("\n")
    .trim();
  return salvage;
}

/** Address comparison that ignores case and any `+tag` on the local part. */
export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined): string | null => {
    if (!v) return null;
    const bare = /<([^>]+)>/.exec(v)?.[1] ?? v;
    const at = bare.lastIndexOf("@");
    if (at <= 0) return null;
    const local = bare.slice(0, at).trim().toLowerCase();
    const domain = bare.slice(at + 1).trim().toLowerCase();
    if (!local || !domain) return null;
    const plus = local.indexOf("+");
    return `${plus > 0 ? local.slice(0, plus) : local}@${domain}`;
  };
  const na = norm(a);
  const nb = norm(b);
  return na !== null && na === nb;
}

/** Local part of an address, lowercased — used to route per-campaign inboxes. */
export function localPart(address: string | null | undefined): string | null {
  if (!address) return null;
  const bare = /<([^>]+)>/.exec(address)?.[1] ?? address;
  const at = bare.lastIndexOf("@");
  if (at <= 0) return null;
  const local = bare.slice(0, at).trim().toLowerCase();
  return local.length > 0 ? local : null;
}

/**
 * One shared inbound address for every campaign.
 *
 * Per-campaign addresses (`rpg-<slug>@`) would read better, but Cloudflare
 * Email Routing matches rules on exact addresses, so each campaign would need
 * a rule created at runtime — which means shipping a zone-scoped Cloudflare
 * API token into the Worker. That is a large standing credential to hold for a
 * cosmetic gain.
 *
 * One address needs one rule, provisioned once, and costs nothing: a reply is
 * bound to its campaign by the threading header or subject code, and a fresh
 * mail from a player in a single campaign is unambiguous anyway.
 */
/**
 * Domains that can never accept mail, reserved by RFC 2606 and RFC 6761.
 *
 * Attempting delivery to one of these is not a risk of bouncing — it is a
 * guaranteed hard bounce, every time, by standard. And hard bounces are what
 * sender reputation is measured in: on 2026-08-03 this account reached an
 * 83.5% bounce rate and a "sending may be paused" warning, because the test
 * harnesses address their players at `@example.invalid` and the app dutifully
 * tried to deliver to all of them.
 *
 * The guard belongs here rather than in the harnesses. A typo'd signup, a
 * copy-pasted `user@example.com`, or a future test that forgets are all the
 * same shape, and the cost of any of them is the domain's ability to send
 * mail at all — which for this product is the product.
 */
const UNDELIVERABLE_TLDS = new Set(["invalid", "test", "example", "localhost"]);
const UNDELIVERABLE_DOMAINS = new Set(["example.com", "example.net", "example.org"]);

export function isUndeliverable(address: string | null | undefined): boolean {
  if (!address) return true;
  const bare = (/<([^>]+)>/.exec(address)?.[1] ?? address).trim().toLowerCase();
  const at = bare.lastIndexOf("@");
  if (at <= 0) return true;
  const domain = bare.slice(at + 1);
  if (!domain || domain.startsWith(".") || domain.endsWith(".")) return true;
  if (UNDELIVERABLE_DOMAINS.has(domain)) return true;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  // A bare hostname with no dot cannot be a public MX either.
  if (!domain.includes(".")) return true;
  return UNDELIVERABLE_TLDS.has(tld);
}

export const INBOX_LOCAL = "rpg";

export function isInboxAddress(local: string | null): boolean {
  if (!local) return false;
  return (local.split("+")[0] ?? local) === INBOX_LOCAL;
}
