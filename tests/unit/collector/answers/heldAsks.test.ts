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
  TOGETHER_MS,
  type DropReason,
  type HookReply,
  type RegistryReading,
  type RegistryStatus,
} from "@collector/answers/heldAsks";
import { createRegistryStatus } from "@collector/answers/registryStatus";
import { createRuleAnswers, type RuleAnswers } from "@collector/answers/ruleAnswers";
import { shownAsk } from "@collector/answers/shownAsk";
import type { PermissionRule } from "@core/permission-rules/permissionRules";
import type { SessionEvent } from "@core/sessions/session";
import { ANSWER_HOLDS_MS } from "@core/waits/answeredWaits";
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
  since?: number,
): RegistryReading {
  return status === "waiting"
    ? { status, wait, ...(since !== undefined && { since }) }
    : { status };
}

/** Held requests over a clock and a registry the test moves, with no timer, and perhaps rules. */
function standIns(
  status: RegistryStatus = "waiting",
  rules?: Pick<RuleAnswers, "verdictFor" | "answered">,
) {
  const clock = { now: T0 };
  /** `wait` stands for the moment the registry says the wait began, and what for; `since` for the moment alone. */
  const registry = {
    status,
    wait: "1700000000000|permission prompt",
    since: undefined as number | undefined,
    reads: 0,
  };
  const drops: [DropReason, string][] = [];
  let ids = 0;
  const asks = createHeldAsks({
    status: {
      statusOf: vi.fn(async () => {
        registry.reads += 1;
        return reading(registry.status, registry.wait, registry.since);
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

  test("a wait that began while another copy of Agent Lookout had the socket says nothing", () => {
    const { asks, clock } = standIns();
    clock.now = T0 + 20_000;
    asks.listensNow();
    asks.observe(snapshot([waiting({ statusSince: T0 + 10_000 })], T0 + 60_000));
    expect(asks.status().plugin).toBe("unknown");
    asks.observe(snapshot([waiting({ statusSince: T0 + 30_000 })], T0 + 60_000));
    expect(asks.status().plugin).toBe("missed");
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

describe("the waits a poll is told were answered", () => {
  const ALLOW_TESTS: PermissionRule = {
    id: "aaaaaaaaaaaa",
    decision: "allow",
    tool: "Bash",
    command: "npm test:*",
  };

  /** A poll that read Claude Code's sessions. */
  function polled(sessions: Session[]): SessionsSnapshot {
    return {
      generatedAt: T0,
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
      sessions,
    };
  }

  /** A request held, confirmed in a wait the registry says began at T0, and answered with Allow. */
  async function answered() {
    const parts = standIns();
    parts.registry.since = T0;
    const hook = standInReply();
    parts.asks.receive(bash(), hook.reply);
    await parts.asks.check();
    const requestId = parts.asks.withAsks(snapshot([waiting()])).sessions[0]?.ask?.requestId ?? "";
    expect(await parts.asks.answer(ID, requestId, "allow")).toBe("answered");
    return parts;
  }

  test("an answered wait is answered for every poll that still reads it, and forgotten once one reads it moved on", async () => {
    const { asks } = await answered();
    expect([...asks.answeredIn(polled([waiting({ statusSince: T0 })]))]).toEqual([ID]);
    expect([...asks.answeredIn(polled([waiting({ statusSince: T0 })]))]).toEqual([ID]);
    expect(
      asks.answeredIn(polled([waiting({ status: "working", statusSince: T0 + 900 })])).size,
    ).toBe(0);
    // Forgotten: the same wait read again is not taken as answered.
    expect(asks.answeredIn(polled([waiting({ statusSince: T0 })])).size).toBe(0);
  });

  test("an answered wait is forgotten once the answer is ANSWER_HOLDS_MS old, though a poll still reads it", async () => {
    const { asks, clock } = await answered();
    clock.now += ANSWER_HOLDS_MS - 1;
    expect([...asks.answeredIn(polled([waiting({ statusSince: T0 })]))]).toEqual([ID]);
    clock.now += 1;
    expect(asks.answeredIn(polled([waiting({ statusSince: T0 })])).size).toBe(0);
    // Forgotten: a poll a moment later does not find it answered either.
    clock.now -= 1;
    expect(asks.answeredIn(polled([waiting({ statusSince: T0 })])).size).toBe(0);
  });

  test("a later wait of the session is not the one answered", async () => {
    const { asks } = await answered();
    expect(asks.answeredIn(polled([waiting({ statusSince: T0 + 1_500 })])).size).toBe(0);
  });

  test("a poll whose source could not be read forgets nothing", async () => {
    const { asks } = await answered();
    expect(asks.answeredIn({ sources: [], sessions: [] }).size).toBe(0);
    expect([...asks.answeredIn(polled([waiting({ statusSince: T0 })]))]).toEqual([ID]);
  });

  test("a newer request of the session is a new prompt: the answer before it is forgotten", async () => {
    const { asks } = await answered();
    asks.receive(bash("npm run build"), standInReply().reply);
    expect(asks.answeredIn(polled([waiting({ statusSince: T0 })])).size).toBe(0);
  });

  test("a request a rule will answer at the check that confirms it is answered already, as far as a poll goes", async () => {
    const { asks, registry } = withRuleAnswers([ALLOW_TESTS]);
    asks.receive(bash("npm test"), standInReply().reply);
    // The check made as it arrived found the session not yet waiting.
    await asks.check();
    registry.status = "waiting";
    expect([...asks.answeredIn(polled([waiting()]))]).toEqual([ID]);
    // Not while the poll reads the session as anything but waiting for permission.
    expect(asks.answeredIn(polled([waiting({ waitingReason: "question" })])).size).toBe(0);
  });

  test("a request that waits for the person is not, nor is any request with no rules", async () => {
    const ruled = withRuleAnswers([ALLOW_TESTS]);
    ruled.asks.receive(bash("npm run build"), standInReply().reply);
    await ruled.asks.check();
    expect(ruled.asks.answeredIn(polled([waiting()])).size).toBe(0);

    const plain = standIns("not-waiting");
    plain.asks.receive(bash("npm test"), standInReply().reply);
    await plain.asks.check();
    expect(plain.asks.answeredIn(polled([waiting()])).size).toBe(0);
  });

  /** Held requests over the rules, with the registry not yet saying the session waits. */
  function withRuleAnswers(rules: PermissionRule[]) {
    const answers = createRuleAnswers({
      rules: () => rules,
      poller: {
        getSnapshot: () => snapshot([waiting()]),
        pollOnce: async () => snapshot([waiting()]),
      },
      events: { add: () => {} },
      now: () => T0,
    });
    return standIns("not-waiting", answers);
  }
});

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

/** Held requests over these rules, which a test can change, with the registry not yet saying the session waits. */
function parallel(rules: PermissionRule[] = [ALLOW_TESTS, DENY_RM]) {
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
  const parts = standIns("not-waiting", answers);
  parts.registry.since = T0;
  const receive = (command: string) => {
    const hook = standInReply();
    parts.asks.receive(bash(command), hook.reply);
    return hook;
  };
  /** The registry says the session waits, and a check finds it. */
  const waits = async () => {
    parts.registry.status = "waiting";
    await parts.asks.check();
    // A rule's answer reads the registry once more after the check.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** The sessions a poll that reads the session as waiting is told are answered. */
  const answered = (session = waiting({ statusSince: T0 })) => [
    ...parts.asks.answeredIn({
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
      sessions: [session],
    }),
  ];
  const shown = () => parts.asks.withAsks(snapshot([waiting()])).sessions[0]?.ask;
  return { ...parts, rules, events, receive, waits, answered, shown };
}

describe("several requests of one session at once, as parallel tool calls make them", () => {
  test("each a rule covers is answered, whichever came last, and none is shown", async () => {
    const { asks, drops, events, receive, waits, answered, shown } = parallel();
    const hooks = ["npm test a", "rm -rf build", "npm test b"].map(receive);
    expect(asks.size).toBe(3);
    // Taken as answered by a poll that reads the wait before they are.
    expect(answered()).toEqual([ID]);
    await waits();
    expect(hooks.map(({ sent }) => sent)).toEqual([[ALLOW_OUTPUT], [DENY_OUTPUT], [ALLOW_OUTPUT]]);
    expect(events.map((event) => event.kind === "answered" && event.decision)).toEqual(
      expect.arrayContaining(["allow", "deny", "allow"]),
    );
    expect(shown()).toBeUndefined();
    expect(answered()).toEqual([ID]);
    expect([drops, asks.size]).toEqual([[], 0]);
    // In their own wait, and in no other.
    expect(answered(waiting({ statusSince: T0 - 500 }))).toEqual([]);
  });

  test("one a rule is answering as a newer one arrives is answered all the same", async () => {
    let reads = 0;
    let readAgain = (_: RegistryReading) => {};
    const asks = createHeldAsks({
      status: {
        // The second read, right before the first request's answer is written, takes its time.
        statusOf: async () =>
          (reads += 1) === 2
            ? new Promise<RegistryReading>((resolve) => (readAgain = resolve))
            : reading("waiting"),
      },
      holdMs: HOLD_MS,
      now: () => T0,
      every: () => () => {},
      rules: { verdictFor: () => ({ decision: "allow", rule: ALLOW_TESTS }), answered: () => {} },
    });
    const [first, second] = [standInReply(), standInReply()];
    asks.receive(bash("npm test a"), first.reply);
    await vi.waitFor(() => expect(reads).toBe(2));
    asks.receive(bash("npm test b"), second.reply);
    await vi.waitFor(() => expect(second.sent).toEqual([ALLOW_OUTPUT]));
    expect(first.sent).toEqual([]);
    readAgain(reading("waiting"));
    await vi.waitFor(() => expect(first.sent).toEqual([ALLOW_OUTPUT]));
  });

  test("one a rule covers is answered, and a newer one for the person is shown, its session not taken as answered", async () => {
    const { receive, waits, answered, shown, asks } = parallel();
    const first = receive("npm test");
    const second = receive("npm run build");
    expect(answered()).toEqual([]);
    await waits();
    expect([first.sent, second.sent]).toEqual([[ALLOW_OUTPUT], []]);
    expect(shown()?.command).toBe("npm run build");
    expect(answered()).toEqual([]);
    // Once the person has answered that one too, the wait is over.
    expect(await asks.answer(ID, shown()?.requestId ?? "", "deny")).toBe("answered");
    expect(answered()).toEqual([ID]);
  });

  test("one let go for a newer one that a rule answers leaves its session waiting, not answered", async () => {
    for (const confirmed of [false, true]) {
      const { receive, waits, answered, registry } = parallel();
      const first = receive("npm run build");
      if (confirmed) await waits();
      const second = receive("npm test");
      expect(first.sent).toEqual([""]);
      expect(answered()).toEqual([]);
      await waits();
      expect(second.sent).toEqual([ALLOW_OUTPUT]);
      expect(answered()).toEqual([]);

      // In a later wait, with nothing let go in it, an answer ends the wait as ever.
      registry.wait = "1700000005000|permission prompt";
      registry.since = T0 + 5_000;
      const third = receive("npm test");
      await waits();
      expect(third.sent).toEqual([ALLOW_OUTPUT]);
      expect(answered(waiting({ statusSince: T0 + 5_000 }))).toEqual([ID]);
    }
  });

  test("a press for the newer one leaves the session waiting too, while the one let go is open in the session", async () => {
    const { receive, waits, answered, shown, asks } = parallel([]);
    receive("npm run build");
    await waits();
    receive("npm run lint");
    await waits();
    expect(await asks.answer(ID, shown()?.requestId ?? "", "allow")).toBe("answered");
    expect(answered()).toEqual([]);
  });

  test("a request let go for want of room, or past its hold, leaves its session waiting too", async () => {
    const full = parallel();
    for (let index = 0; index < MAX_HELD; index += 1) {
      full.asks.receive({ ...bash(), sessionId: `claude-code:s${index}` }, standInReply().reply);
    }
    expect(full.receive("npm run build").sent).toEqual([""]);
    full.asks.dropAll();
    full.receive("npm test");
    await full.waits();
    expect(full.answered()).toEqual([]);

    const late = parallel();
    late.receive("npm run build");
    await late.waits();
    late.clock.now = T0 + HOLD_MS;
    await late.asks.check();
    const next = late.receive("npm test");
    await late.waits();
    expect(next.sent).toEqual([ALLOW_OUTPUT]);
    // It may have been answered in the session since, so the wait is taken as answered for a moment.
    expect(late.answered()).toEqual([ID]);
    late.clock.now += GRACE_MS;
    expect(late.answered()).toEqual([]);
  });

  test("a newer one that did not arrive with the one let go ends the wait for a moment, and its own wait for good", async () => {
    for (const rules of [[ALLOW_TESTS], []]) {
      const { asks, clock, receive, waits, answered, shown } = parallel(rules);
      receive("npm run build");
      await waits();
      clock.now = T0 + TOGETHER_MS;
      const second = receive("npm test");
      await waits();
      if (rules.length === 0) {
        expect(await asks.answer(ID, shown()?.requestId ?? "", "allow")).toBe("answered");
      }
      expect(second.sent).toEqual([ALLOW_OUTPUT]);
      // The first may have been answered in the session, where the file has yet to say so.
      expect(answered()).toEqual([ID]);
      clock.now += GRACE_MS - 1;
      expect(answered()).toEqual([ID]);
      // The file would have said so by now, so it is the first one's wait.
      clock.now += 1;
      expect(answered()).toEqual([]);
      // A wait that began since the first arrived, and not since the answer, is the second's own.
      expect(answered(waiting({ statusSince: T0 + TOGETHER_MS }))).toEqual([ID]);
      expect(answered(waiting({ statusSince: T0 - 1 }))).toEqual([]);
      expect(answered(waiting({ statusSince: T0 + TOGETHER_MS + 1 }))).toEqual([]);
    }
  });

  test("a newer one that arrived with the one let go does not end the wait", async () => {
    const { clock, receive, waits, answered } = parallel();
    receive("npm run build");
    await waits();
    clock.now = T0 + TOGETHER_MS - 1;
    receive("npm test");
    await waits();
    expect(answered()).toEqual([]);
    expect(answered(waiting({ statusSince: T0 + TOGETHER_MS - 1 }))).toEqual([]);
  });

  test("one let go keeps a later wait from being taken as answered for more than a moment, until a poll finds none", async () => {
    for (const polled of [false, true]) {
      const { asks, clock, registry, receive, waits, answered } = parallel();
      receive("npm run build");
      await waits();
      clock.now = T0 + HOLD_MS;
      await asks.check();
      clock.now += GRACE_MS;
      if (polled) answered(waiting({ status: "working" }));
      const statusSince = clock.now;
      registry.wait = `${statusSince}|permission prompt`;
      registry.since = statusSince;
      receive("npm test");
      await waits();
      expect(answered(waiting({ statusSince }))).toEqual([ID]);
      clock.now += GRACE_MS;
      expect(answered(waiting({ statusSince })), `${polled}`).toEqual(polled ? [ID] : []);
    }
  });

  test("a newer one in a later wait than the one let go was in is answered in that wait alone", async () => {
    const { asks, clock, registry, receive, waits, answered } = parallel();
    receive("npm run build");
    await waits();
    clock.now = T0 + HOLD_MS;
    await asks.check();
    registry.wait = "1700000300000|permission prompt";
    registry.since = T0 + HOLD_MS;
    receive("npm test");
    await waits();
    expect(answered(waiting({ statusSince: T0 + HOLD_MS }))).toEqual([ID]);
    expect(answered(waiting({ statusSince: T0 + HOLD_MS - 500 }))).toEqual([]);
  });

  test("one let go before the file says its wait is remembered past a poll that reads none", async () => {
    const { receive, waits, answered } = parallel();
    receive("npm run build");
    receive("npm test");
    expect(answered(waiting({ status: "working" }))).toEqual([]);
    await waits();
    expect(answered()).toEqual([]);
  });

  test("one let go is forgotten with its session", async () => {
    const { asks, clock, receive, waits, answered } = parallel();
    receive("npm run build");
    receive("npm run lint");
    clock.now = T0 + GRACE_MS;
    await asks.check();
    asks.answeredIn({ sources: [], sessions: [] });
    receive("npm test");
    await waits();
    clock.now += GRACE_MS;
    expect(answered()).toEqual([ID]);
  });

  test("one whose hook had closed, as its answer was written, leaves no prompt open", async () => {
    let reads = 0;
    let readAgain = (_: RegistryReading) => {};
    const asks = createHeldAsks({
      status: {
        // The second read, right before the first request's answer is written, takes its time.
        statusOf: async () =>
          (reads += 1) === 2
            ? new Promise<RegistryReading>((resolve) => (readAgain = resolve))
            : reading("waiting", undefined, T0),
      },
      holdMs: HOLD_MS,
      now: () => T0,
      every: () => () => {},
      rules: {
        verdictFor: ({ shown }) =>
          shown.command === "npm test" ? { decision: "allow", rule: ALLOW_TESTS } : null,
        answered: () => {},
      },
    });
    const [first, second] = [standInReply(), standInReply()];
    asks.receive(bash("npm run build"), first.reply);
    const shown = () => asks.withAsks(snapshot([waiting()])).sessions[0]?.ask;
    await vi.waitFor(() => expect(shown()).toBeDefined());
    const pressed = asks.answer(ID, shown()?.requestId ?? "", "allow");
    first.close();
    asks.receive(bash("npm test"), second.reply);
    readAgain(reading("waiting", undefined, T0));
    expect(await pressed).toBe("gone");
    await vi.waitFor(() => expect(second.sent).toEqual([ALLOW_OUTPUT]));
    const sources = [
      { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 },
    ] as const;
    const sessions = [waiting({ statusSince: T0 })];
    expect([...asks.answeredIn({ sources: [...sources], sessions })]).toEqual([ID]);
  });

  test("one kept for a rule that is gone by its check is open, and ends the answer given to the newer one", async () => {
    const reads: ((read: RegistryReading) => void)[] = [];
    let covered = true;
    const asks = createHeldAsks({
      status: { statusOf: () => new Promise((resolve) => reads.push(resolve)) },
      holdMs: HOLD_MS,
      now: () => T0,
      every: () => () => {},
      rules: {
        verdictFor: ({ shown }) =>
          covered || shown.command === "npm test b"
            ? { decision: "allow", rule: ALLOW_TESTS }
            : null,
        answered: () => {},
      },
    });
    const [first, second] = [standInReply(), standInReply()];
    const read = async (index: number, reading: RegistryReading) => {
      await vi.waitFor(() => expect(reads.length).toBeGreaterThan(index));
      reads[index]?.(reading);
    };
    asks.receive(bash("npm test a"), first.reply);
    asks.receive(bash("npm test b"), second.reply);
    await read(0, reading("not-waiting"));
    // The newer one is read first, and answered, while the older one's read takes its time.
    await read(1, reading("waiting", undefined, T0));
    await read(3, reading("waiting", undefined, T0));
    await vi.waitFor(() => expect(second.sent).toEqual([ALLOW_OUTPUT]));
    covered = false;
    await read(2, reading("waiting", undefined, T0));
    await vi.waitFor(() => expect(first.sent).toEqual([""]));
    const sources = [
      { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 },
    ] as const;
    const sessions = [waiting({ statusSince: T0 })];
    expect([...asks.answeredIn({ sources: [...sources], sessions })]).toEqual([]);
  });

  test("the most held at once counts those kept for their rule", () => {
    const { receive } = parallel();
    for (let index = 0; index < MAX_HELD; index += 1) {
      expect(receive(`npm test ${index}`).sent).toEqual([]);
    }
    expect(receive("npm test").sent).toEqual([""]);
  });

  test("the registry is read again while any request is held, shown or kept for its rule", () => {
    let reading = 0;
    const asks = createHeldAsks({
      status: { statusOf: () => new Promise(() => {}) },
      holdMs: HOLD_MS,
      now: () => T0,
      every: () => {
        reading += 1;
        return () => (reading -= 1);
      },
      rules: { verdictFor: () => ({ decision: "allow", rule: ALLOW_TESTS }), answered: () => {} },
    });
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const hooks = [standInReply(), standInReply()];
      for (const { reply } of hooks) asks.receive(bash(), reply);
      expect([asks.size, reading]).toEqual([2, 1]);
      hooks[order[0] as number]?.close();
      expect([asks.size, reading]).toEqual([1, 1]);
      hooks[order[1] as number]?.close();
      expect([asks.size, reading]).toEqual([0, 0]);
    }
  });

  test("one let go in a session that never waited says nothing of a later wait", async () => {
    const { asks, clock, receive, waits, answered } = parallel();
    receive("npm run build");
    receive("npm run lint");
    clock.now = T0 + GRACE_MS;
    await asks.check();
    expect(answered(waiting({ status: "working" }))).toEqual([]);
    receive("npm test");
    await waits();
    expect(answered()).toEqual([ID]);
  });

  test("one a rule covered when the newer arrived, and no more, is let go unanswered", async () => {
    const { rules, receive, waits, answered, drops, shown } = parallel();
    const first = receive("npm test");
    const second = receive("npm run build");
    rules.length = 0;
    await waits();
    expect([first.sent, second.sent]).toEqual([[""], []]);
    expect(drops).toEqual([["newer", ID]]);
    expect(shown()?.command).toBe("npm run build");
    expect(answered()).toEqual([]);
  });

  test("one kept for its rule is let go as any other: past the grace, as its hook closes, and as Agent Lookout stops", async () => {
    const { asks, clock, receive } = parallel();
    const late = receive("npm test a");
    receive("npm test b");
    clock.now = T0 + GRACE_MS;
    await asks.check();
    expect(late.sent).toEqual([""]);
    expect(asks.size).toBe(0);

    const closed = receive("npm test c");
    const stopped = receive("npm test d");
    receive("npm test e");
    closed.close();
    expect(asks.size).toBe(2);
    asks.dropAll();
    expect(stopped.sent).toEqual([""]);
    expect(asks.size).toBe(0);
  });

  test("only the newest is ever answered by a press", async () => {
    const { asks, receive, registry } = parallel();
    const first = receive("npm test");
    receive("npm run build");
    registry.status = "waiting";
    expect(await asks.answer(ID, "1".padStart(32, "0"), "deny")).toBe("no-ask");
    expect(first.sent).toEqual([]);
  });
});

describe("the request that comes right after an answer, while the file still says the wait before", () => {
  /** How long after the wait before began the next request arrives, and when its own wait begins. */
  const LATER = 5_000;
  const ARRIVED = T0 + LATER;
  const OWN = `${ARRIVED}|permission prompt`;

  /** A request answered by a press in a wait that began at `began`, and the next one, arrived since, in the same reading. */
  async function next(command = "npm run build", rules: PermissionRule[] = [], began = T0) {
    const parts = parallel(rules);
    parts.registry.since = began;
    parts.registry.wait = `${began}|permission prompt`;
    parts.clock.now = began;
    parts.receive("npm run lint");
    await parts.waits();
    expect(await parts.asks.answer(ID, parts.shown()?.requestId ?? "", "allow")).toBe("answered");
    parts.clock.now = ARRIVED;
    const hook = parts.receive(command);
    await parts.waits();
    /** The file says the session waits in another wait, one that began at `since`. */
    const ownWait = (since: number | undefined = ARRIVED) => {
      parts.registry.status = "waiting";
      parts.registry.wait = `${since ?? ""}|permission prompt`;
      parts.registry.since = since;
    };
    return { ...parts, hook, ownWait };
  }

  test("moves to its own wait once the file says it, and is answered there", async () => {
    const { asks, hook, ownWait, shown, drops, answered, clock } = await next();
    const requestId = shown()?.requestId ?? "";
    ownWait();
    clock.now = ARRIVED + 1_500;
    await asks.check();
    expect(shown()?.requestId).toBe(requestId);
    // A wait of its own now, past which it is let go as ever.
    expect(await asks.answer(ID, requestId, "deny")).toBe("answered");
    expect(hook.sent).toEqual([DENY_OUTPUT]);
    expect(drops).toEqual([]);
    expect(answered(waiting({ statusSince: ARRIVED }))).toEqual([ID]);
  });

  test("a wait answered within a second of beginning is known by its answer", async () => {
    const asked = await next("npm run build", [], ARRIVED - 400);
    const requestId = asked.shown()?.requestId ?? "";
    asked.ownWait(ARRIVED - 100);
    await asked.asks.check();
    expect(asked.shown()?.requestId).toBe(requestId);
    expect(asked.hook.sent).toEqual([]);

    // So is the one before a request that takes another's place there.
    const twice = await next("npm run build", [], ARRIVED - 400);
    const last = twice.receive("npm run check");
    await twice.waits();
    twice.ownWait(ARRIVED - 100);
    await twice.asks.check();
    expect(twice.shown()?.command).toBe("npm run check");
    expect(last.sent).toEqual([]);

    const ruled = await next("npm test", [ALLOW_TESTS], ARRIVED - 400);
    expect(ruled.hook.sent).toEqual([ALLOW_OUTPUT]);
    expect(ruled.answered(waiting({ statusSince: ARRIVED - 100 }))).toEqual([ID]);
    expect(ruled.answered(waiting({ statusSince: ARRIVED + 1 }))).toEqual([]);
  });

  test("is held, not shown, while the file says the session works between the two, and offered afresh after", async () => {
    const { asks, hook, registry, ownWait, shown, drops, clock } = await next();
    const requestId = shown()?.requestId ?? "";
    registry.status = "not-waiting";
    clock.now = ARRIVED + 1_000;
    await asks.check();
    expect(shown()).toBeUndefined();
    expect(await asks.answer(ID, requestId, "allow")).toBe("no-ask");
    ownWait();
    clock.now = ARRIVED + 2_000;
    await asks.check();
    // Under another id, so a page that said the press came to nothing has its buttons again.
    expect(shown()?.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(shown()?.requestId).not.toBe(requestId);
    expect(await asks.answer(ID, requestId, "allow")).toBe("no-ask");
    expect([hook.sent, drops]).toEqual([[], []]);

    // Its own wait is left as any other is.
    registry.status = "not-waiting";
    await asks.check();
    expect([hook.sent, drops]).toEqual([[""], [["left-waiting", ID]]]);
  });

  test("is let go past the grace, when the file still says no wait of its own", async () => {
    const { asks, hook, registry, clock } = await next();
    registry.status = "not-waiting";
    clock.now = ARRIVED + GRACE_MS - 1;
    await asks.check();
    expect(hook.sent).toEqual([]);
    clock.now = ARRIVED + GRACE_MS;
    await asks.check();
    expect(hook.sent).toEqual([""]);
  });

  test("is let go for a wait that began too early to be its own, has no time, or comes past the grace", async () => {
    for (const [since, at] of [
      [ARRIVED - 1_001, ARRIVED + 500],
      [undefined, ARRIVED + 500],
      [ARRIVED, ARRIVED + GRACE_MS],
    ] as const) {
      const { asks, hook, registry, clock } = await next();
      registry.wait = OWN;
      registry.since = since;
      clock.now = at;
      await asks.check();
      expect(hook.sent, `${since}`).toEqual([""]);
    }
  });

  test("a request confirmed in its own wait is never moved to another", async () => {
    const { asks, hook, ownWait, shown, clock } = await next();
    ownWait();
    await asks.check();
    ownWait(ARRIVED + 200);
    clock.now = ARRIVED + 400;
    expect(await asks.answer(ID, shown()?.requestId ?? "", "allow")).toBe("gone");
    expect(hook.sent).toEqual([""]);
  });

  test("a press as the file moves on is answered in its own wait, and sends nothing between the two", async () => {
    const own = await next();
    own.ownWait();
    expect(await own.asks.answer(ID, own.shown()?.requestId ?? "", "allow")).toBe("answered");
    expect(own.hook.sent).toEqual([ALLOW_OUTPUT]);

    const between = await next();
    const requestId = between.shown()?.requestId ?? "";
    between.registry.status = "not-waiting";
    expect(await between.asks.answer(ID, requestId, "allow")).toBe("gone");
    expect(between.hook.sent).toEqual([]);
    between.ownWait();
    await between.asks.check();
    const again = between.shown()?.requestId ?? "";
    expect(again).not.toBe(requestId);
    expect(await between.asks.answer(ID, again, "allow")).toBe("answered");
  });

  test("the third of three inside one lag stays held through the wait of the second, answered already", async () => {
    for (const rules of [[], [ALLOW_TESTS]]) {
      for (const after of [500, 1_200]) {
        const { asks, hook, ownWait, receive, waits, shown, clock, drops } = await next(
          "npm test",
          rules,
        );
        if (rules.length === 0) {
          expect(await asks.answer(ID, shown()?.requestId ?? "", "allow")).toBe("answered");
        }
        expect(hook.sent).toEqual([ALLOW_OUTPUT]);
        const third = ARRIVED + after;
        clock.now = third;
        const last = receive("npm run check");
        await waits();
        ownWait(ARRIVED);
        clock.now = third + 800;
        await asks.check();
        expect(shown()?.command, `${after}`).toBe("npm run check");
        ownWait(third);
        clock.now = third + 1_600;
        await asks.check();
        expect(shown()?.command, `${after}`).toBe("npm run check");
        expect([last.sent, drops]).toEqual([[], []]);

        // That one is its own.
        ownWait(third + 2_000);
        await asks.check();
        expect(last.sent).toEqual([""]);
      }
    }
  });

  test("is not held through a wait that began before the one answered in between", async () => {
    const { asks, ownWait, receive, waits, clock } = await next("npm test", [ALLOW_TESTS]);
    clock.now = ARRIVED + 1_200;
    const last = receive("npm run check");
    await waits();
    ownWait(ARRIVED - 1_001);
    await asks.check();
    expect(last.sent).toEqual([""]);
  });

  test("moves with the file once a rule has answered an older one of its wait", async () => {
    for (const between of [false, true]) {
      const { asks, registry, receive, waits, shown, clock, drops } = parallel();
      const first = receive("npm test");
      const second = receive("npm run build");
      // The wait is confirmed, and the older one answered, at the last check of the grace.
      clock.now = T0 + GRACE_MS - 1;
      await waits();
      expect([first.sent, shown()?.command]).toEqual([[ALLOW_OUTPUT], "npm run build"]);
      clock.now += 1_500;
      if (between) {
        registry.status = "not-waiting";
        await asks.check();
        expect(shown()).toBeUndefined();
      }
      registry.wait = OWN;
      registry.since = clock.now;
      await waits();
      expect(shown()?.command).toBe("npm run build");
      expect([second.sent, drops]).toEqual([[], []]);
      expect(await asks.answer(ID, shown()?.requestId ?? "", "deny")).toBe("answered");

      // Past the grace since that answer, another wait is another prompt's.
      const late = parallel();
      late.receive("npm test");
      const held = late.receive("npm run build");
      await late.waits();
      late.clock.now = T0 + GRACE_MS;
      late.registry.wait = OWN;
      late.registry.since = late.clock.now;
      await late.asks.check();
      expect(held.sent).toEqual([""]);
    }
  });

  test("an answer in one session says nothing of another's request", async () => {
    const { asks, registry, receive, waits, shown } = parallel();
    const other = standInReply();
    asks.receive({ ...bash("npm run lint"), sessionId: "claude-code:other" }, other.reply);
    receive("npm run build");
    await waits();
    expect(await asks.answer(ID, shown()?.requestId ?? "", "allow")).toBe("answered");
    registry.wait = OWN;
    registry.since = T0 + 1;
    await asks.check();
    expect(other.sent).toEqual([""]);
  });

  test("one a rule covered before the two, and no more, is the person's: its press is not a rule's", async () => {
    const reads: ((read: RegistryReading) => void)[] = [];
    let covered = true;
    const asks = createHeldAsks({
      status: { statusOf: () => new Promise((resolve) => reads.push(resolve)) },
      holdMs: HOLD_MS,
      now: () => ARRIVED,
      every: () => () => {},
      rules: {
        verdictFor: () => (covered ? { decision: "allow", rule: ALLOW_TESTS } : null),
        answered: () => {},
      },
    });
    const read = async (index: number, reading: RegistryReading) => {
      await vi.waitFor(() => expect(reads.length).toBeGreaterThan(index));
      reads[index]?.(reading);
    };
    asks.receive(bash("npm test"), standInReply().reply);
    await read(0, reading("waiting", undefined, T0));
    // Its rule's answer finds the file between the two.
    await read(1, reading("not-waiting"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    covered = false;
    const check = asks.check();
    await read(2, reading("waiting", OWN, ARRIVED));
    await check;
    const ask = asks.withAsks(snapshot([waiting()])).sessions[0]?.ask;
    expect(ask).toBeDefined();
    const pressed = asks.answer(ID, ask?.requestId ?? "", "allow");
    const sources = [
      { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 },
    ] as const;
    const sessions = [waiting({ statusSince: ARRIVED })];
    expect([...asks.answeredIn({ sources: [...sources], sessions })]).toEqual([]);
    await read(3, reading("waiting", OWN, ARRIVED));
    expect(await pressed).toBe("answered");
  });

  test("one a rule answers there is answered in its own wait too, whatever polls read between, and no later wait is", async () => {
    const { asks, hook, answered, clock } = await next("npm test", [ALLOW_TESTS]);
    expect(hook.sent).toEqual([ALLOW_OUTPUT]);
    expect(answered()).toEqual([ID]);
    clock.now = ARRIVED + 1_000;
    expect(answered(waiting({ status: "working" }))).toEqual([]);
    expect(answered(waiting({ statusSince: ARRIVED - 400 }))).toEqual([ID]);
    // It began after the answer, so it is not the prompt that was answered.
    expect(answered(waiting({ statusSince: ARRIVED + 1 }))).toEqual([]);
    expect(answered(waiting({ statusSince: ARRIVED - 1_001 }))).toEqual([]);
    expect(asks.size).toBe(0);
    clock.now = ARRIVED + ANSWER_HOLDS_MS;
    expect(answered(waiting({ statusSince: ARRIVED }))).toEqual([]);
  });

  test("of two a rule answers there, the wait of each is answered", async () => {
    const { receive, waits, answered, clock } = await next("npm test", [ALLOW_TESTS]);
    clock.now = ARRIVED + 1_500;
    expect(receive("npm test b").sent).toEqual([]);
    await waits();
    expect(answered(waiting({ statusSince: ARRIVED }))).toEqual([ID]);
    expect(answered(waiting({ statusSince: ARRIVED + 1_500 }))).toEqual([ID]);
  });

  test("a rule's answer waits for its own wait, when the file says none as it is written", async () => {
    const { asks, registry, receive, waits, clock, events } = parallel();
    registry.since = T0;
    clock.now = ARRIVED;
    let reads = 0;
    Object.defineProperty(registry, "status", {
      get: () => ((reads += 1) === 2 ? "not-waiting" : "waiting"),
      set: () => {},
      configurable: true,
    });
    const hook = receive("npm test");
    await vi.waitFor(() => expect(reads).toBe(2));
    expect([hook.sent, events, asks.size]).toEqual([[], [], 1]);
    registry.wait = OWN;
    registry.since = ARRIVED;
    await waits();
    expect(hook.sent).toEqual([ALLOW_OUTPUT]);
    expect(events).toHaveLength(1);
  });

  test("one let go there for a newer one that a rule answers leaves its session waiting in either wait", async () => {
    const { receive, waits, answered } = await next("npm run build", [ALLOW_TESTS]);
    const last = receive("npm test");
    await waits();
    expect(last.sent).toEqual([ALLOW_OUTPUT]);
    expect(answered()).toEqual([]);
    expect(answered(waiting({ statusSince: ARRIVED }))).toEqual([]);
  });

  test("one let go there for a newer one leaves its session waiting, once that one is answered in the wait of both", async () => {
    const { asks, receive, waits, ownWait, shown, answered } = await next();
    receive("npm run check");
    await waits();
    ownWait();
    await asks.check();
    expect(await asks.answer(ID, shown()?.requestId ?? "", "allow")).toBe("answered");
    expect(answered(waiting({ statusSince: ARRIVED }))).toEqual([]);
  });
});

describe("a session two processes have open", () => {
  const A = 4241;
  const B = 4242;
  const ALLOWED: ReturnType<RuleAnswers["verdictFor"]> = {
    decision: "allow",
    rule: { id: "aaaaaaaaaaaa", decision: "allow", tool: "Bash", command: "npm test" },
  };

  /** Each process's registry file, and the one the collector lists, over a clock the test moves. */
  function twoProcesses(rules?: Pick<RuleAnswers, "verdictFor" | "answered">) {
    const clock = { now: T0 };
    const row = { pid: A };
    /** When each process's wait for permission began, or null while it works. */
    const since = new Map<number, number | null>([
      [A, null],
      [B, null],
    ]);
    const listed = () => {
      const began = since.get(row.pid) ?? null;
      return began === null
        ? makeSession({ id: ID, status: "working", pid: row.pid, alive: true })
        : waiting({ pid: row.pid, statusSince: began });
    };
    const drops: DropReason[] = [];
    let ids = 0;
    const asks = createHeldAsks({
      status: createRegistryStatus({
        snapshot: () => snapshot([listed()], clock.now),
        env: {},
        homeDir: "/Users/example",
        readFile: async (file) => {
          const pid = Number(/(\d+)\.json$/.exec(file)?.[1]);
          const began = since.get(pid) ?? null;
          return JSON.stringify({
            pid,
            sessionId: UUID,
            ...(began === null
              ? { status: "busy", statusUpdatedAt: T0 - 60_000 }
              : { status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: began }),
          });
        },
      }),
      holdMs: HOLD_MS,
      now: () => clock.now,
      every: () => () => {},
      newId: () => (ids += 1).toString(16).padStart(32, "0"),
      onDrop: (reason) => drops.push(reason),
      ...(rules && { rules }),
    });
    const at = async (ms: number) => {
      clock.now = T0 + ms;
      await asks.check();
    };
    const poll = (): SessionsSnapshot => ({
      ...snapshot([listed()], clock.now),
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: clock.now }],
    });
    return { asks, row, since, drops, at, poll };
  }

  const shown = (asks: ReturnType<typeof createHeldAsks>, poll: SessionsSnapshot) =>
    asks.withAsks(poll).sessions[0]?.ask;

  test("an answer to one's request ends the other's wait, whose request was let go, for a moment and no longer", async () => {
    const { asks, row, since, at, poll } = twoProcesses();
    row.pid = B;
    // A's request, before any file says it waits, and B's, for which it is let go.
    asks.receive(bash("npm test"), standInReply().reply);
    since.set(A, T0 + 120);
    await at(450);
    const reply = standInReply();
    asks.receive(bash("npm run build"), reply.reply);
    since.set(B, T0 + 570);
    await at(1_000);
    const ask = shown(asks, poll());
    expect(await asks.answer(ID, ask?.requestId ?? "", "allow")).toBe("answered");
    expect(reply.sent).toEqual([ALLOW_OUTPUT]);
    expect([...asks.answeredIn(poll())]).toEqual([ID]);

    // The collector lists A now, which waits still.
    row.pid = A;
    await at(1_000 + GRACE_MS - 1);
    expect([...asks.answeredIn(poll())]).toEqual([ID]);
    await at(1_000 + GRACE_MS);
    expect([...asks.answeredIn(poll())]).toEqual([]);
  });

  test("one a rule answers while the other's wait, just begun, is read is answered in its own process's wait", async () => {
    const { asks, row, since, at, poll } = twoProcesses({
      verdictFor: ({ shown }) => (shown.command === "npm test" ? ALLOWED : null),
      answered: () => {},
    });
    row.pid = B;
    asks.receive(bash("npm run build"), standInReply().reply);
    since.set(B, T0);
    await at(500);
    await at(850);
    const reply = standInReply();
    asks.receive(bash("npm test"), reply.reply);
    since.set(A, T0 + 870);
    await at(900);
    expect(reply.sent).toEqual([ALLOW_OUTPUT]);
    row.pid = A;
    await at(1_100);
    expect([...asks.answeredIn(poll())]).toEqual([ID]);
  });

  test("one answered while the other's older wait is read is answered in its own process's wait for good", async () => {
    const { asks, row, since, at, poll } = twoProcesses();
    // A's own request, which B's is let go for.
    await at(-8_000);
    since.set(A, T0 - 8_000);
    asks.receive(bash("npm run build"), standInReply().reply);
    await at(-7_500);
    await at(0);
    asks.receive(bash("npm test"), standInReply().reply);
    since.set(B, T0 + 100);
    await at(400);
    expect(await asks.answer(ID, shown(asks, poll())?.requestId ?? "", "allow")).toBe("answered");
    row.pid = B;
    for (const ms of [500, 400 + GRACE_MS]) {
      await at(ms);
      expect([...asks.answeredIn(poll())]).toEqual([ID]);
    }
  });

  test("one between two of its own waits is not taken up by the other's older wait", async () => {
    const { asks, row, since, drops, at, poll } = twoProcesses();
    row.pid = B;
    since.set(A, T0 - 8_000);
    asks.receive(bash("npm test"), standInReply().reply);
    since.set(B, T0);
    await at(500);
    await at(1_000);
    expect(await asks.answer(ID, shown(asks, poll())?.requestId ?? "", "allow")).toBe("answered");

    // B's next prompt, before its file moves on, and answered in the session.
    await at(1_150);
    asks.receive(bash("rm -r build"), standInReply().reply);
    await at(1_200);
    expect(shown(asks, poll())?.command).toBe("rm -r build");
    since.set(B, null);
    row.pid = A;
    for (const ms of [1_500, 2_000, 2_500, 3_000, 4_000]) {
      await at(ms);
      expect(shown(asks, poll()), `${ms}`).toBeUndefined();
    }
    await at(4_200);
    expect([asks.size, drops]).toEqual([0, ["left-waiting"]]);
  });
});
