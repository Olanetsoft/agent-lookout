import { describe, expect, test, vi } from "vitest";

import { createRuleAnswers, ruleAnsweredEvent } from "@collector/answers/ruleAnswers";
import { shownAsk } from "@collector/answers/shownAsk";
import { MAX_RULE_ANSWERS } from "@core/api";
import type { PermissionRule } from "@core/permission-rules/permissionRules";
import type { SessionEvent, SessionsSnapshot } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const T0 = 1_700_000_000_000;

const ALLOW_TESTS: PermissionRule = {
  id: "aaaaaaaaaaaa",
  decision: "allow",
  tool: "Bash",
  command: "npm test:*",
};
const ASK_ALL: PermissionRule = { id: "bbbbbbbbbbbb", decision: "ask", tool: "*" };
const DENY_FETCH: PermissionRule = { id: "cccccccccccc", decision: "deny", tool: "WebFetch" };

function over(rules: PermissionRule[]) {
  const events: SessionEvent[] = [];
  let at = T0;
  const snapshot: SessionsSnapshot = {
    generatedAt: T0,
    sources: [],
    sessions: [makeSession({ id: ID, name: "checkout-flow", status: "needs-you" })],
  };
  const poller = { getSnapshot: () => snapshot, pollOnce: vi.fn(async () => snapshot) };
  const answers = createRuleAnswers({
    rules: () => rules,
    poller,
    events: { add: (added) => events.push(...added) },
    now: () => (at += 1),
  });
  return { answers, events, poller };
}

const request = (tool: string, input: Record<string, unknown>) => ({
  sessionId: ID,
  shown: shownAsk(tool, input)!,
});

describe("what the rules make of a held request", () => {
  test("with no rules there is nothing to decide", () => {
    expect(over([]).answers.verdictFor(request("Bash", { command: "npm test" }))).toBeNull();
  });

  test("an allow rule answers what Allow is offered for", () => {
    const { answers } = over([ALLOW_TESTS]);
    expect(answers.verdictFor(request("Bash", { command: "npm test" }))).toEqual({
      decision: "allow",
      rule: ALLOW_TESTS,
    });
    expect(
      answers.verdictFor(request("Bash", { command: "npm test", run_in_background: true })),
    ).toMatchObject({ decision: "allow" });
  });

  test("an allow rule never answers what the dashboard offers Deny alone for, whatever its words", () => {
    const { answers } = over([ALLOW_TESTS]);
    // Cut, with hidden characters, in right-to-left letters, or with too many blank lines.
    for (const command of [
      `npm test ${"x".repeat(4_100)}`,
      "npm test​",
      "npm test א",
      "npm test\n\n\n\nrm -rf ~",
    ]) {
      expect(answers.verdictFor(request("Bash", { command })), command).toBeNull();
    }
    expect(
      answers.verdictFor(request("Bash", { command: "npm test", dangerouslyDisableSandbox: true })),
    ).toBeNull();
  });

  test("an allow rule never answers a request the dashboard offers Deny alone for, though its words and its tool match", () => {
    // Each is one plain command, or a tool the rule names, so only the dashboard's own check stops it.
    const longTimeout = request("Bash", { command: "npm test", timeout: "x".repeat(5_000) });
    expect(longTimeout.shown).toMatchObject({ command: "npm test", allow: false });
    expect(over([ALLOW_TESTS]).answers.verdictFor(longTimeout)).toBeNull();

    const fetchAll: PermissionRule = { id: "dddddddddddd", decision: "allow", tool: "WebFetch" };
    const hiddenUrl = request("WebFetch", { url: "https://example.com/\u200bdocs" });
    expect(hiddenUrl.shown).toMatchObject({ allow: false, denyOnly: "hidden-characters" });
    expect(over([fetchAll]).answers.verdictFor(hiddenUrl)).toBeNull();
    // The same requests, shown whole, are allowed.
    expect(
      over([fetchAll]).answers.verdictFor(request("WebFetch", { url: "https://example.com/docs" })),
    ).toMatchObject({ decision: "allow" });
    expect(
      over([ALLOW_TESTS]).answers.verdictFor(request("Bash", { command: "npm test", timeout: 60 })),
    ).toMatchObject({ decision: "allow" });
  });

  test("an ask rule decides, and so leaves the request to the person", () => {
    expect(
      over([ALLOW_TESTS, ASK_ALL]).answers.verdictFor(request("Bash", { command: "npm test" })),
    ).toBeNull();
  });

  test("a deny rule answers deny", () => {
    expect(
      over([DENY_FETCH]).answers.verdictFor(request("WebFetch", { url: "https://example.com" })),
    ).toEqual({ decision: "deny", rule: DENY_FETCH });
  });
});

describe("what is recorded of an answer", () => {
  test("one event, with the tool and the rule's own words, and nothing of what was asked", () => {
    const { answers, events, poller } = over([ALLOW_TESTS]);
    const asked = request("Bash", { command: "npm test --grep secret-name", description: "Run" });
    answers.answered(asked, { decision: "allow", rule: ALLOW_TESTS });
    expect(events).toEqual([
      {
        id: `${ID}@${T0 + 1}:answered`,
        at: T0 + 1,
        sessionId: ID,
        sessionName: "checkout-flow",
        kind: "answered",
        from: "needs-you",
        severity: "advisory",
        by: "agent-lookout",
        decision: "allow",
        tool: "Bash",
        rule: { tool: "Bash", command: "npm test:*" },
      },
    ]);
    expect(answers.recent()).toEqual([
      {
        at: T0 + 1,
        sessionId: ID,
        sessionName: "checkout-flow",
        tool: "Bash",
        decision: "allow",
        rule: { decision: "allow", tool: "Bash", command: "npm test:*" },
      },
    ]);
    const kept = JSON.stringify([events, answers.recent()]);
    expect(kept).not.toContain("secret-name");
    expect(kept).not.toContain("Run");
    expect(poller.pollOnce).toHaveBeenCalledOnce();
  });

  test(`the list keeps the newest ${MAX_RULE_ANSWERS}, newest first`, () => {
    const { answers } = over([DENY_FETCH]);
    const asked = request("WebFetch", { url: "https://example.com" });
    for (let index = 0; index < MAX_RULE_ANSWERS + 5; index += 1) {
      answers.answered(asked, { decision: "deny", rule: DENY_FETCH });
    }
    const recent = answers.recent();
    expect(recent).toHaveLength(MAX_RULE_ANSWERS);
    expect(recent[0]?.at).toBe(T0 + MAX_RULE_ANSWERS + 5);
    expect(recent.at(-1)?.at).toBe(T0 + 6);
  });

  test("a session the snapshot no longer lists is named by its id", () => {
    const event = ruleAnsweredEvent(null, ID, "Read", { decision: "deny", rule: DENY_FETCH }, T0);
    expect(event.sessionName).toBe(ID);
    expect(event).not.toHaveProperty("from");
    expect(event.rule).toEqual({ tool: "WebFetch" });
  });
});
