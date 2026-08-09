/**
 * Mint a session cookie for a player without going through the magic-link flow.
 *
 * Tests that exercise authorization need a signed-in request; making each one
 * round-trip an email is noise. This runs the *real* token path — mint, then
 * redeem — and only skips delivery. Nothing about verification is stubbed: the
 * cookie it returns is one `sessionFrom` has to accept on its own terms, and it
 * stops working the moment the auth rules change, which is the point.
 *
 * `mintLoginToken` writes an `auth_tokens` row that REFERENCES `players(id)`,
 * so the player must already exist. That is deliberate — a helper that
 * conjured a session for a nonexistent player would let a test assert
 * authorization against an identity production could never produce.
 */

import { mintLoginToken, redeemLoginToken, sessionCookie } from "../../src/auth";
import type { Env } from "../../src/env";

export async function mintSessionForTest(env: Env, playerId: string): Promise<string> {
  const login = await mintLoginToken(env, playerId);
  const session = await redeemLoginToken(env, login);
  if (!session) throw new Error(`could not mint a session for ${playerId} — is the player seeded?`);
  // `sessionCookie` returns a Set-Cookie value; a request needs just name=value.
  return sessionCookie(session).split(";")[0]!;
}
