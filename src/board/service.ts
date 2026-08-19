import { desc, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { board, boardHistory, SINGLETON_BOARD_ID } from "../db/schema";
import { BoardValidationError, NotFoundError, VersionConflictError } from "./errors";
import type { Board, BoardRecord, HistoryEntry, HistorySummary, WriteSource } from "./types";
import { validateBoard } from "./validate";

/** What a brand new, never-written board looks like. */
export const EMPTY_BOARD: Board = { areas: [] };

export interface UpdateOptions {
  /** Which interface performed the write. Recorded on the history row. */
  source?: WriteSource;
  /**
   * Opt-in optimistic concurrency (plan.md section 14). When omitted the write
   * is plain last-write-wins. When supplied and stale, the write is rejected
   * with 409 and the stored board is untouched.
   */
  expectedVersion?: number;
  /** Override the connection (tests). */
  db?: Db;
}

export interface UpdateResult {
  record: BoardRecord;
  /** id of the history row holding the board this write replaced. */
  historyId: number;
  /** Version that was archived. */
  previousVersion: number;
  warnings: string[];
}

function toRecord(row: { data: Board; version: number; createdAt: Date; updatedAt: Date }): BoardRecord {
  return {
    board: row.data,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function resolveDb(db?: Db): Promise<Db> {
  return db ?? (await getDb());
}

/**
 * Make sure the singleton row exists, then return it. Concurrent callers race
 * harmlessly: the primary key makes the second insert a no-op.
 */
async function ensureRow(db: Db) {
  const existing = await db.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID)).limit(1);
  if (existing[0]) return existing[0];

  await db
    .insert(board)
    .values({ id: SINGLETON_BOARD_ID, version: 1, data: EMPTY_BOARD })
    .onConflictDoNothing({ target: board.id });

  const created = await db.select().from(board).where(eq(board.id, SINGLETON_BOARD_ID)).limit(1);
  if (!created[0]) throw new Error("Failed to initialise the board row");
  return created[0];
}

/** Create the singleton row if absent. Safe to call repeatedly. */
export async function initialize(options: { db?: Db } = {}): Promise<BoardRecord> {
  const db = await resolveDb(options.db);
  return toRecord(await ensureRow(db));
}

/** Current board. Returns the empty board on first ever call. */
export async function getBoard(options: { db?: Db } = {}): Promise<BoardRecord> {
  const db = await resolveDb(options.db);
  return toRecord(await ensureRow(db));
}

/**
 * Replace the whole board.
 *
 * Order of operations matters and is the core safety property of this system:
 *
 *   1. validate the payload            (no database access at all)
 *   2. begin transaction, lock the row
 *   3. copy the current board into board_history
 *   4. overwrite the current board
 *
 * A failure at any step aborts before or inside the transaction, so the stored
 * board is either fully replaced or completely untouched.
 */
export async function updateBoard(input: unknown, options: UpdateOptions = {}): Promise<UpdateResult> {
  const validation = validateBoard(input);
  if (!validation.ok) throw new BoardValidationError(validation.errors);

  const db = await resolveDb(options.db);
  const source = options.source ?? "rest";

  await ensureRow(db);

  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(board)
      .where(eq(board.id, SINGLETON_BOARD_ID))
      .limit(1)
      .for("update");

    const current = locked[0];
    if (!current) throw new Error("Board row disappeared mid-transaction");

    if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) {
      throw new VersionConflictError(options.expectedVersion, current.version);
    }

    const archived = await tx
      .insert(boardHistory)
      .values({ version: current.version, data: current.data, source })
      .returning({ id: boardHistory.id });

    const historyId = archived[0]?.id;
    if (historyId === undefined) throw new Error("Failed to archive the previous board");

    const updated = await tx
      .update(board)
      .set({ data: validation.board, version: current.version + 1, updatedAt: sql`now()` })
      .where(eq(board.id, SINGLETON_BOARD_ID))
      .returning();

    const next = updated[0];
    if (!next) throw new Error("Failed to write the new board");

    return {
      record: toRecord(next),
      historyId,
      previousVersion: current.version,
      warnings: validation.warnings,
    };
  });
}

/**
 * Archive an arbitrary board snapshot without changing the current board.
 * Exposed because plan.md section 9 names it; `updateBoard` archives inline and
 * atomically, so normal writes do not call this.
 */
export async function saveHistory(
  data: Board,
  version: number,
  options: { source?: WriteSource; db?: Db } = {},
): Promise<number> {
  const db = await resolveDb(options.db);
  const inserted = await db
    .insert(boardHistory)
    .values({ version, data, source: options.source ?? "rest" })
    .returning({ id: boardHistory.id });
  const id = inserted[0]?.id;
  if (id === undefined) throw new Error("Failed to insert history row");
  return id;
}

/** Newest-first list of previous versions, without their payloads. */
export async function listHistory(options: { limit?: number; db?: Db } = {}): Promise<HistorySummary[]> {
  const db = await resolveDb(options.db);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);

  const rows = await db
    .select()
    .from(boardHistory)
    .orderBy(desc(boardHistory.replacedAt), desc(boardHistory.id))
    .limit(limit);

  return rows.map((row) => {
    const areas = row.data?.areas ?? [];
    return {
      id: row.id,
      version: row.version,
      source: row.source,
      replacedAt: row.replacedAt.toISOString(),
      areaCount: areas.length,
      projectCount: areas.reduce((total, area) => total + (area.projects?.length ?? 0), 0),
    };
  });
}

/** One archived version, payload included. */
export async function getHistoryEntry(id: number, options: { db?: Db } = {}): Promise<HistoryEntry> {
  const db = await resolveDb(options.db);
  const rows = await db.select().from(boardHistory).where(eq(boardHistory.id, id)).limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError(`No board_history row with id ${id}`);
  return {
    id: row.id,
    version: row.version,
    source: row.source,
    replacedAt: row.replacedAt.toISOString(),
    board: row.data,
  };
}

/**
 * Roll the board back to an archived version. This is an ordinary write: the
 * board being replaced is itself archived first, so a restore is undoable.
 */
export async function restoreVersion(
  historyId: number,
  options: { db?: Db } = {},
): Promise<UpdateResult & { restoredFrom: HistoryEntry }> {
  const db = await resolveDb(options.db);
  const entry = await getHistoryEntry(historyId, { db });
  const result = await updateBoard(entry.board, { source: "restore", db });
  return { ...result, restoredFrom: entry };
}

/**
 * The shared service layer. plan.md section 9: REST and MCP both go through
 * this object so the browser and the automation can never behave differently.
 */
export const boardService = {
  initialize,
  getBoard,
  updateBoard,
  saveHistory,
  validateBoard,
  listHistory,
  getHistoryEntry,
  restoreVersion,
  EMPTY_BOARD,
};

export type BoardService = typeof boardService;
