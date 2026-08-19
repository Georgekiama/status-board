/**
 * plan.md section 10, Steps 3 and 4 — GET /api/board and PUT /api/board.
 *
 * Exercised two ways: through handleApi directly (fast, no socket) and through
 * the real Node server over HTTP, so the transport adapter is covered too.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { boardService } from "../src/board/service.ts";
import { board, boardHistory, SINGLETON_BOARD_ID } from "../src/db/schema.ts";
import { handleApi } from "../src/http/handlers.ts";
import { startNodeServer, type RunningServer } from "../src/http/node-server.ts";
import {
  apiRequest,
  asRecord,
  createTestDb,
  labelledBoard,
  sampleBoard,
  type TestDb,
} from "./helpers.ts";

let ctx: TestDb;
let server: RunningServer;

before(async () => {
  ctx = await createTestDb();
  server = await startNodeServer(0, { db: ctx.db, env: { ...process.env, ALLOWED_ORIGINS: "", API_TOKEN: "" } });
});
after(async () => {
  await server.close();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

const call = (...args: Parameters<typeof apiRequest>) =>
  handleApi(apiRequest(...args), { db: ctx.db, env: { ...process.env, ALLOWED_ORIGINS: "", API_TOKEN: "" } });

describe("GET /api/board", () => {
  it("returns 200 and the empty board on a database that has never been written", async () => {
    const response = await call("GET", "/api/board");
    assert.equal(response.status, 200);
    const body = asRecord(response.body);
    assert.deepEqual(body.board, { areas: [] });
    assert.equal(body.version, 1);
    assert.equal(typeof body.createdAt, "string");
    assert.equal(typeof body.updatedAt, "string");
  });

  it("returns the stored board verbatim", async () => {
    const stored = sampleBoard();
    await boardService.updateBoard(stored, { db: ctx.db });

    const response = await call("GET", "/api/board");
    assert.equal(response.status, 200);
    assert.deepEqual(asRecord(response.body).board, stored);
  });

  it("advertises the version and forbids caching", async () => {
    await boardService.updateBoard(labelledBoard("A"), { db: ctx.db });
    const response = await call("GET", "/api/board");
    assert.equal(response.headers["X-Board-Version"], "2");
    assert.match(response.headers["Cache-Control"] ?? "", /no-store/);
    assert.equal(typeof response.headers["X-Board-Updated-At"], "string");
  });

  it("is a pure read — it never creates history", async () => {
    await call("GET", "/api/board");
    await call("GET", "/api/board");
    const history = await ctx.db.select().from(boardHistory);
    assert.equal(history.length, 0);
  });

  it("rejects other methods with 405 and an Allow header", async () => {
    for (const method of ["POST", "DELETE", "PATCH"]) {
      const response = await call(method, "/api/board");
      assert.equal(response.status, 405, method + " should not be allowed");
      assert.equal(response.headers.Allow, "GET, PUT");
    }
  });

  it("404s an unknown route", async () => {
    const response = await call("GET", "/api/nope");
    assert.equal(response.status, 404);
    assert.equal(asRecord(response.body).error.code, "not_found");
  });
});

describe("PUT /api/board", () => {
  it("accepts a valid board and makes it current", async () => {
    const next = sampleBoard();
    const response = await call("PUT", "/api/board", { body: next });

    assert.equal(response.status, 200);
    const body = asRecord(response.body);
    assert.deepEqual(body.board, next, "the response must echo what was stored");
    assert.equal(body.version, 2);
    assert.equal(body.previousVersion, 1);
    assert.equal(typeof body.historyId, "number");
    assert.deepEqual(body.warnings, []);

    const fetched = await call("GET", "/api/board");
    assert.deepEqual(asRecord(fetched.body).board, next, "GET must agree with the PUT response");
  });

  it("stores exactly what a follow-up read returns, byte for byte", async () => {
    const next = sampleBoard();
    await call("PUT", "/api/board", { body: next });
    const [row] = await ctx.db.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID));
    assert.deepEqual(row?.data, next);
  });

  it("archives the previous board before replacing it", async () => {
    const first = labelledBoard("A");
    const second = labelledBoard("B");
    await call("PUT", "/api/board", { body: first });
    await call("PUT", "/api/board", { body: second });

    const history = await ctx.db.select().from(boardHistory);
    assert.equal(history.length, 2);
    // v1 was the auto-created empty board, v2 was "A".
    assert.deepEqual(history.map((row) => row.version), [1, 2]);
    assert.deepEqual(history[0]?.data, { areas: [] });
    assert.deepEqual(history[1]?.data, first);
  });

  it("records the write source as rest", async () => {
    await call("PUT", "/api/board", { body: labelledBoard("A") });
    const [row] = await ctx.db.select().from(boardHistory);
    assert.equal(row?.source, "rest");
  });

  it("accepts the bare board or the response envelope", async () => {
    const bare = labelledBoard("bare");
    const enveloped = labelledBoard("enveloped");

    const first = await call("PUT", "/api/board", { body: bare });
    assert.equal(first.status, 200);
    assert.deepEqual(asRecord(first.body).board, bare);

    const second = await call("PUT", "/api/board", { body: { board: enveloped, version: 2 } });
    assert.equal(second.status, 200);
    assert.deepEqual(asRecord(second.body).board, enveloped);
  });

  it("returns warnings alongside a successful write", async () => {
    const response = await call("PUT", "/api/board", {
      body: { areas: [{ name: "A", projects: [{ id: "p", status: "gray", updated: "soon" }] }] },
    });
    assert.equal(response.status, 200);
    const warnings = asRecord(response.body).warnings.join(" ");
    assert.match(warnings, /has no name/);
    assert.match(warnings, /not a YYYY-MM-DD date/);
  });

  it("rejects a status the frontend cannot render, rather than breaking the board", async () => {
    const good = sampleBoard();
    await call("PUT", "/api/board", { body: good });

    const response = await call("PUT", "/api/board", {
      body: { areas: [{ name: "A", projects: [{ id: "p", name: "P", status: "chartreuse" }] }] },
    });
    assert.equal(response.status, 400);
    assert.match(asRecord(response.body).error.issues[0].message, /green, amber, red, gray/);
    assert.deepEqual(asRecord((await call("GET", "/api/board")).body).board, good);
  });
});

describe("PUT /api/board — rejections must never damage the board", () => {
  const goodBoard = sampleBoard();

  beforeEach(async () => {
    await ctx.reset();
    await boardService.updateBoard(goodBoard, { db: ctx.db });
  });

  async function assertBoardUntouched(expectedVersion: number) {
    const response = await call("GET", "/api/board");
    const body = asRecord(response.body);
    assert.deepEqual(body.board, goodBoard, "the stored board must be unchanged");
    assert.equal(body.version, expectedVersion, "a rejected write must not bump the version");
  }

  it("rejects a malformed board with 400 and leaves the board alone", async () => {
    const response = await call("PUT", "/api/board", { body: { notAreas: true } });
    assert.equal(response.status, 400);
    const error = asRecord(response.body).error;
    assert.equal(error.code, "invalid_board");
    assert.ok(Array.isArray(error.issues) && error.issues.length > 0);
    await assertBoardUntouched(2);
  });

  it("rejects invalid JSON with 400 and leaves the board alone", async () => {
    const response = await call("PUT", "/api/board", { rawBody: "{ this is not json" });
    assert.equal(response.status, 400);
    assert.equal(asRecord(response.body).error.code, "invalid_json");
    await assertBoardUntouched(2);
  });

  it("rejects an empty body and leaves the board alone", async () => {
    const response = await call("PUT", "/api/board", { rawBody: "" });
    assert.equal(response.status, 400);
    await assertBoardUntouched(2);
  });

  it("rejects a JSON array and leaves the board alone", async () => {
    const response = await call("PUT", "/api/board", { body: [{ areas: [] }] });
    assert.equal(response.status, 400);
    await assertBoardUntouched(2);
  });

  it("rejects a project without an id and leaves the board alone", async () => {
    const response = await call("PUT", "/api/board", {
      body: { areas: [{ name: "A", projects: [{ name: "no id" }] }] },
    });
    assert.equal(response.status, 400);
    await assertBoardUntouched(2);
  });

  it("writes no history row for a rejected update", async () => {
    const before = await ctx.db.select().from(boardHistory);
    await call("PUT", "/api/board", { body: { areas: "nope" } });
    const after = await ctx.db.select().from(boardHistory);
    assert.equal(after.length, before.length, "a rejected write must not archive anything");
  });
});

describe("optimistic concurrency (opt-in)", () => {
  it("ignores concurrency entirely when the client does not ask — last write wins", async () => {
    await call("PUT", "/api/board", { body: labelledBoard("A") });
    const second = await call("PUT", "/api/board", { body: labelledBoard("B") });
    assert.equal(second.status, 200);
    assert.deepEqual(asRecord(second.body).board, labelledBoard("B"));
  });

  it("rejects a stale write with 409 when expectedVersion is supplied", async () => {
    const first = await call("PUT", "/api/board", { body: labelledBoard("A") });
    const currentVersion = asRecord(first.body).version;

    const stale = await call("PUT", "/api/board", {
      body: { ...labelledBoard("B"), expectedVersion: currentVersion - 1 },
    });
    assert.equal(stale.status, 409);
    const error = asRecord(stale.body).error;
    assert.equal(error.code, "version_conflict");
    assert.equal(error.currentVersion, currentVersion);

    const current = await call("GET", "/api/board");
    assert.deepEqual(asRecord(current.body).board, labelledBoard("A"), "the conflicting write must not land");
  });

  it("accepts a fresh write when expectedVersion matches", async () => {
    const first = await call("PUT", "/api/board", { body: labelledBoard("A") });
    const version = asRecord(first.body).version;
    const second = await call("PUT", "/api/board", {
      body: { ...labelledBoard("B"), expectedVersion: version },
    });
    assert.equal(second.status, 200);
    assert.equal(asRecord(second.body).version, version + 1);
  });

  it("honours an If-Match header as well as the body field", async () => {
    await call("PUT", "/api/board", { body: labelledBoard("A") });
    const stale = await call("PUT", "/api/board", {
      body: labelledBoard("B"),
      headers: { "If-Match": '"1"' },
    });
    assert.equal(stale.status, 409);
  });
});

describe("GET /api/health", () => {
  it("reports the database as up", async () => {
    const response = await call("GET", "/api/health");
    assert.equal(response.status, 200);
    const body = asRecord(response.body);
    assert.equal(body.ok, true);
    assert.equal(body.database, "up");
    assert.equal(typeof body.boardVersion, "number");
  });

  it("needs no API token, so uptime checks work when auth is on", async () => {
    const response = await handleApi(apiRequest("GET", "/api/health"), {
      db: ctx.db,
      env: { ...process.env, API_TOKEN: "secret" },
    });
    assert.equal(response.status, 200);
  });
});

describe("CORS", () => {
  const withOrigins = (origins: string, origin?: string) =>
    handleApi(apiRequest("GET", "/api/board", origin ? { headers: { Origin: origin } } : {}), {
      db: ctx.db,
      env: { ...process.env, ALLOWED_ORIGINS: origins, API_TOKEN: "" },
    });

  it("emits no CORS headers for a same-origin deployment", async () => {
    const response = await withOrigins("", "https://status.litnmore.com");
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
  });

  it("echoes an allowed origin, never a wildcard", async () => {
    const response = await withOrigins("https://status.litnmore.com", "https://status.litnmore.com");
    assert.equal(response.headers["Access-Control-Allow-Origin"], "https://status.litnmore.com");
    assert.notEqual(response.headers["Access-Control-Allow-Origin"], "*");
  });

  it("refuses an origin that is not on the list", async () => {
    const response = await withOrigins("https://status.litnmore.com", "https://evil.example");
    assert.equal(response.headers["Access-Control-Allow-Origin"], undefined);
    assert.equal(response.headers.Vary, "Origin");
  });

  it("answers a preflight with 204", async () => {
    const response = await handleApi(
      apiRequest("OPTIONS", "/api/board", { headers: { Origin: "https://status.litnmore.com" } }),
      { db: ctx.db, env: { ...process.env, ALLOWED_ORIGINS: "https://status.litnmore.com" } },
    );
    assert.equal(response.status, 204);
    assert.match(response.headers["Access-Control-Allow-Methods"] ?? "", /PUT/);
  });
});

describe("optional API token", () => {
  const withToken = (headers: Record<string, string> = {}) =>
    handleApi(apiRequest("GET", "/api/board", { headers }), {
      db: ctx.db,
      env: { ...process.env, API_TOKEN: "s3cret" },
    });

  it("401s a request with no token", async () => {
    const response = await withToken();
    assert.equal(response.status, 401);
    assert.equal(asRecord(response.body).error.code, "unauthorized");
  });

  it("401s a wrong token", async () => {
    assert.equal((await withToken({ Authorization: "Bearer nope" })).status, 401);
  });

  it("accepts the token as a bearer credential or a header", async () => {
    assert.equal((await withToken({ Authorization: "Bearer s3cret" })).status, 200);
    assert.equal((await withToken({ "X-Api-Token": "s3cret" })).status, 200);
  });
});

describe("over real HTTP", () => {
  it("serves GET and PUT end to end", async () => {
    const next = sampleBoard();

    const put = await fetch(server.origin + "/api/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    assert.equal(put.status, 200);
    assert.match(put.headers.get("content-type") ?? "", /application\/json/);
    const putBody = asRecord(await put.json());
    assert.deepEqual(putBody.board, next);

    const get = await fetch(server.origin + "/api/board");
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("x-board-version"), String(putBody.version));
    assert.deepEqual(asRecord(await get.json()).board, next);
  });

  it("returns 400 with a JSON error body for a bad payload", async () => {
    const response = await fetch(server.origin + "/api/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{ broken",
    });
    assert.equal(response.status, 400);
    assert.equal(asRecord(await response.json()).error.code, "invalid_json");
  });

  it("serves the board HTML at the root, same origin as the API", async () => {
    const response = await fetch(server.origin + "/");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await response.text(), /<html/i);
  });

  it("blocks path traversal out of public/", async () => {
    const response = await fetch(server.origin + "/../package.json");
    assert.ok(response.status === 403 || response.status === 404, "got " + response.status);
  });
});
