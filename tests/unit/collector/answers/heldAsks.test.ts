import { describe, expect, test, vi } from "vitest";

import type { Session, SessionsSnapshot } from "@core/sessions/session";
import {
  ALLOW_OUTPUT,
  CHECK_EVERY_MS,
  createHeldAsks,
  DENY_MESSAGE,
  DENY_OUTPUT,
  GRACE_MS,
  MAX_HELD,
  MISSED_AFTER_MS,
  readHookRequest,
  type DropReason,
  type HookReply,
  type RegistryReading,
  type RegistryStatus,
} from "@collector/answers/heldAsks";
import { createRuleAnswers, type RuleAnswers } from "@collector/answers/ruleAnswers";
import { shownAsk } from "@collector/answers/shownAsk";
import type { PermissionRule } from "@core/permission-rules/permissionRules";
import type { SessionEvent } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const UUID = "00000000-0000-4000-8000-000000000001";
const ID = `claude-code:${UUID}`;
const T0 = 1_700_000_000_000;
const HOLD_MS = 300_000;

/** A hook's open response: what was sent on it, and a way to close it as Claude Code would. */
function standInReply() {
  const sent: string[] = [];
  let open = true;
  const listeners: (() => void)[] = [];
  const reply: HookReply = {
    send(body) {
      if (!open) return;
      sent.push(body);
      open = false;
    },
    isOpen: () => open,
    onClose(listener) {
      listeners.push(listener);
    },
  };
  return {
    reply,
    sent,
    close() {
      open = false;
      for (const listener of listeners) listener();
    },
  };
}

function reading(
  status: RegistryStatus,
  wait = "1700000000000|permission prompt",
): RegistryReading {
  return status === "waiting" ? { status, wait } : { status };
}

/** Held requests over a clock and a registry the test moves, with no timer, and perhaps rules. */
function standIns(
  status: RegistryStatus = "waiting",
  rules?: Pick<RuleAnswers, "verdictFor" | "answered">,
) {
  const clock = { now: T0 };
  /** `wait` stands for the moment the registry says the wait began, and what for. */
  const registry = { status, wait: "1700000000000|permission prompt", reads: 0 };
  const drops: [DropReason, string][] = [];
  let ids = 0;
  const asks = createHeldAsks({
    status: {
      statusOf: vi.fn(async () => {
        registry.reads += 1;
        return reading(registry.status, registry.wait);
      }),
    },
    holdMs: HOLD_MS,
    now: () => clock.now,
    every: () => () => {},
    newId: () => (ids += 1).toString(16).padStart(32, "0"),
    onDrop: (reason, sessionId) => drops.push([reason, sessionId]),
    ...(rules && { rules }),
  });
  return { asks, clock, registry, drops };
}

const bash = (command = "npm test") => ({
  sessionId: ID,
  shown: shownAsk("Bash", { command }) ?? { tool: "Bash", allow: false },
});

function snapshot(sessions: Session[], generatedAt = T0): SessionsSnapshot {
  return { generatedAt, sources: [], sessions };
}

const waiting = (overrides: Partial<Session> = {}) =>
  makeSession({
    id: ID,
    status: "needs-you",
    waitingReason: "permission",
    pid: 4241,
    alive: true,
    ...overrides,
  });

describe("the decision written for the hook", () => {
  test("allow is the documented shape and nothing more: no rewritten input, no saved rule", () => {
    expect(JSON.parse(ALLOW_OUTPUT)).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
  });

  test("deny says plainly the person chose it, and does not interrupt", () => {
    expect(JSON.parse(DENY_OUTPUT)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: DENY_MESSAGE },
      },
    });
    expect(DENY_MESSAGE).toMatch(/^The person denied this from Agent Lookout\./);
    expect(DENY_MESSAGE).toContain("not a problem with a hook");
    expect(DENY_OUTPUT).not.toContain("interrupt");
    expect(DENY_OUTPUT).not.toContain("updated");
  });
});

describe("readHookRequest keeps the session and what is shown, and lets the rest go", () => {
  const input = {
    session_id: UUID,
    transcript_path: "/Users/example/.claude/projects/demo/x.jsonl",
    cwd: "/Users/example/code/demo",
    scratchpad_dir: "/private/tmp/example",
    prompt_id: "11111111-1111-4111-8111-111111111111",
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "npm test", description: "Run the tests" },
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  };

  test("a permission request is read as its session and what it asks", () => {
    const request = readHookRequest(JSON.stringify(input));
    expect(request).toEqual({
      sessionId: ID,
      shown: { tool: "Bash", command: "npm test", description: "Run the tests", allow: true },
    });
    const kept = JSON.stringify(request);
    for (const dropped of ["transcript", "scratchpad", "11111111", "acceptEdits", "/code/demo"]) {
      expect(kept).not.toContain(dropped);
    }
  });

  test("anything else is not a request", () => {
    for (const body of [
      "",
      "not json",
      "[]",
      JSON.stringify({ ...input, hook_event_name: "PreToolUse" }),
      JSON.stringify({ ...input, session_id: "../../etc" }),
      JSON.stringify({ ...input, session_id: 7 }),
      JSON.stringify({ ...input, tool_name: undefined }),
      JSON.stringify({ ...input, tool_input: "ls" }),
    ]) {
      expect(readHookRequest(body), body).toBeNull();
    }
  });
});

describe("the hold", () => {
  test("a request is shown once the registry says its session is waiting, and not before", async () => {
    const { asks, registry } = standIns("not-waiting");
    const { reply } = standInReply();
    asks.receive(bash(), reply);
    await asks.check();
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask).toBeUndefined();

    registry.status = "waiting";
    await asks.check();
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask).toEqual({
      requestId: "1".padStart(32, "0"),
      tool: "Bash",
      command: "npm test",
      allow: true,
      until: T0 + HOLD_MS,
    });
  });

  test("a session the snapshot does not list as needing you is shown no ask", async () => {
    const { asks } = standIns();
    asks.receive(bash(), standInReply().reply);
    await asks.check();
    expect(
      asks.withAsks(snapshot([waiting({ status: "working" })])).sessions[0],
    ).not.toHaveProperty("ask");
  });

  test("it is let go, with no answer, as soon as the registry no longer says waiting", async () => {
    const { asks, registry, drops } = standIns();
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    await asks.check();
    registry.status = "not-waiting";
    await asks.check();
    expect(hook.sent).toEqual([""]);
    expect(drops).toEqual([["left-waiting", ID]]);
    expect(asks.size).toBe(0);
  });

  test("it is let go when the session waits again in a later wait: answered in the session, and asking again", async () => {
    const { asks, registry, drops } = standIns();
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    await asks.check();
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask).toBeDefined();
    registry.wait = "1700000005000|permission prompt";
    await asks.check();
    expect(hook.sent).toEqual([""]);
    expect(drops).toEqual([["left-waiting", ID]]);
  });

  test("a session whose file never says waiting is given the grace, then let go", async () => {
    const { asks, clock, drops } = standIns("not-waiting");
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    clock.now = T0 + GRACE_MS - 1;
    await asks.check();
    expect(asks.size).toBe(1);
    clock.now = T0 + GRACE_MS;
    await asks.check();
    expect(hook.sent).toEqual([""]);
    expect(drops).toEqual([["left-waiting", ID]]);
  });

  test("a registry that cannot be read is no reason to hold it past the grace", async () => {
    const { asks, clock, registry } = standIns("unknown");
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    clock.now = T0 + GRACE_MS;
    await asks.check();
    expect(hook.sent).toEqual([""]);
    expect(registry.reads).toBeGreaterThan(0);
  });

  test("it is let go at the hold's limit, with no answer", async () => {
    const { asks, clock, drops } = standIns();
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    clock.now = T0 + HOLD_MS - 1;
    await asks.check();
    expect(asks.size).toBe(1);
    clock.now = T0 + HOLD_MS;
    await asks.check();
    expect(hook.sent).toEqual([""]);
    expect(drops).toEqual([["limit", ID]]);
  });

  test("it is let go at once when the hook's connection closes", async () => {
    const { asks, drops } = standIns();
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    await asks.check();
    hook.close();
    expect(asks.size).toBe(0);
    expect(drops).toEqual([["closed", ID]]);
    expect(hook.sent).toEqual([]);
  });

  test("a newer request of the same session lets the older go, with no answer", async () => {
    const { asks, drops } = standIns();
    const first = standInReply();
    const second = standInReply();
    asks.receive(bash("first"), first.reply);
    asks.receive(bash("second"), second.reply);
    await asks.check();
    expect(first.sent).toEqual([""]);
    expect(drops).toEqual([["newer", ID]]);
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask?.command).toBe("second");
  });

  test("past the most held at once, a request is let go at once", () => {
    const { asks } = standIns();
    for (let index = 0; index < MAX_HELD; index += 1) {
      asks.receive({ ...bash(), sessionId: `claude-code:s${index}` }, standInReply().reply);
    }
    const last = standInReply();
    asks.receive({ ...bash(), sessionId: "claude-code:one-more" }, last.reply);
    expect(last.sent).toEqual([""]);
    expect(asks.size).toBe(MAX_HELD);
  });

  test("the registry is read again every half second while anything is held, and not after", async () => {
    const runs: (() => void)[] = [];
    const stopped = vi.fn();
    let status: RegistryStatus = "waiting";
    const asks = createHeldAsks({
      status: { statusOf: async () => reading(status) },
      holdMs: HOLD_MS,
      now: () => T0,
      every: (run, ms) => {
        expect(ms).toBe(CHECK_EVERY_MS);
        runs.push(run);
        return stopped;
      },
    });
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    expect(runs).toHaveLength(1);
    status = "not-waiting";
    await asks.check();
    await asks.check();
    expect(hook.sent).toEqual([""]);
    expect(stopped).toHaveBeenCalledOnce();
  });

  test("letting everything go, as Agent Lookout stops, answers nothing", () => {
    const { asks } = standIns();
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    asks.dropAll();
    expect(hook.sent).toEqual([""]);
    expect(asks.size).toBe(0);
  });
});

describe("answering", () => {
  async function held(command = "npm test") {
    const parts = standIns();
    const hook = standInReply();
    parts.asks.receive(bash(command), hook.reply);
    await parts.asks.check();
    const requestId = parts.asks.withAsks(snapshot([waiting()])).sessions[0]?.ask?.requestId ?? "";
    return { ...parts, hook, requestId };
  }

  test("Allow writes the allow decision on the hook's response, once", async () => {
    const { asks, hook, requestId } = await held();
    expect(await asks.answer(ID, requestId, "allow")).toBe("answered");
    expect(hook.sent).toEqual([ALLOW_OUTPUT]);
    expect(asks.size).toBe(0);
    expect(await asks.answer(ID, requestId, "allow")).toBe("no-ask");
  });

  test("Deny writes the deny decision", async () => {
    const { asks, hook, requestId } = await held();
    expect(await asks.answer(ID, requestId, "deny")).toBe("answered");
    expect(hook.sent).toEqual([DENY_OUTPUT]);
  });

  test("the registry is read again right before: answered in the session, nothing is written", async () => {
    const { asks, hook, registry, requestId } = await held();
    registry.status = "not-waiting";
    expect(await asks.answer(ID, requestId, "allow")).toBe("gone");
    expect(hook.sent).toEqual([""]);
  });

  test("a later wait, between two checks, is not the one shown: nothing is written", async () => {
    const { asks, hook, registry, requestId } = await held();
    registry.wait = "1700000005000|permission prompt";
    expect(await asks.answer(ID, requestId, "allow")).toBe("gone");
    expect(hook.sent).toEqual([""]);
  });

  test("a request not yet shown, its wait not yet confirmed, cannot be answered", async () => {
    const parts = standIns("not-waiting");
    const hook = standInReply();
    parts.asks.receive(bash(), hook.reply);
    await parts.asks.check();
    parts.registry.status = "waiting";
    expect(await parts.asks.answer(ID, "1".padStart(32, "0"), "allow")).toBe("no-ask");
    expect(hook.sent).toEqual([]);
  });

  test("only the request shown is answered: another id, or another session, is no ask", async () => {
    const { asks, hook } = await held();
    expect(await asks.answer(ID, "f".repeat(32), "allow")).toBe("no-ask");
    expect(await asks.answer("claude-code:other", "1".padStart(32, "0"), "allow")).toBe("no-ask");
    expect(hook.sent).toEqual([]);
  });

  test("Allow is refused for a request that offers only Deny, and Deny is not", async () => {
    const parts = standIns();
    const hook = standInReply();
    parts.asks.receive(
      { sessionId: ID, shown: shownAsk("Write", { file_path: "/Users/example/a.ts" })! },
      hook.reply,
    );
    await parts.asks.check();
    const requestId = "1".padStart(32, "0");
    expect(await parts.asks.answer(ID, requestId, "allow")).toBe("not-allowable");
    expect(hook.sent).toEqual([]);
    expect(await parts.asks.answer(ID, requestId, "deny")).toBe("answered");
    expect(hook.sent).toEqual([DENY_OUTPUT]);
  });

  test("a hook that has gone is answered nothing", async () => {
    const { asks, hook, requestId } = await held();
    hook.close();
    expect(await asks.answer(ID, requestId, "allow")).toBe("no-ask");
    expect(hook.sent).toEqual([]);
  });

  test("past the hold's limit, it is gone", async () => {
    const { asks, clock, hook, requestId } = await held();
    clock.now = T0 + HOLD_MS;
    expect(await asks.answer(ID, requestId, "allow")).toBe("gone");
    expect(hook.sent).toEqual([""]);
  });

  test("two answers at once: the second is told one is under way", async () => {
    const { asks, requestId } = await held();
    const [first, second] = await Promise.all([
      asks.answer(ID, requestId, "allow"),
      asks.answer(ID, requestId, "deny"),
    ]);
    expect([first, second]).toEqual(["answered", "too-soon"]);
  });
});

describe("whether the plugin's requests arrive", () => {
  test("unknown until a permission wait, missed when one had no request, seen once one came", () => {
    const { asks, clock } = standIns();
    expect(asks.status()).toEqual({ state: "on", plugin: "unknown", holdMs: HOLD_MS });

    const since = T0 + 10_000;
    asks.observe(snapshot([waiting({ statusSince: since })], since + MISSED_AFTER_MS - 1));
    expect(asks.status().plugin).toBe("unknown");
    asks.observe(snapshot([waiting({ statusSince: since })], since + MISSED_AFTER_MS));
    expect(asks.status().plugin).toBe("missed");

    clock.now = since + 20_000;
    asks.noteRequest(ID);
    expect(asks.status().plugin).toBe("seen");
  });

  test("a wait its request came for is not missed, even when the request came a poll before", () => {
    const { asks, clock } = standIns();
    const since = T0 + 10_000;
    clock.now = since - 500;
    asks.noteRequest(ID);
    asks.observe(snapshot([waiting({ status: "working" })], since - 400));
    asks.observe(snapshot([waiting({ statusSince: since })], since + MISSED_AFTER_MS + 1));
    expect(asks.status().plugin).toBe("seen");
  });

  test("a wait that began before Agent Lookout listened, or is not for permission, says nothing", () => {
    const { asks } = standIns();
    asks.observe(snapshot([waiting({ statusSince: T0 - 60_000 })], T0 + 60_000));
    asks.observe(
      snapshot([waiting({ statusSince: T0 + 5_000, waitingReason: "question" })], T0 + 60_000),
    );
    asks.observe(
      snapshot([waiting({ statusSince: T0 + 5_000, source: "codex", id: "codex:x" })], T0 + 60_000),
    );
    expect(asks.status().plugin).toBe("unknown");
  });
});

describe("the permission rules", () => {
  const ALLOW_TESTS: PermissionRule = {
    id: "aaaaaaaaaaaa",
    decision: "allow",
    tool: "Bash",
    command: "npm test:*",
  };
  const DENY_RM: PermissionRule = {
    id: "bbbbbbbbbbbb",
    decision: "deny",
    tool: "Bash",
    command: "rm:*",
  };
  const ASK_PUSH: PermissionRule = {
    id: "cccccccccccc",
    decision: "ask",
    tool: "Bash",
    command: "npm test --update:*",
  };

  /** The rules in force, over the real record of what they answered. */
  function withRules(rules: PermissionRule[], status: RegistryStatus = "waiting") {
    const events: SessionEvent[] = [];
    const answers = createRuleAnswers({
      rules: () => rules,
      poller: {
        getSnapshot: () => snapshot([waiting()]),
        pollOnce: async () => snapshot([waiting()]),
      },
      events: { add: (added) => events.push(...added) },
      now: () => T0,
    });
    return { ...standIns(status, answers), events, answers };
  }

  test("an allow rule answers allow at once, once the registry confirms the wait, and is never shown", async () => {
    const { asks, events, answers } = withRules([ALLOW_TESTS]);
    const hook = standInReply();
    asks.receive(bash("npm test --watch"), hook.reply);
    // Nothing is answered before the registry says the session waits.
    expect(hook.sent).toEqual([]);
    await asks.check();
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]).not.toHaveProperty("ask");
    await vi.waitFor(() => expect(hook.sent).toEqual([ALLOW_OUTPUT]));
    expect(asks.size).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "answered",
        decision: "allow",
        by: "agent-lookout",
        tool: "Bash",
        rule: { tool: "Bash", command: "npm test:*" },
      }),
    ]);
    expect(answers.recent()).toHaveLength(1);
    // The event and the list hold the rule, never the command.
    expect(JSON.stringify([events, answers.recent()])).not.toContain("--watch");
  });

  test("a deny rule answers deny at once", async () => {
    const { asks, events } = withRules([DENY_RM, ALLOW_TESTS]);
    const hook = standInReply();
    asks.receive(bash("cd build && rm -rf dist"), hook.reply);
    await asks.check();
    await vi.waitFor(() => expect(hook.sent).toEqual([DENY_OUTPUT]));
    expect(events[0]).toMatchObject({ decision: "deny", rule: { command: "rm:*" } });
  });

  test("a deny rule answers what offers Deny alone, as an edit does", async () => {
    const denyWrite: PermissionRule = { id: "dddddddddddd", decision: "deny", tool: "Write" };
    const { asks } = withRules([denyWrite]);
    const hook = standInReply();
    asks.receive(
      { sessionId: ID, shown: shownAsk("Write", { file_path: "/tmp/a", content: "x" })! },
      hook.reply,
    );
    await asks.check();
    await vi.waitFor(() => expect(hook.sent).toEqual([DENY_OUTPUT]));
  });

  test("an ask rule, a compound command and no rule leave the request held and shown, for the person", async () => {
    for (const [rules, command] of [
      [[ALLOW_TESTS, ASK_PUSH], "npm test --update snapshots"],
      [[ALLOW_TESTS], "npm test && rm -rf ~"],
      [[ALLOW_TESTS], "npm run build"],
      [[], "npm test"],
    ] as const) {
      const { asks, events } = withRules([...rules]);
      const hook = standInReply();
      asks.receive(bash(command), hook.reply);
      await asks.check();
      await asks.check();
      expect(hook.sent, command).toEqual([]);
      expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask, command).toBeDefined();
      expect(events, command).toEqual([]);
    }
  });

  test("an allow rule never answers what offers Deny alone", async () => {
    const { asks } = withRules([ALLOW_TESTS]);
    const hook = standInReply();
    asks.receive(bash(`npm test ${"x".repeat(5_000)}`), hook.reply);
    await asks.check();
    await asks.check();
    expect(hook.sent).toEqual([]);
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask).toMatchObject({
      allow: false,
      denyOnly: "too-long",
    });
  });

  test("a rule answers only in the wait it was confirmed in, through the same checks as a press", async () => {
    const { asks, registry, events } = withRules([ALLOW_TESTS]);
    const hook = standInReply();
    // The registry says the session waits, then, by the time the answer is
    // written, that it moved on: the read made right before writing catches it.
    let reads = 0;
    const was = registry.status;
    Object.defineProperty(registry, "status", {
      get: () => ((reads += 1) === 1 ? was : "not-waiting"),
      configurable: true,
    });
    asks.receive(bash(), hook.reply);
    await asks.check();
    await vi.waitFor(() => expect(hook.sent).toEqual([""]));
    expect(events).toEqual([]);
  });

  test("a rule that throws answers nothing, and the request waits for the person", async () => {
    const { asks } = standIns("waiting", {
      verdictFor: () => {
        throw new Error("broken");
      },
      answered: () => {},
    });
    const hook = standInReply();
    asks.receive(bash(), hook.reply);
    await asks.check();
    expect(hook.sent).toEqual([]);
    expect(asks.withAsks(snapshot([waiting()])).sessions[0]?.ask).toBeDefined();
  });
});
