import { defineConfig } from "drizzle-kit";

/**
 * Only used by `npm run db:generate` (SQL generation from the schema) and by
 * `drizzle-kit studio`. Runtime migrations go through scripts/migrate.ts, which
 * supports all three drivers.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/statusboard",
  },
  strict: true,
  verbose: true,
});
