import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema.ts";

/**
 * All three supported drivers (node-postgres, Neon serverless, PGlite) expose
 * the same Drizzle query API including real transactions, so the rest of the
 * codebase is typed against one shape.
 */
export type Db = NodePgDatabase<typeof schema>;

export type DriverKind = "neon" | "postgres" | "pglite";

export interface DbHandle {
  db: Db;
  driver: DriverKind;
  url: string;
  close(): Promise<void>;
}

/**
 * Decide which driver a connection string wants.
 *
 * - `pglite://<dir>` or `pglite://memory` → Postgres compiled to WASM, no
 *   server required. Used for the local test suite.
 * - anything on `*.neon.tech` → Neon serverless driver (WebSocket pool, so
 *   transactions work; the neon-http driver cannot do transactions).
 * - anything else → plain node-postgres.
 */
export function detectDriver(url: string): DriverKind {
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

/** Strip the `pglite://` scheme down to a directory, or the in-memory sentinel. */
function pgliteTarget(url: string): string {
  const rest = url.replace(/^(pglite|memory):(\/\/)?/, "");
  if (rest === "" || rest === "memory" || rest === "memory://") return "memory://";
  return rest;
}

export function resolveDatabaseUrl(explicit?: string): string {
  const url = explicit ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in " +
        "(use `pglite://.pglite/statusboard` for a local no-server database).",
    );
  }
  return url;
}

async function createHandle(url: string): Promise<DbHandle> {
  const driver = detectDriver(url);

  if (driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = pgliteTarget(url);
    if (target !== "memory://") {
      // PGlite will not create intermediate directories itself.
      const { mkdir } = await import("node:fs/promises");
      await mkdir(target, { recursive: true });
    }
    const client = new PGlite(target);
    const db = drizzle(client, { schema }) as unknown as Db;
    return { db, driver, url, close: () => client.close() };
  }

  if (driver === "neon") {
    const neonPkg = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-serverless");
    // Node 18+ ships a global WebSocket; the driver needs it for pooled
    // connections (and therefore for transactions).
    if (!neonPkg.neonConfig.webSocketConstructor && typeof globalThis.WebSocket !== "undefined") {
      neonPkg.neonConfig.webSocketConstructor = globalThis.WebSocket as never;
    }
    const pool = new neonPkg.Pool({ connectionString: url });
    const db = drizzle(pool, { schema }) as unknown as Db;
    return { db, driver, url, close: () => pool.end() };
  }

  const pg = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new pg.default.Pool({
    connectionString: url,
    ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
  });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, driver, url, close: () => pool.end() };
}

/**
 * Process-wide handle. Serverless functions reuse it across warm invocations,
 * which is why the promise (not the resolved value) is cached.
 */
let cached: { url: string; handle: Promise<DbHandle> } | undefined;

export function getDbHandle(explicitUrl?: string): Promise<DbHandle> {
  const url = resolveDatabaseUrl(explicitUrl);
  if (cached && cached.url === url) return cached.handle;
  cached = { url, handle: createHandle(url) };
  return cached.handle;
}

export async function getDb(explicitUrl?: string): Promise<Db> {
  return (await getDbHandle(explicitUrl)).db;
}

/** Tear down the cached handle. Used by tests and by the CLI scripts. */
export async function closeDb(): Promise<void> {
  const current = cached;
  cached = undefined;
  if (!current) return;
  const handle = await current.handle.catch(() => undefined);
  await handle?.close();
}

export { schema };
