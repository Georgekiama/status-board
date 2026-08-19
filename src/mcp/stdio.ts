/**
 * MCP over stdio — for a local Claude Desktop / Claude Code connection.
 *
 * Run with `npm run mcp:stdio`. Uses the same boardService (and therefore the
 * same database) as the REST API. Nothing is written to stdout except protocol
 * traffic; logs go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runMigrations } from "../db/migrate";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS !== "1") {
    await runMigrations();
  }

  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] status board server ready on stdio");
}

main().catch((error) => {
  console.error("[mcp] failed to start:", error);
  process.exit(1);
});
