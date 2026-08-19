/**
 * plan.md section 10, Step 1 — Database.
 *
 * Connection, migration, insert current board, read current board, insert
 * history record, update current board. Nothing else is built on top of this
 * until these pass.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { desc, eq } from "drizzle-orm";
import { board, boardHistory, SINGLETON_BOARD_ID } from "../src/db/schema";
import { detectDriver } from "../src/db/client";
import type { Board } from "../src/board/types";
import {
  assertDbRejects,
  createTestDb,
  labelledBoard,
  sampleBoard,
  TEST_DATABASE_URL,
  type TestDb,
} from "./helpers";

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

describe("driver detection", () => {
  it("routes Neon hosts to the Neon serverless driver", () => {
    assert.equal(detectDriver("postgresql://u:p@ep-cool-name-123456-pooler.us-east-2.aws.neon.tech/db"), "neon");
  });
  it("routes plain hosts to node-postgres", () => {
    assert.equal(detectDriver("postgresql://postgres:postgres@localhost:5432/statusboard"), "postgres");
  });
  it("routes the pglite scheme to PGlite", () => {
    assert.equal(detectDriver("pglite://.pglite/statusboard"), "pglite");
    assert.equal(detectDriver("memory://"), "pglite");
  });
});

describe("connection and migration", () => {
  it("connects and answers a trivial query", async () => {
    const rows = await ctx.db.select().from(board);
    assert.ok(Array.isArray(rows));
  });

  it("created both tables with the expected columns", async () => {
    // Selecting every column proves the migration produced the full shape.
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data: sampleBoard() });
    const [row] = await ctx.db.select().from(board);
    assert.ok(row);
    assert.deepEqual(Object.keys(row).sort(), ["createdAt", "data", "id", "updatedAt", "version"]);
  });

  it("is idempotent — re-running migrations is a no-op", async () => {
    const { applyMigrations } = await import("../src/db/migrate");
    await applyMigrations(ctx.db, detectDriver(TEST_DATABASE_URL));
    const rows = await ctx.db.select().from(board);
    assert.equal(rows.length, 0);
  });
});

describe("board table", () => {
  it("inserts and reads back the current board unchanged", async () => {
    const data = sampleBoard();
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data });

    const [row] = await ctx.db.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID));
    assert.ok(row);
    assert.deepEqual(row.data, data, "JSONB round-trip must preserve the board exactly");
    assert.equal(row.version, 1);
    assert.ok(row.createdAt instanceof Date);
    assert.ok(row.updatedAt instanceof Date);
  });

  it("preserves unknown fields the frontend may add", async () => {
    const data: Board = {
      areas: [
        { name: "A", projects: [{ id: "p1", name: "P", status: "green", customField: { nested: [1, 2, 3] } }] },
      ],
      boardLevelExtra: "keep me",
    };
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data });
    const [row] = await ctx.db.select().from(board);
    assert.deepEqual(row?.data, data);
  });

  it("preserves array order but not object key order, as jsonb does", async () => {
    // Postgres jsonb stores object keys sorted, so a round trip can reorder
    // keys. That is invisible to the frontend, which reads by property name --
    // but the ordering that DOES matter (areas and projects on screen) comes
    // from array order, and arrays are preserved exactly. Pinned here so nobody
    // later mistakes reordered keys for corrupted data.
    const data: Board = {
      areas: [
        { name: "Second-listed area", projects: [{ id: "z-last", name: "Z", status: "red" }] },
        { name: "First-listed area", projects: [{ id: "a-first", name: "A", status: "green" }] },
      ],
    };
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data });

    const [row] = await ctx.db.select().from(board);
    assert.ok(row);
    assert.deepStrictEqual(row.data, data, "every value must survive the round trip");
    assert.deepEqual(
      row.data.areas.map((area) => area.name),
      ["Second-listed area", "First-listed area"],
      "area order drives display order and must be preserved",
    );
    assert.deepEqual(
      row.data.areas.flatMap((area) => area.projects.map((project) => project.id)),
      ["z-last", "a-first"],
      "project order within an area must be preserved",
    );
  });

  it("refuses a second board row — the board is a singleton", async () => {
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data: sampleBoard() });
    await assertDbRejects(
      () => ctx.db.insert(board).values({ id: 2, version: 1, data: sampleBoard() }),
      /board_is_singleton|check constraint/i,
    );
    await assertDbRejects(
      () => ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data: sampleBoard() }),
      /duplicate key|unique|board_pkey/i,
    );
  });

  it("updates the current board in place", async () => {
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data: labelledBoard("A") });
    const next = labelledBoard("B");

    await ctx.db
      .update(board)
      .set({ data: next, version: 2 })
      .where(eq(board.id, SINGLETON_BOARD_ID));

    const rows = await ctx.db.select().from(board);
    assert.equal(rows.length, 1, "update must not create a second row");
    assert.deepEqual(rows[0]?.data, next);
    assert.equal(rows[0]?.version, 2);
  });
});

describe("board_history table", () => {
  it("inserts a history record and reads it back", async () => {
    const archived = labelledBoard("A");
    const inserted = await ctx.db
      .insert(boardHistory)
      .values({ version: 1, data: archived, source: "rest" })
      .returning();

    assert.equal(inserted.length, 1);
    const row = inserted[0];
    assert.ok(row);
    assert.equal(typeof row.id, "number");
    assert.equal(row.version, 1);
    assert.equal(row.source, "rest");
    assert.deepEqual(row.data, archived);
    assert.ok(row.replacedAt instanceof Date);
  });

  it("accepts many versions and orders them newest-first", async () => {
    for (const [index, label] of ["A", "B", "C"].entries()) {
      await ctx.db.insert(boardHistory).values({ version: index + 1, data: labelledBoard(label), source: "rest" });
    }

    const rows = await ctx.db
      .select()
      .from(boardHistory)
      .orderBy(desc(boardHistory.version));

    assert.deepEqual(
      rows.map((r) => r.version),
      [3, 2, 1],
    );
  });

  it("records which interface wrote each version", async () => {
    await ctx.db.insert(boardHistory).values({ version: 1, data: labelledBoard("A"), source: "mcp" });
    const [row] = await ctx.db.select().from(boardHistory);
    assert.equal(row?.source, "mcp");
  });

  it("defaults source to rest when unspecified", async () => {
    await ctx.db.insert(boardHistory).values({ version: 1, data: labelledBoard("A") });
    const [row] = await ctx.db.select().from(boardHistory);
    assert.equal(row?.source, "rest");
  });
});

describe("transactions", () => {
  it("rolls back a failed archive+replace so the board is untouched", async () => {
    const original = labelledBoard("A");
    await ctx.db.insert(board).values({ id: SINGLETON_BOARD_ID, version: 1, data: original });

    await assert.rejects(async () => {
      await ctx.db.transaction(async (tx) => {
        await tx.insert(boardHistory).values({ version: 1, data: original, source: "rest" });
        await tx.update(board).set({ data: labelledBoard("B"), version: 2 }).where(eq(board.id, SINGLETON_BOARD_ID));
        throw new Error("simulated failure after both writes");
      });
    }, /simulated failure/);

    const [row] = await ctx.db.select().from(board);
    assert.deepEqual(row?.data, original, "board must survive a rolled-back transaction");
    assert.equal(row?.version, 1);
    const history = await ctx.db.select().from(boardHistory);
    assert.equal(history.length, 0, "history must roll back too");
  });
});
