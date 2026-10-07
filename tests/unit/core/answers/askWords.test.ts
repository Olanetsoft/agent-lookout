import { expect, test } from "vitest";

import { answerOutcomeWords, askHeading, denyOnlyWords } from "@core/answers/askWords";
import { DENY_ONLY_REASONS } from "@core/sessions/session";

test("the heading says what the request asks, and who asks it", () => {
  expect(askHeading({ tool: "Bash", command: "npm test" })).toBe("Asks to run");
  expect(askHeading({ tool: "Write" })).toBe("Asks to use Write");
  expect(askHeading({ tool: "Bash", command: "ls", subagent: true })).toBe(
    "A subagent asks to run",
  );
  expect(askHeading({ tool: "Bash", command: "ls" }, true)).toBe("It now asks to run");
  expect(askHeading({ tool: "Write", subagent: true }, true)).toBe(
    "A subagent now asks to use Write",
  );
});

test("each answer, and each reason for Deny alone, has words of its own", () => {
  expect(answerOutcomeWords("allowed")).toBe("Allowed from Agent Lookout.");
  expect(answerOutcomeWords("denied")).toBe(
    "Denied from Agent Lookout. Claude carries on without it.",
  );
  const reasons = DENY_ONLY_REASONS.map(denyOnlyWords);
  expect(new Set(reasons).size).toBe(DENY_ONLY_REASONS.length);
});
