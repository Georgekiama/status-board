import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credential handling for the authorization server.
 *
 * Two rules, both deliberate:
 *
 *  - Nothing secret is stored in the clear. Client secrets, authorization codes
 *    and tokens are stored as SHA-256 hashes and looked up by hash, so the
 *    database never holds a usable credential.
 *  - Comparisons of secret material are timing-safe.
 *
 * SHA-256 rather than a password hash (bcrypt/argon2) is the right choice here:
 * these are long, high-entropy random strings, not user-chosen passwords, so
 * there is nothing to brute force and a slow KDF would only add latency. The one
 * human-chosen secret, BOARD_PASSWORD, is compared with timingSafeCompare and
 * never stored at all.
 */

/** URL-safe random string with ~192 bits of entropy. */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/** Stable, non-reversible lookup key for a credential. */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison that tolerates unequal lengths. */
export function timingSafeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(hashSecret(a), "hex");
  const bufferB = Buffer.from(hashSecret(b), "hex");
  // Hashing first makes both sides the same length, so timingSafeEqual cannot
  // throw and the comparison leaks nothing about the inputs' lengths.
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * Verify a PKCE code_verifier against a stored challenge (RFC 7636).
 *
 * Only S256 is accepted. The `plain` method offers no protection against an
 * intercepted authorization code, and every current MCP client supports S256.
 */
export function verifyPkce(verifier: string, challenge: string, method: string): boolean {
  if (method !== "S256") return false;
  // RFC 7636: 43-128 characters from the unreserved set.
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const expected = challenge.trim();
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}
