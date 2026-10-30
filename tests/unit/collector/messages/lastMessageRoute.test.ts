import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { MAX_SESSION_ID_LENGTH } from "@collector/jumpRoute";
import { createLastMessageRoute, idIn } from "@collector/messages/lastMessageRoute";
import { createTailLimits, MAX_KEPT, READS_PER_SECOND } from "@collector/messages/tailReader";
import { LAST_MESSAGE_PATH, type LastMessageResponse } from "@core/api";
import type { Session, SourceId } from "@core/sessions/session";
import {
  AGY_HOME,
  APP_HOME,
  conversationId,
  HOUR,
  MINUTE,
  NOW as AGY_NOW,
  replyStep,
  summariesPath,
  textStep,
  transcriptPath,
} from "@tests/fixtures/antigravity";
import { makeSession } from "@tests/fixtures/session";
import {
  antigravityAdapterFor,
  antigravityAppAdapterFor,
  handClock,
  memoryFiles,
  standInHub,
  standInProcesses,
  standInSqlite,
} from "@tests/support/adapters/antigravityAdapter";

const T0 = 1_700_000_000_000;

const claude = makeSession({ id: "claude-code:00000000-0000-4000-8000-000000000001" });
const codex = makeSession({ id: "codex:00000000-0000-4000-8000-000000000002", source: "codex" });
const gemini = makeSession({ id: "gemini-cli:demo-conversation", source: "gemini-cli" });
const statusFile = makeSession({ id: "status-files:demo-agent", source: "status-files" });
const remote = makeSession({
  id: "remote:devbox:claude-code:00000000-0000-4000-8000-000000000003",
  source: "remote:devbox",
  machine: "devbox",
});
const listed: Session[] = [claude, codex, gemini, statusFile, remote];

const SAID: LastMessageResponse = { message: { text: "The tests pass.", cut: false } };

/**
 * The route over a list of sessions, with a Claude Code and a Codex adapter
 * that answer as they are told and write down every id they are asked for,
 * and adapters for the other sources that read nothing.
 */
function setUp(env: NodeJS.ProcessEnv = {}, said: LastMessageResponse | "busy" | null = SAID) {
  const asked: string[] = [];
  const reading = (id: SourceId): Pick<Adapter, "id" | "lastMessage"> => ({
    id,
    lastMessage: async (sessionId) => {
      asked.push(sessionId);
      return said;
    },
  });
  const route = createLastMessageRoute({
    env,
    poller: { getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: listed }) },
    adapters: [
      reading("claude-code"),
      reading("codex"),
      { id: "gemini-cli" },
      { id: "status-files" },
    ],
  });
  const ask = (query: string, headers: IncomingMessage["headers"] = {}) =>
    route({ headers }, new URL(`http://localhost${LAST_MESSAGE_PATH}${query}`));
  return { ask, asked };
}

const forId = (id: string) => `?id=${encodeURIComponent(id)}`;

describe("idIn", () => {
  test("takes one id of 1 to 300 characters and nothing else", () => {
    const query = (text: string) => new URLSearchParams(text);
    expect(idIn(query(`id=${encodeURIComponent(claude.id)}`))).toBe(claude.id);
    expect(idIn(query(`id=${"a".repeat(MAX_SESSION_ID_LENGTH)}`))).toHaveLength(300);
    for (const text of [
      "",
      "id=",
      "id",
      `id=${"a".repeat(MAX_SESSION_ID_LENGTH + 1)}`,
      "id=a&id=b",
      "id=a&more=1",
      "more=1&id=a",
      "ID=a",
      "sessionId=a",
    ]) {
      expect(idIn(query(text)), text).toBeNull();
    }
  });
});

describe("GET /api/sessions/last-message", () => {
  test("gives what the session's own adapter read, asked by its id", async () => {
    const { ask, asked } = setUp();
    await expect(ask(forId(claude.id))).resolves.toEqual({ status: 200, body: SAID });
    await expect(
      ask(forId(claude.id), { "sec-fetch-site": "same-origin", origin: "http://localhost:4777" }),
    ).resolves.toEqual({ status: 200, body: SAID });
    await expect(ask(forId(codex.id))).resolves.toEqual({ status: 200, body: SAID });
    expect(asked).toEqual([claude.id, claude.id, codex.id]);
  });

  test("a request a browser marks as anything but same-origin is refused before anything is looked up", async () => {
    const { ask, asked } = setUp();
    for (const site of ["same-site", "cross-site", "none"]) {
      const answer = await ask(forId(claude.id), { "sec-fetch-site": site });
      expect([site, answer.status]).toEqual([site, 403]);
      expect(JSON.stringify(answer.body)).not.toContain("The tests pass");
    }
    expect(asked).toEqual([]);
  });

  test("a query that is not one id and nothing else is a 400", async () => {
    const { ask, asked } = setUp();
    for (const query of [
      "",
      "?id=",
      `${forId(claude.id)}&id=${encodeURIComponent(codex.id)}`,
      `${forId(claude.id)}&path=/etc/passwd`,
      `?id=${"a".repeat(MAX_SESSION_ID_LENGTH + 1)}`,
    ]) {
      const answer = await ask(query);
      expect([query, answer.status]).toEqual([query, 400]);
      expect(answer.body).toEqual({ error: "Name one session as id, and nothing else." });
    }
    expect(asked).toEqual([]);
  });

  test("a session that is not listed is a 404, and so is one its adapter no longer lists", async () => {
    const { ask, asked } = setUp();
    const unlisted = await ask(forId("claude-code:00000000-0000-4000-8000-000000000009"));
    expect(unlisted).toEqual({
      status: 404,
      body: { error: "No session with that id is listed." },
    });
    expect(asked).toEqual([]);

    const gone = setUp({}, null);
    await expect(gone.ask(forId(claude.id))).resolves.toMatchObject({ status: 404 });
    expect(gone.asked).toEqual([claude.id]);
  });

  test("a session on another machine, or of an agent whose adapter reads no messages, is not read", async () => {
    const { ask, asked } = setUp();
    for (const session of [remote, gemini, statusFile]) {
      await expect(ask(forId(session.id)), session.id).resolves.toEqual({
        status: 200,
        body: { message: null, reason: "not-read" },
      });
    }
    expect(asked).toEqual([]);
  });

  test("with AGENT_LOOKOUT_LAST_MESSAGE=off it answers off, naming the setting, and looks nothing up", async () => {
    const { ask, asked } = setUp({ AGENT_LOOKOUT_LAST_MESSAGE: " Off " });
    const off = {
      status: 200,
      body: { message: null, reason: "off", setting: "AGENT_LOOKOUT_LAST_MESSAGE" },
    };
    await expect(ask(forId(claude.id))).resolves.toEqual(off);
    await expect(ask(forId("claude-code:not-listed"))).resolves.toEqual(off);
    // The request's own checks still come first.
    await expect(ask("?id=")).resolves.toMatchObject({ status: 400 });
    await expect(ask(forId(claude.id), { "sec-fetch-site": "same-site" })).resolves.toMatchObject({
      status: 403,
    });
    expect(asked).toEqual([]);
  });

  test("an adapter that says it is off, as with AGENT_LOOKOUT_WAITING_TEXT=off, is passed on", async () => {
    const off: LastMessageResponse = {
      message: null,
      reason: "off",
      setting: "AGENT_LOOKOUT_WAITING_TEXT",
    };
    const { ask } = setUp({}, off);
    await expect(ask(forId(claude.id))).resolves.toEqual({ status: 200, body: off });
  });

  test("while the adapter reads no more for a moment, the answer is 429 with Retry-After", async () => {
    const { ask } = setUp({}, "busy");
    const answer = await ask(forId(claude.id));
    expect(answer.status).toBe(429);
    expect(answer.headers).toEqual({ "Retry-After": "1" });
    expect(answer.body).toEqual({
      error: "Too many last messages were asked for at once. Ask again in a second.",
    });
  });
});

describe("with the Antigravity CLI's and Antigravity's own adapters, which share one set of limits", () => {
  const conversations = ["c1", "c2", "c3", "c4", "c5"].map(conversationId);
  const chats = ["e1", "e2", "e3", "e4"].map(conversationId);
  const cliId = (index: number) => `antigravity-cli:${conversations[index]}`;
  const appId = (index: number) => `antigravity-app:${chats[index]}`;

  /**
   * Five agy conversations and four Antigravity chats, each with a reply, in
   * files held in memory, read by the two real adapters given one set of
   * limits, as the collector gives every reader of last messages, and the
   * route over what they last listed.
   */
  function setUp() {
    const clock = handClock(AGY_NOW);
    const files = memoryFiles(clock.now);
    const write = (file: string, reply: string) =>
      files.write(
        file,
        [
          textStep(0, "USER_INPUT", AGY_NOW - 2 * MINUTE, "Start"),
          replyStep({ index: 1, at: AGY_NOW - MINUTE, content: reply }),
        ].join(""),
        { mtimeMs: AGY_NOW - MINUTE },
      );
    conversations.forEach((id, index) => write(transcriptPath(AGY_HOME, id), `Reply ${index}.`));
    chats.forEach((id, index) => write(transcriptPath(APP_HOME, id), `Chat reply ${index}.`));
    files.write(summariesPath(APP_HOME), "SQLite format 3\u0000", { mtimeMs: AGY_NOW - HOUR });

    const lastMessageLimits = createTailLimits();
    const cli = antigravityAdapterFor(files, standInProcesses(), {
      now: clock.now,
      lastMessageLimits,
    });
    const app = antigravityAppAdapterFor(files, standInHub(), standInSqlite(), {
      now: clock.now,
      lastMessageLimits,
    });
    let sessions: Session[] = [];
    const route = createLastMessageRoute({
      env: {},
      poller: { getSnapshot: () => ({ generatedAt: clock.now(), sources: [], sessions }) },
      adapters: [cli, app],
    });
    return {
      clock,
      files,
      cli,
      app,
      async poll() {
        sessions = [...((await cli.poll()).sessions ?? []), ...((await app.poll()).sessions ?? [])];
        return sessions.map((session) => session.id);
      },
      ask: (id: string) =>
        route({ headers: {} }, new URL(`http://localhost${LAST_MESSAGE_PATH}${forId(id)}`)),
    };
  }

  test("a listed conversation and a listed chat are answered what they last said", async () => {
    const { ask, files, poll } = setUp();
    expect(await poll()).toEqual(
      expect.arrayContaining([
        ...conversations.map((_, index) => cliId(index)),
        ...chats.map((_, index) => appId(index)),
      ]),
    );
    files.forget();
    await expect(ask(cliId(2))).resolves.toEqual({
      status: 200,
      body: { message: { text: "Reply 2.", cut: false } },
    });
    await expect(ask(appId(1))).resolves.toEqual({
      status: 200,
      body: { message: { text: "Chat reply 1.", cut: false } },
    });
    expect(files.opened()).toEqual([
      transcriptPath(AGY_HOME, conversations[2]!),
      transcriptPath(APP_HOME, chats[1]!),
    ]);
  });

  test(`together they read at most ${READS_PER_SECOND} transcripts a second, so a fifth ask is 429 busy, and keep at most ${MAX_KEPT} sessions`, async () => {
    const { ask, app, cli, clock, files, poll } = setUp();
    await poll();
    files.forget();

    const first = [cliId(0), cliId(1), appId(0), appId(1)];
    for (const id of first) {
      await expect(ask(id), id).resolves.toMatchObject({ status: 200 });
    }
    // A conversation, though its own adapter has read only two this second.
    await expect(ask(cliId(2))).resolves.toEqual({
      status: 429,
      headers: { "Retry-After": "1" },
      body: { error: "Too many last messages were asked for at once. Ask again in a second." },
    });
    expect(files.count("openRegular")).toBe(READS_PER_SECOND);

    // One ask a second, so none is busy, until nine sessions have been asked for.
    for (const id of [cliId(2), cliId(3), cliId(4), appId(2), appId(3)]) {
      clock.advance(1_000);
      await expect(ask(id), id).resolves.toMatchObject({ status: 200 });
    }
    expect(cli.lastMessagesKept + app.lastMessagesKept).toBe(MAX_KEPT);
  });
});
