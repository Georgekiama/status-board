import { z } from "zod";
import type { Board } from "./types.ts";

/** Refuse absurd payloads outright. The real board is a few KB. */
export const MAX_BOARD_BYTES = 1_000_000;

/**
 * The four statuses the board understands, confirmed against status-board.html:
 * `const STATUS = { green, amber, red, gray }`.
 *
 * This is a hard enum, not a warning, and `status` is required. The frontend
 * does `STATUS[p.status].cls` while rendering every row, so a status outside
 * this set (or a missing one) throws and the whole board renders blank. Storing
 * such a board would take the board down for everyone, which matters most for
 * writes arriving from the MCP agent.
 */
export const KNOWN_STATUSES = ["green", "amber", "red", "gray"] as const;

export type KnownStatus = (typeof KNOWN_STATUSES)[number];

export interface ValidationIssue {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; board: Board; warnings: string[] }
  | { ok: false; errors: ValidationIssue[] };

const projectSchema = z
  .object({
    id: z.string({ required_error: "project id is required" }).trim().min(1, "project id cannot be empty"),
    name: z.string().optional(),
    owner: z.string().optional(),
    // Required and closed: an unknown status breaks rendering for everyone.
    // One errorMap so a missing status and a bogus status read the same way —
    // an agent retrying after a rejection should not have to parse two formats.
    status: z.enum(KNOWN_STATUSES, {
      errorMap: () => ({
        message: "project status is required and must be one of: " + KNOWN_STATUSES.join(", "),
      }),
    }),
    note: z.string().optional(),
    updated: z.string().optional(),
    flag: z.boolean().optional(),
  })
  .passthrough();

const areaSchema = z
  .object({
    name: z.string().optional(),
    projects: z.array(projectSchema, { required_error: "area.projects is required" }),
  })
  .passthrough();

const boardSchema = z
  .object({
    areas: z.array(areaSchema, { required_error: "board.areas is required" }),
  })
  .passthrough();

function formatPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "board";
  return `board.${path.map((p) => (typeof p === "number" ? `[${p}]` : p)).join(".").replace(/\.\[/g, "[")}`;
}

/**
 * Validate an incoming board payload.
 *
 * Guarantees: this function never touches the database, so a rejected payload
 * cannot possibly disturb the stored board (plan.md section 10 step 4).
 */
export function validateBoard(input: unknown): ValidationResult {
  if (input === null || input === undefined) {
    return { ok: false, errors: [{ path: "board", message: "board payload is required" }] };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ path: "board", message: `board must be a JSON object, received ${describe(input)}` }],
    };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, errors: [{ path: "board", message: "board is not serialisable as JSON" }] };
  }
  if (serialized === undefined) {
    return { ok: false, errors: [{ path: "board", message: "board is not serialisable as JSON" }] };
  }
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_BOARD_BYTES) {
    return {
      ok: false,
      errors: [{ path: "board", message: `board is too large (${bytes} bytes, limit ${MAX_BOARD_BYTES})` }],
    };
  }

  const parsed = boardSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const board = parsed.data as Board;
  return { ok: true, board, warnings: collectWarnings(board) };
}

/** Non-fatal observations. Surfaced to the caller but never block a write. */
function collectWarnings(board: Board): string[] {
  const warnings: string[] = [];
  const seen = new Map<string, number>();

  if (board.areas.length === 0) warnings.push("board.areas is empty — the board will render with no content");

  board.areas.forEach((area, areaIndex) => {
    const areaLabel = area.name?.trim() ? `"${area.name}"` : `areas[${areaIndex}]`;
    if (!area.name?.trim()) warnings.push(`${areaLabel} has no name`);

    area.projects.forEach((project, projectIndex) => {
      const where = `${areaLabel}.projects[${projectIndex}]`;
      const count = (seen.get(project.id) ?? 0) + 1;
      seen.set(project.id, count);
      if (count === 2) warnings.push(`duplicate project id "${project.id}" — the frontend keys on id`);

      if (!project.name?.trim()) warnings.push(`${where} (id "${project.id}") has no name`);

      if (project.updated !== undefined && project.updated !== "" && !isDateLike(project.updated)) {
        warnings.push(`${where} (id "${project.id}") updated="${project.updated}" is not a YYYY-MM-DD date`);
      }
    });
  });

  return warnings;
}

function isDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
