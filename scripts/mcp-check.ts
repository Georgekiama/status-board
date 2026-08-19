/**
 * Verify a deployed MCP endpoint end to end, as a real client sees it.
 *
 *   npm run mcp:check -- --url http://localhost:3222
 *   npm run mcp:check -- --url https://status.litnmore.com --write
 *
 * Read-only by default: connects, lists tools, calls get_board, and checks the
 * result matches what REST returns. `--write` additionally calls update_board
 * with the board it just read — content-neutral, but it does bump the version
 * and add one history row, and it proves the write path and history work.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf("--" + name);
  return index === -1 ? undefined : args[index + 1];
}

const baseUrl = (option("url") ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = option("token") ?? process.env.API_TOKEN;
const doWrite = args.includes("--write");

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

/**
 * Compare boards by value. Postgres jsonb stores object keys sorted, so a plain
 * text comparison would fail on key order alone even though nothing changed.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

function sameBoard(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Tool results carry JSON in a text block. */
function parseResult(result: unknown): Record<string, unknown> {
  const shaped = result as { content?: unknown; isError?: boolean };
  const content = shaped.content as Array<{ type: string; text?: string }> | undefined;
  const text = content?.[0]?.text ?? "";
  if (shaped.isError) throw new Error("tool returned an error: " + text);
  return JSON.parse(text) as Record<string, unknown>;
}

function countProjects(board: { areas?: Array<{ projects?: unknown[] }> }): number {
  return (board.areas ?? []).reduce((total, area) => total + (area.projects?.length ?? 0), 0);
}

async function main(): Promise<void> {
  console.log("Checking MCP at " + baseUrl + "/api/mcp");
  console.log("");

  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + "/api/mcp"), {
    requestInit: token ? { headers: { Authorization: "Bearer " + token } } : undefined,
  });
  const client = new Client({ name: "mcp-check", version: "1.0.0" });

  try {
    await client.connect(transport);
    check("connected and initialized", true);

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    check("exposes exactly get_board and update_board", JSON.stringify(names) === '["get_board","update_board"]', names.join(", "));

    const update = tools.find((tool) => tool.name === "update_board");
    check("update_board is flagged destructive", update?.annotations?.destructiveHint === true);

    const fetched = parseResult(await client.callTool({ name: "get_board", arguments: {} }));
    const board = fetched.board as { areas?: unknown[] };
    check("get_board returns a board", Array.isArray(board?.areas));
    check("get_board reports a version", typeof fetched.version === "number");
    console.log(
      "        board: version " +
        fetched.version +
        ", " +
        (board.areas?.length ?? 0) +
        " area(s), " +
        countProjects(board as never) +
        " project(s)",
    );

    // The same data must be visible through REST.
    const restHeaders: Record<string, string> = token ? { Authorization: "Bearer " + token } : {};
    const restResponse = await fetch(baseUrl + "/api/board", { headers: restHeaders });
    const rest = (await restResponse.json()) as { board?: unknown; version?: number };
    check("MCP and REST agree on the board", sameBoard(rest.board, fetched.board));
    check("MCP and REST agree on the version", rest.version === fetched.version);

    const rejected = (await client.callTool({
      name: "update_board",
      arguments: { board: { areas: [{ name: "bad", projects: [{ id: "x", name: "no status" }] }] } },
    })) as unknown as { isError?: boolean };
    check("an invalid board is rejected", rejected.isError === true);

    const afterReject = parseResult(await client.callTool({ name: "get_board", arguments: {} }));
    check("a rejected write left the board untouched", afterReject.version === fetched.version);

    if (doWrite) {
      console.log("");
      console.log("  write round-trip");
      const written = parseResult(
        await client.callTool({ name: "update_board", arguments: { board: fetched.board } }),
      );
      check("update_board accepted", written.ok === true);
      check("version advanced", written.version === (fetched.version as number) + 1);
      check("previous version archived", typeof written.archivedAsHistoryId === "number");
      check("board round-tripped unchanged", sameBoard(written.board, fetched.board));

      const viaRest = await fetch(baseUrl + "/api/board", { headers: restHeaders });
      const restAfter = (await viaRest.json()) as { version?: number };
      check("REST sees the MCP write", restAfter.version === written.version);

      const historyResponse = await fetch(baseUrl + "/api/board/history?limit=1", { headers: restHeaders });
      const history = (await historyResponse.json()) as { versions?: Array<{ id: number; source: string }> };
      const newest = history.versions?.[0];
      check("history records the write as coming from mcp", newest?.source === "mcp", newest?.source);
      check("history id matches what update_board reported", newest?.id === written.archivedAsHistoryId);
      console.log("        restore it with: npm run db:restore -- --id " + written.archivedAsHistoryId);
    }
  } finally {
    await client.close().catch(() => undefined);
  }

  console.log("");
  console.log(failures === 0 ? "All checks passed." : failures + " check(s) failed.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("MCP check could not run:", error);
  process.exitCode = 1;
});
