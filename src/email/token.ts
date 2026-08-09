/**
 * The reply capability.
 *
 * Every beat carries a code that is unique to one (campaign, player, tick).
 * Replying with that code is what tells us which story, which character, and
 * which moment an action belongs to — so the code is a capability, and it has
 * to be unguessable and tamper-evident rather than merely unique.
 *
 * It is an HMAC over the triple it names, with a random nonce so that two
 * beats for the same triple never collide:
 *
 *     code = nonce(4) ‖ base32(HMAC-SHA256(secret, campaign|player|tick|nonce))(12)
 *
 * 16 Crockford-base32 characters, 80 bits, of which 60 are the tag. Guessing
 * one is infeasible; altering one to point at a different player or an earlier
 * tick invalidates the tag.
 *
 * ## Why the subject line carries it
 *
 * The design called for `Reply-To: rpg+<token>@…`, which is where a capability
 * belongs. Cloudflare Email Routing matches rules on exact addresses, and the
 * apex catch-all on this zone is already routed to an unrelated Worker, so a
 * plus-addressed reply would be delivered somewhere else entirely — and the
 * fix is a zone-level change that belongs to the domain's owner, not to this
 * app. Cloudflare Email Sending also rejects a caller-supplied `Message-ID`,
 * so threading ids cannot be chosen either.
 *
 * The subject code is the one carrier that survives every mail client's reply
 * without a zone change, so the capability rides there. It is a weaker place
 * to put a secret than an address — subjects are quoted in forwards and shown
 * in notifications — which is why possession of a code is never sufficient on
 * its own: `handleInboundEmail` also requires a DMARC-verified sender who is a
 * member of the bound campaign and is the player the binding names.
 */

/** Crockford base32: lowercase alphanumerics, no vowels, no ambiguous glyphs. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const NONCE_CHARS = 4;
const TAG_CHARS = 12;
export const REPLY_CODE_CHARS = NONCE_CHARS + TAG_CHARS;

function base32(bytes: Uint8Array, chars: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  return out;
}

function payload(binding: ReplyBinding, nonce: string): string {
  return `${binding.campaignId}|${binding.playerId}|${binding.tick}|${nonce}`;
}

async function tag(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return base32(new Uint8Array(mac), TAG_CHARS);
}

export interface ReplyBinding {
  campaignId: string;
  playerId: string;
  tick: number;
}

/**
 * Mint the code for one beat.
 *
 * With no secret configured — local dev, CI — the code is still 80 random
 * bits, so it is still unguessable; it simply cannot be verified later. That
 * degrades the check, never the delivery.
 */
export async function mintReplyCode(
  secret: string | undefined,
  binding: ReplyBinding,
): Promise<string> {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  if (!secret) return base32(random, REPLY_CODE_CHARS);
  const nonce = base32(random, NONCE_CHARS);
  return nonce + (await tag(secret, payload(binding, nonce)));
}

/**
 * Does this code authenticate the binding it was looked up by?
 *
 * Codes minted before this scheme existed, and codes minted while no secret
 * was configured, cannot be verified. Rejecting them would invalidate every
 * beat already in someone's inbox, so they are accepted on the strength of the
 * stored binding alone — the position this code has always been in — and age
 * out with their 90-day expiry. When a secret is configured and the code has
 * the current shape, the tag must check out.
 */
export async function verifyReplyCode(
  secret: string | undefined,
  code: string,
  binding: ReplyBinding,
): Promise<boolean> {
  if (!secret) return true;
  if (code.length !== REPLY_CODE_CHARS) return true;
  const expected = await tag(secret, payload(binding, code.slice(0, NONCE_CHARS)));
  const actual = code.slice(NONCE_CHARS);
  // Length is fixed by construction, so a constant-time compare over the tag
  // is enough; it leaks nothing about how much of a guess was right.
  let diff = 0;
  for (let i = 0; i < TAG_CHARS; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}
