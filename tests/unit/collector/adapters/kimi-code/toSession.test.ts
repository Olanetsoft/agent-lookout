import { describe, expect, test } from "vitest";

import {
  kimiCodeSession,
  type KimiCodeSessionInput,
} from "@collector/adapters/kimi-code/toSession";
import type { KimiCodeWait } from "@core/mapping/kimi-code/kimiCodeMapping";
import {
  BUCKET,
  CREATED_AT,
  DAY,
  LOCKED_AT,
  MINUTE,
  NOW,
  PID,
  PROJECT,
  SECOND,
  sessionIdOf,
  UPDATED_AT,
} from "@tests/fixtures/kimi-code/kimiCode";

const ID = sessionIdOf(1);
const LOCK = { pid: PID, startedAt: LOCKED_AT };
const WAIT: KimiCodeWait = { reason: "permission", since: LOCKED_AT + 1000, ids: ["a"] };

function input(changes: Partial<KimiCodeSessionInput> = {}): KimiCodeSessionInput {
  return {
    session: { id: ID, bucket: BUCKET, folder: PROJECT },
    state: {
      folder: PROJECT,
      ownName: null,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      lastTurnFailed: false,
      listed: true,
    },
    lock: null,
    lastHolder: null,
    wait: null,
    stateWrittenAt: UPDATED_AT,
    now: NOW,
    ...changes,
  };
}

describe("kimiCodeSession", () => {
  test("is in the shared model, with no link, no Jump and no app", () => {
    expect(kimiCodeSession(input())).toEqual({
      id: `kimi-code:${ID}`,
      source: "kimi-code",
      surface: "unknown",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "finished",
      startedAt: CREATED_AT,
      statusSince: UPDATED_AT,
      links: {},
      stale: false,
    });
  });

  test("works from when the lock was taken, with its process", () => {
    expect(kimiCodeSession(input({ lock: LOCK }))).toMatchObject({
      status: "working",
      statusSince: LOCKED_AT,
      pid: PID,
      alive: true,
    });
  });

  test("needs you from when the wait began, with why, and never what was asked", () => {
    const session = kimiCodeSession(input({ lock: LOCK, wait: WAIT }));
    expect(session).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: WAIT.since,
    });
    expect(session).not.toHaveProperty("waitingText");
  });

  test("a wait counts for nothing with no lock held", () => {
    const session = kimiCodeSession(input({ wait: WAIT }));
    expect(session.status).toBe("finished");
    expect(session).not.toHaveProperty("waitingReason");
  });

  test("is idle while its last holder runs, since its last write, and stale after a day", () => {
    expect(kimiCodeSession(input({ lastHolder: LOCK }))).toMatchObject({
      status: "idle",
      statusSince: UPDATED_AT,
      pid: PID,
      alive: true,
      stale: false,
    });
    const after = NOW + 2 * DAY;
    expect(kimiCodeSession(input({ lastHolder: LOCK, now: after })).stale).toBe(true);
  });

  test("a failed last turn is failed", () => {
    const failed = input();
    failed.state.lastTurnFailed = true;
    expect(kimiCodeSession(failed)).toMatchObject({ status: "failed", statusSince: UPDATED_AT });
  });

  test("a finished session names no process", () => {
    const session = kimiCodeSession(input());
    expect(session).not.toHaveProperty("pid");
    expect(session).not.toHaveProperty("alive");
  });

  describe("its name", () => {
    const named = (ownName: string | null, folder: string | null = PROJECT) => {
      const given = input({ session: { id: ID, bucket: BUCKET, folder } });
      given.state.ownName = ownName;
      given.state.folder = folder;
      return kimiCodeSession(given).name;
    };

    test("is the title it keeps, else its folder's, else its id", () => {
      expect(named("demo release")).toBe("demo release");
      expect(named(null)).toBe("demo-project");
      expect(named(null, null)).toBe(`kimi-code:${ID}`);
    });

    test("of only spaces is no name", () => {
      expect(named("   ")).toBe("demo-project");
    });

    test("is cut as every other agent's is", () => {
      expect(Array.from(named("x".repeat(500)))).toHaveLength(200);
    });
  });

  test("takes its folder from state.json, else from the index", () => {
    const given = input({ session: { id: ID, bucket: BUCKET, folder: "/Users/example/other" } });
    expect(kimiCodeSession(given).cwd).toBe(PROJECT);
    given.state.folder = null;
    expect(kimiCodeSession(given)).toMatchObject({ cwd: "/Users/example/other", project: "other" });
  });

  describe("its times", () => {
    test("that are not real times are none", () => {
      const given = input({ lock: { pid: PID, startedAt: 12 } });
      given.state.createdAt = 12;
      expect(kimiCodeSession(given)).toMatchObject({ startedAt: null, statusSince: null });
    });

    test("ahead of the clock are none", () => {
      const given = input({ lock: { pid: PID, startedAt: NOW + 10 * MINUTE } });
      expect(kimiCodeSession(given).statusSince).toBeNull();
    });

    test("a status that seems to begin before the session did has no time", () => {
      const given = input({ lock: { pid: PID, startedAt: CREATED_AT - MINUTE } });
      expect(kimiCodeSession(given).statusSince).toBeNull();
      const moment = input({ lock: { pid: PID, startedAt: CREATED_AT - SECOND / 2 } });
      expect(kimiCodeSession(moment).statusSince).toBe(CREATED_AT - SECOND / 2);
    });

    test("a wait, an updatedAt, a file's time or a last write before the session began is none", () => {
      const early = CREATED_AT - MINUTE;
      const wait: KimiCodeWait = { reason: "permission", since: early, ids: ["a"] };
      expect(kimiCodeSession(input({ lock: LOCK, wait })).statusSince).toBeNull();
      const given = input();
      given.state.updatedAt = early;
      expect(kimiCodeSession(given).statusSince).toBe(UPDATED_AT);
      expect(kimiCodeSession({ ...given, stateWrittenAt: early }).statusSince).toBeNull();
      expect(kimiCodeSession(input({ lock: LOCK, wireWrittenAt: early }))).not.toHaveProperty(
        "lastWriteAt",
      );
    });

    test("with no good `updatedAt`, the status time is state.json's own", () => {
      const given = input({ stateWrittenAt: UPDATED_AT + 0.5 });
      given.state.updatedAt = null;
      expect(kimiCodeSession(given).statusSince).toBe(UPDATED_AT);
    });

    test("the last write is the event file's, while it was looked up", () => {
      expect(kimiCodeSession(input({ lock: LOCK, wireWrittenAt: NOW - 0.5 })).lastWriteAt).toBe(
        NOW - 1,
      );
      expect(kimiCodeSession(input())).not.toHaveProperty("lastWriteAt");
      expect(kimiCodeSession(input({ lock: LOCK, wireWrittenAt: 5 }))).not.toHaveProperty(
        "lastWriteAt",
      );
    });
  });
});
