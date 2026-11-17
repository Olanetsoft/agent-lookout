import { expect, test } from "vitest";

import {
  deepseekHarnessSession,
  lastWriteOf,
  sessionIdOf,
  WRITE_ORDER_SLACK_MS,
} from "@collector/adapters/deepseek-harness/toSession";
import type { DeepseekHarnessHeader } from "@collector/adapters/deepseek-harness/lines";
import {
  CWD,
  DAY,
  MINUTE,
  NOW,
  SESSION_ID,
  STARTED_AT,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";

const header: DeepseekHarnessHeader = {
  id: SESSION_ID,
  createdAt: STARTED_AT,
  cwd: CWD,
  parentSession: null,
  subagent: false,
};

const session = (extra: Partial<Parameters<typeof deepseekHarnessSession>[0]> = {}) =>
  deepseekHarnessSession({
    folderName: SESSION_ID,
    header,
    title: null,
    status: { status: "idle", since: NOW - MINUTE, showsLastWrite: false },
    writtenAt: NOW - MINUTE,
    now: NOW,
    ...extra,
  });

test("its ID is its folder's name when that is DeepSeek Harness's own, and a short hash of it otherwise", () => {
  expect(sessionIdOf(SESSION_ID)).toBe(`deepseek-harness:${SESSION_ID}`);
  const configured = `reviewer-${SESSION_ID}`;
  expect(sessionIdOf(configured)).toBe(`deepseek-harness:${configured}`);
  for (const name of [
    "web~0020chat",
    "x".repeat(300),
    "SESSION-0B5D6C1E-2F3A-4B4C-8D5E-6F7A8B9C0D1E",
    `${"a".repeat(65)}-${SESSION_ID}`,
  ]) {
    expect(sessionIdOf(name), name).toMatch(/^deepseek-harness:h[0-9a-f]{16}$/);
  }
  expect(sessionIdOf("web~0020chat")).toBe(sessionIdOf("web~0020chat"));
  expect(sessionIdOf("web~0020chat")).not.toBe(sessionIdOf("web~0020chats"));
});

test("its name is a title of its own, else its folder's, else its ID", () => {
  expect(session({ title: "Fix the build" }).name).toBe("Fix the build");
  expect(session().name).toBe("demo-project");
  expect(session({ header: { ...header, cwd: null } }).name).toBe(`deepseek-harness:${SESSION_ID}`);
  expect(session({ title: "   " }).name).toBe("demo-project");
});

test("it has the folder and start of its header, and no app, link, pid, Jump or Stop", () => {
  expect(session()).toEqual({
    id: `deepseek-harness:${SESSION_ID}`,
    source: "deepseek-harness",
    surface: "unknown",
    name: "demo-project",
    cwd: CWD,
    project: "demo-project",
    status: "idle",
    startedAt: STARTED_AT,
    statusSince: NOW - MINUTE,
    links: {},
    stale: false,
  });
});

test("its last write is shown only while it works, and a wait gives its reason", () => {
  expect(
    session({ status: { status: "working", since: NOW - MINUTE, showsLastWrite: true } })
      .lastWriteAt,
  ).toBe(NOW - MINUTE);
  expect(
    session({ status: { status: "working", since: NOW, showsLastWrite: true }, writtenAt: null }),
  ).not.toHaveProperty("lastWriteAt");
  expect(
    session({
      status: { status: "needs-you", since: NOW, waitingReason: "question", showsLastWrite: false },
    }),
  ).toMatchObject({ waitingReason: "question" });
  expect(session()).not.toHaveProperty("waitingReason");
});

test("a start ahead of the clock is none, and neither shown nor compared with a write", () => {
  expect(session({ header: { ...header, createdAt: NOW + 2 * MINUTE } }).startedAt).toBeNull();
  expect(lastWriteOf(STARTED_AT - DAY, NOW + 2 * MINUTE, NOW)).toBe(STARTED_AT - DAY);
});

test("idle for a day is stale", () => {
  expect(
    session({ status: { status: "idle", since: NOW - DAY, showsLastWrite: false } }).stale,
  ).toBe(true);
});

test("a last write that cannot be right, or is before the session began, is none", () => {
  expect(lastWriteOf(NOW - 1.5, STARTED_AT, NOW)).toBe(NOW - 2);
  expect(lastWriteOf(NOW + 2 * MINUTE, STARTED_AT, NOW)).toBeNull();
  expect(lastWriteOf(STARTED_AT - WRITE_ORDER_SLACK_MS - 1, STARTED_AT, NOW)).toBeNull();
  expect(lastWriteOf(STARTED_AT - WRITE_ORDER_SLACK_MS, STARTED_AT, NOW)).toBe(
    STARTED_AT - WRITE_ORDER_SLACK_MS,
  );
  expect(lastWriteOf(STARTED_AT - DAY, null, NOW)).toBe(STARTED_AT - DAY);
});
