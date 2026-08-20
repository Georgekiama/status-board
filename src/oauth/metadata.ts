import { MCP_PATH, OAUTH_ROUTES, SCOPES } from "./config";

/**
 * Discovery documents. These are what an MCP client fetches after a 401 in
 * order to find out how to authenticate.
 */

/** RFC 9728 — tells the client which authorization server guards this resource. */
export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: baseUrl + MCP_PATH,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SCOPES],
    resource_name: "Lit & More Status Board",
    resource_documentation: baseUrl + "/",
  };
}

/** RFC 8414 — the authorization server's own capabilities. */
export function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: baseUrl + OAUTH_ROUTES.authorize,
    token_endpoint: baseUrl + OAUTH_ROUTES.token,
    registration_endpoint: baseUrl + OAUTH_ROUTES.register,
    revocation_endpoint: baseUrl + OAUTH_ROUTES.revoke,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. `plain` gives no protection against a stolen code.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    service_documentation: baseUrl + "/",
  };
}

/**
 * The WWW-Authenticate value for a 401 from a protected resource.
 *
 * The `resource_metadata` parameter is the thread the whole flow hangs from: it
 * is how the client discovers where to authenticate. A bare `Bearer` challenge
 * (which is what this server sent before) leaves the client with nowhere to go,
 * which is why the connector could not register.
 */
export function challengeHeader(baseUrl: string, error?: string, description?: string): string {
  const parts = [
    'Bearer realm="status-board"',
    'resource_metadata="' + baseUrl + OAUTH_ROUTES.protectedResourceMetadata + '"',
  ];
  if (error) parts.push('error="' + error + '"');
  if (description) parts.push('error_description="' + description.replace(/"/g, "'") + '"');
  return parts.join(", ");
}
