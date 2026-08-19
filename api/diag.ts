/**
 * Deployment diagnostic.
 *
 * The other functions fail with FUNCTION_INVOCATION_FAILED, which is a crash at
 * module load: no handler code runs, so the response carries no information. This
 * endpoint imports nothing at the top level, then probes each module of the real
 * graph individually inside try/catch and reports which one fails and why.
 *
 * That turns an opaque 500 into the actual error message and stack, without
 * needing access to the platform's runtime logs.
 *
 * The probe specifiers are deliberately literal, so the bundler processes them
 * exactly as it processes the real functions' imports.
 *
 * Only the PRESENCE of environment variables is reported, never their values.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

interface ProbeResult {
  module: string;
  ok: boolean;
  error?: string;
  code?: string;
  where?: string;
}

function describe(error: unknown): { error: string; code?: string; where?: string } {
  if (!(error instanceof Error)) return { error: String(error) };
  const cause = error.cause instanceof Error ? " <- caused by: " + error.cause.message : "";
  const frame = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") && !line.includes("diag"));
  return {
    error: error.message + cause,
    code: (error as { code?: string }).code,
    where: frame,
  };
}

/**
 * Probes run in dependency order: third-party packages first, then this
 * project's modules from the leaves inward. The first failure is the culprit,
 * and anything importing it fails as a consequence.
 */
async function probe(): Promise<ProbeResult[]> {
  const probes: Array<[string, () => Promise<unknown>]> = [
    ["zod", () => import("zod")],
    ["drizzle-orm", () => import("drizzle-orm")],
    ["drizzle-orm/pg-core", () => import("drizzle-orm/pg-core")],
    ["@neondatabase/serverless", () => import("@neondatabase/serverless")],
    ["drizzle-orm/neon-serverless", () => import("drizzle-orm/neon-serverless")],
    ["ws", () => import("ws")],
    ["@modelcontextprotocol/sdk (mcp)", () => import("@modelcontextprotocol/sdk/server/mcp.js")],
    ["@modelcontextprotocol/sdk (http)", () => import("@modelcontextprotocol/sdk/server/streamableHttp.js")],
    ["src/board/types", () => import("../src/board/types")],
    ["src/board/validate", () => import("../src/board/validate")],
    ["src/board/errors", () => import("../src/board/errors")],
    ["src/db/schema", () => import("../src/db/schema")],
    ["src/db/client", () => import("../src/db/client")],
    ["src/board/service", () => import("../src/board/service")],
    ["src/http/cors", () => import("../src/http/cors")],
    ["src/http/handlers", () => import("../src/http/handlers")],
    ["src/http/vercel", () => import("../src/http/vercel")],
    ["src/mcp/server", () => import("../src/mcp/server")],
    ["src/mcp/http", () => import("../src/mcp/http")],
  ];

  const results: ProbeResult[] = [];
  for (const [name, load] of probes) {
    try {
      await load();
      results.push({ module: name, ok: true });
    } catch (error) {
      results.push({ module: name, ok: false, ...describe(error) });
    }
  }
  return results;
}

export default async function handler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  let probes: ProbeResult[] = [];
  let probeError: string | undefined;
  try {
    probes = await probe();
  } catch (error) {
    probeError = describe(error).error;
  }

  const failed = probes.filter((result) => !result.ok);

  const body = {
    ok: failed.length === 0,
    summary:
      failed.length === 0
        ? "Every module in the graph loaded. If /api/board still fails, the fault is not module loading."
        : "First failing module: " + failed[0]?.module,
    node: process.version,
    platform: process.platform,
    env: {
      // Presence only. Never return the values themselves.
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      API_TOKEN: Boolean(process.env.API_TOKEN),
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? "set" : "empty (same-origin)",
      VERCEL_ENV: process.env.VERCEL_ENV ?? null,
      VERCEL_GIT_COMMIT_SHA: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    },
    probeError,
    failed,
    all: probes,
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body, null, 2));
}
