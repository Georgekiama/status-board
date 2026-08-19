/**
 * Apply database migrations. Safe to run repeatedly.
 *
 *   npm run db:migrate
 */
import { closeDb } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { boardService } from "../src/board/service.ts";

async function main(): Promise<void> {
  const { driver, url } = await runMigrations();
  console.log("[migrate] driver: " + driver);
  console.log("[migrate] target: " + redact(url));
  console.log("[migrate] schema is up to date");

  const record = await boardService.initialize();
  console.log("[migrate] board row present, current version " + record.version);
}

/** Never print credentials, even into a CI log. */
function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}

main()
  .catch((error) => {
    console.error("[migrate] failed:", error);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
