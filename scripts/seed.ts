/**
 * Load a starter board.
 *
 *   npm run db:seed                       # seed only if the board is empty
 *   npm run db:seed -- --file board.json  # seed from a file
 *   npm run db:seed -- --force            # overwrite a non-empty board
 *
 * An overwrite goes through boardService, so the board it replaces is archived
 * to board_history like any other write.
 */
import { readFile } from "node:fs/promises";
import { closeDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { boardService } from "../src/board/service";
import type { Board } from "../src/board/types";

const STARTER_BOARD: Board = {
  areas: [
    {
      name: "Legal ops / trial support",
      projects: [
        {
          id: "fl-sweep",
          name: "Florida Trial Sweep",
          owner: "Barbrah Shiundu",
          status: "amber",
          note: "Placeholder row from the seed script — replace with real data.",
          updated: "2026-08-19",
          flag: false,
        },
      ],
    },
  ],
};

function flag(name: string): boolean {
  return process.argv.includes("--" + name);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf("--" + name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  await runMigrations();

  const file = option("file");
  let board: Board = STARTER_BOARD;
  if (file) {
    board = JSON.parse(await readFile(file, "utf8")) as Board;
    console.log("[seed] loaded board from " + file);
  }

  const current = await boardService.getBoard();
  const isEmpty = current.board.areas.length === 0;

  if (!isEmpty && !flag("force")) {
    console.log(
      "[seed] board already has " +
        current.board.areas.length +
        " area(s) at version " +
        current.version +
        " — refusing to overwrite. Re-run with --force if that is what you want.",
    );
    return;
  }

  const result = await boardService.updateBoard(board, { source: "seed" });
  console.log("[seed] board written, now at version " + result.record.version);
  console.log("[seed] previous version archived as history id " + result.historyId);
  for (const warning of result.warnings) console.log("[seed] warning: " + warning);
}

main()
  .catch((error) => {
    console.error("[seed] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
