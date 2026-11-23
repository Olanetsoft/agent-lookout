import { describe, expect, test } from "vitest";

import {
  deltaSpanOf,
  deltaStateOf,
  type DeltaState,
} from "@collector/adapters/mistral-vibe/deltaWalker";
import {
  canonical,
  delta,
  MINUTE,
  NOW,
  publicState,
  record,
  sessionApiFacts,
  sessionId,
  type StateFields,
} from "@tests/fixtures/mistralVibe";

const running: StateFields = {
  id: sessionId("a1"),
  status: "running",
  title: "demo-project refactor",
  turn: { status: "in_progress", startedAt: NOW - MINUTE },
};

const bytes = (text: string) => Buffer.from(text.replace(/\n$/, ""));

/** The state a walk of the line from byte `from` on found, as text, or the kind of answer when it found none. */
function found(text: string, from = 0): string {
  const line = bytes(text).subarray(from);
  const result: DeltaState = deltaStateOf(line, from === 0);
  return result.kind === "state"
    ? line.toString("utf8", result.state.start, result.state.end)
    : result.kind;
}

const STATE = canonical(publicState(running));

describe("walking a projection_delta line back from its end", () => {
  test("finds the newest set_envelope step's state, byte for byte, with or without session_api", () => {
    expect(found(delta(5, running))).toBe(STATE);
    expect(found(delta(5, running, undefined, sessionApiFacts()))).toBe(STATE);
  });

  test("steps over strings that hold quotes, backslashes and the record's own keys", () => {
    const tricky = [
      'a "quoted" word',
      "C:\\",
      '\\"',
      '{"op":"set_envelope","state":{}}],"watermark":1}',
      "\\\\",
    ];
    const entries = tricky.map((text, index) => ({ id: `entry-${index}`, text }));
    const facts = sessionApiFacts({ texts: tricky, 'a key with \\ and "': tricky });
    expect(found(delta(5, running, entries, facts))).toBe(STATE);
    expect(found(delta(5, undefined, entries, facts))).toBe("none");
  });

  test("steps over session_api whole, whatever its objects hold", () => {
    const facts = sessionApiFacts({
      op: "set_envelope",
      state: publicState({ ...running, status: "idle" }),
      nested: [[{ deep: [{}] }], { "]": "[", "}": "{" }],
    });
    expect(found(delta(5, running, undefined, facts))).toBe(STATE);
  });

  test("sets no state for an empty delta, one of entries only, or a state under another op", () => {
    expect(found(record("projection_delta", 5, { delta: [], watermark: 5 }))).toBe("none");
    expect(found(delta(5, undefined, undefined, sessionApiFacts()))).toBe("none");
    expect(found(record("projection_delta", 5, { delta: [], session_api: {}, watermark: 5 }))).toBe(
      "none",
    );
    const later = { op: "a_step_vibe_adds_later", state: publicState(running) };
    expect(found(record("projection_delta", 5, { delta: [later], watermark: 5 }))).toBe("none");
  });

  test("reads the state from the end of a line whose start it was not given", () => {
    const text = delta(5, running, [{ id: "entry-5", text: "y".repeat(4096) }], sessionApiFacts());
    expect(found(text, 2048)).toBe(STATE);
  });

  test("is cut when what it walks starts before the bytes it was given", () => {
    const facts = sessionApiFacts({ content: "y".repeat(4096) });
    const text = delta(5, running, undefined, facts);
    // Inside session_api, after the state.
    expect(found(text, text.indexOf("yyyy"))).toBe("cut");
    // Inside the header.
    expect(found(text, text.indexOf('"record_sha256"'))).toBe("cut");
    // A delta of entries only, cut inside its last entry.
    const entries = delta(5, undefined, [{ id: "entry-5", text: "y".repeat(4096) }]);
    expect(found(entries, entries.indexOf("yyyy"))).toBe("cut");
  });

  test("is cut, not misled, when the bytes start inside a run of backslashes", () => {
    // The step's id is q\"rest, written "q\\\"rest": a backslash escaped, then a quote escaped.
    const step = { op: "remove_entry", id: 'q\\"rest' };
    const text = record("projection_delta", 5, { delta: [step], watermark: 5 });
    const run = text.indexOf('\\\\\\"rest');
    expect(run).toBeGreaterThan(0);
    // Given from the second backslash on, the escaped quote looks like the one that opens the id.
    expect(found(text, run + 1)).toBe("cut");
    expect(found(text, run)).toBe("cut");
    expect(found(text)).toBe("none");
  });

  test("a line not laid out as Vibe writes a projection_delta is bad", () => {
    for (const text of [
      "",
      "not json",
      '{"payload":{"delta":[],"watermark":5},"type":"projection_delta"',
      record("projection_delta", 5, { watermark: 5 }),
      record("projection_delta", 5, { delta: [], later: 1, watermark: 5 }),
      record("projection_delta", 5, { delta: [], watermark: 5, zone: 1 }),
      record("projection_delta", 5, { delta: [], session_api: {}, watermark: 5 }).replace(
        '"delta":[]',
        '"delta":[}',
      ),
      record("projection_delta", 5, { delta: ["a step"], watermark: 5 }),
      record("projection_delta", 5, { delta: [{ op: "set_envelope", state: null }], watermark: 5 }),
      record("projection_delta", 5, { delta: [{ op: "set_envelope" }], watermark: 5 }),
    ]) {
      expect(found(text), text.slice(0, 80)).toBe("bad");
    }
  });

  test("an array under another key, after the delta or in its place, is bad", () => {
    const step = { op: "set_envelope", state: publicState(running) };
    for (const payload of [
      { delta: [step], later: [], watermark: 5 },
      { delta: [], later: [step], watermark: 5 },
      { delta: [step], queue: [], session_api: {}, watermark: 5 },
      { steps: [step], watermark: 5 },
    ]) {
      const text = record("projection_delta", 5, payload);
      expect(found(text), text.slice(0, 80)).toBe("bad");
    }
  });

  test("on a line whose start it was not given, checks the delta's key when the key is in the bytes given", () => {
    const step = { op: "set_envelope", state: publicState(running) };
    const text = record("projection_delta", 5, { delta: [], later: [step], watermark: 5 });
    expect(found(text, 1)).toBe("bad");
    // With the key before the bytes given, the array is walked as the delta.
    expect(found(text, text.indexOf('"later"') + 1)).toBe(STATE);
  });
});

/** The steps a walk of the line from byte `from` on found, as text, or the kind of answer when it found none. */
function steps(text: string, from = 0): string {
  const line = bytes(text).subarray(from);
  const result = deltaSpanOf(line, from === 0);
  return result.kind === "delta"
    ? line.toString("utf8", result.delta.start, result.delta.end)
    : result.kind;
}

describe("finding a projection_delta line's steps", () => {
  const step = { op: "set_envelope", state: publicState(running) };
  const entries = [{ id: "entry-5", text: '{"op":"x"}],"session_api":{},"watermark":1}' }];

  test("is its delta array, byte for byte, with or without session_api, and nothing of what follows", () => {
    const array = canonical([...entries.map((entry) => ({ op: "append_entry", entry })), step]);
    expect(steps(delta(5, running, entries))).toBe(array);
    expect(steps(delta(5, running, entries, sessionApiFacts()))).toBe(array);
    expect(steps(record("projection_delta", 5, { delta: [], watermark: 5 }))).toBe("[]");
    const facts = sessionApiFacts({ delta: [step], watermark: 1 });
    expect(
      steps(record("projection_delta", 5, { delta: [], session_api: facts, watermark: 5 })),
    ).toBe("[]");
  });

  test("is bad for a line not laid out as Vibe writes a projection_delta, as the state's walk is", () => {
    for (const text of [
      "",
      "not json",
      record("projection_delta", 5, { watermark: 5 }),
      record("projection_delta", 5, { delta: [step], later: [], watermark: 5 }),
      record("projection_delta", 5, { delta: [step], queue: [], session_api: {}, watermark: 5 }),
      record("projection_delta", 5, { delta: {}, watermark: 5 }),
      record("projection_delta", 5, { steps: [step], watermark: 5 }),
      record("projection_delta", 5, { delta: [], watermark: 5, zone: 1 }),
    ]) {
      expect(steps(text), text.slice(0, 80)).toBe("bad");
    }
  });

  test("is cut when the array, or its key, starts before the bytes it was given", () => {
    const text = delta(5, running, entries, sessionApiFacts());
    expect(steps(text, text.indexOf('"record_sha256"'))).toBe("cut");
    expect(steps(text, text.indexOf("entry-5"))).toBe("cut");
    expect(steps(text, text.indexOf('"delta"') + 1)).toBe("cut");
    // From the key's opening quote, what is before it, a backslash or not, is not known.
    expect(steps(text, text.indexOf('"delta"'))).toBe("cut");
    // From the payload's opening brace on, the array and its key are found.
    expect(steps(text, text.indexOf('"delta"') - 1)).toBe(steps(text));
  });
});
