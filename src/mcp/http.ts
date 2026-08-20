import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticate } from "../oauth/authenticate";
import { resolveBaseUrl } from "../oauth/config";
import { challengeHeader } from "../oauth/metadata";
import { createMcpServer, type McpContext } from "./server";

export interface McpHttpOptions {
  ctx?: McpContext;
  /** Body already read off the socket, if the caller consumed it. */
  rawBody?: string;
  env?: NodeJS.ProcessEnv;
}

function headerRecord(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * Serve one MCP request over streamable HTTP.
 *
 * Stateless: a fresh server and transport per request, so this works unchanged
 * on a long-running Node process and on Vercel, where no state survives between
 * invocations anyway.
 *
 * Authentication accepts either the static API_TOKEN or an OAuth access token,
 * through the same `authenticate` used by the REST API. The 401 carries a
 * `WWW-Authenticate` challenge with a `resource_metadata` pointer, which is what
 * lets an MCP client discover the authorization server and register itself. A
 * bare `Bearer` challenge is why Claude's connector previously failed with
 * "couldn't register with the sign-in service".
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: McpHttpOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const headers = headerRecord(req);
  const baseUrl = resolveBaseUrl(headers, env);

  const auth = await authenticate(headers, { db: options.ctx?.db, env });
  if (!auth.ok) {
    sendJsonRpcError(
      res,
      401,
      -32001,
      auth.reason === "invalid"
        ? "The credential presented is expired, revoked or unknown."
        : "Authentication is required.",
      {
        "WWW-Authenticate": challengeHeader(
          baseUrl,
          auth.reason === "invalid" ? "invalid_token" : undefined,
          auth.reason === "invalid" ? "The credential is expired, revoked or unknown." : undefined,
        ),
      },
    );
    return;
  }

  let parsedBody: unknown;
  if (options.rawBody !== undefined && options.rawBody !== "") {
    try {
      parsedBody = JSON.parse(options.rawBody);
    } catch {
      sendJsonRpcError(res, 400, -32700, "Parse error: request body is not valid JSON.");
      return;
    }
  }

  const server = createMcpServer(options.ctx ?? {});
  const transport = new StreamableHTTPServerTransport({
    // Stateless mode — no session bookkeeping to lose between invocations.
    sessionIdGenerator: undefined,
    // Plain JSON responses rather than SSE, which is what serverless needs.
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    console.error("[mcp] request failed:", error);
    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, "Internal MCP server error.");
    }
  }
}
