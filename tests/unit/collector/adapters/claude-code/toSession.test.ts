import { describe, expect, test } from "vitest";

import {
  projectOf,
  sessionFromFeed,
  sessionFromRegistry,
  uniqueById,
  type SessionContext,
} from "@collector/adapters/claude-code/toSession";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { EMPTY_WAIT_MEMORY, waitChanges } from "@core/sessions/waitChanges";
import { ids, pids } from "@tests/fixtures/claudeCode";
import { makeSession } from "@tests/fixtures/session";

const now = 1_700_000_100_000;
const day = 24 * 60 * 60 * 1000;
const context: SessionContext = { now, isAlive: () => true };

describe("sessionFromFeed", () => {
  test("a live session with its registry entry", () => {
    const session = sessionFromFeed(
      {
        pid: pids.permission,
        cwd: "/Users/example/code/demo",
        kind: "interactive",
        startedAt: 1_700_000_000_000,
        sessionId: ids.permission,
        name: "demo-project",
        status: "waiting",
        waitingFor: "permission prompt",
      },
      { pid: pids.permission, entrypoint: "claude-vscode", statusUpdatedAt: 1_700_000_030_000 },
      context,
    );
    expect(session).toEqual({
      id: `claude-code:${ids.permission}`,
      source: "claude-code",
      surface: "vscode",
      name: "demo-project",
      cwd: "/Users/example/code/demo",
      project: "demo",
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      startedAt: 1_700_000_000_000,
      statusSince: 1_700_000_030_000,
      pid: pids.permission,
      alive: true,
      links: { open: `vscode://anthropic.claude-code/open?session=${ids.permission}` },
      stale: false,
    });
  });

  test("without a registry entry the surface and status time are unknown, not guessed", () => {
    const session = sessionFromFeed(
      { pid: pids.idle, sessionId: ids.idle, cwd: "/Users/example/code/demo", status: "idle" },
      undefined,
      context,
    );
    expect(session.surface).toBe("unknown");
    expect(session.statusSince).toBeNull();
    expect(session.links).toEqual({});
    // Idle for an unknown length of time is not called stale.
    expect(session.stale).toBe(false);
  });

  test("the feed decides the session; the registry only adds surface and status time", () => {
    const session = sessionFromFeed(
      {
        pid: pids.busy,
        sessionId: ids.busy,
        name: "demo-project",
        cwd: "/Users/example/code/demo",
        status: "busy",
      },
      {
        pid: pids.busy,
        sessionId: ids.busy,
        name: "a-different-name",
        cwd: "/Users/example/code/elsewhere",
        status: "busy",
        entrypoint: "claude-desktop",
        statusUpdatedAt: 1_700_000_030_000,
      },
      context,
    );
    expect(session).toMatchObject({
      id: `claude-code:${ids.busy}`,
      name: "demo-project",
      cwd: "/Users/example/code/demo",
      status: "working",
      surface: "desktop",
      statusSince: 1_700_000_030_000,
    });
  });

  test("a registry file that gives another status adds the surface, and not its time", () => {
    const session = sessionFromFeed(
      { pid: pids.busy, sessionId: ids.busy, status: "busy" },
      {
        pid: pids.busy,
        sessionId: ids.busy,
        status: "waiting",
        waitingFor: "permission prompt",
        entrypoint: "claude-desktop",
        statusUpdatedAt: 1_700_000_030_000,
      },
      context,
    );
    expect(session).toMatchObject({ status: "working", surface: "desktop", statusSince: null });
    expect(session.waitingReason).toBeUndefined();
  });

  // The feed's answer is a few seconds old. The person answers, the registry
  // moves on at once, and the feed still says waiting until its next run.
  test("a wait answered while the feed still reports it is not read as a new wait", () => {
    const feed = {
      pid: pids.permission,
      sessionId: ids.permission,
      status: "waiting",
      waitingFor: "permission prompt",
    };
    const asked = sessionFromFeed(
      feed,
      {
        pid: pids.permission,
        sessionId: ids.permission,
        status: "waiting",
        statusUpdatedAt: now - 6_000,
      },
      context,
    );
    const answered = sessionFromFeed(
      feed,
      {
        pid: pids.permission,
        sessionId: ids.permission,
        status: "busy",
        statusUpdatedAt: now - 1_000,
      },
      context,
    );
    expect(asked).toMatchObject({ status: "needs-you", statusSince: now - 6_000 });
    expect(answered).toMatchObject({ status: "needs-you", statusSince: null });

    const snapshot = (session: Session): SessionsSnapshot => ({
      generatedAt: now,
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: now }],
      sessions: [session],
    });
    const { memory } = waitChanges(EMPTY_WAIT_MEMORY, snapshot(asked));
    expect(waitChanges(memory, snapshot(answered))).toMatchObject({ started: [], stopped: [] });
  });

  test("a file for the same session whose status time is before the start keeps its surface", () => {
    const session = sessionFromFeed(
      { pid: pids.idle, sessionId: ids.idle, startedAt: now - 1_000, status: "idle" },
      { pid: pids.idle, sessionId: ids.idle, entrypoint: "cli", statusUpdatedAt: now - 3 * day },
      context,
    );
    expect(session).toMatchObject({ surface: "terminal", statusSince: null, stale: false });
  });

  test("a registry file for the same pid that names another session is not used", () => {
    // A file left by an earlier process can carry the pid of a new one.
    const session = sessionFromFeed(
      { pid: pids.busy, sessionId: ids.busy, startedAt: now - 1_000, status: "idle" },
      {
        pid: pids.busy,
        sessionId: "00000000-0000-4000-8000-00000000ffff",
        entrypoint: "claude-desktop",
        statusUpdatedAt: now - 3 * day,
      },
      context,
    );
    expect(session).toMatchObject({
      surface: "unknown",
      startedAt: now - 1_000,
      statusSince: null,
      stale: false,
      links: {},
    });
  });

  test("a registry file whose status is older than the session is not used", () => {
    // Neither side names a session here, so the times are the only evidence.
    const session = sessionFromFeed(
      { pid: pids.busy, startedAt: now - 1_000, status: "idle" },
      { pid: pids.busy, entrypoint: "claude-desktop", statusUpdatedAt: now - 3 * day },
      context,
    );
    expect(session).toMatchObject({ surface: "unknown", statusSince: null, stale: false });
  });

  test("a status time a moment before the start time is the same moment", () => {
    const session = sessionFromFeed(
      { pid: pids.busy, sessionId: ids.busy, startedAt: now - 60_000, status: "idle" },
      { pid: pids.busy, sessionId: ids.busy, entrypoint: "cli", statusUpdatedAt: now - 60_200 },
      context,
    );
    expect(session).toMatchObject({ surface: "terminal", statusSince: now - 60_200 });
  });

  test("when only one side names the session, the pid is enough", () => {
    const session = sessionFromFeed(
      { pid: pids.busy, status: "busy" },
      { pid: pids.busy, sessionId: ids.busy, entrypoint: "claude-vscode" },
      context,
    );
    expect(session.surface).toBe("vscode");
  });

  test.each([
    ["zero", 0],
    ["a negative number", -5],
    ["seconds where milliseconds were expected", 1_700_000_000],
    ["an hour ahead of the clock", now + 60 * 60 * 1000],
  ])("a status time that is %s is not known, and never makes a session stale", (_label, time) => {
    const session = sessionFromFeed(
      { pid: pids.idle, sessionId: ids.idle, status: "idle" },
      { pid: pids.idle, sessionId: ids.idle, entrypoint: "cli", statusUpdatedAt: time },
      context,
    );
    // The surface comes from the same file and is still believed.
    expect(session).toMatchObject({ surface: "terminal", statusSince: null, stale: false });
  });

  test.each([
    ["zero", 0],
    ["a negative number", -5],
    ["seconds where milliseconds were expected", 1_700_000_000],
    ["an hour ahead of the clock", now + 60 * 60 * 1000],
  ])("a start time that is %s is not known", (_label, time) => {
    const session = sessionFromFeed(
      { pid: pids.idle, sessionId: ids.idle, status: "idle", startedAt: time },
      undefined,
      context,
    );
    expect(session.startedAt).toBeNull();
  });

  test("a name made only of spaces falls back like a missing one, and a real one is trimmed", () => {
    expect(
      sessionFromFeed(
        { pid: 4242, name: "   ", cwd: "/Users/example/code/demo" },
        undefined,
        context,
      ).name,
    ).toBe("demo");
    expect(sessionFromFeed({ pid: 4242, name: " \t " }, undefined, context).name).toBe(
      "claude-code:4242",
    );
    expect(sessionFromFeed({ pid: 4242, name: "  demo-project " }, undefined, context).name).toBe(
      "demo-project",
    );
  });

  test("a background job that failed is failed even while its process sits idle", () => {
    const session = sessionFromFeed(
      {
        pid: pids.idle,
        kind: "background",
        sessionId: ids.background,
        id: "job-0001",
        status: "idle",
        state: "failed",
      },
      undefined,
      context,
    );
    expect(session).toMatchObject({ status: "failed", pid: pids.idle, alive: true });
  });

  test("only VS Code sessions get a jump link", () => {
    for (const [entrypoint, link] of [
      ["claude-vscode", `vscode://anthropic.claude-code/open?session=${ids.busy}`],
      ["claude-desktop", undefined],
      ["cli", undefined],
    ] as const) {
      const session = sessionFromFeed(
        { pid: pids.busy, sessionId: ids.busy, status: "busy" },
        { pid: pids.busy, entrypoint },
        context,
      );
      expect(session.links.open).toBe(link);
    }
  });

  test("a session whose process was found in a tmux pane names the place, and only the place", () => {
    const pane = { pid: 4100, id: "%7", place: "checkout-flow:2.1" };
    const inTmux: SessionContext = {
      ...context,
      paneOf: (pid) => (pid === pids.busy ? pane : undefined),
    };
    const found = sessionFromRegistry(
      { pid: pids.busy, sessionId: ids.busy, status: "busy", entrypoint: "cli" },
      inTmux,
    );
    expect(found.jump).toEqual({ kind: "tmux", place: "checkout-flow:2.1" });
    expect(JSON.stringify(found)).not.toContain("%7");
    // From the command's answer as well, for when the registry is not relied on.
    expect(
      sessionFromFeed({ pid: pids.busy, sessionId: ids.busy, status: "busy" }, undefined, inTmux)
        .jump,
    ).toEqual({ kind: "tmux", place: "checkout-flow:2.1" });

    // A session in no pane, and any session when panes are not looked for, has none.
    const elsewhere = sessionFromRegistry({ pid: pids.idle, sessionId: ids.idle }, inTmux);
    expect("jump" in elsewhere).toBe(false);
    const unasked = sessionFromRegistry({ pid: pids.busy, sessionId: ids.busy }, context);
    expect("jump" in unasked).toBe(false);
  });

  test("a session whose process was found in a Terminal or iTerm2 tab names the app, and only the app", () => {
    const tab = { app: "iTerm2", tty: "/dev/ttys007" } as const;
    const inTab: SessionContext = {
      ...context,
      tabOf: (pid) => (pid === pids.busy ? tab : undefined),
    };
    const found = sessionFromRegistry(
      { pid: pids.busy, sessionId: ids.busy, status: "busy", entrypoint: "cli" },
      inTab,
    );
    expect(found.jump).toEqual({ kind: "terminal", app: "iTerm2", place: "iTerm2" });
    expect(JSON.stringify(found)).not.toContain("ttys007");
    expect(
      sessionFromFeed({ pid: pids.busy, sessionId: ids.busy, status: "busy" }, undefined, inTab)
        .jump,
    ).toEqual({ kind: "terminal", app: "iTerm2", place: "iTerm2" });
  });

  test("a session found in a tmux pane is reached through tmux, whatever tab it is in", () => {
    const both: SessionContext = {
      ...context,
      paneOf: () => ({ pid: 4100, id: "%7", place: "checkout-flow:2.1" }),
      tabOf: () => ({ app: "Terminal", tty: "/dev/ttys004" }),
    };
    const session = sessionFromRegistry({ pid: pids.busy, sessionId: ids.busy }, both);
    expect(session.jump).toEqual({ kind: "tmux", place: "checkout-flow:2.1" });
  });

  test("a session whose process has gone is not said to be in a tab", () => {
    const session = sessionFromRegistry(
      { pid: pids.busy, sessionId: ids.busy, status: "busy" },
      { now, isAlive: () => false, tabOf: () => ({ app: "Terminal", tty: "/dev/ttys004" }) },
    );
    expect("jump" in session).toBe(false);
  });

  test("a session whose process has gone is not said to be in a pane", () => {
    const session = sessionFromRegistry(
      { pid: pids.busy, sessionId: ids.busy, status: "busy" },
      {
        now,
        isAlive: () => false,
        paneOf: () => ({ pid: 4100, id: "%7", place: "checkout-flow:2.1" }),
      },
    );
    expect(session.alive).toBe(false);
    expect("jump" in session).toBe(false);
  });

  test("a background session with no live process has no pid and no liveness", () => {
    const session = sessionFromFeed(
      {
        cwd: "/Users/example/code/demo-jobs",
        kind: "background",
        startedAt: 1_700_000_004_000,
        sessionId: ids.background,
        name: "nightly-report",
        id: "job-0001",
        state: "failed",
      },
      undefined,
      context,
    );
    expect(session).toMatchObject({
      id: `claude-code:${ids.background}`,
      status: "failed",
      surface: "unknown",
    });
    expect("pid" in session).toBe(false);
    expect("alive" in session).toBe(false);
  });

  test("the id is the session id, then the job id, then the pid", () => {
    expect(
      sessionFromFeed({ sessionId: ids.busy, id: "job-0001", pid: 4242 }, undefined, context).id,
    ).toBe(`claude-code:${ids.busy}`);
    expect(sessionFromFeed({ id: "job-0001", pid: 4242 }, undefined, context).id).toBe(
      "claude-code:job-0001",
    );
    expect(sessionFromFeed({ pid: 4242 }, undefined, context).id).toBe("claude-code:4242");
  });

  test("the name falls back to the project folder, then to the id", () => {
    expect(
      sessionFromFeed({ pid: 4242, cwd: "/Users/example/code/demo" }, undefined, context).name,
    ).toBe("demo");
    expect(sessionFromFeed({ pid: 4242 }, undefined, context)).toMatchObject({
      name: "claude-code:4242",
      cwd: null,
      project: null,
      startedAt: null,
    });
  });

  test("a process that has gone is marked, not hidden", () => {
    const session = sessionFromFeed(
      { pid: pids.idle, sessionId: ids.idle, status: "idle" },
      undefined,
      { now, isAlive: (pid) => pid !== pids.idle },
    );
    expect(session).toMatchObject({ pid: pids.idle, alive: false, status: "idle" });
  });

  test("an idle session is stale once its status is 24 hours old", () => {
    const entry = { pid: pids.idle, sessionId: ids.idle, status: "idle" };
    const stale = sessionFromFeed(entry, { pid: pids.idle, statusUpdatedAt: now - day }, context);
    const fresh = sessionFromFeed(
      entry,
      { pid: pids.idle, statusUpdatedAt: now - day + 1 },
      context,
    );
    const busy = sessionFromFeed(
      { ...entry, status: "busy" },
      { pid: pids.idle, statusUpdatedAt: now - 7 * day },
      context,
    );
    expect(stale.stale).toBe(true);
    expect(fresh.stale).toBe(false);
    expect(busy.stale).toBe(false);
  });
});

describe("sessionFromRegistry", () => {
  test("builds the same session from the registry alone", () => {
    const session = sessionFromRegistry(
      {
        pid: pids.question,
        sessionId: ids.question,
        cwd: "/Users/example/code/demo-docs",
        startedAt: 1_700_000_002_000,
        kind: "interactive",
        entrypoint: "claude-desktop",
        name: "demo-docs",
        status: "waiting",
        waitingFor: "input needed",
        statusUpdatedAt: 1_700_000_050_000,
      },
      context,
    );
    expect(session).toEqual({
      id: `claude-code:${ids.question}`,
      source: "claude-code",
      surface: "desktop",
      name: "demo-docs",
      cwd: "/Users/example/code/demo-docs",
      project: "demo-docs",
      status: "needs-you",
      waitingReason: "question",
      waitingDetail: "input needed",
      startedAt: 1_700_000_002_000,
      statusSince: 1_700_000_050_000,
      pid: pids.question,
      alive: true,
      links: {},
      stale: false,
    });
  });

  test("the registry's shell status is working, as the feed reports such a session", () => {
    const session = sessionFromRegistry(
      { pid: pids.busy, sessionId: ids.busy, status: "shell" },
      context,
    );
    expect(session.status).toBe("working");
  });

  test("a registry status nobody has seen before is unknown", () => {
    const session = sessionFromRegistry(
      { pid: pids.busy, sessionId: ids.busy, status: "sleeping" },
      context,
    );
    expect(session.status).toBe("unknown");
  });

  test("a status time before the start time in the same file is not known", () => {
    const session = sessionFromRegistry(
      {
        pid: pids.idle,
        sessionId: ids.idle,
        status: "idle",
        startedAt: now - 60_000,
        statusUpdatedAt: now - 3 * day,
      },
      context,
    );
    expect(session).toMatchObject({ startedAt: now - 60_000, statusSince: null, stale: false });
  });

  test("a working session has no last write: its registry file is written when its status changes, not as it works", () => {
    const fromRegistry = sessionFromRegistry(
      {
        pid: pids.busy,
        sessionId: ids.busy,
        status: "busy",
        startedAt: now - 60 * 60_000,
        statusUpdatedAt: now - 40 * 60_000,
      },
      context,
    );
    const fromFeed = sessionFromFeed(
      { pid: pids.busy, sessionId: ids.busy, status: "busy" },
      { pid: pids.busy, sessionId: ids.busy, status: "busy", statusUpdatedAt: now - 40 * 60_000 },
      context,
    );
    for (const session of [fromRegistry, fromFeed]) {
      expect(session.status).toBe("working");
      expect(session).not.toHaveProperty("lastWriteAt");
    }
  });
});

describe("projectOf", () => {
  test("is the last segment of the working directory", () => {
    expect(projectOf("/Users/example/code/demo")).toBe("demo");
    expect(projectOf("/Users/example/code/demo/")).toBe("demo");
    expect(projectOf("C:\\Users\\example\\code\\demo")).toBe("demo");
    expect(projectOf("/")).toBeNull();
    expect(projectOf("")).toBeNull();
    expect(projectOf(undefined)).toBeNull();
  });
});

describe("uniqueById", () => {
  test("keeps one session per id, preferring the one whose process is alive", () => {
    const dead = makeSession({ id: "claude-code:a", pid: 1, alive: false });
    const alive = makeSession({ id: "claude-code:a", pid: 2, alive: true });
    const other = makeSession({ id: "claude-code:b", pid: 3, alive: true });
    expect(uniqueById([dead, alive, other])).toEqual([alive, other]);
    expect(uniqueById([alive, dead, other])).toEqual([alive, other]);
    expect(uniqueById([dead, { ...dead, pid: 9 }])).toEqual([dead]);
  });
});
