import { describe, expect, test } from "vitest";

import {
  MAX_SESSIONS,
  PROBE_QUERY,
  QUERY_WINDOW_MS,
  readSchema,
  readSessionRows,
  SESSION_ID,
  SESSIONS_QUERY,
  sqliteArguments,
  sqliteUri,
} from "@collector/adapters/opencode/sessionRows";
import {
  answerRow,
  FOLDER,
  messageId,
  MINUTE,
  NOW,
  probeJson,
  sessionId,
  sqliteJson,
} from "@tests/fixtures/opencode/opencode";

const A = sessionId("a1");

describe("the two questions", () => {
  test("ask for no whole row, no whole data value, no text and no table but the session's own", () => {
    for (const query of [PROBE_QUERY, SESSIONS_QUERY]) {
      // No `SELECT *` and no `s.*`: only `count(*)` and a multiplication.
      expect(query.replaceAll("count(*)", "").replaceAll("* 1000", "")).not.toContain("*");
      for (const never of [
        "event",
        "credential",
        "account",
        "session_share",
        "permission",
        "todo",
        "$.text",
        "$.state.input",
        "$.state.output",
        "$.state.error",
        "$.system",
        "$.summary",
        "share_url",
        "summary_",
        "tokens_",
        "cost",
        "revert",
      ]) {
        expect(query, never).not.toContain(never);
      }
      // Every newline and every argument is fixed text, with nothing to fill in.
      expect(query).not.toMatch(/[\n?]|\$\{/);
    }
    // Each `data` is only ever read through one of the paths named, and only
    // once `json_valid` says it is JSON, so one row that is not cannot fail the answer.
    const checked = SESSIONS_QUERY.replaceAll(/json_valid\([a-z]\.data\)/g, "");
    const uses = checked.match(/[a-z]\.data\b(?:, '[^']*')?/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use, use).toMatch(
        /^[a-z]\.data, '\$\.(role|time\.completed|error\.name|finish|type|tool|auto|metadata\.providerExecuted|metadata\.compaction_continue|state\.status|state\.metadata\.interrupted)'$/,
      );
    }
    for (const alias of ["m", "p", "u", "q"]) {
      expect(SESSIONS_QUERY, alias).toContain(`CASE WHEN json_valid(${alias}.data) THEN`);
    }
    // A title and a folder are cut inside SQLite, so long ones cannot fill the answer.
    expect(SESSIONS_QUERY).toContain("substr(s.directory, 1, 4097) AS directory");
    expect(SESSIONS_QUERY).toContain("substr(s.title, 1, 1000) AS title");
    expect(SESSIONS_QUERY).toContain("s.parent_id IS NULL AND s.time_archived IS NULL");
    expect(SESSIONS_QUERY).toContain(`* 1000 - ${QUERY_WINDOW_MS}`);
    expect(SESSIONS_QUERY).toContain(`LIMIT ${MAX_SESSIONS}`);
    expect(QUERY_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
  });

  test("the probe asks only for the names of tables and columns", () => {
    expect(PROBE_QUERY).toBe(
      "SELECT 'table' AS kind, name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_v2', 'session_message') UNION ALL SELECT 'session', name FROM pragma_table_info('session') UNION ALL SELECT 'session_v2', name FROM pragma_table_info('session_v2')",
    );
  });
});

describe("sqliteUri", () => {
  test("opens a database with nothing in its -wal as a file nothing changes, and one with something there with its -shm read-only", () => {
    expect(sqliteUri("/Users/example/.local/share/opencode/opencode.db", "whole")).toBe(
      "file:/Users/example/.local/share/opencode/opencode.db?mode=ro&immutable=1",
    );
    expect(sqliteUri("/Users/example/.local/share/opencode/opencode.db", "with-wal")).toBe(
      "file:/Users/example/.local/share/opencode/opencode.db?mode=ro&readonly_shm=1",
    );
  });

  test("never lets a folder's name add to the address", () => {
    expect(sqliteUri("/Users/example/a b?c#d%e&mode=rw/opencode.db", "with-wal")).toBe(
      "file:/Users/example/a%20b%3Fc%23d%25e%26mode%3Drw/opencode.db?mode=ro&readonly_shm=1",
    );
  });

  test("the arguments are sqlite3's settings off, JSON out, the address and the fixed question", () => {
    expect(sqliteArguments("/data/opencode.db", "whole", PROBE_QUERY)).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      "file:/data/opencode.db?mode=ro&immutable=1",
      PROBE_QUERY,
    ]);
  });
});

describe("readSchema", () => {
  test("OpenCode 1.x's tables, with every column asked for", () => {
    expect(readSchema(probeJson("v1"))).toEqual({ layout: "v1", opencode2: false });
    expect(readSchema(probeJson("v1+v2"))).toEqual({ layout: "v1", opencode2: true });
  });

  test("OpenCode 2's table alone", () => {
    expect(readSchema(probeJson("v2-only"))).toEqual({ layout: "v2-only", opencode2: true });
  });

  test("anything else is a layout Agent Lookout does not read", () => {
    expect(readSchema(probeJson("none"))).toEqual({ layout: "unsupported", opencode2: false });
    const withoutArchive = sqliteJson(
      ["session", "message", "part"]
        .map((name) => ({ kind: "table", name }))
        .concat(
          ["id", "parent_id", "directory", "title", "time_created", "time_updated"].map((name) => ({
            kind: "session",
            name,
          })),
        ),
    );
    expect(readSchema(withoutArchive)).toEqual({ layout: "unsupported", opencode2: false });
    const withoutParts = sqliteJson([
      { kind: "table", name: "session" },
      { kind: "table", name: "message" },
    ]);
    expect(readSchema(withoutParts)?.layout).toBe("unsupported");
  });

  test("an answer that is not the probe's is none", () => {
    expect(readSchema("not json")).toBeNull();
    expect(readSchema('{"kind":"table"}')).toBeNull();
  });
});

describe("readSessionRows", () => {
  test("keeps each field of a row, and drops the rest", () => {
    const rows = readSessionRows(
      sqliteJson([{ ...answerRow({ id: A }), share_url: "https://example.com", cost: 3 }]),
    );
    expect(rows).toEqual([
      {
        id: A,
        folder: FOLDER,
        title: "Rename the helper",
        createdAt: NOW - 60 * MINUTE,
        updatedAt: NOW - MINUTE,
        message: {
          createdAt: NOW - 2 * MINUTE,
          updatedAt: NOW - MINUTE,
          role: "assistant",
          completedAt: NOW - MINUTE,
          error: null,
          finish: "stop",
          tools: 0,
          shell: 0,
          partsUpdatedAt: NOW - MINUTE,
        },
        userCreatedAt: NOW - 3 * MINUTE,
      },
    ]);
  });

  test("an empty answer is no sessions, and one that is not JSON rows is none at all", () => {
    expect(readSessionRows("")).toEqual([]);
    expect(readSessionRows("\n")).toEqual([]);
    expect(readSessionRows("[{")).toBeNull();
    expect(readSessionRows('{"id":"ses_1"}')).toBeNull();
    expect(readSessionRows('[1, null, "x"]')).toEqual([]);
  });

  test("a session with no message has none", () => {
    const [row] = readSessionRows(sqliteJson([answerRow({ id: A, m_id: null })])) ?? [];
    expect(row?.message).toBeNull();
  });

  test("a row whose id is not one OpenCode makes is dropped, and a repeated one is kept once", () => {
    const rows = readSessionRows(
      sqliteJson([
        answerRow({ id: "msg_000000000000000000000000a1" }),
        answerRow({ id: "ses_../../etc" }),
        answerRow({ id: `ses_${"a".repeat(65)}` }),
        answerRow({ id: 7 as unknown as string }),
        answerRow({ id: A }),
        answerRow({ id: A, title: "Another" }),
      ]),
    );
    expect(rows?.map((row) => [row.id, row.title])).toEqual([[A, "Rename the helper"]]);
    expect(SESSION_ID.test(sessionId("b2"))).toBe(true);
  });

  test("a folder is kept only when it is an absolute path with nothing unprintable in it", () => {
    const folderOf = (directory: unknown) =>
      readSessionRows(sqliteJson([answerRow({ id: A, directory })]))?.[0]?.folder;
    expect(folderOf("/Users/example/code/demo")).toBe("/Users/example/code/demo");
    expect(folderOf("")).toBeNull();
    expect(folderOf("code/demo")).toBeNull();
    expect(folderOf("C:/Users/example/code/demo")).toBeNull();
    expect(folderOf("/Users/example/code/demo\nnext")).toBeNull();
    expect(folderOf("/Users/example/code/\u202edemo")).toBeNull();
    expect(folderOf(`/${"a".repeat(4096)}`)).toBeNull();
    expect(folderOf(3)).toBeNull();
  });

  test("OpenCode's placeholder title is no title, and a long one is cut", () => {
    const titleOf = (title: unknown) =>
      readSessionRows(sqliteJson([answerRow({ id: A, title })]))?.[0]?.title;
    expect(titleOf("New session - 2026-10-01T11:00:00.000Z")).toBeNull();
    expect(titleOf("Child session - 2026-10-01T11:00:00.000Z")).toBeNull();
    expect(titleOf("New session - today")).toBe("New session - today");
    expect(titleOf(null)).toBeNull();
    expect(titleOf(5)).toBeNull();
    expect(titleOf("x".repeat(5000))).toHaveLength(1000);
  });

  test("a time that is not a whole number is not known", () => {
    const [row] =
      readSessionRows(
        sqliteJson([
          answerRow({
            id: A,
            time_created: "yesterday",
            time_updated: 1.5,
            m_created: null,
            p_updated: "x",
            u_created: true,
          }),
        ]),
      ) ?? [];
    expect(row?.createdAt).toBeNull();
    expect(row?.updatedAt).toBeNull();
    expect(row?.message?.createdAt).toBeNull();
    expect(row?.message?.partsUpdatedAt).toBeNull();
    expect(row?.userCreatedAt).toBeNull();
  });

  test("a short field keeps a word or a number, and anything long or unprintable is of the wrong type", () => {
    const fieldsOf = (fields: Record<string, unknown>) =>
      readSessionRows(sqliteJson([answerRow({ id: A, ...fields })]))?.[0]?.message;
    expect(fieldsOf({ m_role: "user", m_error: "APIError", m_finish: "length" })).toMatchObject({
      role: "user",
      error: "APIError",
      finish: "length",
    });
    expect(fieldsOf({ m_completed: "soon", m_tools: 2, m_shell: 1 })).toMatchObject({
      completedAt: "soon",
      tools: 2,
      shell: 1,
    });
    const wrong = fieldsOf({
      m_role: "x".repeat(65),
      m_error: "API\u0000Error",
      m_finish: '{"why":"text"}'.repeat(10),
      m_tools: true,
      m_shell: false,
    });
    expect(wrong).toMatchObject({
      role: undefined,
      error: undefined,
      finish: undefined,
      tools: undefined,
      shell: undefined,
    });
    expect(fieldsOf({ m_id: messageId("b1") })?.role).toBe("assistant");
  });
});
