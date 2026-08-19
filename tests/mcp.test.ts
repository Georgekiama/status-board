/**
 * plan.md section 12 — MCP testing.
 *
 * Both tools are driven through a real MCP client over an in-memory transport,
 * and over the streamable-HTTP endpoint, then cross-checked against REST:
 *
 *   REST update -> database -> MCP get_board
 *   MCP update  -> database -> REST GET
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { asc } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { boardHistory } from "../src/db/schema";
import { handleApi } from "../src/http/handlers";
import { startNodeServer, type RunningServer } from "../src/http/node-server";
import { createMcpServer } from "../src/mcp/server";
import { apiRequest, asRecord, createTestDb, labelledBoard, sampleBoard, type TestDb } from "./helpers";

let ctx: TestDb;
let client: Client;
let server: RunningServer;

before(async () => {
  ctx = await createTestDb();

  const mcpServer = createMcpServer({ db: ctx.db });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

  server = await startNodeServer(0, { db: ctx.db, env: { ...process.env, API_TOKEN: "", ALLOWED_ORIGINS: "" } });
});

after(async () => {
  await client.close();
  await server.close();
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
});

/** Tool results carry JSON in a text block; parse it back out. */
function parseToolResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const first = content?.[0];
  assert.ok(first, "tool result had no content");
  assert.equal(first.type, "text");
  return { text: first.text ?? "", isError: result.isError === true, structured: result.structuredContent };
}

function parseJsonToolResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const parsed = parseToolResult(result);
  assert.equal(parsed.isError, false, "tool reported an error: " + parsed.text);
  return asRecord(JSON.parse(parsed.text));
}

const restPut = (body: unknown) => handleApi(apiRequest("PUT", "/api/board", { body }), { db: ctx.db });
const restGet = () => handleApi(apiRequest("GET", "/api/board"), { db: ctx.db });

describe("tool discovery", () => {
  it("exposes exactly the two tools the plan calls for", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_board", "update_board"]);
  });

  it("describes update_board as a whole-document, destructive write", async () => {
    const { tools } = await client.listTools();
    const update = tools.find((tool) => tool.name === "update_board");
    assert.ok(update);
    assert.equal(update.annotations?.destructiveHint, true);
    assert.match(update.description ?? "", /entire status board|COMPLETE board/);
  });

  it("advertises get_board as read-only", async () => {
    const { tools } = await client.listTools();
    const get = tools.find((tool) => tool.name === "get_board");
    assert.equal(get?.annotations?.readOnlyHint, true);
  });

  it("publishes a board input schema so the model knows the shape", async () => {
    const { tools } = await client.listTools();
    const update = tools.find((tool) => tool.name === "update_board");
    const schema = update?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(schema.properties?.board, "board argument must be documented");
    assert.deepEqual(schema.required, ["board"]);
  });
});

describe("get_board", () => {
  it("returns the empty board on a fresh database", async () => {
    const body = parseJsonToolResult(await client.callTool({ name: "get_board", arguments: {} }));
    assert.deepEqual(body.board, { areas: [] });
    assert.equal(body.version, 1);
  });

  it("returns exactly what REST returns", async () => {
    await restPut(sampleBoard());

    const viaMcp = parseJsonToolResult(await client.callTool({ name: "get_board", arguments: {} }));
    const viaRest = asRecord((await restGet()).body);

    assert.deepEqual(viaMcp.board, viaRest.board);
    assert.equal(viaMcp.version, viaRest.version);
  });

  it("includes a summary the agent can reason about", async () => {
    await restPut(sampleBoard());
    const body = parseJsonToolResult(await client.callTool({ name: "get_board", arguments: {} }));
    assert.equal(body.areaCount, 2);
    assert.equal(body.projectCount, 3);
  });

  it("does not create a history record", async () => {
    await client.callTool({ name: "get_board", arguments: {} });
    const rows = await ctx.db.select().from(boardHistory);
    assert.equal(rows.length, 0);
  });
});

describe("update_board", () => {
  it("writes the board and reports the archived version", async () => {
    const next = sampleBoard();
    const body = parseJsonToolResult(await client.callTool({ name: "update_board", arguments: { board: next } }));

    assert.equal(body.ok, true);
    assert.deepEqual(body.board, next);
    assert.equal(body.version, 2);
    assert.equal(body.previousVersion, 1);
    assert.equal(typeof body.archivedAsHistoryId, "number");
  });

  it("creates a history record marked as an MCP write", async () => {
    await client.callTool({ name: "update_board", arguments: { board: labelledBoard("A") } });
    const rows = await ctx.db.select().from(boardHistory);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source, "mcp", "history must show the automation made this change");
  });

  it("archives the previous board across successive MCP writes", async () => {
    await client.callTool({ name: "update_board", arguments: { board: labelledBoard("A") } });
    await client.callTool({ name: "update_board", arguments: { board: labelledBoard("B") } });

    const rows = await ctx.db.select().from(boardHistory).orderBy(asc(boardHistory.id));
    assert.deepEqual(rows.map((row) => row.data), [{ areas: [] }, labelledBoard("A")]);
  });

  it("rejects an invalid board without changing anything", async () => {
    await restPut(sampleBoard());

    const result = parseToolResult(
      await client.callTool({ name: "update_board", arguments: { board: { areas: [{ name: "A" }] } } }),
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /rejected and nothing was changed/);

    const current = asRecord((await restGet()).body);
    assert.deepEqual(current.board, sampleBoard(), "the board must be untouched");
    assert.equal(current.version, 2);
  });

  it("warns the agent when a write shrinks the board", async () => {
    await restPut(sampleBoard());
    const body = parseJsonToolResult(
      await client.callTool({ name: "update_board", arguments: { board: labelledBoard("tiny") } }),
    );
    assert.match(
      (body.warnings as string[]).join(" "),
      /reduced the project count from 3 to 1/,
      "an agent overwriting the board wholesale must be told what it removed",
    );
  });

  it("honours expectedVersion so the agent cannot clobber a human edit", async () => {
    const first = asRecord((await restPut(labelledBoard("human"))).body);

    const stale = parseToolResult(
      await client.callTool({
        name: "update_board",
        arguments: { board: labelledBoard("agent"), expectedVersion: first.version - 1 },
      }),
    );
    assert.equal(stale.isError, true);
    assert.match(stale.text, /Board has changed/);
    assert.deepEqual(asRecord((await restGet()).body).board, labelledBoard("human"));

    const fresh = parseJsonToolResult(
      await client.callTool({
        name: "update_board",
        arguments: { board: labelledBoard("agent"), expectedVersion: first.version },
      }),
    );
    assert.deepEqual(fresh.board, labelledBoard("agent"));
  });
});

describe("REST and MCP see one database", () => {
  it("REST update -> MCP get_board", async () => {
    const written = labelledBoard("from-rest");
    await restPut(written);

    const body = parseJsonToolResult(await client.callTool({ name: "get_board", arguments: {} }));
    assert.deepEqual(body.board, written);
  });

  it("MCP update -> REST GET", async () => {
    const written = labelledBoard("from-mcp");
    await client.callTool({ name: "update_board", arguments: { board: written } });

    const response = await restGet();
    assert.deepEqual(asRecord(response.body).board, written);
  });

  it("shares one version sequence and one history table", async () => {
    await restPut(labelledBoard("A"));
    await client.callTool({ name: "update_board", arguments: { board: labelledBoard("B") } });
    await restPut(labelledBoard("C"));

    const current = asRecord((await restGet()).body);
    assert.equal(current.version, 4, "versions must continue across interfaces");

    const rows = await ctx.db.select().from(boardHistory).orderBy(asc(boardHistory.id));
    // `source` names the interface whose write REPLACED that snapshot, which is
    // what answers "what did the board look like before the agent touched it?".
    // So the row holding A is marked mcp, because the MCP write replaced A.
    assert.deepEqual(rows.map((row) => row.source), ["rest", "mcp", "rest"]);
    assert.deepEqual(rows.map((row) => row.version), [1, 2, 3]);
    assert.deepEqual(rows.map((row) => row.data), [{ areas: [] }, labelledBoard("A"), labelledBoard("B")]);
  });

  it("interleaves reads and writes from both sides consistently", async () => {
    await client.callTool({ name: "update_board", arguments: { board: labelledBoard("one") } });
    assert.deepEqual(asRecord((await restGet()).body).board, labelledBoard("one"));

    await restPut(labelledBoard("two"));
    assert.deepEqual(
      parseJsonToolResult(await client.callTool({ name: "get_board", arguments: {} })).board,
      labelledBoard("two"),
    );

    await client.callTool({ name: "update_board", arguments: { board: labelledBoard("three") } });
    assert.deepEqual(asRecord((await restGet()).body).board, labelledBoard("three"));
  });
});

describe("over the streamable HTTP endpoint", () => {
  it("serves both tools at /api/mcp", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(server.origin + "/api/mcp"));
    const httpClient = new Client({ name: "http-test-client", version: "1.0.0" });
    try {
      await httpClient.connect(transport);

      const { tools } = await httpClient.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_board", "update_board"]);

      const written = labelledBoard("over-http");
      const updated = parseJsonToolResult(
        await httpClient.callTool({ name: "update_board", arguments: { board: written } }),
      );
      assert.deepEqual(updated.board, written);

      const fetched = parseJsonToolResult(await httpClient.callTool({ name: "get_board", arguments: {} }));
      assert.deepEqual(fetched.board, written);

      // and the same data is visible through REST
      assert.deepEqual(asRecord((await restGet()).body).board, written);
    } finally {
      await httpClient.close().catch(() => undefined);
    }
  });
});
