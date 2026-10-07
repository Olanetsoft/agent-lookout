import { describe, expect, test } from "vitest";

import { antigravitySession } from "@collector/adapters/antigravity/toSession";
import type { TranscriptState } from "@collector/adapters/antigravity/transcriptFile";
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
};

describe("antigravitySession", () => {
  test("is a terminal session named by its conversation id, with no folder, process or link", () => {
    expect(
      antigravitySession({
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
    };
    const session = antigravitySession({
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
