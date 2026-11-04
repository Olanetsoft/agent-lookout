import { describe, expect, test } from "vitest";

import {
  MAX_SESSIONS,
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  SESSIONS_QUERY,
} from "@collector/adapters/crush/sessionRows";
import {
  HOUR,
  MINUTE,
  NOW,
  printedRow,
  probeJson,
  SESSION_ID,
  seconds,
  sqliteJson,
} from "@tests/fixtures/crush/crush";

/** The time a row printed in whole seconds comes back as. */
const toSecond = (at: number) => seconds(at) * 1000;

describe("what is asked", () => {
  test("names its columns, never every column, and no column that can hold what was said", () => {
    for (const query of [SESSIONS_QUERY, PROBE_QUERY]) {
      expect(query).not.toContain("*");
      for (const column of [
        "title",
        "todos",
        "channel",
        "summary_message_id",
        "prompt_tokens",
        "completion_tokens",
        "cost",
        "parts",
      ]) {
        expect(query, column).not.toContain(column);
      }
    }
  });

  test("names one table, so nothing of a message or a file is ever read", () => {
    expect(SESSIONS_QUERY).toContain("FROM sessions");
    for (const query of [SESSIONS_QUERY, PROBE_QUERY]) {
      for (const table of ["messages", "files", "read_files", "mcp_"]) {
        expect(query, table).not.toContain(table);
      }
    }
  });

  test("prints an id cut inside SQLite and two times, and nothing else", () => {
    expect(SESSIONS_QUERY).toContain(
      "SELECT substr(id, 1, 129) AS id, created_at, updated_at FROM",
    );
  });

  test("leaves out a subagent's run, as Crush's own lists do, and a session with no message", () => {
    expect(SESSIONS_QUERY).toContain("parent_session_id IS NULL");
    expect(SESSIONS_QUERY).toContain("message_count > 0");
  });

  test("works out its cut-off inside SQLite, and stops at the newest 200", () => {
    expect(SESSIONS_QUERY).toContain("strftime('%s', 'now')");
    expect(SESSIONS_QUERY).toContain(`ORDER BY updated_at DESC LIMIT ${MAX_SESSIONS}`);
  });
});

describe("readSchema", () => {
  test("takes Crush's layout for what it is", () => {
    expect(readSchema(probeJson())).toBe("supported");
  });

  test.each(["id", "parent_session_id", "message_count", "created_at", "updated_at"])(
    "does not take a table with no %s",
    (column) => {
      expect(readSchema(probeJson([column]))).toBe("unsupported");
    },
  );

  test("does not take a database with no sessions", () => {
    expect(readSchema("")).toBe("unsupported");
  });

  test("gives no answer for something that is no answer", () => {
    expect(readSchema("not json")).toBeNull();
  });
});

describe("readSessionRows", () => {
  test("keeps the id and the two times, in milliseconds", () => {
    expect(readSessionRows(sqliteJson([printedRow()]))).toEqual([
      { id: SESSION_ID, createdAt: toSecond(NOW - HOUR), updatedAt: toSecond(NOW - MINUTE) },
    ]);
  });

  test("keeps nothing else of what a row holds", () => {
    const rows = readSessionRows(sqliteJson([printedRow({ title: "words", cost: 1 })]));
    expect(Object.keys(rows?.[0] ?? {}).sort()).toEqual(["createdAt", "id", "updatedAt"]);
  });

  test("takes no rows for what sqlite3 prints when there are none", () => {
    expect(readSessionRows("")).toEqual([]);
  });

  test.each([
    ["not an object", "[1]"],
    ["no id", sqliteJson([{ created_at: 1, updated_at: 1 }])],
    ["a number for an id", sqliteJson([printedRow({ id: 7 })])],
    ["a subagent's id", sqliteJson([printedRow({ id: "message$$call" })])],
    ["an id too long", sqliteJson([printedRow({ id: "a".repeat(129) })])],
    ["a path for an id", sqliteJson([printedRow({ id: "../other" })])],
  ])("drops a row with %s", (_name, stdout) => {
    expect(readSessionRows(stdout)).toEqual([]);
  });

  test.each([
    ["text", "1790000000"],
    ["a fraction", 1790000000.5],
    ["nothing", null],
    ["a number too big to be a time", Number.MAX_SAFE_INTEGER],
  ])("takes %s for a time as none", (_name, value) => {
    const rows = readSessionRows(
      sqliteJson([printedRow({ created_at: value, updated_at: value })]),
    );
    expect(rows).toEqual([{ id: SESSION_ID, createdAt: null, updatedAt: null }]);
  });

  test("gives no answer for something that is no answer", () => {
    expect(readSessionRows("not json")).toBeNull();
    expect(readSessionRows('{"id":"a"}')).toBeNull();
  });
});
