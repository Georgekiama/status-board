import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/board/errors.ts
var BoardError = class extends Error {
  status;
  code;
  constructor(message, code, status) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
};
var BoardValidationError = class extends BoardError {
  issues;
  constructor(issues) {
    super(`Board payload is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"})`, "invalid_board", 400);
    this.issues = issues;
  }
};
var VersionConflictError = class extends BoardError {
  expectedVersion;
  currentVersion;
  constructor(expectedVersion, currentVersion) {
    super(
      `Board has changed: expected version ${expectedVersion} but current version is ${currentVersion}`,
      "version_conflict",
      409
    );
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
};
var NotFoundError = class extends BoardError {
  constructor(message) {
    super(message, "not_found", 404);
  }
};

// src/board/service.ts
import { desc, eq, sql as sql2 } from "drizzle-orm";

// src/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  SINGLETON_BOARD_ID: () => SINGLETON_BOARD_ID,
  board: () => board,
  boardHistory: () => boardHistory
});
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
var SINGLETON_BOARD_ID = 1;
var board = pgTable(
  "board",
  {
    id: integer("id").primaryKey().default(SINGLETON_BOARD_ID),
    /** Bumped on every successful write. Also used for optimistic concurrency. */
    version: integer("version").notNull().default(1),
    data: jsonb("data").$type().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [check("board_is_singleton", sql`${t.id} = ${sql.raw(String(SINGLETON_BOARD_ID))}`)]
);
var boardHistory = pgTable(
  "board_history",
  {
    id: serial("id").primaryKey(),
    version: integer("version").notNull(),
    data: jsonb("data").$type().notNull(),
    /** "rest" | "mcp" | "seed" | "restore" — which interface performed the write. */
    source: text("source").$type().notNull().default("rest"),
    replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow()
  },
  (t) => [
    index("board_history_replaced_at_idx").on(t.replacedAt),
    index("board_history_version_idx").on(t.version)
  ]
);

// src/db/client.ts
var PGLITE_MODULE = ["@electric-sql", "pglite"].join("/");
var PGLITE_DRIVER_MODULE = ["drizzle-orm", "pglite"].join("/");
var PGLITE_MIGRATOR_MODULE = ["drizzle-orm", "pglite", "migrator"].join("/");
var PG_MODULE = ["p", "g"].join("");
var PG_DRIVER_MODULE = ["drizzle-orm", "node-postgres"].join("/");
var PG_MIGRATOR_MODULE = ["drizzle-orm", "node-postgres", "migrator"].join("/");
function detectDriver(url) {
  if (url.startsWith("pglite:") || url.startsWith("memory:")) return "pglite";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  if (host.endsWith(".neon.tech") || host.endsWith(".neon.build")) return "neon";
  return "postgres";
}
function pgliteTarget(url) {
  const rest = url.replace(/^(pglite|memory):(\/\/)?/, "");
  if (rest === "" || rest === "memory" || rest === "memory://") return "memory://";
  return rest;
}
function resolveDatabaseUrl(explicit) {
  const url = explicit ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in (use `pglite://.pglite/statusboard` for a local no-server database)."
    );
  }
  return url;
}
async function createHandle(url) {
  const driver = detectDriver(url);
  if (driver === "pglite") {
    const { PGlite } = await import(PGLITE_MODULE);
    const { drizzle: drizzle2 } = await import(PGLITE_DRIVER_MODULE);
    const target = pgliteTarget(url);
    if (target !== "memory://") {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(target, { recursive: true });
    }
    const client = new PGlite(target);
    const db2 = drizzle2(client, { schema: schema_exports });
    return { db: db2, driver, url, close: () => client.close() };
  }
  if (driver === "neon") {
    const neonPkg = await import("@neondatabase/serverless");
    const { drizzle: drizzle2 } = await import("drizzle-orm/neon-serverless");
    if (!neonPkg.neonConfig.webSocketConstructor) {
      try {
        const wsModule = await import("ws");
        neonPkg.neonConfig.webSocketConstructor = wsModule.default ?? wsModule;
      } catch {
        if (typeof globalThis.WebSocket !== "undefined") {
          neonPkg.neonConfig.webSocketConstructor = globalThis.WebSocket;
        }
      }
    }
    const pool2 = new neonPkg.Pool({ connectionString: url });
    const db2 = drizzle2(pool2, { schema: schema_exports });
    return { db: db2, driver, url, close: () => pool2.end() };
  }
  const pg = await import(PG_MODULE);
  const { drizzle } = await import(PG_DRIVER_MODULE);
  const pool = new pg.default.Pool({
    connectionString: url,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : void 0
  });
  const db = drizzle(pool, { schema: schema_exports });
  return { db, driver, url, close: () => pool.end() };
}
var cached;
function getDbHandle(explicitUrl) {
  const url = resolveDatabaseUrl(explicitUrl);
  if (cached && cached.url === url) return cached.handle;
  cached = { url, handle: createHandle(url) };
  return cached.handle;
}
async function getDb(explicitUrl) {
  return (await getDbHandle(explicitUrl)).db;
}

// src/board/validate.ts
import { z } from "zod";
var MAX_BOARD_BYTES = 1e6;
var KNOWN_STATUSES = ["green", "amber", "red", "gray"];
var projectSchema = z.object({
  id: z.string({ required_error: "project id is required" }).trim().min(1, "project id cannot be empty"),
  name: z.string().optional(),
  owner: z.string().optional(),
  // Required and closed: an unknown status breaks rendering for everyone.
  // One errorMap so a missing status and a bogus status read the same way —
  // an agent retrying after a rejection should not have to parse two formats.
  status: z.enum(KNOWN_STATUSES, {
    errorMap: () => ({
      message: "project status is required and must be one of: " + KNOWN_STATUSES.join(", ")
    })
  }),
  note: z.string().optional(),
  updated: z.string().optional(),
  flag: z.boolean().optional()
}).passthrough();
var areaSchema = z.object({
  name: z.string().optional(),
  projects: z.array(projectSchema, { required_error: "area.projects is required" })
}).passthrough();
var boardSchema = z.object({
  areas: z.array(areaSchema, { required_error: "board.areas is required" })
}).passthrough();
function formatPath(path) {
  if (path.length === 0) return "board";
  return `board.${path.map((p) => typeof p === "number" ? `[${p}]` : p).join(".").replace(/\.\[/g, "[")}`;
}
function validateBoard(input) {
  if (input === null || input === void 0) {
    return { ok: false, errors: [{ path: "board", message: "board payload is required" }] };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: "board", message: `board must be a JSON object, received ${describe(input)}` }]
    };
  }
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, errors: [{ path: "board", message: "board is not serialisable as JSON" }] };
  }
  if (serialized === void 0) {
    return { ok: false, errors: [{ path: "board", message: "board is not serialisable as JSON" }] };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_BOARD_BYTES) {
    return {
      ok: false,
      errors: [{ path: "board", message: `board is too large (${bytes} bytes, limit ${MAX_BOARD_BYTES})` }]
    };
  }
  const parsed = boardSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message
      }))
    };
  }
  const board2 = parsed.data;
  return { ok: true, board: board2, warnings: collectWarnings(board2) };
}
function collectWarnings(board2) {
  const warnings = [];
  const seen = /* @__PURE__ */ new Map();
  if (board2.areas.length === 0) warnings.push("board.areas is empty \u2014 the board will render with no content");
  board2.areas.forEach((area, areaIndex) => {
    const areaLabel = area.name?.trim() ? `"${area.name}"` : `areas[${areaIndex}]`;
    if (!area.name?.trim()) warnings.push(`${areaLabel} has no name`);
    area.projects.forEach((project, projectIndex) => {
      const where = `${areaLabel}.projects[${projectIndex}]`;
      const count = (seen.get(project.id) ?? 0) + 1;
      seen.set(project.id, count);
      if (count === 2) warnings.push(`duplicate project id "${project.id}" \u2014 the frontend keys on id`);
      if (!project.name?.trim()) warnings.push(`${where} (id "${project.id}") has no name`);
      if (project.updated !== void 0 && project.updated !== "" && !isDateLike(project.updated)) {
        warnings.push(`${where} (id "${project.id}") updated="${project.updated}" is not a YYYY-MM-DD date`);
      }
    });
  });
  return warnings;
}
function isDateLike(value) {
  return /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}
function describe(value) {
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

// src/board/service.ts
var EMPTY_BOARD = { areas: [] };
function toRecord(row) {
  return {
    board: row.data,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}
async function resolveDb(db) {
  return db ?? await getDb();
}
async function ensureRow(db) {
  const existing = await db.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID)).limit(1);
  if (existing[0]) return existing[0];
  await db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data: EMPTY_BOARD }).onConflictDoNothing({ target: board.id });
  const created = await db.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID)).limit(1);
  if (!created[0]) throw new Error("Failed to initialise the board row");
  return created[0];
}
async function initialize(options = {}) {
  const db = await resolveDb(options.db);
  return toRecord(await ensureRow(db));
}
async function getBoard(options = {}) {
  const db = await resolveDb(options.db);
  return toRecord(await ensureRow(db));
}
async function updateBoard(input, options = {}) {
  const validation = validateBoard(input);
  if (!validation.ok) throw new BoardValidationError(validation.errors);
  const db = await resolveDb(options.db);
  const source = options.source ?? "rest";
  await ensureRow(db);
  return db.transaction(async (tx) => {
    const locked = await tx.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID)).limit(1).for("update");
    const current = locked[0];
    if (!current) throw new Error("Board row disappeared mid-transaction");
    if (options.expectedVersion !== void 0 && options.expectedVersion !== current.version) {
      throw new VersionConflictError(options.expectedVersion, current.version);
    }
    const archived = await tx.insert(boardHistory).values({ version: current.version, data: current.data, source }).returning({ id: boardHistory.id });
    const historyId = archived[0]?.id;
    if (historyId === void 0) throw new Error("Failed to archive the previous board");
    const updated = await tx.update(board).set({ data: validation.board, version: current.version + 1, updatedAt: sql2`now()` }).where(eq(board.id, SINGLETON_BOARD_ID)).returning();
    const next = updated[0];
    if (!next) throw new Error("Failed to write the new board");
    return {
      record: toRecord(next),
      historyId,
      previousVersion: current.version,
      warnings: validation.warnings
    };
  });
}
async function saveHistory(data, version, options = {}) {
  const db = await resolveDb(options.db);
  const inserted = await db.insert(boardHistory).values({ version, data, source: options.source ?? "rest" }).returning({ id: boardHistory.id });
  const id = inserted[0]?.id;
  if (id === void 0) throw new Error("Failed to insert history row");
  return id;
}
async function listHistory(options = {}) {
  const db = await resolveDb(options.db);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const rows = await db.select().from(boardHistory).orderBy(desc(boardHistory.replacedAt), desc(boardHistory.id)).limit(limit);
  return rows.map((row) => {
    const areas = row.data?.areas ?? [];
    return {
      id: row.id,
      version: row.version,
      source: row.source,
      replacedAt: row.replacedAt.toISOString(),
      areaCount: areas.length,
      projectCount: areas.reduce((total, area) => total + (area.projects?.length ?? 0), 0)
    };
  });
}
async function getHistoryEntry(id, options = {}) {
  const db = await resolveDb(options.db);
  const rows = await db.select().from(boardHistory).where(eq(boardHistory.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError(`No board_history row with id ${id}`);
  return {
    id: row.id,
    version: row.version,
    source: row.source,
    replacedAt: row.replacedAt.toISOString(),
    board: row.data
  };
}
async function restoreVersion(historyId, options = {}) {
  const db = await resolveDb(options.db);
  const entry = await getHistoryEntry(historyId, { db });
  const result = await updateBoard(entry.board, { source: "restore", db });
  return { ...result, restoredFrom: entry };
}
var boardService = {
  initialize,
  getBoard,
  updateBoard,
  saveHistory,
  validateBoard,
  listHistory,
  getHistoryEntry,
  restoreVersion,
  EMPTY_BOARD
};

// src/http/cors.ts
function allowedOrigins(env = process.env) {
  return (env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim().replace(/\/$/, "")).filter(Boolean);
}
function corsHeaders(requestOrigin, env = process.env) {
  const origins = allowedOrigins(env);
  if (origins.length === 0 || !requestOrigin) return {};
  const normalized = requestOrigin.replace(/\/$/, "");
  if (!origins.includes(normalized)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": normalized,
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Token, If-Match",
    "Access-Control-Expose-Headers": "X-Board-Version, X-Board-Updated-At",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
}

// src/http/handlers.ts
var MAX_REQUEST_BYTES = 2e6;
function boardHeaders(record) {
  return {
    "X-Board-Version": String(record.version),
    "X-Board-Updated-At": record.updatedAt,
    // The board is mutable shared state; never let a proxy or browser cache it.
    "Cache-Control": "no-store, must-revalidate"
  };
}
function errorBody(code, message, extra = {}) {
  return { error: { code, message, ...extra } };
}
function unwrapBoardPayload(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload;
    if (!("areas" in record) && record.board && typeof record.board === "object") {
      return record.board;
    }
  }
  return payload;
}
function readExpectedVersion(payload, headers) {
  const ifMatch = headers["if-match"];
  if (ifMatch) {
    const parsed = Number(ifMatch.replace(/^W\//, "").replace(/"/g, "").trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const raw = payload.expectedVersion;
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  }
  return void 0;
}
function authorize(req, env) {
  const expected = env.API_TOKEN;
  if (!expected) return void 0;
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
  const supplied = bearer || req.headers["x-api-token"]?.trim();
  if (supplied && supplied === expected) return void 0;
  return {
    status: 401,
    headers: { "WWW-Authenticate": "Bearer" },
    body: errorBody("unauthorized", "A valid API token is required.")
  };
}
async function handleApi(req, ctx = {}) {
  const env = ctx.env ?? process.env;
  const cors = corsHeaders(req.headers.origin, env);
  const method = req.method.toUpperCase();
  const path = req.path.replace(/\/+$/, "") || "/";
  const respond = (response) => ({
    ...response,
    headers: { ...cors, ...response.headers }
  });
  if (method === "OPTIONS") {
    return respond({ status: 204, headers: {}, body: null });
  }
  if (path === "/api/health") {
    if (method !== "GET") return respond(methodNotAllowed(["GET"]));
    return respond(await handleHealth(ctx));
  }
  const unauthorized = authorize(req, env);
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
        db: ctx.db
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
      body: errorBody("not_found", "No route for " + method + " " + req.path)
    });
  } catch (error) {
    return respond(toErrorResponse(error));
  }
}
async function handleHealth(ctx) {
  try {
    const record = await boardService.getBoard({ db: ctx.db });
    return {
      status: 200,
      headers: { "Cache-Control": "no-store" },
      body: { ok: true, database: "up", boardVersion: record.version }
    };
  } catch (error) {
    return {
      status: 503,
      headers: { "Cache-Control": "no-store" },
      body: { ok: false, database: "down", message: messageOf(error) }
    };
  }
}
async function handleGetBoard(ctx) {
  const record = await boardService.getBoard({ db: ctx.db });
  return { status: 200, headers: boardHeaders(record), body: record };
}
async function handlePutBoard(req, ctx) {
  if (Buffer.byteLength(req.rawBody, "utf8") > MAX_REQUEST_BYTES) {
    return {
      status: 413,
      headers: {},
      body: errorBody("payload_too_large", "Request body exceeds " + MAX_REQUEST_BYTES + " bytes.")
    };
  }
  let parsed;
  try {
    parsed = req.rawBody.trim() === "" ? void 0 : JSON.parse(req.rawBody);
  } catch (error) {
    return {
      status: 400,
      headers: {},
      body: errorBody("invalid_json", "Request body is not valid JSON: " + messageOf(error))
    };
  }
  const expectedVersion = readExpectedVersion(parsed, req.headers);
  const result = await boardService.updateBoard(unwrapBoardPayload(parsed), {
    source: ctx.source ?? "rest",
    expectedVersion,
    db: ctx.db
  });
  return {
    status: 200,
    headers: boardHeaders(result.record),
    body: {
      ...result.record,
      previousVersion: result.previousVersion,
      historyId: result.historyId,
      warnings: result.warnings
    }
  };
}
function methodNotAllowed(allowed) {
  return {
    status: 405,
    headers: { Allow: allowed.join(", ") },
    body: errorBody("method_not_allowed", "Allowed methods: " + allowed.join(", "))
  };
}
function toErrorResponse(error) {
  if (error instanceof BoardValidationError) {
    return {
      status: error.status,
      headers: {},
      body: errorBody(error.code, error.message, { issues: error.issues })
    };
  }
  if (error instanceof BoardError) {
    const extra = "currentVersion" in error ? {
      currentVersion: error.currentVersion,
      expectedVersion: error.expectedVersion
    } : {};
    return { status: error.status, headers: {}, body: errorBody(error.code, error.message, extra) };
  }
  console.error("[api] unhandled error:", error);
  const message = messageOf(error);
  const isConnectivity = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect|terminated|DATABASE_URL/i.test(message);
  return isConnectivity ? {
    status: 503,
    headers: { "Retry-After": "5" },
    body: errorBody("database_unavailable", "The board database is unavailable. Your change was not saved.")
  } : { status: 500, headers: {}, body: errorBody("internal_error", "Unexpected server error.") };
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/http/vercel.ts
async function readRawBody(req) {
  if (typeof req.body === "string") return req.body;
  if (req.body !== void 0 && req.body !== null) return JSON.stringify(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function toApiRequest(req, rawBody) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    method: req.method ?? "GET",
    // A rewrite can leave the original path only in the URL, which is what we want.
    path: url.pathname,
    query: url.searchParams,
    headers,
    rawBody
  };
}
async function serveApi(req, res, ctx = {}) {
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    res.writeHead(413, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "payload_too_large", message: error instanceof Error ? error.message : "Body too large" }
      })
    );
    return;
  }
  const response = await handleApi(toApiRequest(req, rawBody), ctx);
  if (response.body === null || response.body === void 0) {
    res.writeHead(response.status, response.headers);
    res.end();
    return;
  }
  res.writeHead(response.status, { ...response.headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(response.body));
}

// functions/index.ts
async function handler(req, res) {
  await serveApi(req, res, { source: "rest" });
}
export {
  handler as default
};
