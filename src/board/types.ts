/**
 * Board data contract.
 *
 * Confirmed against the real status-board.html: the board is
 * `{ areas: [ { name, projects: [ { id, name, owner, status, note, updated, flag } ] } ] }`
 * and nothing else. It is still stored as a single JSONB document with unknown
 * fields preserved verbatim, so the frontend can add fields without a backend
 * change — but `status` is closed, because the frontend indexes its STATUS map
 * with it and a stray value blanks the whole board.
 */

import type { KnownStatus } from "./validate.ts";

export interface Project {
  /** Stable identifier the frontend uses as a key. Required. */
  id: string;
  name: string;
  owner?: string;
  /** Required. One of KNOWN_STATUSES: green | amber | red | gray. */
  status: KnownStatus;
  note?: string;
  /** ISO-ish date string, e.g. "2026-07-07" */
  updated?: string;
  /** "Flag for Kris" marker */
  flag?: boolean;
  /** Any additional fields the frontend sends are preserved as-is. */
  [key: string]: unknown;
}

export interface Area {
  name: string;
  projects: Project[];
  [key: string]: unknown;
}

export interface Board {
  areas: Area[];
  [key: string]: unknown;
}

/** Where a write came from. Recorded on every history row. */
export type WriteSource = "rest" | "mcp" | "seed" | "restore";

/** The current board plus its storage metadata. */
export interface BoardRecord {
  board: Board;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** One previous version of the board. */
export interface HistoryEntry {
  id: number;
  version: number;
  source: WriteSource;
  replacedAt: string;
  board: Board;
}

/** History row without the payload — for cheap listing. */
export type HistorySummary = Omit<HistoryEntry, "board"> & {
  areaCount: number;
  projectCount: number;
};
