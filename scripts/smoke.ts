/**
 * Smoke-test a running deployment over HTTP.
 *
 *   npm run smoke -- --url https://status.litnmore.com
 *   npm run smoke -- --url http://localhost:3000 --write
 *
 * Read-only by default. `--write` performs a full PUT round-trip: it reads the
 * board, writes it back unchanged, then verifies the read matches and a history
 * row was created. That is safe (the content does not change) but it does bump
 * the version and add one history row.
 */
const args = process.argv.slice(2);

function option(name: string): string | undefined {
  const index = args.indexOf("--" + name);
  return index === -1 ? undefined : args[index + 1];
}

const baseUrl = (option("url") ?? process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const token = option("token") ?? process.env.API_TOKEN;
const doWrite = args.includes("--write");

const authHeaders: Record<string, string> = token ? { Authorization: "Bearer " + token } : {};

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? " — " + detail : ""));
  if (!ok) failures += 1;
}

/**
 * Compare boards by value, not by text. Postgres jsonb stores object keys
 * sorted, so a plain JSON.stringify comparison would fail on key order alone
 * even though nothing changed.
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

async function main(): Promise<void> {
  console.log("Smoke-testing " + baseUrl);
  console.log("");

  const health = await fetch(baseUrl + "/api/health");
  const healthBody = (await health.json()) as { ok?: boolean; database?: string; boardVersion?: number };
  check("GET /api/health responds 200", health.status === 200, "got " + health.status);
  check("database reachable", healthBody.database === "up", JSON.stringify(healthBody));

  const get = await fetch(baseUrl + "/api/board", { headers: authHeaders });
  check("GET /api/board responds 200", get.status === 200, "got " + get.status);
  const board = (await get.json()) as { board?: { areas?: unknown[] }; version?: number };
  check("response carries a board with areas", Array.isArray(board.board?.areas));
  check("response carries a version", typeof board.version === "number");
  check("version header matches body", get.headers.get("x-board-version") === String(board.version));
  check("board is not cached", /no-store/.test(get.headers.get("cache-control") ?? ""));

  const bad = await fetch(baseUrl + "/api/board", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({ definitely: "not a board" }),
  });
  check("an invalid PUT is rejected with 400", bad.status === 400, "got " + bad.status);

  const afterBad = await fetch(baseUrl + "/api/board", { headers: authHeaders });
  const afterBadBody = (await afterBad.json()) as { version?: number };
  check("a rejected PUT did not change the version", afterBadBody.version === board.version);

  const mcp = await fetch(baseUrl + "/api/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...authHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1.0.0" },
      },
    }),
  });
  check("MCP endpoint accepts initialize", mcp.status === 200, "got " + mcp.status);

  if (doWrite) {
    console.log("");
    console.log("  write round-trip");
    const put = await fetch(baseUrl + "/api/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(board.board),
    });
    const putBody = (await put.json()) as { version?: number; historyId?: number; board?: unknown };
    check("PUT accepted", put.status === 200, "got " + put.status);
    check("version advanced", putBody.version === (board.version ?? 0) + 1);
    check("previous version archived", typeof putBody.historyId === "number");
    check("returned board matches what was sent", sameBoard(putBody.board, board.board));

    const reread = await fetch(baseUrl + "/api/board", { headers: authHeaders });
    const rereadBody = (await reread.json()) as { board?: unknown; version?: number };
    check("re-read matches the write", sameBoard(rereadBody.board, board.board));
    check("re-read version matches", rereadBody.version === putBody.version);
  }

  console.log("");
  console.log(failures === 0 ? "All checks passed." : failures + " check(s) failed.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("smoke test could not run:", error);
  process.exitCode = 1;
});
