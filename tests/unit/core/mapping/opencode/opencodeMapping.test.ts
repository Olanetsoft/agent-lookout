import { describe, expect, test } from "vitest";

import {
  ABORTED_ERROR,
  FAILED_ERRORS,
  mapOpencodeStatus,
  opencodeStatusSince,
  STEP_GAP_MS,
  type OpencodeMessageFields,
} from "@core/mapping/opencode/opencodeMapping";
import type { SessionStatus } from "@core/sessions/session";
import { CLOCK_SLACK_MS } from "@core/time";

/** Midday UTC on 1 October 2026. */
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;

/** An assistant step that ended a minute ago, with nothing wrong and a reason that ends the turn. */
function assistant(fields: Partial<OpencodeMessageFields> = {}): OpencodeMessageFields {
  return {
    role: "assistant",
    completedAt: NOW - MINUTE,
    error: null,
    finish: "stop",
    tools: 0,
    shell: 0,
    ...fields,
  };
}

const user: OpencodeMessageFields = {
  role: "user",
  completedAt: null,
  error: null,
  finish: null,
  tools: 0,
  shell: 0,
};

const both = (message: OpencodeMessageFields | null, now = NOW) =>
  [true, false].map((open) => mapOpencodeStatus({ message, open, now }));

describe("mapOpencodeStatus", () => {
  // Every row of the table in opencodeMapping.ts and docs/adapters/opencode.md:
  // [what the newest message is, open, closed].
  test.each<[string, OpencodeMessageFields | null, SessionStatus, SessionStatus]>([
    ["none", null, "idle", "finished"],
    ["the person's", user, "working", "finished"],
    ["a step still running", assistant({ completedAt: null, finish: null }), "working", "finished"],
    ["a stopped step", assistant({ error: ABORTED_ERROR }), "idle", "finished"],
    ["a step that ended on an error", assistant({ error: "APIError" }), "failed", "failed"],
    [
      "a step that ended on an error of another name",
      assistant({ error: "SomeNewError" }),
      "unknown",
      "unknown",
    ],
    [
      "a step that asked for tools a moment ago",
      assistant({ finish: "tool-calls", completedAt: NOW - 1_000 }),
      "working",
      "finished",
    ],
    [
      "a step that asked for tools a while ago",
      assistant({ finish: "tool-calls" }),
      "idle",
      "finished",
    ],
    ["a step that ended the turn", assistant(), "idle", "finished"],
    [
      "a command the person ran with !, which has ended",
      assistant({ finish: null, tools: 1, shell: 1, completedAt: NOW - 1_000 }),
      "idle",
      "finished",
    ],
    [
      "a command the person ran with !, still running",
      assistant({ finish: null, tools: 1, shell: 1, completedAt: null }),
      "working",
      "finished",
    ],
    ["another role", { ...user, role: "system" }, "unknown", "unknown"],
    ["a role that is not text", { ...user, role: 7 }, "unknown", "unknown"],
  ])("the newest message is %s", (_what, message, open, closed) => {
    expect(both(message)).toEqual([open, closed]);
  });

  test("every error OpenCode records but a stop fails the session, open or closed", () => {
    expect(FAILED_ERRORS).toHaveLength(7);
    for (const error of FAILED_ERRORS) {
      expect(both(assistant({ error })), error).toEqual(["failed", "failed"]);
    }
    expect(FAILED_ERRORS).not.toContain(ABORTED_ERROR);
  });

  test("an error is read before whether the step ended", () => {
    expect(both(assistant({ error: "APIError", completedAt: null }))).toEqual(["failed", "failed"]);
    expect(both(assistant({ error: ABORTED_ERROR, completedAt: null }))).toEqual([
      "idle",
      "finished",
    ]);
  });

  test("a step that goes on is working for STEP_GAP_MS after it ended, then idle", () => {
    for (const goesOn of [
      { finish: "tool-calls" },
      { finish: "unknown" },
      { finish: null },
      { tools: 1 },
      { finish: "stop", tools: 2 },
    ]) {
      const label = JSON.stringify(goesOn);
      const at = (ms: number) => assistant({ ...goesOn, completedAt: NOW - ms });
      expect(both(at(0)), label).toEqual(["working", "finished"]);
      expect(both(at(STEP_GAP_MS - 1)), label).toEqual(["working", "finished"]);
      expect(both(at(STEP_GAP_MS)), label).toEqual(["idle", "finished"]);
    }
    expect(STEP_GAP_MS).toBe(10_000);
  });

  test("a step that ended while the poll read, a little after it noted its time, is still working", () => {
    for (const ahead of [1, 5_000, CLOCK_SLACK_MS]) {
      expect(
        both(assistant({ finish: "tool-calls", completedAt: NOW + ahead })),
        `${ahead}`,
      ).toEqual(["working", "finished"]);
    }
  });

  test("a clock set back further than the slack counts as time enough", () => {
    expect(
      both(assistant({ finish: "tool-calls", completedAt: NOW + CLOCK_SLACK_MS + 1 })),
    ).toEqual(["idle", "finished"]);
  });

  test("only a step with no reason it ended and the shell's one tool part is a command the person ran", () => {
    // A step that asked for tools, or ended the turn, goes as it would.
    expect(
      both(assistant({ finish: "tool-calls", tools: 1, shell: 1, completedAt: NOW - 1_000 })),
    ).toEqual(["working", "finished"]);
    expect(both(assistant({ finish: null, tools: 2, shell: 0, completedAt: NOW - 1_000 }))).toEqual(
      ["working", "finished"],
    );
    expect(
      both(assistant({ finish: null, tools: 1, shell: null, completedAt: NOW - 1_000 })),
    ).toEqual(["working", "finished"]);
  });

  test("a field of the wrong type is unknown, open or closed", () => {
    for (const wrong of [
      { completedAt: "soon" },
      { completedAt: 1.5 },
      { error: 3 },
      { error: undefined },
      { finish: 1 },
      { finish: undefined },
      { tools: -1 },
      { tools: "2" },
      { shell: 2 },
      { shell: "1" },
      { shell: undefined },
      { role: undefined },
    ]) {
      expect(both(assistant(wrong)), JSON.stringify(wrong)).toEqual(["unknown", "unknown"]);
    }
  });

  test("it never says a session needs you", () => {
    const messages: (OpencodeMessageFields | null)[] = [
      null,
      user,
      ...[null, NOW - 1_000, NOW - MINUTE].flatMap((completedAt) =>
        [null, ABORTED_ERROR, "APIError", "Other"].flatMap((error) =>
          [null, "stop", "tool-calls", "unknown"].flatMap((finish) =>
            [0, 1].flatMap((tools) =>
              [0, 1].map((shell) => assistant({ completedAt, error, finish, tools, shell })),
            ),
          ),
        ),
      ),
    ];
    const seen = new Set(messages.flatMap((message) => both(message)));
    expect(seen.has("needs-you")).toBe(false);
    expect(seen).toEqual(new Set(["idle", "working", "finished", "failed", "unknown"]));
  });
});

describe("opencodeStatusSince", () => {
  const times = {
    sessionCreatedAt: NOW - 30 * MINUTE,
    messageCreatedAt: NOW - 2 * MINUTE,
    userCreatedAt: NOW - 5 * MINUTE,
    completedAt: NOW - MINUTE,
    activityAt: NOW - 40_000,
  };

  test("working is the person's newest prompt, else the newest message's start, else the session's", () => {
    expect(opencodeStatusSince("working", times, NOW)).toBe(NOW - 5 * MINUTE);
    expect(opencodeStatusSince("working", { ...times, userCreatedAt: null }, NOW)).toBe(
      NOW - 2 * MINUTE,
    );
    expect(
      opencodeStatusSince(
        "working",
        { ...times, userCreatedAt: null, messageCreatedAt: null },
        NOW,
      ),
    ).toBe(NOW - 30 * MINUTE);
  });

  test("idle, failed and finished are when the newest step ended, else the newest write", () => {
    for (const status of ["idle", "failed", "finished"] as const) {
      expect(opencodeStatusSince(status, times, NOW), status).toBe(NOW - MINUTE);
      expect(opencodeStatusSince(status, { ...times, completedAt: null }, NOW), status).toBe(
        NOW - 40_000,
      );
    }
  });

  test("unknown has no time, and a time that could not be right is not known", () => {
    expect(opencodeStatusSince("unknown", times, NOW)).toBeNull();
    expect(
      opencodeStatusSince("idle", { ...times, completedAt: 12, activityAt: null }, NOW),
    ).toBeNull();
    // Further ahead of the clock than the slack allows.
    expect(
      opencodeStatusSince("working", { ...times, userCreatedAt: NOW + 10 * MINUTE }, NOW),
    ).toBe(NOW - 2 * MINUTE);
  });
});
