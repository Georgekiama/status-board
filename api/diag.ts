/**
 * Deployment diagnostic. Deliberately imports NOTHING.
 *
 * When the other functions fail with FUNCTION_INVOCATION_FAILED, the crash is at
 * module load and no handler code runs, so there is nothing in the response to
 * diagnose from. This endpoint has no imports at all, which splits the problem
 * in two:
 *
 *   /api/diag works, others fail  -> the module graph is at fault (a dependency
 *                                    failing to bundle or load)
 *   /api/diag also fails          -> the platform or project config is at fault
 *                                    (runtime, build output, routing)
 *
 * It reports only whether environment variables are PRESENT, never their values.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  const body = {
    ok: true,
    note: "This endpoint imports nothing. If it responds while /api/board does not, the fault is in the module graph.",
    node: process.version,
    platform: process.platform,
    env: {
      // Presence only. Never log or return the values themselves.
      DATABASE_URL: Boolean(process.env.DATABASE_URL),
      API_TOKEN: Boolean(process.env.API_TOKEN),
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? "set" : "empty (same-origin)",
      VERCEL_ENV: process.env.VERCEL_ENV ?? null,
      VERCEL_GIT_COMMIT_SHA: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
    },
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body, null, 2));
}
