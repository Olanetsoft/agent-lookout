import { describe, expect, test } from "vitest";

import {
  answerLead,
  decisionSentence,
  DECISION_SENTENCE,
  EMPTY_FORM,
  formOf,
  readForm,
  ruleName,
  wordsOf,
} from "@dashboard/lib/permission-rules/ruleWords";

describe("the form", () => {
  test("is an allow rule with nothing typed until the person types", () => {
    expect(EMPTY_FORM).toEqual({ decision: "allow", tool: "", command: "" });
  });

  test("reads the tool and the command with their spaces trimmed, and an empty command as none", () => {
    expect(wordsOf({ decision: "deny", tool: " Write ", command: "  " })).toEqual({
      decision: "deny",
      tool: "Write",
    });
    expect(wordsOf({ decision: "allow", tool: "Bash", command: " npm test:* " })).toEqual({
      decision: "allow",
      tool: "Bash",
      command: "npm test:*",
    });
  });

  test("says why a rule cannot be one, in the sentences the app refuses by", () => {
    expect(readForm({ decision: "allow", tool: "Bash", command: "" })).toEqual({
      ok: false,
      problem: expect.stringMatching(/names a command/),
    });
    expect(readForm({ decision: "allow", tool: "Bash", command: "npm test && rm" }).ok).toBe(false);
    expect(readForm({ decision: "allow", tool: "Bash", command: "npm test" })).toEqual({
      ok: true,
      words: { decision: "allow", tool: "Bash", command: "npm test" },
    });
  });

  test("holds a rule that is there, to edit it", () => {
    expect(formOf({ decision: "deny", tool: "WebFetch" })).toEqual({
      decision: "deny",
      tool: "WebFetch",
      command: "",
    });
  });
});

describe("the words", () => {
  test("an allow rule says plainly that Claude Code runs it without asking", () => {
    expect(DECISION_SENTENCE.allow).toContain("Claude Code runs it without asking you.");
  });

  test("an allow rule for a tool that is not Bash says it allows every request of that tool", () => {
    expect(decisionSentence({ decision: "allow", tool: " Read ", command: "" })).toBe(
      `${DECISION_SENTENCE.allow} A rule for Read allows every Read request, whatever it asks for.`,
    );
    // Bash's rules name the command; the rest can make no allow rule.
    for (const tool of ["Bash", "*", "", "  ", "Edit", "mcp__docs", "Web Fetch"]) {
      expect(decisionSentence({ decision: "allow", tool, command: "" })).toBe(
        DECISION_SENTENCE.allow,
      );
    }
    expect(decisionSentence({ decision: "deny", tool: "Read", command: "" })).toBe(
      DECISION_SENTENCE.deny,
    );
  });

  test("a rule is named with its decision, and every tool in words", () => {
    expect(ruleName({ decision: "allow", tool: "Bash", command: "npm test:*" })).toBe(
      "Allow Bash(npm test:*)",
    );
    expect(ruleName({ decision: "deny", tool: "*" })).toBe("Deny every tool");
  });

  test("an answer says what was done to which tool, before the rule", () => {
    expect(
      answerLead({ decision: "allow", tool: "Bash", rule: { decision: "allow", tool: "Bash" } }),
    ).toBe("Allowed Bash by the rule");
    expect(
      answerLead({ decision: "deny", tool: "Write", rule: { decision: "deny", tool: "*" } }),
    ).toBe("Denied Write by the rule for every tool");
  });
});
