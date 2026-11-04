import { describe, expect, test } from "vitest";

import {
  MAX_SESSIONS,
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  SESSIONS_QUERY,
} from "@collector/adapters/goose/sessionRows";
import {
  HOUR,
  MINUTE,
  NOW,
  printedRow,
  probeJson,
  PROJECT,
  sqliteJson,
} from "@tests/fixtures/goose/goose";

/** One row of what the probe prints. */
type Row = Record<string, unknown>;

/** The time a row printed in whole seconds comes back as. */
const toSecond = (at: number) => Math.floor(at / 1000) * 1000;

describe("what is asked", () => {
  test("names its columns, never every column, and no column that can hold what was said", () => {
    for (const query of [SESSIONS_QUERY, PROBE_QUERY]) {
      expect(query).not.toContain("*");
      for (const column of [
        "content_json",
        "metadata_json",
        "description",
        "extension_data",
        "recipe_json",
        "user_recipe_values_json",
        "system_prompt",
        "model_config_json",
        "provider_name",
        "total_tokens",
        "input_tokens",
      ]) {
        expect(query, column).not.toContain(column);
      }
    }
  });

  test("gives Goose's own name only where the person set it", () => {
    expect(SESSIONS_QUERY).toContain("CASE WHEN s.user_set_name = 1 THEN substr(s.name, 1, 1000)");
    expect(SESSIONS_QUERY.match(/s\.name/g)).toHaveLength(1);
  });

  test("is bounded by time and by a count, and leaves out what Goose keeps from its own lists", () => {
    expect(SESSIONS_QUERY).toContain("datetime('now', '-48 hours')");
    expect(SESSIONS_QUERY).toContain(`LIMIT ${MAX_SESSIONS}`);
    expect(SESSIONS_QUERY).toContain("s.session_type IN ('user', 'scheduled', 'acp')");
    expect(SESSIONS_QUERY).toContain("s.archived_at IS NULL");
    expect(SESSIONS_QUERY).toContain("EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)");
  });
});

describe("the sessions read", () => {
  test("keep their id, folder, name and two times", () => {
    const rows = readSessionRows(sqliteJson([printedRow({ own_name: "Release notes" })]));
    expect(rows).toEqual([
      {
        id: "20261001_1",
        folder: PROJECT,
        ownName: "Release notes",
        createdAt: toSecond(NOW - HOUR),
        updatedAt: toSecond(NOW - MINUTE),
      },
    ]);
  });

  test("no rows are no sessions", () => {
    expect(readSessionRows("")).toEqual([]);
  });

  test("what is not an answer is no answer", () => {
    expect(readSessionRows("not json")).toBeNull();
    expect(readSessionRows('{"id":"20261001_1"}')).toBeNull();
  });

  test.each([
    ["no id", { id: undefined }],
    ["a number for an id", { id: 20261001 }],
    ["an empty id", { id: "" }],
    ["an id that could leave a folder", { id: "../20261001_1" }],
    ["an id with a space", { id: "20261001 1" }],
    ["an id over 128 characters", { id: "a".repeat(129) }],
  ])("a row with %s is dropped, and the others stay", (_case, changes) => {
    const rows = readSessionRows(
      sqliteJson([printedRow(changes), printedRow({ id: "20261001_2" })]),
    );
    expect(rows?.map(({ id }) => id)).toEqual(["20261001_2"]);
  });

  test("takes an id a client gave, of up to 128 letters, digits, dashes and underscores", () => {
    const id = `${"A-b_9".repeat(25)}abc`;
    expect(readSessionRows(sqliteJson([printedRow({ id })]))?.[0]?.id).toBe(id);
  });

  test.each([
    ["a number", 7],
    ["a relative path", "code/demo-project"],
    ["none", null],
    ["a path with a line break", "/Users/example/code/demo\nproject"],
    ["a path with a mark that turns text around", "/Users/example/code/demo‮project"],
    ["a path over 4096 characters", `/${"a".repeat(4096)}`],
  ])("a folder that is %s is no folder", (_case, working_dir) => {
    expect(readSessionRows(sqliteJson([printedRow({ working_dir })]))?.[0]?.folder).toBeNull();
  });

  test("a folder of exactly 4096 characters is kept", () => {
    const folder = `/${"a".repeat(4095)}`;
    const rows = readSessionRows(sqliteJson([printedRow({ working_dir: folder })]));
    expect(rows?.[0]?.folder).toBe(folder);
  });

  test.each([
    ["text", "2026-10-01 12:00:00"],
    ["a fraction", 1790000000.5],
    ["none", null],
    ["too large to be a time", Number.MAX_SAFE_INTEGER],
  ])("a time that is %s is no time", (_case, value) => {
    const [row] = readSessionRows(
      sqliteJson([printedRow({ created_s: value, updated_s: value })]),
    )!;
    expect(row).toMatchObject({ createdAt: null, updatedAt: null });
  });

  test("a name that is not text is no name", () => {
    expect(readSessionRows(sqliteJson([printedRow({ own_name: 7 })]))?.[0]?.ownName).toBeNull();
  });

  test("nothing but the kept fields is kept, whatever else is printed", () => {
    const [row] = readSessionRows(
      sqliteJson([printedRow({ prompt: "words", name: "words", provider_name: "words" })]),
    )!;
    expect(Object.keys(row!).sort()).toEqual(["createdAt", "folder", "id", "ownName", "updatedAt"]);
  });
});

describe("what the probe found", () => {
  test("Goose's layout", () => {
    expect(readSchema(probeJson())).toBe("supported");
  });

  test.each([
    "id",
    "name",
    "created_at",
    "archived_at",
    "user_set_name",
    "session_type",
    "working_dir",
    "updated_at",
  ])("a database with no %s is one this does not read", (column) => {
    expect(readSchema(probeJson([column]))).toBe("unsupported");
  });

  test.each([
    [
      "a view named messages in place of its table",
      ({ kind, name }: Row) => !(kind === "table" && name === "messages"),
    ],
    ["no session_id in messages", ({ kind }: Row) => kind !== "messages"],
  ])("a database with %s is one this does not read", (_case, keep) => {
    const rows = (JSON.parse(probeJson()) as Row[]).filter(keep);
    expect(readSchema(sqliteJson(rows))).toBe("unsupported");
  });

  test("a database with neither table is one this does not read", () => {
    expect(readSchema("")).toBe("unsupported");
  });

  test("what is not an answer says nothing", () => {
    expect(readSchema("not json")).toBeNull();
  });
});
