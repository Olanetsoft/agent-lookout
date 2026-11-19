import { describe, expect, test } from "vitest";

import {
  idOf as tokenId,
  judgeHeadLine,
  judgeLine,
  LINE_MAX,
  MAX_ID_BYTES,
  timeOf,
} from "@collector/adapters/muse-code/records";
import {
  ACTION,
  asked,
  CWD,
  decided,
  marker,
  metadata,
  modelChanged,
  NOW,
  PRIVATE_WORDS,
  PROMPT,
  record,
  renamed,
  replied,
  requested,
  retracted,
  reviewCompleted,
  reviewStarted,
  RUN,
  sampled,
  SESSION_ID,
  sessionEnd,
  sessionResumed,
  settled,
  started,
  taskOutput,
  terminal,
  waitEnded,
} from "@tests/fixtures/muse-code/museCode";

const FOLDER = Buffer.from(SESSION_ID);
const AT = NOW - 60_000;

/** A line of a fixture as the reader gives it: without its line break, whole. */
const judge = (text: string, folder: Buffer = FOLDER) =>
  judgeLine(Buffer.from(text.replace(/\n$/, "")), true, folder);

/** The same record spaced after each colon and comma, as one reader's files hold Muse Code's lines. */
function spaced(line: string): string {
  const write = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(write).join(", ")}]`;
    if (value !== null && typeof value === "object") {
      const fields = Object.entries(value).map(
        ([name, inner]) => `${JSON.stringify(name)}: ${write(inner)}`,
      );
      return `{${fields.join(", ")}}`;
    }
    return JSON.stringify(value);
  };
  return write(JSON.parse(line));
}

describe("the records that decide", () => {
  test("a run's start, end and retraction, by their run's ID and time", () => {
    expect(judge(started(RUN, AT))).toEqual({
      sort: "record",
      record: { sort: "started", run: RUN, at: AT },
    });
    for (const [end, sort] of [
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
      ["interrupted", "other"],
    ]) {
      expect(judge(terminal(RUN, AT, end))).toEqual({
        sort: "record",
        record: { sort: "terminal", run: RUN, end: sort, at: AT },
      });
    }
    expect(judge(retracted(RUN, AT))).toEqual({
      sort: "record",
      record: { sort: "retracted", run: RUN, at: AT },
    });
  });

  test("a question and its answer, by the prompt's ID", () => {
    expect(judge(asked(RUN, PROMPT, AT))).toEqual({
      sort: "record",
      record: { sort: "asked", run: RUN, prompt: PROMPT, at: AT },
    });
    expect(judge(settled(RUN, PROMPT, AT))).toEqual({
      sort: "record",
      record: { sort: "settled", run: RUN, prompt: PROMPT, at: AT },
    });
  });

  test("an approval's request with its phase, its review, its decision and its wait's end", () => {
    for (const [phase, read] of [
      ["automated_reviewing", "automated_reviewing"],
      ["human_pending", "human_pending"],
      ["something_new", "other"],
      [undefined, "none"],
    ] as const) {
      expect(judge(requested(RUN, ACTION, AT, phase))).toEqual({
        sort: "record",
        record: { sort: "requested", run: RUN, action: ACTION, phase: read, at: AT },
      });
    }
    expect(judge(reviewStarted(RUN, ACTION, AT))).toEqual({
      sort: "record",
      record: { sort: "review-started", run: RUN, action: ACTION, at: AT },
    });
    expect(judge(decided(RUN, ACTION, AT))).toEqual({
      sort: "record",
      record: { sort: "decided", run: RUN, action: ACTION, at: AT },
    });
    expect(judge(waitEnded(ACTION, AT))).toEqual({
      sort: "record",
      record: { sort: "wait-ended", action: ACTION, at: AT },
    });
  });

  test("a review's word is clean only when it approved, did not time out and did not fail", () => {
    const clean = (completion: Parameters<typeof reviewCompleted>[3]) => {
      const judged = judge(reviewCompleted(RUN, ACTION, AT, completion));
      return judged.sort === "record" && judged.record.sort === "review-completed"
        ? judged.record.clean
        : null;
    };
    expect(clean({ status: "approved" })).toBe(true);
    expect(clean({ status: "escalated" })).toBe(false);
    expect(clean({ status: "timed_out" })).toBe(false);
    expect(clean({ status: "approved", timedOut: true })).toBe(false);
    expect(clean({ status: "approved", failure: { kind: "unavailable" } })).toBe(false);
    expect(clean({ status: "approved", failure: "x" })).toBe(false);
    // A failure left out is none.
    const line = reviewCompleted(RUN, ACTION, AT, { status: "approved" }).replace(
      '"failure":null,',
      "",
    );
    const judged = judge(line);
    expect(judged).toMatchObject({ record: { sort: "review-completed", clean: true } });
  });

  test("the session's end and resume, and every other event of a run, an approval or a task", () => {
    expect(judge(sessionEnd(AT))).toEqual({ sort: "record", record: { sort: "end", at: AT } });
    expect(judge(sessionEnd(AT, "crash_inferred"))).toEqual({
      sort: "record",
      record: { sort: "end", at: AT },
    });
    expect(judge(sessionResumed(AT))).toEqual({
      sort: "record",
      record: { sort: "resumed", at: AT },
    });
    expect(judge(replied(RUN, AT))).toEqual({
      sort: "record",
      record: { sort: "run-event", run: RUN, at: AT },
    });
    expect(judge(sampled(RUN, AT))).toMatchObject({ record: { sort: "run-event" } });
    expect(judge(taskOutput(RUN, AT))).toEqual({
      sort: "record",
      record: { sort: "other", at: AT },
    });
    const policy = record(
      "runtime.session",
      { kind: "approval", run_id: RUN, event: { kind: "policy_persistence_succeeded" } },
      AT,
    );
    expect(judge(policy)).toEqual({
      sort: "record",
      record: { sort: "approval-event", run: RUN, at: AT },
    });
  });

  test("keys in another order are read alike, as a hand-authored record of Meta's writes them", () => {
    const line = JSON.stringify({
      payload: { event: { kind: "started", prompt: "x" }, kind: "run", run_id: RUN },
      payload_type: "runtime.session",
      recorded_at: AT * 1000,
      stream: { id: SESSION_ID, kind: "session" },
      schema_version: 1,
    });
    expect(judge(line)).toEqual({ sort: "record", record: { sort: "started", run: RUN, at: AT } });
  });

  test("a line spaced after each colon and comma is read as the same line compact", () => {
    const lines = [
      started(RUN, AT),
      terminal(RUN, AT, "failed"),
      asked(RUN, PROMPT, AT),
      requested(RUN, ACTION, AT, "human_pending"),
      reviewCompleted(RUN, ACTION, AT, { status: "escalated" }),
      reviewCompleted(RUN, ACTION, AT, { status: "approved" }),
      decided(RUN, ACTION, AT),
      waitEnded(ACTION, AT),
      sessionEnd(AT, "crash_inferred"),
      sessionResumed(AT),
    ];
    for (const line of lines) {
      const compact = judge(line);
      expect(compact, line).toMatchObject({ sort: "record" });
      expect(spaced(line), line).toContain('": ');
      expect(judge(spaced(line)), line).toEqual(compact);
    }
    expect(judgeHeadLine(Buffer.from(spaced(metadata(AT))), FOLDER, "darwin")).toEqual({
      cwd: CWD,
      at: AT,
    });
  });
});

describe("lines passed over", () => {
  test("a line that holds none of the payload types read is not walked, whatever else it is", () => {
    expect(judge(renamed(AT))).toEqual({ sort: "passed" });
    expect(judge(modelChanged(AT))).toEqual({ sort: "passed" });
    expect(judge("not json at all")).toEqual({ sort: "passed" });
    // A string that holds the type with its quotes escaped is not the type.
    expect(judge(JSON.stringify({ text: '"runtime.session"', x: "{" }))).toEqual({
      sort: "passed",
    });
  });

  test("a line of another type, another stream or another session is passed over", () => {
    expect(judge(record("runtime.session.route_facts", { pid: 1 }, AT))).toEqual({
      sort: "passed",
    });
    expect(judge(started(RUN, AT, { stream: { kind: "run", id: SESSION_ID } }))).toEqual({
      sort: "passed",
    });
    expect(
      judge(started(RUN, AT, { stream: { kind: "session", id: SESSION_ID.toUpperCase() } })),
    ).toEqual({
      sort: "passed",
    });
    expect(judge(started(RUN, AT, { stream: null }))).toEqual({ sort: "passed" });
    expect(judge(started(RUN, AT), Buffer.from("01900000-0000-7000-8000-000000000999"))).toEqual({
      sort: "passed",
    });
  });

  test("a frame and a marker are passed over, and a frame is never opened, whatever it holds", () => {
    expect(judge(marker())).toEqual({ sort: "passed" });
    const framed = JSON.stringify({
      retained_frame: "session_permission_transaction",
      schema_version: 1,
      stream: { kind: "session", id: SESSION_ID },
      recorded_at: AT * 1000,
      payload_type: "runtime.session",
      payload: { kind: "run", run_id: RUN, event: { kind: "started" } },
    });
    expect(judge(framed)).toEqual({ sort: "passed" });
    // Without its frame key the same line is a run's start.
    expect(
      judge(framed.replace('"retained_frame":"session_permission_transaction",', "")),
    ).toMatchObject({
      record: { sort: "started" },
    });
  });

  test("the metadata record is read only in the log's first bytes", () => {
    expect(judge(metadata(AT))).toEqual({ sort: "passed" });
  });
});

describe("lines that would decide and cannot be read", () => {
  test("a syntax error, or a wanted path met twice, before what is needed is read", () => {
    expect(judge(started(RUN, AT).replace('"stream":{', '"stream":{,'))).toEqual({
      sort: "unreadable",
      newer: false,
    });
    // Past what its kind needs, nothing is looked at.
    expect(judge(started(RUN, AT).replace(/}\s*$/, ""))).toMatchObject({
      record: { sort: "started" },
    });
    const twice = started(RUN, AT).replace('"run_id":', '"run_id":"x","run_id":');
    expect(judge(twice)).toEqual({ sort: "unreadable", newer: false });
  });

  test("a schema version other than 1, newer when it is a whole number above it", () => {
    expect(judge(started(RUN, AT, { schemaVersion: 2 }))).toEqual({
      sort: "unreadable",
      newer: true,
    });
    expect(judge(started(RUN, AT, { schemaVersion: 10 }))).toEqual({
      sort: "unreadable",
      newer: true,
    });
    for (const version of [0, 1.5, -2, "1", null]) {
      expect(judge(started(RUN, AT, { schemaVersion: version })), String(version)).toEqual({
        sort: "unreadable",
        newer: false,
      });
    }
    expect(judge(started(RUN, AT, { schemaVersion: undefined }))).toEqual({
      sort: "unreadable",
      newer: false,
    });
  });

  test("a field its kind needs missing or not of its kind", () => {
    const cases = [
      record("runtime.session", { run_id: RUN, event: { kind: "started" } }, AT),
      record("runtime.session", { kind: 1, run_id: RUN, event: { kind: "started" } }, AT),
      record("runtime.session", { kind: "run", run_id: RUN }, AT),
      record("runtime.session", { kind: "run", run_id: RUN, event: { kind: 7 } }, AT),
      record("runtime.session", { kind: "run", event: { kind: "started" } }, AT),
      record("runtime.session", { kind: "run", run_id: RUN, event: { kind: "terminal" } }, AT),
      record(
        "runtime.session",
        { kind: "run", run_id: RUN, event: { kind: "terminal", terminal: 1 } },
        AT,
      ),
      record(
        "runtime.session",
        { kind: "run", run_id: RUN, event: { kind: "user_input_prompt_requested" } },
        AT,
      ),
      record(
        "runtime.session",
        { kind: "approval", run_id: RUN, event: { kind: "requested" } },
        AT,
      ),
      record(
        "runtime.session",
        { kind: "approval", run_id: RUN, event: { kind: "decision_applied" } },
        AT,
      ),
      record("approval_wait.effect.terminal", { record: {} }, AT),
      record("approval_wait.effect.terminal", { pending_action_id: ACTION }, AT),
    ];
    for (const line of cases)
      expect(judge(line), line).toEqual({ sort: "unreadable", newer: false });
  });

  test("an ID with a byte it may not hold, none, or more than 128 bytes", () => {
    for (const id of ["", "a b", "a/b", 'a"b', "é", "a".repeat(MAX_ID_BYTES + 1), 7]) {
      expect(judge(started(id as string, AT)), String(id)).toEqual({
        sort: "unreadable",
        newer: false,
      });
    }
    const longest = "a".repeat(MAX_ID_BYTES);
    expect(judge(started(longest, AT))).toMatchObject({ record: { run: longest } });
    expect(judge(started("run.1:a_b-C", AT))).toMatchObject({ record: { run: "run.1:a_b-C" } });
  });
});

describe("a line longer than what is walked", () => {
  test("its fields read before the first 1 MiB decide, as a start whose prompt comes after its kind", () => {
    const line = started(RUN, AT, undefined, "x".repeat(2 * LINE_MAX)).replace(/\n$/, "");
    expect(judgeLine(Buffer.from(line).subarray(0, LINE_MAX), false, FOLDER)).toEqual({
      sort: "record",
      record: { sort: "started", run: RUN, at: AT },
    });
  });

  test("a field it needs past the first 1 MiB is missing, so the line cannot be read", () => {
    const line = JSON.stringify({
      schema_version: 1,
      stream: { kind: "session", id: SESSION_ID },
      recorded_at: AT * 1000,
      payload_type: "runtime.session",
      payload: {
        event: { prompt: "x".repeat(2 * LINE_MAX), kind: "started" },
        kind: "run",
        run_id: RUN,
      },
    });
    expect(judgeLine(Buffer.from(line).subarray(0, LINE_MAX), false, FOLDER)).toEqual({
      sort: "unreadable",
      newer: false,
    });
  });

  test("an approval request's phase past the first 1 MiB is not needed, so it is read as none", () => {
    const line = JSON.stringify({
      schema_version: 1,
      stream: { kind: "session", id: SESSION_ID },
      recorded_at: AT * 1000,
      payload_type: "runtime.session",
      payload: {
        kind: "approval",
        run_id: RUN,
        event: {
          kind: "requested",
          pending_action_id: ACTION,
          raw_args: "x".repeat(2 * LINE_MAX),
          presentation_phase: "human_pending",
        },
      },
    });
    expect(judgeLine(Buffer.from(line).subarray(0, LINE_MAX), false, FOLDER)).toEqual({
      sort: "record",
      record: { sort: "requested", run: RUN, action: ACTION, phase: "none", at: AT },
    });
  });
});

describe("times", () => {
  test("recorded_at in microseconds is milliseconds, from 1 to 16 digits alone", () => {
    expect(judge(started(RUN, AT, { recordedAt: AT * 1000 + 999 }))).toMatchObject({
      record: { at: AT },
    });
    for (const value of [-1, 1.5, "1700000000000000", null, 10 ** 16]) {
      expect(judge(started(RUN, AT, { recordedAt: value })), String(value)).toMatchObject({
        record: { at: null },
      });
    }
    expect(judge(started(RUN, AT, { recordedAt: undefined }))).toMatchObject({
      record: { at: null },
    });
    const exponent = started(RUN, AT).replace(/"recorded_at":\d+/, '"recorded_at":17e14');
    expect(judge(exponent)).toMatchObject({ record: { at: null } });
    const line = Buffer.from("9007199254740993");
    expect(timeOf(line, { type: "number", start: 0, end: line.byteLength })).toBeNull();
    const safe = Buffer.from("9007199254740991");
    expect(timeOf(safe, { type: "number", start: 0, end: safe.byteLength })).toBe(9007199254740);
  });
});

describe("the metadata record in the log's first bytes", () => {
  const head = (text: string, platform: NodeJS.Platform = "darwin") =>
    judgeHeadLine(Buffer.from(text.replace(/\n$/, "")), FOLDER, platform);

  test("gives the workspace folder and the record's time", () => {
    expect(head(metadata(AT))).toEqual({ cwd: CWD, at: AT });
    expect(head(metadata(AT, null))).toEqual({ cwd: null, at: AT });
  });

  test("keeps a folder only when it is a whole path of the system's, with no control character, of 4,096 characters at most", () => {
    expect(head(metadata(AT, "code/demo"))?.cwd).toBeNull();
    expect(head(metadata(AT, "/Users/example/a\u0007b"))?.cwd).toBeNull();
    expect(head(metadata(AT, `/${"a".repeat(4095)}`))?.cwd).toBe(`/${"a".repeat(4095)}`);
    expect(head(metadata(AT, `/${"a".repeat(4096)}`))?.cwd).toBeNull();
    expect(head(metadata(AT, 7))?.cwd).toBeNull();
    expect(head(metadata(AT, "C:\\Users\\example\\code\\demo"), "win32")?.cwd).toBe(
      "C:\\Users\\example\\code\\demo",
    );
    expect(head(metadata(AT, "C:\\Users\\example\\code\\demo"), "darwin")?.cwd).toBeNull();
    expect(head(metadata(AT, "/Users/example/code/demo"), "win32")?.cwd).toBe(
      "/Users/example/code/demo",
    );
  });

  test("decodes a folder that holds an escape by JSON's rules", () => {
    expect(head(metadata(AT, '/Users/example/code/"demo"'))?.cwd).toBe(
      '/Users/example/code/"demo"',
    );
  });

  test("is none on another stream, of another schema, or of another type", () => {
    expect(head(metadata(AT, CWD, { stream: { kind: "subagent", id: SESSION_ID } }))).toBeNull();
    expect(head(metadata(AT, CWD, { schemaVersion: 2 }))).toBeNull();
    expect(head(started(RUN, AT))).toBeNull();
    expect(head(metadata(AT).replace('"stream":{', '"stream":{,'))).toBeNull();
  });
});

test("no prompt, question, answer, command, reply or review is ever turned into text", () => {
  const lines = [
    started(RUN, AT),
    asked(RUN, PROMPT, AT),
    settled(RUN, PROMPT, AT),
    requested(RUN, ACTION, AT, "automated_reviewing"),
    reviewStarted(RUN, ACTION, AT),
    reviewCompleted(RUN, ACTION, AT),
    decided(RUN, ACTION, AT),
    replied(RUN, AT),
    taskOutput(RUN, AT),
    renamed(AT),
  ];
  const judged = JSON.stringify(lines.map((line) => judge(line)));
  for (const word of PRIVATE_WORDS) expect(judged, word).not.toContain(word);
  expect(tokenId(Buffer.from("abc"), { type: "string", start: 0, end: 3, escaped: false })).toBe(
    "abc",
  );
});
