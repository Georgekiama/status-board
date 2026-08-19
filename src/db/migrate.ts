import { fileURLToPath } from "node:url";
import { getDbHandle, PGLITE_MIGRATOR_MODULE, type Db, type DriverKind } from "./client.ts";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

/**
 * Apply pending Drizzle migrations to a specific connection. Driver-agnostic:
 * each driver ships its own migrator, so we dispatch on the driver kind.
 */
export async function applyMigrations(db: Db, driver: DriverKind): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };

  switch (driver) {
    case "pglite": {
      // Non-literal specifier: keeps PGlite out of the production bundle.
      const { migrate } = (await import(PGLITE_MIGRATOR_MODULE)) as typeof import("drizzle-orm/pglite/migrator");
      await migrate(db as never, config);
      return;
    }
    case "neon": {
      const { migrate } = await import("drizzle-orm/neon-serverless/migrator");
      await migrate(db as never, config);
      return;
    }
    default: {
      const { migrate } = await import("drizzle-orm/node-postgres/migrator");
      await migrate(db as never, config);
      return;
    }
  }
}

/** Migrate the process-wide connection described by DATABASE_URL. */
export async function runMigrations(explicitUrl?: string): Promise<{ driver: DriverKind; url: string }> {
  const handle = await getDbHandle(explicitUrl);
  await applyMigrations(handle.db, handle.driver);
  return { driver: handle.driver, url: handle.url };
}
