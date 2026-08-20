/**
 * Verify the OAuth side of a deployment, the way Claude's connector does.
 *
 *   npm run oauth:check -- --url https://status-board-eight.vercel.app
 *   npm run oauth:check -- --url https://... --password '<BOARD_PASSWORD>'
 *
 * Without --password it checks everything that does not need the board password:
 * the 401 challenge, both discovery documents, dynamic client registration, and
 * that the sign-in page renders. That is the whole path the connector walks
 * before a human is asked to sign in.
 *
 * With --password it completes the flow — sign in, exchange the code with PKCE,
 * then use the resulting token against the board and the MCP endpoint. It leaves
 * a registered client and an access token behind, both revocable.
 */
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf("--" + name);
  return index === -1 ? undefined : args[index + 1];
}

const baseUrl = (option("url") ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
// Deliberately NOT falling back to process.env.BOARD_PASSWORD: that would send a
// local development password to whatever remote host --url points at, and make
// the output look like real failures when it did not match.
const password = option("password");
// Loopback, so a stray code cannot be delivered anywhere real.
const REDIRECT_URI = "http://localhost:7777/callback";

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

function pkce() {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function main(): Promise<void> {
  console.log("Checking OAuth at " + baseUrl);
  console.log("");

  /* 1. The 401 challenge that starts everything. */
  const unauthorized = await fetch(baseUrl + "/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("MCP refuses an anonymous client", unauthorized.status === 401, "got " + unauthorized.status);
  const challenge = unauthorized.headers.get("www-authenticate") ?? "";
  check("the 401 carries a resource_metadata pointer", challenge.includes("resource_metadata="), challenge || "(no header)");

  /* 2. Discovery. */
  const prm = await fetch(baseUrl + "/.well-known/oauth-protected-resource");
  const prmBody = (await prm.json().catch(() => ({}))) as Record<string, any>;
  check("protected resource metadata is served", prm.status === 200, "got " + prm.status);
  check("it names this MCP endpoint as the resource", prmBody.resource === baseUrl + "/api/mcp", prmBody.resource);

  const asm = await fetch(baseUrl + "/.well-known/oauth-authorization-server");
  const asmBody = (await asm.json().catch(() => ({}))) as Record<string, any>;
  check("authorization server metadata is served", asm.status === 200, "got " + asm.status);
  check("it advertises a registration endpoint", typeof asmBody.registration_endpoint === "string");
  check("it requires PKCE with S256", JSON.stringify(asmBody.code_challenge_methods_supported) === '["S256"]');

  /* 3. Dynamic client registration — the step that was failing. */
  const registration = await fetch(baseUrl + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [REDIRECT_URI],
      client_name: "status-board oauth:check",
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_post",
    }),
  });
  const client = (await registration.json().catch(() => ({}))) as Record<string, any>;
  check("dynamic client registration succeeds", registration.status === 201, "got " + registration.status);
  check("a client_id was issued", typeof client.client_id === "string", client.client_id);

  if (registration.status !== 201) {
    console.log("");
    console.log("Registration failed, so the connector cannot be added. Stopping here.");
    process.exitCode = 1;
    return;
  }

  /* 4. The sign-in page. */
  const { verifier, challenge: codeChallenge } = pkce();
  const authorizeUrl = new URL(baseUrl + "/oauth/authorize");
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: "board:read board:write",
    state: "oauth-check-state",
  })) {
    authorizeUrl.searchParams.set(key, value);
  }

  const page = await fetch(authorizeUrl.toString());
  const pageHtml = await page.text();
  check("the sign-in page renders", page.status === 200, "got " + page.status);
  check("it asks for the board password", /Board password/i.test(pageHtml));

  /* 5. An unregistered redirect_uri must not be honoured. */
  const openRedirect = new URL(authorizeUrl.toString());
  openRedirect.searchParams.set("redirect_uri", "https://attacker.example/steal");
  const refused = await fetch(openRedirect.toString(), { redirect: "manual" });
  check(
    "an unregistered redirect_uri is refused without redirecting",
    refused.status === 400 && !refused.headers.get("location"),
    "status " + refused.status + ", location " + (refused.headers.get("location") ?? "none"),
  );

  /* 6. A wrong password must not issue a code. */
  const wrong = await fetch(baseUrl + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      password: "definitely-not-the-password",
    }).toString(),
    redirect: "manual",
  });
  check(
    "a wrong password issues no code",
    wrong.status === 401 && !wrong.headers.get("location"),
    "status " + wrong.status,
  );

  if (!password) {
    console.log("");
    console.log("  (skipping the sign-in step: pass --password to complete the full flow)");
    console.log("");
    console.log(failures === 0 ? "All checks passed." : failures + " check(s) failed.");
    if (failures > 0) process.exitCode = 1;
    return;
  }

  /* 7. The full flow. */
  console.log("");
  console.log("  full flow with the board password");

  const signedIn = await fetch(baseUrl + "/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: "board:read board:write",
      state: "oauth-check-state",
      password,
    }).toString(),
    redirect: "manual",
  });
  check("the right password redirects with a code", signedIn.status === 302, "got " + signedIn.status);

  const location = signedIn.headers.get("location");
  if (!location) {
    check("a redirect location was returned", false);
    console.log("");
    console.log(failures + " check(s) failed.");
    process.exitCode = 1;
    return;
  }
  const redirected = new URL(location);
  const code = redirected.searchParams.get("code") ?? "";
  check("a code was issued", code.length > 0);
  check("the state was round-tripped", redirected.searchParams.get("state") === "oauth-check-state");

  const exchange = await fetch(baseUrl + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
      code_verifier: verifier,
    }).toString(),
  });
  const tokens = (await exchange.json().catch(() => ({}))) as Record<string, any>;
  // Never print the tokens themselves, even for a throwaway client.
  check(
    "the code exchanges for a token",
    exchange.status === 200,
    "got " + exchange.status + (exchange.status === 200 ? "" : " " + (tokens.error_description ?? tokens.error ?? "")),
  );
  check("an access token was issued", typeof tokens.access_token === "string");
  check("a refresh token was issued", typeof tokens.refresh_token === "string");

  if (typeof tokens.access_token !== "string") {
    console.log("");
    console.log(failures + " check(s) failed.");
    process.exitCode = 1;
    return;
  }

  const replay = await fetch(baseUrl + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
      code_verifier: verifier,
    }).toString(),
  });
  check("the code cannot be reused", replay.status === 400, "got " + replay.status);

  const auth = { Authorization: "Bearer " + tokens.access_token };

  const board = await fetch(baseUrl + "/api/board", { headers: auth });
  check("the token reads the board", board.status === 200, "got " + board.status);

  const mcp = await fetch(baseUrl + "/api/mcp", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "oauth-check", version: "1.0.0" },
      },
    }),
  });
  check("the token drives the MCP endpoint", mcp.status === 200, "got " + mcp.status);

  const revoked = await fetch(baseUrl + "/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: tokens.access_token,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    }).toString(),
  });
  check("the token can be revoked", revoked.status === 200, "got " + revoked.status);

  const afterRevoke = await fetch(baseUrl + "/api/board", { headers: auth });
  check("a revoked token is refused immediately", afterRevoke.status === 401, "got " + afterRevoke.status);

  // Revoke the refresh token too, or this check would leave a long-lived
  // credential behind every time it runs.
  const revokedRefresh = await fetch(baseUrl + "/oauth/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    }).toString(),
  });
  check("the refresh token is revoked as well", revokedRefresh.status === 200, "got " + revokedRefresh.status);

  const deadRefresh = await fetch(baseUrl + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret ?? "",
    }).toString(),
  });
  check("the revoked refresh token cannot mint a new token", deadRefresh.status === 400, "got " + deadRefresh.status);
  console.log("        left behind: registered client " + client.client_id + " (harmless; no live tokens)");

  console.log("");
  console.log(failures === 0 ? "All checks passed." : failures + " check(s) failed.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("oauth check could not run:", error);
  process.exitCode = 1;
});
