import type { ApiContext, ApiRequest, ApiResponse } from "../http/handlers";
import { OAUTH_ROUTES, DEFAULT_SCOPE, resolveBaseUrl } from "./config";
import { timingSafeCompare } from "./crypto";
import { authorizationServerMetadata, protectedResourceMetadata } from "./metadata";
import { renderAuthorizePage, renderErrorPage } from "./page";
import {
  consumeAuthorizationCode,
  createAuthorizationCode,
  findClient,
  registerClient,
  revokeToken,
  rotateRefreshToken,
  issueTokens,
  verifyClientSecret,
} from "./store";
import { verifyPkce } from "./crypto";

/**
 * The authorization server (RFC 6749 + 7591 + 7636 + 8414 + 9728), scoped to
 * exactly what an MCP client needs.
 *
 * There are no user accounts. Authorization is a single shared password held in
 * BOARD_PASSWORD; what OAuth buys over the old static bearer token is that
 * Claude can actually complete the flow, and that access becomes per-client and
 * revocable instead of one secret shared by everything.
 */

const JSON_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };

function json(status: number, body: unknown, headers: Record<string, string> = {}): ApiResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body };
}

function html(status: number, markup: string): ApiResponse {
  return {
    status,
    headers: { "Cache-Control": "no-store" },
    body: null,
    text: markup,
    contentType: "text/html; charset=utf-8",
  };
}

function redirect(location: string): ApiResponse {
  return {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
    body: null,
    text: "",
    contentType: "text/plain; charset=utf-8",
  };
}

/** An OAuth error response at the token/registration endpoints. */
function oauthError(status: number, error: string, description: string): ApiResponse {
  return json(status, { error, error_description: description });
}

/** An OAuth error handed back to the client via the redirect URI. */
function redirectError(redirectUri: string, error: string, description: string, state?: string): ApiResponse {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}

function methodNotAllowed(allowed: string[]): ApiResponse {
  return json(405, { error: "invalid_request", error_description: "Allowed: " + allowed.join(", ") }, {
    Allow: allowed.join(", "),
  });
}

/**
 * Read a form-encoded or JSON body.
 *
 * The shape of the payload decides, not the declared content type: a hosting
 * platform may pre-parse a form body and hand it back re-serialised, so trusting
 * the header alone is how form fields silently arrive empty.
 */
function parseBody(req: ApiRequest): URLSearchParams {
  const raw = req.rawBody ?? "";
  const trimmed = raw.trim();

  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) params.set(key, String(value));
      }
      return params;
    } catch {
      /* not JSON after all; fall through */
    }
  }

  return new URLSearchParams(raw);
}

/** Client credentials may arrive in the body or as HTTP Basic. */
function clientCredentials(req: ApiRequest, body: URLSearchParams): { id?: string; secret?: string } {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        return {
          id: decodeURIComponent(decoded.slice(0, separator)),
          secret: decodeURIComponent(decoded.slice(separator + 1)),
        };
      }
    } catch {
      /* fall through to the body */
    }
  }
  return { id: body.get("client_id") ?? undefined, secret: body.get("client_secret") ?? undefined };
}

/**
 * A redirect URI must be an exact match against what the client registered, and
 * must not be something that could execute in a browser.
 */
function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "javascript:" || scheme === "data:" || scheme === "vbscript:" || scheme === "file:") return false;
  if (scheme === "http:") {
    // Plain HTTP only for loopback, which is how native clients receive codes.
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export async function handleOAuth(req: ApiRequest, ctx: ApiContext = {}): Promise<ApiResponse> {
  const env = ctx.env ?? process.env;
  const baseUrl = resolveBaseUrl(req.headers, env);
  const path = req.path.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();

  if (method === "OPTIONS") return { status: 204, headers: {}, body: null };

  // Discovery. Clients may append the resource path to the well-known URL.
  if (path === OAUTH_ROUTES.protectedResourceMetadata || path.startsWith(OAUTH_ROUTES.protectedResourceMetadata + "/")) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
    return json(200, protectedResourceMetadata(baseUrl));
  }
  if (
    path === OAUTH_ROUTES.authorizationServerMetadata ||
    path.startsWith(OAUTH_ROUTES.authorizationServerMetadata + "/")
  ) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
    return json(200, authorizationServerMetadata(baseUrl));
  }

  if (path === OAUTH_ROUTES.register) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleRegister(req, ctx);
  }

  if (path === OAUTH_ROUTES.authorize) {
    if (method === "GET") return handleAuthorizeGet(req, ctx);
    if (method === "POST") return handleAuthorizePost(req, ctx);
    return methodNotAllowed(["GET", "POST"]);
  }

  if (path === OAUTH_ROUTES.token) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleToken(req, ctx);
  }

  if (path === OAUTH_ROUTES.revoke) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleRevoke(req, ctx);
  }

  return json(404, { error: "invalid_request", error_description: "No such OAuth endpoint: " + req.path });
}

/* -------------------------------------------------------------------------- */
/* Dynamic Client Registration (RFC 7591)                                     */
/* -------------------------------------------------------------------------- */

async function handleRegister(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(req.rawBody || "{}") as Record<string, unknown>;
  } catch {
    return oauthError(400, "invalid_client_metadata", "Request body must be JSON.");
  }

  const redirectUris = payload.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris is required and must be a non-empty array.");
  }
  if (!redirectUris.every((uri): uri is string => typeof uri === "string" && isAcceptableRedirectUri(uri))) {
    return oauthError(
      400,
      "invalid_redirect_uri",
      "Every redirect_uri must be an absolute URL. Plain http is only allowed for loopback addresses.",
    );
  }

  const requestedMethod = typeof payload.token_endpoint_auth_method === "string"
    ? payload.token_endpoint_auth_method
    : "client_secret_post";
  if (!["client_secret_post", "client_secret_basic", "none"].includes(requestedMethod)) {
    return oauthError(400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method: " + requestedMethod);
  }

  const grantTypes = Array.isArray(payload.grant_types)
    ? payload.grant_types.filter((g): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token"];
  const unsupported = grantTypes.filter((g) => g !== "authorization_code" && g !== "refresh_token");
  if (unsupported.length > 0) {
    return oauthError(400, "invalid_client_metadata", "Unsupported grant_types: " + unsupported.join(", "));
  }

  const client = await registerClient(
    {
      redirectUris,
      clientName: typeof payload.client_name === "string" ? payload.client_name : undefined,
      grantTypes,
      tokenEndpointAuthMethod: requestedMethod,
      scope: typeof payload.scope === "string" && payload.scope.trim() ? payload.scope : DEFAULT_SCOPE,
    },
    { db: ctx.db },
  );

  return json(201, {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope,
  });
}

/* -------------------------------------------------------------------------- */
/* Authorization endpoint                                                     */
/* -------------------------------------------------------------------------- */

interface AuthorizeParams {
  responseType: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
  state: string;
  resource: string;
}

function readAuthorizeParams(source: URLSearchParams): AuthorizeParams {
  return {
    responseType: source.get("response_type") ?? "",
    clientId: source.get("client_id") ?? "",
    redirectUri: source.get("redirect_uri") ?? "",
    codeChallenge: source.get("code_challenge") ?? "",
    codeChallengeMethod: source.get("code_challenge_method") ?? "",
    scope: source.get("scope") ?? DEFAULT_SCOPE,
    state: source.get("state") ?? "",
    resource: source.get("resource") ?? "",
  };
}

function hiddenFields(params: AuthorizeParams): Record<string, string> {
  return {
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    scope: params.scope,
    state: params.state,
    resource: params.resource,
  };
}

/**
 * Validate everything that must be right before a password is even asked for.
 *
 * An invalid client_id or redirect_uri must NOT redirect (RFC 6749 §4.1.2.1) —
 * redirecting to an unverified URI is how open redirectors happen. Those render
 * an error page instead.
 */
async function validateAuthorize(params: AuthorizeParams, ctx: ApiContext) {
  if (!params.clientId) {
    return { fatal: html(400, renderErrorPage("Missing client", "No client_id was supplied.")) };
  }

  const client = await findClient(params.clientId, { db: ctx.db });
  if (!client) {
    return {
      fatal: html(
        400,
        renderErrorPage(
          "Unknown client",
          "This client is not registered with the status board. If the connector was set up a long time ago, remove and re-add it so it can register again.",
        ),
      ),
    };
  }

  if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) {
    return {
      fatal: html(
        400,
        renderErrorPage(
          "Invalid redirect URI",
          "The redirect_uri does not exactly match one registered by this client, so the request was refused.",
        ),
      ),
    };
  }

  // From here on the redirect URI is trusted, so errors can go back to the client.
  if (params.responseType !== "code") {
    return {
      client,
      recoverable: redirectError(
        params.redirectUri,
        "unsupported_response_type",
        "Only response_type=code is supported.",
        params.state,
      ),
    };
  }
  if (!params.codeChallenge) {
    return {
      client,
      recoverable: redirectError(
        params.redirectUri,
        "invalid_request",
        "PKCE is required: code_challenge is missing.",
        params.state,
      ),
    };
  }
  if (params.codeChallengeMethod !== "S256") {
    return {
      client,
      recoverable: redirectError(
        params.redirectUri,
        "invalid_request",
        "code_challenge_method must be S256.",
        params.state,
      ),
    };
  }

  return { client };
}

async function handleAuthorizeGet(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  const params = readAuthorizeParams(req.query);
  const validation = await validateAuthorize(params, ctx);
  if (validation.fatal) return validation.fatal;
  if (validation.recoverable) return validation.recoverable;

  if (!(ctx.env ?? process.env).BOARD_PASSWORD) {
    return html(
      503,
      renderErrorPage(
        "Not configured",
        "This board has no BOARD_PASSWORD set, so authorization cannot be granted. Set it in the deployment's environment variables and try again.",
      ),
    );
  }

  return html(200, renderAuthorizePage({ fields: hiddenFields(params), clientName: validation.client?.clientName }));
}

async function handleAuthorizePost(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  const body = parseBody(req);
  const params = readAuthorizeParams(body);
  const validation = await validateAuthorize(params, ctx);
  if (validation.fatal) return validation.fatal;
  if (validation.recoverable) return validation.recoverable;

  const expected = (ctx.env ?? process.env).BOARD_PASSWORD;
  if (!expected) {
    return html(
      503,
      renderErrorPage(
        "Not configured",
        "This board has no BOARD_PASSWORD set, so authorization cannot be granted.",
      ),
    );
  }

  const supplied = body.get("password") ?? "";
  if (!supplied || !timingSafeCompare(supplied, expected)) {
    // Re-render rather than redirect, so the attempt stays on this server and
    // the client learns nothing from a failed guess.
    return html(
      401,
      renderAuthorizePage({
        fields: hiddenFields(params),
        clientName: validation.client?.clientName,
        error: "That password is not correct.",
      }),
    );
  }

  const code = await createAuthorizationCode(
    {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      scope: params.scope || DEFAULT_SCOPE,
      resource: params.resource || undefined,
    },
    { db: ctx.db },
  );

  const target = new URL(params.redirectUri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);
  return redirect(target.toString());
}

/* -------------------------------------------------------------------------- */
/* Token endpoint                                                             */
/* -------------------------------------------------------------------------- */

async function handleToken(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  const body = parseBody(req);
  const grantType = body.get("grant_type") ?? "";
  const credentials = clientCredentials(req, body);

  if (!credentials.id) {
    return oauthError(401, "invalid_client", "client_id is required.");
  }
  if (!(await verifyClientSecret(credentials.id, credentials.secret, { db: ctx.db }))) {
    return oauthError(401, "invalid_client", "Client authentication failed.");
  }

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(body, credentials.id, ctx);
  }
  if (grantType === "refresh_token") {
    const refreshToken = body.get("refresh_token") ?? "";
    if (!refreshToken) return oauthError(400, "invalid_request", "refresh_token is required.");

    const rotated = await rotateRefreshToken(refreshToken, credentials.id, { db: ctx.db });
    if (!rotated) return oauthError(400, "invalid_grant", "The refresh token is expired, revoked or unknown.");
    return tokenResponse(rotated);
  }

  return oauthError(
    400,
    "unsupported_grant_type",
    "Supported grant types: authorization_code, refresh_token.",
  );
}

async function handleAuthorizationCodeGrant(
  body: URLSearchParams,
  clientId: string,
  ctx: ApiContext,
): Promise<ApiResponse> {
  const code = body.get("code") ?? "";
  const redirectUri = body.get("redirect_uri") ?? "";
  const verifier = body.get("code_verifier") ?? "";

  if (!code) return oauthError(400, "invalid_request", "code is required.");
  if (!verifier) return oauthError(400, "invalid_request", "code_verifier is required (PKCE).");

  const consumed = await consumeAuthorizationCode(code, { db: ctx.db });
  if (!consumed.ok) {
    return oauthError(
      400,
      "invalid_grant",
      consumed.reason === "expired"
        ? "The authorization code has expired. Start the flow again."
        : "The authorization code is unknown or has already been used.",
    );
  }

  const record = consumed.code;
  if (record.clientId !== clientId) {
    return oauthError(400, "invalid_grant", "This authorization code was issued to a different client.");
  }
  if (redirectUri && redirectUri !== record.redirectUri) {
    return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (!verifyPkce(verifier, record.codeChallenge, record.codeChallengeMethod)) {
    return oauthError(400, "invalid_grant", "The PKCE code_verifier does not match the code_challenge.");
  }

  const issued = await issueTokens(
    { clientId, scope: record.scope, resource: record.resource },
    { db: ctx.db },
  );
  return tokenResponse(issued);
}

function tokenResponse(issued: {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}): ApiResponse {
  return json(200, {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: issued.scope,
  });
}

/* -------------------------------------------------------------------------- */
/* Revocation (RFC 7009)                                                      */
/* -------------------------------------------------------------------------- */

async function handleRevoke(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  const body = parseBody(req);
  const credentials = clientCredentials(req, body);
  const token = body.get("token") ?? "";

  if (!credentials.id) return oauthError(401, "invalid_client", "client_id is required.");
  if (!(await verifyClientSecret(credentials.id, credentials.secret, { db: ctx.db }))) {
    return oauthError(401, "invalid_client", "Client authentication failed.");
  }
  if (token) await revokeToken(token, { db: ctx.db });

  // RFC 7009: an unknown token is still a success, so callers cannot probe.
  return { status: 200, headers: JSON_HEADERS, body: {} };
}
