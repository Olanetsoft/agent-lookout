import { describe, expect, test } from "vitest";

import type { FxLog } from "@collector/adapters/fx/logFile";
import { fxSession } from "@collector/adapters/fx/toSession";
import { NOW, SECOND, SESSION_ID, STARTED_AT, WORKSPACE } from "@tests/fixtures/fx/fx";

const LOG: FxLog = {
  id: SESSION_ID,
  cwd: WORKSPACE,
  createdAt: STARTED_AT,
  tail: { turn: "open" },
  why: null,
  newestTs: NOW - 10 * SECOND,
};

const session = (log: Partial<FxLog>, more: Partial<Parameters<typeof fxSession>[0]> = {}) =>
  fxSession({
    log: { ...LOG, ...log },
    programs: "some",
    writerGone: false,
    writtenAt: NOW - 10 * SECOND,
    now: NOW,
    ...more,
  });

describe("an fx session", () => {
  test("is named after its folder, with the log's last write, and nothing else of fx's", () => {
    expect(session({})).toEqual({
      id: `fx:${SESSION_ID}`,
      source: "fx",
      surface: "unknown",
      name: "demo-project",
      cwd: WORKSPACE,
      project: "demo-project",
      status: "working",
      startedAt: STARTED_AT,
      statusSince: null,
      links: {},
      stale: false,
      lastWriteAt: NOW - 10 * SECOND,
    });
  });

  test("with no folder, it takes its id", () => {
    expect(session({ cwd: null })).toMatchObject({
      name: `fx:${SESSION_ID}`,
      project: null,
      cwd: null,
    });
  });

  test("a finished session's status time is the last write", () => {
    expect(session({}, { programs: "none" })).toMatchObject({
      status: "finished",
      statusSince: NOW - 10 * SECOND,
    });
  });

  test("a failed session's status time is its line's, unless it is before the start", () => {
    expect(session({ tail: { turn: "ended", failed: true, at: NOW - 20 * SECOND } })).toMatchObject(
      {
        status: "failed",
        statusSince: NOW - 20 * SECOND,
      },
    );
    expect(
      session({ tail: { turn: "ended", failed: true, at: STARTED_AT - 3 * SECOND } }),
    ).toMatchObject({ status: "failed", statusSince: null });
    expect(
      session({ tail: { turn: "ended", failed: true, at: STARTED_AT - 2 * SECOND } }),
    ).toMatchObject({ status: "failed", statusSince: STARTED_AT - 2 * SECOND });
  });

  test("a last write before the start, or that cannot be right, is left out", () => {
    const before = session({}, { writtenAt: STARTED_AT - 3 * SECOND, programs: "none" });
    expect(before).not.toHaveProperty("lastWriteAt");
    expect(before.statusSince).toBeNull();
    expect(session({}, { writtenAt: NOW + 2 * 60_000 })).not.toHaveProperty("lastWriteAt");
    expect(session({ createdAt: 12 })).toMatchObject({ startedAt: null });
  });

  test("an unknown or between-turns session has no status time", () => {
    expect(session({ tail: { turn: "unknown" }, why: "unknown-end" })).toMatchObject({
      status: "unknown",
      statusSince: null,
    });
    expect(session({ tail: { turn: "ended", failed: false, at: NOW } })).toMatchObject({
      status: "unknown",
      statusSince: null,
    });
  });
});
