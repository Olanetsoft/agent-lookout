import { expect, test } from "vitest";

import type { RegistryEntry } from "@collector/adapters/grok-build/registry";
import {
  finishedAtOf,
  finishedGrokBuildSession,
  grokBuildId,
  grokBuildSession,
  withJump,
} from "@collector/adapters/grok-build/toSession";
import {
  DAY,
  MINUTE,
  NOW,
  OPENED_AT,
  PID,
  PROJECT,
  SECOND,
  SESSION_ID,
} from "@tests/fixtures/grok-build/grokBuild";

const ENTRY: RegistryEntry = { sessionId: SESSION_ID, pid: PID, cwd: PROJECT, openedAt: OPENED_AT };

test("a session's ID is its source's and Grok Build's own", () => {
  expect(grokBuildId(SESSION_ID)).toBe(`grok-build:${SESSION_ID}`);
});

test("an open session takes its name from a marked title, else its folder, else its ID", () => {
  const status = { status: "idle" as const, since: NOW - MINUTE };
  const base = { entry: ENTRY, status, writtenAt: NOW - SECOND, now: NOW };
  expect(grokBuildSession({ ...base, title: "Release checklist" }).name).toBe("Release checklist");
  expect(grokBuildSession({ ...base, title: null }).name).toBe("demo-project");
  expect(grokBuildSession({ ...base, title: null, entry: { ...ENTRY, cwd: "/" } }).name).toBe(
    `grok-build:${SESSION_ID}`,
  );
});

test("an open session's last write is its log's time, when that could be right", () => {
  const status = { status: "working" as const, since: NOW - MINUTE };
  const session = (writtenAt: number | null) =>
    grokBuildSession({ entry: ENTRY, title: null, status, writtenAt, now: NOW });
  expect(session(NOW - 1.5).lastWriteAt).toBe(NOW - 2);
  expect(session(NOW + 10 * MINUTE).lastWriteAt).toBeUndefined();
  expect(session(null).lastWriteAt).toBeUndefined();
});

test("a waiting session carries its reason, and an idle one a day old is stale", () => {
  const waiting = grokBuildSession({
    entry: ENTRY,
    title: null,
    status: {
      status: "needs-you",
      since: NOW - MINUTE,
      waitingReason: "question",
      wait: "question",
    },
    writtenAt: null,
    now: NOW,
  });
  expect(waiting).toMatchObject({ status: "needs-you", waitingReason: "question", stale: false });
  const old = grokBuildSession({
    entry: ENTRY,
    title: null,
    status: { status: "idle", since: NOW - DAY },
    writtenAt: null,
    now: NOW,
  });
  expect(old.stale).toBe(true);
});

test("Jump names the pane's place or the app, and nothing else", () => {
  const session = grokBuildSession({
    entry: ENTRY,
    title: null,
    status: { status: "idle", since: null },
    writtenAt: null,
    now: NOW,
  });
  expect(withJump(session, { pid: PID, id: "%1", place: "demo:0.1" }, undefined).jump).toEqual({
    kind: "tmux",
    place: "demo:0.1",
  });
  expect(withJump(session, undefined, { app: "Terminal", tty: "/dev/ttys001" }).jump).toEqual({
    kind: "terminal",
    app: "Terminal",
    place: "Terminal",
  });
  expect(withJump(session, undefined, undefined)).toBe(session);
});

test("a session that ended is finished since the later of its listing and its log's write", () => {
  const record = {
    entry: ENTRY,
    title: null,
    writtenAt: OPENED_AT + MINUTE,
    noticedAt: NOW,
    processRunsOn: false,
  };
  expect(finishedGrokBuildSession(record, NOW)).toMatchObject({
    status: "finished",
    statusSince: OPENED_AT + MINUTE,
    pid: PID,
    alive: false,
    lastWriteAt: OPENED_AT + MINUTE,
  });
  expect(finishedAtOf({ ...record, writtenAt: OPENED_AT - MINUTE }, NOW)).toBe(OPENED_AT);
});

test("a session whose process runs on names no process", () => {
  const record = {
    entry: ENTRY,
    title: null,
    writtenAt: null,
    noticedAt: NOW,
    processRunsOn: true,
  };
  const session = finishedGrokBuildSession(record, NOW);
  expect(session.pid).toBeUndefined();
  expect(session.alive).toBeUndefined();
});

test("with neither time right, it is finished since it was seen to end", () => {
  const record = {
    entry: { ...ENTRY, openedAt: NOW + DAY },
    title: null,
    writtenAt: NOW + DAY,
    noticedAt: NOW - SECOND,
    processRunsOn: false,
  };
  expect(finishedAtOf(record, NOW)).toBe(NOW - SECOND);
  expect(finishedGrokBuildSession(record, NOW).startedAt).toBeNull();
});
