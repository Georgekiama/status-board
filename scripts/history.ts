/**
 * Inspect board history.
 *
 *   npm run db:history                 # list previous versions, newest first
 *   npm run db:history -- --id 12      # print one archived board as JSON
 *   npm run db:history -- --id 12 --out backup.json
 */
import { writeFile } from "node:fs/promises";
import { closeDb } from "../src/db/client";
import { boardService } from "../src/board/service";

function option(name: string): string | undefined {
  const index = process.argv.indexOf("--" + name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const id = option("id");

  if (id) {
    const entry = await boardService.getHistoryEntry(Number(id));
    const out = option("out");
    if (out) {
      await writeFile(out, JSON.stringify(entry.board, null, 2), "utf8");
      console.log("[history] wrote history id " + entry.id + " (version " + entry.version + ") to " + out);
    } else {
      console.log(JSON.stringify(entry, null, 2));
    }
    return;
  }

  const current = await boardService.getBoard();
  const versions = await boardService.listHistory({ limit: Number(option("limit") ?? 50) });

  console.log("current: version " + current.version + ", updated " + current.updatedAt);
  if (versions.length === 0) {
    console.log("no archived versions yet");
    return;
  }

  console.log("");
  console.log("  id  version  replaced at                areas  projects  replaced by");
  console.log("  --  -------  -------------------------  -----  --------  -----------");
  for (const entry of versions) {
    console.log(
      "  " +
        String(entry.id).padEnd(4) +
        String(entry.version).padEnd(9) +
        entry.replacedAt.padEnd(27) +
        String(entry.areaCount).padEnd(7) +
        String(entry.projectCount).padEnd(10) +
        entry.source,
    );
  }
  console.log("");
  console.log("Restore one with:  npm run db:restore -- --id <id>");
}

main()
  .catch((error) => {
    console.error("[history] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
