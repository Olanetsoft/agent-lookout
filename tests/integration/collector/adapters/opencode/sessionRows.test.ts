import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { findSqlite, runSqlite } from "@collector/adapters/antigravity/app/summaries";
import { createOpencodeAdapter } from "@collector/adapters/opencode/index";
import {
  BOTH_SESSIONS_QUERY,
  MAX_SESSIONS,
  OPENCODE_2_SESSIONS_QUERY,
  PROBE_QUERY,
  readSchema,
  SESSIONS_QUERY,
  sqliteArguments,
} from "@collector/adapters/opencode/sessionRows";
import type { Session } from "@core/sessions/session";
import {
  assistantData,
  FOLDER,
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
  sessionV2MessageRows,
  sessionV2Row,
  text,
  textData,
  userData,
  V2_SCHEMA,
  type SessionV2Fields,
} from "@tests/fixtures/opencode/opencode";
import { tempDir } from "@tests/support/node/tempFiles";

// The real sqlite3 is run, as the adapter runs it, on a database this test
// writes with that same sqlite3, with its SQL on stdin, laid out as OpenCode
// 1.19.0 lays one out, as OpenCode 2.2.5 lays a fresh one out, or with both, as
// OpenCode 2 leaves one it copied 1.x's sessions in. The clock in the sessions
// query is SQLite's, so the times here are the real time's.

const sqlite = process.platform === "win32" ? null : await findSqlite();

const A = sessionId("a1");
const B = sessionId("b2");
const C = sessionId("c3");
const OTHER_FOLDER = "/Users/example/code/other";

/** The rows of a session of 1.x whose newest step ended the turn at `at`. */
function v1Session(id: string, suffix: string, at: number, title = "Rename the helper"): string[] {
  const user = messageId(`u${suffix}`);
  const reply = messageId(`a${suffix}`);
  return [
    sessionRow({ id, title, createdAt: at - 10 * MINUTE, updatedAt: at }),
    messageRow({ id: user, sessionId: id, createdAt: at - 2 * MINUTE, data: userData(at) }),
    messageRow({
      id: reply,
      sessionId: id,
      createdAt: at - MINUTE,
      updatedAt: at,
      data: assistantData({
        createdAt: at - MINUTE,
        completedAt: at,
        finish: "stop",
        parentId: user,
      }),
    }),
    partRow({
      id: partId(`a${suffix}`),
      messageId: reply,
      sessionId: id,
      createdAt: at,
      data: textData(),
    }),
  ];
}

/** A database in a folder of its own, with these tables and rows, and nothing beside it. */
async function makeDatabase(schema: string, rows: string[]): Promise<string> {
  const dir = path.join(await tempDir(), "opencode");
  const file = path.join(dir, "opencode.db");
  await mkdir(dir, { recursive: true });
  execFileSync(sqlite as string, [file], { input: [schema, ...rows].join("\n") });
  await rm(`${file}-wal`, { force: true });
  await rm(`${file}-shm`, { force: true });
  return file;
}

/** The adapter on that database, with `ps` saying what the test says, and its own settings otherwise. */
function adapterOn(file: string, running = true) {
  return createOpencodeAdapter({
    env: { AGENT_LOOKOUT_OPENCODE_HOME: path.dirname(file) },
    processes: { read: () => Promise.resolve({ ok: true, running }) },
  });
}

/** What the adapter lists there, by OpenCode's id for each. */
async function listed(file: string, running = true): Promise<Map<string, Session>> {
  const { health, sessions } = await adapterOn(file, running).poll();
  expect(health.state, health.detail).toBe("ok");
  return new Map(sessions.map((session) => [session.id.slice("opencode:".length), session]));
}

/** What `sqlite3` prints for a question, as the adapter asks it. */
async function asked(file: string, question: string): Promise<string> {
  const answer = await runSqlite(sqlite as string, sqliteArguments(file, "whole", question));
  if (!answer.ok) throw new Error(`sqlite3 did not answer: ${question}`);
  return answer.stdout;
}

/** The plan SQLite makes for a question. */
function planOf(file: string, question: string): string {
  return execFileSync(sqlite as string, ["-init", "/dev/null", "-batch", file], {
    input: `EXPLAIN QUERY PLAN ${question};`,
    encoding: "utf8",
  });
}

describe.skipIf(sqlite === null)("OpenCode's sessions, with the real sqlite3", () => {
  describe("a database written by OpenCode 1.x alone", () => {
    test("is asked what it was always asked, and prints nothing of OpenCode 2's", async () => {
      const now = Date.now();
      const file = await makeDatabase(SCHEMA, v1Session(A, "1", now - MINUTE));
      expect(readSchema(await asked(file, PROBE_QUERY))).toEqual({ layout: "v1" });
      expect(SESSIONS_QUERY).not.toContain("session_v2");
      const printed = await asked(file, SESSIONS_QUERY);
      for (const word of ["slug", '"v2"', "time_suspended", "time_idle", "idle_outcome"]) {
        expect(printed, word).not.toContain(word);
      }
      const sessions = await listed(file);
      expect([...sessions.keys()]).toEqual([A]);
      expect(sessions.get(A)).toMatchObject({
        name: "Rename the helper",
        cwd: FOLDER,
        status: "idle",
      });
    });
  });

  describe("a database written by OpenCode 2 alone", () => {
    test("has no table of 1.x's, and each root session is listed once, with its name, folder and status", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE, title: "Rename the helper" }),
        sessionV2Row({
          id: B,
          updatedAt: now - 2 * MINUTE,
          title: "Tidy the tests",
          directory: OTHER_FOLDER,
          suspendedAt: now - MINUTE,
        }),
        ...sessionV2MessageRows(A, "1"),
      ]);
      expect(readSchema(await asked(file, PROBE_QUERY))).toEqual({ layout: "v2" });
      const sessions = await listed(file);
      expect([...sessions.keys()]).toEqual([A, B]);
      expect(sessions.get(A)).toMatchObject({
        name: "Rename the helper",
        cwd: FOLDER,
        project: "demo",
        status: "idle",
      });
      expect(sessions.get(B)).toMatchObject({
        name: "Tidy the tests",
        cwd: OTHER_FOLDER,
        project: "other",
        status: "working",
        statusSince: now - MINUTE,
      });
    });

    test("prints nothing the docs do not list, and neither reads nor changes anything else", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE }),
        ...sessionV2MessageRows(A, "1"),
      ]);
      const before = await readFile(file);
      const printed = await asked(file, OPENCODE_2_SESSIONS_QUERY);
      expect(Object.keys((JSON.parse(printed) as Record<string, unknown>[])[0] ?? {})).toEqual([
        "id",
        "directory",
        "title",
        "time_created",
        "time_updated",
        "slug",
        "v2",
        "time_suspended",
        "time_idle",
        "idle_outcome",
      ]);
      expect(printed).not.toContain(PRIVATE_WORDS);
      expect(printed).not.toContain("2000000");
      await listed(file);
      expect(await readdir(path.dirname(file))).toEqual(["opencode.db"]);
      expect((await readFile(file)).equals(before)).toBe(true);
    });

    test("a database from before v2.2.2, with no time_busy, is read the same", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE }),
        "ALTER TABLE session_v2 DROP COLUMN time_busy;",
      ]);
      expect(readSchema(await asked(file, PROBE_QUERY))).toEqual({ layout: "v2" });
      expect((await listed(file)).get(A)?.status).toBe("idle");
    });
  });

  describe("a database written by both", () => {
    const both = `${SCHEMA}\n${V2_SCHEMA}`;

    test("lists each root session once, and the row of session_v2 wins for an id in both", async () => {
      const now = Date.now();
      const file = await makeDatabase(both, [
        // Copied, and carried on by OpenCode 2: its old row still says it is idle.
        ...v1Session(A, "1", now - 30 * MINUTE, "The name 1.x had"),
        sessionV2Row({
          id: A,
          title: "The name 2 has",
          directory: OTHER_FOLDER,
          updatedAt: now - MINUTE,
          suspendedAt: now - MINUTE,
        }),
        // Written by 1.x after the copy, so it is only there.
        ...v1Session(B, "2", now - 3 * MINUTE),
        // Written by 2 alone.
        sessionV2Row({ id: C, title: "New in 2", updatedAt: now - 2 * MINUTE }),
      ]);
      expect(readSchema(await asked(file, PROBE_QUERY))).toEqual({ layout: "both" });
      const printed = JSON.parse(await asked(file, BOTH_SESSIONS_QUERY)) as { id: string }[];
      expect(printed.map((row) => row.id)).toEqual([A, C, B]);
      const sessions = await listed(file);
      expect(sessions.size).toBe(3);
      expect(sessions.get(A)).toMatchObject({
        name: "The name 2 has",
        cwd: OTHER_FOLDER,
        status: "working",
      });
      expect(sessions.get(B)).toMatchObject({ name: "Rename the helper", status: "idle" });
      expect(sessions.get(C)).toMatchObject({ name: "New in 2", status: "idle" });
    });

    test("a session copied and not yet carried on shows what session_v2 says, with none of the 1.x row's counts or status", async () => {
      const now = Date.now();
      const file = await makeDatabase(both, [
        ...v1Session(A, "1", now - 5 * MINUTE),
        sessionV2Row({ id: A, updatedAt: now - 5 * MINUTE }),
      ]);
      const session = (await listed(file)).get(A);
      expect(session).toMatchObject({ status: "idle", statusSince: now - 5 * MINUTE });
      expect(session).not.toHaveProperty("tokens");
    });

    test("a session OpenCode 2 archived, or made a child, stays out, whatever its 1.x row says", async () => {
      const now = Date.now();
      const file = await makeDatabase(both, [
        ...v1Session(A, "1", now - MINUTE),
        sessionV2Row({ id: A, updatedAt: now - MINUTE, archivedAt: now - MINUTE }),
        ...v1Session(B, "2", now - MINUTE),
        sessionV2Row({ id: B, updatedAt: now - MINUTE, parentId: C }),
        sessionV2Row({ id: C, updatedAt: now - MINUTE }),
      ]);
      expect([...(await listed(file)).keys()]).toEqual([C]);
    });

    test("a row of session_v2 too old to ask for keeps its 1.x row out too", async () => {
      const now = Date.now();
      const file = await makeDatabase(both, [
        ...v1Session(A, "1", now - MINUTE),
        sessionV2Row({ id: A, updatedAt: now - 72 * 60 * MINUTE }),
      ]);
      expect((await listed(file)).size).toBe(0);
    });

    test("prints no more than the newest 200 of the two together", async () => {
      const now = Date.now();
      const count = MAX_SESSIONS + 20;
      const rows: string[] = [];
      for (let index = 0; index < count; index += 1) {
        // The two kinds take turns, so the newest 200 are half of each.
        rows.push(
          ...v1Session(sessionId(`o${index}`), `o${index}`, now - (2 * index + 1) * MINUTE),
          sessionV2Row({ id: sessionId(`n${index}`), updatedAt: now - (2 * index + 2) * MINUTE }),
        );
      }
      const file = await makeDatabase(both, rows);
      const printed = JSON.parse(await asked(file, BOTH_SESSIONS_QUERY)) as {
        id: string;
        v2: number | null;
      }[];
      expect(printed).toHaveLength(MAX_SESSIONS);
      expect(printed.filter((row) => row.v2 === 1)).toHaveLength(MAX_SESSIONS / 2);
      expect(printed[0]?.id).toBe(sessionId("o0"));
      expect(printed.at(-1)?.id).toBe(sessionId(`n${MAX_SESSIONS / 2 - 1}`));
    });

    test("the plan finds each row of session_v2 through an index, and each side stops at 200", async () => {
      const file = await makeDatabase(both, []);
      const plan = planOf(file, BOTH_SESSIONS_QUERY);
      // A root session by `session_v2_parent_idx`, and the check of an id in both by its primary key alone.
      expect(plan).toMatch(/SEARCH v USING INDEX session_v2_parent_idx \(parent_id=\?\)/);
      expect(plan).toMatch(/SEARCH w USING COVERING INDEX sqlite_autoindex_session_v2_1 \(id=\?\)/);
      expect(plan).not.toMatch(/SCAN v\b/);
      expect(plan).not.toMatch(/SCAN w\b/);
      expect(BOTH_SESSIONS_QUERY.match(/LIMIT 200/g)).toHaveLength(3);
    });

    test("the plan for a database of OpenCode 2's alone uses the same index", async () => {
      const file = await makeDatabase(V2_SCHEMA, []);
      const plan = planOf(file, OPENCODE_2_SESSIONS_QUERY);
      expect(plan).toMatch(/SEARCH v USING INDEX session_v2_parent_idx \(parent_id=\?\)/);
      expect(plan).not.toMatch(/SCAN v\b/);
    });
  });

  test("a child and an archived row are left out", async () => {
    const now = Date.now();
    const file = await makeDatabase(V2_SCHEMA, [
      sessionV2Row({ id: A, updatedAt: now - MINUTE }),
      sessionV2Row({ id: B, updatedAt: now - MINUTE, parentId: A }),
      sessionV2Row({ id: C, updatedAt: now - MINUTE, archivedAt: now - MINUTE }),
    ]);
    expect([...(await listed(file)).keys()]).toEqual([A]);
  });

  test("a row written more than 48 hours ago is not asked for, and one more than a day ago not listed", async () => {
    const now = Date.now();
    const file = await makeDatabase(V2_SCHEMA, [
      sessionV2Row({ id: A, updatedAt: now - 49 * 60 * MINUTE, idleAt: now - MINUTE }),
      sessionV2Row({ id: B, updatedAt: now - 25 * 60 * MINUTE }),
      sessionV2Row({ id: C, updatedAt: now - 25 * 60 * MINUTE, idleAt: now - MINUTE }),
    ]);
    expect(JSON.parse(await asked(file, OPENCODE_2_SESSIONS_QUERY))).toHaveLength(2);
    expect([...(await listed(file)).keys()]).toEqual([C]);
  });

  test("a row with no title is named by its slug, and a placeholder by its slug too", async () => {
    const now = Date.now();
    const file = await makeDatabase(V2_SCHEMA, [
      sessionV2Row({ id: A, updatedAt: now - MINUTE, title: null, slug: "brave-wolf" }),
      sessionV2Row({
        id: B,
        updatedAt: now - MINUTE,
        title: "New session - 2026-10-01T11:00:00.000Z",
        slug: "calm-otter",
      }),
      sessionV2Row({ id: C, updatedAt: now - MINUTE, title: "   ", slug: "tidy-heron" }),
    ]);
    const sessions = await listed(file);
    expect(sessions.get(A)?.name).toBe("brave-wolf");
    expect(sessions.get(B)?.name).toBe("calm-otter");
    expect(sessions.get(C)?.name).toBe("tidy-heron");
  });

  describe("each turn state", () => {
    const states: [string, (now: number) => Omit<SessionV2Fields, "id">, string, string][] = [
      ["no turn has run, as when just made or copied", () => ({}), "idle", "finished"],
      ["a turn holds its claim", (now) => ({ suspendedAt: now - MINUTE }), "working", "finished"],
      [
        "a turn holds its claim after one that failed",
        (now) => ({ suspendedAt: now - MINUTE, idleAt: now - 2 * MINUTE, outcome: "failed" }),
        "working",
        "finished",
      ],
      [
        "the turn succeeded",
        (now) => ({ idleAt: now - MINUTE, outcome: "succeeded" }),
        "idle",
        "finished",
      ],
      [
        "the turn was interrupted",
        (now) => ({ idleAt: now - MINUTE, outcome: "interrupted" }),
        "idle",
        "finished",
      ],
      [
        "the turn failed",
        (now) => ({ idleAt: now - MINUTE, outcome: "failed" }),
        "failed",
        "failed",
      ],
      [
        "an outcome it does not know",
        (now) => ({ idleAt: now - MINUTE, outcome: "abandoned" }),
        "unknown",
        "unknown",
      ],
    ];

    test.each(states)("%s", async (_name, fields, open, closed) => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE, ...fields(now) }),
      ]);
      expect((await listed(file, true)).get(A)?.status).toBe(open);
      expect((await listed(file, false)).get(A)?.status).toBe(closed);
    });
  });

  describe("rows that are not what is expected", () => {
    test("an id OpenCode does not make is dropped, and every other session is still read", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: "not-a-session", updatedAt: now - MINUTE }),
        sessionV2Row({ id: `ses_${"x".repeat(100)}`, updatedAt: now - MINUTE }),
        sessionV2Row({ id: "ses_with'quote", updatedAt: now - MINUTE }),
        sessionV2Row({ id: A, updatedAt: now - MINUTE }),
      ]);
      expect([...(await listed(file)).keys()]).toEqual([A]);
    });

    test("a time of the wrong type is unknown, and text there is never printed", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE, suspendedAt: PRIVATE_WORDS }),
        sessionV2Row({ id: B, updatedAt: now - MINUTE, idleAt: PRIVATE_WORDS }),
        sessionV2Row({ id: C, updatedAt: now - MINUTE }),
      ]);
      const printed = await asked(file, OPENCODE_2_SESSIONS_QUERY);
      expect(printed).not.toContain(PRIVATE_WORDS);
      const sessions = await listed(file);
      expect(sessions.get(A)?.status).toBe("unknown");
      expect(sessions.get(B)?.status).toBe("unknown");
      expect(sessions.get(C)?.status).toBe("idle");
    });

    test("an outcome too long to be a word is cut inside SQLite, and is unknown", async () => {
      const now = Date.now();
      const long = "x".repeat(100_000);
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE, idleAt: now - MINUTE, outcome: long }),
      ]);
      expect((await asked(file, OPENCODE_2_SESSIONS_QUERY)).length).toBeLessThan(2_000);
      expect((await listed(file)).get(A)?.status).toBe("unknown");
    });

    test("a long title, slug or folder cannot fill the answer", async () => {
      const now = Date.now();
      const long = "x".repeat(100_000);
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({
          id: A,
          updatedAt: now - MINUTE,
          title: long,
          slug: long,
          directory: `/${long}`,
        }),
      ]);
      expect((await asked(file, OPENCODE_2_SESSIONS_QUERY)).length).toBeLessThan(8_000);
      const session = (await listed(file)).get(A);
      expect(session?.cwd).toBeNull();
      expect(session?.status).toBe("idle");
    });

    test("a folder that is empty, as a copied session can have, or not absolute, is none", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE, directory: "" }),
        sessionV2Row({ id: B, updatedAt: now - MINUTE, directory: "code/demo" }),
      ]);
      const sessions = await listed(file);
      expect(sessions.get(A)?.cwd).toBeNull();
      expect(sessions.get(B)?.cwd).toBeNull();
    });

    test("a table of OpenCode 2's with a column gone says the version is not read, and asks no more", async () => {
      const now = Date.now();
      const file = await makeDatabase(V2_SCHEMA, [
        sessionV2Row({ id: A, updatedAt: now - MINUTE }),
        "ALTER TABLE session_v2 DROP COLUMN idle_outcome;",
      ]);
      const { health, sessions } = await adapterOn(file).poll();
      expect(health.state).toBe("error");
      expect(health.detail).toContain("a version of OpenCode that Agent Lookout does not read");
      expect(sessions).toEqual([]);
    });
  });

  test("the last message of a session in both is not read from its old 1.x row", async () => {
    const now = Date.now();
    const file = await makeDatabase(`${SCHEMA}\n${V2_SCHEMA}`, [
      ...v1Session(A, "1", now - MINUTE),
      sessionV2Row({ id: A, updatedAt: now - MINUTE }),
      ...v1Session(B, "2", now - MINUTE),
      `UPDATE part SET data = ${text(JSON.stringify({ type: "text", text: "The newest reply of 1.x." }))} WHERE session_id = ${text(B)};`,
    ]);
    const adapter = adapterOn(file);
    await adapter.poll();
    expect(await adapter.lastMessage(`opencode:${A}`)).toEqual({
      message: null,
      reason: "not-read",
    });
    expect(await adapter.lastMessage(`opencode:${B}`)).toMatchObject({
      message: { text: "The newest reply of 1.x." },
    });
  });

  test("a session OpenCode 2 deleted stays out while the adapter runs, though its 1.x rows are left", async () => {
    const now = Date.now();
    const file = await makeDatabase(`${SCHEMA}\n${V2_SCHEMA}`, [
      ...v1Session(A, "1", now - 3 * MINUTE),
      `UPDATE part SET data = ${text(JSON.stringify({ type: "text", text: "The newest reply of 1.x." }))} WHERE session_id = ${text(A)};`,
      sessionV2Row({ id: A, updatedAt: now - MINUTE }),
    ]);
    const id = `opencode:${A}`;
    const adapter = adapterOn(file);
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([id]);

    // As `SessionEvent.Deleted` does at v2.2.5: the row of session_v2 alone.
    execFileSync(sqlite as string, [file], {
      input: `DELETE FROM session_v2 WHERE id = ${text(A)};`,
    });
    expect(await asked(file, BOTH_SESSIONS_QUERY)).toContain(A);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(await adapter.lastMessage(id)).toBeNull();

    // An adapter that never read it there cannot tell it from a session 1.x made.
    const restarted = adapterOn(file);
    expect((await restarted.poll()).sessions.map((session) => session.id)).toEqual([id]);
    expect(await restarted.lastMessage(id)).toMatchObject({
      message: { text: "The newest reply of 1.x." },
    });
  });

  test("no answer holds a word of what the tables the adapter never reads hold", async () => {
    const now = Date.now();
    const file = await makeDatabase(`${SCHEMA}\n${V2_SCHEMA}`, [
      ...v1Session(A, "1", now - MINUTE),
      sessionV2Row({ id: B, updatedAt: now - MINUTE }),
      ...sessionV2MessageRows(B, "2"),
    ]);
    const printed = await asked(file, BOTH_SESSIONS_QUERY);
    expect(printed).not.toContain(PRIVATE_WORDS);
    expect(printed).not.toContain(SECRET_WORDS);
  });
});
