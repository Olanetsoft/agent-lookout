import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
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
import { QUESTION_OUTPUT_BYTES } from "@collector/adapters/opencode/database";
import { lastTextQuery } from "@collector/adapters/opencode/lastMessages";
import {
  jsonRows,
  PROBE_QUERY,
  readSchema,
  readSessionRows,
  sqliteArguments,
} from "@collector/adapters/opencode/sessionRows";
import { ANSWER_AGAIN_MS } from "@collector/messages/tailReader";
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
  text,
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

// What a session last said, asked with OpenCode's own question of a database
// laid out as Kilo Code v7.8.32 lays it out, which for this question is as
// v7.8.27 does, through the adapter Kilo Code's profile makes.

/** A text part's data, saying these words, with any marks Kilo Code gives it. */
function said(words: string, marks: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "text", text: words, time: { start: 0, end: 0 }, ...marks };
}

/** Kilo Code's data folder with a database of these rows alone, in WAL mode, and nothing beside it. */
async function makeKiloDatabase(rows: string[]): Promise<{ dir: string; file: string }> {
  const dir = path.join(await tempDir(), "kilo");
  const file = path.join(dir, "kilo.db");
  await mkdir(dir, { recursive: true });
  // On stdin, since Linux takes no argument longer than 128 KB.
  execFileSync(sqlite as string, ["-bail", "-init", "/dev/null", file], {
    input: ["PRAGMA journal_mode=WAL;", SCHEMA, ...rows].join("\n"),
    stdio: ["pipe", "ignore", "ignore"],
  });
  // The SQLite of macOS keeps the two files once the database is closed; others remove them.
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  return { dir, file };
}

/** Each file in a folder, by name, with its hash, size and modified time. */
async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of (await readdir(dir)).sort()) {
    const info = await lstat(path.join(dir, name));
    const hash = createHash("sha256")
      .update(await readFile(path.join(dir, name)))
      .digest("hex");
    found[name] = `${hash} ${info.size} ${info.mtimeMs}`;
  }
  return found;
}

/** Kilo Code's adapter over that folder, polled once, and what it answers for a session, a second apart. */
async function kiloReading(dir: string) {
  let at = Date.now();
  const adapter = createKiloCodeAdapter({
    env: { AGENT_LOOKOUT_KILO_HOME: dir },
    homeDir: "/Users/example",
    now: () => at,
    processes: { read: async () => ({ ok: true, running: true }) },
  });
  const { sessions } = await adapter.poll();
  return {
    listed: sessions.map((session) => session.id),
    async ask(id: string) {
      at += ANSWER_AGAIN_MS;
      return adapter.lastMessage(`kilo-code:${id}`);
    },
  };
}

/** What sqlite3 prints for the question of this session's last text, asked as the adapter asks it. */
async function printed(file: string, id: string): Promise<string> {
  const answer = await runSqlite(
    sqlite as string,
    sqliteArguments(file, "whole", lastTextQuery(id) ?? ""),
    undefined,
    QUESTION_OUTPUT_BYTES,
  );
  if (!answer.ok) throw new Error("sqlite3 did not answer.");
  return answer.stdout;
}

describe.skipIf(sqlite === null)(
  "what a Kilo Code session last said, with the real sqlite3",
  () => {
    const ROOT = sessionId("f1");
    const OTHER = sessionId("f2");
    const SUBAGENT = sessionId("f3");
    const THIRD = sessionId("f4");
    const now = Date.now();
    const at = (minutes: number) => now - minutes * MINUTE;
    /** The person's prompt, with one text part of these words. */
    const prompt = (session: string, suffix: string, minutes: number, words: string) => [
      messageRow({
        id: messageId(suffix),
        sessionId: session,
        createdAt: at(minutes),
        data: userData(at(minutes)),
      }),
      partRow({
        id: partId(`${suffix}0`),
        messageId: messageId(suffix),
        sessionId: session,
        createdAt: at(minutes),
        data: said(words),
      }),
    ];
    /** A step of a reply that ended, with these parts, written in the order given, each `[id suffix, data]`. */
    const step = (
      session: string,
      suffix: string,
      minutes: number,
      parts: [string, Record<string, unknown>][],
      marks: Record<string, unknown> = {},
    ) => [
      messageRow({
        id: messageId(suffix),
        sessionId: session,
        createdAt: at(minutes),
        data: {
          ...assistantData({ createdAt: at(minutes), completedAt: at(minutes), finish: "stop" }),
          ...marks,
        },
      }),
      ...parts.map(([part, data]) =>
        partRow({
          id: partId(`${suffix}${part}`),
          messageId: messageId(suffix),
          sessionId: session,
          createdAt: at(minutes),
          data,
        }),
      ),
    ];

    test("is the newest reply's own text parts, in Kilo Code's order, joined with a line break, and no file is made or changed", async () => {
      const { dir, file } = await makeKiloDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...prompt(ROOT, "u1", 6, "Words of the prompt."),
        // Written out of the order of their ids, which is the order Kilo Code shows them in.
        ...step(ROOT, "a1", 5, [
          ["3", said("Second part.")],
          ["0", { type: "reasoning", text: "Thinking it over.", time: { start: at(5) } }],
          ["1", said("First part.")],
          ["2", toolData({ status: "completed" })],
          // The warning Kilo Code adds when a step stops at its output limit, and its passing note of progress.
          ["4", said("Stopped at the output limit.", { ignored: true })],
          [
            "5",
            said("Checking the files.", {
              synthetic: true,
              metadata: { "kilocode.lifecycle": "transient" },
            }),
          ],
          ["6", { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 1 } }],
        ]),
        // A compaction's summary, then a reply under way, whose text part Kilo Code saves empty.
        ...step(ROOT, "a2", 4, [["0", said("The summary of the session.")]], {
          summary: true,
          mode: "compaction",
          agent: "compaction",
        }),
        messageRow({
          id: messageId("a3"),
          sessionId: ROOT,
          createdAt: at(3),
          data: assistantData({ createdAt: at(3) }),
        }),
        partRow({
          id: partId("a30"),
          messageId: messageId("a3"),
          sessionId: ROOT,
          createdAt: at(3),
          data: { type: "text", text: "", time: { start: at(3) } },
        }),
      ]);
      const before = await snapshotOf(dir);
      expect(Object.keys(before)).toEqual(["kilo.db"]);

      const reading = await kiloReading(dir);
      expect(reading.listed).toEqual([`kilo-code:${ROOT}`]);
      expect(await reading.ask(ROOT)).toEqual({
        message: { text: "First part.\nSecond part.", cut: false },
      });
      expect(await snapshotOf(dir)).toEqual(before);

      const answer = await printed(file, ROOT);
      for (const words of [
        "Words of the prompt.",
        "Thinking it over.",
        "Stopped at the output limit.",
        "Checking the files.",
        "kilocode.lifecycle",
        "The summary of the session.",
        PRIVATE_WORDS,
        SECRET_WORDS,
      ]) {
        expect(answer).not.toContain(words);
      }
      expect(await snapshotOf(dir)).toEqual(before);
    });

    test("after /undo, the reply before the messages it took back shows, as Kilo Code shows it, and nothing of revert is printed", async () => {
      /** Two prompts, each with its reply. */
      const turns = (session: string, letter: string) => [
        sessionRow({ id: session, updatedAt: at(1) }),
        ...prompt(session, `${letter}1`, 10, "Tidy the docs."),
        ...step(session, `${letter}2`, 9, [["0", said("Earlier reply.")]]),
        ...prompt(session, `${letter}8`, 8, "Clear out the old files."),
        // Written after the prompt, with a smaller id: what comes after it is told by time first.
        ...step(session, `${letter}0`, 7, [["0", said("I deleted the migrations folder.")]]),
      ];
      /** The revert Kilo Code writes, with its own `workspace` beside OpenCode's fields. */
      const revert = (session: string, fields: Record<string, unknown>) =>
        `UPDATE session SET revert = ${text(JSON.stringify({ snapshot: "demo-snapshot", diff: PRIVATE_WORDS, workspace: "restored", ...fields }))} WHERE id = ${text(session)};`;
      const { dir, file } = await makeKiloDatabase([
        // /undo went back to the second prompt.
        ...turns(ROOT, "a"),
        revert(ROOT, { messageID: messageId("a8") }),
        // /undo of a part of the newest reply names that reply, and hides it whole.
        ...turns(OTHER, "b"),
        revert(OTHER, { messageID: messageId("b0"), partID: partId("b00") }),
        // No undo.
        ...turns(THIRD, "c"),
      ]);
      const reading = await kiloReading(dir);
      expect(await reading.ask(ROOT)).toEqual({ message: { text: "Earlier reply.", cut: false } });
      expect(await reading.ask(OTHER)).toEqual({ message: { text: "Earlier reply.", cut: false } });
      expect(await reading.ask(THIRD)).toEqual({
        message: { text: "I deleted the migrations folder.", cut: false },
      });

      for (const id of [ROOT, OTHER]) {
        const answer = await printed(file, id);
        for (const words of [
          "I deleted the migrations folder.",
          messageId("a8"),
          messageId("b0"),
          partId("b00"),
          "demo-snapshot",
          "restored",
          PRIVATE_WORDS,
        ]) {
          expect(answer).not.toContain(words);
        }
      }
    });

    test("a subagent's newer reply is never its parent's, its session is not asked as one of its own, and another session's text never shows", async () => {
      const { dir, file } = await makeKiloDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...prompt(ROOT, "u1", 10, "Look into it."),
        ...step(ROOT, "a1", 9, [
          ["0", said("The parent's reply.")],
          // The task tool that started the subagent, whose output is never taken.
          ["1", toolData({ status: "completed", tool: "task" })],
        ]),
        // The subagent's own session, written after the parent's reply.
        sessionRow({ id: SUBAGENT, parentId: ROOT, updatedAt: at(2) }),
        ...prompt(SUBAGENT, "c1", 4, "Look into it."),
        ...step(SUBAGENT, "c2", 2, [["0", said("What the subagent said.")]]),
        // Another root session, written last.
        sessionRow({ id: OTHER, updatedAt: at(1) }),
        ...step(OTHER, "b1", 1, [["0", said("Another session's reply.")]]),
      ]);
      const reading = await kiloReading(dir);
      expect(reading.listed.sort()).toEqual([`kilo-code:${ROOT}`, `kilo-code:${OTHER}`].sort());
      expect(await reading.ask(ROOT)).toEqual({
        message: { text: "The parent's reply.", cut: false },
      });
      expect(await reading.ask(OTHER)).toEqual({
        message: { text: "Another session's reply.", cut: false },
      });
      // Not listed, so not asked; and asked all the same, the question finds no root session.
      expect(await reading.ask(SUBAGENT)).toBeNull();
      expect(JSON.parse(await printed(file, SUBAGENT))).toEqual([
        { kind: "reply", parts: 0, more: 0, n: null, cut: null, text: null },
      ]);
      const answer = await printed(file, ROOT);
      expect(answer).not.toContain("What the subagent said.");
      expect(answer).not.toContain("Another session's reply.");
    });

    test("looks no further back than the newest 100 messages, and what sqlite3 prints stays far under 256 KB", async () => {
      const toolSteps = (session: string, letter: string, count: number) =>
        Array.from({ length: count }, (_, index) =>
          step(session, `${letter}${index + 10}`, 100 - index * 0.5, [
            ["0", toolData({ status: "completed" })],
          ]),
        ).flat();
      const { dir, file } = await makeKiloDatabase([
        // A reply, then 100 steps that only call tools.
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...step(ROOT, "d1", 200, [["0", said("Long ago.")]]),
        ...toolSteps(ROOT, "d", 100),
        // A reply far longer than is kept, then five thousand parts of one letter each.
        sessionRow({ id: OTHER, updatedAt: at(1) }),
        ...step(OTHER, "e1", 2, [
          ["0", said("filled below")],
          ["1", said("The end of it.")],
        ]),
        `UPDATE part SET data = json_set(data, '$.text', hex(zeroblob(500000))) WHERE id = ${text(partId("e10"))};`,
        sessionRow({ id: THIRD, updatedAt: at(1) }),
        ...step(THIRD, "g1", 2, []),
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)",
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'prt_g' || printf('%05d', i), ${text(messageId("g1"))}, ${text(THIRD)}, 0, 0, json_object('type', 'text', 'text', 'y') FROM n;`,
      ]);
      const reading = await kiloReading(dir);
      expect(await reading.ask(ROOT)).toEqual({ message: null, reason: "too-far-back" });

      const long = await reading.ask(OTHER);
      expect(long).toMatchObject({ message: { cut: true } });
      expect(
        (long as { message: { text: string } }).message.text.endsWith("0000\nThe end of it."),
      ).toBe(true);
      expect((await printed(file, OTHER)).length).toBeLessThan(16 * 1024);

      const many = await reading.ask(THIRD);
      expect(many).toMatchObject({ message: { cut: true } });
      expect((many as { message: { text: string } }).message.text).toMatch(/^(y\n)+y$/);
      expect(Buffer.byteLength(await printed(file, THIRD))).toBeLessThan(QUESTION_OUTPUT_BYTES);
      expect(QUESTION_OUTPUT_BYTES).toBe(256 * 1024);
    });

    test("with either setting off, it is off, by that setting", async () => {
      const { dir } = await makeKiloDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...step(ROOT, "a1", 2, [["0", said("The reply.")]]),
      ]);
      for (const [setting, value] of [
        ["AGENT_LOOKOUT_LAST_MESSAGE", "off"],
        ["AGENT_LOOKOUT_WAITING_TEXT", "off"],
      ] as const) {
        const adapter = createKiloCodeAdapter({
          env: { AGENT_LOOKOUT_KILO_HOME: dir, [setting]: value },
          homeDir: "/Users/example",
          processes: { read: async () => ({ ok: true, running: true }) },
        });
        expect((await adapter.poll()).sessions).toHaveLength(1);
        await expect(adapter.lastMessage(`kilo-code:${ROOT}`)).resolves.toEqual({
          message: null,
          reason: "off",
          setting,
        });
      }
    });
  },
);
