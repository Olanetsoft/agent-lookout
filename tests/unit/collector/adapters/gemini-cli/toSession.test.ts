import { describe, expect, test } from "vitest";

import type { ChatFileState } from "@collector/adapters/gemini-cli/chatFile";
import {
  BATCH_GRACE_MS,
  geminiCliSession,
  geminiCliSessionId,
  lastActivity,
} from "@collector/adapters/gemini-cli/toSession";
import { DAY, HOUR, ids, MINUTE, NOW, PROJECT, SLUG } from "@tests/fixtures/gemini-cli/geminiCli";

function stateWith(fields: Partial<ChatFileState> = {}): ChatFileState {
  return {
    header: { sessionId: ids.working, kind: "main", startedAt: NOW - HOUR, updatedAt: NOW - HOUR },
    status: { status: "working", since: NOW - MINUTE },
    updatedAt: NOW - MINUTE,
    messageAt: NOW - MINUTE,
    toolAt: null,
    skipped: 0,
    ...fields,
  };
}

/** The session a file with a header makes. */
function sessionOf(
  state: ChatFileState,
  extra: { cwd?: string | null; writtenAt?: number; now?: number } = {},
) {
  const session = geminiCliSession({ state, slug: SLUG, cwd: PROJECT, now: NOW, ...extra });
  if (session === null) throw new Error("No session was made.");
  return session;
}

describe("geminiCliSession", () => {
  test("a working session, in the shared model", () => {
    expect(sessionOf(stateWith(), { writtenAt: NOW - 30_000.6 })).toEqual({
      id: geminiCliSessionId(SLUG, ids.working),
      source: "gemini-cli",
      surface: "terminal",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "working",
      startedAt: NOW - HOUR,
      statusSince: NOW - MINUTE,
      lastWriteAt: NOW - 30_001,
      links: {},
      stale: false,
    });
  });

  test("is named by its title, then its folder, then its id, and never by a prompt", () => {
    expect(sessionOf(stateWith({ summary: "Tidy the demo readme" })).name).toBe(
      "Tidy the demo readme",
    );
    expect(sessionOf(stateWith({ summary: "   " })).name).toBe("demo-project");
    expect(sessionOf(stateWith(), { cwd: null })).toMatchObject({
      name: geminiCliSessionId(SLUG, ids.working),
      cwd: null,
      project: null,
    });
    const long = "A title ".repeat(40);
    expect(sessionOf(stateWith({ summary: long })).name.length).toBeLessThanOrEqual(200);
  });

  test("is no session when its file has no header", () => {
    expect(
      geminiCliSession({ state: stateWith({ header: null }), slug: SLUG, cwd: PROJECT, now: NOW }),
    ).toBeNull();
  });

  test("keeps its status's time, unless that is before the session began", () => {
    const idle = { status: "idle" as const, since: NOW - 2 * MINUTE };
    expect(sessionOf(stateWith({ status: idle })).statusSince).toBe(NOW - 2 * MINUTE);
    // A moment before the start is the same moment.
    const justBefore = { status: "idle" as const, since: NOW - HOUR - 500 };
    expect(sessionOf(stateWith({ status: justBefore })).statusSince).toBe(NOW - HOUR - 500);
    const before = { status: "idle" as const, since: NOW - HOUR - 2_000 };
    expect(sessionOf(stateWith({ status: before })).statusSince).toBeNull();
    // A time that could not be right is not known.
    const future = { status: "working" as const, since: NOW + HOUR };
    expect(sessionOf(stateWith({ status: future })).statusSince).toBeNull();
    // An unknown status has no time.
    const unknown = { status: "unknown" as const, since: NOW - MINUTE };
    expect(sessionOf(stateWith({ status: unknown })).statusSince).toBeNull();
  });

  test("a batch of tool calls that ended a moment ago is working since the prompt, and unknown later", () => {
    // Gemini CLI writes the batch, then does other work before it writes the tools' results.
    const batchAt = (endedAt: number | null) => ({
      status: "unknown" as const,
      since: null,
      batch: { endedAt, workingSince: NOW - MINUTE },
    });
    expect(sessionOf(stateWith({ status: batchAt(NOW - 5_000) }))).toMatchObject({
      status: "working",
      statusSince: NOW - MINUTE,
    });
    expect(sessionOf(stateWith({ status: batchAt(NOW - BATCH_GRACE_MS + 1) })).status).toBe(
      "working",
    );
    // A tool that stops the agent leaves the batch last for good.
    expect(sessionOf(stateWith({ status: batchAt(NOW - BATCH_GRACE_MS) }))).toMatchObject({
      status: "unknown",
      statusSince: null,
    });
    // With no time it ended, or one that could not be right, it stays unknown.
    expect(sessionOf(stateWith({ status: batchAt(null) })).status).toBe("unknown");
    expect(sessionOf(stateWith({ status: batchAt(NOW + HOUR) })).status).toBe("unknown");
  });

  test("its last write is the file's time, unless that is before the session began", () => {
    expect(sessionOf(stateWith(), { writtenAt: NOW - HOUR - 500 })?.lastWriteAt).toBe(
      NOW - HOUR - 500,
    );
    expect(sessionOf(stateWith(), { writtenAt: NOW - HOUR - 2_000 })).not.toHaveProperty(
      "lastWriteAt",
    );
    expect(sessionOf(stateWith(), { writtenAt: NOW + HOUR })).not.toHaveProperty("lastWriteAt");
    expect(sessionOf(stateWith())).not.toHaveProperty("lastWriteAt");
  });

  test("is stale after a day idle, and never while working", () => {
    const idle = { status: "idle" as const, since: NOW - DAY };
    const header = { sessionId: ids.idle, startedAt: NOW - 2 * DAY, updatedAt: null };
    expect(sessionOf(stateWith({ header, status: idle })).stale).toBe(true);
    const working = { status: "working" as const, since: NOW - DAY };
    expect(sessionOf(stateWith({ header, status: working })).stale).toBe(false);
  });

  test("has no pid, no process and no way to jump to it", () => {
    const session = sessionOf(stateWith());
    expect(session).not.toHaveProperty("pid");
    expect(session).not.toHaveProperty("alive");
    expect(session).not.toHaveProperty("jump");
    expect(session).not.toHaveProperty("tokens");
  });
});

describe("lastActivity", () => {
  test("is the newest time that could be right of the last update, message and tool call", () => {
    expect(lastActivity(stateWith({ toolAt: NOW - 10_000 }), NOW)).toBe(NOW - 10_000);
    expect(lastActivity(stateWith({ updatedAt: NOW - 5_000 }), NOW)).toBe(NOW - 5_000);
    // A time in the future is passed over, not believed.
    expect(lastActivity(stateWith({ updatedAt: NOW + DAY }), NOW)).toBe(NOW - MINUTE);
    expect(
      lastActivity(stateWith({ updatedAt: null, messageAt: null, toolAt: null }), NOW),
    ).toBeNull();
  });
});

test("a session's id is Gemini CLI's own id and a short hash of its project folder, never the folder's name", () => {
  const id = geminiCliSessionId("demo-project", "review");
  expect(id).toMatch(/^gemini-cli:review\.[0-9a-f]{8}$/);
  expect(id).not.toContain("demo-project");
  // The same project gives the same id on every poll, and another project another id.
  expect(geminiCliSessionId("demo-project", "review")).toBe(id);
  expect(geminiCliSessionId("other-project", "review")).not.toBe(id);
});
