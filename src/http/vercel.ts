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

  if (req.body !== undefined && req.body !== null) {
    // Vercel parses the body for us and drains the stream, so req.body is the
    // only copy. Re-encode it in the format the request actually declared --
    // JSON.stringify-ing a form body would produce something that neither a
    // JSON parser nor URLSearchParams can read, which silently broke the OAuth
    // token and authorize endpoints (both form-encoded) in production.
    const contentType = (
      Array.isArray(req.headers["content-type"]) ? req.headers["content-type"][0] : req.headers["content-type"]
    ) ?? "";

    if (contentType.includes("application/x-www-form-urlencoded") && typeof req.body === "object") {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(req.body as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const item of value) params.append(key, String(item));
        } else if (value !== undefined && value !== null) {
          params.set(key, String(value));
        }
      }
      return params.toString();
    }

    return JSON.stringify(req.body);
  }

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
