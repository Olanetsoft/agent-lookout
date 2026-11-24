import { describe, expect, test } from "vitest";

import {
  sessionFromFeed,
  sessionFromRegistry,
  uniqueById,
  type SessionContext,
} from "@collector/adapters/claude-code/toSession";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import { EMPTY_WAIT_MEMORY, waitChanges } from "@core/notices/sessionChanges";
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

  test("a name is cleaned and cut as every other agent's: the marks that reorder text and control characters become spaces", () => {
    const named = (name: string) =>
      sessionFromFeed({ pid: 4242, name, cwd: "/Users/example/code/demo" }, undefined, context)
        .name;
    expect(named("docs‮gnp.exe")).toBe("docs gnp.exe");
    expect(named("checkout‏flow\u0007")).toBe("checkout flow");
    expect(named("‪‬")).toBe("demo");
    expect(Array.from(named("x".repeat(300)))).toHaveLength(200);
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

  describe("a session of the VS Code extension found under its editor", () => {
    const bundle = "/Applications/Visual Studio Code.app";
    const editor = { app: "VS Code", bundle } as const;
    const inEditor: SessionContext = {
      ...context,
      homeDirs: ["/Users/example"],
      editorOf: (pid) => (pid === pids.busy ? editor : undefined),
    };
    const vscode = {
      pid: pids.busy,
      sessionId: ids.busy,
      status: "busy",
      entrypoint: "claude-vscode",
      cwd: "/Users/example/code/demo",
    };

    test("is reached through the editor's window, names only the editor, and keeps its link", () => {
      const found = sessionFromRegistry(vscode, inEditor);

      expect(found.jump).toEqual({ kind: "editor", app: "VS Code", place: "VS Code" });
      expect(found.links.open).toBe(`vscode://anthropic.claude-code/open?session=${ids.busy}`);
      expect(JSON.stringify(found)).not.toContain("Visual Studio Code.app");
      // From the command's answer as well, enriched from its registry file.
      expect(
        sessionFromFeed(
          {
            pid: pids.busy,
            sessionId: ids.busy,
            status: "busy",
            cwd: "/Users/example/code/demo",
          },
          { pid: pids.busy, sessionId: ids.busy, entrypoint: "claude-vscode" },
          inEditor,
        ).jump,
      ).toEqual({ kind: "editor", app: "VS Code", place: "VS Code" });
    });

    test("the editor comes before a pane and a tab", () => {
      const all: SessionContext = {
        ...inEditor,
        paneOf: () => ({ pid: 4100, id: "%7", place: "checkout-flow:2.1" }),
        tabOf: () => ({ app: "Terminal", tty: "/dev/ttys004" }),
      };
      expect(sessionFromRegistry(vscode, all).jump?.kind).toBe("editor");
    });

    test.each<[string, Record<string, unknown>, Partial<SessionContext>]>([
      ["a session in a terminal", { entrypoint: "cli" }, {}],
      ["a session whose process has gone", {}, { isAlive: () => false }],
      ["a session with no folder", { cwd: undefined }, {}],
      ["a session in a relative folder", { cwd: "code/demo" }, {}],
      ["a session in a folder inside an app", { cwd: "/Applications/Calculator.app" }, {}],
      ["a session in the home folder", { cwd: "/Users/example" }, {}],
      [
        "a session in the home folder as its links lead",
        { cwd: "/Volumes/Data/example" },
        { homeDirs: ["/Users/example", "/Volumes/Data/example"] },
      ],
      ["a session in /", { cwd: "/" }, {}],
      ["a session read with no home folder to compare", {}, { homeDirs: undefined }],
    ])("%s is given no editor, and keeps what it had", (_what, fields, changes) => {
      const session = sessionFromRegistry({ ...vscode, ...fields }, { ...inEditor, ...changes });

      expect("jump" in session).toBe(false);
      if (fields.entrypoint === undefined) {
        expect(session.links.open).toBe(`vscode://anthropic.claude-code/open?session=${ids.busy}`);
      }
    });

    test("a session in a terminal found under the editor keeps its tab", () => {
      const session = sessionFromRegistry(
        { ...vscode, entrypoint: "cli" },
        { ...inEditor, tabOf: () => ({ app: "Terminal", tty: "/dev/ttys004" }) },
      );
      expect(session.jump).toEqual({ kind: "terminal", app: "Terminal", place: "Terminal" });
    });
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

describe("a live background job", () => {
  const askedAt = now - 10_000;
  const file = {
    pid: pids.idle,
    sessionId: ids.background,
    kind: "bg",
    status: "idle",
    waitingFor: "permission prompt",
    statusUpdatedAt: askedAt,
  };
  const listed = {
    pid: pids.idle,
    sessionId: ids.background,
    id: "job-0001",
    status: "idle",
    state: "blocked",
  };
  const shown = (
    fileChanges: Record<string, unknown> = {},
    listedChanges: Record<string, unknown> = {},
  ) =>
    sessionFromRegistry({ ...file, ...fileChanges }, context, {
      askedAt,
      entries: [{ ...listed, ...listedChanges }],
    });

  test("takes the state the command gave it, and what it waits for", () => {
    const blocked = shown();
    expect(blocked).toMatchObject({
      status: "needs-you",
      waitingReason: "other",
      statusSince: askedAt,
    });
    expect(blocked.waitingDetail).toBeUndefined();
    expect(shown({}, { waitingFor: "input needed" })).toMatchObject({
      waitingReason: "question",
      waitingDetail: "input needed",
    });
    expect(shown({}, { state: "working" }).status).toBe("idle");
  });

  test.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ["went idle after the command was asked", { statusUpdatedAt: askedAt + 1 }, {}, "idle"],
    ["does not say when it went idle", { statusUpdatedAt: undefined }, {}, "idle"],
    ["says it went idle at no real time", { statusUpdatedAt: 5 }, {}, "idle"],
    ["works", { status: "busy" }, {}, "working"],
    ["is in a shell", { status: "shell" }, {}, "working"],
    ["holds a state of its own", { state: "done" }, {}, "finished"],
    ["was busy when the command was asked", {}, { status: "busy" }, "idle"],
    ["had no process when the command was asked", {}, { status: undefined }, "idle"],
    ["is another process", {}, { pid: pids.busy }, "idle"],
    ["was listed with no process", {}, { pid: undefined }, "idle"],
    ["is another session's process", {}, { sessionId: ids.idle }, "idle"],
  ])("that %s keeps what its file says", (_what, fileChanges, listedChanges, status) => {
    expect(shown(fileChanges, listedChanges).status).toBe(status);
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

  const copy = (pid: number, status: Session["status"], statusSince: number | null) =>
    makeSession({ id: "claude-code:a", pid, alive: true, status, statusSince });

  test.each<[string, Session, Session]>([
    ["that waits, before one that works", copy(1, "needs-you", now - 9), copy(2, "working", now)],
    ["that waits, before an idle one", copy(1, "needs-you", now - 9), copy(2, "idle", now)],
    ["that works, before an idle one", copy(1, "working", now - 9), copy(2, "idle", now)],
    ["that works, before a finished one", copy(1, "working", now - 9), copy(2, "finished", now)],
    ["whose wait began last", copy(1, "needs-you", now), copy(2, "needs-you", now - 9)],
    ["that went idle last", copy(1, "idle", now), copy(2, "idle", now - 9)],
    ["that finished after the other went idle", copy(1, "finished", now), copy(2, "idle", now - 9)],
    ["whose time is known", copy(1, "working", now - 9), copy(2, "working", null)],
  ])("of two live copies keeps the one %s, in either order", (_which, shown, hidden) => {
    expect(uniqueById([shown, hidden])).toEqual([shown]);
    expect(uniqueById([hidden, shown])).toEqual([shown]);
  });

  test("a copy that waits but has no process is not kept over one that has", () => {
    const gone = { ...copy(1, "needs-you", now), alive: false };
    const listed = makeSession({ id: "claude-code:a", status: "needs-you", statusSince: now });
    const idle = copy(2, "idle", now - 9);
    expect(uniqueById([gone, idle])).toEqual([idle]);
    expect(uniqueById([idle, gone])).toEqual([idle]);
    expect(uniqueById([listed, idle])).toEqual([idle]);
  });
});
