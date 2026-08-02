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
 * Deliberately conservative in one direction: if stripping would leave nothing,
 * we return the original text rather than an empty action. A player who
 * bottom-posts inside the quote should still get a turn, even if what we
 * capture is messy — silence is the worse failure.
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

  // Everything was quote or signature. Recover whatever unquoted prose exists
  // anywhere in the message rather than returning nothing.
  const salvage = lines
    .filter((l) => !/^\s*>/.test(l) && !CUTOFFS.some((re) => re.test(l)))
    .join("\n")
    .trim();
  return salvage.length > 0 ? salvage : normalized.trim();
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
export const INBOX_LOCAL = "rpg";

export function isInboxAddress(local: string | null): boolean {
  if (!local) return false;
  return (local.split("+")[0] ?? local) === INBOX_LOCAL;
}
