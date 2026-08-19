/**
 * plan.md section 13 — integration and failure behaviour, and section 14 —
 * last-write-wins concurrency.
 *
 * Two independent HTTP clients stand in for two browsers. The failure cases
 * matter most: a client must never be told a change was saved when it was not.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { boardService } from "../src/board/service.ts";
import type { Db } from "../src/db/client.ts";
import { boardHistory } from "../src/db/schema.ts";
import { startNodeServer, type RunningServer } from "../src/http/node-server.ts";
import { asRecord, createTestDb, labelledBoard, sampleBoard, type TestDb } from "./helpers.ts";

let ctx: TestDb;
let server: RunningServer;
/** A second server on its own port, sharing the database — "another browser". */
let otherServer: RunningServer;

const env = () => ({ ...process.env, API_TOKEN: "", ALLOWED_ORIGINS: "" });

before(async () => {
  ctx = await createTestDb();
  server = await startNodeServer(0, { db: ctx.db, env: env() });
  otherServer = await startNodeServer(0, { db: ctx.db, env: env() });
});
after(async () => {
  await server.close();
  await otherServer.close();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

async function getBoard(origin: string) {
  const response = await fetch(origin + "/api/board");
  return { status: response.status, body: asRecord(await response.json()) };
}

async function putBoard(origin: string, board: unknown, init: RequestInit = {}) {
  const response = await fetch(origin + "/api/board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(board),
    ...init,
  });
  return { status: response.status, body: asRecord(await response.json()) };
}

describe("the human workflow", () => {
  it("load, edit, save, reload — the change is still there", async () => {
    const initial = await getBoard(server.origin);
    assert.equal(initial.status, 200);

    // Edit one project the way the UI would: mutate and PUT the whole board.
    const edited = sampleBoard();
    edited.areas[0]!.projects[0]!.note = "Exhibit list received, moving to green.";
    edited.areas[0]!.projects[0]!.status = "green";
    edited.areas[0]!.projects[0]!.updated = "2026-08-19";

    const saved = await putBoard(server.origin, edited);
    assert.equal(saved.status, 200);

    // "Refresh the browser."
    const reloaded = await getBoard(server.origin);
    assert.deepEqual(reloaded.body.board, edited);
    assert.equal(reloaded.body.board.areas[0]?.projects[0]?.status, "green");
  });

  it("survives many sequential edits without losing any of them", async () => {
    const board = sampleBoard();
    for (const note of ["first", "second", "third", "fourth"]) {
      board.areas[0]!.projects[0]!.note = note;
      const saved = await putBoard(server.origin, board);
      assert.equal(saved.status, 200);
      const reloaded = await getBoard(server.origin);
      assert.equal(reloaded.body.board.areas[0].projects[0].note, note);
    }

    const history = await boardService.listHistory({ db: ctx.db });
    assert.equal(history.length, 4, "every edit archives exactly one previous version");
  });
});

describe("two browsers", () => {
  it("browser B sees what browser A saved, after a refresh", async () => {
    const fromA = labelledBoard("edited-by-A");
    const saved = await putBoard(server.origin, fromA);
    assert.equal(saved.status, 200);

    const seenByB = await getBoard(otherServer.origin);
    assert.deepEqual(seenByB.body.board, fromA);
    assert.equal(seenByB.body.version, saved.body.version);
  });

  it("last successful write wins when both browsers save", async () => {
    await putBoard(server.origin, labelledBoard("A-first"));
    await putBoard(otherServer.origin, labelledBoard("B-second"));

    const finalA = await getBoard(server.origin);
    const finalB = await getBoard(otherServer.origin);
    assert.deepEqual(finalA.body.board, labelledBoard("B-second"));
    assert.deepEqual(finalB.body, finalA.body, "both browsers agree on the current board");
  });

  it("keeps the overwritten version recoverable from history", async () => {
    await putBoard(server.origin, labelledBoard("A-work"));
    await putBoard(otherServer.origin, labelledBoard("B-overwrites-A"));

    const history = await boardService.listHistory({ db: ctx.db });
    const archived = await boardService.getHistoryEntry(history[0]!.id, { db: ctx.db });
    assert.deepEqual(archived.board, labelledBoard("A-work"), "A's work is recoverable, not gone");
  });
});

describe("concurrent writes", () => {
  it("serialises simultaneous PUTs — no lost history, no duplicate versions", async () => {
    const results = await Promise.all([
      putBoard(server.origin, labelledBoard("one")),
      putBoard(otherServer.origin, labelledBoard("two")),
      putBoard(server.origin, labelledBoard("three")),
    ]);

    for (const result of results) assert.equal(result.status, 200);

    const versions = results.map((result) => result.body.version).sort((a, b) => a - b);
    assert.deepEqual(versions, [2, 3, 4], "each write gets its own version");

    const rows = await ctx.db.select().from(boardHistory);
    assert.equal(rows.length, 3, "each write archived exactly one previous board");
    const archivedVersions = rows.map((row) => row.version).sort((a, b) => a - b);
    assert.deepEqual(archivedVersions, [1, 2, 3], "no version was archived twice or skipped");

    // Three writes starting from version 1 leave the board at version 4:
    // each write archives version v and stores v + 1.
    const current = await getBoard(server.origin);
    assert.equal(current.body.version, 4);
  });

  it("leaves the board matching exactly one of the concurrent writes", async () => {
    const candidates = [labelledBoard("x"), labelledBoard("y")];
    await Promise.all(candidates.map((board) => putBoard(server.origin, board)));

    const current = await getBoard(server.origin);
    const serialised = JSON.stringify(current.body.board);
    assert.ok(
      candidates.some((candidate) => JSON.stringify(candidate) === serialised),
      "the board must be one of the writes, never a blend of both",
    );
  });
});

describe("failure behaviour — the client must never be misled", () => {
  /** A connection that fails the way an unreachable Postgres does. */
  function unreachableDb(): Db {
    const fail = () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
    };
    return new Proxy({} as Db, {
      get: () => fail,
    });
  }

  it("reports 503 and says the change was not saved when the database is down", async () => {
    const broken = await startNodeServer(0, { db: unreachableDb(), env: env() });
    try {
      const response = await fetch(broken.origin + "/api/board", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sampleBoard()),
      });
      assert.equal(response.status, 503);
      const body = asRecord(await response.json());
      assert.equal(body.error.code, "database_unavailable");
      assert.match(body.error.message, /not saved/i, "the message must not imply success");
    } finally {
      await broken.close();
    }
  });

  it("reports the database as down on /api/health rather than pretending to be fine", async () => {
    const broken = await startNodeServer(0, { db: unreachableDb(), env: env() });
    try {
      const response = await fetch(broken.origin + "/api/health");
      assert.equal(response.status, 503);
      const body = asRecord(await response.json());
      assert.equal(body.ok, false);
      assert.equal(body.database, "down");
    } finally {
      await broken.close();
    }
  });

  it("never answers a failed write with 2xx", async () => {
    const cases: Array<[string, unknown]> = [
      ["missing areas", { nope: 1 }],
      ["areas of the wrong type", { areas: "no" }],
      ["a project with no id", { areas: [{ name: "A", projects: [{ name: "x" }] }] }],
    ];
    for (const [label, payload] of cases) {
      const result = await putBoard(server.origin, payload);
      assert.ok(result.status >= 400, label + " must not return " + result.status);
      assert.ok(result.body.error, label + " must return an error body");
    }
  });

  it("survives a client that disconnects mid-request, leaving the board intact", async () => {
    const good = sampleBoard();
    await putBoard(server.origin, good);
    const before = await getBoard(server.origin);

    const controller = new AbortController();
    const inflight = fetch(server.origin + "/api/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(labelledBoard("aborted")),
      signal: controller.signal,
    });
    controller.abort();
    await inflight.catch(() => undefined);

    // The server must still be answering, and the board must still be readable.
    const after = await getBoard(server.origin);
    assert.equal(after.status, 200);
    assert.ok(
      JSON.stringify(after.body.board) === JSON.stringify(before.body.board) ||
        JSON.stringify(after.body.board) === JSON.stringify(labelledBoard("aborted")),
      "an aborted request either landed completely or not at all",
    );
  });

  it("rejects an oversized body without falling over", async () => {
    const huge = { areas: [{ name: "A", projects: [{ id: "p", name: "P", note: "x".repeat(2_100_000) }] }] };
    const response = await fetch(server.origin + "/api/board", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(huge),
    });
    assert.ok(response.status === 413 || response.status === 400, "got " + response.status);

    const after = await getBoard(server.origin);
    assert.equal(after.status, 200, "the server is still healthy afterwards");
  });

  it("returns a JSON error body for every failure, so the UI can show a reason", async () => {
    const responses = await Promise.all([
      fetch(server.origin + "/api/board", { method: "DELETE" }),
      fetch(server.origin + "/api/nope"),
      fetch(server.origin + "/api/board", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{oops",
      }),
    ]);

    for (const response of responses) {
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const body = asRecord(await response.json());
      assert.equal(typeof body.error.code, "string");
      assert.equal(typeof body.error.message, "string");
    }
  });
});
