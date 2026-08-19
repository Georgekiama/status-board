import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import type { Board, WriteSource } from "../board/types";

/**
 * The board is a single shared document (plan.md section 2), so `board` holds
 * exactly one row, pinned to this id by a CHECK constraint.
 */
export const SINGLETON_BOARD_ID = 1;

export const board = pgTable(
  "board",
  {
    id: integer("id").primaryKey().default(SINGLETON_BOARD_ID),
    /** Bumped on every successful write. Also used for optimistic concurrency. */
    version: integer("version").notNull().default(1),
    data: jsonb("data").$type<Board>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("board_is_singleton", sql`${t.id} = ${sql.raw(String(SINGLETON_BOARD_ID))}`)],
);

/**
 * Every board that gets replaced is copied here first. `version` is the version
 * the snapshot *was* while it was current, so history version N and current
 * version N are never both present.
 */
export const boardHistory = pgTable(
  "board_history",
  {
    id: serial("id").primaryKey(),
    version: integer("version").notNull(),
    data: jsonb("data").$type<Board>().notNull(),
    /** "rest" | "mcp" | "seed" | "restore" — which interface performed the write. */
    source: text("source").$type<WriteSource>().notNull().default("rest"),
    replacedAt: timestamp("replaced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("board_history_replaced_at_idx").on(t.replacedAt),
    index("board_history_version_idx").on(t.version),
  ],
);

export type BoardRow = typeof board.$inferSelect;
export type BoardHistoryRow = typeof boardHistory.$inferSelect;
