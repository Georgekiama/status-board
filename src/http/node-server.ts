import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderConfig } from "../../scripts/write-config";
import { handleMcpRequest } from "../mcp/http";
import { handleApi, MAX_REQUEST_BYTES, type ApiContext, type ApiRequest } from "./handlers";

const PUBLIC_DIR = fileURLToPath(new URL("../../public", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

class PayloadTooLargeError extends Error {}

/** Collect the request body as text, refusing anything oversized. */
async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new PayloadTooLargeError("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toApiRequest(req: IncomingMessage, rawBody: string): ApiRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers,
    rawBody,
  };
}

function sendJson(res: ServerResponse, status: number, headers: Record<string, string>, body: unknown): void {
  if (body === null || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

/**
 * Serve a file out of public/. Path traversal is blocked by resolving inside
 * PUBLIC_DIR and rejecting anything that escapes it.
 */
async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const relative = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname)).replace(
    /^([/\\])+/,
    "",
  );
  const target = join(PUBLIC_DIR, relative);

  if (!target.startsWith(PUBLIC_DIR + sep) && target !== PUBLIC_DIR) {
    sendJson(res, 403, {}, { error: { code: "forbidden", message: "Path outside the public directory." } });
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      await serveStatic(req, res, join(pathname, "index.html").replace(/\\/g, "/"));
      return;
    }
    const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    // The board HTML must never be cached, or an edit can appear to vanish.
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(target).pipe(res);
  } catch {
    sendJson(res, 404, {}, { error: { code: "not_found", message: "Not found: " + pathname } });
  }
}

/**
 * Frontend and API on a single origin (plan.md section 6) so no CORS is needed.
 */
export function createNodeServer(ctx: ApiContext = {}): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { Allow: "GET, HEAD" }, { error: { code: "method_not_allowed", message: "Static files are read-only." } });
        return;
      }
      // Served from the environment rather than from disk, so local development
      // never depends on a generated file being up to date. On Vercel the build
      // writes public/config.js instead and the CDN serves that.
      if (url.pathname === "/config.js") {
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : renderConfig(ctx.env ?? process.env));
        return;
      }
      await serveStatic(req, res, url.pathname);
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBody(req);
    } catch (error) {
      // We are answering before the client finished uploading, so the unread
      // remainder would corrupt the next request on this keep-alive socket.
      // Close the connection explicitly and discard the rest.
      const status = error instanceof PayloadTooLargeError ? 413 : 400;
      const code = error instanceof PayloadTooLargeError ? "payload_too_large" : "bad_request";
      const message =
        error instanceof PayloadTooLargeError ? error.message : "Could not read the request body.";
      sendJson(res, status, { Connection: "close" }, { error: { code, message } });
      req.destroy();
      return;
    }

    // MCP shares the origin with the REST API and the same service layer.
    if (url.pathname.replace(/\/+$/, "") === "/api/mcp") {
      await handleMcpRequest(req, res, { ctx: { db: ctx.db }, rawBody, env: ctx.env });
      return;
    }

    try {
      const response = await handleApi(toApiRequest(req, rawBody), ctx);
      sendJson(res, response.status, response.headers, response.body);
    } catch (error) {
      console.error("[server] unhandled error:", error);
      sendJson(res, 500, {}, { error: { code: "internal_error", message: "Unexpected server error." } });
    }
  });
}

export interface RunningServer {
  server: Server;
  port: number;
  origin: string;
  close(): Promise<void>;
}

/** Start on `port`, or on an ephemeral port when given 0 (used by tests). */
export function startNodeServer(port: number, ctx: ApiContext = {}): Promise<RunningServer> {
  const server = createNodeServer(ctx);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      resolve({
        server,
        port: actualPort,
        origin: "http://127.0.0.1:" + actualPort,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
