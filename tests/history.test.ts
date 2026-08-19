/**
 * plan.md section 11 — History testing.
 *
 *   Version A -> PUT B  =>  history contains A, current is B
 *   Version B -> PUT C  =>  history contains A + B, current is C
 *
 * which is what makes an automated update conceptually rollback-able.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { asc } from "drizzle-orm";
import { boardService } from "../src/board/service.ts";
import { NotFoundError } from "../src/board/errors.ts";
import { boardHistory } from "../src/db/schema.ts";
import { handleApi } from "../src/http/handlers.ts";
import { apiRequest, asRecord, createTestDb, labelledBoard, type TestDb } from "./helpers.ts";

let ctx: TestDb;

before(async () => {
  ctx = await createTestDb();
});
after(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

const A = labelledBoard("A");
const B = labelledBoard("B");
const C = labelledBoard("C");

const put = (body: unknown) => handleApi(apiRequest("PUT", "/api/board", { body }), { db: ctx.db });
const get = () => handleApi(apiRequest("GET", "/api/board"), { db: ctx.db });

/** Archived boards, oldest first. */
async function archivedBoards() {
  const rows = await ctx.db.select().from(boardHistory).orderBy(asc(boardHistory.id));
  return rows.map((row) => row.data);
}

describe("the A -> B -> C chain", () => {
  it("archives A when B replaces it", async () => {
    await put(A);
    await put(B);

    const current = asRecord((await get()).body);
    assert.deepEqual(current.board, B, "current must be B");
    // The empty board created on first read is archived too, hence A sits second.
    assert.deepEqual(await archivedBoards(), [{ areas: [] }, A]);
  });

  it("archives A and B once C replaces B", async () => {
    await put(A);
    await put(B);
    await put(C);

    const current = asRecord((await get()).body);
    assert.deepEqual(current.board, C, "current must be C");
    assert.deepEqual(await archivedBoards(), [{ areas: [] }, A, B]);
  });

  it("keeps versions monotonic and gap-free across current and history", async () => {
    await put(A);
    await put(B);
    await put(C);

    const rows = await ctx.db.select().from(boardHistory).orderBy(asc(boardHistory.version));
    assert.deepEqual(rows.map((row) => row.version), [1, 2, 3]);
    assert.equal(asRecord((await get()).body).version, 4, "current continues the sequence");
  });

  it("never holds the same version in both places", async () => {
    await put(A);
    await put(B);
    const currentVersion = asRecord((await get()).body).version;
    const rows = await ctx.db.select().from(boardHistory);
    assert.ok(
      !rows.some((row) => row.version === currentVersion),
      "a version is either current or archived, never both",
    );
  });

  it("timestamps each archived version", async () => {
    await put(A);
    await put(B);
    const rows = await ctx.db.select().from(boardHistory).orderBy(asc(boardHistory.id));
    for (const row of rows) {
      assert.ok(row.replacedAt instanceof Date);
      assert.ok(Number.isFinite(row.replacedAt.getTime()));
    }
    const [first, second] = rows;
    assert.ok(first && second);
    assert.ok(second.replacedAt.getTime() >= first.replacedAt.getTime(), "history must be chronological");
  });
});

describe("GET /api/board/history", () => {
  it("lists versions newest-first with summary counts and no payload", async () => {
    await put(A);
    await put(B);

    const response = await handleApi(apiRequest("GET", "/api/board/history"), { db: ctx.db });
    assert.equal(response.status, 200);
    const versions = asRecord(response.body).versions;
    assert.equal(versions.length, 2);
    assert.deepEqual(versions.map((v: { version: number }) => v.version), [2, 1]);

    const newest = versions[0];
    assert.equal(newest.areaCount, 1);
    assert.equal(newest.projectCount, 1);
    assert.equal(newest.source, "rest");
    assert.equal(typeof newest.replacedAt, "string");
    assert.equal(newest.board, undefined, "the listing must stay lightweight");
  });

  it("honours a limit", async () => {
    for (const label of ["A", "B", "C", "D"]) await put(labelledBoard(label));
    const response = await handleApi(apiRequest("GET", "/api/board/history", { query: { limit: "2" } }), {
      db: ctx.db,
    });
    assert.equal(asRecord(response.body).versions.length, 2);
  });

  it("returns an empty list on a fresh database", async () => {
    const response = await handleApi(apiRequest("GET", "/api/board/history"), { db: ctx.db });
    assert.deepEqual(asRecord(response.body).versions, []);
  });
});

describe("GET /api/board/history/:id", () => {
  it("returns one archived version including its board", async () => {
    await put(A);
    const putB = asRecord((await put(B)).body);

    const response = await handleApi(apiRequest("GET", "/api/board/history/" + putB.historyId), { db: ctx.db });
    assert.equal(response.status, 200);
    const entry = asRecord(response.body);
    assert.deepEqual(entry.board, A, "the row PUT B archived must hold A");
    assert.equal(entry.version, 2);
  });

  it("404s an id that does not exist", async () => {
    const response = await handleApi(apiRequest("GET", "/api/board/history/999999"), { db: ctx.db });
    assert.equal(response.status, 404);
    assert.equal(asRecord(response.body).error.code, "not_found");
  });
});

describe("restore — proving a rollback is possible", () => {
  it("rolls the board back to an archived version", async () => {
    await put(A);
    const putB = asRecord((await put(B)).body);
    await put(C);

    // putB.historyId is the row holding A.
    const restored = await boardService.restoreVersion(putB.historyId, { db: ctx.db });
    assert.deepEqual(restored.record.board, A);
    assert.deepEqual(asRecord((await get()).body).board, A, "the board is back to A");
  });

  it("archives the board it rolled back over, so a restore is itself undoable", async () => {
    await put(A);
    const putB = asRecord((await put(B)).body);

    await boardService.restoreVersion(putB.historyId, { db: ctx.db });
    const boards = await archivedBoards();
    assert.deepEqual(boards, [{ areas: [] }, A, B], "B must be archived by the restore");
  });

  it("marks a restore with its own source", async () => {
    await put(A);
    const putB = asRecord((await put(B)).body);
    await boardService.restoreVersion(putB.historyId, { db: ctx.db });

    const rows = await ctx.db.select().from(boardHistory).orderBy(asc(boardHistory.id));
    assert.equal(rows.at(-1)?.source, "restore");
  });

  it("refuses to restore a version that does not exist", async () => {
    await assert.rejects(() => boardService.restoreVersion(424242, { db: ctx.db }), NotFoundError);
  });
});

describe("saveHistory used directly", () => {
  it("archives a snapshot without touching the current board", async () => {
    await put(A);
    const before = asRecord((await get()).body);

    const id = await boardService.saveHistory(B, 99, { source: "seed", db: ctx.db });
    assert.equal(typeof id, "number");

    const after = asRecord((await get()).body);
    assert.deepEqual(after.board, before.board);
    assert.equal(after.version, before.version);
  });
});
