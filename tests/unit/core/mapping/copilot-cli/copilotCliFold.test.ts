import { describe, expect, test } from "vitest";

import {
  applyCopilotRecord,
  copilotCwdOf,
  copyCopilotFold,
  OPEN_MAX,
  startCopilotFold,
  type CopilotFold,
  type CopilotRecord,
} from "@core/mapping/copilot-cli/copilotCliFold";

const T = Date.UTC(2026, 10, 20, 12, 0, 0);

function fold(...records: CopilotRecord[]): CopilotFold {
  const made = startCopilotFold();
  for (const record of records) applyCopilotRecord(made, record);
  return made;
}

const start = (cwd: string | null = "/Users/example/code/demo", at = T): CopilotRecord => ({
  sort: "start",
  cwd,
  at,
});

describe("a lifetime", () => {
  test("a session.start begins one, with its folder and its time", () => {
    const made = fold(start());
    expect(made.startedAt).toBe(T);
    expect(copilotCwdOf(made)).toBe("/Users/example/code/demo");
    expect(made.newest).toEqual({ sort: "start", at: T });
    expect(made.turn).toEqual({ state: "closed" });
  });

  test("a resume's folder wins over the start's, and the first start's time stays", () => {
    const made = fold(
      start("/Users/example/code/demo", T),
      { sort: "resume", cwd: "/Users/example/code/other", continuePending: false, at: T + 5 },
      start("/Users/example/code/demo", T + 10),
    );
    expect(made.startedAt).toBe(T);
    // A later start is the newest lifetime, and its folder stands.
    expect(copilotCwdOf(made)).toBe("/Users/example/code/demo");
    const resumed = fold(start(), {
      sort: "resume",
      cwd: "/Users/example/code/other",
      continuePending: false,
      at: T + 5,
    });
    expect(copilotCwdOf(resumed)).toBe("/Users/example/code/other");
    // A resume that names no folder keeps the one before.
    expect(
      copilotCwdOf(fold(start(), { sort: "resume", cwd: null, continuePending: false, at: T })),
    ).toBe("/Users/example/code/demo");
  });

  const busy: CopilotRecord[] = [
    start(),
    { sort: "user", at: T + 1 },
    { sort: "turn-start", turn: "0", sub: null, at: T + 2 },
    { sort: "turn-start", turn: "0", sub: "task-1", at: T + 3 },
    { sort: "tool-start", call: "c-1", ask: false, at: T + 4 },
    { sort: "tool-start", call: "c-2", ask: true, at: T + 5 },
    { sort: "permission", request: "r-1", byHook: false, at: T + 6 },
  ];

  test("a resume drops what was open before it, unless Copilot goes on with it", () => {
    const dropped = fold(...busy, {
      sort: "resume",
      cwd: null,
      continuePending: false,
      at: T + 10,
    });
    expect(dropped.permissions.size + dropped.questions.size + dropped.tools.size).toBe(0);
    expect(dropped.subTurns.size).toBe(0);
    expect(dropped.turn).toEqual({ state: "closed" });
    expect(dropped.askedAt).toBeNull();
    expect(dropped.newest).toEqual({ sort: "resume", at: T + 10 });

    const kept = fold(...busy, { sort: "resume", cwd: null, continuePending: true, at: T + 10 });
    expect([...kept.permissions.keys()]).toEqual(["r-1"]);
    expect([...kept.questions.keys()]).toEqual(["c-2"]);
    expect([...kept.tools]).toEqual(["c-1"]);
    expect(kept.subTurns.size).toBe(1);
    expect(kept.turn).toMatchObject({ state: "open", id: "0" });
  });

  test("a new start drops everything open and makes the fold sure again", () => {
    const made = fold(...busy, { sort: "unreadable" }, start(null, T + 20));
    expect(made.unsure).toBe(false);
    expect(made.permissions.size + made.questions.size + made.tools.size).toBe(0);
    expect(made.subTurns.size).toBe(0);
  });
});

describe("turns", () => {
  test("a main turn is open from its start to its end, and notes whether a reply in it asked for tools", () => {
    const opened = fold(start(), { sort: "turn-start", turn: "0", sub: null, at: T + 1 });
    expect(opened.turn).toEqual({ state: "open", id: "0", at: T + 1 });
    const asked = fold(
      start(),
      { sort: "turn-start", turn: "0", sub: null, at: T + 1 },
      { sort: "reply", tools: true },
      { sort: "reply", tools: false },
      { sort: "turn-end", turn: "0", sub: null, at: T + 2 },
    );
    expect(asked.turn).toEqual({ state: "closed" });
    expect(asked.newest).toEqual({ sort: "turn-end", at: T + 2, tools: true });
    const none = fold(
      start(),
      { sort: "turn-start", turn: "1", sub: null, at: T + 1 },
      { sort: "reply", tools: false },
      { sort: "turn-end", turn: "1", sub: null, at: T + 2 },
    );
    expect(none.newest).toEqual({ sort: "turn-end", at: T + 2, tools: false });
    const notKnown = fold(
      start(),
      { sort: "turn-start", turn: "1", sub: null, at: T + 1 },
      { sort: "reply", tools: null },
      { sort: "turn-end", turn: "1", sub: null, at: T + 2 },
    );
    expect(notKnown.newest).toMatchObject({ sort: "turn-end", tools: null });
  });

  test("a task's completion that ends the run makes its open turn one that asks for nothing more", () => {
    const run = (goesOn: boolean | null) =>
      fold(
        start(),
        { sort: "turn-start", turn: "4", sub: null, at: T + 1 },
        { sort: "reply", tools: true },
        { sort: "tool-start", call: "c-9", ask: false, at: T + 2 },
        { sort: "task-complete", goesOn, at: T + 3 },
        { sort: "tool-end", call: "c-9" },
        { sort: "turn-end", turn: "4", sub: null, at: T + 4 },
      ).newest;
    expect(run(false)).toEqual({ sort: "turn-end", at: T + 4, tools: false });
    // One that goes on leaves the turn's tools as they were, and one that does not say makes them not known.
    expect(run(true)).toEqual({ sort: "turn-end", at: T + 4, tools: true });
    expect(run(null)).toEqual({ sort: "turn-end", at: T + 4, tools: null });
    // After the turn's end, it is the newest lifecycle line, with whether the run goes on.
    const after = fold(
      start(),
      { sort: "turn-start", turn: "4", sub: null, at: T + 1 },
      { sort: "turn-end", turn: "4", sub: null, at: T + 2 },
      { sort: "task-complete", goesOn: false, at: T + 3 },
    );
    expect(after.newest).toEqual({ sort: "task-complete", at: T + 3, goesOn: false });
  });

  test("an end that names another turn closes nothing", () => {
    const made = fold(
      start(),
      { sort: "turn-start", turn: "1", sub: null, at: T + 1 },
      { sort: "turn-end", turn: "0", sub: null, at: T + 2 },
    );
    expect(made.turn).toMatchObject({ state: "open", id: "1" });
    expect(made.newest).toMatchObject({ sort: "turn-start" });
  });

  test("a sub-agent's turns are kept apart, by its parent call and turn, until each ends", () => {
    const made = fold(
      start(),
      { sort: "turn-start", turn: "0", sub: "task-1", at: T + 1 },
      { sort: "turn-start", turn: "0", sub: "task-2", at: T + 2 },
      { sort: "turn-end", turn: "0", sub: "task-1", at: T + 3 },
    );
    expect(made.subTurns.size).toBe(1);
    // The main turn and the newest lifecycle line are not a sub-agent's.
    expect(made.turn).toEqual({ state: "closed" });
    expect(made.newest).toEqual({ sort: "start", at: T });
  });
});

describe("waits and tool calls", () => {
  test("a permission request is open until its completion, whichever is written first, from any agent", () => {
    const after = fold(
      start(),
      { sort: "tool-start", call: "c-1", ask: false, at: T + 1 },
      { sort: "permission", request: "r-1", byHook: false, at: T + 2 },
    );
    expect([...after.permissions]).toEqual([["r-1", T + 2]]);
    const before = fold(
      start(),
      { sort: "permission", request: "r-1", byHook: false, at: T + 1 },
      { sort: "tool-start", call: "c-1", ask: false, at: T + 2 },
    );
    expect([...before.permissions]).toEqual([["r-1", T + 1]]);
    expect(
      fold(
        start(),
        { sort: "permission", request: "r-1", byHook: false, at: T + 1 },
        {
          sort: "permission-end",
          request: "r-1",
        },
      ).permissions.size,
    ).toBe(0);
    // A completion written before its request: the request opens nothing.
    const early = fold(
      start(),
      { sort: "permission-end", request: "r-1" },
      { sort: "permission", request: "r-1", byHook: false, at: T + 2 },
    );
    expect(early.permissions.size).toBe(0);
    expect(early.settled.size).toBe(0);
  });

  test("a request a hook settled opens nothing", () => {
    expect(
      fold(start(), { sort: "permission", request: "r-1", byHook: true, at: T + 1 }).permissions
        .size,
    ).toBe(0);
  });

  test("completions whose request has not come are kept, the newest OPEN_MAX, and never make the fold unsure", () => {
    const made = fold(start());
    // A long session of requests a hook settled, each followed by its completion.
    for (let n = 0; n < OPEN_MAX + 44; n += 1) {
      applyCopilotRecord(made, { sort: "permission", request: `h-${n}`, byHook: true, at: T });
      applyCopilotRecord(made, { sort: "permission-end", request: `h-${n}` });
    }
    expect(made.unsure).toBe(false);
    expect(made.settled.size).toBe(OPEN_MAX);
    // The oldest went first.
    expect(made.settled.has("h-0")).toBe(false);
    expect(made.settled.has(`h-${OPEN_MAX + 43}`)).toBe(true);
    // A completion kept still closes its request when it comes.
    applyCopilotRecord(made, { sort: "permission-end", request: "r-1" });
    applyCopilotRecord(made, { sort: "permission", request: "r-1", byHook: false, at: T });
    expect(made.permissions.size).toBe(0);
    expect(made.settled.has("r-1")).toBe(false);
  });

  test("an ask_user call is a question, and any other call a tool, until its completion", () => {
    const made = fold(
      start(),
      { sort: "tool-start", call: "c-1", ask: true, at: T + 1 },
      { sort: "tool-start", call: "c-2", ask: false, at: T + 2 },
    );
    expect([...made.questions]).toEqual([["c-1", T + 1]]);
    expect([...made.tools]).toEqual(["c-2"]);
    applyCopilotRecord(made, { sort: "tool-end", call: "c-1" });
    applyCopilotRecord(made, { sort: "tool-end", call: "c-2" });
    expect(made.questions.size + made.tools.size).toBe(0);
  });

  const permission = (request: string, at: number | null): CopilotRecord => ({
    sort: "permission",
    request,
    byHook: false,
    at,
  });
  const question = (call: string, at: number | null): CopilotRecord => ({
    sort: "tool-start",
    call,
    ask: true,
    at,
  });
  const answered = (call: string): CopilotRecord => ({ sort: "tool-end", call });

  test("has waited since the first thing open was asked, for as long as anything stays open", () => {
    const since = (...records: CopilotRecord[]) => fold(start(), ...records).waitingSince;
    const first = question("c-1", T + 1);
    const second = permission("r-1", T + 2);
    expect(since()).toBeNull();
    expect(since(first, second)).toBe(T + 1);
    // One asked before the last was answered goes on with its wait, and one asked after is another.
    expect(since(first, second, answered("c-1"))).toBe(T + 1);
    expect(since(first, answered("c-1"))).toBeNull();
    expect(since(first, answered("c-1"), second)).toBe(T + 2);
    expect(since(second, { sort: "permission-end", request: "r-1" })).toBeNull();
    // No other tool call is a wait, and a first with no time leaves it not known.
    expect(since({ sort: "tool-start", call: "c-9", ask: false, at: T + 1 })).toBeNull();
    expect(since(question("c-1", null), second)).toBeNull();
    // What drops everything open ends it.
    expect(since(first, { sort: "gap" })).toBeNull();
    expect(since(first, start())).toBeNull();
  });

  test("a main turn's start or end, or an abort, passes the open questions by, until they are answered", () => {
    const turn = (sort: "turn-start" | "turn-end", sub: string | null = null): CopilotRecord => ({
      sort,
      turn: sort === "turn-start" ? "1" : "0",
      sub,
      at: T + 5,
    });
    const asked = (...records: CopilotRecord[]) =>
      fold(
        start(),
        { sort: "turn-start", turn: "0", sub: null, at: T },
        question("c-1", T + 1),
        ...records,
      );
    const passing: CopilotRecord[] = [
      turn("turn-start"),
      turn("turn-end"),
      { sort: "abort", at: T + 5 },
    ];
    for (const record of passing) {
      const made = asked(record);
      expect([...made.questions.keys()]).toEqual(["c-1"]);
      expect([...made.passed]).toEqual(["c-1"]);
      expect(made.waitingSince).toBeNull();
      // What is asked after it has waited since then, and what was open beside it goes on.
      applyCopilotRecord(made, question("c-2", T + 7));
      expect([...made.passed]).toEqual(["c-1"]);
      expect(made.waitingSince).toBe(T + 7);
      expect(asked(permission("r-1", T + 2), record).waitingSince).toBe(T + 1);
      applyCopilotRecord(made, answered("c-1"));
      expect(made.passed.size).toBe(0);
    }
    const staying: CopilotRecord[] = [
      turn("turn-start", "task-1"),
      turn("turn-end", "task-1"),
      { sort: "turn-end", turn: "9", sub: null, at: T + 5 },
      { sort: "user", at: T + 5 },
      { sort: "error", at: T + 5 },
      { sort: "resume", cwd: null, continuePending: true, at: T + 5 },
    ];
    for (const record of staying) {
      expect(asked(record)).toMatchObject({ passed: new Set(), waitingSince: T + 1 });
    }
    expect(asked(turn("turn-start"), start()).passed.size).toBe(0);
  });

  test("more open than it keeps makes the fold unsure, and lets go of what it held", () => {
    const made = fold(start());
    for (let n = 0; n <= OPEN_MAX; n += 1) {
      applyCopilotRecord(made, { sort: "tool-start", call: `c-${n}`, ask: false, at: T });
    }
    expect(made.unsure).toBe(true);
    expect(made.tools.size).toBeLessThanOrEqual(OPEN_MAX);
  });
});

describe("lines that are not read", () => {
  test("an unreadable line makes the fold unsure", () => {
    expect(fold(start(), { sort: "unreadable" }).unsure).toBe(true);
  });

  test("a gap drops everything open and leaves the main turn not known", () => {
    const made = fold(
      start(),
      { sort: "user", at: T + 1 },
      { sort: "turn-start", turn: "0", sub: null, at: T + 2 },
      { sort: "permission", request: "r-1", byHook: false, at: T + 3 },
      { sort: "gap" },
    );
    expect(made.turn).toEqual({ state: "unknown" });
    expect(made.turnTools).toBeNull();
    expect(made.newest).toBeNull();
    expect(made.askedAt).toBeNull();
    expect(made.permissions.size).toBe(0);
    // Its start and folder stand.
    expect(made.startedAt).toBe(T);
    // A turn's end after a gap knows only what was read since.
    applyCopilotRecord(made, { sort: "reply", tools: false });
    applyCopilotRecord(made, { sort: "turn-end", turn: "0", sub: null, at: T + 9 });
    expect(made.newest).toEqual({ sort: "turn-end", at: T + 9, tools: null });
  });

  test("a copy stands apart from the fold it was made from", () => {
    const made = fold(start(), { sort: "permission", request: "r-1", byHook: false, at: T });
    applyCopilotRecord(made, { sort: "tool-start", call: "c-1", ask: true, at: T });
    const copy = copyCopilotFold(made);
    applyCopilotRecord(copy, { sort: "permission-end", request: "r-1" });
    applyCopilotRecord(copy, { sort: "turn-start", turn: "0", sub: null, at: T });
    expect(made.permissions.size).toBe(1);
    expect([copy.passed.size, made.passed.size]).toEqual([1, 0]);
    expect(made.turn).toEqual({ state: "closed" });
  });
});
