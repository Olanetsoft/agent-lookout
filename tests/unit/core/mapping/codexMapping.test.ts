import { describe, expect, test } from "vitest";

import {
  codexLiveness,
  isCodexSessionSource,
  isImportedCodexTurn,
  keepsWriterLocks,
  mapCodexStatus,
  mapCodexSurface,
  type CodexLiveness,
} from "@core/mapping/codexMapping";
import type { SessionStatus } from "@core/sessions/session";

const LIVENESS: CodexLiveness[] = [true, false, "unknown"];

describe("mapCodexStatus", () => {
  // Every row of the table in codexMapping.ts and docs/adapters/codex.md:
  // [last turn line, open, not open, no lock folder].
  test.each<[unknown, SessionStatus, SessionStatus, SessionStatus]>([
    ["task_started", "working", "finished", "working"],
    ["turn_started", "working", "finished", "working"],
    ["task_complete", "idle", "finished", "idle"],
    ["turn_complete", "idle", "finished", "idle"],
    ["turn_aborted", "idle", "finished", "idle"],
    // The whole file was read and holds no turn line yet.
    [null, "idle", "finished", "idle"],
  ])(
    "a last turn line of %j is %s while open, %s once closed, %s with no lock folder",
    (lastTurn, open, closed, noLocks) => {
      expect(mapCodexStatus({ lastTurn, live: true })).toBe(open);
      expect(mapCodexStatus({ lastTurn, live: false })).toBe(closed);
      expect(mapCodexStatus({ lastTurn, live: "unknown" })).toBe(noLocks);
    },
  );

  test.each([
    // A turn line it has never seen, such as one Codex adds later.
    "task_paused",
    "turn_waiting_for_approval",
    "exec_approval_request",
    "",
    "TASK_STARTED",
    // Not found within the scan limit.
    undefined,
    7,
    {},
  ])("%j is unknown, whatever the lock says, rather than a guess", (lastTurn) => {
    for (const live of LIVENESS) {
      expect(mapCodexStatus({ lastTurn, live })).toBe("unknown");
    }
  });

  test("never says a Codex session needs you, for any input", () => {
    const turns: unknown[] = [
      "task_started",
      "turn_started",
      "task_complete",
      "turn_complete",
      "turn_aborted",
      "exec_approval_request",
      "apply_patch_approval_request",
      "request_permissions",
      "request_user_input",
      "elicitation_request",
      "needs-you",
      "error",
      "shutdown_complete",
      null,
      undefined,
    ];
    const seen = new Set<SessionStatus>();
    for (const lastTurn of turns) {
      for (const live of LIVENESS) seen.add(mapCodexStatus({ lastTurn, live }));
    }
    expect(seen.has("needs-you")).toBe(false);
    expect(seen.has("failed")).toBe(false);
    expect([...seen].sort()).toEqual(["finished", "idle", "unknown", "working"]);
  });
});

describe("mapCodexSurface", () => {
  test.each([
    ["cli", "terminal"],
    ["exec", "terminal"],
    ["vscode", "vscode"],
    [{ custom: "chatgpt" }, "desktop"],
    // Codex lists the Atlas browser as interactive, but nothing says what it looks like here.
    [{ custom: "atlas" }, "unknown"],
    [{ custom: "something-new" }, "unknown"],
    ["mcp", "unknown"],
    ["something-new", "unknown"],
    ["CLI", "unknown"],
    [undefined, "unknown"],
    [null, "unknown"],
    [42, "unknown"],
    [["cli"], "unknown"],
    [{}, "unknown"],
  ])("a source of %j is shown as %s", (source, surface) => {
    expect(mapCodexSurface(source)).toBe(surface);
  });

  test("the Codex desktop app is known by its originator, since it records its sessions as vscode", () => {
    expect(mapCodexSurface("vscode", "Codex Desktop")).toBe("desktop");
    // Whatever the source says.
    expect(mapCodexSurface("cli", "Codex Desktop")).toBe("desktop");
    expect(mapCodexSurface(undefined, "Codex Desktop")).toBe("desktop");
  });

  test.each([
    ["codex_cli_rs", "cli", "terminal"],
    ["codex_vscode", "vscode", "vscode"],
    ["codex desktop", "vscode", "vscode"],
    ["Codex Desktop ", "vscode", "vscode"],
    [undefined, "vscode", "vscode"],
    [42, "vscode", "vscode"],
  ])("any other originator, such as %j, leaves it to the source", (originator, source, surface) => {
    expect(mapCodexSurface(source, originator)).toBe(surface);
  });
});

describe("keepsWriterLocks", () => {
  test.each(["0.155.0", "0.155.1", "0.160.0", "0.200.3", "1.0.0", "0.160.0+build.7"])(
    "Codex %s keeps a lock for each open session",
    (version) => {
      expect(keepsWriterLocks(version)).toBe(true);
    },
  );

  test.each([
    "0.154.0",
    "0.150.2",
    "0.99.0",
    // A pre-release of 0.155.0 comes before it, and not every one had locks.
    "0.155.0-alpha.9",
    // A build from source calls itself 0.0.0.
    "0.0.0",
    "",
    "0.160",
    "v0.160.0",
    "0.160.0.1",
    "latest",
    undefined,
    null,
    160,
  ])("%j does not", (version) => {
    expect(keepsWriterLocks(version)).toBe(false);
  });
});

describe("codexLiveness", () => {
  test("a session whose lock is there is open, whatever made it", () => {
    for (const cliVersion of ["0.160.0", "0.150.0", undefined]) {
      expect(codexLiveness({ lockFolder: true, locked: true, cliVersion })).toBe(true);
    }
  });

  test("a missing lock means closed only for a session made by a Codex that keeps locks", () => {
    expect(codexLiveness({ lockFolder: true, locked: false, cliVersion: "0.160.0" })).toBe(false);
    expect(codexLiveness({ lockFolder: true, locked: false, cliVersion: "0.150.0" })).toBe(
      "unknown",
    );
    expect(codexLiveness({ lockFolder: true, locked: false, cliVersion: undefined })).toBe(
      "unknown",
    );
  });

  test("with no lock folder nothing is known", () => {
    for (const cliVersion of ["0.160.0", "0.150.0", undefined]) {
      expect(codexLiveness({ lockFolder: false, locked: false, cliVersion })).toBe("unknown");
    }
  });

  test("a mid-turn session from an older Codex with no lock is working, not finished", () => {
    const live = codexLiveness({ lockFolder: true, locked: false, cliVersion: "0.150.0" });
    expect(mapCodexStatus({ lastTurn: "task_started", live })).toBe("working");
  });
});

describe("isImportedCodexTurn", () => {
  test.each(["external-import-turn-1", "external-import-turn-432"])("%s was imported", (id) => {
    expect(isImportedCodexTurn(id)).toBe(true);
  });

  test.each([
    "019a0000-0000-7000-8000-000000000001",
    "turn-0001",
    "external-import-turn-",
    "external-import-turn-x",
    "an external-import-turn-1",
    "",
    undefined,
    null,
    1,
  ])("%j was not", (id) => {
    expect(isImportedCodexTurn(id)).toBe(false);
  });
});

describe("isCodexSessionSource", () => {
  test.each([
    ["cli"],
    ["vscode"],
    ["exec"],
    [{ custom: "chatgpt" }],
    [{ custom: "atlas" }],
    // Nothing says these are helpers, so they are kept.
    [undefined],
    ["something-new"],
    [{ custom: "something-new" }],
    [42],
  ])("a session started from %j is listed", (source) => {
    expect(isCodexSessionSource(source)).toBe(true);
    expect(isCodexSessionSource(source, {})).toBe(true);
  });

  test.each([
    ["mcp"],
    ["subagent"],
    ["internal"],
    [{ subagent: { thread_spawn: { depth: 1 } } }],
    [{ subagent: "review" }],
    [{ internal: "memory_consolidation" }],
  ])("a thread from %j belongs to something already listed, so it is left out", (source) => {
    expect(isCodexSessionSource(source)).toBe(false);
  });

  test("a thread that names a parent is left out, whatever its source", () => {
    const parent = "00000000-0000-4000-8000-0000000000c1";
    expect(isCodexSessionSource("cli", { parentThreadId: parent })).toBe(false);
    expect(isCodexSessionSource(undefined, { parentThreadId: parent })).toBe(false);
    // An empty or odd parent names nothing.
    expect(isCodexSessionSource("cli", { parentThreadId: "" })).toBe(true);
    expect(isCodexSessionSource("cli", { parentThreadId: 7 })).toBe(true);
  });

  test.each(["subagent", "guardian_review", "memory_consolidation"])(
    "a thread whose thread_source is %s is left out",
    (threadSource) => {
      expect(isCodexSessionSource("cli", { threadSource })).toBe(false);
    },
  );

  test("other thread sources leave the decision to the source", () => {
    expect(isCodexSessionSource("cli", { threadSource: "user" })).toBe(true);
    expect(isCodexSessionSource("mcp", { threadSource: "user" })).toBe(false);
  });
});
