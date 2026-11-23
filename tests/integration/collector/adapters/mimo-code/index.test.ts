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
  createMimoCodeAdapter,
  MIMO_EXTRAS,
  MIMO_SESSIONS_QUERY,
} from "@collector/adapters/mimo-code/index";
import { QUESTION_OUTPUT_BYTES } from "@collector/adapters/opencode/database";
import { lastTextQuery } from "@collector/adapters/opencode/lastMessages";
import {
  jsonRows,
  probeQueryFor,
  readSchema,
  readSessionRows,
  sqliteArguments,
} from "@collector/adapters/opencode/sessionRows";
import { ANSWER_AGAIN_MS } from "@collector/messages/tailReader";
import {
  actorRow,
  assistantData,
  mainActorRow,
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
} from "@tests/fixtures/mimo-code/mimoCode";
import { tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, with the real sqlite3, on a database this test
// writes with the tables and indexes MiMo Code v0.1.17 makes for what the
// adapter reads, read with the schema not trusted, as every read is. What
// `ps` would say is given: the real `ps` is asked in the OpenCode adapter's
// processes.test.ts, with the same arguments. Where there is no sqlite3, as on
// Windows, there is nothing to run.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const IDLE = sessionId("a1");
const WORKING = sessionId("b2");
const ASKING = sessionId("c3");
const PLANNING = sessionId("d4");
const SUBAGENT_RUNNING = sessionId("e5");
const SUBAGENT_PENDING = sessionId("f6");
const FAILED = sessionId("a7");
const MODEL_FAILED = sessionId("b8");
const PROMPT_TITLE = sessionId("c9");
const NAMED = sessionId("d0");
const CHILD = sessionId("e1");
const ARCHIVED = sessionId("f2");
const FORKED = sessionId("a3");
const RUN_TITLED = sessionId("b4");
const NEW_SESSION = sessionId("c5");

/** The rows of every session the database holds, relative to `now`. */
function rows(now: number): string[] {
  const at = (minutes: number) => now - minutes * MINUTE;
  const prompt = (id: string, suffix: string, minutes: number, agentId?: string) =>
    messageRow({
      id: messageId(suffix),
      sessionId: id,
      createdAt: at(minutes),
      agentId,
      data: userData(at(minutes)),
    });
  /** The main agent's step that ended its turn, `minutes` ago. */
  const ended = (id: string, suffix: string, minutes: number, error?: string) =>
    messageRow({
      id: messageId(suffix),
      sessionId: id,
      createdAt: at(minutes),
      data: assistantData({
        createdAt: at(minutes),
        ...(error === undefined ? { completedAt: at(minutes), finish: "stop" } : { error }),
      }),
    });
  /** A subagent's prompt and its step under way, newer than anything of the main agent's, with a call that runs. */
  const subagent = (id: string, suffix: string, tool = "bash") => [
    prompt(id, `${suffix}su`, 2, "sub_1"),
    messageRow({
      id: messageId(`${suffix}sa`),
      sessionId: id,
      createdAt: at(1),
      agentId: "sub_1",
      data: assistantData({
        createdAt: at(1),
        tokens: { input: 9000, output: 900, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    }),
    partRow({
      id: partId(`${suffix}s1`),
      messageId: messageId(`${suffix}sa`),
      sessionId: id,
      createdAt: at(1),
      data: toolData({ status: "running", tool }),
    }),
  ];
  /** The main agent's step under way, with these tool parts of its own beside a text part. */
  const underWay = (
    id: string,
    suffix: string,
    tools: { tool: string; status: "pending" | "running" | "completed" | "error" }[],
  ) => [
    sessionRow({ id, title: `Session ${suffix}`, createdAt: at(30), updatedAt: at(2) }),
    mainActorRow(id, at(1)),
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
  // Every session has a row of `actor_registry` for its main agent, which
  // MiMo Code makes `pending` with the session and its turns leave so, written
  // as the main agent last wrote.
  return [
    // Idle: its main agent's last step ended the turn, with token counts. A
    // subagent wrote after it, asked a question and is done: none of its
    // messages decides the status or the counts.
    sessionRow({ id: IDLE, title: "Rename the helper", createdAt: at(30), updatedAt: at(5) }),
    mainActorRow(IDLE, at(5)),
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
    ...subagent(IDLE, "a1", "question"),
    actorRow({ sessionId: IDLE, actorId: "sub_1", status: "idle", updatedAt: at(1) }),
    // A step of the main agent's that runs the shell.
    ...underWay(WORKING, "b2", [{ tool: "bash", status: "running" }]),
    // A question that waits for you.
    ...underWay(ASKING, "c3", [{ tool: "question", status: "running" }]),
    // A plan that waits for your approval.
    ...underWay(PLANNING, "d4", [{ tool: "plan_exit", status: "running" }]),
    // The main agent's turn is over, and its subagent still runs.
    sessionRow({ id: SUBAGENT_RUNNING, createdAt: at(30), updatedAt: at(5) }),
    mainActorRow(SUBAGENT_RUNNING, at(5)),
    prompt(SUBAGENT_RUNNING, "e5u", 6),
    ended(SUBAGENT_RUNNING, "e5a", 5),
    ...subagent(SUBAGENT_RUNNING, "e5"),
    actorRow({
      sessionId: SUBAGENT_RUNNING,
      actorId: "sub_1",
      status: "running",
      updatedAt: at(2),
      lastActivityAt: at(1),
    }),
    // One whose subagent is still to start.
    sessionRow({ id: SUBAGENT_PENDING, createdAt: at(30), updatedAt: at(5) }),
    mainActorRow(SUBAGENT_PENDING, at(5)),
    prompt(SUBAGENT_PENDING, "f6u", 6),
    ended(SUBAGENT_PENDING, "f6a", 5),
    actorRow({
      sessionId: SUBAGENT_PENDING,
      actorId: "sub_1",
      status: "pending",
      updatedAt: at(4),
    }),
    // Failed: its main agent's reply ended on an error, one of OpenCode's and one of MiMo Code's own.
    sessionRow({ id: FAILED, title: "Write the notes", createdAt: at(40), updatedAt: at(10) }),
    mainActorRow(FAILED, at(10)),
    ended(FAILED, "a7a", 10, "APIError"),
    sessionRow({ id: MODEL_FAILED, createdAt: at(40), updatedAt: at(10) }),
    mainActorRow(MODEL_FAILED, at(10)),
    ended(MODEL_FAILED, "b8a", 10, "ModelError"),
    // A title MiMo Code took from the first line of the prompt, before a model named the session.
    sessionRow({
      id: PROMPT_TITLE,
      title: PRIVATE_WORDS,
      titleSource: "fallback",
      createdAt: at(20),
      updatedAt: at(8),
    }),
    mainActorRow(PROMPT_TITLE, at(8)),
    ended(PROMPT_TITLE, "c9a", 8),
    // A title the person renamed the session to, after MiMo Code's first one.
    sessionRow({
      id: NAMED,
      title: "Tidy the tests",
      titleSource: "user",
      titleRevision: 2,
      createdAt: at(20),
      updatedAt: at(8),
    }),
    mainActorRow(NAMED, at(8)),
    ended(NAMED, "d0a", 8),
    // A fork of a session MiMo Code had not named yet: a root session whose
    // title is the first line of the prompt, copied and marked as the person's.
    sessionRow({
      id: FORKED,
      title: `${PRIVATE_WORDS} (fork #1)`,
      titleSource: "user",
      titleRevision: 0,
      createdAt: at(20),
      updatedAt: at(7),
    }),
    mainActorRow(FORKED, at(7)),
    ended(FORKED, "a3a", 7),
    // A title given as the session was made, as `mimo run --title` gives the
    // start of the prompt.
    sessionRow({
      id: RUN_TITLED,
      title: PRIVATE_WORDS,
      titleSource: "user",
      titleRevision: 0,
      createdAt: at(20),
      updatedAt: at(7),
    }),
    mainActorRow(RUN_TITLED, at(7)),
    ended(RUN_TITLED, "b4a", 7),
    // A new session, with nothing but its main agent's row.
    sessionRow({
      id: NEW_SESSION,
      title: "Untitled",
      titleSource: "fallback",
      titleRevision: 0,
      createdAt: at(4),
    }),
    mainActorRow(NEW_SESSION, at(4)),
    // A session of its own for a subagent, and an archived one, are left out.
    sessionRow({ id: CHILD, title: "Look around", parentId: IDLE, updatedAt: at(3) }),
    mainActorRow(CHILD, at(3)),
    sessionRow({ id: ARCHIVED, title: "Old work", archivedAt: at(3), updatedAt: at(3) }),
    mainActorRow(ARCHIVED, at(3)),
  ];
}

/** The tables of a MiMo Code from before it kept its subagents in `actor_registry`. */
const WITHOUT_ACTORS = SCHEMA.replace(/CREATE TABLE actor_registry \([^;]*\);/, "").replaceAll(
  /CREATE INDEX actor_registry_[^;]*;/g,
  "",
);

/** The tables of a MiMo Code whose `session` has no `title_revision`. */
const WITHOUT_TITLE_REVISION = SCHEMA.replace("title_revision integer DEFAULT 0 NOT NULL, ", "");

/**
 * MiMo Code's data folder, `data` in a home of the test's own, with a closed
 * database of these rows. Without `actor_registry`, its rows are left out, and
 * without `title_revision`, the sessions' rows.
 */
async function makeHome(now: number, schema = SCHEMA): Promise<{ home: string; file: string }> {
  const home = await tempDir();
  const data = path.join(home, "data");
  await mkdir(data);
  const file = path.join(data, "mimocode.db");
  const written = rows(now).filter(
    (row) =>
      (schema.includes("actor_registry") || !row.startsWith("INSERT INTO actor_registry")) &&
      (schema.includes("title_revision") || !row.startsWith("INSERT INTO session ")),
  );
  // On stdin, since Linux takes no argument longer than 128 KB.
  execFileSync(sqlite as string, ["-bail", "-init", "/dev/null", file], {
    input: [schema, ...written].join("\n"),
    stdio: ["pipe", "ignore", "ignore"],
  });
  return { home, file };
}

/** What the real sqlite3 prints for one fixed question, asked as the adapter asks it. */
async function ask(file: string, question: string): Promise<string> {
  const answer = await runSqlite(sqlite as string, sqliteArguments(file, "whole", question));
  if (!answer.ok) throw new Error("sqlite3 did not answer.");
  return answer.stdout;
}

// This test decides whether MiMo Code's database may be read at all, so in CI,
// on macOS and Linux, it must not be skipped for want of a sqlite3. Elsewhere,
// as on a machine with sqlite3 in none of its fixed places, it is skipped.
test.runIf(Boolean(process.env.CI) && process.platform !== "win32")(
  "sqlite3 is at one of its fixed places, so the tests below run",
  () => {
    expect(sqlite).not.toBeNull();
  },
);

describe.skipIf(sqlite === null)("the MiMo Code adapter, with the real sqlite3", () => {
  test("lists each root session with its name, folder and status, from mimocode.db in MiMo Code's home", async () => {
    const now = Date.now();
    const { home } = await makeHome(now);
    const adapter = createMimoCodeAdapter({
      env: { MIMOCODE_HOME: home },
      homeDir: "/Users/example",
      now: () => now,
      processes: { read: async () => ({ ok: true, running: true }) },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toMatch(/^Sessions are read from MiMo Code's database, /);
    expect(basis).toBe(BASIS);
    expect(Object.fromEntries(sessions.map((session) => [session.id, session.status]))).toEqual({
      [`mimo-code:${IDLE}`]: "idle",
      [`mimo-code:${WORKING}`]: "working",
      [`mimo-code:${ASKING}`]: "needs-you",
      [`mimo-code:${PLANNING}`]: "needs-you",
      [`mimo-code:${SUBAGENT_RUNNING}`]: "working",
      [`mimo-code:${SUBAGENT_PENDING}`]: "working",
      [`mimo-code:${FAILED}`]: "failed",
      [`mimo-code:${MODEL_FAILED}`]: "failed",
      [`mimo-code:${PROMPT_TITLE}`]: "idle",
      [`mimo-code:${NAMED}`]: "idle",
      [`mimo-code:${FORKED}`]: "idle",
      [`mimo-code:${RUN_TITLED}`]: "idle",
      [`mimo-code:${NEW_SESSION}`]: "idle",
    });
    const named = Object.fromEntries(sessions.map((session) => [session.id, session.name]));
    expect(named[`mimo-code:${IDLE}`]).toBe("Rename the helper");
    expect(named[`mimo-code:${NAMED}`]).toBe("Tidy the tests");
    // A title from the prompt is never read, nor one marked the person's
    // before a rename, so the folder names the session.
    expect(named[`mimo-code:${PROMPT_TITLE}`]).toBe("demo");
    expect(named[`mimo-code:${FORKED}`]).toBe("demo");
    expect(named[`mimo-code:${RUN_TITLED}`]).toBe("demo");
    expect(named[`mimo-code:${NEW_SESSION}`]).toBe("demo");
    const idle = sessions.find((session) => session.id === `mimo-code:${IDLE}`);
    expect(idle).toMatchObject({
      source: "mimo-code",
      cwd: "/Users/example/code/demo",
      // The main agent's reply's, never the subagent's after it.
      tokens: { input: 2400, cached: 1800, output: 120 },
    });
    expect(sessions.find((session) => session.status === "needs-you")?.waitingReason).toBe(
      "question",
    );
    // Working since the main agent's prompt, not the subagent's.
    const running = sessions.find((session) => session.id === `mimo-code:${SUBAGENT_RUNNING}`);
    expect(running?.statusSince).toBe(now - 6 * MINUTE);
    const said = JSON.stringify({ health, sessions });
    expect(said).not.toContain(SECRET_WORDS);
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain("OpenCode");
  });

  test("the probe takes its tables for a layout it reads, and nothing written or secret is printed", async () => {
    const { file } = await makeHome(Date.now());
    const probe = probeQueryFor(MIMO_EXTRAS);
    // Every read is asked with the schema not trusted.
    expect(sqliteArguments(file, "whole", probe)).toContain(TRUSTED_SCHEMA_OFF);
    expect(readSchema(await ask(file, probe), { v2: false, extras: MIMO_EXTRAS })).toEqual({
      layout: "v1",
    });
    const printed = await ask(file, MIMO_SESSIONS_QUERY);
    expect(
      readSessionRows(printed)
        ?.map((row) => row.id)
        .sort(),
    ).toEqual(
      [
        IDLE,
        WORKING,
        ASKING,
        PLANNING,
        SUBAGENT_RUNNING,
        SUBAGENT_PENDING,
        FAILED,
        MODEL_FAILED,
        PROMPT_TITLE,
        NAMED,
        FORKED,
        RUN_TITLED,
        NEW_SESSION,
      ].sort(),
    );
    const read = readSessionRows(printed) ?? [];
    const of = (id: string) => read.find((row) => row.id === id);
    // Only a subagent's row is counted, never the main agent's own.
    for (const row of read) {
      const working = row.id === SUBAGENT_RUNNING || row.id === SUBAGENT_PENDING;
      expect(row.subagentsAt === null, row.id).toBe(!working);
    }
    expect(of(SUBAGENT_RUNNING)?.subagentsAt).toBeGreaterThan(0);
    expect(of(PROMPT_TITLE)?.title).toBeNull();
    expect(of(FORKED)?.title).toBeNull();
    expect(of(RUN_TITLED)?.title).toBeNull();
    expect(of(NAMED)?.title).toBe("Tidy the tests");
    // Nothing of the tables that hold secrets, and no text written, is printed.
    expect(printed).not.toContain(SECRET_WORDS);
    expect(printed).not.toContain(PRIVATE_WORDS);
  });

  test("the main agent's own row, pending while MiMo Code runs, keeps a session idle once its turn ended", async () => {
    const now = Date.now();
    const { file, home } = await makeHome(now);
    // Each session has one, pending.
    expect(
      jsonRows(
        await ask(
          file,
          "SELECT count(*) AS n FROM actor_registry WHERE mode = 'main' AND status = 'pending'",
        ),
      ),
    ).toEqual([{ n: 15 }]);
    const adapter = createMimoCodeAdapter({
      env: { MIMOCODE_HOME: home },
      homeDir: "/Users/example",
      now: () => now,
      processes: { read: async () => ({ ok: true, running: true }) },
    });
    const { sessions } = await adapter.poll();
    const status = (id: string) =>
      sessions.find((session) => session.id === `mimo-code:${id}`)?.status;
    // The main step ended with finish stop, and a subagent of it is done.
    expect(status(IDLE)).toBe("idle");
    // A new session with nothing but its main agent's row.
    expect(status(NEW_SESSION)).toBe("idle");
    // A subagent at work still makes a session working.
    expect(status(SUBAGENT_PENDING)).toBe("working");
  });

  test("a database from before MiMo Code kept subagents in actor_registry is a version it does not read, and lists nothing", async () => {
    const now = Date.now();
    const { file, home } = await makeHome(now, WITHOUT_ACTORS);
    expect(
      jsonRows(await ask(file, "SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'actor%'")),
    ).toEqual([{ n: 0 }]);
    const adapter = createMimoCodeAdapter({
      env: { AGENT_LOOKOUT_MIMO_CODE_HOME: path.join(home, "data") },
      homeDir: "/Users/example",
      now: () => now,
      processes: { read: async () => ({ ok: true, running: true }) },
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(health.detail).toMatch(
      /is laid out as a version of MiMo Code that Agent Lookout does not read\.$/,
    );
    expect(sessions).toEqual([]);
  });

  test("a database whose sessions have no title_revision is a version it does not read", async () => {
    const now = Date.now();
    const { file, home } = await makeHome(now, WITHOUT_TITLE_REVISION);
    const probe = probeQueryFor(MIMO_EXTRAS);
    expect(readSchema(await ask(file, probe), { v2: false, extras: MIMO_EXTRAS })).toEqual({
      layout: "unsupported",
    });
    const adapter = createMimoCodeAdapter({
      env: { AGENT_LOOKOUT_MIMO_CODE_HOME: path.join(home, "data") },
      homeDir: "/Users/example",
      now: () => now,
      processes: { read: async () => ({ ok: true, running: true }) },
    });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("error");
    expect(sessions).toEqual([]);
  });
});

// What a session last said, the main agent's newest reply, asked with
// OpenCode's question of a database laid out as MiMo Code v0.1.17 lays it
// out, through the adapter MiMo Code's profile makes.

/** A text part's data, saying these words, with any marks MiMo Code gives it. */
function said(words: string, marks: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: "text", text: words, time: { start: 0, end: 0 }, ...marks };
}

/** MiMo Code's data folder with a database of these rows alone, in WAL mode, and nothing beside it. */
async function makeMimoDatabase(rows: string[]): Promise<{ dir: string; file: string }> {
  const dir = path.join(await tempDir(), "mimocode");
  const file = path.join(dir, "mimocode.db");
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

/** MiMo Code's adapter over that folder, polled once, and what it answers for a session, a second apart. */
async function mimoReading(dir: string) {
  let at = Date.now();
  const adapter = createMimoCodeAdapter({
    env: { AGENT_LOOKOUT_MIMO_CODE_HOME: dir },
    homeDir: "/Users/example",
    now: () => at,
    processes: { read: async () => ({ ok: true, running: true }) },
  });
  const { sessions } = await adapter.poll();
  return {
    listed: sessions.map((session) => session.id),
    async ask(id: string) {
      at += ANSWER_AGAIN_MS;
      return adapter.lastMessage(`mimo-code:${id}`);
    },
  };
}

/** What sqlite3 prints for MiMo Code's question of this session's last text, asked as the adapter asks it. */
async function printed(file: string, id: string): Promise<string> {
  const answer = await runSqlite(
    sqlite as string,
    sqliteArguments(file, "whole", lastTextQuery(id, MIMO_EXTRAS) ?? ""),
    undefined,
    QUESTION_OUTPUT_BYTES,
  );
  if (!answer.ok) throw new Error("sqlite3 did not answer.");
  return answer.stdout;
}

describe.skipIf(sqlite === null)(
  "what a MiMo Code session last said, with the real sqlite3",
  () => {
    const ROOT = sessionId("f1");
    const OTHER = sessionId("f2");
    const PEER = sessionId("f3");
    const THIRD = sessionId("f4");
    const now = Date.now();
    const at = (minutes: number) => now - minutes * MINUTE;
    /** A prompt, the person's to the main agent or the main agent's to a subagent, with one text part of these words. */
    const prompt = (
      session: string,
      suffix: string,
      minutes: number,
      words: string,
      agentId?: string,
    ) => [
      messageRow({
        id: messageId(suffix),
        sessionId: session,
        createdAt: at(minutes),
        agentId,
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
    /** A step of a reply that ended, the main agent's unless `agentId` names a subagent, with these parts, each `[id suffix, data]`. */
    const step = (
      session: string,
      suffix: string,
      minutes: number,
      parts: [string, Record<string, unknown>][],
      options: { agentId?: string; marks?: Record<string, unknown> } = {},
    ) => [
      messageRow({
        id: messageId(suffix),
        sessionId: session,
        createdAt: at(minutes),
        agentId: options.agentId,
        data: {
          ...assistantData({ createdAt: at(minutes), completedAt: at(minutes), finish: "stop" }),
          ...options.marks,
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
    const toolSteps = (
      session: string,
      letter: string,
      count: number,
      from: number,
      agentId?: string,
    ) =>
      Array.from({ length: count }, (_, index) =>
        step(
          session,
          `${letter}${index + 10}`,
          from - index * 0.1,
          [["0", toolData({ status: "completed" })]],
          { agentId },
        ),
      ).flat();

    test("is the main agent's newest reply, never a subagent's newer one in the same session, and no file is made or changed", async () => {
      const { dir, file } = await makeMimoDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        mainActorRow(ROOT, at(1)),
        actorRow({ sessionId: ROOT, actorId: "sub_1", status: "idle", updatedAt: at(2) }),
        ...prompt(ROOT, "u1", 10, "Words of the prompt."),
        ...step(ROOT, "a1", 9, [
          ["2", said("Second part.")],
          ["0", { type: "reasoning", text: "Thinking it over.", time: { start: at(9) } }],
          ["1", said("First part.")],
          // A notice MiMo Code writes for itself.
          ["3", said("Memory writes are off.", { synthetic: true, ignored: true })],
        ]),
        // The main agent hands work to a subagent, which replies in the same session, later.
        ...step(ROOT, "a2", 8, [["0", toolData({ status: "completed", tool: "actor" })]]),
        ...prompt(ROOT, "s1", 7, "Look into the tests.", "sub_1"),
        ...step(ROOT, "s2", 6, [["0", said("What the subagent said.")]], { agentId: "sub_1" }),
        // A compaction's summary, for the main agent.
        ...step(ROOT, "a3", 5, [["0", said("The summary of the session.")]], {
          marks: { summary: true, mode: "compaction", agent: "compaction" },
        }),
      ]);
      const before = await snapshotOf(dir);
      expect(Object.keys(before)).toEqual(["mimocode.db"]);

      const reading = await mimoReading(dir);
      expect(reading.listed).toEqual([`mimo-code:${ROOT}`]);
      expect(await reading.ask(ROOT)).toEqual({
        message: { text: "First part.\nSecond part.", cut: false },
      });
      expect(await snapshotOf(dir)).toEqual(before);

      const answer = await printed(file, ROOT);
      for (const words of [
        "Words of the prompt.",
        "Thinking it over.",
        "Memory writes are off.",
        "Look into the tests.",
        "What the subagent said.",
        "sub_1",
        "The summary of the session.",
        // The fixture's revert names no message, and is never printed.
        PRIVATE_WORDS,
        SECRET_WORDS,
      ]) {
        expect(answer).not.toContain(words);
      }
      expect(await snapshotOf(dir)).toEqual(before);
    });

    test("the newest 100 messages looked through, and those counted, are the main agent's alone", async () => {
      const { dir } = await makeMimoDatabase([
        // A main reply and 99 main steps that only call tools, then 50 of a
        // subagent's: the reply is the oldest of the main agent's newest 100.
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...step(ROOT, "r1", 300, [["0", said("Just in reach.")]]),
        ...toolSteps(ROOT, "ra", 99, 200),
        ...toolSteps(ROOT, "rb", 50, 50, "sub_1"),
        // 100 main prompts, and 50 of a subagent's: no more than 100 are the main agent's.
        sessionRow({ id: OTHER, updatedAt: at(1) }),
        ...Array.from({ length: 100 }, (_, index) =>
          prompt(OTHER, `o${index + 10}`, 200 - index * 0.5, "Tidy the docs."),
        ).flat(),
        ...toolSteps(OTHER, "ob", 50, 50, "sub_1"),
        // A main reply, then 100 main steps that only call tools.
        sessionRow({ id: THIRD, updatedAt: at(1) }),
        ...step(THIRD, "t1", 300, [["0", said("Long ago.")]]),
        ...toolSteps(THIRD, "ta", 100, 200),
      ]);
      const reading = await mimoReading(dir);
      expect(await reading.ask(ROOT)).toEqual({ message: { text: "Just in reach.", cut: false } });
      expect(await reading.ask(OTHER)).toEqual({ message: null, reason: "nothing-yet" });
      expect(await reading.ask(THIRD)).toEqual({ message: null, reason: "too-far-back" });
    });

    test("after /undo, which can name a subagent's prompt, the main agent's reply before it shows, and nothing of revert is printed", async () => {
      const { dir, file } = await makeMimoDatabase([
        // /undo went back to the subagent's prompt, the newest prompt of the session.
        sessionRow({ id: ROOT, updatedAt: at(1), undoneFrom: messageId("s1") }),
        ...prompt(ROOT, "u1", 10, "Tidy the docs."),
        ...step(ROOT, "a1", 9, [["0", said("Earlier reply.")]]),
        ...prompt(ROOT, "s1", 8, "Clear out the old files.", "sub_1"),
        ...step(ROOT, "s2", 7, [["0", said("The subagent's reply.")]], { agentId: "sub_1" }),
        ...step(ROOT, "a2", 6, [["0", said("I deleted the migrations folder.")]]),
        // /undo went back to the main agent's prompt.
        sessionRow({ id: OTHER, updatedAt: at(1), undoneFrom: messageId("v8") }),
        ...prompt(OTHER, "v1", 10, "Tidy the docs."),
        ...step(OTHER, "v2", 9, [["0", said("Earlier reply.")]]),
        ...prompt(OTHER, "v8", 8, "Clear out the old files."),
        ...step(OTHER, "v0", 7, [["0", said("I deleted the migrations folder.")]]),
      ]);
      const reading = await mimoReading(dir);
      expect(await reading.ask(ROOT)).toEqual({ message: { text: "Earlier reply.", cut: false } });
      expect(await reading.ask(OTHER)).toEqual({ message: { text: "Earlier reply.", cut: false } });
      for (const id of [ROOT, OTHER]) {
        const answer = await printed(file, id);
        for (const words of [
          "I deleted the migrations folder.",
          "The subagent's reply.",
          messageId("s1"),
          messageId("v8"),
          "demo-snapshot",
          PRIVATE_WORDS,
        ]) {
          expect(answer).not.toContain(words);
        }
      }
    });

    test("a peer's child session is never read as its parent's or as one of its own, and another session's text never shows", async () => {
      const { dir, file } = await makeMimoDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...prompt(ROOT, "u1", 10, "Look into it."),
        ...step(ROOT, "a1", 9, [["0", said("The parent's reply.")]]),
        // A peer works in a child session, whose turns run under its own id.
        sessionRow({ id: PEER, parentId: ROOT, updatedAt: at(2) }),
        ...prompt(PEER, "c1", 4, "Look into it.", PEER),
        ...step(PEER, "c2", 2, [["0", said("What the peer said.")]], { agentId: PEER }),
        ...step(PEER, "c3", 1, [["0", said("The peer's main words.")]]),
        // Another root session, written last.
        sessionRow({ id: OTHER, updatedAt: at(1) }),
        ...step(OTHER, "b1", 1, [["0", said("Another session's reply.")]]),
      ]);
      const reading = await mimoReading(dir);
      expect(reading.listed.sort()).toEqual([`mimo-code:${ROOT}`, `mimo-code:${OTHER}`].sort());
      expect(await reading.ask(ROOT)).toEqual({
        message: { text: "The parent's reply.", cut: false },
      });
      expect(await reading.ask(OTHER)).toEqual({
        message: { text: "Another session's reply.", cut: false },
      });
      expect(await reading.ask(PEER)).toBeNull();
      expect(JSON.parse(await printed(file, PEER))).toEqual([
        { kind: "reply", parts: 0, more: 0, n: null, cut: null, text: null },
      ]);
      const answer = await printed(file, ROOT);
      for (const words of [
        "What the peer said.",
        "The peer's main words.",
        "Another session's reply.",
      ]) {
        expect(answer).not.toContain(words);
      }
    });

    test("what sqlite3 prints stays far under 256 KB, however long the reply", async () => {
      const { dir, file } = await makeMimoDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...step(ROOT, "g1", 2, []),
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)",
        `INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) SELECT 'prt_g' || printf('%05d', i), ${text(messageId("g1"))}, ${text(ROOT)}, 0, 0, json_object('type', 'text', 'text', 'y') FROM n;`,
      ]);
      const many = await (await mimoReading(dir)).ask(ROOT);
      expect(many).toMatchObject({ message: { cut: true } });
      expect((many as { message: { text: string } }).message.text).toMatch(/^(y\n)+y$/);
      expect(Buffer.byteLength(await printed(file, ROOT))).toBeLessThan(QUESTION_OUTPUT_BYTES);
      expect(QUESTION_OUTPUT_BYTES).toBe(256 * 1024);
    });

    test("with either setting off, it is off, by that setting", async () => {
      const { dir } = await makeMimoDatabase([
        sessionRow({ id: ROOT, updatedAt: at(1) }),
        ...step(ROOT, "a1", 2, [["0", said("The reply.")]]),
      ]);
      for (const [setting, value] of [
        ["AGENT_LOOKOUT_LAST_MESSAGE", "off"],
        ["AGENT_LOOKOUT_WAITING_TEXT", "off"],
      ] as const) {
        const adapter = createMimoCodeAdapter({
          env: { AGENT_LOOKOUT_MIMO_CODE_HOME: dir, [setting]: value },
          homeDir: "/Users/example",
          processes: { read: async () => ({ ok: true, running: true }) },
        });
        expect((await adapter.poll()).sessions).toHaveLength(1);
        await expect(adapter.lastMessage(`mimo-code:${ROOT}`)).resolves.toEqual({
          message: null,
          reason: "off",
          setting,
        });
      }
    });
  },
);
