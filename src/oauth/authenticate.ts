import type { Db } from "../db/client";
import { timingSafeCompare } from "./crypto";
import { verifyAccessToken, type TokenIdentity } from "./store";

/**
 * One place that decides whether a request is authenticated, used by both the
 * REST API and the MCP endpoint so they cannot drift apart.
 *
 * Two credential types are accepted:
 *
 *  - the static `API_TOKEN`, which the board's own browser code and the CLI
 *    check scripts use;
 *  - an OAuth access token issued through /oauth/token, which is what Claude
 *    custom connectors use.
 *
 * The requirement rule is unchanged from before OAuth existed: a credential is
 * required only when `API_TOKEN` is set. That keeps local development and the
 * test suite open by default while production stays closed.
 */

export type AuthResult =
  | { ok: true; identity: TokenIdentity | { kind: "anonymous"; scope: string } }
  | { ok: false; reason: "missing" | "invalid" };

export function extractBearer(headers: Record<string, string | undefined>): string | undefined {
  const header = headers.authorization;
  if (header && /^bearer\s+/i.test(header)) {
    const value = header.replace(/^bearer\s+/i, "").trim();
    if (value) return value;
  }
  const alternative = headers["x-api-token"]?.trim();
  return alternative || undefined;
}

export async function authenticate(
  headers: Record<string, string | undefined>,
  options: { db?: Db; env?: NodeJS.ProcessEnv } = {},
): Promise<AuthResult> {
  const env = options.env ?? process.env;
  const staticToken = env.API_TOKEN;
  const presented = extractBearer(headers);

  if (!presented) {
    // No credential. Only an error if this deployment requires one.
    if (!staticToken) return { ok: true, identity: { kind: "anonymous", scope: "board:read board:write" } };
    return { ok: false, reason: "missing" };
  }

  if (staticToken && timingSafeCompare(presented, staticToken)) {
    return { ok: true, identity: { kind: "static", scope: "board:read board:write" } };
  }

  const oauthIdentity = await verifyAccessToken(presented, { db: options.db });
  if (oauthIdentity) return { ok: true, identity: oauthIdentity };

  // A credential was presented and it is not usable. Say so even on an open
  // deployment: silently ignoring a bad token hides expiry from the client.
  return { ok: false, reason: "invalid" };
}
