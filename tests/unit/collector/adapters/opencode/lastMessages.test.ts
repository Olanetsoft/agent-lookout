import { describe, expect, test } from "vitest";

import { createDatabaseReader, QUESTION_OUTPUT_BYTES } from "@collector/adapters/opencode/database";
import {
  answerFrom,
  createOpencodeLastMessages,
  lastTextQuery,
  MESSAGES_LOOKED_AT,
  TEXT_HANDED_BACK,
} from "@collector/adapters/opencode/lastMessages";
import { sqliteArguments } from "@collector/adapters/opencode/sessionRows";
import {
  ANSWER_AGAIN_MS,
  createTailLimits,
  KEEP_MS,
  READS_PER_SECOND,
} from "@collector/messages/tailReader";
import {
  DATABASE,
  lastTextJson,
  NOW,
  sessionId,
  sqliteJson,
} from "@tests/fixtures/opencode/opencode";
import {
  handClock,
  memoryFiles,
  standInSqlite,
  type MemoryFiles,
  type StandInSqlite,
} from "@tests/support/adapters/opencodeAdapter";

const A = sessionId("a1");
const B = sessionId("b2");
const SAID_A = `opencode:${A}`;
const SAID_B = `opencode:${B}`;
const WAL = `${DATABASE}-wal`;
const SHM = `${DATABASE}-shm`;

describe("the question", () => {
  test("names the session by its id alone, once it is an id OpenCode makes", () => {
    const question = lastTextQuery(A) ?? "";
    expect(question.split(`'${A}'`)).toHaveLength(2);
    // Fixed text but for the id: another session's question is the same with its id.
    expect(question.replace(A, B)).toBe(lastTextQuery(B));
  });

  test.each([
    "",
    "ses",
    `${A}'`,
    `ses_x' OR 1=1 --`,
    "ses_x'); DROP TABLE session; --",
    'ses_x"',
    "ses_x\\",
    "ses_a b",
    "ses_a\n",
    "ses_ä",
    "SES_abc",
    "msg_000000000000000000000000a1",
    `ses_${"a".repeat(64)}`,
  ])("is not made for %j, which is not an id OpenCode makes", (id) => {
    expect(lastTextQuery(id)).toBeNull();
  });

  test("asks only for fixed fields of each row's data, never a whole data and never SELECT *", () => {
    const question = lastTextQuery(A) ?? "";
    expect(question).not.toMatch(/SELECT\s+\*/i);
    expect(question).not.toMatch(/\.\*/);
    // Every use of a data column is inside one of SQLite's JSON functions.
    const uses = [...question.matchAll(/(\w+)\(\s*\w+\.data\b(?:,\s*'([^']*)')?/g)];
    const bare = question.match(/\b\w+\.data\b/g) ?? [];
    expect(uses).toHaveLength(bare.length);
    expect(new Set(uses.map(([, fn]) => fn))).toEqual(
      new Set(["json_valid", "json_extract", "json_type"]),
    );
    const paths = new Set(uses.map(([, , field]) => field).filter(Boolean));
    expect(paths).toEqual(
      new Set(["$.role", "$.summary", "$.type", "$.text", "$.synthetic", "$.ignored"]),
    );
    // Each data is read only once json_valid says it is JSON.
    for (const alias of ["m", "p"]) {
      expect(question, alias).toContain(`CASE WHEN json_valid(${alias}.data) THEN`);
    }
  });

  test("reads only $.messageID of the session's revert, once it is JSON, to leave out what /undo took back", () => {
    const question = lastTextQuery(A) ?? "";
    expect(question.match(/\b\w+\.revert\b[^)]*\)/g)).toEqual([
      "s.revert)",
      "s.revert, '$.messageID')",
    ]);
    expect(question).toContain(
      "CASE WHEN json_valid(s.revert) THEN json_extract(s.revert, '$.messageID') END AS undo_from",
    );
    // Compared only with the ids of the session's own messages.
    expect(question.match(/\bundo_from\b/g)).toHaveLength(2);
    expect(question).toContain("c.id = (SELECT undo_from FROM asked)");
    // Both the messages looked through and those counted leave out what it took back.
    expect(
      question.match(/NOT EXISTS \(SELECT 1 FROM undone u WHERE \(m\.time_created, m\.id\) >= /g),
    ).toHaveLength(2);
  });

  test("names no table but session, message and part", () => {
    const question = lastTextQuery(A) ?? "";
    const named = new Set([...question.matchAll(/(\w+) AS \(/g)].map(([, name]) => name));
    expect(named).toEqual(new Set(["asked", "undone", "recent", "reply", "texts", "ends"]));
    const tables = [...question.matchAll(/\bFROM\s+(\w+)/g)]
      .map(([, table]) => table)
      .filter((table) => table !== undefined && !named.has(table));
    expect(new Set(tables)).toEqual(new Set(["session", "message", "part"]));
    expect(question).not.toMatch(/\bJOIN\b/i);
  });

  test("looks through the newest 100 messages, and hands back at most 4,000 characters of the reply", () => {
    const question = lastTextQuery(A) ?? "";
    expect(MESSAGES_LOOKED_AT).toBe(100);
    expect(TEXT_HANDED_BACK).toBe(4_000);
    expect(question).toContain("LIMIT 100)");
    expect(question).toContain("substr(t, -4000)");
    expect(question).toContain("WHERE after < 4000");
  });
});

describe("its answer", () => {
  test("is the reply's text", () => {
    expect(answerFrom(lastTextJson(["The reply."]))).toEqual({
      message: { text: "The reply.", cut: false },
    });
  });

  test("joins the reply's parts with a line break, in OpenCode's order, however they are printed", () => {
    const printed = sqliteJson([
      { kind: "text", parts: null, more: null, n: 2, cut: 0, text: "Second part." },
      { kind: "reply", parts: 2, more: 0, n: null, cut: null, text: null },
      { kind: "text", parts: null, more: null, n: 1, cut: 0, text: "First part." },
    ]);
    expect(answerFrom(printed)).toEqual({
      message: { text: "First part.\nSecond part.", cut: false },
    });
  });

  test("with no reply that says anything, is nothing yet, or too far back when there are older messages", () => {
    expect(answerFrom(lastTextJson([]))).toEqual({ message: null, reason: "nothing-yet" });
    expect(answerFrom(lastTextJson([], { more: true }))).toEqual({
      message: null,
      reason: "too-far-back",
    });
    // Only what cannot be shown.
    expect(answerFrom(lastTextJson(["‏\u0007"]))).toEqual({
      message: null,
      reason: "nothing-yet",
    });
  });

  test("is cut when the question left out a part, or the start of one", () => {
    expect(answerFrom(lastTextJson(["The end."], { parts: 2 }))).toEqual({
      message: { text: "The end.", cut: true },
    });
    expect(answerFrom(lastTextJson(["The end."], { cut: [true] }))).toEqual({
      message: { text: "The end.", cut: true },
    });
  });

  test("keeps the last 2,000 characters of a longer reply", () => {
    const answer = answerFrom(lastTextJson(["a".repeat(3_000), "The end."]));
    expect(answer.message?.cut).toBe(true);
    expect(answer.message?.text).toHaveLength(2_000);
    expect(answer.message?.text.endsWith("a\nThe end.")).toBe(true);
    expect(answer).not.toHaveProperty("tokens");
  });

  test.each([
    ["nothing", ""],
    ["text that is not JSON", "not json"],
    ["a row of another kind", sqliteJson([{ kind: "other" }])],
    ["no reply row", sqliteJson([{ kind: "text", n: 1, cut: 0, text: "Said." }])],
    [
      "two reply rows",
      sqliteJson([
        { kind: "reply", parts: 0, more: 0 },
        { kind: "reply", parts: 0, more: 0 },
      ]),
    ],
    ["a reply with parts and none printed", sqliteJson([{ kind: "reply", parts: 1, more: 0 }])],
    [
      "more parts printed than the reply has",
      sqliteJson([
        { kind: "reply", parts: 1, more: 0 },
        { kind: "text", n: 1, cut: 0, text: "One." },
        { kind: "text", n: 2, cut: 0, text: "Two." },
      ]),
    ],
    [
      "a field of the wrong type",
      sqliteJson([
        { kind: "reply", parts: 1, more: 0 },
        { kind: "text", n: "1", cut: 0, text: "Said." },
      ]),
    ],
    ["a flag that is not 0 or 1", sqliteJson([{ kind: "reply", parts: 0, more: 2 }])],
    [
      "a text that is not text",
      sqliteJson([
        { kind: "reply", parts: 1, more: 0 },
        { kind: "text", n: 1, cut: 0, text: 7 },
      ]),
    ],
  ])("is unreadable for %s, which is not the question's answer", (_name, printed) => {
    expect(answerFrom(printed)).toEqual({ message: null, reason: "unreadable" });
  });
});

/** A reader of last messages over the stand-in files and sqlite3, with A and B listed. */
function setUp(options: { platform?: NodeJS.Platform; files?: MemoryFiles } = {}) {
  const clock = handClock(NOW);
  const files = options.files ?? memoryFiles(clock.now);
  if (options.files === undefined) {
    files.write(DATABASE, "database");
    files.write(WAL, "frames");
    files.write(SHM, "index");
  }
  const sqlite = standInSqlite();
  sqlite.said(A, lastTextJson(["The reply."]));
  sqlite.said(B, lastTextJson(["Another reply."]));
  const reader = createDatabaseReader({
    file: DATABASE,
    io: files.io,
    platform: options.platform ?? "darwin",
    run: sqlite.run,
    find: sqlite.find,
  });
  const limits = createTailLimits();
  const messages = createOpencodeLastMessages({
    reader,
    database: DATABASE,
    now: clock.now,
    limits,
    later: () => {},
  });
  messages.keep(
    new Map([
      [SAID_A, A],
      [SAID_B, B],
    ]),
  );
  return { clock, files, sqlite, messages, limits };
}

const text = (answer: unknown) =>
  (answer as { message: { text: string } | null } | null)?.message?.text;

/** The questions asked, each as the session's id it names. */
const askedFor = (sqlite: StandInSqlite) =>
  sqlite
    .questions()
    .map((run) => [A, B].find((id) => run.args.at(-1) === lastTextQuery(id)) ?? "another");

describe("the reader", () => {
  test("asks only for a listed session, opened as the poll opens the database, with at most 256 KB of what is printed", async () => {
    const { sqlite, messages } = setUp();
    expect(await messages.read(SAID_A)).toEqual({ message: { text: "The reply.", cut: false } });
    expect(sqlite.questions()).toEqual([
      {
        binary: "/usr/bin/sqlite3",
        args: sqliteArguments(DATABASE, "with-wal", lastTextQuery(A) ?? ""),
        // The poll's own timeout, which is runSqlite's.
        timeoutMs: undefined,
        maxOutputBytes: QUESTION_OUTPUT_BYTES,
      },
    ]);
    expect(QUESTION_OUTPUT_BYTES).toBe(256 * 1024);
    expect(sqlite.runs).toHaveLength(1);
  });

  test("an id the last keep did not list, or another agent's, is null, and nothing is looked at", async () => {
    const { files, sqlite, messages } = setUp();
    files.forget();
    await expect(messages.read(`opencode:${sessionId("c3")}`)).resolves.toBeNull();
    await expect(messages.read(`codex:${A}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
    expect(sqlite.runs).toEqual([]);
  });

  test("an id that is not one OpenCode makes is never put into a question", async () => {
    const { files, sqlite, messages } = setUp();
    messages.keep(new Map([[SAID_A, `${A}' OR 1=1 --`]]));
    files.forget();
    await expect(messages.read(SAID_A)).resolves.toEqual({ message: null, reason: "unreadable" });
    expect(sqlite.runs).toEqual([]);
  });

  test("is not asked again while the database and its -wal are unchanged, and is once either changes", async () => {
    const { clock, files, sqlite, messages } = setUp();
    await messages.read(SAID_A);
    clock.advance(ANSWER_AGAIN_MS);
    files.forget();
    expect(text(await messages.read(SAID_A))).toBe("The reply.");
    // Looked at, but not asked.
    expect(files.count("lstat")).toBe(3);
    expect(sqlite.questions()).toHaveLength(1);

    sqlite.said(A, lastTextJson(["A newer reply."]));
    files.append(WAL, "more frames");
    clock.advance(ANSWER_AGAIN_MS);
    expect(text(await messages.read(SAID_A))).toBe("A newer reply.");
    files.rewrite(DATABASE, "moved in");
    sqlite.said(A, lastTextJson(["The newest reply."]));
    clock.advance(ANSWER_AGAIN_MS);
    expect(text(await messages.read(SAID_A))).toBe("The newest reply.");
    expect(askedFor(sqlite)).toEqual([A, A, A]);
  });

  test("with no -wal, opens the database as a file nothing changes", async () => {
    const files = memoryFiles();
    files.write(DATABASE, "database");
    const { sqlite, messages } = setUp({ files });
    expect(text(await messages.read(SAID_A))).toBe("The reply.");
    expect(sqlite.questions().map((run) => run.args.at(-2))).toEqual([
      `file:${DATABASE}?mode=ro&immutable=1`,
    ]);
  });

  test("with no database there, is not found", async () => {
    const files = memoryFiles();
    const { sqlite, messages } = setUp({ files });
    await expect(messages.read(SAID_A)).resolves.toEqual({ message: null, reason: "not-found" });
    expect(sqlite.runs).toEqual([]);
  });

  test("is unreadable, with nothing asked, when the files beside the database are not safe to read, the database is empty, or on Windows", async () => {
    const noShm = setUp();
    noShm.files.remove(SHM);
    const empty = setUp();
    empty.files.write(DATABASE, "");
    const link = setUp();
    link.files.special(DATABASE);
    for (const { messages, sqlite } of [noShm, empty, link]) {
      await expect(messages.read(SAID_A)).resolves.toEqual({
        message: null,
        reason: "unreadable",
      });
      expect(sqlite.runs).toEqual([]);
    }

    const windows = setUp({ platform: "win32" });
    windows.files.forget();
    await expect(windows.messages.read(SAID_A)).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });
    expect(windows.files.calls).toEqual([]);
    expect(windows.sqlite.runs).toEqual([]);
  });

  test("is unreadable when no sqlite3 is found, or sqlite3 fails, as it does when it times out or prints more than its cap", async () => {
    const missing = setUp();
    missing.sqlite.there(false);
    await expect(missing.messages.read(SAID_A)).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });
    expect(missing.sqlite.runs).toEqual([]);

    const failing = setUp();
    failing.sqlite.fail();
    await expect(failing.messages.read(SAID_A)).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });
    // Asked again once its second is up, and read once sqlite3 answers.
    failing.sqlite.fail(false);
    failing.clock.advance(ANSWER_AGAIN_MS);
    expect(text(await failing.messages.read(SAID_A))).toBe("The reply.");

    const throwing = setUp();
    throwing.sqlite.throw();
    await expect(throwing.messages.read(SAID_A)).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });

    const odd = setUp();
    odd.sqlite.said(A, "not json");
    await expect(odd.messages.read(SAID_A)).resolves.toEqual({
      message: null,
      reason: "unreadable",
    });
  });

  test("asks made while sqlite3 has not answered yet share its one run", async () => {
    const { files, sqlite } = setUp();
    let answer: (value: { ok: true; stdout: string }) => void = () => {};
    const slow = createOpencodeLastMessages({
      reader: createDatabaseReader({
        file: DATABASE,
        io: files.io,
        platform: "darwin",
        find: sqlite.find,
        run: (binary, args, timeoutMs, maxOutputBytes) => {
          void sqlite.run(binary, args, timeoutMs, maxOutputBytes);
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      }),
      database: DATABASE,
      now: () => NOW,
      later: () => {},
    });
    slow.keep(new Map([[SAID_A, A]]));
    const first = slow.read(SAID_A);
    const second = slow.read(SAID_A);
    // The files are looked at before sqlite3 is started.
    await new Promise((resolve) => setTimeout(resolve, 0));
    answer({ ok: true, stdout: lastTextJson(["Said slowly."]) });
    expect([text(await first), text(await second)]).toEqual(["Said slowly.", "Said slowly."]);
    expect(sqlite.questions()).toHaveLength(1);
  });

  test("counts each look at the database against the limits every reader shares", async () => {
    const { clock, files, sqlite, messages, limits } = setUp();
    // Three reads of another agent's this second leave one for OpenCode.
    for (let read = 1; read < READS_PER_SECOND; read += 1) expect(limits.mayRead(NOW)).toBe(true);
    expect(text(await messages.read(SAID_A))).toBe("The reply.");
    files.forget();
    await expect(messages.read(SAID_B)).resolves.toBe("busy");
    expect(files.calls).toEqual([]);
    expect(askedFor(sqlite)).toEqual([A]);

    clock.advance(1_000);
    expect(text(await messages.read(SAID_B))).toBe("Another reply.");
    expect(messages.size).toBe(2);
  });

  test("keeps a session's answer at most 15 seconds after its last ask, and none once a poll does not list it", async () => {
    const { clock, messages } = setUp();
    await messages.read(SAID_A);
    await messages.read(SAID_B);
    expect(messages.size).toBe(2);
    clock.advance(KEEP_MS);
    await messages.read(SAID_B);
    expect(messages.size).toBe(1);

    messages.keep(new Map([[SAID_A, A]]));
    expect(messages.size).toBe(0);
    await expect(messages.read(SAID_B)).resolves.toBeNull();
    messages.forget();
    await expect(messages.read(SAID_A)).resolves.toBeNull();
  });
});
