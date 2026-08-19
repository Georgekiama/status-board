import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/mcp/http.ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// src/mcp/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z2 } from "zod";

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

// src/mcp/server.ts
var MCP_SERVER_NAME = "litnmore-status-board";
var MCP_SERVER_VERSION = "1.0.0";
var projectSchema2 = z2.object({
  // Required in practice, optional here on purpose: boardService.validateBoard
  // is the single authority on what a valid board is (plan.md section 9), so
  // both interfaces reject the same payloads with the same explanations
  // rather than the MCP layer failing first with a protocol-level error.
  id: z2.string().optional().describe("REQUIRED. Stable project id, unique across the whole board."),
  name: z2.string().optional().describe("Project name as shown on the board."),
  owner: z2.string().optional().describe("Person accountable for the project."),
  status: z2.string().optional().describe(
    "REQUIRED. Exactly one of: green (moving), amber (watch), red (blocked), gray (needs update). Any other value is rejected \u2014 the board cannot render it."
  ),
  note: z2.string().optional().describe("Short free-text status note."),
  updated: z2.string().optional().describe("Date this row was last updated, as YYYY-MM-DD."),
  flag: z2.boolean().optional().describe("True when the row is flagged for Kris.")
}).passthrough();
var areaSchema2 = z2.object({
  name: z2.string().optional().describe("Area heading, e.g. Legal ops / trial support."),
  projects: z2.array(projectSchema2).optional().describe("REQUIRED. Projects in this area, in display order.")
}).passthrough();
var boardSchema2 = z2.object({
  areas: z2.array(areaSchema2).optional().describe("REQUIRED. Every area on the board, in display order.")
}).passthrough();
function projectCount(board2) {
  return board2.areas.reduce((total, area) => total + (area.projects?.length ?? 0), 0);
}
function summarise(record) {
  return {
    version: record.version,
    updatedAt: record.updatedAt,
    areaCount: record.board.areas.length,
    projectCount: projectCount(record.board)
  };
}
function textResult(payload, structured) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: structured
  };
}
function errorResult(message, detail) {
  const text2 = detail === void 0 ? message : message + "\n\n" + JSON.stringify(detail, null, 2);
  return { content: [{ type: "text", text: text2 }], isError: true };
}
function createMcpServer(ctx = {}) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions: "The Lit & More status board is a single shared document. To change anything, call get_board first, edit the object you receive, then send the COMPLETE board back through update_board \u2014 an update replaces the whole board. The previous version is always archived, so a bad write can be rolled back, but a partial board will still look to the team like rows were deleted."
    }
  );
  server.registerTool(
    "get_board",
    {
      title: "Get the status board",
      description: "Return the current Lit & More status board as JSON, together with its version number. Always call this before update_board so you edit the live board rather than a guess. Equivalent to GET /api/board.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      try {
        const record = await boardService.getBoard({ db: ctx.db });
        const payload = { ...summarise(record), createdAt: record.createdAt, board: record.board };
        return textResult(payload, payload);
      } catch (error) {
        return errorResult("Could not read the board: " + messageOf(error));
      }
    }
  );
  server.registerTool(
    "update_board",
    {
      title: "Replace the status board",
      description: "Replace the entire status board with the board you supply. The board currently stored is archived to board_history first, so this is reversible, but it is a whole-document write: anything you omit disappears from the board. Call get_board, modify the result, and send it back complete. Pass expectedVersion (the version get_board returned) to have the write rejected if somebody edited the board in the meantime. Equivalent to PUT /api/board.",
      inputSchema: {
        board: boardSchema2.describe("The COMPLETE board to store. Partial boards delete rows."),
        expectedVersion: z2.number().int().optional().describe("Version from get_board. When supplied and stale, the write is rejected instead of overwriting.")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    async ({ board: board2, expectedVersion }) => {
      let previous;
      try {
        previous = await boardService.getBoard({ db: ctx.db });
      } catch {
        previous = void 0;
      }
      try {
        const result = await boardService.updateBoard(board2, {
          source: "mcp",
          expectedVersion,
          db: ctx.db
        });
        const before = previous ? projectCount(previous.board) : void 0;
        const after = projectCount(result.record.board);
        const notes = [...result.warnings];
        if (before !== void 0 && after < before) {
          notes.push(
            "This write reduced the project count from " + before + " to " + after + ". If that was not intended, restore history id " + result.historyId + "."
          );
        }
        const payload = {
          ok: true,
          ...summarise(result.record),
          previousVersion: result.previousVersion,
          archivedAsHistoryId: result.historyId,
          warnings: notes,
          board: result.record.board
        };
        return textResult(payload, payload);
      } catch (error) {
        if (error instanceof BoardValidationError) {
          return errorResult(
            "The board was rejected and nothing was changed. Fix these problems and try again:",
            error.issues
          );
        }
        if (error instanceof BoardError) {
          return errorResult("The board was not changed: " + error.message);
        }
        return errorResult("Could not write the board: " + messageOf(error));
      }
    }
  );
  return server;
}
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/mcp/http.ts
function sendJsonRpcError(res, status, code, message) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
function authorized(req, env) {
  const expected = env.API_TOKEN;
  if (!expected) return true;
  const header = req.headers.authorization;
  const bearer = Array.isArray(header) ? header[0] : header;
  const supplied = bearer?.replace(/^Bearer\s+/i, "").trim() || (Array.isArray(req.headers["x-api-token"]) ? req.headers["x-api-token"][0] : req.headers["x-api-token"])?.trim();
  return Boolean(supplied) && supplied === expected;
}
async function handleMcpRequest(req, res, options = {}) {
  const env = options.env ?? process.env;
  if (!authorized(req, env)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    sendJsonRpcError(res, 401, -32001, "A valid API token is required.");
    return;
  }
  let parsedBody;
  if (options.rawBody !== void 0 && options.rawBody !== "") {
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
    sessionIdGenerator: void 0,
    // Plain JSON responses rather than SSE, which is what serverless needs.
    enableJsonResponse: true
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

// src/http/handlers.ts
var MAX_REQUEST_BYTES = 2e6;

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

// functions/mcp.ts
async function handler(req, res) {
  const rawBody = await readRawBody(req).catch(() => "");
  await handleMcpRequest(req, res, { rawBody });
}
export {
  handler as default
};
