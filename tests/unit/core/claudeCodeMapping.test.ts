import { describe, expect, test } from "vitest";

import {
  claudeCodeOpenLink,
  isClaudeCodeSessionKind,
  mapClaudeCodeStatus,
  mapClaudeCodeSurface,
  mapClaudeCodeWaitingFor,
} from "@core/claudeCodeMapping";

describe("mapClaudeCodeStatus", () => {
  test.each([
    ["busy", "working"],
    ["idle", "idle"],
  ] as const)("a live process that is %s is %s", (status, expected) => {
    expect(mapClaudeCodeStatus({ status })).toEqual({ status: expected });
  });

  test("a waiting process needs you, with the vendor's wording kept", () => {
    expect(mapClaudeCodeStatus({ status: "waiting", waitingFor: "permission prompt" })).toEqual({
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
    });
    expect(mapClaudeCodeStatus({ status: "waiting", waitingFor: "input needed" })).toEqual({
      status: "needs-you",
      waitingReason: "question",
      waitingDetail: "input needed",
    });
  });

  test.each(["sandbox request", "worker request", "dialog open", "goal proposal"])(
    "waiting for %s is the reason other, kept verbatim",
    (waitingFor) => {
      expect(mapClaudeCodeStatus({ status: "waiting", waitingFor })).toEqual({
        status: "needs-you",
        waitingReason: "other",
        waitingDetail: waitingFor,
      });
    },
  );

  test("a waiting process that does not say why has the reason other and no detail", () => {
    expect(mapClaudeCodeStatus({ status: "waiting" })).toEqual({
      status: "needs-you",
      waitingReason: "other",
    });
  });

  test.each([
    ["working", "working"],
    ["done", "finished"],
    ["stopped", "finished"],
    ["failed", "failed"],
  ] as const)("a background session whose state is %s is %s", (state, expected) => {
    expect(mapClaudeCodeStatus({ state })).toEqual({ status: expected });
  });

  test("a blocked background session needs you", () => {
    expect(mapClaudeCodeStatus({ state: "blocked", waitingFor: "permission prompt" })).toEqual({
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
    });
    expect(mapClaudeCodeStatus({ state: "blocked" })).toEqual({
      status: "needs-you",
      waitingReason: "other",
    });
  });

  test("a live status wins over the background state", () => {
    expect(mapClaudeCodeStatus({ status: "busy", state: "blocked" })).toEqual({
      status: "working",
    });
  });

  test("a busy or waiting process wins over a background state that says it is over", () => {
    expect(mapClaudeCodeStatus({ status: "busy", state: "failed" })).toEqual({ status: "working" });
    expect(mapClaudeCodeStatus({ status: "busy", state: "done" })).toEqual({ status: "working" });
    expect(
      mapClaudeCodeStatus({ status: "waiting", state: "done", waitingFor: "input needed" }),
    ).toEqual({ status: "needs-you", waitingReason: "question", waitingDetail: "input needed" });
  });

  test.each([
    ["done", "finished"],
    ["stopped", "finished"],
    ["failed", "failed"],
  ] as const)(
    "a background job that is %s is %s even while its process sits idle",
    (state, expected) => {
      expect(mapClaudeCodeStatus({ status: "idle", state })).toEqual({ status: expected });
    },
  );

  test("a blocked background job needs you even while its process sits idle", () => {
    expect(mapClaudeCodeStatus({ status: "idle", state: "blocked" })).toEqual({
      status: "needs-you",
      waitingReason: "other",
    });
  });

  test("an idle process whose background job is still working is idle", () => {
    expect(mapClaudeCodeStatus({ status: "idle", state: "working" })).toEqual({ status: "idle" });
    expect(mapClaudeCodeStatus({ status: "idle", state: "something new" })).toEqual({
      status: "idle",
    });
  });

  test("an unrecognised live status falls back to the background state", () => {
    expect(mapClaudeCodeStatus({ status: "shell", state: "working" })).toEqual({
      status: "working",
    });
  });

  test("the registry's shell status is working, as the feed itself reports it", () => {
    expect(mapClaudeCodeStatus({ status: "shell" }, "registry")).toEqual({ status: "working" });
    // The feed never prints `shell`, so there it stays unrecognised.
    expect(mapClaudeCodeStatus({ status: "shell" }, "feed")).toEqual({ status: "unknown" });
    expect(mapClaudeCodeStatus({ status: "shell" })).toEqual({ status: "unknown" });
  });

  test("the registry's other statuses map exactly as the feed's do", () => {
    expect(mapClaudeCodeStatus({ status: "busy" }, "registry")).toEqual({ status: "working" });
    expect(mapClaudeCodeStatus({ status: "idle" }, "registry")).toEqual({ status: "idle" });
    expect(
      mapClaudeCodeStatus({ status: "waiting", waitingFor: "permission prompt" }, "registry"),
    ).toEqual({
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
    });
    expect(mapClaudeCodeStatus({ status: "sleeping" }, "registry")).toEqual({ status: "unknown" });
    expect(mapClaudeCodeStatus({ status: "constructor" }, "registry")).toEqual({
      status: "unknown",
    });
  });

  test("anything unrecognised is unknown, never a guess", () => {
    expect(mapClaudeCodeStatus({})).toEqual({ status: "unknown" });
    expect(mapClaudeCodeStatus({ status: "shell" })).toEqual({ status: "unknown" });
    expect(mapClaudeCodeStatus({ status: 3, state: null })).toEqual({ status: "unknown" });
    // Names every object has must not be mistaken for a status.
    expect(mapClaudeCodeStatus({ status: "constructor", state: "toString" })).toEqual({
      status: "unknown",
    });
  });

  test("the waiting fields appear only when the session needs you", () => {
    const mapped = mapClaudeCodeStatus({ status: "idle", waitingFor: "permission prompt" });
    expect(mapped).toEqual({ status: "idle" });
    expect("waitingReason" in mapped).toBe(false);
    expect("waitingDetail" in mapped).toBe(false);
  });
});

describe("mapClaudeCodeWaitingFor", () => {
  test("matching ignores case and surrounding space but the detail stays verbatim", () => {
    expect(mapClaudeCodeWaitingFor(" Permission Prompt ")).toEqual({
      waitingReason: "permission",
      waitingDetail: " Permission Prompt ",
    });
  });

  test("an empty or non-text value has no detail", () => {
    expect(mapClaudeCodeWaitingFor("")).toEqual({ waitingReason: "other" });
    expect(mapClaudeCodeWaitingFor("   ")).toEqual({ waitingReason: "other" });
    expect(mapClaudeCodeWaitingFor(undefined)).toEqual({ waitingReason: "other" });
    expect(mapClaudeCodeWaitingFor({ dialog: true })).toEqual({ waitingReason: "other" });
  });
});

describe("isClaudeCodeSessionKind", () => {
  test("interactive and background entries are sessions", () => {
    expect(isClaudeCodeSessionKind("interactive")).toBe(true);
    expect(isClaudeCodeSessionKind("bg")).toBe(true);
  });

  test("Claude Code's helper processes are not", () => {
    expect(isClaudeCodeSessionKind("daemon")).toBe(false);
    expect(isClaudeCodeSessionKind("daemon-worker")).toBe(false);
  });

  test("a kind we do not recognise is not taken for a session", () => {
    expect(isClaudeCodeSessionKind("something-new")).toBe(false);
    expect(isClaudeCodeSessionKind(7)).toBe(false);
  });

  test("an entry that names no kind is kept, because nothing says it is a helper", () => {
    expect(isClaudeCodeSessionKind(undefined)).toBe(true);
    expect(isClaudeCodeSessionKind(null)).toBe(true);
    expect(isClaudeCodeSessionKind("")).toBe(true);
  });
});

describe("mapClaudeCodeSurface", () => {
  test("the VS Code extension and the desktop app are named", () => {
    expect(mapClaudeCodeSurface("claude-vscode")).toBe("vscode");
    expect(mapClaudeCodeSurface("claude-desktop")).toBe("desktop");
  });

  test("any other entrypoint is a terminal", () => {
    expect(mapClaudeCodeSurface("cli")).toBe("terminal");
    expect(mapClaudeCodeSurface("sdk-ts")).toBe("terminal");
  });

  test("no entrypoint means the surface is unknown, not a terminal", () => {
    expect(mapClaudeCodeSurface(undefined)).toBe("unknown");
    expect(mapClaudeCodeSurface("")).toBe("unknown");
    expect(mapClaudeCodeSurface(42)).toBe("unknown");
  });
});

describe("claudeCodeOpenLink", () => {
  test("a VS Code session with an id gets the documented link", () => {
    expect(claudeCodeOpenLink("vscode", "00000000-0000-4000-8000-000000000001")).toBe(
      "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000001",
    );
  });

  test("the session id is escaped", () => {
    expect(claudeCodeOpenLink("vscode", "a b&c=d")).toBe(
      "vscode://anthropic.claude-code/open?session=a%20b%26c%3Dd",
    );
  });

  test("other surfaces and missing ids get no link", () => {
    expect(claudeCodeOpenLink("desktop", "00000000-0000-4000-8000-000000000001")).toBeUndefined();
    expect(claudeCodeOpenLink("terminal", "00000000-0000-4000-8000-000000000001")).toBeUndefined();
    expect(claudeCodeOpenLink("unknown", "00000000-0000-4000-8000-000000000001")).toBeUndefined();
    expect(claudeCodeOpenLink("vscode", null)).toBeUndefined();
    expect(claudeCodeOpenLink("vscode", "")).toBeUndefined();
  });
});
