import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BoardError, BoardValidationError } from "../board/errors.ts";
import { boardService } from "../board/service.ts";
import type { Board, BoardRecord } from "../board/types.ts";
import type { Db } from "../db/client.ts";

export const MCP_SERVER_NAME = "litnmore-status-board";
export const MCP_SERVER_VERSION = "1.0.0";

export interface McpContext {
  /** Injected connection (tests). Falls back to DATABASE_URL. */
  db?: Db;
}

/**
 * Shapes mirrored from src/board/types.ts. These exist so the tool's JSON
 * Schema tells the model what a board looks like; the authoritative check is
 * still boardService.validateBoard, exactly as for the REST API.
 */
const projectSchema = z
  .object({
    // Required in practice, optional here on purpose: boardService.validateBoard
    // is the single authority on what a valid board is (plan.md section 9), so
    // both interfaces reject the same payloads with the same explanations
    // rather than the MCP layer failing first with a protocol-level error.
    id: z.string().optional().describe("REQUIRED. Stable project id, unique across the whole board."),
    name: z.string().optional().describe("Project name as shown on the board."),
    owner: z.string().optional().describe("Person accountable for the project."),
    status: z
      .string()
      .optional()
      .describe(
        "REQUIRED. Exactly one of: green (moving), amber (watch), red (blocked), " +
          "gray (needs update). Any other value is rejected — the board cannot render it.",
      ),
    note: z.string().optional().describe("Short free-text status note."),
    updated: z.string().optional().describe("Date this row was last updated, as YYYY-MM-DD."),
    flag: z.boolean().optional().describe("True when the row is flagged for Kris."),
  })
  .passthrough();

const areaSchema = z
  .object({
    name: z.string().optional().describe("Area heading, e.g. Legal ops / trial support."),
    projects: z.array(projectSchema).optional().describe("REQUIRED. Projects in this area, in display order."),
  })
  .passthrough();

const boardSchema = z
  .object({
    areas: z.array(areaSchema).optional().describe("REQUIRED. Every area on the board, in display order."),
  })
  .passthrough();

function projectCount(board: Board): number {
  return board.areas.reduce((total, area) => total + (area.projects?.length ?? 0), 0);
}

function summarise(record: BoardRecord) {
  return {
    version: record.version,
    updatedAt: record.updatedAt,
    areaCount: record.board.areas.length,
    projectCount: projectCount(record.board),
  };
}

function textResult(payload: unknown, structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: structured,
  };
}

function errorResult(message: string, detail?: unknown) {
  const text = detail === undefined ? message : message + "\n\n" + JSON.stringify(detail, null, 2);
  return { content: [{ type: "text" as const, text }], isError: true };
}

/**
 * Build the MCP server.
 *
 * plan.md sections 8 and 9: exactly two tools, and both go through
 * `boardService` — there is no second database implementation here, so the
 * browser and the automation cannot drift apart.
 */
export function createMcpServer(ctx: McpContext = {}): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "The Lit & More status board is a single shared document. To change anything, call " +
        "get_board first, edit the object you receive, then send the COMPLETE board back " +
        "through update_board — an update replaces the whole board. The previous version is " +
        "always archived, so a bad write can be rolled back, but a partial board will still " +
        "look to the team like rows were deleted.",
    },
  );

  server.registerTool(
    "get_board",
    {
      title: "Get the status board",
      description:
        "Return the current Lit & More status board as JSON, together with its version number. " +
        "Always call this before update_board so you edit the live board rather than a guess. " +
        "Equivalent to GET /api/board.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const record = await boardService.getBoard({ db: ctx.db });
        const payload = { ...summarise(record), createdAt: record.createdAt, board: record.board };
        return textResult(payload, payload);
      } catch (error) {
        return errorResult("Could not read the board: " + messageOf(error));
      }
    },
  );

  server.registerTool(
    "update_board",
    {
      title: "Replace the status board",
      description:
        "Replace the entire status board with the board you supply. The board currently stored " +
        "is archived to board_history first, so this is reversible, but it is a whole-document " +
        "write: anything you omit disappears from the board. Call get_board, modify the result, " +
        "and send it back complete. Pass expectedVersion (the version get_board returned) to " +
        "have the write rejected if somebody edited the board in the meantime. " +
        "Equivalent to PUT /api/board.",
      inputSchema: {
        board: boardSchema.describe("The COMPLETE board to store. Partial boards delete rows."),
        expectedVersion: z
          .number()
          .int()
          .optional()
          .describe("Version from get_board. When supplied and stale, the write is rejected instead of overwriting."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ board, expectedVersion }) => {
      let previous: BoardRecord | undefined;
      try {
        previous = await boardService.getBoard({ db: ctx.db });
      } catch {
        previous = undefined;
      }

      try {
        const result = await boardService.updateBoard(board, {
          source: "mcp",
          expectedVersion,
          db: ctx.db,
        });

        const before = previous ? projectCount(previous.board) : undefined;
        const after = projectCount(result.record.board);
        const notes = [...result.warnings];
        if (before !== undefined && after < before) {
          notes.push(
            "This write reduced the project count from " +
              before +
              " to " +
              after +
              ". If that was not intended, restore history id " +
              result.historyId +
              ".",
          );
        }

        const payload = {
          ok: true,
          ...summarise(result.record),
          previousVersion: result.previousVersion,
          archivedAsHistoryId: result.historyId,
          warnings: notes,
          board: result.record.board,
        };
        return textResult(payload, payload);
      } catch (error) {
        if (error instanceof BoardValidationError) {
          return errorResult(
            "The board was rejected and nothing was changed. Fix these problems and try again:",
            error.issues,
          );
        }
        if (error instanceof BoardError) {
          return errorResult("The board was not changed: " + error.message);
        }
        return errorResult("Could not write the board: " + messageOf(error));
      }
    },
  );

  return server;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
