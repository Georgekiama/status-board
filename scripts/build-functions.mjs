/**
 * Bundle the serverless functions into api/*.js.
 *
 * Why this exists: Vercel's Node builder transpiles api/*.ts per file rather
 * than bundling it, and does not ship the imported src/ tree into the function.
 * The deployed function then fails at module load with
 *
 *   Cannot find module '/var/task/src/board/types' — ERR_MODULE_NOT_FOUND
 *
 * so every request returned FUNCTION_INVOCATION_FAILED. Bundling here makes each
 * function a single self-contained file with no relative imports left to resolve,
 * which removes the dependency on how the platform handles TypeScript.
 *
 * Deliberately plain .mjs, run by plain node: this is on the critical deploy path
 * and should not also depend on tsx.
 */
import { rm, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = ROOT + "api";

const ENTRY_POINTS = ["functions/index.ts", "functions/mcp.ts", "functions/diag.ts"];

/**
 * Drivers production never uses. Their specifiers are already assembled at
 * runtime in src/db/client.ts so esbuild cannot see them, but marking them
 * external as well documents the intent and keeps the bundle honest if that
 * ever changes.
 *
 * `pg` in particular must stay out: it depends on pg-cloudflare, which imports
 * `cloudflare:sockets`, a specifier that does not resolve off Cloudflare.
 */
const EXTERNAL = [
  "pg",
  "pg-native",
  "pg-cloudflare",
  "@electric-sql/pglite",
  "drizzle-orm/pglite",
  "drizzle-orm/pglite/migrator",
  "drizzle-orm/node-postgres",
  "drizzle-orm/node-postgres/migrator",
];

async function main() {
  // Clear stale output so a renamed or deleted function cannot linger.
  await rm(OUT_DIR, { recursive: true, force: true });


  const result = await esbuild.build({
    entryPoints: ENTRY_POINTS,
    outdir: "api",
    outbase: "functions",
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    sourcemap: false,
    minify: false,
    // Everything in node_modules stays external and is resolved at runtime from
    // /var/task/node_modules, which the module probe confirmed works. Only this
    // project's own code is inlined -- that is the part Vercel does not ship.
    // It also keeps the committed output small and reviewable.
    packages: "external",
    external: EXTERNAL,
    // Some bundled dependencies are CommonJS and call require() at runtime.
    // In an ESM output that identifier does not exist, so provide it.
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "warning",
    metafile: true,
  });

  for (const warning of result.warnings) {
    console.warn("[functions] warning: " + warning.text);
  }

  const files = (await readdir(OUT_DIR)).sort();
  for (const file of files) {
    const info = await stat(OUT_DIR + "/" + file);
    console.log("[functions] api/" + file + "  " + Math.round(info.size / 1024) + " KB");
  }
  console.log("[functions] bundled " + files.length + " function(s)");
}

main().catch((error) => {
  console.error("[functions] build failed:", error);
  process.exit(1);
});
