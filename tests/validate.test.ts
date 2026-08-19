/**
 * plan.md section 10, Step 2 — Board validation.
 *
 * Two rules govern these tests:
 *   - malformed data must be rejected before any database access;
 *   - validation must NOT be so strict that legitimate fields the real frontend
 *     sends get refused, so unknown keys pass through and questionable-but-
 *     usable values become warnings instead of errors.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KNOWN_STATUSES, MAX_BOARD_BYTES, validateBoard } from "../src/board/validate.ts";
import { sampleBoard } from "./helpers.ts";

function expectValid(input: unknown) {
  const result = validateBoard(input);
  assert.equal(result.ok, true, `expected valid, got: ${JSON.stringify(result)}`);
  assert.ok(result.ok);
  return result;
}

function expectInvalid(input: unknown) {
  const result = validateBoard(input);
  assert.equal(result.ok, false, `expected invalid, got: ${JSON.stringify(result)}`);
  assert.ok(!result.ok);
  assert.ok(result.errors.length > 0, "a rejection must explain itself");
  return result;
}

describe("valid boards", () => {
  it("accepts the shape from plan.md section 4", () => {
    const result = expectValid(sampleBoard());
    assert.deepEqual(result.board, sampleBoard());
    assert.deepEqual(result.warnings, []);
  });

  it("accepts an empty board (the initial state)", () => {
    const result = expectValid({ areas: [] });
    assert.deepEqual(result.board, { areas: [] });
    assert.match(result.warnings.join(" "), /areas is empty/);
  });

  it("accepts an area with no projects yet, as the Add area button creates it", () => {
    expectValid({ areas: [{ name: "New area", projects: [] }] });
  });

  it("accepts the real seed board that ships inside status-board.html", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const seedPath = fileURLToPath(new URL("../seed/initial-board.json", import.meta.url));
    const seed = JSON.parse(await readFile(seedPath, "utf8"));

    const result = expectValid(seed);
    assert.deepEqual(result.warnings, [], "the board the team actually uses must validate cleanly");
    assert.deepEqual(result.board, seed, "and must survive validation byte for byte");
  });

  it("accepts a freshly added project, exactly as the UI creates it", () => {
    // addProject() in status-board.html pushes precisely this shape.
    expectValid({
      areas: [
        {
          name: "A",
          projects: [
            { id: "p-1755500000000", name: "New", owner: "", status: "gray", note: "", updated: "", flag: false },
          ],
        },
      ],
    });
  });

  it("preserves unknown fields instead of stripping them", () => {
    const input = {
      areas: [
        {
          name: "A",
          collapsed: true,
          projects: [{ id: "p1", name: "P", status: "green", priority: 3, tags: ["x"], meta: { nested: true } }],
        },
      ],
      lastEditedBy: "kris",
      schemaVersion: 2,
    };
    const result = expectValid(input);
    assert.deepEqual(result.board, input, "extra frontend fields must survive validation untouched");
  });

  it("accepts every known status", () => {
    for (const status of KNOWN_STATUSES) {
      const result = expectValid({ areas: [{ name: "A", projects: [{ id: "p", name: "P", status }] }] });
      assert.deepEqual(result.warnings, [], `${status} should not warn`);
    }
  });
});

describe("invalid boards", () => {
  it("rejects a missing areas key", () => {
    const result = expectInvalid({});
    assert.match(result.errors[0]!.message, /required/i);
    assert.equal(result.errors[0]!.path, "board.areas");
  });

  it("rejects areas that is not an array", () => {
    for (const areas of ["nope", 42, {}, true]) {
      expectInvalid({ areas });
    }
  });

  it("rejects a completely invalid payload", () => {
    for (const input of [null, undefined, "a string", 42, true, [], [{ areas: [] }]]) {
      expectInvalid(input);
    }
  });

  it("rejects an area whose projects key is missing", () => {
    const result = expectInvalid({ areas: [{ name: "A" }] });
    assert.equal(result.errors[0]!.path, "board.areas[0].projects");
  });

  it("rejects projects that is not an array", () => {
    expectInvalid({ areas: [{ name: "A", projects: { id: "p" } }] });
  });

  it("rejects a project with no id", () => {
    const result = expectInvalid({ areas: [{ name: "A", projects: [{ name: "No id" }] }] });
    assert.equal(result.errors[0]!.path, "board.areas[0].projects[0].id");
  });

  it("rejects a project with an empty or non-string id", () => {
    for (const id of ["", "   ", 42, null, {}]) {
      expectInvalid({ areas: [{ name: "A", projects: [{ id, name: "P", status: "green" }] }] });
    }
  });

  it("rejects a project with no status, because renderRow would throw on it", () => {
    const result = expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", name: "P" }] }] });
    assert.equal(result.errors[0]!.path, "board.areas[0].projects[0].status");
  });

  it("rejects a status outside the four the frontend can render", () => {
    // STATUS[p.status].cls throws for anything else, blanking the whole board.
    for (const status of ["purple", "chartreuse", "GREEN", "grey", "", "blocked", 1, null, true]) {
      const result = expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", name: "P", status }] }] });
      assert.equal(
        result.errors[0]!.path,
        "board.areas[0].projects[0].status",
        "for status " + JSON.stringify(status),
      );
    }
  });

  it("rejects a project whose status key is misspelled", () => {
    expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", name: "P", Status: "green" }] }] });
  });

  it("rejects a project that is not an object", () => {
    expectInvalid({ areas: [{ name: "A", projects: ["just-a-string"] }] });
  });

  it("rejects wrong types on known fields", () => {
    expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", status: "green", name: 42 }] }] });
    expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", status: "green", flag: "true" }] }] });
    expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", status: "green", note: { text: "x" } }] }] });
    expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", status: "green", owner: 7 }] }] });
    expectInvalid({ areas: [{ name: "A", projects: [{ id: "p", status: "green", updated: 20260819 }] }] });
    expectInvalid({ areas: [{ name: 42, projects: [] }] });
  });

  it("reports every problem at once, not just the first", () => {
    const result = expectInvalid({
      areas: [
        { name: "A", projects: [{ name: "missing id", status: "green" }] },
        { name: "B" },
      ],
    });
    assert.ok(result.errors.length >= 2, `expected several errors, got ${JSON.stringify(result.errors)}`);
  });

  it("rejects a payload that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = { areas: [] };
    cyclic.self = cyclic;
    expectInvalid(cyclic);
  });

  it("rejects an oversized payload", () => {
    const huge = {
      areas: [
        {
          name: "A",
          projects: [{ id: "p", name: "P", status: "green", note: "x".repeat(MAX_BOARD_BYTES + 1) }],
        },
      ],
    };
    const result = expectInvalid(huge);
    assert.match(result.errors[0]!.message, /too large/);
  });
});

describe("warnings — accepted, but worth flagging", () => {
  it("warns about duplicate project ids", () => {
    const result = expectValid({
      areas: [
        { name: "A", projects: [{ id: "dupe", name: "One", status: "green" }] },
        { name: "B", projects: [{ id: "dupe", name: "Two", status: "amber" }] },
      ],
    });
    assert.match(result.warnings.join(" "), /duplicate project id "dupe"/);
  });

  it("warns once per duplicated id, not once per occurrence", () => {
    const result = expectValid({
      areas: [
        {
          name: "A",
          projects: [
            { id: "d", name: "1", status: "green" },
            { id: "d", name: "2", status: "green" },
            { id: "d", name: "3", status: "green" },
          ],
        },
      ],
    });
    const duplicateWarnings = result.warnings.filter((w) => w.includes("duplicate project id"));
    assert.equal(duplicateWarnings.length, 1);
  });

  it("warns about a missing project name", () => {
    const result = expectValid({ areas: [{ name: "A", projects: [{ id: "p", status: "gray" }] }] });
    assert.match(result.warnings.join(" "), /has no name/);
  });

  it("warns about a malformed updated date", () => {
    const result = expectValid({
      areas: [{ name: "A", projects: [{ id: "p", name: "P", status: "green", updated: "last tuesday" }] }],
    });
    assert.match(result.warnings.join(" "), /is not a YYYY-MM-DD date/);
  });

  it("accepts the empty updated string the UI writes for a new row", () => {
    const result = expectValid({
      areas: [{ name: "A", projects: [{ id: "p", name: "P", status: "gray", updated: "" }] }],
    });
    assert.equal(result.warnings.filter((w) => w.includes("date")).length, 0);
  });

  it("accepts the empty owner string the UI writes for a new row", () => {
    const result = expectValid({
      areas: [{ name: "A", projects: [{ id: "p", name: "P", status: "gray", owner: "" }] }],
    });
    assert.deepEqual(result.warnings, []);
  });
});
