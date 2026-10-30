import { describe, expect, test } from "vitest";

import {
  anyKeepsAwake,
  KEEP_AWAKE_WORKING_MS,
  keepsAwake,
  LISTED_WORKING_SOURCE,
} from "@core/keep-awake/keepAwakeRule";
import type { Session, SessionStatus } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A session of an agent whose writes are measured, as Gemini CLI's are. */
const gemini = (overrides: Partial<Session>) =>
  makeSession({ id: "gemini-cli:session-1", source: "gemini-cli", ...overrides });

/** A session of OpenCode, which has no write time and whose working time is its turn's prompt. */
const opencode = (overrides: Partial<Session>) =>
  makeSession({ id: "opencode:ses_1", source: "opencode", ...overrides });

test("a working session stops counting 30 minutes after its newest update", () => {
  expect(KEEP_AWAKE_WORKING_MS).toBe(30 * MINUTE);
  expect(LISTED_WORKING_SOURCE).toBe("claude-code");
});

describe("a session that needs you", () => {
  test("counts for as long as it is listed, however long it has waited", () => {
    expect(keepsAwake(gemini({ status: "needs-you", statusSince: NOW - 3 * DAY }), NOW)).toBe(true);
    expect(
      keepsAwake(
        gemini({ status: "needs-you", statusSince: NOW - 3 * DAY, lastWriteAt: NOW - 3 * DAY }),
        NOW,
      ),
    ).toBe(true);
    expect(keepsAwake(gemini({ status: "needs-you", statusSince: null }), NOW)).toBe(true);
  });

  test("counts as working once Agent Lookout has answered its wait", () => {
    const answered = { status: "needs-you" as const, answered: true as const };
    expect(keepsAwake(gemini({ ...answered, statusSince: NOW - 5 * MINUTE }), NOW)).toBe(true);
    // Held to the working rule, so an old answered wait with an old write does not count.
    expect(
      keepsAwake(gemini({ ...answered, statusSince: NOW - HOUR, lastWriteAt: NOW - HOUR }), NOW),
    ).toBe(false);
    // A Claude Code session, which most answered waits are, counts while its process runs.
    expect(
      keepsAwake(makeSession({ ...answered, statusSince: NOW - HOUR, alive: true }), NOW),
    ).toBe(true);
  });
});

describe("a working session whose writes are measured", () => {
  const working = (lastWriteAt: number, statusSince: number | null = null) =>
    gemini({ status: "working", lastWriteAt, statusSince });

  test("counts while its last write is under 30 minutes old", () => {
    expect(keepsAwake(working(NOW), NOW)).toBe(true);
    expect(keepsAwake(working(NOW - 30 * MINUTE + 1_000), NOW)).toBe(true);
  });

  test("stops counting at 30 minutes, and after", () => {
    expect(keepsAwake(working(NOW - 30 * MINUTE), NOW)).toBe(false);
    expect(keepsAwake(working(NOW - 31 * MINUTE), NOW)).toBe(false);
    // A Gemini CLI session left working after its terminal closed.
    expect(keepsAwake(working(NOW - 20 * HOUR, NOW - 20 * HOUR), NOW)).toBe(false);
  });

  test("is judged by the newer of its status time and its last write", () => {
    expect(keepsAwake(working(NOW - HOUR, NOW - 5 * MINUTE), NOW)).toBe(true);
    expect(keepsAwake(working(NOW - 5 * MINUTE, NOW - HOUR), NOW)).toBe(true);
    expect(keepsAwake(working(NOW - HOUR, NOW - 45 * MINUTE), NOW)).toBe(false);
  });

  test("counts when its newest time is ahead of now, as after the clock is set back", () => {
    expect(keepsAwake(working(NOW + 10 * MINUTE), NOW)).toBe(true);
    expect(keepsAwake(working(NOW - HOUR, NOW + HOUR), NOW)).toBe(true);
  });

  test("is held to its status time when its write time was left out", () => {
    // A status file whose modified time was before its `since`, as a copy that kept an older time.
    const statusFile = { id: "status-files:night.json", source: "status-files" as const };
    expect(
      keepsAwake(
        makeSession({ ...statusFile, status: "working", statusSince: NOW - 72 * HOUR }),
        NOW,
      ),
    ).toBe(false);
    expect(
      keepsAwake(
        makeSession({ ...statusFile, status: "working", statusSince: NOW - 10 * MINUTE }),
        NOW,
      ),
    ).toBe(true);
    // A Gemini CLI session whose file time could not be right.
    expect(keepsAwake(gemini({ status: "working", statusSince: NOW - 20 * HOUR }), NOW)).toBe(
      false,
    );
    expect(keepsAwake(gemini({ status: "working", statusSince: NOW - 29 * MINUTE }), NOW)).toBe(
      true,
    );
  });

  test("does not count with neither time", () => {
    expect(keepsAwake(gemini({ status: "working", statusSince: null }), NOW)).toBe(false);
  });
});

describe("a working Claude Code session", () => {
  test("counts for as long as it is listed while its process runs, as its status time stays where its task began", () => {
    expect(
      keepsAwake(makeSession({ status: "working", statusSince: NOW - 2 * HOUR, alive: true }), NOW),
    ).toBe(true);
    expect(
      keepsAwake(makeSession({ status: "working", statusSince: null, alive: true }), NOW),
    ).toBe(true);
  });

  test("with no running process, as a background job between runs, is held to its status time", () => {
    // A `/loop` job or a routine shows as working between its runs, with no process.
    for (const alive of [undefined, false]) {
      expect(
        keepsAwake(makeSession({ status: "working", statusSince: NOW - 2 * HOUR, alive }), NOW),
        String(alive),
      ).toBe(false);
      expect(
        keepsAwake(makeSession({ status: "working", statusSince: NOW - 5 * MINUTE, alive }), NOW),
        String(alive),
      ).toBe(true);
      expect(
        keepsAwake(makeSession({ status: "working", statusSince: null, alive }), NOW),
        String(alive),
      ).toBe(false);
    }
  });

  test("goes by its source, not by its id, on this Mac", () => {
    // A session of another agent whose id happens to begin as Claude Code's is held to the time.
    expect(
      keepsAwake(
        makeSession({
          id: "claude-code:look-alike",
          source: "gemini-cli",
          status: "working",
          statusSince: NOW - 2 * HOUR,
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("a working OpenCode session", () => {
  test("counts until 30 minutes after the prompt that began its turn", () => {
    expect(keepsAwake(opencode({ status: "working", statusSince: NOW - 5 * MINUTE }), NOW)).toBe(
      true,
    );
    expect(keepsAwake(opencode({ status: "working", statusSince: NOW - 30 * MINUTE }), NOW)).toBe(
      false,
    );
  });

  test("left mid-step, does not count while OpenCode runs and it stays listed", () => {
    expect(keepsAwake(opencode({ status: "working", statusSince: NOW - 6 * HOUR }), NOW)).toBe(
      false,
    );
    expect(keepsAwake(opencode({ status: "working", statusSince: NOW - 23 * HOUR }), NOW)).toBe(
      false,
    );
  });

  test("with no time at all, does not count", () => {
    expect(keepsAwake(opencode({ status: "working", statusSince: null }), NOW)).toBe(false);
  });
});

describe("a session on another machine", () => {
  const there = (agent: string) => ({
    id: `remote:devbox:${agent}:session-1`,
    source: "remote:devbox" as const,
    machine: "devbox",
  });

  test("follows the same rule as one on this Mac", () => {
    expect(
      keepsAwake(
        makeSession({ ...there("gemini-cli"), status: "needs-you", statusSince: NOW - DAY }),
        NOW,
      ),
    ).toBe(true);
    expect(
      keepsAwake(
        makeSession({ ...there("gemini-cli"), status: "working", lastWriteAt: NOW - 5 * MINUTE }),
        NOW,
      ),
    ).toBe(true);
    expect(
      keepsAwake(
        makeSession({ ...there("gemini-cli"), status: "working", lastWriteAt: NOW - HOUR }),
        NOW,
      ),
    ).toBe(false);
    expect(keepsAwake(makeSession({ ...there("gemini-cli"), status: "idle" }), NOW)).toBe(false);
  });

  test("of Claude Code counts while it is listed, if that machine says its process runs", () => {
    const working = {
      ...there("claude-code"),
      status: "working" as const,
      statusSince: NOW - 2 * HOUR,
    };
    expect(keepsAwake(makeSession({ ...working, alive: true }), NOW)).toBe(true);
    expect(keepsAwake(makeSession({ ...working, alive: false }), NOW)).toBe(false);
    expect(keepsAwake(makeSession(working), NOW)).toBe(false);
  });

  test("whose Agent Lookout sends no write time is held to its status time", () => {
    expect(
      keepsAwake(
        makeSession({ ...there("gemini-cli"), status: "working", statusSince: NOW - 20 * HOUR }),
        NOW,
      ),
    ).toBe(false);
    expect(
      keepsAwake(
        makeSession({ ...there("opencode"), status: "working", statusSince: NOW - 6 * HOUR }),
        NOW,
      ),
    ).toBe(false);
  });

  test("whose id names no agent after the machine is held to its status time", () => {
    for (const id of ["claude-code:session-1", "remote:devbox:claude-codex:1", "remote:devbox:x"]) {
      expect(
        keepsAwake(
          makeSession({
            id,
            source: "remote:devbox",
            machine: "devbox",
            status: "working",
            statusSince: NOW - 2 * HOUR,
            // A running process, so only the id decides.
            alive: true,
          }),
          NOW,
        ),
      ).toBe(false);
    }
  });
});

test.each<SessionStatus>(["idle", "finished", "failed", "unknown"])(
  "a session that is %s never counts",
  (status) => {
    for (const session of [makeSession, gemini, opencode]) {
      expect(keepsAwake(session({ status, statusSince: NOW, lastWriteAt: NOW }), NOW)).toBe(false);
      expect(keepsAwake(session({ status, statusSince: null }), NOW)).toBe(false);
      expect(keepsAwake(session({ status, stale: true, statusSince: NOW - DAY }), NOW)).toBe(false);
    }
  },
);

test("anyKeepsAwake is true when one session counts, and false for none", () => {
  expect(anyKeepsAwake([], NOW)).toBe(false);
  expect(
    anyKeepsAwake([makeSession({ status: "idle" }), makeSession({ status: "finished" })], NOW),
  ).toBe(false);
  expect(
    anyKeepsAwake([makeSession({ status: "idle" }), makeSession({ status: "needs-you" })], NOW),
  ).toBe(true);
});
