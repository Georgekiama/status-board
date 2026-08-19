import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer, type McpContext } from "./server";

export interface McpHttpOptions {
  ctx?: McpContext;
  /** Body already read off the socket, if the caller consumed it. */
  rawBody?: string;
  env?: NodeJS.ProcessEnv;
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

/**
 * When API_TOKEN is set, the MCP endpoint requires it too. This endpoint can
 * write the board, so it is never less protected than the REST API.
 */
function authorized(req: IncomingMessage, env: NodeJS.ProcessEnv): boolean {
  const expected = env.API_TOKEN;
  if (!expected) return true;

  const header = req.headers.authorization;
  const bearer = Array.isArray(header) ? header[0] : header;
  const supplied =
    bearer?.replace(/^Bearer\s+/i, "").trim() ||
    (Array.isArray(req.headers["x-api-token"]) ? req.headers["x-api-token"][0] : req.headers["x-api-token"])?.trim();

  return Boolean(supplied) && supplied === expected;
}

/**
 * Serve one MCP request over streamable HTTP.
 *
 * Stateless: a fresh server and transport per request, so this works unchanged
 * on a long-running Node process and on Vercel, where no state survives between
 * invocations anyway.
 */
export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: McpHttpOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;

  if (!authorized(req, env)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    sendJsonRpcError(res, 401, -32001, "A valid API token is required.");
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
