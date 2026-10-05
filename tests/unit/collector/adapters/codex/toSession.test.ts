import { describe, expect, test } from "vitest";

import type { RolloutState } from "@collector/adapters/codex/rolloutFile";
import { codexSession, lastActivity, SOURCE_ID } from "@collector/adapters/codex/toSession";
import { STALE_THRESHOLD_MS } from "@core/sessions/staleness";
import { CLOCK_SLACK_MS } from "@core/time";
import { at, DAY, ids, MINUTE, NOW } from "@tests/fixtures/codex";

const START = NOW - 30 * MINUTE;

function state(overrides: Partial<RolloutState> = {}): RolloutState {
  return {
    meta: { id: ids.working, timestamp: at(START), cwd: "/Users/example/code/demo", source: "cli" },
    lastTurn: "task_started",
    lastTurnAt: NOW - 10 * MINUTE,
    lastTurnImported: false,
    lastLineAt: NOW - 5 * MINUTE,
    ...overrides,
  };
}

describe("codexSession", () => {
  test("a working session in the shared model, with no pid, no process and no link", () => {
    const session = codexSession({ threadId: ids.working, state: state(), live: true, now: NOW });
    expect(session).toEqual({
      id: `codex:${ids.working}`,
      source: "codex",
      surface: "terminal",
      name: "demo",
      cwd: "/Users/example/code/demo",
      project: "demo",
      status: "working",
      startedAt: START,
      statusSince: NOW - 10 * MINUTE,
      links: {},
      stale: false,
    });
    expect(SOURCE_ID).toBe("codex");
    expect(session).not.toHaveProperty("pid");
    expect(session).not.toHaveProperty("alive");
    expect(session).not.toHaveProperty("waitingReason");
  });

  test("the name is the one given in Codex, then the folder, then the id", () => {
    const named = (name: string | undefined, cwd?: string) =>
      codexSession({
        threadId: ids.working,
        state: state({ meta: { cwd, source: "cli" } }),
        name,
        live: true,
        now: NOW,
      }).name;
    expect(named("demo-project", "/Users/example/code/demo")).toBe("demo-project");
    expect(named("  demo-project  ", "/Users/example/code/demo")).toBe("demo-project");
    expect(named("   ", "/Users/example/code/demo")).toBe("demo");
    expect(named(undefined, "/Users/example/code/demo")).toBe("demo");
    expect(named(undefined, undefined)).toBe(`codex:${ids.working}`);
  });

  test("the surface comes from where the session was started", () => {
    const surface = (meta: RolloutState["meta"]) =>
      codexSession({ threadId: ids.working, state: state({ meta }), live: true, now: NOW }).surface;
    expect(surface({ source: "vscode" })).toBe("vscode");
    expect(surface({ source: { custom: "chatgpt" } })).toBe("desktop");
    expect(surface({ source: "exec" })).toBe("terminal");
    expect(surface({})).toBe("unknown");
    expect(surface(null)).toBe("unknown");
  });

  test.each([
    // [what the file says, the lock, status, since]
    [{ lastTurn: "task_started" }, true, "working", NOW - 10 * MINUTE],
    [{ lastTurn: "task_complete" }, true, "idle", NOW - 10 * MINUTE],
    [{ lastTurn: "turn_aborted" }, "unknown", "idle", NOW - 10 * MINUTE],
    // A session that has not begun a turn has been idle since its last line.
    [{ lastTurn: null, lastTurnAt: null }, true, "idle", NOW - 5 * MINUTE],
    // A session that has ended has been finished since its last line.
    [{ lastTurn: "task_started" }, false, "finished", NOW - 5 * MINUTE],
    [{ lastTurn: "task_complete" }, false, "finished", NOW - 5 * MINUTE],
    // An unknown status has no time.
    [{ lastTurn: "turn_paused" }, true, "unknown", null],
    [{ lastTurn: undefined }, false, "unknown", null],
  ] as const)("%j with the lock %j is %s since %j", (fields, live, status, since) => {
    const session = codexSession({ threadId: ids.working, state: state(fields), live, now: NOW });
    expect(session.status).toBe(status);
    expect(session.statusSince).toBe(since);
  });

  test("times that cannot be right are not known", () => {
    const future = NOW + CLOCK_SLACK_MS + 1;
    const session = codexSession({
      threadId: ids.working,
      state: state({ meta: { timestamp: at(future) }, lastTurnAt: future }),
      live: true,
      now: NOW,
    });
    expect(session.startedAt).toBeNull();
    expect(session.statusSince).toBeNull();

    const before2020 = codexSession({
      threadId: ids.working,
      state: state({
        meta: { timestamp: "2019-12-31T23:59:59.000Z" },
        lastTurnAt: Date.UTC(2019, 0, 1),
      }),
      live: true,
      now: NOW,
    });
    expect(before2020.startedAt).toBeNull();
    expect(before2020.statusSince).toBeNull();

    const unreadable = codexSession({
      threadId: ids.working,
      state: state({ meta: { timestamp: "yesterday" } }),
      live: true,
      now: NOW,
    });
    expect(unreadable.startedAt).toBeNull();
  });

  test("a status time from before the session began is not believed, but a moment before is", () => {
    const since = (lastTurnAt: number) =>
      codexSession({ threadId: ids.working, state: state({ lastTurnAt }), live: true, now: NOW })
        .statusSince;
    expect(since(START - 1_000)).toBe(START - 1_000);
    expect(since(START - 1_001)).toBeNull();
  });

  test("an idle session is stale after a day idle, and a working one never", () => {
    const idleFor = (ms: number) =>
      codexSession({
        threadId: ids.working,
        state: state({
          meta: { timestamp: at(NOW - 3 * DAY) },
          lastTurn: "task_complete",
          lastTurnAt: NOW - ms,
        }),
        live: true,
        now: NOW,
      });
    expect(idleFor(STALE_THRESHOLD_MS).stale).toBe(true);
    expect(idleFor(STALE_THRESHOLD_MS - 1).stale).toBe(false);

    const busy = codexSession({
      threadId: ids.working,
      state: state({ meta: { timestamp: at(NOW - 3 * DAY) }, lastTurnAt: NOW - 2 * DAY }),
      live: true,
      now: NOW,
    });
    expect(busy.status).toBe("working");
    expect(busy.stale).toBe(false);
  });

  test("never needs you, whatever the file and the lock say", () => {
    for (const lastTurn of [
      "task_started",
      "task_complete",
      "turn_aborted",
      "exec_approval_request",
      null,
      undefined,
    ]) {
      for (const live of [true, false, "unknown"] as const) {
        const session = codexSession({
          threadId: ids.working,
          state: state({ lastTurn }),
          live,
          now: NOW,
        });
        expect(session.status).not.toBe("needs-you");
        expect(session).not.toHaveProperty("waitingReason");
      }
    }
  });
});

describe("lastActivity", () => {
  test("is the last line's time, then the last turn's, then the start", () => {
    expect(lastActivity(state(), NOW)).toBe(NOW - 5 * MINUTE);
    expect(lastActivity(state({ lastLineAt: null }), NOW)).toBe(NOW - 10 * MINUTE);
    expect(lastActivity(state({ lastLineAt: null, lastTurnAt: null }), NOW)).toBe(START);
    expect(lastActivity(state({ lastLineAt: null, lastTurnAt: null, meta: null }), NOW)).toBeNull();
  });

  test("a time that cannot be right is passed over", () => {
    expect(lastActivity(state({ lastLineAt: NOW + CLOCK_SLACK_MS + 1 }), NOW)).toBe(
      NOW - 10 * MINUTE,
    );
    expect(lastActivity(state({ lastLineAt: 1_000 }), NOW)).toBe(NOW - 10 * MINUTE);
  });
});
