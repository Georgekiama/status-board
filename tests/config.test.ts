/**
 * The /config.js seam.
 *
 * The board gets its API token from config.js, generated at build time on Vercel
 * and served from the environment in local development. If that file is wrong the
 * board silently fails to save once a token is configured, so it is exercised the
 * way a browser actually consumes it: config.js first, then board-api.js, then
 * the board's own two storage calls.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startNodeServer, type RunningServer } from "../src/http/node-server";
import { renderConfig } from "../scripts/write-config";
import { asRecord, createTestDb, labelledBoard, type TestDb } from "./helpers";

const SCRIPT_PATH = fileURLToPath(new URL("../public/board-api.js", import.meta.url));
const TOKEN = "test-token-abc123";

let ctx: TestDb;
let secured: RunningServer;
let open: RunningServer;
let shimSource: string;

before(async () => {
  ctx = await createTestDb();
  secured = await startNodeServer(0, { db: ctx.db, env: { ...process.env, API_TOKEN: TOKEN, ALLOWED_ORIGINS: "" } });
  open = await startNodeServer(0, { db: ctx.db, env: { ...process.env, API_TOKEN: "", ALLOWED_ORIGINS: "" } });
  shimSource = await readFile(SCRIPT_PATH, "utf8");
});
after(async () => {
  await secured.close();
  await open.close();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

interface BoardStorage {
  get(key: string, shared?: boolean): Promise<{ value: string }>;
  set(key: string, value: string, shared?: boolean): Promise<unknown>;
}

/**
 * Load config.js then board-api.js into one sandboxed window, exactly as the
 * page's two script tags do, and return the resulting window.storage.
 */
function loadPage(configSource: string, endpoint: string): BoardStorage {
  const win: Record<string, unknown> = {};
  const sandbox: Record<string, unknown> = {
    window: win,
    console,
    setTimeout,
    clearTimeout,
    fetch,
    Promise,
    Object,
    Error,
    JSON,
  };
  const context = createContext(sandbox);

  // <script src="/config.js">
  runInContext(configSource, context, { filename: "config.js" });
  // The board is same-origin in production; tests need an absolute endpoint,
  // and banner/debounce off so assertions are deterministic.
  const existing = (win.BOARD_API_OPTIONS ?? {}) as Record<string, unknown>;
  win.BOARD_API_OPTIONS = { ...existing, endpoint, banner: false, debounceMs: 0 };
  // <script src="/board-api.js">
  runInContext(shimSource, context, { filename: "board-api.js" });

  const storage = win.storage as BoardStorage | undefined;
  assert.ok(storage, "board-api.js must define window.storage synchronously");
  return storage;
}

describe("renderConfig", () => {
  it("emits the token when one is configured", () => {
    const source = renderConfig({ API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    assert.match(source, /window\.BOARD_API_OPTIONS/);
    assert.ok(source.includes(TOKEN));
  });

  it("emits no token when the API is open", () => {
    const source = renderConfig({} as NodeJS.ProcessEnv);
    assert.match(source, /\{\}/);
    assert.ok(!source.includes("token"));
  });

  it("never invents a token from an empty variable", () => {
    const source = renderConfig({ API_TOKEN: "" } as NodeJS.ProcessEnv);
    assert.ok(!source.includes("token"));
  });

  it("merges rather than clobbering options the page set first", () => {
    // The page may define window.BOARD_API_OPTIONS before config.js loads.
    const source = renderConfig({ API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    assert.match(source, /Object\.assign\(window\.BOARD_API_OPTIONS \|\| \{\}/);
  });

  it("produces valid JavaScript", () => {
    const win: Record<string, unknown> = {};
    const context = createContext({ window: win, Object, JSON });
    runInContext(renderConfig({ API_TOKEN: TOKEN } as NodeJS.ProcessEnv), context, { filename: "config.js" });
    assert.equal((win.BOARD_API_OPTIONS as { token?: string }).token, TOKEN);
  });
});

describe("GET /config.js", () => {
  it("serves the token from the environment", async () => {
    const response = await fetch(secured.origin + "/config.js");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.ok((await response.text()).includes(TOKEN));
  });

  it("is never cached, so a rotated token cannot linger", async () => {
    const response = await fetch(secured.origin + "/config.js");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  });

  it("serves an empty config when no token is set", async () => {
    const response = await fetch(open.origin + "/config.js");
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes("token"));
  });

  it("needs no token itself, or the board could never bootstrap", async () => {
    // /config.js is fetched before the board has any credential at all.
    const response = await fetch(secured.origin + "/config.js");
    assert.equal(response.status, 200);
  });
});

describe("the board bootstraps through config.js", () => {
  it("loads and saves against a token-protected API", async () => {
    const config = renderConfig({ API_TOKEN: TOKEN } as NodeJS.ProcessEnv);
    const storage = loadPage(config, secured.origin + "/api/board");

    const loaded = await storage.get("board-data", true);
    assert.deepEqual(JSON.parse(loaded.value), { areas: [] });

    await storage.set("board-data", JSON.stringify(labelledBoard("via-config")), true);

    const response = await fetch(secured.origin + "/api/board", {
      headers: { Authorization: "Bearer " + TOKEN },
    });
    assert.deepEqual(asRecord(await response.json()).board, labelledBoard("via-config"));
  });

  it("fails loudly, not silently, when the config carries no token", async () => {
    // The failure mode this guards: config.js missing or generated without
    // API_TOKEN on a protected deployment. The board must not appear to work.
    const storage = loadPage(renderConfig({} as NodeJS.ProcessEnv), secured.origin + "/api/board");
    await assert.rejects(() => storage.get("board-data", true));
  });

  it("still works on an open deployment with an empty config", async () => {
    const storage = loadPage(renderConfig({} as NodeJS.ProcessEnv), open.origin + "/api/board");
    const loaded = await storage.get("board-data", true);
    assert.deepEqual(JSON.parse(loaded.value), { areas: [] });
  });
});
