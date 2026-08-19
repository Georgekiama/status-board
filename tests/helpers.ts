import assert from "node:assert/strict";
import { detectDriver, type Db } from "../src/db/client.ts";
import type { ApiRequest } from "../src/http/handlers.ts";
import { applyMigrations } from "../src/db/migrate.ts";
import * as schema from "../src/db/schema.ts";
import { boardHistory, board } from "../src/db/schema.ts";
import type { Board } from "../src/board/types.ts";

/**
 * Where the test suite runs.
 *
 * Defaults to PGlite (real Postgres compiled to WASM, no server) so `npm test`
 * works with zero setup and can never touch a live database by accident. To
 * exercise the suite against Neon or a local Postgres, set TEST_DATABASE_URL
 * explicitly — DATABASE_URL is deliberately ignored here.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "memory://";

export interface TestDb {
  db: Db;
  close(): Promise<void>;
  /** Empty both tables and reset identities, leaving a migrated schema. */
  reset(): Promise<void>;
}

/** A migrated, isolated database for one test file. */
export async function createTestDb(): Promise<TestDb> {
  const driver = detectDriver(TEST_DATABASE_URL);
  let db: Db;
  let close: () => Promise<void>;

  if (driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const client = new PGlite("memory://");
    db = drizzle(client, { schema }) as unknown as Db;
    close = () => client.close();
  } else if (driver === "neon") {
    const neonPkg = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    if (!neonPkg.neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== "undefined") {
      neonPkg.neonConfig.webSocketConstructor = globalThis.WebSocket as never;
    }
    const pool = new neonPkg.Pool({ connectionString: TEST_DATABASE_URL });
    db = drizzle(pool, { schema }) as unknown as Db;
    close = () => pool.end();
  } else {
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.default.Pool({ connectionString: TEST_DATABASE_URL });
    db = drizzle(pool, { schema }) as unknown as Db;
    close = () => pool.end();
  }

  await applyMigrations(db, driver);

  const reset = async () => {
    await db.delete(boardHistory);
    await db.delete(board);
  };
  await reset();

  return { db, close, reset };
}

/** A small but realistic board, shaped like the example in plan.md section 4. */
export function sampleBoard(overrides: Partial<Board> = {}): Board {
  return {
    areas: [
      {
        name: "Legal ops / trial support",
        projects: [
          {
            id: "fl-sweep",
            name: "Florida Trial Sweep",
            owner: "Barbrah Shiundu",
            status: "amber",
            note: "Waiting on exhibit list from local counsel.",
            updated: "2026-07-07",
            flag: true,
          },
          {
            id: "depo-prep",
            name: "Deposition Prep Tracker",
            owner: "Kris",
            status: "green",
            note: "On track.",
            updated: "2026-07-05",
            flag: false,
          },
        ],
      },
      {
        name: "Marketing",
        projects: [
          {
            id: "site-refresh",
            name: "Website Refresh",
            owner: "Unassigned",
            status: "red",
            note: "Blocked on copy review.",
            updated: "2026-06-28",
            flag: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** Deterministic label so tests can tell versions apart. */
export function labelledBoard(label: string): Board {
  return {
    areas: [
      {
        name: `Area ${label}`,
        projects: [{ id: `project-${label}`, name: `Project ${label}`, status: "green", updated: "2026-08-19" }],
      },
    ],
  };
}

/**
 * Drizzle wraps driver errors, so the Postgres message (constraint names and
 * SQLSTATE detail) lives on `error.cause`. Flatten the chain before matching.
 */
export function flattenError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    parts.push(current.message);
    const withDetail = current as Error & { detail?: string; constraint?: string; code?: string };
    for (const extra of [withDetail.detail, withDetail.constraint, withDetail.code]) {
      if (extra) parts.push(String(extra));
    }
    current = current.cause;
  }
  return parts.join(" | ");
}

/** Assert that a database call rejects with a Postgres error matching `pattern`. */
export async function assertDbRejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "expected the query to reject, but it succeeded");
  const flattened = flattenError(caught);
  assert.match(flattened, pattern);
}

/** Build an ApiRequest without going near a socket. */
export function apiRequest(
  method: string,
  path: string,
  options: { body?: unknown; rawBody?: string; headers?: Record<string, string>; query?: Record<string, string> } = {},
): ApiRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }
  const rawBody =
    options.rawBody ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  if (rawBody !== "" && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  return {
    method,
    path,
    query: new URLSearchParams(options.query ?? {}),
    headers,
    rawBody,
  };
}

/** Narrow a JSON body to a record so tests can index it. */
export function asRecord(body: unknown): Record<string, any> {
  assert.ok(body && typeof body === "object", "expected an object body, got " + JSON.stringify(body));
  return body as Record<string, any>;
}
