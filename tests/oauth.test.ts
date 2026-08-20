/**
 * The authorization server.
 *
 * Claude custom connectors cannot use a static bearer token: on a 401 they follow
 * the MCP authorization spec and expect discovery metadata, dynamic client
 * registration and an authorization-code exchange. These tests drive that whole
 * flow over real HTTP, and then try to break it.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { oauthTokens } from "../src/db/schema";
import { startNodeServer, type RunningServer } from "../src/http/node-server";
import { hashSecret, verifyPkce } from "../src/oauth/crypto";
import { createTestDb, labelledBoard, type TestDb } from "./helpers";

const PASSWORD = "correct-horse-battery-staple";
const STATIC_TOKEN = "static-token-for-cli";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

let ctx: TestDb;
let server: RunningServer;

const env = () => ({
  ...process.env,
  API_TOKEN: STATIC_TOKEN,
  BOARD_PASSWORD: PASSWORD,
  ALLOWED_ORIGINS: "",
});

before(async () => {
  ctx = await createTestDb();
  server = await startNodeServer(0, { db: ctx.db, env: env() });
});
after(async () => {
  await server.close();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

/* -------------------------------------------------------------------------- */
/* Helpers that behave like a real MCP client                                 */
/* -------------------------------------------------------------------------- */

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

async function register(overrides: Record<string, unknown> = {}) {
  const response = await fetch(server.origin + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "Claude Test Connector",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_post",
      ...overrides,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function authorizeUrl(params: Record<string, string>): string {
  const url = new URL(server.origin + "/oauth/authorize");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Submit the password form and return the Location header without following it. */
async function submitPassword(fields: Record<string, string>, password: string) {
  const body = new URLSearchParams({ ...fields, password });
  const response = await fetch(server.origin + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    redirect: "manual",
  });
  return response;
}

async function postToken(params: Record<string, string>) {
  const response = await fetch(server.origin + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

/** The complete happy path: register, authorize, exchange. */
async function fullFlow() {
  const { body: client } = await register();
  const { verifier, challenge } = pkce();
  const fields = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "board:read board:write",
    state: "opaque-state-123",
  };

  const redirected = await submitPassword(fields, PASSWORD);
  const location = new URL(redirected.headers.get("location") ?? "");
  const code = location.searchParams.get("code") ?? "";

  const token = await postToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    client_secret: client.client_secret,
    code_verifier: verifier,
  });

  return { client, fields, verifier, code, token, state: location.searchParams.get("state") };
}

/* -------------------------------------------------------------------------- */

describe("PKCE verification", () => {
  it("accepts a correct S256 verifier", () => {
    const { verifier, challenge } = pkce();
    assert.equal(verifyPkce(verifier, challenge, "S256"), true);
  });

  it("rejects a wrong verifier", () => {
    const { challenge } = pkce();
    assert.equal(verifyPkce(pkce().verifier, challenge, "S256"), false);
  });

  it("refuses the plain method outright", () => {
    // `plain` gives no protection against an intercepted code.
    const verifier = randomBytes(48).toString("base64url");
    assert.equal(verifyPkce(verifier, verifier, "plain"), false);
  });

  it("rejects verifiers outside the length the RFC allows", () => {
    const { challenge } = pkce();
    assert.equal(verifyPkce("too-short", challenge, "S256"), false);
    assert.equal(verifyPkce("a".repeat(129), challenge, "S256"), false);
  });
});

describe("discovery", () => {
  it("serves protected resource metadata pointing at this server", async () => {
    const response = await fetch(server.origin + "/.well-known/oauth-protected-resource");
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.resource, server.origin + "/api/mcp");
    assert.deepEqual(body.authorization_servers, [server.origin]);
  });

  it("serves the same document when the resource path is appended", async () => {
    // Clients may request /.well-known/oauth-protected-resource/api/mcp
    const response = await fetch(server.origin + "/.well-known/oauth-protected-resource/api/mcp");
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as Record<string, any>).resource, server.origin + "/api/mcp");
  });

  it("serves authorization server metadata with every endpoint the client needs", async () => {
    const response = await fetch(server.origin + "/.well-known/oauth-authorization-server");
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.issuer, server.origin);
    assert.equal(body.authorization_endpoint, server.origin + "/oauth/authorize");
    assert.equal(body.token_endpoint, server.origin + "/oauth/token");
    assert.equal(body.registration_endpoint, server.origin + "/oauth/register");
    assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
    assert.ok(body.grant_types_supported.includes("authorization_code"));
    assert.ok(body.grant_types_supported.includes("refresh_token"));
  });

  it("needs no credential, or discovery could never happen", async () => {
    // These are fetched before the client has any token at all.
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
    ]) {
      assert.equal((await fetch(server.origin + path)).status, 200, path);
    }
  });
});

describe("the 401 that starts the flow", () => {
  it("points an unauthenticated MCP client at the discovery document", async () => {
    const response = await fetch(server.origin + "/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(response.status, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assert.match(challenge, /^Bearer /);
    assert.ok(
      challenge.includes('resource_metadata="' + server.origin + '/.well-known/oauth-protected-resource"'),
      "the challenge must carry a resource_metadata pointer, got: " + challenge,
    );
  });

  it("does the same for the REST API", async () => {
    const response = await fetch(server.origin + "/api/board");
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  it("marks an expired or unknown token as invalid_token, not merely missing", async () => {
    const response = await fetch(server.origin + "/api/board", {
      headers: { Authorization: "Bearer sba_definitely-not-a-real-token" },
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  });
});

describe("dynamic client registration", () => {
  it("registers a client and returns credentials", async () => {
    const { status, body } = await register();
    assert.equal(status, 201);
    assert.match(body.client_id, /^sbc_/);
    assert.equal(typeof body.client_secret, "string");
    assert.deepEqual(body.redirect_uris, [REDIRECT_URI]);
    assert.deepEqual(body.response_types, ["code"]);
    assert.equal(typeof body.client_id_issued_at, "number");
  });

  it("issues no secret to a public client using PKCE alone", async () => {
    const { status, body } = await register({ token_endpoint_auth_method: "none" });
    assert.equal(status, 201);
    assert.equal(body.client_secret, undefined);
    assert.equal(body.token_endpoint_auth_method, "none");
  });

  it("stores the secret hashed, never in the clear", async () => {
    const { body } = await register();
    const rows = await ctx.db.select().from((await import("../src/db/schema")).oauthClients);
    const row = rows.find((r) => r.clientId === body.client_id);
    assert.ok(row?.clientSecretHash);
    assert.notEqual(row.clientSecretHash, body.client_secret, "the raw secret must not be stored");
    assert.equal(row.clientSecretHash, hashSecret(body.client_secret));
  });

  it("requires at least one redirect_uri", async () => {
    for (const payload of [{ redirect_uris: [] }, { redirect_uris: "not-an-array" }, {}]) {
      const response = await fetch(server.origin + "/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as Record<string, any>).error, "invalid_redirect_uri");
    }
  });

  it("refuses redirect URIs that could execute in a browser", async () => {
    for (const uri of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
      const { status } = await register({ redirect_uris: [uri] });
      assert.equal(status, 400, uri + " must be refused");
    }
  });

  it("refuses plain http except on loopback", async () => {
    assert.equal((await register({ redirect_uris: ["http://evil.example/cb"] })).status, 400);
    assert.equal((await register({ redirect_uris: ["http://localhost:7777/cb"] })).status, 201);
    assert.equal((await register({ redirect_uris: ["http://127.0.0.1:7777/cb"] })).status, 201);
  });

  it("refuses grant types it does not implement", async () => {
    const { status, body } = await register({ grant_types: ["client_credentials"] });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_client_metadata");
  });
});

describe("the authorization endpoint", () => {
  it("shows a password form for a valid request", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const response = await fetch(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc",
      }),
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /Board password/);
    assert.match(html, /Claude Test Connector/, "the page should name the client asking for access");
    assert.match(html, /name="code_challenge"/, "the request must be replayed on submit");
  });

  it("renders an error page rather than redirecting when the client is unknown", async () => {
    const response = await fetch(
      authorizeUrl({
        response_type: "code",
        client_id: "sbc_not-real",
        redirect_uri: REDIRECT_URI,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null, "must not redirect to an unverified URI");
    assert.match(await response.text(), /Unknown client/);
  });

  it("refuses a redirect_uri that was not registered", async () => {
    const { body: client } = await register();
    const response = await fetch(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: "https://attacker.example/steal",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("location"), null, "an open redirect would be a real vulnerability");
    assert.match(await response.text(), /Invalid redirect URI/);
  });

  it("requires PKCE", async () => {
    const { body: client } = await register();
    const response = await fetch(
      authorizeUrl({
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        state: "xyz",
      }),
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.searchParams.get("error"), "invalid_request");
    assert.equal(location.searchParams.get("state"), "xyz", "state must survive an error");
  });

  it("rejects a response_type other than code, via the redirect", async () => {
    const { body: client } = await register();
    const response = await fetch(
      authorizeUrl({
        response_type: "token",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      }),
      { redirect: "manual" },
    );
    assert.equal(response.status, 302);
    assert.equal(
      new URL(response.headers.get("location") ?? "").searchParams.get("error"),
      "unsupported_response_type",
    );
  });

  it("re-renders with an error on a wrong password and issues no code", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const fields = {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "s",
    };
    const response = await submitPassword(fields, "wrong-password");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("location"), null, "a failed password must not redirect anywhere");
    assert.match(await response.text(), /not correct/);
  });

  it("redirects with a code and the original state on the right password", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const response = await submitPassword(
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "round-trip-me",
      },
      PASSWORD,
    );
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.origin + location.pathname, REDIRECT_URI);
    assert.ok(location.searchParams.get("code"));
    assert.equal(location.searchParams.get("state"), "round-trip-me");
  });

  it("refuses to grant anything when no board password is configured", async () => {
    const unconfigured = await startNodeServer(0, {
      db: ctx.db,
      env: { ...process.env, API_TOKEN: STATIC_TOKEN, BOARD_PASSWORD: "" },
    });
    try {
      const { body: client } = await register();
      const response = await fetch(
        unconfigured.origin +
          "/oauth/authorize?response_type=code&client_id=" +
          client.client_id +
          "&redirect_uri=" +
          encodeURIComponent(REDIRECT_URI) +
          "&code_challenge=" +
          pkce().challenge +
          "&code_challenge_method=S256",
      );
      assert.equal(response.status, 503);
      assert.match(await response.text(), /BOARD_PASSWORD/);
    } finally {
      await unconfigured.close();
    }
  });
});

describe("the token endpoint", () => {
  it("exchanges a code for an access and refresh token", async () => {
    const { token, state } = await fullFlow();
    assert.equal(state, "opaque-state-123");
    assert.equal(token.status, 200);
    assert.match(token.body.access_token, /^sba_/);
    assert.match(token.body.refresh_token, /^sbr_/);
    assert.equal(token.body.token_type, "Bearer");
    assert.equal(typeof token.body.expires_in, "number");
    assert.equal(token.body.scope, "board:read board:write");
  });

  it("stores tokens hashed, never in the clear", async () => {
    const { token } = await fullFlow();
    const rows = await ctx.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenHash, hashSecret(token.body.access_token)));
    assert.equal(rows.length, 1, "the token must be findable only by its hash");

    const all = await ctx.db.select().from(oauthTokens);
    for (const row of all) {
      assert.notEqual(row.tokenHash, token.body.access_token);
      assert.notEqual(row.tokenHash, token.body.refresh_token);
    }
  });

  it("refuses to reuse an authorization code", async () => {
    const { client, verifier, code } = await fullFlow();
    const replay = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
    assert.match(replay.body.error_description, /already been used/);
  });

  it("refuses a code with the wrong PKCE verifier", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const redirected = await submitPassword(
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      PASSWORD,
    );
    const code = new URL(redirected.headers.get("location") ?? "").searchParams.get("code") ?? "";

    const stolen = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret,
      // An attacker holding the code but not the verifier.
      code_verifier: pkce().verifier,
    });
    assert.equal(stolen.status, 400);
    assert.match(stolen.body.error_description, /code_verifier/);
  });

  it("requires a code_verifier at all", async () => {
    const { body: client } = await register();
    const { challenge } = pkce();
    const redirected = await submitPassword(
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      PASSWORD,
    );
    const code = new URL(redirected.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const result = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error_description, /PKCE/);
  });

  it("rejects a wrong client secret", async () => {
    const { client, verifier, code } = await fullFlow();
    const result = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: "not-the-secret",
      code_verifier: verifier,
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_client");
  });

  it("rejects an unknown client", async () => {
    const result = await postToken({
      grant_type: "authorization_code",
      code: "whatever",
      client_id: "sbc_nope",
      code_verifier: "x".repeat(43),
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, "invalid_client");
  });

  it("rejects a code issued to a different client", async () => {
    const { body: victim } = await register();
    const { body: attacker } = await register();
    const { challenge } = pkce();
    const redirected = await submitPassword(
      {
        response_type: "code",
        client_id: victim.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      PASSWORD,
    );
    const code = new URL(redirected.headers.get("location") ?? "").searchParams.get("code") ?? "";

    const result = await postToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: attacker.client_id,
      client_secret: attacker.client_secret,
      code_verifier: "x".repeat(43),
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_grant");
  });

  it("rejects a mismatched redirect_uri at exchange time", async () => {
    const { client, verifier, code: _unused } = await fullFlow();
    // Fresh code, then exchange claiming a different redirect_uri.
    const { challenge } = pkce();
    const redirected = await submitPassword(
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      PASSWORD,
    );
    const fresh = new URL(redirected.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const result = await postToken({
      grant_type: "authorization_code",
      code: fresh,
      redirect_uri: "http://localhost:7777/cb",
      client_id: client.client_id,
      client_secret: client.client_secret,
      code_verifier: verifier,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_grant");
  });

  it("rejects an unsupported grant type", async () => {
    const { body: client } = await register();
    const result = await postToken({
      grant_type: "client_credentials",
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "unsupported_grant_type");
  });

  it("accepts client credentials via HTTP Basic", async () => {
    const { body: client } = await register({ token_endpoint_auth_method: "client_secret_basic" });
    const { challenge, verifier } = pkce();
    const redirected = await submitPassword(
      {
        response_type: "code",
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
      },
      PASSWORD,
    );
    const code = new URL(redirected.headers.get("location") ?? "").searchParams.get("code") ?? "";

    const basic = Buffer.from(client.client_id + ":" + client.client_secret).toString("base64");
    const response = await fetch(server.origin + "/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + basic,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    assert.equal(response.status, 200);
    assert.match(((await response.json()) as Record<string, any>).access_token, /^sba_/);
  });

  it("never lets a token response be cached", async () => {
    const { body: client } = await register();
    const response = await fetch(server.origin + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "bogus", client_id: client.client_id, client_secret: client.client_secret }).toString(),
    });
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  });
});

describe("refresh and revocation", () => {
  it("exchanges a refresh token for a new pair", async () => {
    const { client, token } = await fullFlow();
    const refreshed = await postToken({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    assert.equal(refreshed.status, 200);
    assert.match(refreshed.body.access_token, /^sba_/);
    assert.notEqual(refreshed.body.access_token, token.body.access_token);
  });

  it("rotates the refresh token, so the old one stops working", async () => {
    const { client, token } = await fullFlow();
    await postToken({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    const replay = await postToken({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "invalid_grant");
  });

  it("refuses a refresh token belonging to another client", async () => {
    const { token } = await fullFlow();
    const { body: other } = await register();
    const result = await postToken({
      grant_type: "refresh_token",
      refresh_token: token.body.refresh_token,
      client_id: other.client_id,
      client_secret: other.client_secret,
    });
    assert.equal(result.status, 400);
  });

  it("revokes a token, and the board immediately refuses it", async () => {
    const { client, token } = await fullFlow();

    const before = await fetch(server.origin + "/api/board", {
      headers: { Authorization: "Bearer " + token.body.access_token },
    });
    assert.equal(before.status, 200, "the token should work before revocation");

    const revoked = await fetch(server.origin + "/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: token.body.access_token,
        client_id: client.client_id,
        client_secret: client.client_secret,
      }).toString(),
    });
    assert.equal(revoked.status, 200);

    const after = await fetch(server.origin + "/api/board", {
      headers: { Authorization: "Bearer " + token.body.access_token },
    });
    assert.equal(after.status, 401);
    assert.match(after.headers.get("www-authenticate") ?? "", /invalid_token/);
  });

  it("reports success for an unknown token, so it cannot be used to probe", async () => {
    const { body: client } = await register();
    const response = await fetch(server.origin + "/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: "sba_never-existed",
        client_id: client.client_id,
        client_secret: client.client_secret,
      }).toString(),
    });
    assert.equal(response.status, 200);
  });
});

describe("using an OAuth token against the board", () => {
  it("reads and writes the board through REST", async () => {
    const { token } = await fullFlow();
    const auth = { Authorization: "Bearer " + token.body.access_token };

    const read = await fetch(server.origin + "/api/board", { headers: auth });
    assert.equal(read.status, 200);

    const write = await fetch(server.origin + "/api/board", {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(labelledBoard("via-oauth")),
    });
    assert.equal(write.status, 200);

    const reread = await fetch(server.origin + "/api/board", { headers: auth });
    assert.deepEqual(((await reread.json()) as Record<string, any>).board, labelledBoard("via-oauth"));
  });

  it("drives the MCP endpoint", async () => {
    const { token } = await fullFlow();
    const response = await fetch(server.origin + "/api/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token.body.access_token,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1.0.0" },
        },
      }),
    });
    assert.equal(response.status, 200);
  });

  it("keeps accepting the static API token, so the CLI checks still work", async () => {
    const response = await fetch(server.origin + "/api/board", {
      headers: { Authorization: "Bearer " + STATIC_TOKEN },
    });
    assert.equal(response.status, 200);
  });
});
