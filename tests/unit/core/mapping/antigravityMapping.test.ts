import { describe, expect, test } from "vitest";

import {
  ANTIGRAVITY_STEP_STATUSES,
  ANTIGRAVITY_STEP_TYPES,
  isAsideStep,
  mapAntigravityStatus,
  openStatusOf,
  stepStatusName,
  stepTypeName,
  type AntigravityLiveness,
  type AntigravityStep,
} from "@core/mapping/antigravityMapping";

const done = (type: string, toolCalls = false): AntigravityStep => ({
  type,
  status: "DONE",
  toolCalls,
});

describe("the names agy 1.3.1 defines", () => {
  test("are every step type and status of its program, each once", () => {
    expect(ANTIGRAVITY_STEP_TYPES).toHaveLength(118);
    expect(new Set(ANTIGRAVITY_STEP_TYPES).size).toBe(118);
    expect(ANTIGRAVITY_STEP_STATUSES).toHaveLength(12);
    expect(new Set(ANTIGRAVITY_STEP_STATUSES).size).toBe(12);
    for (const name of [...ANTIGRAVITY_STEP_TYPES, ...ANTIGRAVITY_STEP_STATUSES]) {
      expect(name).toMatch(/^[A-Z][A-Z0-9_]+$/);
    }
  });

  test("are read as written, in any case, and with the program's own prefix", () => {
    expect(stepTypeName("USER_INPUT")).toBe("USER_INPUT");
    expect(stepTypeName("user_input")).toBe("USER_INPUT");
    expect(stepTypeName(" PLANNER_RESPONSE ")).toBe("PLANNER_RESPONSE");
    expect(stepTypeName("CORTEX_STEP_TYPE_RUN_COMMAND")).toBe("RUN_COMMAND");
    expect(stepStatusName("done")).toBe("DONE");
    expect(stepStatusName("CORTEX_STEP_STATUS_WAITING")).toBe("WAITING");
  });

  test("anything else is no name", () => {
    for (const value of [
      undefined,
      null,
      3,
      true,
      {},
      [],
      "",
      "user input",
      "DONE!",
      "x".repeat(65),
    ]) {
      expect(stepTypeName(value)).toBeNull();
      expect(stepStatusName(value)).toBeNull();
    }
  });
});

describe("the steps passed over", () => {
  test("are those that say nothing of whose turn it is, and steps no longer in the conversation", () => {
    const aside = ANTIGRAVITY_STEP_TYPES.filter((type) => isAsideStep(done(type)));
    expect(aside.sort()).toEqual(
      [
        "BRAIN_UPDATE",
        "CHECKPOINT",
        "CIDER_AGENT_DUMMY",
        "CONVERSATION_HISTORY",
        "DIRECTORY_RULES",
        "DUMMY",
        "EPHEMERAL_MESSAGE",
        "KI_INSERTION",
        "KNOWLEDGE_ARTIFACTS",
        "KNOWLEDGE_GENERATION",
        "SUGGESTED_RESPONSES",
        "SYSTEM_MESSAGE",
      ].sort(),
    );
    expect(isAsideStep({ type: "PLANNER_RESPONSE", status: "CLEARED" })).toBe(true);
    expect(isAsideStep({ type: "RUN_COMMAND", status: "INVALID" })).toBe(true);
    expect(isAsideStep({ type: null, status: null })).toBe(false);
  });
});

describe("what one step says while agy has the conversation open", () => {
  test("every step type agy defines, once done", () => {
    const by = new Map<string, string[]>();
    for (const type of ANTIGRAVITY_STEP_TYPES) {
      if (isAsideStep(done(type))) continue;
      const status = openStatusOf(done(type));
      by.set(status, [...(by.get(status) ?? []), type]);
    }
    expect(by.get("idle")).toEqual(["FINISH", "PLANNER_RESPONSE"]);
    expect(by.get("failed")).toEqual(["ERROR_MESSAGE"]);
    expect(by.get("unknown")).toEqual(["UNSPECIFIED"]);
    // Every other type is a step the agent goes on from: the person's prompt, or a tool.
    expect(by.get("working")).toContain("USER_INPUT");
    expect(by.get("working")).toContain("RUN_COMMAND");
    expect(by.get("working")).toContain("ASK_QUESTION");
    expect(by.get("working")).toContain("NOTIFY_USER");
    expect(by.get("working")).toContain("INVOKE_SUBAGENT");
    expect(by.get("working")).toHaveLength(118 - 12 - 4);
  });

  test("a reply that asks for a tool is working, and one that does not ends the turn", () => {
    expect(openStatusOf(done("PLANNER_RESPONSE", true))).toBe("working");
    expect(openStatusOf(done("PLANNER_RESPONSE", false))).toBe("idle");
  });

  test("a step under way is working, whatever its type, a wait for approval included", () => {
    for (const status of ["PENDING", "RUNNING", "GENERATING", "QUEUED", "WAITING"]) {
      for (const type of ["PLANNER_RESPONSE", "RUN_COMMAND", "ASK_QUESTION", "A_TYPE_FROM_LATER"]) {
        expect(openStatusOf({ type, status, toolCalls: false }), `${type} ${status}`).toBe(
          "working",
        );
      }
    }
  });

  test("a step the person stopped, with Esc or Ctrl+C, hands the turn back", () => {
    for (const status of ["CANCELED", "INTERRUPTED"]) {
      expect(openStatusOf({ type: "RUN_COMMAND", status, toolCalls: false })).toBe("idle");
      expect(openStatusOf({ type: "PLANNER_RESPONSE", status, toolCalls: true })).toBe("idle");
    }
  });

  test("a failed reply, or an error agy reports as a step, is failed; a failed tool is not", () => {
    expect(openStatusOf({ type: "PLANNER_RESPONSE", status: "ERROR", toolCalls: false })).toBe(
      "failed",
    );
    expect(openStatusOf({ type: "ERROR_MESSAGE", status: "DONE", toolCalls: false })).toBe(
      "failed",
    );
    expect(openStatusOf({ type: "ERROR_MESSAGE", status: null, toolCalls: false })).toBe("failed");
    expect(openStatusOf({ type: "RUN_COMMAND", status: "ERROR", toolCalls: false })).toBe(
      "working",
    );
    expect(openStatusOf({ type: "VIEW_FILE", status: "ERROR", toolCalls: false })).toBe("working");
  });

  test("a type or status it does not know, or none, is unknown rather than a guess", () => {
    expect(openStatusOf({ type: "A_TYPE_FROM_LATER", status: "DONE", toolCalls: false })).toBe(
      "unknown",
    );
    expect(
      openStatusOf({ type: "RUN_COMMAND", status: "A_STATUS_FROM_LATER", toolCalls: false }),
    ).toBe("unknown");
    expect(openStatusOf({ type: "RUN_COMMAND", status: "UNSPECIFIED", toolCalls: false })).toBe(
      "unknown",
    );
    expect(openStatusOf({ type: null, status: "DONE", toolCalls: false })).toBe("unknown");
    expect(openStatusOf({ type: "RUN_COMMAND", status: null, toolCalls: false })).toBe("unknown");
  });
});

describe("mapAntigravityStatus", () => {
  const live: AntigravityLiveness[] = [true, "unknown", false];

  test.each([
    [done("USER_INPUT"), ["working", "working", "finished"]],
    [done("PLANNER_RESPONSE", true), ["working", "working", "finished"]],
    [done("PLANNER_RESPONSE"), ["idle", "idle", "finished"]],
    [null, ["idle", "idle", "finished"]],
    [done("ERROR_MESSAGE"), ["failed", "failed", "failed"]],
    [done("A_TYPE_FROM_LATER"), ["unknown", "unknown", "unknown"]],
    [undefined, ["unknown", "unknown", "unknown"]],
  ] as const)("%o: open, not known, closed", (last, expected) => {
    expect(live.map((value) => mapAntigravityStatus({ last, live: value }))).toEqual(expected);
  });

  test("is never needs-you, for any step agy defines in any status", () => {
    for (const type of [...ANTIGRAVITY_STEP_TYPES, "A_TYPE_FROM_LATER"]) {
      for (const status of [...ANTIGRAVITY_STEP_STATUSES, "A_STATUS_FROM_LATER"]) {
        for (const toolCalls of [true, false]) {
          for (const value of live) {
            const mapped = mapAntigravityStatus({ last: { type, status, toolCalls }, live: value });
            expect(mapped, `${type} ${status}`).not.toBe("needs-you");
          }
        }
      }
    }
  });
});
