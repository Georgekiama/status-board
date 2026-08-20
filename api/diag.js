import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/board/types.ts
var types_exports = {};
var init_types = __esm({
  "src/board/types.ts"() {
    "use strict";
  }
});

// src/board/validate.ts
var validate_exports = {};
__export(validate_exports, {
  KNOWN_STATUSES: () => KNOWN_STATUSES,
  MAX_BOARD_BYTES: () => MAX_BOARD_BYTES,
  validateBoard: () => validateBoard
});
import { z } from "zod";
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
var MAX_BOARD_BYTES, KNOWN_STATUSES, projectSchema, areaSchema, boardSchema;
var init_validate = __esm({
  "src/board/validate.ts"() {
    "use strict";
    MAX_BOARD_BYTES = 1e6;
    KNOWN_STATUSES = ["green", "amber", "red", "gray"];
    projectSchema = z.object({
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
    areaSchema = z.object({
      name: z.string().optional(),
      projects: z.array(projectSchema, { required_error: "area.projects is required" })
    }).passthrough();
    boardSchema = z.object({
      areas: z.array(areaSchema, { required_error: "board.areas is required" })
    }).passthrough();
  }
});

// src/board/errors.ts
var errors_exports = {};
__export(errors_exports, {
  BoardError: () => BoardError,
  BoardValidationError: () => BoardValidationError,
  NotFoundError: () => NotFoundError,
  VersionConflictError: () => VersionConflictError
});
var BoardError, BoardValidationError, VersionConflictError, NotFoundError;
var init_errors = __esm({
  "src/board/errors.ts"() {
    "use strict";
    BoardError = class extends Error {
      status;
      code;
      constructor(message, code, status) {
        super(message);
        this.name = new.target.name;
        this.code = code;
        this.status = status;
      }
    };
    BoardValidationError = class extends BoardError {
      issues;
      constructor(issues) {
        super(`Board payload is invalid (${issues.length} problem${issues.length === 1 ? "" : "s"})`, "invalid_board", 400);
        this.issues = issues;
      }
    };
    VersionConflictError = class extends BoardError {
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
    NotFoundError = class extends BoardError {
      constructor(message) {
        super(message, "not_found", 404);
      }
    };
  }
});

// src/db/schema.ts
var schema_exports = {};
__export(schema_exports, {
  SINGLETON_BOARD_ID: () => SINGLETON_BOARD_ID,
  board: () => board,
  boardHistory: () => boardHistory,
  oauthClients: () => oauthClients,
  oauthCodes: () => oauthCodes,
  oauthTokens: () => oauthTokens
});
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
var SINGLETON_BOARD_ID, board, boardHistory, oauthClients, oauthCodes, oauthTokens;
var init_schema = __esm({
  "src/db/schema.ts"() {
    "use strict";
    SINGLETON_BOARD_ID = 1;
    board = pgTable(
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
    boardHistory = pgTable(
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
    oauthClients = pgTable(
      "oauth_clients",
      {
        clientId: text("client_id").primaryKey(),
        /** SHA-256 of the secret. Null for public clients (PKCE only). */
        clientSecretHash: text("client_secret_hash"),
        clientName: text("client_name"),
        /** Exact-match allow-list. A redirect_uri not in here is refused. */
        redirectUris: jsonb("redirect_uris").$type().notNull(),
        grantTypes: jsonb("grant_types").$type().notNull(),
        tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("client_secret_post"),
        scope: text("scope").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
      },
      (t) => [index("oauth_clients_created_at_idx").on(t.createdAt)]
    );
    oauthCodes = pgTable(
      "oauth_codes",
      {
        codeHash: text("code_hash").primaryKey(),
        clientId: text("client_id").notNull(),
        redirectUri: text("redirect_uri").notNull(),
        /** PKCE (RFC 7636). S256 only — plain is not accepted. */
        codeChallenge: text("code_challenge").notNull(),
        codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
        scope: text("scope").notNull(),
        /** RFC 8707 resource indicator, recorded for auditing. */
        resource: text("resource"),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        usedAt: timestamp("used_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
      },
      (t) => [index("oauth_codes_expires_at_idx").on(t.expiresAt)]
    );
    oauthTokens = pgTable(
      "oauth_tokens",
      {
        tokenHash: text("token_hash").primaryKey(),
        /** "access" | "refresh" */
        kind: text("kind").$type().notNull(),
        clientId: text("client_id").notNull(),
        scope: text("scope").notNull(),
        resource: text("resource"),
        expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
        revokedAt: timestamp("revoked_at", { withTimezone: true }),
        createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
      },
      (t) => [
        index("oauth_tokens_client_id_idx").on(t.clientId),
        index("oauth_tokens_expires_at_idx").on(t.expiresAt)
      ]
    );
  }
});

// src/db/client.ts
var client_exports = {};
__export(client_exports, {
  PGLITE_DRIVER_MODULE: () => PGLITE_DRIVER_MODULE,
  PGLITE_MIGRATOR_MODULE: () => PGLITE_MIGRATOR_MODULE,
  PGLITE_MODULE: () => PGLITE_MODULE,
  PG_DRIVER_MODULE: () => PG_DRIVER_MODULE,
  PG_MIGRATOR_MODULE: () => PG_MIGRATOR_MODULE,
  PG_MODULE: () => PG_MODULE,
  closeDb: () => closeDb,
  detectDriver: () => detectDriver,
  getDb: () => getDb,
  getDbHandle: () => getDbHandle,
  resolveDatabaseUrl: () => resolveDatabaseUrl,
  schema: () => schema_exports
});
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
function getDbHandle(explicitUrl) {
  const url = resolveDatabaseUrl(explicitUrl);
  if (cached && cached.url === url) return cached.handle;
  cached = { url, handle: createHandle(url) };
  return cached.handle;
}
async function getDb(explicitUrl) {
  return (await getDbHandle(explicitUrl)).db;
}
async function closeDb() {
  const current = cached;
  cached = void 0;
  if (!current) return;
  const handle = await current.handle.catch(() => void 0);
  await handle?.close();
}
var PGLITE_MODULE, PGLITE_DRIVER_MODULE, PGLITE_MIGRATOR_MODULE, PG_MODULE, PG_DRIVER_MODULE, PG_MIGRATOR_MODULE, cached;
var init_client = __esm({
  "src/db/client.ts"() {
    "use strict";
    init_schema();
    PGLITE_MODULE = ["@electric-sql", "pglite"].join("/");
    PGLITE_DRIVER_MODULE = ["drizzle-orm", "pglite"].join("/");
    PGLITE_MIGRATOR_MODULE = ["drizzle-orm", "pglite", "migrator"].join("/");
    PG_MODULE = ["p", "g"].join("");
    PG_DRIVER_MODULE = ["drizzle-orm", "node-postgres"].join("/");
    PG_MIGRATOR_MODULE = ["drizzle-orm", "node-postgres", "migrator"].join("/");
  }
});

// src/board/service.ts
var service_exports = {};
__export(service_exports, {
  EMPTY_BOARD: () => EMPTY_BOARD,
  boardService: () => boardService,
  getBoard: () => getBoard,
  getHistoryEntry: () => getHistoryEntry,
  initialize: () => initialize,
  listHistory: () => listHistory,
  restoreVersion: () => restoreVersion,
  saveHistory: () => saveHistory,
  updateBoard: () => updateBoard
});
import { desc, eq, sql as sql2 } from "drizzle-orm";
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
var EMPTY_BOARD, boardService;
var init_service = __esm({
  "src/board/service.ts"() {
    "use strict";
    init_client();
    init_schema();
    init_errors();
    init_validate();
    EMPTY_BOARD = { areas: [] };
    boardService = {
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
  }
});

// src/http/cors.ts
var cors_exports = {};
__export(cors_exports, {
  allowedOrigins: () => allowedOrigins,
  corsHeaders: () => corsHeaders
});
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
var init_cors = __esm({
  "src/http/cors.ts"() {
    "use strict";
  }
});

// src/oauth/crypto.ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
function randomToken(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}
function hashSecret(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function timingSafeCompare(a, b) {
  const bufferA = Buffer.from(hashSecret(a), "hex");
  const bufferB = Buffer.from(hashSecret(b), "hex");
  return timingSafeEqual(bufferA, bufferB);
}
function verifyPkce(verifier, challenge, method) {
  if (method !== "S256") return false;
  if (verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const expected = challenge.trim();
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(expected));
}
var init_crypto = __esm({
  "src/oauth/crypto.ts"() {
    "use strict";
  }
});

// src/oauth/config.ts
function isOAuthPath(path) {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized.startsWith("/oauth/")) return true;
  return normalized === OAUTH_ROUTES.protectedResourceMetadata || normalized.startsWith(OAUTH_ROUTES.protectedResourceMetadata + "/") || normalized === OAUTH_ROUTES.authorizationServerMetadata || normalized.startsWith(OAUTH_ROUTES.authorizationServerMetadata + "/");
}
function resolveBaseUrl(headers, env = process.env) {
  if (env.PUBLIC_BASE_URL) return env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const forwardedHost = headers["x-forwarded-host"];
  const host = (forwardedHost || headers.host || "localhost").split(",")[0]?.trim() ?? "localhost";
  const forwardedProto = headers["x-forwarded-proto"]?.split(",")[0]?.trim();
  const proto = forwardedProto || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return proto + "://" + host;
}
var SCOPES, DEFAULT_SCOPE, CODE_TTL_SECONDS, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_SECONDS, OAUTH_ROUTES, MCP_PATH;
var init_config = __esm({
  "src/oauth/config.ts"() {
    "use strict";
    SCOPES = ["board:read", "board:write"];
    DEFAULT_SCOPE = SCOPES.join(" ");
    CODE_TTL_SECONDS = 120;
    ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24;
    REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90;
    OAUTH_ROUTES = {
      protectedResourceMetadata: "/.well-known/oauth-protected-resource",
      authorizationServerMetadata: "/.well-known/oauth-authorization-server",
      authorize: "/oauth/authorize",
      token: "/oauth/token",
      register: "/oauth/register",
      revoke: "/oauth/revoke"
    };
    MCP_PATH = "/api/mcp";
  }
});

// src/oauth/store.ts
import { and, eq as eq2, isNull, lt, sql as sql3 } from "drizzle-orm";
async function resolve(db) {
  return db ?? await getDb();
}
function secondsFromNow(seconds) {
  return new Date(Date.now() + seconds * 1e3);
}
async function registerClient(input, options = {}) {
  const db = await resolve(options.db);
  const clientId = "sbc_" + randomToken(16);
  const authMethod = input.tokenEndpointAuthMethod ?? "client_secret_post";
  const isPublic = authMethod === "none";
  const clientSecret = isPublic ? void 0 : randomToken(32);
  const row = {
    clientId,
    clientSecretHash: clientSecret ? hashSecret(clientSecret) : null,
    clientName: input.clientName ?? null,
    redirectUris: input.redirectUris,
    grantTypes: input.grantTypes ?? ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: authMethod,
    scope: input.scope ?? DEFAULT_SCOPE
  };
  const inserted = await db.insert(oauthClients).values(row).returning();
  const created = inserted[0];
  if (!created) throw new Error("Failed to register the OAuth client");
  return {
    clientId: created.clientId,
    clientSecret,
    clientName: created.clientName,
    redirectUris: created.redirectUris,
    grantTypes: created.grantTypes,
    tokenEndpointAuthMethod: created.tokenEndpointAuthMethod,
    scope: created.scope,
    createdAt: created.createdAt.toISOString()
  };
}
async function findClient(clientId, options = {}) {
  const db = await resolve(options.db);
  const rows = await db.select().from(oauthClients).where(eq2(oauthClients.clientId, clientId)).limit(1);
  return rows[0];
}
async function verifyClientSecret(clientId, suppliedSecret, options = {}) {
  const client = await findClient(clientId, options);
  if (!client) return false;
  if (!client.clientSecretHash) return true;
  if (!suppliedSecret) return false;
  return timingSafeCompare(hashSecret(suppliedSecret), client.clientSecretHash);
}
async function createAuthorizationCode(input, options = {}) {
  const db = await resolve(options.db);
  const code = randomToken(32);
  await db.insert(oauthCodes).values({
    codeHash: hashSecret(code),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    resource: input.resource ?? null,
    expiresAt: secondsFromNow(CODE_TTL_SECONDS)
  });
  return code;
}
async function consumeAuthorizationCode(code, options = {}) {
  const db = await resolve(options.db);
  const codeHash = hashSecret(code);
  const claimed = await db.update(oauthCodes).set({ usedAt: sql3`now()` }).where(and(eq2(oauthCodes.codeHash, codeHash), isNull(oauthCodes.usedAt))).returning();
  const row = claimed[0];
  if (!row) return { ok: false, reason: "unknown_or_reused" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, reason: "expired" };
  return { ok: true, code: row };
}
async function issueTokens(input, options = {}) {
  const db = await resolve(options.db);
  const accessToken = "sba_" + randomToken(32);
  const refreshToken = "sbr_" + randomToken(32);
  await db.insert(oauthTokens).values([
    {
      tokenHash: hashSecret(accessToken),
      kind: "access",
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource ?? null,
      expiresAt: secondsFromNow(ACCESS_TOKEN_TTL_SECONDS)
    },
    {
      tokenHash: hashSecret(refreshToken),
      kind: "refresh",
      clientId: input.clientId,
      scope: input.scope,
      resource: input.resource ?? null,
      expiresAt: secondsFromNow(REFRESH_TOKEN_TTL_SECONDS)
    }
  ]);
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS, scope: input.scope };
}
async function findLiveToken(token, kind, db) {
  const rows = await db.select().from(oauthTokens).where(and(eq2(oauthTokens.tokenHash, hashSecret(token)), eq2(oauthTokens.kind, kind))).limit(1);
  const row = rows[0];
  if (!row) return void 0;
  if (row.revokedAt) return void 0;
  if (row.expiresAt.getTime() <= Date.now()) return void 0;
  return row;
}
async function verifyAccessToken(token, options = {}) {
  const db = await resolve(options.db);
  const row = await findLiveToken(token, "access", db);
  if (!row) return void 0;
  return { kind: "oauth", clientId: row.clientId, scope: row.scope };
}
async function rotateRefreshToken(refreshToken, clientId, options = {}) {
  const db = await resolve(options.db);
  const row = await findLiveToken(refreshToken, "refresh", db);
  if (!row || row.clientId !== clientId) return void 0;
  await db.update(oauthTokens).set({ revokedAt: sql3`now()` }).where(eq2(oauthTokens.tokenHash, row.tokenHash));
  return issueTokens({ clientId: row.clientId, scope: row.scope, resource: row.resource }, { db });
}
async function revokeToken(token, options = {}) {
  const db = await resolve(options.db);
  await db.update(oauthTokens).set({ revokedAt: sql3`now()` }).where(eq2(oauthTokens.tokenHash, hashSecret(token)));
}
var init_store = __esm({
  "src/oauth/store.ts"() {
    "use strict";
    init_client();
    init_schema();
    init_config();
    init_crypto();
  }
});

// src/oauth/authenticate.ts
function extractBearer(headers) {
  const header = headers.authorization;
  if (header && /^bearer\s+/i.test(header)) {
    const value = header.replace(/^bearer\s+/i, "").trim();
    if (value) return value;
  }
  const alternative = headers["x-api-token"]?.trim();
  return alternative || void 0;
}
async function authenticate(headers, options = {}) {
  const env = options.env ?? process.env;
  const staticToken = env.API_TOKEN;
  const presented = extractBearer(headers);
  if (!presented) {
    if (!staticToken) return { ok: true, identity: { kind: "anonymous", scope: "board:read board:write" } };
    return { ok: false, reason: "missing" };
  }
  if (staticToken && timingSafeCompare(presented, staticToken)) {
    return { ok: true, identity: { kind: "static", scope: "board:read board:write" } };
  }
  const oauthIdentity = await verifyAccessToken(presented, { db: options.db });
  if (oauthIdentity) return { ok: true, identity: oauthIdentity };
  return { ok: false, reason: "invalid" };
}
var init_authenticate = __esm({
  "src/oauth/authenticate.ts"() {
    "use strict";
    init_crypto();
    init_store();
  }
});

// src/oauth/metadata.ts
function protectedResourceMetadata(baseUrl) {
  return {
    resource: baseUrl + MCP_PATH,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: [...SCOPES],
    resource_name: "Lit & More Status Board",
    resource_documentation: baseUrl + "/"
  };
}
function authorizationServerMetadata(baseUrl) {
  return {
    issuer: baseUrl,
    authorization_endpoint: baseUrl + OAUTH_ROUTES.authorize,
    token_endpoint: baseUrl + OAUTH_ROUTES.token,
    registration_endpoint: baseUrl + OAUTH_ROUTES.register,
    revocation_endpoint: baseUrl + OAUTH_ROUTES.revoke,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. `plain` gives no protection against a stolen code.
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    service_documentation: baseUrl + "/"
  };
}
function challengeHeader(baseUrl, error, description) {
  const parts = [
    'Bearer realm="status-board"',
    'resource_metadata="' + baseUrl + OAUTH_ROUTES.protectedResourceMetadata + '"'
  ];
  if (error) parts.push('error="' + error + '"');
  if (description) parts.push('error_description="' + description.replace(/"/g, "'") + '"');
  return parts.join(", ");
}
var init_metadata = __esm({
  "src/oauth/metadata.ts"() {
    "use strict";
    init_config();
  }
});

// src/oauth/page.ts
function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function renderAuthorizePage(params) {
  const hidden = Object.entries(params.fields).filter(([, value]) => value !== void 0 && value !== "").map(
    ([name, value]) => '<input type="hidden" name="' + escapeHtml(name) + '" value="' + escapeHtml(value) + '" />'
  ).join("\n      ");
  const who = params.clientName ? escapeHtml(params.clientName) : "An application";
  const error = params.error ? '<p class="error" role="alert">' + escapeHtml(params.error) + "</p>" : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize \u2014 Lit &amp; More Status Board</title>
<style>
  :root{
    --ink:#2A2A22; --ink-soft:#5B5A4E; --cream:#F1ECDD; --card:#FAF7EE;
    --olive:#5B6144; --line:#DFD8C2; --rust:#B14926;
  }
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:var(--cream);color:var(--ink);
    font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;}
  .card{background:var(--card);border:1px solid var(--line);border-radius:8px;
    padding:28px 30px;max-width:26rem;width:100%;}
  h1{font-size:19px;margin:0 0 6px;}
  .sub{font-size:13.5px;color:var(--ink-soft);margin:0 0 20px;line-height:1.55;}
  .who{font-weight:600;color:var(--ink);}
  label{display:block;font-size:12.5px;font-weight:600;margin-bottom:6px;}
  input[type=password]{width:100%;font-size:14px;padding:10px 12px;border:1px solid var(--line);
    border-radius:5px;background:#fff;font-family:inherit;}
  input[type=password]:focus{outline:2px solid var(--olive);outline-offset:1px;}
  button{margin-top:16px;width:100%;background:var(--olive);color:#fff;border:none;border-radius:5px;
    padding:11px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;}
  button:hover{opacity:.92;}
  .error{background:#F3DCD2;border:1px solid #D69377;color:#8A3418;font-size:13px;
    border-radius:5px;padding:9px 11px;margin:0 0 16px;}
  .scopes{margin:18px 0 0;padding:12px 14px;background:var(--cream);border-radius:5px;
    font-size:12.5px;color:var(--ink-soft);line-height:1.6;}
  .scopes strong{color:var(--ink);}
  .foot{margin:18px 0 0;font-size:11.5px;color:var(--ink-soft);line-height:1.5;}
</style>
</head>
<body>
  <form class="card" method="post" action="/oauth/authorize">
    <h1>Authorize access</h1>
    <p class="sub"><span class="who">${who}</span> is asking to read and update the
      Lit &amp; More status board. Enter the board password to allow it.</p>
    ${error}
    <label for="password">Board password</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
      autofocus required />
    ${hidden}
    <button type="submit">Allow access</button>
    <div class="scopes">
      This grants: <strong>read the board</strong> and <strong>replace the board</strong>.
      Every change is version-stamped and the previous version is kept, so an
      unwanted edit can be rolled back.
    </div>
    <p class="foot">If you were not expecting this, close this page. Access can be
      revoked at any time from the server.</p>
  </form>
</body>
</html>
`;
}
function renderErrorPage(title, detail) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} \u2014 Status Board</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#F1ECDD;color:#2A2A22;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;padding:24px;}
  .card{background:#FAF7EE;border:1px solid #DFD8C2;border-radius:8px;padding:26px 28px;max-width:28rem;}
  h1{font-size:18px;margin:0 0 8px;}
  p{font-size:13.5px;color:#5B5A4E;line-height:1.6;margin:0;}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;}
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </div>
</body>
</html>
`;
}
var init_page = __esm({
  "src/oauth/page.ts"() {
    "use strict";
  }
});

// src/oauth/handlers.ts
function json(status, body, headers = {}) {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body };
}
function html(status, markup) {
  return {
    status,
    headers: { "Cache-Control": "no-store" },
    body: null,
    text: markup,
    contentType: "text/html; charset=utf-8"
  };
}
function redirect(location) {
  return {
    status: 302,
    headers: { Location: location, "Cache-Control": "no-store" },
    body: null,
    text: "",
    contentType: "text/plain; charset=utf-8"
  };
}
function oauthError(status, error, description) {
  return json(status, { error, error_description: description });
}
function redirectError(redirectUri, error, description, state) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return redirect(url.toString());
}
function methodNotAllowed(allowed) {
  return json(405, { error: "invalid_request", error_description: "Allowed: " + allowed.join(", ") }, {
    Allow: allowed.join(", ")
  });
}
function parseBody(req) {
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(req.rawBody || "{}");
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(parsed)) {
        if (value !== void 0 && value !== null) params.set(key, String(value));
      }
      return params;
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(req.rawBody ?? "");
}
function clientCredentials(req, body) {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        return {
          id: decodeURIComponent(decoded.slice(0, separator)),
          secret: decodeURIComponent(decoded.slice(separator + 1))
        };
      }
    } catch {
    }
  }
  return { id: body.get("client_id") ?? void 0, secret: body.get("client_secret") ?? void 0 };
}
function isAcceptableRedirectUri(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "javascript:" || scheme === "data:" || scheme === "vbscript:" || scheme === "file:") return false;
  if (scheme === "http:") {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }
  return true;
}
async function handleOAuth(req, ctx = {}) {
  const env = ctx.env ?? process.env;
  const baseUrl = resolveBaseUrl(req.headers, env);
  const path = req.path.replace(/\/+$/, "") || "/";
  const method = req.method.toUpperCase();
  if (method === "OPTIONS") return { status: 204, headers: {}, body: null };
  if (path === OAUTH_ROUTES.protectedResourceMetadata || path.startsWith(OAUTH_ROUTES.protectedResourceMetadata + "/")) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
    return json(200, protectedResourceMetadata(baseUrl));
  }
  if (path === OAUTH_ROUTES.authorizationServerMetadata || path.startsWith(OAUTH_ROUTES.authorizationServerMetadata + "/")) {
    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(["GET"]);
    return json(200, authorizationServerMetadata(baseUrl));
  }
  if (path === OAUTH_ROUTES.register) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleRegister(req, ctx);
  }
  if (path === OAUTH_ROUTES.authorize) {
    if (method === "GET") return handleAuthorizeGet(req, ctx);
    if (method === "POST") return handleAuthorizePost(req, ctx);
    return methodNotAllowed(["GET", "POST"]);
  }
  if (path === OAUTH_ROUTES.token) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleToken(req, ctx);
  }
  if (path === OAUTH_ROUTES.revoke) {
    if (method !== "POST") return methodNotAllowed(["POST"]);
    return handleRevoke(req, ctx);
  }
  return json(404, { error: "invalid_request", error_description: "No such OAuth endpoint: " + req.path });
}
async function handleRegister(req, ctx) {
  let payload;
  try {
    payload = JSON.parse(req.rawBody || "{}");
  } catch {
    return oauthError(400, "invalid_client_metadata", "Request body must be JSON.");
  }
  const redirectUris = payload.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris is required and must be a non-empty array.");
  }
  if (!redirectUris.every((uri) => typeof uri === "string" && isAcceptableRedirectUri(uri))) {
    return oauthError(
      400,
      "invalid_redirect_uri",
      "Every redirect_uri must be an absolute URL. Plain http is only allowed for loopback addresses."
    );
  }
  const requestedMethod = typeof payload.token_endpoint_auth_method === "string" ? payload.token_endpoint_auth_method : "client_secret_post";
  if (!["client_secret_post", "client_secret_basic", "none"].includes(requestedMethod)) {
    return oauthError(400, "invalid_client_metadata", "Unsupported token_endpoint_auth_method: " + requestedMethod);
  }
  const grantTypes = Array.isArray(payload.grant_types) ? payload.grant_types.filter((g) => typeof g === "string") : ["authorization_code", "refresh_token"];
  const unsupported = grantTypes.filter((g) => g !== "authorization_code" && g !== "refresh_token");
  if (unsupported.length > 0) {
    return oauthError(400, "invalid_client_metadata", "Unsupported grant_types: " + unsupported.join(", "));
  }
  const client = await registerClient(
    {
      redirectUris,
      clientName: typeof payload.client_name === "string" ? payload.client_name : void 0,
      grantTypes,
      tokenEndpointAuthMethod: requestedMethod,
      scope: typeof payload.scope === "string" && payload.scope.trim() ? payload.scope : DEFAULT_SCOPE
    },
    { db: ctx.db }
  );
  return json(201, {
    client_id: client.clientId,
    ...client.clientSecret ? { client_secret: client.clientSecret } : {},
    client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1e3),
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: client.grantTypes,
    response_types: ["code"],
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    scope: client.scope
  });
}
function readAuthorizeParams(source) {
  return {
    responseType: source.get("response_type") ?? "",
    clientId: source.get("client_id") ?? "",
    redirectUri: source.get("redirect_uri") ?? "",
    codeChallenge: source.get("code_challenge") ?? "",
    codeChallengeMethod: source.get("code_challenge_method") ?? "",
    scope: source.get("scope") ?? DEFAULT_SCOPE,
    state: source.get("state") ?? "",
    resource: source.get("resource") ?? ""
  };
}
function hiddenFields(params) {
  return {
    response_type: params.responseType,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: params.codeChallengeMethod,
    scope: params.scope,
    state: params.state,
    resource: params.resource
  };
}
async function validateAuthorize(params, ctx) {
  if (!params.clientId) {
    return { fatal: html(400, renderErrorPage("Missing client", "No client_id was supplied.")) };
  }
  const client = await findClient(params.clientId, { db: ctx.db });
  if (!client) {
    return {
      fatal: html(
        400,
        renderErrorPage(
          "Unknown client",
          "This client is not registered with the status board. If the connector was set up a long time ago, remove and re-add it so it can register again."
        )
      )
    };
  }
  if (!params.redirectUri || !client.redirectUris.includes(params.redirectUri)) {
    return {
      fatal: html(
        400,
        renderErrorPage(
          "Invalid redirect URI",
          "The redirect_uri does not exactly match one registered by this client, so the request was refused."
        )
      )
    };
  }
  if (params.responseType !== "code") {
    return {
      client,
      recoverable: redirectError(
        params.redirectUri,
        "unsupported_response_type",
        "Only response_type=code is supported.",
        params.state
      )
    };
  }
  if (!params.codeChallenge) {
    return {
      client,
      recoverable: redirectError(
        params.redirectUri,
        "invalid_request",
        "PKCE is required: code_challenge is missing.",
        params.state
      )
    };
  }
  if (params.codeChallengeMethod !== "S256") {
    return {
      client,
      recoverable: redirectError(
        params.redirectUri,
        "invalid_request",
        "code_challenge_method must be S256.",
        params.state
      )
    };
  }
  return { client };
}
async function handleAuthorizeGet(req, ctx) {
  const params = readAuthorizeParams(req.query);
  const validation = await validateAuthorize(params, ctx);
  if (validation.fatal) return validation.fatal;
  if (validation.recoverable) return validation.recoverable;
  if (!(ctx.env ?? process.env).BOARD_PASSWORD) {
    return html(
      503,
      renderErrorPage(
        "Not configured",
        "This board has no BOARD_PASSWORD set, so authorization cannot be granted. Set it in the deployment's environment variables and try again."
      )
    );
  }
  return html(200, renderAuthorizePage({ fields: hiddenFields(params), clientName: validation.client?.clientName }));
}
async function handleAuthorizePost(req, ctx) {
  const body = parseBody(req);
  const params = readAuthorizeParams(body);
  const validation = await validateAuthorize(params, ctx);
  if (validation.fatal) return validation.fatal;
  if (validation.recoverable) return validation.recoverable;
  const expected = (ctx.env ?? process.env).BOARD_PASSWORD;
  if (!expected) {
    return html(
      503,
      renderErrorPage(
        "Not configured",
        "This board has no BOARD_PASSWORD set, so authorization cannot be granted."
      )
    );
  }
  const supplied = body.get("password") ?? "";
  if (!supplied || !timingSafeCompare(supplied, expected)) {
    return html(
      401,
      renderAuthorizePage({
        fields: hiddenFields(params),
        clientName: validation.client?.clientName,
        error: "That password is not correct."
      })
    );
  }
  const code = await createAuthorizationCode(
    {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      scope: params.scope || DEFAULT_SCOPE,
      resource: params.resource || void 0
    },
    { db: ctx.db }
  );
  const target = new URL(params.redirectUri);
  target.searchParams.set("code", code);
  if (params.state) target.searchParams.set("state", params.state);
  return redirect(target.toString());
}
async function handleToken(req, ctx) {
  const body = parseBody(req);
  const grantType = body.get("grant_type") ?? "";
  const credentials = clientCredentials(req, body);
  if (!credentials.id) {
    return oauthError(401, "invalid_client", "client_id is required.");
  }
  if (!await verifyClientSecret(credentials.id, credentials.secret, { db: ctx.db })) {
    return oauthError(401, "invalid_client", "Client authentication failed.");
  }
  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(body, credentials.id, ctx);
  }
  if (grantType === "refresh_token") {
    const refreshToken = body.get("refresh_token") ?? "";
    if (!refreshToken) return oauthError(400, "invalid_request", "refresh_token is required.");
    const rotated = await rotateRefreshToken(refreshToken, credentials.id, { db: ctx.db });
    if (!rotated) return oauthError(400, "invalid_grant", "The refresh token is expired, revoked or unknown.");
    return tokenResponse(rotated);
  }
  return oauthError(
    400,
    "unsupported_grant_type",
    "Supported grant types: authorization_code, refresh_token."
  );
}
async function handleAuthorizationCodeGrant(body, clientId, ctx) {
  const code = body.get("code") ?? "";
  const redirectUri = body.get("redirect_uri") ?? "";
  const verifier = body.get("code_verifier") ?? "";
  if (!code) return oauthError(400, "invalid_request", "code is required.");
  if (!verifier) return oauthError(400, "invalid_request", "code_verifier is required (PKCE).");
  const consumed = await consumeAuthorizationCode(code, { db: ctx.db });
  if (!consumed.ok) {
    return oauthError(
      400,
      "invalid_grant",
      consumed.reason === "expired" ? "The authorization code has expired. Start the flow again." : "The authorization code is unknown or has already been used."
    );
  }
  const record = consumed.code;
  if (record.clientId !== clientId) {
    return oauthError(400, "invalid_grant", "This authorization code was issued to a different client.");
  }
  if (redirectUri && redirectUri !== record.redirectUri) {
    return oauthError(400, "invalid_grant", "redirect_uri does not match the authorization request.");
  }
  if (!verifyPkce(verifier, record.codeChallenge, record.codeChallengeMethod)) {
    return oauthError(400, "invalid_grant", "The PKCE code_verifier does not match the code_challenge.");
  }
  const issued = await issueTokens(
    { clientId, scope: record.scope, resource: record.resource },
    { db: ctx.db }
  );
  return tokenResponse(issued);
}
function tokenResponse(issued) {
  return json(200, {
    access_token: issued.accessToken,
    token_type: "Bearer",
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: issued.scope
  });
}
async function handleRevoke(req, ctx) {
  const body = parseBody(req);
  const credentials = clientCredentials(req, body);
  const token = body.get("token") ?? "";
  if (!credentials.id) return oauthError(401, "invalid_client", "client_id is required.");
  if (!await verifyClientSecret(credentials.id, credentials.secret, { db: ctx.db })) {
    return oauthError(401, "invalid_client", "Client authentication failed.");
  }
  if (token) await revokeToken(token, { db: ctx.db });
  return { status: 200, headers: JSON_HEADERS, body: {} };
}
var JSON_HEADERS;
var init_handlers = __esm({
  "src/oauth/handlers.ts"() {
    "use strict";
    init_config();
    init_crypto();
    init_metadata();
    init_page();
    init_store();
    init_crypto();
    JSON_HEADERS = { "Cache-Control": "no-store", Pragma: "no-cache" };
  }
});

// src/http/handlers.ts
var handlers_exports = {};
__export(handlers_exports, {
  MAX_REQUEST_BYTES: () => MAX_REQUEST_BYTES,
  handleApi: () => handleApi,
  toErrorResponse: () => toErrorResponse,
  unwrapBoardPayload: () => unwrapBoardPayload
});
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
async function authorize(req, ctx, baseUrl) {
  const result = await authenticate(req.headers, { db: ctx.db, env: ctx.env ?? process.env });
  if (result.ok) return void 0;
  return {
    status: 401,
    headers: {
      "WWW-Authenticate": challengeHeader(
        baseUrl,
        result.reason === "invalid" ? "invalid_token" : void 0,
        result.reason === "invalid" ? "The credential is expired, revoked or unknown." : void 0
      )
    },
    body: errorBody(
      "unauthorized",
      result.reason === "invalid" ? "The credential presented is expired, revoked or unknown." : "Authentication is required. Use an API token, or authorize through OAuth."
    )
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
    if (method !== "GET") return respond(methodNotAllowed2(["GET"]));
    return respond(await handleHealth(ctx));
  }
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
      return respond(methodNotAllowed2(["GET", "PUT"]));
    }
    if (path === "/api/board/history") {
      if (method !== "GET") return respond(methodNotAllowed2(["GET"]));
      const limit = Number(req.query.get("limit") ?? "50");
      const versions = await boardService.listHistory({
        limit: Number.isFinite(limit) ? limit : 50,
        db: ctx.db
      });
      return respond({ status: 200, headers: { "Cache-Control": "no-store" }, body: { versions } });
    }
    const historyEntry = /^\/api\/board\/history\/(\d+)$/.exec(path);
    if (historyEntry) {
      if (method !== "GET") return respond(methodNotAllowed2(["GET"]));
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
function methodNotAllowed2(allowed) {
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
var MAX_REQUEST_BYTES;
var init_handlers2 = __esm({
  "src/http/handlers.ts"() {
    "use strict";
    init_errors();
    init_service();
    init_cors();
    init_authenticate();
    init_config();
    init_handlers();
    init_metadata();
    MAX_REQUEST_BYTES = 2e6;
  }
});

// src/http/vercel.ts
var vercel_exports = {};
__export(vercel_exports, {
  readRawBody: () => readRawBody,
  serveApi: () => serveApi
});
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
  if (response.text !== void 0) {
    res.writeHead(response.status, {
      ...response.headers,
      "Content-Type": response.contentType ?? "text/plain; charset=utf-8"
    });
    res.end(response.text);
    return;
  }
  if (response.body === null || response.body === void 0) {
    res.writeHead(response.status, response.headers);
    res.end();
    return;
  }
  res.writeHead(response.status, { ...response.headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(response.body));
}
var init_vercel = __esm({
  "src/http/vercel.ts"() {
    "use strict";
    init_handlers2();
  }
});

// src/mcp/server.ts
var server_exports = {};
__export(server_exports, {
  MCP_SERVER_NAME: () => MCP_SERVER_NAME,
  MCP_SERVER_VERSION: () => MCP_SERVER_VERSION,
  createMcpServer: () => createMcpServer
});
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z2 } from "zod";
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
        return errorResult("Could not read the board: " + messageOf2(error));
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
        return errorResult("Could not write the board: " + messageOf2(error));
      }
    }
  );
  return server;
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}
var MCP_SERVER_NAME, MCP_SERVER_VERSION, projectSchema2, areaSchema2, boardSchema2;
var init_server = __esm({
  "src/mcp/server.ts"() {
    "use strict";
    init_errors();
    init_service();
    MCP_SERVER_NAME = "litnmore-status-board";
    MCP_SERVER_VERSION = "1.0.0";
    projectSchema2 = z2.object({
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
    areaSchema2 = z2.object({
      name: z2.string().optional().describe("Area heading, e.g. Legal ops / trial support."),
      projects: z2.array(projectSchema2).optional().describe("REQUIRED. Projects in this area, in display order.")
    }).passthrough();
    boardSchema2 = z2.object({
      areas: z2.array(areaSchema2).optional().describe("REQUIRED. Every area on the board, in display order.")
    }).passthrough();
  }
});

// src/mcp/http.ts
var http_exports = {};
__export(http_exports, {
  handleMcpRequest: () => handleMcpRequest
});
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
function headerRecord(req) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}
function sendJsonRpcError(res, status, code, message, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}
async function handleMcpRequest(req, res, options = {}) {
  const env = options.env ?? process.env;
  const headers = headerRecord(req);
  const baseUrl = resolveBaseUrl(headers, env);
  const auth = await authenticate(headers, { db: options.ctx?.db, env });
  if (!auth.ok) {
    sendJsonRpcError(
      res,
      401,
      -32001,
      auth.reason === "invalid" ? "The credential presented is expired, revoked or unknown." : "Authentication is required.",
      {
        "WWW-Authenticate": challengeHeader(
          baseUrl,
          auth.reason === "invalid" ? "invalid_token" : void 0,
          auth.reason === "invalid" ? "The credential is expired, revoked or unknown." : void 0
        )
      }
    );
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
var init_http = __esm({
  "src/mcp/http.ts"() {
    "use strict";
    init_authenticate();
    init_config();
    init_metadata();
    init_server();
  }
});

// functions/diag.ts
function describe2(error) {
  if (!(error instanceof Error)) return { error: String(error) };
  const cause = error.cause instanceof Error ? " <- caused by: " + error.cause.message : "";
  const frame = (error.stack ?? "").split("\n").slice(1).map((line) => line.trim()).find((line) => line.startsWith("at ") && !line.includes("diag"));
  return {
    error: error.message + cause,
    code: error.code,
    where: frame
  };
}
async function probe() {
  const probes = [
    ["zod", () => import("zod")],
    ["drizzle-orm", () => import("drizzle-orm")],
    ["drizzle-orm/pg-core", () => import("drizzle-orm/pg-core")],
    ["@neondatabase/serverless", () => import("@neondatabase/serverless")],
    ["drizzle-orm/neon-serverless", () => import("drizzle-orm/neon-serverless")],
    ["ws", () => import("ws")],
    ["@modelcontextprotocol/sdk (mcp)", () => import("@modelcontextprotocol/sdk/server/mcp.js")],
    ["@modelcontextprotocol/sdk (http)", () => import("@modelcontextprotocol/sdk/server/streamableHttp.js")],
    ["src/board/types", () => Promise.resolve().then(() => (init_types(), types_exports))],
    ["src/board/validate", () => Promise.resolve().then(() => (init_validate(), validate_exports))],
    ["src/board/errors", () => Promise.resolve().then(() => (init_errors(), errors_exports))],
    ["src/db/schema", () => Promise.resolve().then(() => (init_schema(), schema_exports))],
    ["src/db/client", () => Promise.resolve().then(() => (init_client(), client_exports))],
    ["src/board/service", () => Promise.resolve().then(() => (init_service(), service_exports))],
    ["src/http/cors", () => Promise.resolve().then(() => (init_cors(), cors_exports))],
    ["src/http/handlers", () => Promise.resolve().then(() => (init_handlers2(), handlers_exports))],
    ["src/http/vercel", () => Promise.resolve().then(() => (init_vercel(), vercel_exports))],
    ["src/mcp/server", () => Promise.resolve().then(() => (init_server(), server_exports))],
    ["src/mcp/http", () => Promise.resolve().then(() => (init_http(), http_exports))]
  ];
  const results = [];
  for (const [name, load] of probes) {
    try {
      await load();
      results.push({ module: name, ok: true });
    } catch (error) {
      results.push({ module: name, ok: false, ...describe2(error) });
    }
  }
  return results;
}
async function handler(_req, res) {
  let probes = [];
  let probeError;
  try {
    probes = await probe();
  } catch (error) {
    probeError = describe2(error).error;
  }
  const failed = probes.filter((result) => !result.ok);
  const body = {
    ok: failed.length === 0,
    summary: failed.length === 0 ? "Every module in the graph loaded. If /api/board still fails, the fault is not module loading." : "First failing module: " + failed[0]?.module,
    node: process.version,
    platform: process.platform,
    env: {
      // Presence only. Never return the values themselves.
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      API_TOKEN: Boolean(process.env.API_TOKEN),
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? "set" : "empty (same-origin)",
      VERCEL_ENV: process.env.VERCEL_ENV ?? null,
      VERCEL_GIT_COMMIT_SHA: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null
    },
    probeError,
    failed,
    all: probes
  };
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body, null, 2));
}
export {
  handler as default
};
