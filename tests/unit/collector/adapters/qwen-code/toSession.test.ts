import { describe, expect, test } from "vitest";

import type { ChatState } from "@collector/adapters/qwen-code/chatRecords";
import type { RegistryEntry } from "@collector/adapters/qwen-code/registry";
import {
  closedQwenCodeSession,
  leftBehindQwenCodeSession,
  qwenCodeSession,
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

  test("a record of another kind is in no known app", () => {
    expect(
      qwenCodeSession({ entry: entry({ kind: "headless" }), chat: null, now: NOW }).surface,
    ).toBe("unknown");
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
});
