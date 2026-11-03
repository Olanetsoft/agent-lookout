import { describe, expect, test } from "vitest";

import type { ChatState } from "@collector/adapters/qwen-code/chatRecords";
import type { RegistryEntry } from "@collector/adapters/qwen-code/registry";
import {
  closedQwenCodeSession,
  leftBehindQwenCodeSession,
  qwenCodeSession,
  withJump,
} from "@collector/adapters/qwen-code/toSession";
import {
  foldQwenCodeRecord,
  startQwenCodeFold,
  type QwenCodeRecord,
} from "@core/mapping/qwen-code/qwenCodeMapping";
import { DAY, MINUTE, NOW, PROJECT, sessionIdOf } from "@tests/fixtures/qwen-code/qwenCode";

const ID = sessionIdOf(1);

const entry = (fields: Partial<RegistryEntry> = {}): RegistryEntry => ({
  pid: 41001,
  sessionId: ID,
  cwd: PROJECT,
  startedAt: NOW - 30 * MINUTE,
  kind: "tui",
  linux: false,
  ...fields,
});

function chat(records: QwenCodeRecord[], whole = true): ChatState {
  const fold = records.reduce(foldQwenCodeRecord, startQwenCodeFold(whole));
  const first = records.find((record) => record.at !== null)?.at ?? null;
  return { fold, firstAt: whole ? first : null };
}

const prompt = (time: number): QwenCodeRecord => ({ type: "user", at: time });
const reply = (time: number): QwenCodeRecord => ({ type: "assistant", at: time, message: true });
/** The end of a request of the session's own, then the reply to it, which asks the person a question. */
const asks = (time: number): QwenCodeRecord[] => [
  {
    type: "system",
    subtype: "ui_telemetry",
    at: time,
    lifecycle: { phase: "ended", outcome: "success", subagent: false },
  },
  { type: "assistant", at: time, message: true, calls: true, waitsOn: "ask_user_question" },
];
const title = (text: string): QwenCodeRecord => ({
  type: "system",
  subtype: "custom_title",
  at: NOW - MINUTE,
  title: text,
});

describe("qwenCodeSession", () => {
  test("a working session, named by its title, with its process and the time of its last write", () => {
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - 10 * MINUTE), title("Fix the flaky test")]),
      writtenAt: NOW - MINUTE + 0.5,
      now: NOW,
    });
    expect(session).toEqual({
      id: `qwen-code:${ID}`,
      source: "qwen-code",
      surface: "terminal",
      name: "Fix the flaky test",
      cwd: PROJECT,
      project: "demo-project",
      status: "working",
      startedAt: NOW - 10 * MINUTE,
      statusSince: NOW - 10 * MINUTE,
      lastWriteAt: NOW - MINUTE,
      pid: 41001,
      alive: true,
      links: {},
      stale: false,
    });
  });

  test("its name is its title, then its folder's, then its id", () => {
    const named = (state: ChatState | null, cwd: string | null = PROJECT) =>
      qwenCodeSession({ entry: entry({ cwd }), chat: state, now: NOW }).name;
    expect(named(chat([title("Tidy the release notes")]))).toBe("Tidy the release notes");
    expect(named(chat([title("   ")]))).toBe("demo-project");
    expect(named(null)).toBe("demo-project");
    expect(named(null, null)).toBe(`qwen-code:${ID}`);
  });

  test("with no chat file it is idle since its process registered it, with no last write", () => {
    const session = qwenCodeSession({ entry: entry(), chat: null, now: NOW });
    expect(session).toMatchObject({
      status: "idle",
      startedAt: NOW - 30 * MINUTE,
      statusSince: NOW - 30 * MINUTE,
    });
    expect(session).not.toHaveProperty("lastWriteAt");
  });

  test("one /clear or /resume moved its process to counts from then, not from when the process registered", () => {
    const old = entry({ startedAt: NOW - 2 * DAY });
    const session = qwenCodeSession({ entry: old, chat: null, tookOverAt: NOW - MINUTE, now: NOW });
    expect(session).toMatchObject({
      status: "idle",
      startedAt: NOW - MINUTE,
      statusSince: NOW - MINUTE,
      stale: false,
    });
  });

  test("it began with its file's first line when the file was read from its start, otherwise when it registered", () => {
    // Resumed: the file is older than the process.
    const resumed = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - DAY), reply(NOW - DAY + MINUTE)]),
      now: NOW,
    });
    expect(resumed).toMatchObject({
      status: "idle",
      startedAt: NOW - DAY,
      statusSince: NOW - 30 * MINUTE,
    });
    const cut = qwenCodeSession({
      entry: entry(),
      chat: chat([reply(NOW - 5 * MINUTE)], false),
      now: NOW,
    });
    expect(cut).toMatchObject({
      status: "idle",
      startedAt: NOW - 30 * MINUTE,
      statusSince: NOW - 5 * MINUTE,
    });
  });

  test("a working session whose stretch of work began before what was read has no status time", () => {
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([{ type: "tool_result", at: NOW - MINUTE }], false),
      now: NOW,
    });
    expect(session).toMatchObject({ status: "working", statusSince: null });
  });

  test("an unknown status has no time", () => {
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - MINUTE), { type: "summary", at: NOW - 30_000 }]),
      now: NOW,
    });
    expect(session).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("times that could not be right are not kept", () => {
    const session = qwenCodeSession({
      entry: entry({ startedAt: 1_700 }),
      chat: chat([prompt(NOW + DAY)]),
      writtenAt: NOW + DAY,
      now: NOW,
    });
    expect(session).toMatchObject({ startedAt: null, statusSince: null });
    expect(session).not.toHaveProperty("lastWriteAt");
  });

  test("a last write or a status more than a second before the session began is not kept, within a second it is", () => {
    const early = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - 10 * MINUTE)]),
      writtenAt: NOW - 10 * MINUTE - 1_001,
      now: NOW,
    });
    expect(early).not.toHaveProperty("lastWriteAt");
    const close = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - 10 * MINUTE)]),
      writtenAt: NOW - 10 * MINUTE - 1_000,
      now: NOW,
    });
    expect(close.lastWriteAt).toBe(NOW - 10 * MINUTE - 1_000);
  });

  test("an idle session whose file began after its process registered it is idle since the file began", () => {
    // A title written before the first prompt, after the record.
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([{ ...title("Fix the flaky test"), at: NOW - 10 * MINUTE }]),
      now: NOW,
    });
    expect(session).toMatchObject({
      status: "idle",
      startedAt: NOW - 10 * MINUTE,
      statusSince: NOW - 10 * MINUTE,
    });
  });

  test("an idle session is stale after a day", () => {
    const session = qwenCodeSession({
      entry: entry({ startedAt: NOW - 3 * DAY }),
      chat: chat([prompt(NOW - 3 * DAY), reply(NOW - 2 * DAY)]),
      now: NOW,
    });
    expect(session).toMatchObject({ status: "idle", stale: true });
  });

  test("carries the token counts of its newest reply that has them, and none without", () => {
    const tokens = { input: 2400, cached: 1800, output: 150 };
    const counted = (time: number): QwenCodeRecord => ({ ...reply(time), tokens });
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - 10 * MINUTE), counted(NOW - 9 * MINUTE), reply(NOW - 8 * MINUTE)]),
      now: NOW,
    });
    expect(session).toMatchObject({ status: "idle", tokens });
    // A copy: the fold's own counts are not handed on.
    expect(session.tokens).not.toBe(tokens);

    const without = (state: ChatState | null) =>
      qwenCodeSession({ entry: entry(), chat: state, now: NOW });
    expect(without(null)).not.toHaveProperty("tokens");
    expect(without(chat([prompt(NOW - MINUTE), reply(NOW - 30_000)]))).not.toHaveProperty("tokens");
    expect(
      without(chat([counted(NOW - MINUTE), { ...reply(NOW - 30_000), tokens: null }])),
    ).not.toHaveProperty("tokens");
  });

  test("needs you while Qwen Code asks, with the reason question, since the line that asked, and no text", () => {
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - 10 * MINUTE), ...asks(NOW - 4 * MINUTE)]),
      writtenAt: NOW - 4 * MINUTE,
      now: NOW,
    });
    expect(session).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 4 * MINUTE,
      alive: true,
      stale: false,
    });
    expect(session).not.toHaveProperty("waitingText");
    expect(session).not.toHaveProperty("waitingDetail");
  });

  test("has no reason for a wait when it does not need you", () => {
    for (const state of [
      chat([prompt(NOW - MINUTE)]),
      chat([prompt(NOW - MINUTE), reply(NOW - 30_000)]),
      chat([
        prompt(NOW - MINUTE),
        ...asks(NOW - 50_000),
        { type: "tool_result", at: NOW - 30_000 },
      ]),
      null,
    ]) {
      expect(qwenCodeSession({ entry: entry(), chat: state, now: NOW })).not.toHaveProperty(
        "waitingReason",
      );
    }
  });

  test("a question an earlier process left open is no wait: idle since the session registered", () => {
    const session = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - DAY), ...asks(NOW - DAY + MINUTE)]),
      now: NOW,
    });
    expect(session).toMatchObject({ status: "idle", statusSince: NOW - 30 * MINUTE });
    expect(session).not.toHaveProperty("waitingReason");
  });

  test("a record of another kind is in no known app", () => {
    expect(
      qwenCodeSession({ entry: entry({ kind: "headless" }), chat: null, now: NOW }).surface,
    ).toBe("unknown");
  });
});

describe("withJump", () => {
  const open = () => qwenCodeSession({ entry: entry(), chat: null, now: NOW });
  const pane = { pid: 4100, id: "%3", place: "api-rate-limits:0.1" };
  const tab = { app: "Terminal", tty: "/dev/ttys004" } as const;

  test("a session in a pane is reached through tmux, by the place's name alone", () => {
    const session = withJump(open(), pane, tab);
    expect(session.jump).toEqual({ kind: "tmux", place: "api-rate-limits:0.1" });
    expect(JSON.stringify(session)).not.toContain("%3");
    expect(JSON.stringify(session)).not.toContain("ttys004");
  });

  test("a session in a tab only is reached through its app", () => {
    expect(withJump(open(), undefined, tab).jump).toEqual({
      kind: "terminal",
      app: "Terminal",
      place: "Terminal",
    });
  });

  test("a session in neither is as it was", () => {
    expect(withJump(open(), undefined, undefined)).toEqual(open());
    expect(open()).not.toHaveProperty("jump");
  });
});

describe("closedQwenCodeSession", () => {
  test("is the session as last seen, finished since the poll that found it closed", () => {
    const open = qwenCodeSession({ entry: entry(), chat: chat([prompt(NOW - MINUTE)]), now: NOW });
    expect(closedQwenCodeSession(open, NOW + 2_000)).toEqual({
      ...open,
      status: "finished",
      statusSince: NOW + 2_000,
      alive: false,
      stale: false,
    });
  });

  test("keeps the token counts it had when it closed", () => {
    const tokens = { input: 1200, cached: 600, output: 100 };
    const open = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - MINUTE), { ...reply(NOW - 30_000), tokens }]),
      now: NOW,
    });
    expect(closedQwenCodeSession(open, NOW + 2_000).tokens).toEqual(tokens);
    expect(closedQwenCodeSession(open, NOW + 2_000, true).tokens).toEqual(tokens);
  });

  test("a session that closes while it waits is finished, with no reason for the wait", () => {
    const open = qwenCodeSession({
      entry: entry(),
      chat: chat([prompt(NOW - MINUTE), ...asks(NOW - 30_000)]),
      now: NOW,
    });
    expect(open.waitingReason).toBe("question");
    for (const closed of [
      closedQwenCodeSession(open, NOW + 2_000),
      closedQwenCodeSession(open, NOW + 2_000, true),
    ]) {
      expect(closed).toMatchObject({ status: "finished", statusSince: NOW + 2_000 });
      expect(closed).not.toHaveProperty("waitingReason");
    }
  });

  test("names no process when its process runs on with another session", () => {
    const open = qwenCodeSession({ entry: entry(), chat: chat([prompt(NOW - MINUTE)]), now: NOW });
    const closed = closedQwenCodeSession(open, NOW + 2_000, true);
    expect(closed).toMatchObject({ status: "finished", statusSince: NOW + 2_000, stale: false });
    expect(closed).not.toHaveProperty("pid");
    expect(closed).not.toHaveProperty("alive");
  });
});

describe("leftBehindQwenCodeSession", () => {
  test("is finished since its chat file was last written, named for its folder", () => {
    expect(leftBehindQwenCodeSession(entry(), NOW - 20 * MINUTE, NOW)).toEqual({
      id: `qwen-code:${ID}`,
      source: "qwen-code",
      surface: "terminal",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "finished",
      startedAt: NOW - 30 * MINUTE,
      statusSince: NOW - 20 * MINUTE,
      lastWriteAt: NOW - 20 * MINUTE,
      pid: 41001,
      alive: false,
      links: {},
      stale: false,
    });
  });

  test("with no chat file, since its process registered it", () => {
    const session = leftBehindQwenCodeSession(entry(), undefined, NOW);
    expect(session.statusSince).toBe(NOW - 30 * MINUTE);
    expect(session).not.toHaveProperty("lastWriteAt");
  });

  test("has no token counts: its chat file is not read", () => {
    expect(leftBehindQwenCodeSession(entry(), NOW - 20 * MINUTE, NOW)).not.toHaveProperty("tokens");
  });
});
