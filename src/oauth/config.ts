/**
 * Authorization server configuration and route constants.
 */

/** Scopes this server understands. Both are granted together — see below. */
export const SCOPES = ["board:read", "board:write"] as const;
export const DEFAULT_SCOPE = SCOPES.join(" ");

/** Authorization codes are exchanged immediately; a short life limits replay. */
export const CODE_TTL_SECONDS = 120;
/** Access tokens last a day; the client refreshes silently. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24;
/** Refresh tokens last 90 days and are rotated on every use. */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;

export const OAUTH_ROUTES = {
  protectedResourceMetadata: "/.well-known/oauth-protected-resource",
  authorizationServerMetadata: "/.well-known/oauth-authorization-server",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  register: "/oauth/register",
  revoke: "/oauth/revoke",
} as const;

/** The MCP endpoint these tokens are audience-scoped to. */
export const MCP_PATH = "/api/mcp";

/**
 * Does a request path belong to the authorization server?
 *
 * These paths must never sit behind the static API token, or a client could
 * never authenticate in the first place.
 */
export function isOAuthPath(path: string): boolean {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized.startsWith("/oauth/")) return true;
  // Clients may append the resource path, e.g.
  // /.well-known/oauth-protected-resource/api/mcp
  return (
    normalized === OAUTH_ROUTES.protectedResourceMetadata ||
    normalized.startsWith(OAUTH_ROUTES.protectedResourceMetadata + "/") ||
    normalized === OAUTH_ROUTES.authorizationServerMetadata ||
    normalized.startsWith(OAUTH_ROUTES.authorizationServerMetadata + "/")
  );
}

/**
 * Absolute base URL of this deployment, taken from the request.
 *
 * The issuer in OAuth metadata must match the host the client actually used, so
 * it cannot be hard-coded — the same code serves localhost, the vercel.app
 * domain and any custom domain added later. `x-forwarded-proto` is what Vercel
 * sets in front of the function.
 */
export function resolveBaseUrl(
  headers: Record<string, string | undefined>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");

  const forwardedHost = headers["x-forwarded-host"];
  const host = (forwardedHost || headers.host || "localhost").split(",")[0]?.trim() ?? "localhost";
  const forwardedProto = headers["x-forwarded-proto"]?.split(",")[0]?.trim();
  const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return proto + "://" + host;
}
