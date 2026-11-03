import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { findSqlite, runSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createDatabaseReader, QUESTION_OUTPUT_BYTES } from "@collector/adapters/opencode/database";
import {
  createOpencodeLastMessages,
  lastTextQuery,
} from "@collector/adapters/opencode/lastMessages";
import { sqliteArguments } from "@collector/adapters/opencode/sessionRows";
import { nodeIo } from "@collector/files/readOnlyIo";
import { ANSWER_AGAIN_MS } from "@collector/messages/tailReader";
import type { LastMessageResponse } from "@core/api";
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
  toolData,
  userData,
} from "@tests/fixtures/opencode/opencode";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 asks the one question of a session's last text, as the
// adapter asks it, of a database this test writes with that same sqlite3,
// laid out as OpenCode 1.19.0's is. A second sqlite3, kept open as OpenCode
// keeps its database open, stands in for OpenCode where its commits must lie
// in the -wal. Each answer must be the reply's own words alone, and every
// byte, size and modified time of the database, its -wal and its -shm must
// stay as they were. Where there is no sqlite3, as on Windows, there is
// nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const A = sessionId("a1");
const B = sessionId("b2");
const NOW = Date.now();
const at = (minutes: number) => NOW - minutes * MINUTE;

/** A text part's data, saying these words. */
function said(words: string, marks: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "text", text: words, time: { start: at(1), end: at(1) }, ...marks };
}

/** The person's prompt, with one text part of these words. */
function prompt(session: string, suffix: string, minutes: number, words: string): string[] {
  return [
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
}

/** A step of a reply that ended, with these parts, written in the order given, each `[id suffix, data]`. */
function step(
  session: string,
  suffix: string,
  minutes: number,
  parts: [string, Record<string, unknown>][],
  marks: Record<string, unknown> = {},
): string[] {
  return [
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
}

/** OpenCode's database in a folder of its own, in WAL mode, with these rows, and nothing beside it. */
async function makeDatabase(rows: string[]): Promise<{ dir: string; file: string }> {
  const dir = path.join(await tempDir(), "opencode");
  const file = path.join(dir, "opencode.db");
  await mkdir(dir, { recursive: true });
  // On stdin, since Linux takes no argument longer than 128 KB, and some of these are longer.
  execFileSync(sqlite as string, [file], {
    input: ["PRAGMA journal_mode=WAL;", SCHEMA, ...rows].join("\n"),
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

/** A second sqlite3 that keeps the database open, as OpenCode does while it runs, and writes what it is given. */
function holdOpen(file: string, marks: string) {
  const child: ChildProcess = spawn(sqlite as string, ["-batch", file], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  let count = 0;
  return {
    /** Writes these statements as one commit, and waits until sqlite3 has run them. */
    async write(statements: string[]): Promise<void> {
      count += 1;
      const mark = path.join(marks, `written-${count}`);
      child.stdin?.write(
        `PRAGMA busy_timeout = 5000;\n${statements.join("\n")}\n.once ${mark}\nSELECT 'done';\n`,
      );
      const until = Date.now() + 10_000;
      for (;;) {
        const there = await stat(mark).then(
          (info) => info.size > 0,
          () => false,
        );
        if (there) return;
        if (Date.now() > until) throw new Error("sqlite3 did not write in time.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    /** Ends it with SIGKILL, so its -wal and -shm are left full, as OpenCode leaves them when it quits. */
    async kill(): Promise<void> {
      const gone = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await gone;
    },
  };
}

/** The reader of last messages the adapter makes for this database, with these sessions listed, on a clock the test moves. */
function readerOf(file: string, ids: readonly string[]) {
  let now = NOW;
  const messages = createOpencodeLastMessages({
    reader: createDatabaseReader({ file, io: nodeIo, platform: process.platform }),
    database: file,
    now: () => now,
    later: () => {},
  });
  messages.keep(new Map(ids.map((id) => [`opencode:${id}`, id])));
  return {
    /** What the session last said, asked once the second an answer is given again is up. */
    async ask(id: string): Promise<LastMessageResponse | "busy" | null> {
      now += ANSWER_AGAIN_MS;
      return messages.read(`opencode:${id}`);
    },
  };
}

/** What sqlite3 prints for the question of this session's last text, asked as the adapter asks it. */
async function printed(file: string, id: string, mode: "whole" | "with-wal" = "whole") {
  const answer = await runSqlite(
    sqlite as string,
    sqliteArguments(file, mode, lastTextQuery(id) ?? ""),
    undefined,
    QUESTION_OUTPUT_BYTES,
  );
  expect(answer.ok).toBe(true);
  return answer.ok ? answer.stdout : "";
}

describe.skipIf(sqlite === null)("asking OpenCode's database what a session last said", () => {
  test("is the newest reply's own text parts, in OpenCode's order, joined with a line break, and no file is made or changed", async () => {
    const { dir, file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...prompt(A, "u1", 5, "Words of the prompt."),
      // Written out of the order of their ids, which is the order OpenCode shows them in.
      ...step(A, "a1", 4, [
        ["3", said("Second part.")],
        ["0", { type: "reasoning", text: "Thinking it over.", time: { start: at(4) } }],
        ["1", said("First part.")],
        ["2", toolData({ status: "completed" })],
        [
          "4",
          {
            type: "file",
            mime: "text/plain",
            filename: "notes.txt",
            url: "file:///Users/example/code/demo/notes.txt",
            source: {
              type: "file",
              path: "notes.txt",
              text: { value: "File words.", start: 0, end: 1 },
            },
          },
        ],
        ["5", said("Synthetic words.", { synthetic: true })],
        ["6", said("Ignored words.", { ignored: true })],
        ["7", { type: "step-finish", reason: "stop", cost: 0, tokens: { input: 1, output: 1 } }],
      ]),
    ]);
    const before = await snapshotOf(dir);
    expect(Object.keys(before)).toEqual(["opencode.db"]);

    const reader = readerOf(file, [A]);
    expect(await reader.ask(A)).toEqual({
      message: { text: "First part.\nSecond part.", cut: false },
    });
    expect(await snapshotOf(dir)).toEqual(before);

    const answer = await printed(file, A);
    for (const words of [
      "Words of the prompt.",
      "Thinking it over.",
      "File words.",
      "notes.txt",
      "Synthetic words.",
      "Ignored words.",
      PRIVATE_WORDS,
      SECRET_WORDS,
    ]) {
      expect(answer).not.toContain(words);
    }
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("a step that only thinks, calls tools or says nothing but spaces is passed over for the reply before it, and so is a compaction's summary", async () => {
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...prompt(A, "u1", 10, "Tidy the docs."),
      ...step(A, "a1", 9, [["0", said("The reply.")]]),
      ...step(A, "a2", 8, [
        ["0", { type: "reasoning", text: "Thinking it over.", time: { start: at(8) } }],
        ["1", toolData({ status: "completed" })],
      ]),
      ...step(A, "a3", 7, [["0", said("  \n\t \r\n ")]]),
      // The person asks OpenCode to compact the session, and it writes a summary.
      messageRow({
        id: messageId("u2"),
        sessionId: A,
        createdAt: at(6),
        data: userData(at(6)),
      }),
      partRow({
        id: partId("u20"),
        messageId: messageId("u2"),
        sessionId: A,
        createdAt: at(6),
        data: { type: "compaction", auto: false },
      }),
      ...step(A, "a4", 5, [["0", said("The summary of the session.")]], {
        summary: true,
        mode: "compaction",
        agent: "compaction",
      }),
    ]);
    expect(await readerOf(file, [A]).ask(A)).toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("after /undo, the reply before the messages it took back shows, as OpenCode shows it, and nothing of revert is printed", async () => {
    const C = sessionId("c3");
    const D = sessionId("d4");
    const E = sessionId("e5");
    /** Two prompts, each with its reply. */
    const turns = (session: string, letter: string, undoneFrom?: string) => [
      sessionRow({ id: session, updatedAt: at(1), undoneFrom }),
      ...prompt(session, `${letter}1`, 10, "Tidy the docs."),
      ...step(session, `${letter}2`, 9, [["0", said("Earlier reply.")]]),
      ...prompt(session, `${letter}8`, 8, "Clear out the old files."),
      // Written after the prompt, with a smaller id: what comes after it is told by time first.
      ...step(session, `${letter}0`, 7, [["0", said("I deleted the migrations folder.")]]),
    ];
    const { file } = await makeDatabase([
      // /undo went back to the second prompt.
      ...turns(A, "a", messageId("a8")),
      // No undo.
      ...turns(B, "b"),
      // A revert that is not JSON, and one that names another session's message.
      ...turns(C, "c"),
      `UPDATE session SET revert = 'not json' WHERE id = ${text(C)};`,
      ...turns(D, "d", messageId("a8")),
      // /undo went back to the first prompt, so every reply is taken back.
      ...turns(E, "e", messageId("e1")),
    ]);
    const reader = readerOf(file, [A, B, C, D, E]);
    expect(await reader.ask(A)).toEqual({ message: { text: "Earlier reply.", cut: false } });
    const newest = { message: { text: "I deleted the migrations folder.", cut: false } };
    expect(await reader.ask(B)).toEqual(newest);
    expect(await reader.ask(C)).toEqual(newest);
    expect(await reader.ask(D)).toEqual(newest);
    expect(await reader.ask(E)).toEqual({ message: null, reason: "nothing-yet" });

    const answer = await printed(file, A);
    for (const words of [
      "I deleted the migrations folder.",
      messageId("a8"),
      "demo-snapshot",
      PRIVATE_WORDS,
    ]) {
      expect(answer).not.toContain(words);
    }
  });

  test("after /undo, the newest 100 messages looked through, and those counted, come before the ones it took back", async () => {
    const F = sessionId("f6");
    const H = sessionId("h8");
    const toolSteps = (session: string, prefix: string, count: number, from: number) =>
      Array.from({ length: count }, (_, index) =>
        step(session, `${prefix}${index + 10}`, from - index * 0.1, [
          ["0", toolData({ status: "completed" })],
        ]),
      ).flat();
    const { file } = await makeDatabase([
      // 50 steps that only call tools, then the prompt /undo went back to,
      // then 60 more: 111 messages, of which only 50 are left.
      sessionRow({ id: F, updatedAt: at(1), undoneFrom: messageId("f9") }),
      ...toolSteps(F, "fa", 50, 100),
      ...prompt(F, "f9", 50, "Clear out the old files."),
      ...toolSteps(F, "fb", 60, 40),
      // A reply and 99 such steps, then the prompt /undo went back to, a
      // reply to it and 10 more steps: the first reply is the oldest of the
      // newest 100 that are left.
      sessionRow({ id: H, updatedAt: at(1), undoneFrom: messageId("h9") }),
      ...step(H, "h1", 200, [["0", said("Just in reach.")]]),
      ...toolSteps(H, "ha", 99, 150),
      ...prompt(H, "h9", 50, "Clear out the old files."),
      ...step(H, "h7", 45, [["0", said("Taken back.")]]),
      ...toolSteps(H, "hb", 10, 40),
    ]);
    const reader = readerOf(file, [F, H]);
    expect(await reader.ask(F)).toEqual({ message: null, reason: "nothing-yet" });
    expect(await reader.ask(H)).toEqual({ message: { text: "Just in reach.", cut: false } });
  });

  test("a message or a part whose data is not JSON is passed over, and the reply is still read", async () => {
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a1", 5, [["0", said("The reply.")]]),
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (${text(partId("a19"))}, ${text(messageId("a1"))}, ${text(A)}, ${at(5)}, ${at(5)}, 'not json');`,
      `INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (${text(messageId("a2"))}, ${text(A)}, ${at(2)}, ${at(2)}, 'not json');`,
    ]);
    expect(await readerOf(file, [A]).ask(A)).toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("a text part whose text is not a string is passed over for the reply before it", async () => {
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a1", 5, [["0", said("The reply.")]]),
      ...step(A, "a2", 2, [
        ["0", { type: "text", text: 7 }],
        ["1", { type: "text", text: { words: "odd" } }],
      ]),
    ]);
    expect(await readerOf(file, [A]).ask(A)).toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("the newest reply is the newest by time_created, and by the larger id when two are made in the same millisecond", async () => {
    const { file } = await makeDatabase([
      // The newest reply by time has the smallest id.
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a0", 1, [["0", said("Newest by time.")]]),
      ...Array.from({ length: 100 }, (_, i) =>
        step(A, `z${i + 10}`, 200 - i, [
          ["0", i === 99 ? said("Older, larger id.") : toolData({ status: "completed" })],
        ]),
      ).flat(),
      ...step(A, "zz", 300, [["0", said("Oldest.")]]),
      // Two replies made in the same millisecond.
      sessionRow({ id: B, updatedAt: at(1) }),
      ...step(B, "a2", 2, [["0", said("Later id.")]]),
      ...step(B, "a1", 2, [["0", said("Earlier id.")]]),
    ]);
    const reader = readerOf(file, [A, B]);
    expect(await reader.ask(A)).toEqual({ message: { text: "Newest by time.", cut: false } });
    expect(await reader.ask(B)).toEqual({ message: { text: "Later id.", cut: false } });
  });

  test("a subagent's text is never its parent's last message, and its session is not asked as one of its own", async () => {
    const C = sessionId("c3");
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...prompt(A, "u1", 10, "Look into it."),
      ...step(A, "a1", 9, [
        ["0", said("The parent's reply.")],
        [
          "1",
          {
            type: "tool",
            callID: "demo-call",
            tool: "task",
            state: {
              status: "completed",
              input: { prompt: "Look into it." },
              output: "What the subagent said.",
              title: "Look into it",
              metadata: { sessionId: C },
              time: { start: at(9), end: at(2) },
            },
          },
        ],
      ]),
      // The subagent's own session, written after the parent's reply.
      sessionRow({ id: C, parentId: A, updatedAt: at(2) }),
      ...prompt(C, "c1", 4, "Look into it."),
      ...step(C, "c2", 2, [["0", said("What the subagent said.")]]),
    ]);
    const reader = readerOf(file, [A, C]);
    expect(await reader.ask(A)).toEqual({ message: { text: "The parent's reply.", cut: false } });
    expect(await reader.ask(C)).toEqual({ message: null, reason: "nothing-yet" });
    expect(await printed(file, A)).not.toContain("What the subagent said.");
  });

  test("with nothing said yet, or no reply among its newest 100 messages, it says which", async () => {
    const D = sessionId("d4");
    const E = sessionId("e5");
    const F = sessionId("f6");
    const toolSteps = (session: string, letter: string, count: number) =>
      Array.from({ length: count }, (_, index) =>
        step(session, `${letter}${index + 10}`, 100 - index * 0.5, [
          ["0", toolData({ status: "completed" })],
        ]),
      ).flat();
    const { file } = await makeDatabase([
      // Only a prompt.
      sessionRow({ id: B, updatedAt: at(1) }),
      ...prompt(B, "b1", 2, "Tidy the docs."),
      // A reply, then 100 steps that only call tools.
      sessionRow({ id: D, updatedAt: at(1) }),
      ...step(D, "d1", 200, [["0", said("Long ago.")]]),
      ...toolSteps(D, "d", 100),
      // A reply, then 99 such steps: it is the oldest of the newest 100.
      sessionRow({ id: F, updatedAt: at(1) }),
      ...step(F, "f1", 200, [["0", said("Just in reach.")]]),
      ...toolSteps(F, "f", 99),
      // Exactly 100 prompts, all looked through.
      sessionRow({ id: E, updatedAt: at(1) }),
      ...Array.from({ length: 100 }, (_, index) =>
        prompt(E, `e${index + 10}`, 100 - index * 0.5, "Tidy the docs."),
      ).flat(),
    ]);
    const reader = readerOf(file, [B, D, E, F]);
    expect(await reader.ask(B)).toEqual({ message: null, reason: "nothing-yet" });
    expect(await reader.ask(D)).toEqual({ message: null, reason: "too-far-back" });
    expect(await reader.ask(F)).toEqual({ message: { text: "Just in reach.", cut: false } });
    expect(await reader.ask(E)).toEqual({ message: null, reason: "nothing-yet" });
  });

  test("a reply far longer than is kept is cut inside SQLite, so sqlite3 prints little and its last 2,000 characters show", async () => {
    const G = sessionId("g7");
    const { file } = await makeDatabase([
      // A million characters, then the reply's last words.
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a1", 2, [
        ["0", said("filled below")],
        ["1", said("The end of it.")],
      ]),
      `UPDATE part SET data = json_set(data, '$.text', hex(zeroblob(500000))) WHERE id = ${text(partId("a10"))};`,
      // Five thousand parts of one letter each.
      sessionRow({ id: G, updatedAt: at(1) }),
      ...step(G, "g1", 2, []),
      "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)",
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'prt_g' || printf('%05d', i), ${text(messageId("g1"))}, ${text(G)}, 0, 0, json_object('type', 'text', 'text', 'y') FROM n;`,
    ]);
    const reader = readerOf(file, [A, G]);

    const long = await reader.ask(A);
    expect(long).toMatchObject({ message: { cut: true } });
    const shown = (long as { message: { text: string } }).message.text;
    expect(shown.length).toBeLessThanOrEqual(2_000);
    expect(shown.endsWith("0000\nThe end of it.")).toBe(true);
    expect((await printed(file, A)).length).toBeLessThan(16 * 1024);

    const many = await reader.ask(G);
    expect(many).toMatchObject({ message: { cut: true } });
    expect((many as { message: { text: string } }).message.text).toMatch(/^(y\n)+y$/);
    expect(Buffer.byteLength(await printed(file, G))).toBeLessThan(QUESTION_OUTPUT_BYTES);
  });

  test("the most the question can print, 2,000 text rows of characters sqlite3 writes as six bytes each, is under 175 KB", async () => {
    // A long part, then 1,998 parts of one character and one of two: the
    // newer ones add 3,999 to the long part's `after`, so it is printed too.
    // Each is char(1), which sqlite3 prints as \u0001, or from 3.45.0 to
    // 3.47.x, as Ubuntu 24.04's does, as u0001, a byte less.
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a1", 2, []),
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_a00000', ${text(messageId("a1"))}, ${text(A)}, 0, 0, json_object('type', 'text', 'text', replace(hex(zeroblob(5000)), '00', char(1))));`,
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_a00001', ${text(messageId("a1"))}, ${text(A)}, 0, 0, json_object('type', 'text', 'text', char(1, 1)));`,
      "WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 1999)",
      `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'prt_a' || printf('%05d', i), ${text(messageId("a1"))}, ${text(A)}, 0, 0, json_object('type', 'text', 'text', char(1)) FROM n;`,
    ]);
    const answer = await printed(file, A);
    const rows = JSON.parse(answer) as { kind: string; text: string | null }[];
    expect(rows.filter((row) => row.kind === "text")).toHaveLength(2_000);
    expect(rows.map((row) => (row.text ?? "").replaceAll("u0001", "\u0001")).join("")).toHaveLength(
      6_000,
    );
    expect(Buffer.byteLength(answer)).toBeLessThan(175 * 1024);
    expect(175 * 1024).toBeLessThan(QUESTION_OUTPUT_BYTES);
  });

  test("a part whose start was left out says so, though what is left of it is short once made fit to show", async () => {
    const { file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a1", 2, [["0", said(`Start.${" ".repeat(4_500)}End.`)]]),
    ]);
    expect(await readerOf(file, [A]).ask(A)).toEqual({ message: { text: "End.", cut: true } });
  });

  test("held open with OpenCode's commits only in the -wal: a reply under way shows the one before it, the newest shows once saved, and nothing is written", async () => {
    const { dir, file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(5) }),
      ...prompt(A, "u1", 6, "Tidy the docs."),
      ...step(A, "a1", 5, [["0", said("The first reply.")]]),
    ]);
    const writer = holdOpen(file, await tempDir());
    // A new prompt, and a reply begun: OpenCode writes its text part empty,
    // and saves its words only once the part ends.
    await writer.write([
      ...prompt(A, "u2", 2, "Now the tests."),
      messageRow({
        id: messageId("a2"),
        sessionId: A,
        createdAt: at(1),
        data: assistantData({ createdAt: at(1) }),
      }),
      partRow({
        id: partId("a20"),
        messageId: messageId("a2"),
        sessionId: A,
        createdAt: at(1),
        data: { type: "text", text: "", time: { start: at(1) } },
      }),
    ]);
    const writing = await snapshotOf(dir);
    expect(Object.keys(writing)).toEqual(["opencode.db", "opencode.db-shm", "opencode.db-wal"]);

    const reader = readerOf(file, [A]);
    expect(await reader.ask(A)).toEqual({ message: { text: "The first reply.", cut: false } });
    expect(await snapshotOf(dir)).toEqual(writing);

    await writer.write([
      `UPDATE part SET data = json_set(data, '$.text', 'The second reply.', '$.time.end', ${at(0.5)}) WHERE id = ${text(partId("a20"))};`,
    ]);
    const saved = await snapshotOf(dir);
    expect(await reader.ask(A)).toEqual({ message: { text: "The second reply.", cut: false } });
    expect(await snapshotOf(dir)).toEqual(saved);
    expect(await printed(file, A, "with-wal")).not.toContain("Now the tests.");
    expect(await snapshotOf(dir)).toEqual(saved);

    // OpenCode quits, and leaves its -wal and -shm full with no program holding them.
    await writer.kill();
    const quit = await snapshotOf(dir);
    expect((await lstat(`${file}-wal`)).size).toBeGreaterThan(0);
    expect(await reader.ask(A)).toEqual({ message: { text: "The second reply.", cut: false } });
    expect(await snapshotOf(dir)).toEqual(quit);
  });

  test("an id that is not one OpenCode makes is never asked, and a database that is not there is not found and not made", async () => {
    const { dir, file } = await makeDatabase([
      sessionRow({ id: A, updatedAt: at(1) }),
      ...step(A, "a1", 2, [["0", said("The reply.")]]),
    ]);
    const before = await snapshotOf(dir);
    const messages = createOpencodeLastMessages({
      reader: createDatabaseReader({ file, io: nodeIo, platform: process.platform }),
      database: file,
      later: () => {},
    });
    messages.keep(new Map([["opencode:odd", `${A}' OR 1=1 --`]]));
    await expect(messages.read("opencode:odd")).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });
    expect(await snapshotOf(dir)).toEqual(before);

    const empty = await tempDir();
    const missing = path.join(empty, "opencode.db");
    await expect(readerOf(missing, [A]).ask(A)).resolves.toEqual({
      message: null,
      reason: "not-found",
    });
    expect(await readdir(empty)).toEqual([]);
  });
});
