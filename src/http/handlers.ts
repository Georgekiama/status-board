import type { Db } from "../db/client";
import { BoardError, BoardValidationError } from "../board/errors";
import { boardService } from "../board/service";
import type { BoardRecord, WriteSource } from "../board/types";
import { corsHeaders } from "./cors";
import { authenticate } from "../oauth/authenticate";
import { isOAuthPath, resolveBaseUrl } from "../oauth/config";
import { handleOAuth } from "../oauth/handlers";
import { challengeHeader } from "../oauth/metadata";

/** Reject bodies before parsing them. Generous next to MAX_BOARD_BYTES. */
export const MAX_REQUEST_BYTES = 2_000_000;

export interface ApiRequest {
  method: string;
  /** Path only, no query string, e.g. /api/board */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Raw request body as text. Empty string when there is none. */
  rawBody: string;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON-serialised body. Ignored when `text` is set. */
  body: unknown;
  /**
   * Raw response body, for the OAuth sign-in page and redirects, which cannot be
   * JSON. When set, `contentType` decides the header and `body` is unused.
   */
  text?: string;
  contentType?: string;
}

export interface ApiContext {
  /** Injected connection (tests). Falls back to DATABASE_URL. */
  db?: Db;
  /** Recorded on history rows written through this handler. */
  source?: WriteSource;
  env?: NodeJS.ProcessEnv;
}

function boardHeaders(record: BoardRecord): Record<string, string> {
  return {
    "X-Board-Version": String(record.version),
    "X-Board-Updated-At": record.updatedAt,
    // The board is mutable shared state; never let a proxy or browser cache it.
    "Cache-Control": "no-store, must-revalidate",
  };
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

/**
 * The frontend may PUT either the bare board or the same envelope the API
 * returns, so the HTML integration cannot get this subtly wrong.
 */
export function unwrapBoardPayload(payload: unknown): unknown {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    if (!("areas" in record) && record.board && typeof record.board === "object") {
      return record.board;
    }
  }
  return payload;
}

/** Read expectedVersion from the body or an If-Match header. Opt-in. */
function readExpectedVersion(payload: unknown, headers: Record<string, string | undefined>): number | undefined {
  const ifMatch = headers["if-match"];
  if (ifMatch) {
    const parsed = Number(ifMatch.replace(/^W\//, "").replace(/"/g, "").trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const raw = (payload as Record<string, unknown>).expectedVersion;
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  }
  return undefined;
}

/**
 * Accepts either the static API_TOKEN or an OAuth access token. A credential is
 * required only when API_TOKEN is set (plan.md section 7).
 *
 * The 401 carries a `resource_metadata` challenge pointing at the OAuth
 * discovery document. That pointer is what lets an MCP client find the
 * authorization server — without it, Claude's connector cannot register.
 */
async function authorize(req: ApiRequest, ctx: ApiContext, baseUrl: string): Promise<ApiResponse | undefined> {
  const result = await authenticate(req.headers, { db: ctx.db, env: ctx.env ?? process.env });
  if (result.ok) return undefined;

  return {
    status: 401,
    headers: {
      "WWW-Authenticate": challengeHeader(
        baseUrl,
        result.reason === "invalid" ? "invalid_token" : undefined,
        result.reason === "invalid" ? "The credential is expired, revoked or unknown." : undefined,
      ),
    },
    body: errorBody(
      "unauthorized",
      result.reason === "invalid"
        ? "The credential presented is expired, revoked or unknown."
        : "Authentication is required. Use an API token, or authorize through OAuth.",
    ),
  };
}

/**
 * The whole API surface, transport-agnostic. Both the local Node server and the
 * Vercel functions adapt their request objects into ApiRequest and call this.
 */
export async function handleApi(req: ApiRequest, ctx: ApiContext = {}): Promise<ApiResponse> {
  const env = ctx.env ?? process.env;
  const cors = corsHeaders(req.headers.origin, env);
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, "") || "/";

  const respond = (response: ApiResponse): ApiResponse => ({
    ...response,
    headers: { ...cors, ...response.headers },
  });

  if (method === "OPTIONS") {
    return respond({ status: 204, headers: {}, body: null });
  }

  if (path === "/api/health") {
    if (method !== "GET") return respond(methodNotAllowed(["GET"]));
    return respond(await handleHealth(ctx));
  }

  // The authorization server sits outside the token gate: a client cannot
  // present a credential until it has been through this flow to get one.
  if (isOAuthPath(path)) {
    try {
      return respond(await handleOAuth(req, ctx));
    } catch (error) {
      return respond(toErrorResponse(error));
    }
  }

  const unauthorized = await authorize(req, ctx, resolveBaseUrl(req.headers, env));
  if (unauthorized) return respond(unauthorized);

  try {
    if (path === "/api/board") {
      if (method === "GET") return respond(await handleGetBoard(ctx));
      if (method === "PUT") return respond(await handlePutBoard(req, ctx));
      return respond(methodNotAllowed(["GET", "PUT"]));
    }

    if (path === "/api/board/history") {
      if (method !== "GET") return respond(methodNotAllowed(["GET"]));
      const limit = Number(req.query.get("limit") ?? "50");
      const versions = await boardService.listHistory({
        limit: Number.isFinite(limit) ? limit : 50,
        db: ctx.db,
      });
      return respond({ status: 200, headers: { "Cache-Control": "no-store" }, body: { versions } });
    }

    const historyEntry = /^\/api\/board\/history\/(\d+)$/.exec(path);
    if (historyEntry) {
      if (method !== "GET") return respond(methodNotAllowed(["GET"]));
      const entry = await boardService.getHistoryEntry(Number(historyEntry[1]), { db: ctx.db });
      return respond({ status: 200, headers: { "Cache-Control": "no-store" }, body: entry });
    }

    return respond({
      status: 404,
      headers: {},
      body: errorBody("not_found", "No route for " + method + " " + req.path),
    });
  } catch (error) {
    return respond(toErrorResponse(error));
  }
}

async function handleHealth(ctx: ApiContext): Promise<ApiResponse> {
  try {
    const record = await boardService.getBoard({ db: ctx.db });
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: { ok: true, database: "up", boardVersion: record.version },
    };
  } catch (error) {
    return {
      status: 503,
      headers: { "Cache-Control": "no-store" },
      body: { ok: false, database: "down", message: messageOf(error) },
    };
  }
}

async function handleGetBoard(ctx: ApiContext): Promise<ApiResponse> {
  const record = await boardService.getBoard({ db: ctx.db });
  return { status: 200, headers: boardHeaders(record), body: record };
}

async function handlePutBoard(req: ApiRequest, ctx: ApiContext): Promise<ApiResponse> {
  if (Buffer.byteLength(req.rawBody, "utf8") > MAX_REQUEST_BYTES) {
    return {
      status: 413,
      headers: {},
      body: errorBody("payload_too_large", "Request body exceeds " + MAX_REQUEST_BYTES + " bytes."),
    };
  }

  let parsed: unknown;
  try {
    parsed = req.rawBody.trim() === "" ? undefined : JSON.parse(req.rawBody);
  } catch (error) {
    return {
      status: 400,
      headers: {},
      body: errorBody("invalid_json", "Request body is not valid JSON: " + messageOf(error)),
    };
  }

  const expectedVersion = readExpectedVersion(parsed, req.headers);
  const result = await boardService.updateBoard(unwrapBoardPayload(parsed), {
    source: ctx.source ?? "rest",
    expectedVersion,
    db: ctx.db,
  });

  return {
    status: 200,
    headers: boardHeaders(result.record),
    body: {
      ...result.record,
      previousVersion: result.previousVersion,
      historyId: result.historyId,
      warnings: result.warnings,
    },
  };
}

function methodNotAllowed(allowed: string[]): ApiResponse {
  return {
    status: 405,
    headers: { Allow: allowed.join(", ") },
    body: errorBody("method_not_allowed", "Allowed methods: " + allowed.join(", ")),
  };
}

/** Map service errors onto status codes. Unknown errors never leak internals. */
export function toErrorResponse(error: unknown): ApiResponse {
  if (error instanceof BoardValidationError) {
    return {
      status: error.status,
      headers: {},
      body: errorBody(error.code, error.message, { issues: error.issues }),
    };
  }
  if (error instanceof BoardError) {
    const extra =
      "currentVersion" in error
        ? {
            currentVersion: (error as unknown as { currentVersion: number }).currentVersion,
            expectedVersion: (error as unknown as { expectedVersion: number }).expectedVersion,
          }
        : {};
    return { status: error.status, headers: {}, body: errorBody(error.code, error.message, extra) };
  }

  console.error("[api] unhandled error:", error);
  const message = messageOf(error);
  const isConnectivity = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect|terminated|DATABASE_URL/i.test(message);
  return isConnectivity
    ? {
        status: 503,
        headers: { "Retry-After": "5" },
        body: errorBody("database_unavailable", "The board database is unavailable. Your change was not saved."),
      }
    : { status: 500, headers: {}, body: errorBody("internal_error", "Unexpected server error.") };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
