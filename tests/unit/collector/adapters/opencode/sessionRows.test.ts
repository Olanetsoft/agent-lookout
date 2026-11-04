import { describe, expect, test } from "vitest";

import {
  MAX_SESSIONS,
  MESSAGES_FOR_TOKENS,
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
        /^[a-z]\.data, '\$\.(role|time\.completed|error\.name|finish|type|tool|auto|metadata\.providerExecuted|metadata\.compaction_continue|state\.status|state\.time\.start|state\.metadata\.interrupted|tokens\.(input|output|reasoning|cache\.read|cache\.write|total))'$/,
      );
    }
    for (const alias of ["m", "p", "u", "q", "y", "r"]) {
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

  test("tell a call that waits for the person by the tool's name and state alone, compared exactly, on the newest message's own parts", () => {
    // Its start is printed only as a whole number, so nothing longer can come of it.
    expect(SESSIONS_QUERY).toContain(
      "(SELECT CASE WHEN max(json_extract(p.data, '$.state.status') IS 'running') THEN min(CASE WHEN json_type(p.data, '$.state.time.start') IS 'integer' THEN json_extract(p.data, '$.state.time.start') ELSE p.time_created END) END FROM part p WHERE p.message_id = m.id AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') IS 'tool' AND json_extract(p.data, '$.tool') IN ('question', 'plan_exit') AND json_extract(p.data, '$.state.status') IN ('running', 'completed', 'error') ELSE 0 END) AS m_asked_at,",
    );
    expect(SESSIONS_QUERY.match(/'\$\.state\.time\.start'/g)).toHaveLength(2);
    expect(SESSIONS_QUERY).not.toMatch(/\b(LIKE|GLOB|REGEXP|MATCH)\b/);
  });

  test("read the six token counts of the newest reply that ended with some among the session's own newest 10 messages, each only as a whole number", () => {
    // Each count is a fixed path of the counted reply's data, printed only
    // once json_valid says it is JSON and json_type that the count is a whole
    // number, so nothing longer than a number can come of them.
    for (const [field, name] of [
      ["input", "r_input"],
      ["output", "r_output"],
      ["reasoning", "r_reasoning"],
      ["cache.read", "r_cache_read"],
      ["cache.write", "r_cache_write"],
      ["total", "r_total"],
    ]) {
      expect(SESSIONS_QUERY, name).toContain(
        `CASE WHEN json_valid(r.data) THEN CASE WHEN json_type(r.data, '$.tokens.${field}') IS 'integer' THEN json_extract(r.data, '$.tokens.${field}') END END AS ${name}`,
      );
    }
    expect(SESSIONS_QUERY.match(/json_extract\(r\.data/g)).toHaveLength(6);
    // The reply counted is a step of the session's own that ended with a
    // prompt counted above 0, newest first, and no further back than its 10th
    // newest message.
    expect(MESSAGES_FOR_TOKENS).toBe(10);
    expect(SESSIONS_QUERY).toContain(
      "LEFT JOIN message r ON r.id = (SELECT y.id FROM message y WHERE y.session_id = s.id AND (y.time_created, y.id) >= (coalesce((SELECT z.time_created FROM message z WHERE z.session_id = s.id ORDER BY z.time_created DESC, z.id DESC LIMIT 1 OFFSET 9), 0), coalesce((SELECT z.id FROM message z WHERE z.session_id = s.id ORDER BY z.time_created DESC, z.id DESC LIMIT 1 OFFSET 9), '')) AND CASE WHEN json_valid(y.data) THEN json_extract(y.data, '$.role') IS 'assistant' AND json_type(y.data, '$.time.completed') IS 'integer' AND (json_extract(y.data, '$.tokens.input') > 0 OR json_extract(y.data, '$.tokens.cache.read') > 0 OR json_extract(y.data, '$.tokens.cache.write') > 0) ELSE 0 END ORDER BY y.time_created DESC, y.id DESC LIMIT 1)",
    );
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
          askedAt: null,
          partsUpdatedAt: NOW - MINUTE,
        },
        userCreatedAt: NOW - 3 * MINUTE,
        tokens: null,
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

  test("when a call that waits began is kept as a short field, for the mapping to judge", () => {
    const fieldsOf = (fields: Record<string, unknown>) =>
      readSessionRows(sqliteJson([answerRow({ id: A, ...fields })]))?.[0]?.message;
    expect(fieldsOf({})?.askedAt).toBeNull();
    expect(fieldsOf({ m_asked_at: NOW - MINUTE })?.askedAt).toBe(NOW - MINUTE);
    expect(fieldsOf({ m_asked_at: "x".repeat(65) })?.askedAt).toBeUndefined();
  });
});

describe("the token counts of the newest reply that ended with some", () => {
  /** The counts kept of a row whose counted reply has these `$.tokens`, as sqlite3 prints them. */
  function tokensOf(counts: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    read?: unknown;
    write?: unknown;
    total?: unknown;
  }) {
    const [row] =
      readSessionRows(
        sqliteJson([
          answerRow({
            id: A,
            r_input: counts.input ?? null,
            r_output: counts.output ?? null,
            r_reasoning: counts.reasoning ?? null,
            r_cache_read: counts.read ?? null,
            r_cache_write: counts.write ?? null,
            r_total: counts.total ?? null,
          }),
        ]),
      ) ?? [];
    return row?.tokens;
  }

  test("a reply with counts: In is the prompt, Out what it wrote, and no cached part when none came from a cache", () => {
    expect(
      tokensOf({ input: 1200, output: 300, reasoning: 0, read: 0, write: 0, total: 1500 }),
    ).toEqual({ input: 1200, output: 300 });
  });

  test("In holds what was read from a cache and what was written to one, and Cached only what was read", () => {
    expect(
      tokensOf({ input: 200, output: 100, reasoning: 0, read: 1800, write: 400, total: 2500 }),
    ).toEqual({ input: 2400, cached: 1800, output: 100 });
  });

  test("the reasoning, which OpenCode keeps apart from the output, is counted once in Out", () => {
    expect(
      tokensOf({ input: 1000, output: 300, reasoning: 200, read: 0, write: 0, total: 1500 }),
    ).toEqual({ input: 1000, output: 500 });
  });

  test("a total is not needed, as OpenCode writes none when its provider sent no total", () => {
    expect(tokensOf({ input: 1000, output: 300, reasoning: 0, read: 500, write: 0 })).toEqual({
      input: 1500,
      cached: 500,
      output: 300,
    });
  });

  test("a row with no counts printed has none, and nor has one whose counts are all 0", () => {
    expect(tokensOf({})).toBeNull();
    expect(tokensOf({ input: 0, output: 0, reasoning: 0, read: 0, write: 0 })).toBeNull();
  });

  test("counts that could not be right are none, never a guess", () => {
    const right = { input: 1000, output: 300, reasoning: 0, read: 0, write: 0, total: 1300 };
    expect(tokensOf(right)).toEqual({ input: 1000, output: 300 });
    // One of the five missing, below 0, a fraction, not a number or too large to be exact.
    for (const field of ["input", "output", "reasoning", "read", "write"] as const) {
      for (const wrong of [null, -1, 1.5, "1000", Number.MAX_SAFE_INTEGER + 2]) {
        expect(tokensOf({ ...right, [field]: wrong }), `${field} ${String(wrong)}`).toBeNull();
      }
    }
    // A total smaller than In and Out together: OpenCode raised a count below 0 to 0.
    expect(tokensOf({ ...right, total: 1299 })).toBeNull();
    expect(tokensOf({ ...right, input: 0, read: 1500, total: 1300 })).toBeNull();
    // A larger total, as a provider can send, leaves them as they are.
    expect(tokensOf({ ...right, total: 1400 })).toEqual({ input: 1000, output: 300 });
    // No prompt is no count: a reply is always given one.
    expect(tokensOf({ ...right, input: 0, total: 300 })).toBeNull();
    // Counts too large to be exact once added up.
    expect(
      tokensOf({ ...right, input: Number.MAX_SAFE_INTEGER, read: 1, total: undefined }),
    ).toBeNull();
  });
});
