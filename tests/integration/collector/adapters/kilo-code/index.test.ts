import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  findSqlite,
  runSqlite,
  TRUSTED_SCHEMA_OFF,
} from "@collector/adapters/antigravity/app/summaries";
import {
  BASIS,
  createKiloCodeAdapter,
  KILO_SESSIONS_QUERY,
} from "@collector/adapters/kilo-code/index";
import {
  jsonRows,
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  sqliteArguments,
} from "@collector/adapters/opencode/sessionRows";
import {
  assistantData,
  messageId,
  messageRow,
  MINUTE,
  partId,
  partRow,
  PRIVATE_WORDS,
  SCHEMA,
  SECRET_WORDS,
  sessionId,
  sessionRow,
  textData,
  toolData,
  userData,
} from "@tests/fixtures/kilo-code/kiloCode";
import { tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, with the real sqlite3, on a database this test
// writes with the tables and indexes Kilo Code v7.8.27 makes, the indexes on
// `json_extract` among them, read with the schema not trusted, as every read
// is. What `ps` would say is given: the real `ps` is asked in the OpenCode
// adapter's processes.test.ts, with the same arguments. Where there is no
// sqlite3, as on Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const IDLE = sessionId("a1");
const WORKING = sessionId("b2");
const ASKING = sessionId("c3");
const SUGGESTING = sessionId("d4");
const SUGGESTING_AND_WORKING = sessionId("e5");
const PLANNED = sessionId("f6");
const FAILED = sessionId("a7");
const SUGGESTION_WRITTEN = sessionId("b8");
const CHILD = sessionId("c9");

/** The rows of every session the database holds, relative to `now`. */
function rows(now: number): string[] {
  const at = (minutes: number) => now - minutes * MINUTE;
  const prompt = (id: string, suffix: string, minutes: number) =>
    messageRow({
      id: messageId(suffix),
      sessionId: id,
      createdAt: at(minutes),
      data: userData(at(minutes)),
    });
  /** A step under way, with these tool parts of its own beside a text part. */
  const underWay = (
    id: string,
    suffix: string,
    tools: { tool: string; status: "pending" | "running" | "completed" | "error" }[],
  ) => [
    sessionRow({ id, title: `Session ${suffix}`, createdAt: at(30), updatedAt: at(2) }),
    prompt(id, `${suffix}u`, 3),
    messageRow({
      id: messageId(`${suffix}a`),
      sessionId: id,
      createdAt: at(2),
      data: assistantData({ createdAt: at(2) }),
    }),
    partRow({
      id: partId(`${suffix}0`),
      messageId: messageId(`${suffix}a`),
      sessionId: id,
      createdAt: at(2),
      data: textData(),
    }),
    ...tools.map(({ tool, status }, index) =>
      partRow({
        id: partId(`${suffix}${index + 1}`),
        messageId: messageId(`${suffix}a`),
        sessionId: id,
        createdAt: at(1),
        data: toolData({ status, tool }),
      }),
    ),
  ];
  return [
    // Idle: its last step ended the turn, with token counts.
    sessionRow({ id: IDLE, title: "Rename the helper", createdAt: at(30), updatedAt: at(5) }),
    prompt(IDLE, "a1u", 6),
    messageRow({
      id: messageId("a1a"),
      sessionId: IDLE,
      createdAt: at(5),
      data: assistantData({
        createdAt: at(5),
        completedAt: at(5),
        finish: "stop",
        tokens: {
          total: 2520,
          input: 200,
          output: 100,
          reasoning: 20,
          cache: { read: 1800, write: 400 },
        },
      }),
    }),
    // The mark Kilo Code writes as a step ends, which an index of its own finds.
    partRow({
      id: partId("a1f"),
      messageId: messageId("a1a"),
      sessionId: IDLE,
      createdAt: at(5),
      data: { type: "step-finish", reason: "stop" },
    }),
    // A step that runs the shell.
    ...underWay(WORKING, "b2", [{ tool: "bash", status: "running" }]),
    // A question that waits for you.
    ...underWay(ASKING, "c3", [{ tool: "question", status: "running" }]),
    // A suggestion of a review, which Kilo Code shows as idle while it waits,
    // with a call that ended before it.
    ...underWay(SUGGESTING, "d4", [
      { tool: "read", status: "completed" },
      { tool: "suggest", status: "running" },
    ]),
    // A suggestion beside a call that still runs.
    ...underWay(SUGGESTING_AND_WORKING, "e5", [
      { tool: "suggest", status: "running" },
      { tool: "bash", status: "running" },
    ]),
    // Kilo Code's plan_exit asks nothing: the plan's approval comes after it, in memory.
    ...underWay(PLANNED, "f6", [{ tool: "plan_exit", status: "running" }]),
    // A suggestion the model is still writing has not begun to wait.
    ...underWay(SUGGESTION_WRITTEN, "b8", [{ tool: "suggest", status: "pending" }]),
    // Failed: its reply ended on an error.
    sessionRow({ id: FAILED, title: "Write the notes", createdAt: at(40), updatedAt: at(10) }),
    messageRow({
      id: messageId("a7a"),
      sessionId: FAILED,
      createdAt: at(10),
      data: assistantData({ createdAt: at(10), completedAt: at(10), error: "APIError" }),
    }),
    // A subagent's session is left out.
    sessionRow({ id: CHILD, title: "Look around", parentId: IDLE, updatedAt: at(3) }),
  ];
}

/** Kilo Code's data folder, `kilo` in a data folder of the test's own, with a closed database of these rows. */
async function makeHome(now: number, more: string[] = []): Promise<{ data: string; file: string }> {
  const data = await tempDir();
  const home = path.join(data, "kilo");
  await mkdir(home);
  const file = path.join(home, "kilo.db");
  // On stdin, since Linux takes no argument longer than 128 KB.
  execFileSync(sqlite as string, ["-init", "/dev/null", file], {
    input: [SCHEMA, ...rows(now), ...more].join("\n"),
    stdio: ["pipe", "ignore", "ignore"],
  });
  return { data, file };
}

/** What the real sqlite3 prints for one fixed question, asked as the adapter asks it. */
async function ask(file: string, question: string): Promise<string> {
  const answer = await runSqlite(sqlite as string, sqliteArguments(file, "whole", question));
  if (!answer.ok) throw new Error("sqlite3 did not answer.");
  return answer.stdout;
}

// This test decides whether Kilo Code's database may be read at all, so in CI,
// on macOS and Linux, it must not be skipped for want of a sqlite3. Elsewhere,
// as on a machine with sqlite3 in none of its fixed places, it is skipped.
test.runIf(Boolean(process.env.CI) && process.platform !== "win32")(
  "sqlite3 is at one of its fixed places, so the tests below run",
  () => {
    expect(sqlite).not.toBeNull();
  },
);

describe.skipIf(sqlite === null)("the Kilo Code adapter, with the real sqlite3", () => {
  test("lists each root session with its name, folder and status, from kilo.db in Kilo Code's data folder", async () => {
    const now = Date.now();
    const { data } = await makeHome(now);
    const adapter = createKiloCodeAdapter({
      env: { XDG_DATA_HOME: data },
      homeDir: "/Users/example",
      now: () => now,
      processes: { read: async () => ({ ok: true, running: true }) },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toMatch(/^Sessions are read from Kilo Code's database, /);
    expect(basis).toBe(BASIS);
    expect(Object.fromEntries(sessions.map((session) => [session.id, session.status]))).toEqual({
      [`kilo-code:${IDLE}`]: "idle",
      [`kilo-code:${WORKING}`]: "working",
      [`kilo-code:${ASKING}`]: "needs-you",
      [`kilo-code:${SUGGESTING}`]: "idle",
      [`kilo-code:${SUGGESTING_AND_WORKING}`]: "working",
      [`kilo-code:${PLANNED}`]: "working",
      [`kilo-code:${SUGGESTION_WRITTEN}`]: "working",
      [`kilo-code:${FAILED}`]: "failed",
    });
    const idle = sessions.find((session) => session.id === `kilo-code:${IDLE}`);
    expect(idle).toMatchObject({
      source: "kilo-code",
      name: "Rename the helper",
      cwd: "/Users/example/code/demo",
      tokens: { input: 2400, cached: 1800, output: 120 },
    });
    expect(sessions.find((session) => session.status === "needs-you")?.waitingReason).toBe(
      "question",
    );
    const said = JSON.stringify({ health, sessions });
    expect(said).not.toContain(SECRET_WORDS);
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain("OpenCode");
  });

  test("Kilo Code's indexes on json_extract are read with the schema not trusted, and the probe takes its tables for 1.x's", async () => {
    const { file } = await makeHome(Date.now());
    const indexes = jsonRows(
      await ask(file, "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name"),
    )?.map((row) => row.name);
    for (const name of [
      "recall_message_role_idx",
      "part_session_step_finish_idx",
      "recall_part_search_idx",
    ]) {
      expect(indexes, name).toContain(name);
    }
    // Every read is asked with the schema not trusted.
    expect(sqliteArguments(file, "whole", PROBE_QUERY)).toContain(TRUSTED_SCHEMA_OFF);

    // Questions read through two of those indexes, asked that way, are
    // answered: SQLite's own JSON functions may be used in a schema that is
    // not trusted.
    expect(
      jsonRows(
        await ask(
          file,
          `SELECT count(*) AS n FROM part INDEXED BY part_session_step_finish_idx WHERE session_id = '${IDLE}' AND json_valid(data) AND json_extract(data, '$.type') = 'step-finish'`,
        ),
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      jsonRows(
        await ask(
          file,
          `SELECT json_extract(data, '$.role') AS role FROM message INDEXED BY recall_message_role_idx WHERE id = '${messageId("a1a")}'`,
        ),
      ),
    ).toEqual([{ role: "assistant" }]);

    expect(readSchema(await ask(file, PROBE_QUERY), { v2: false })).toEqual({ layout: "v1" });
    const printed = await ask(file, KILO_SESSIONS_QUERY);
    expect(
      readSessionRows(printed)
        ?.map((row) => row.id)
        .sort(),
    ).toEqual(
      [
        IDLE,
        WORKING,
        ASKING,
        SUGGESTING,
        SUGGESTING_AND_WORKING,
        PLANNED,
        FAILED,
        SUGGESTION_WRITTEN,
      ].sort(),
    );
    // Nothing of the tables that hold secrets, and no text written, is printed.
    expect(printed).not.toContain(SECRET_WORDS);
    expect(printed).not.toContain(PRIVATE_WORDS);
  });

  test("a database with session_v2 is a version of Kilo Code it does not read, and lists nothing", async () => {
    const now = Date.now();
    const { data } = await makeHome(now, [
      "CREATE TABLE session_v2 (id text PRIMARY KEY, parent_id text, slug text, directory text, title text, time_created integer, time_updated integer, time_archived integer, time_suspended integer, time_idle integer, idle_outcome text);",
    ]);
    const adapter = createKiloCodeAdapter({
      env: { XDG_DATA_HOME: data },
      homeDir: "/Users/example",
      now: () => now,
      processes: { read: async () => ({ ok: true, running: true }) },
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toMatch(
      /is laid out as a version of Kilo Code that Agent Lookout does not read\.$/,
    );
    expect(sessions).toEqual([]);
  });
});
