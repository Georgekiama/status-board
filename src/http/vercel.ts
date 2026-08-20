import type { IncomingMessage, ServerResponse } from "node:http";
import { handleApi, MAX_REQUEST_BYTES, type ApiContext, type ApiRequest } from "./handlers";

/**
 * Vercel's Node runtime hands us Node's own IncomingMessage/ServerResponse,
 * extended with a pre-parsed `body` when the content type is JSON.
 */
export type VercelLikeRequest = IncomingMessage & { body?: unknown; query?: Record<string, string | string[]> };
export type VercelLikeResponse = ServerResponse;

/**
 * Recover the raw body. Vercel may have parsed it already, in which case the
 * stream is drained and `req.body` is the only copy.
 */
export async function readRawBody(req: VercelLikeRequest): Promise<string> {
  if (typeof req.body === "string") return req.body;
  if (req.body !== undefined && req.body !== null) return JSON.stringify(req.body);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toApiRequest(req: VercelLikeRequest, rawBody: string): ApiRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    method: req.method ?? "GET",
    // A rewrite can leave the original path only in the URL, which is what we want.
    path: url.pathname,
    query: url.searchParams,
    headers,
    rawBody,
  };
}

/** Adapt a Vercel invocation onto the shared, transport-agnostic handler. */
export async function serveApi(
  req: VercelLikeRequest,
  res: VercelLikeResponse,
  ctx: ApiContext = {},
): Promise<void> {
  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "payload_too_large", message: error instanceof Error ? error.message : "Body too large" },
      }),
    );
    return;
  }

  const response = await handleApi(toApiRequest(req, rawBody), ctx);

  // The OAuth sign-in page and its redirects are not JSON.
  if (response.text !== undefined) {
    res.writeHead(response.status, {
      ...response.headers,
      "Content-Type": response.contentType ?? "text/plain; charset=utf-8",
    });
    res.end(response.text);
    return;
  }

  if (response.body === null || response.body === undefined) {
    res.writeHead(response.status, response.headers);
    res.end();
    return;
  }

  res.writeHead(response.status, { ...response.headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(response.body));
}
