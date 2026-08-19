/**
 * plan.md sections 5 and 13 — the frontend seam.
 *
 * public/board-api.js is the drop-in replacement for the Claude Artifact
 * `window.storage` API, so it is the one piece of browser code that can silently
 * lose an edit. It is loaded here the way a browser loads it (a classic script,
 * evaluated with a stub window) and driven against the real server.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startNodeServer, type RunningServer } from "../src/http/node-server.ts";
import { asRecord, createTestDb, labelledBoard, sampleBoard, type TestDb } from "./helpers.ts";

const SCRIPT_PATH = fileURLToPath(new URL("../public/board-api.js", import.meta.url));

/** The artifact API the board actually calls: get -> { value: <json string> }. */
interface BoardStorage {
  get(key?: string, shared?: boolean): Promise<{ value: string }>;
  set(key: string, value: string, shared?: boolean): Promise<unknown>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  getVersion(): number | null;
  flush(): Promise<unknown>;
}

interface StorageFactory {
  create(options: Record<string, unknown>): BoardStorage;
}

let ctx: TestDb;
let server: RunningServer;
let factory: StorageFactory;

/** Evaluate the browser script in a sandbox with no document, as Node has none. */
async function loadScript(): Promise<StorageFactory> {
  const source = await readFile(SCRIPT_PATH, "utf8");
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
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
  runInContext(source, context, { filename: "board-api.js" });
  const win = sandbox.window as { StatusBoardStorage?: StorageFactory };
  assert.ok(win.StatusBoardStorage, "the script must expose StatusBoardStorage");
  return win.StatusBoardStorage;
}

/** A storage instance pointed at the test server, banner disabled, no debounce. */
function storage(overrides: Record<string, unknown> = {}): BoardStorage {
  return factory.create({
    endpoint: server.origin + "/api/board",
    banner: false,
    debounceMs: 0,
    fetch,
    ...overrides,
  });
}

/**
 * Exactly what status-board.html does: loadData() then saveData(). The load is
 * mandatory — see the LOAD-GUARD note in board-api.js.
 */
async function loadedStorage(overrides: Record<string, unknown> = {}): Promise<BoardStorage> {
  const store = storage(overrides);
  await store.get("board-data", true);
  return store;
}

/** Mirror of the board's own `data = JSON.parse(res.value)`. */
function parseBoard(result: { value: string }): unknown {
  assert.equal(typeof result.value, "string", "the board does JSON.parse(res.value)");
  return JSON.parse(result.value);
}

/** Mirror of the board's own `set(key, JSON.stringify(data), true)`. */
function save(store: BoardStorage, board: unknown): Promise<unknown> {
  return store.set("board-data", JSON.stringify(board), true);
}

before(async () => {
  ctx = await createTestDb();
  server = await startNodeServer(0, { db: ctx.db, env: { ...process.env, API_TOKEN: "", ALLOWED_ORIGINS: "" } });
  factory = await loadScript();
});
after(async () => {
  await server.close();
  await ctx.close();
});
beforeEach(async () => {
  await ctx.reset();
});

describe("the artifact storage contract still holds", () => {
  it("get() resolves to { value: <json string> }, the shape the board parses", async () => {
    const board = sampleBoard();
    const store = await loadedStorage();
    await save(store, board);

    const result = await storage().get("board-data", true);
    assert.deepEqual(parseBoard(result), board, "the UI must receive exactly what it stored");
  });

  it("round-trips through the board's own two calls verbatim", async () => {
    // The literal sequence from status-board.html, with no adaptation.
    const store = storage();
    const res = await store.get("board-data", true);
    const data = JSON.parse(res.value) as { areas: unknown[] };
    assert.ok(Array.isArray(data.areas));

    await store.set("board-data", JSON.stringify(sampleBoard()), true);
    const reread = JSON.parse((await store.get("board-data", true)).value);
    assert.deepEqual(reread, sampleBoard());
  });

  it("ignores the key, because the board is one shared document", async () => {
    const store = await loadedStorage();
    await save(store, labelledBoard("A"));
    assert.deepEqual(parseBoard(await store.get("anything-else", true)), labelledBoard("A"));
  });

  it("returns the empty board before anything has been saved", async () => {
    assert.deepEqual(parseBoard(await storage().get("board-data", true)), { areas: [] });
  });

  it("exposes keys() and a delete() that refuses to wipe the shared board", async () => {
    const store = await loadedStorage();
    await save(store, sampleBoard());
    // keys() builds its array inside the VM realm, so normalise before comparing.
    assert.deepEqual(Array.from(await store.keys()), ["board"]);

    await store.delete("board-data");
    assert.deepEqual(parseBoard(await store.get("board-data", true)), sampleBoard(), "delete must not destroy it");
  });

  it("accepts a board object or an API envelope, not just a JSON string", async () => {
    const store = await loadedStorage();
    await store.set("board-data", labelledBoard("object") as unknown as string, true);
    assert.deepEqual(parseBoard(await store.get("board-data", true)), labelledBoard("object"));

    await store.set("board-data", { board: labelledBoard("wrapped") } as unknown as string, true);
    assert.deepEqual(parseBoard(await store.get("board-data", true)), labelledBoard("wrapped"));
  });

  it("tracks the version so a caller can detect a change", async () => {
    const store = storage();
    assert.equal(store.getVersion(), null, "unknown until the first request");
    await store.get("board-data", true);
    assert.equal(store.getVersion(), 1);
    await save(store, labelledBoard("A"));
    assert.equal(store.getVersion(), 2);
  });
});

describe("a failed save is never reported as success", () => {
  it("rejects and says not saved when the payload is invalid", async () => {
    await save(await loadedStorage(), sampleBoard());

    const states: Array<[string, string | undefined]> = [];
    const watched = await loadedStorage({
      onStatus: (state: string, detail: string | undefined) => states.push([state, detail]),
    });

    await assert.rejects(() => save(watched, { nope: true }));

    const failure = states.find(([state]) => state === "error");
    assert.ok(failure, "an error state must be reported: " + JSON.stringify(states));
    assert.match(failure[1] ?? "", /Not saved/, "the message must not imply the change persisted");

    // and the server still holds the good board
    const response = await fetch(server.origin + "/api/board");
    assert.deepEqual(asRecord(await response.json()).board, sampleBoard());
  });

  it("surfaces the validation detail so the user knows what to fix", async () => {
    const states: Array<[string, string | undefined]> = [];
    const store = await loadedStorage({ onStatus: (s: string, d: string | undefined) => states.push([s, d]) });

    await assert.rejects(() =>
      save(store, { areas: [{ name: "A", projects: [{ name: "no id", status: "green" }] }] }),
    );

    const failure = states.find(([state]) => state === "error");
    assert.match(failure?.[1] ?? "", /id/, "the reported reason should name the offending field");
  });

  it("reports offline rather than saved when the server is unreachable", async () => {
    const states: string[] = [];
    // Port 1 is not listening; the request cannot connect.
    const store = storage({
      endpoint: "http://127.0.0.1:1/api/board",
      retries: 0,
      onStatus: (state: string) => states.push(state),
    });

    await assert.rejects(() => store.get("board-data", true));
    await assert.rejects(() => save(store, sampleBoard()));
    assert.ok(!states.includes("saved"), "must never claim a save succeeded");
  });

  it("rejects a load that cannot reach the server instead of rendering stale data as current", async () => {
    const store = storage({ endpoint: "http://127.0.0.1:1/api/board", retries: 0 });
    await assert.rejects(() => store.get("board-data", true));
  });

  it("reports a version conflict in language the user can act on", async () => {
    const states: Array<[string, string | undefined]> = [];
    const store = await loadedStorage({ onStatus: (s: string, d: string | undefined) => states.push([s, d]) });

    await save(store, labelledBoard("A"));
    // Send a deliberately stale expectedVersion, the way a conflict would arrive.
    await assert.rejects(() => save(store, { ...labelledBoard("B"), expectedVersion: 1 }));

    const failure = states.find(([state]) => state === "error");
    assert.match(failure?.[1] ?? "", /Board has changed|saved the board first/i);
  });

  it("does not retry a rejected payload, since the result would be identical", async () => {
    let puts = 0;
    const countingFetch: typeof fetch = (input, init) => {
      if (init?.method === "PUT") puts += 1;
      return fetch(input as string, init);
    };
    const store = await loadedStorage({ fetch: countingFetch, retries: 3 });

    await assert.rejects(() => save(store, { not: "a board" }));
    assert.equal(puts, 1, "a 400 must be attempted exactly once, never retried");
  });
});

describe("saves are serialised", () => {
  it("applies rapid successive saves in order, with no lost update", async () => {
    const store = await loadedStorage();
    const boards = ["one", "two", "three", "four"].map((label) => labelledBoard(label));

    await Promise.all(boards.map((board) => save(store, board)));
    await store.flush().catch(() => undefined);

    const response = await fetch(server.origin + "/api/board");
    const body = asRecord(await response.json());
    assert.equal(body.version, 5, "all four saves landed, each archiving one version");
  });

  it("collapses a burst into a single request when debouncing is on", async () => {
    let calls = 0;
    const countingFetch: typeof fetch = (input, init) => {
      if (init?.method === "PUT") calls += 1;
      return fetch(input as string, init);
    };
    const store = await loadedStorage({ fetch: countingFetch, debounceMs: 30 });

    const saves = [save(store, labelledBoard("a")), save(store, labelledBoard("b")), save(store, labelledBoard("c"))];
    await Promise.all(saves);

    assert.equal(calls, 1, "a burst of edits should cost one request");
    const response = await fetch(server.origin + "/api/board");
    assert.deepEqual(asRecord(await response.json()).board, labelledBoard("c"), "the last edit wins");
  });

  it("keeps working after a failed save", async () => {
    const store = await loadedStorage();
    await assert.rejects(() => save(store, { bad: true }));

    // The next, valid save must still go through.
    await save(store, labelledBoard("recovered"));
    const response = await fetch(server.origin + "/api/board");
    assert.deepEqual(asRecord(await response.json()).board, labelledBoard("recovered"));
  });
});

describe("optional API token", () => {
  it("sends the token as a bearer credential", async () => {
    const secured = await startNodeServer(0, { db: ctx.db, env: { ...process.env, API_TOKEN: "t0ken" } });
    try {
      const withToken = factory.create({
        endpoint: secured.origin + "/api/board",
        banner: false,
        debounceMs: 0,
        fetch,
        token: "t0ken",
      });
      await withToken.get("board-data", true);
      await save(withToken, labelledBoard("secured"));
      assert.deepEqual(parseBoard(await withToken.get("board-data", true)), labelledBoard("secured"));

      const without = factory.create({
        endpoint: secured.origin + "/api/board",
        banner: false,
        debounceMs: 0,
        fetch,
      });
      await assert.rejects(() => without.get("board-data", true));
    } finally {
      await secured.close();
    }
  });
});

describe("the seed-data overwrite hazard", () => {
  /*
   * status-board.html does this:
   *
   *     try { data = JSON.parse((await storage.get(...)).value) }
   *     catch (e) { data = seedData; await saveData(); }
   *
   * So a load failure makes the page save its built-in seed board. Against a
   * live API that would replace real content with stale seed content. The shim
   * refuses to save until a load has succeeded, which is what makes a brief
   * outage harmless.
   */
  it("refuses to save before any load has succeeded", async () => {
    const states: Array<[string, string | undefined]> = [];
    const store = storage({ onStatus: (s: string, d: string | undefined) => states.push([s, d]) });

    await assert.rejects(() => save(store, sampleBoard()), /never loaded successfully/);
    assert.ok(!states.some(([state]) => state === "saved"));
  });

  it("does not let a failed load overwrite the real board with seed data", async () => {
    // A real board exists, saved by someone whose load worked.
    const healthy = await loadedStorage();
    await save(healthy, sampleBoard());

    // Another browser opens while the API is unreachable, so its load fails and
    // the page falls back to its seed board and tries to save it.
    const offline = storage({ endpoint: "http://127.0.0.1:1/api/board", retries: 0 });
    await assert.rejects(() => offline.get("board-data", true));
    await assert.rejects(() => save(offline, labelledBoard("stale-seed")));

    // Point that same store at the live server: it still refuses, because it
    // has never successfully read the board it would be overwriting.
    const recovered = storage();
    await assert.rejects(() => save(recovered, labelledBoard("stale-seed")), /never loaded successfully/);

    const response = await fetch(server.origin + "/api/board");
    assert.deepEqual(asRecord(await response.json()).board, sampleBoard(), "the real board is intact");
  });

  it("allows saving again once a load succeeds", async () => {
    const store = storage();
    await assert.rejects(() => save(store, labelledBoard("too-early")));

    await store.get("board-data", true);
    await save(store, labelledBoard("now-fine"));

    const response = await fetch(server.origin + "/api/board");
    assert.deepEqual(asRecord(await response.json()).board, labelledBoard("now-fine"));
  });
});
