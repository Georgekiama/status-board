/**
 * Roll the board back to an archived version.
 *
 *   npm run db:history                        # find the id you want
 *   npm run db:restore -- --id 12 --dry-run   # see what would happen
 *   npm run db:restore -- --id 12             # do it
 *
 * The board being rolled over is archived first, so a restore is itself
 * undoable. Deliberately CLI-only: there is no public rollback endpoint.
 */
import { closeDb } from "../src/db/client.ts";
import { boardService } from "../src/board/service.ts";
import type { Board } from "../src/board/types.ts";

function option(name: string): string | undefined {
  const index = process.argv.indexOf("--" + name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function describe(board: Board): string {
  const projects = board.areas.reduce((total, area) => total + (area.projects?.length ?? 0), 0);
  return board.areas.length + " area(s), " + projects + " project(s)";
}

async function main(): Promise<void> {
  const id = option("id");
  if (!id || !/^\d+$/.test(id)) {
    console.error("Usage: npm run db:restore -- --id <historyId> [--dry-run]");
    console.error("Run `npm run db:history` to list the available ids.");
    process.exitCode = 1;
    return;
  }

  const entry = await boardService.getHistoryEntry(Number(id));
  const current = await boardService.getBoard();

  console.log("current board:  version " + current.version + " — " + describe(current.board));
  console.log("restore target: history id " + entry.id + ", version " + entry.version + " — " + describe(entry.board));
  console.log("                archived at " + entry.replacedAt + " (replaced by a " + entry.source + " write)");

  if (process.argv.includes("--dry-run")) {
    console.log("");
    console.log("[restore] dry run — nothing was changed.");
    return;
  }

  const result = await boardService.restoreVersion(Number(id));
  console.log("");
  console.log("[restore] board restored, now at version " + result.record.version);
  console.log("[restore] the board it replaced was archived as history id " + result.historyId);
  console.log("[restore] to undo this restore: npm run db:restore -- --id " + result.historyId);
}

main()
  .catch((error) => {
    console.error("[restore] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
