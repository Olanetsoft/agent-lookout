import { describe, expect, test } from "vitest";

import {
  antigravitySession,
  APP_PROFILE,
  CLI_PROFILE,
} from "@collector/adapters/antigravity/shared/toSession";
import type { TranscriptState } from "@collector/adapters/antigravity/shared/transcriptFile";
import { conversationId, MINUTE, NOW, SECOND } from "@tests/fixtures/antigravity";

const ID = conversationId("a1");
const START = NOW - 30 * MINUTE;

const idle: TranscriptState = {
  firstAt: START,
  last: {
    index: 3,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    toolCalls: false,
    at: NOW - 2 * MINUTE,
  },
  since: NOW - 2 * MINUTE,
  lastAt: NOW - MINUTE,
  lastIndex: 3,
};

describe("antigravitySession", () => {
  test("is a terminal session named by its conversation id, with no folder, process or link", () => {
    expect(
      antigravitySession({
        profile: CLI_PROFILE,
        conversationId: ID,
        state: idle,
        live: true,
        writtenAt: NOW - MINUTE,
        now: NOW,
      }),
    ).toEqual({
      id: `antigravity-cli:${ID}`,
      source: "antigravity-cli",
      surface: "terminal",
      name: ID,
      cwd: null,
      project: null,
      status: "idle",
      startedAt: START,
      statusSince: NOW - 2 * MINUTE,
      lastWriteAt: NOW - MINUTE,
      links: {},
      stale: false,
    });
  });

  test("a conversation no agy program has open is finished since its last step", () => {
    const session = antigravitySession({
      profile: CLI_PROFILE,
      conversationId: ID,
      state: idle,
      live: false,
      writtenAt: null,
      now: NOW,
    });
    expect(session).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
    expect(session).not.toHaveProperty("lastWriteAt");
  });

  test("a working one is working since its turn began", () => {
    const working: TranscriptState = {
      ...idle,
      last: {
        index: 6,
        type: "RUN_COMMAND",
        status: "RUNNING",
        toolCalls: false,
        at: NOW - 10 * SECOND,
      },
      since: NOW - 40 * SECOND,
    };
    expect(
      antigravitySession({
        profile: CLI_PROFILE,
        conversationId: ID,
        state: working,
        live: "unknown",
        writtenAt: NOW,
        now: NOW,
      }),
    ).toMatchObject({ status: "working", statusSince: NOW - 40 * SECOND, lastWriteAt: NOW });
  });

  test("an unknown status has no time", () => {
    const unknown: TranscriptState = { ...idle, last: undefined };
    expect(
      antigravitySession({
        profile: CLI_PROFILE,
        conversationId: ID,
        state: unknown,
        live: true,
        writtenAt: NOW,
        now: NOW,
      }),
    ).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("times that could not be right are not known", () => {
    const wrong: TranscriptState = {
      firstAt: NOW + 2 * 60 * MINUTE,
      last: idle.last,
      since: Date.UTC(2001, 0, 1),
      lastAt: null,
      lastIndex: 3,
    };
    const session = antigravitySession({
      profile: CLI_PROFILE,
      conversationId: ID,
      state: wrong,
      live: true,
      writtenAt: NOW + 2 * 60 * MINUTE,
      now: NOW,
    });
    expect(session).toMatchObject({ startedAt: null, statusSince: null });
    expect(session).not.toHaveProperty("lastWriteAt");
  });

  test("neither a status nor a write can come before the conversation began", () => {
    const early: TranscriptState = { ...idle, since: START - 10 * MINUTE };
    const session = antigravitySession({
      profile: CLI_PROFILE,
      conversationId: ID,
      state: early,
      live: true,
      writtenAt: START - 10 * MINUTE,
      now: NOW,
    });
    expect(session).toMatchObject({ startedAt: START, statusSince: null });
    expect(session).not.toHaveProperty("lastWriteAt");
  });
});

describe("antigravitySession, with what its program's log and its title say", () => {
  const base = {
    profile: CLI_PROFILE,
    conversationId: ID,
    state: idle,
    live: true,
    writtenAt: NOW - MINUTE,
    now: NOW,
  };

  test("needs you for permission while its program waits for approval, since agy began to ask", () => {
    expect(
      antigravitySession({ ...base, waiting: { tool: "RunCommand", since: NOW - 20 * SECOND } }),
    ).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "RunCommand",
      statusSince: NOW - 20 * SECOND,
    });
  });

  test("a wait whose start the log did not give began with the last step", () => {
    expect(
      antigravitySession({ ...base, waiting: { tool: "RunCommand", since: null } }).statusSince,
    ).toBe(NOW - MINUTE);
  });

  test("a closed conversation is finished, whatever its log last said, with nothing of the wait", () => {
    const session = antigravitySession({
      ...base,
      live: false,
      waiting: { tool: "RunCommand", since: NOW - 20 * SECOND },
    });
    expect(session.status).toBe("finished");
    expect(session).not.toHaveProperty("waitingReason");
    expect(session).not.toHaveProperty("waitingDetail");
  });

  test("is named by its title, else its folder's name, else its conversation id", () => {
    const folder = "/Users/example/code/demo-project";
    expect(antigravitySession({ ...base, title: "Count the files", folder })).toMatchObject({
      name: "Count the files",
      cwd: folder,
      project: "demo-project",
    });
    expect(antigravitySession({ ...base, title: null, folder }).name).toBe("demo-project");
    expect(antigravitySession({ ...base, title: null, folder: null }).name).toBe(ID);
  });
});

describe("antigravitySession, for Antigravity 2.0", () => {
  const base = {
    profile: APP_PROFILE,
    conversationId: ID,
    state: idle,
    live: true,
    writtenAt: NOW - MINUTE,
    now: NOW,
  };

  test("is a desktop app session of its own source, with its folder from the app's list of chats", () => {
    const folder = "/Users/example/code/demo-project";
    expect(antigravitySession({ ...base, title: "Count the files", folder })).toEqual({
      id: `antigravity-app:${ID}`,
      source: "antigravity-app",
      surface: "desktop",
      name: "Count the files",
      cwd: folder,
      project: "demo-project",
      status: "idle",
      startedAt: START,
      statusSince: NOW - 2 * MINUTE,
      lastWriteAt: NOW - MINUTE,
      links: {},
      stale: false,
    });
  });

  test("a chat whose last step is a done reply is working while its files are written, since that reply", () => {
    expect(antigravitySession({ ...base, writtenAt: NOW - SECOND, writing: true })).toMatchObject({
      status: "working",
      statusSince: NOW - 2 * MINUTE,
      lastWriteAt: NOW - SECOND,
    });
  });

  test("once the app is closed it is finished, written to or not", () => {
    expect(antigravitySession({ ...base, live: false, writing: true }).status).toBe("finished");
  });
});
