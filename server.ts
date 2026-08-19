/**
 * Local development / self-hosted entry point.
 *
 * Serves the status board HTML from public/ and the API from /api/* on the same
 * origin, which is exactly how the Vercel deployment behaves. Run it with
 * `npm run dev`.
 */
import { closeDb, getDbHandle } from "./src/db/client";
import { runMigrations } from "./src/db/migrate";
import { allowedOrigins } from "./src/http/cors";
import { startNodeServer } from "./src/http/node-server";

const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const handle = await getDbHandle();
  console.log("[server] database driver: " + handle.driver);

  if (process.env.SKIP_MIGRATIONS !== "1") {
    await runMigrations();
    console.log("[server] migrations up to date");
  }

  const running = await startNodeServer(port);
  const origins = allowedOrigins();
  console.log("[server] listening on http://localhost:" + running.port);
  console.log("[server] board API:  http://localhost:" + running.port + "/api/board");
  console.log("[server] health:     http://localhost:" + running.port + "/api/health");
  console.log("[server] MCP (HTTP): http://localhost:" + running.port + "/api/mcp");
  console.log(
    origins.length > 0
      ? "[server] CORS allowed origins: " + origins.join(", ")
      : "[server] CORS disabled (same-origin deployment)",
  );

  const shutdown = async (signal: string) => {
    console.log("\n[server] " + signal + " received, shutting down");
    await running.close().catch(() => undefined);
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("[server] failed to start:", error);
  process.exit(1);
});
