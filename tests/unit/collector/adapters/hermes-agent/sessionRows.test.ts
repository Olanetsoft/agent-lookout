import { describe, expect, test } from "vitest";

import {
  BUSY_TIMEOUT_MS,
  DATABASE_FILE,
  MAX_CHAIN_DEPTH,
  MAX_ROWS,
  PROBE_QUERY,
  QUERY_WINDOW_SECONDS,
  readSchema,
  readSessionRows,
  SESSION_ID,
  SESSIONS_QUERY,
  sqliteArguments,
  sqliteUri,
} from "@collector/adapters/hermes-agent/sessionRows";
import {
  answerRow,
  DEFAULT_DATABASE,
  FOLDER,
  GATEWAY_PID,
  HOUR,
  liveLease,
  MINUTE,
  NOW,
  PID_NAMESPACE,
  probeJson,
  seconds,
  sessionId,
  sqliteJson,
} from "@tests/fixtures/hermes-agent/hermesAgent";

const A = sessionId("a1");
const B = sessionId("b2");

/** The one row kept from an answer of one row with these fields. */
function row(fields: Record<string, unknown> = {}) {
  const rows = readSessionRows(sqliteJson([answerRow({ id: A, ...fields })]));
  expect(rows).toHaveLength(1);
  return rows?.[0];
}

describe("the two questions", () => {
  test("are fixed text, with nothing to fill in", () => {
    expect(DATABASE_FILE).toBe("state.db");
    for (const query of [PROBE_QUERY, SESSIONS_QUERY]) {
      expect(query).not.toMatch(/[\n?]|\$\{/);
    }
    expect(SESSIONS_QUERY).toContain(`- ${QUERY_WINDOW_SECONDS}),`);
    expect(QUERY_WINDOW_SECONDS).toBe(172_800);
    expect(SESSIONS_QUERY).toContain(`WHERE up.depth < ${MAX_CHAIN_DEPTH} `);
    expect(MAX_CHAIN_DEPTH).toBe(64);
    expect(SESSIONS_QUERY.endsWith(`LIMIT ${MAX_ROWS}`)).toBe(true);
    expect(MAX_ROWS).toBe(500);
  });

  test("ask for no whole row, and name no table but the three, nor any column that holds what was written or who wrote it", () => {
    for (const query of [PROBE_QUERY, SESSIONS_QUERY]) {
      // No `SELECT *` and no `s.*`: only `count(*)`, and the pattern a holder's pid is matched by.
      expect(query.replaceAll("count(*)", "").replaceAll("GLOB 'pid=[0-9]*'", "")).not.toContain(
        "*",
      );
      for (const never of [
        "system_prompt",
        "session_admissions",
        "payload_json",
        "lineage_json",
        "gateway_routing",
        "gateway_heartbeats",
        "state_meta",
        "messages_fts",
        "worker_",
        "async_delegations",
        "session_model_usage",
        "compression_locks",
        "conversation_generations",
        "content",
        "reasoning",
        "codex_",
        "tool_name",
        "display_identity",
        "user_id",
        "chat_id",
        "chat_type",
        "thread_id",
        "display_name",
        "origin_json",
        "billing_",
        "_tokens",
        "cost",
        "handoff_",
        "compression_",
        "git_",
        "title_source",
        "last_activity_provenance",
        "profile_name",
        "message_count",
      ]) {
        expect(query, never).not.toContain(never);
      }
    }
    // The probe asks for names alone.
    expect(PROBE_QUERY).toBe(
      "SELECT 'table' AS kind, name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'messages', 'session_turn_leases') UNION ALL SELECT 'sessions', name FROM pragma_table_info('sessions') UNION ALL SELECT 'messages', name FROM pragma_table_info('messages') UNION ALL SELECT 'session_turn_leases', name FROM pragma_table_info('session_turn_leases')",
    );
  });

  test("test a JSON column only at the paths named, and only once json_valid says it is JSON", () => {
    const paths = [...SESSIONS_QUERY.matchAll(/json_(?:extract|type)\([^,]+, '([^']*)'\)/g)].map(
      (match) => match[1],
    );
    expect(new Set(paths)).toEqual(
      new Set([
        "$._branched_from",
        "$._delegate_from",
        "$._reset_from",
        "$.error",
        "$.function.name",
        "$.id",
      ]),
    );
    // Each column of JSON is read only behind its own json_valid.
    for (const column of ["c.model_config", "r.model_config", "n.display_metadata"]) {
      const uses = SESSIONS_QUERY.split(`json_valid(${column})`).length - 1;
      const reads =
        SESSIONS_QUERY.split(`json_extract(${column}`).length -
        1 +
        SESSIONS_QUERY.split(`json_type(${column}`).length -
        1;
      expect(reads, column).toBeGreaterThan(0);
      expect(uses, column).toBe(reads);
    }
    expect(SESSIONS_QUERY).toContain(
      "json_each(CASE WHEN json_valid(a.tool_calls) THEN a.tool_calls ELSE '[]' END)",
    );
  });

  test("test the activity label with two prefixes alone, and print only whether each matched", () => {
    const likes = [...SESSIONS_QUERY.matchAll(/(\S+) LIKE '([^']*)'/g)].map((match) => [
      match[1],
      match[2],
    ]);
    expect(likes).toEqual([
      ["c.last_activity_description", "waiting for user approval%"],
      ["c.last_activity_description", "waiting for user clarify response%"],
    ]);
    expect(SESSIONS_QUERY.split("last_activity_description").length - 1).toBe(2);
  });

  test("cut a title and a folder inside SQLite, a character past what is kept", () => {
    expect(SESSIONS_QUERY).toContain("substr(r.title, 1, 1000) AS root_title");
    expect(SESSIONS_QUERY).toContain("substr(c.title, 1, 1000) AS title");
    expect(SESSIONS_QUERY).toContain("substr(r.cwd, 1, 4097) AS root_cwd");
    expect(SESSIONS_QUERY).toContain("substr(c.cwd, 1, 4097) AS cwd");
  });

  test("leave out Hermes Agent's hidden sources, subagents, and hidden or archived rows", () => {
    expect(SESSIONS_QUERY).toContain("coalesce(r.source, '') NOT IN ('kanban', 'tool', 'oneshot')");
    expect(SESSIONS_QUERY).toContain("r.archived = 0 AND r.hidden = 0");
    expect(SESSIONS_QUERY).toMatch(
      /json_extract\(r\.model_config, '\$\._delegate_from'\) END\) IS NULL/,
    );
  });
});

describe("sqliteArguments", () => {
  test("in rollback-journal mode: settings off, JSON out, a second's wait for a commit, the database read-only with no -shm written", () => {
    expect(sqliteArguments(DEFAULT_DATABASE, "rollback", PROBE_QUERY)).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      "-cmd",
      ".timeout 1000",
      `file:${DEFAULT_DATABASE}?mode=ro&readonly_shm=1`,
      PROBE_QUERY,
    ]);
    expect(BUSY_TIMEOUT_MS).toBe(1000);
  });

  test("in WAL mode with no -wal: read as a file nothing changes, with no wait", () => {
    expect(sqliteArguments(DEFAULT_DATABASE, "whole", SESSIONS_QUERY)).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      `file:${DEFAULT_DATABASE}?mode=ro&immutable=1`,
      SESSIONS_QUERY,
    ]);
  });

  test("in WAL mode with a -wal that holds commits: read with it, the -shm read-only, with no wait", () => {
    expect(sqliteArguments(DEFAULT_DATABASE, "with-wal", SESSIONS_QUERY)).toEqual([
      "-init",
      "/dev/null",
      "-batch",
      "-json",
      `file:${DEFAULT_DATABASE}?mode=ro&readonly_shm=1`,
      SESSIONS_QUERY,
    ]);
  });

  test("a folder's name cannot add to or end the address", () => {
    expect(sqliteUri("/Users/example/a b?c%d#e&mode=rw/state.db", "whole")).toBe(
      "file:/Users/example/a%20b%3Fc%25d%23e%26mode%3Drw/state.db?mode=ro&immutable=1",
    );
  });
});

describe("readSchema", () => {
  /** The rows the probe prints for v0.22.5, without one. */
  const without = (table: string, name: string) => {
    const rows = JSON.parse(probeJson()) as { kind: string; name: string }[];
    return sqliteJson(rows.filter((each) => !(each.kind === table && each.name === name)));
  };

  test("supports a database laid out as v0.21.6 and later lay one out", () => {
    expect(readSchema(probeJson("v0.22.5"))).toBe("supported");
  });

  test("does not support one before v0.21.6, with no created_source, one with no lease table, or one with none of the tables", () => {
    expect(readSchema(probeJson("v0.21.5"))).toBe("unsupported");
    expect(readSchema(probeJson("no-leases"))).toBe("unsupported");
    expect(readSchema(probeJson("none"))).toBe("unsupported");
  });

  test.each<[string, string[]]>([
    [
      "sessions",
      [
        "id",
        "source",
        "created_source",
        "parent_session_id",
        "started_at",
        "ended_at",
        "end_reason",
        "cwd",
        "title",
        "model_config",
        "session_key",
        "archived",
        "hidden",
        "last_activity_at",
        "last_activity_description",
      ],
    ],
    [
      "messages",
      [
        "id",
        "session_id",
        "role",
        "timestamp",
        "active",
        "display_kind",
        "display_metadata",
        "finish_reason",
        "tool_calls",
        "tool_call_id",
      ],
    ],
    ["session_turn_leases", ["conversation_id", "holder", "acquired_at", "expires_at"]],
  ])("needs every column it asks for of %s", (table, columns) => {
    for (const column of columns) {
      expect(readSchema(without(table, column)), column).toBe("unsupported");
    }
    expect(readSchema(without("table", table))).toBe("unsupported");
  });

  test("needs nothing it does not ask for", () => {
    for (const [table, column] of [
      ["sessions", "user_id"],
      ["sessions", "system_prompt"],
      ["messages", "content"],
    ] as const) {
      expect(readSchema(without(table, column)), column).toBe("supported");
    }
  });

  test("a column of another table does not count", () => {
    const moved = probeJson().replace(
      '{"kind":"sessions","name":"created_source"}',
      '{"kind":"messages","name":"created_source"}',
    );
    expect(moved).not.toBe(probeJson());
    expect(readSchema(moved)).toBe("unsupported");
  });

  test("an answer that is not rows is no answer", () => {
    for (const printed of ["not json", "[", '{"kind":"table"}', "1"]) {
      expect(readSchema(printed), printed).toBeNull();
    }
    // A row that is not an object, or names nothing, is passed over.
    expect(readSchema(`[1, null, {"kind": 2, "name": "id"}]`)).toBe("unsupported");
  });
});

describe("readSessionRows", () => {
  test("keeps each field, with times made milliseconds", () => {
    const kept = row({
      ...liveLease({ pidns: PID_NAMESPACE }),
      approval_label: 1,
      question_label: 0,
      calls_at: seconds(NOW - 4 * MINUTE),
      open_questions: 1,
      open_calls: 2,
      ended_at: seconds(NOW) + 0.25,
      end_reason: "cli_close",
    });
    expect(kept).toEqual({
      rootId: A,
      id: A,
      root: {
        source: "local",
        createdSource: "cli",
        startedAt: NOW - HOUR,
        title: "Rename the helper",
        folder: FOLDER,
      },
      startedAt: NOW - HOUR,
      endedAt: NOW + 250,
      endReason: "cli_close",
      lastActivityAt: NOW - MINUTE,
      lastMessageAt: NOW - MINUTE,
      title: "Rename the helper",
      folder: FOLDER,
      approvalLabel: 1,
      questionLabel: 0,
      newest: { role: "assistant", at: NOW - MINUTE, kind: null, finish: "stop", error: null },
      callsAt: NOW - 4 * MINUTE,
      openQuestions: 1,
      openCalls: 2,
      lease: {
        at: NOW - 2 * MINUTE,
        until: NOW + 5 * MINUTE,
        pid: GATEWAY_PID,
        pidns: PID_NAMESPACE,
      },
    });
  });

  test("a conversation with no row of its own has no newest row, and one with no lease has none", () => {
    expect(row({ n_role: null, n_at: null, n_finish: null })).toMatchObject({
      newest: null,
      lease: null,
    });
  });

  test("a lease is there when either of its times is, with a holder that names no process kept as none", () => {
    expect(row({ lease_at: seconds(NOW), lease_pid: null })?.lease).toEqual({
      at: NOW,
      until: null,
      pid: null,
      pidns: null,
    });
    expect(row({ lease_until: seconds(NOW) })?.lease).toMatchObject({ at: null, until: NOW });
    expect(row({ ...liveLease({ pid: 1.5 }), lease_pidns: "4026531836" })?.lease).toMatchObject({
      pid: null,
      pidns: null,
    });
  });

  test("drops a row whose ids are not ones Hermes Agent makes, or that it already has, and keeps the rest", () => {
    const answer = sqliteJson([
      answerRow({ id: A }),
      answerRow({ id: "../state.db" }),
      answerRow({ id: B, root_id: "a b" }),
      answerRow({ id: B, root_id: "" }),
      answerRow({ id: B, root_id: 7 }),
      answerRow({ id: 7 as unknown as string }),
      answerRow({ id: `_${A}` }),
      answerRow({ id: "a".repeat(129) }),
      answerRow({ id: A, title: "Twice" }),
      answerRow({ id: B, root_id: A }),
      answerRow({ id: "cron_0a1b2c3d4e5f_20261001_110000" }),
    ]);
    const kept = readSessionRows(answer) ?? [];
    expect(kept.map((each) => [each.rootId, each.id])).toEqual([
      [A, A],
      [A, B],
      ["cron_0a1b2c3d4e5f_20261001_110000", "cron_0a1b2c3d4e5f_20261001_110000"],
    ]);
    expect(kept[0]?.title).toBe("Rename the helper");
    expect(SESSION_ID.test("a".repeat(128))).toBe(true);
    expect(SESSION_ID.test("0b1c2d3e-0000-4000-8000-000000000001")).toBe(true);
  });

  test("keeps a folder only when it is a whole path, not too long, with nothing unprintable in it", () => {
    const long = `/${"a".repeat(4095)}`;
    expect(row({ cwd: long })?.folder).toBe(long);
    for (const cwd of [
      `/${"a".repeat(4096)}`,
      "code/demo",
      "~/code/demo",
      "C:\\code\\demo",
      `${FOLDER}\n`,
      `${FOLDER}\u0000x`,
      `${FOLDER}\u202edemo`,
      `${FOLDER}\u200b`,
      42,
      "",
    ]) {
      expect(row({ cwd, root_cwd: cwd }), JSON.stringify(cwd)).toMatchObject({
        folder: null,
        root: { folder: null },
      });
    }
  });

  test("keeps a title as it is, cut to 1,000 characters, and none that is not text", () => {
    expect(row({ title: "x".repeat(1200), root_title: "y".repeat(1000) })).toMatchObject({
      title: "x".repeat(1000),
      root: { title: "y".repeat(1000) },
    });
    expect(row({ title: 3, root_title: null })).toMatchObject({
      title: null,
      root: { title: null },
    });
  });

  test("keeps a role, kind, finish, reason or source only as a short printable word, and marks anything else of the wrong type", () => {
    const long = "w".repeat(65);
    const kept = row({
      n_role: long,
      n_kind: "failed\nturn",
      n_finish: 3,
      end_reason: "\u202ecli_close",
      root_source: { name: "cli" },
      root_created_source: "w".repeat(64),
    });
    expect(kept?.newest).toMatchObject({ role: undefined, kind: undefined, finish: undefined });
    expect(kept?.endReason).toBeUndefined();
    expect(kept?.root.source).toBeUndefined();
    expect(kept?.root.createdSource).toBe("w".repeat(64));
    // No long or unprintable text is kept anywhere in the row.
    const said = JSON.stringify(kept);
    expect(said).not.toContain(long);
    expect(said).not.toContain("failed\\nturn");
    expect(said).not.toContain("\u202e");
  });

  test("marks a time that is not a number that could be one as of the wrong type", () => {
    for (const time of ["1790000000", -1, 253_402_300_800, true, { at: 1 }]) {
      const kept = row({ started_at: time, n_at: time, calls_at: time, lease_until: time });
      expect(kept?.startedAt, JSON.stringify(time)).toBeUndefined();
      expect(kept?.newest?.at).toBeUndefined();
      expect(kept?.callsAt).toBeUndefined();
      expect(kept?.lease?.until).toBeUndefined();
    }
    expect(row({ started_at: 0 })?.startedAt).toBe(0);
    expect(row({ started_at: 253_402_300_799 })?.startedAt).toBe(253_402_300_799_000);
  });

  test("marks a flag that is not 0, 1 or none, and a count that is not a whole number of none or more", () => {
    for (const flag of [2, -1, true, "1", 0.5]) {
      const kept = row({ approval_label: flag, question_label: flag, n_error: flag });
      expect(kept?.approvalLabel, JSON.stringify(flag)).toBeUndefined();
      expect(kept?.questionLabel).toBeUndefined();
      expect(kept?.newest?.error).toBeUndefined();
    }
    for (const count of [-1, 1.5, "2", true]) {
      expect(row({ open_questions: count })?.openQuestions, JSON.stringify(count)).toBeUndefined();
      expect(row({ open_calls: count })?.openCalls, JSON.stringify(count)).toBeUndefined();
    }
    expect(row({ open_questions: null })?.openQuestions).toBeNull();
    expect(row({ open_calls: null })?.openCalls).toBeNull();
  });

  test("an answer with no rows is none, and one that is not rows is no answer", () => {
    expect(readSessionRows("")).toEqual([]);
    expect(readSessionRows("\n")).toEqual([]);
    expect(readSessionRows("[]")).toEqual([]);
    for (const printed of ["not json", '{"id": "x"}', "[1, 2", "null"]) {
      expect(readSessionRows(printed), printed).toBeNull();
    }
    // A row that is not an object is passed over.
    expect(readSessionRows(`[1, "x", null, ${JSON.stringify(answerRow({ id: A }))}]`)).toHaveLength(
      1,
    );
  });
});
