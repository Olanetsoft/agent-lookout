import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import type { Adapter } from "@collector/adapters/adapter";
import { MAX_SESSION_ID_LENGTH } from "@collector/jumpRoute";
import { createLastMessageRoute, idIn } from "@collector/messages/lastMessageRoute";
import { LAST_MESSAGE_PATH, type LastMessageResponse } from "@core/api";
import type { Session } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;

const claude = makeSession({ id: "claude-code:00000000-0000-4000-8000-000000000001" });
const codex = makeSession({ id: "codex:00000000-0000-4000-8000-000000000002", source: "codex" });
const agy = makeSession({ id: "antigravity-cli:demo-conversation", source: "antigravity-cli" });
const statusFile = makeSession({ id: "status-files:demo-agent", source: "status-files" });
const remote = makeSession({
  id: "remote:devbox:claude-code:00000000-0000-4000-8000-000000000003",
  source: "remote:devbox",
  machine: "devbox",
});
const listed: Session[] = [claude, codex, agy, statusFile, remote];

const SAID: LastMessageResponse = { message: { text: "The tests pass.", cut: false } };

/**
 * The route over a list of sessions, with a Claude Code adapter that answers
 * as it is told and writes down every id it is asked for, and adapters for
 * the other sources that read nothing.
 */
function setUp(env: NodeJS.ProcessEnv = {}, said: LastMessageResponse | "busy" | null = SAID) {
  const asked: string[] = [];
  const reading: Pick<Adapter, "id" | "lastMessage"> = {
    id: "claude-code",
    lastMessage: async (sessionId) => {
      asked.push(sessionId);
      return said;
    },
  };
  const route = createLastMessageRoute({
    env,
    poller: { getSnapshot: () => ({ generatedAt: T0, sources: [], sessions: listed }) },
    adapters: [reading, { id: "codex" }, { id: "antigravity-cli" }, { id: "status-files" }],
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
    expect(asked).toEqual([claude.id, claude.id]);
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
    for (const session of [remote, codex, agy, statusFile]) {
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
