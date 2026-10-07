import { describe, expect, test } from "vitest";

import {
  addAgyLogLine,
  agyLogTimeAt,
  emptyAgyLogState,
  readAgyLogLine,
  waitsForApproval,
  type AgyLogState,
} from "@core/mapping/antigravityLog";
import {
  answeredLine,
  askingLog,
  conversationId,
  logLine,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  WORKSPACE,
} from "@tests/fixtures/antigravity";

const FIRST = conversationId("a1");
const SECOND_ONE = conversationId("b2");

/** The state after these lines, read in order. */
function stateOf(lines: string[]): AgyLogState {
  const state = emptyAgyLogState();
  for (const text of lines.join("").split("\n")) {
    const line = readAgyLogLine(text);
    if (line) addAgyLogLine(state, line);
  }
  return state;
}

describe("a line of agy's log", () => {
  test("names the folder its program works in", () => {
    expect(
      readAgyLogLine(
        logLine(
          NOW,
          `Creating CLI server backend: product=antigravity workspaceDirs=[${WORKSPACE}] appDataDir=/x`,
        ).trimEnd(),
      ),
    ).toEqual({ kind: "folder", folder: WORKSPACE });
  });

  test("names no folder for more than one, a relative one, or one it cannot tell apart", () => {
    for (const dirs of ["/a /b", "demo", "", "/a]b"]) {
      const text = logLine(NOW, `Creating CLI server backend: workspaceDirs=[${dirs}] x=1`);
      expect(readAgyLogLine(text.trimEnd()), dirs).toBeNull();
    }
  });

  test("says which conversation was opened, in lower case", () => {
    const id = FIRST.toUpperCase();
    for (const words of ["Created conversation", "Streaming conversation"]) {
      expect(readAgyLogLine(logLine(NOW, `${words} ${id}`).trimEnd())).toEqual({
        kind: "opened",
        conversation: FIRST,
      });
    }
  });

  test("says an approval is asked for, with the tool, the step and the local time", () => {
    const at = new Date(2026, 9, 7, 13, 0, 19, 223);
    const line = readAgyLogLine(
      logLine(at.getTime(), 'Surfacing tool confirmation: "RunCommand" at step 2').trimEnd(),
    );
    expect(line).toEqual({
      kind: "asking",
      tool: "RunCommand",
      step: 2,
      at: { month: 10, day: 7, hour: 13, minute: 0, second: 19, millisecond: 223 },
    });
  });

  test("says an approval was answered, either way", () => {
    for (const approved of [true, false]) {
      expect(readAgyLogLine(answeredLine(NOW, FIRST, 2, approved).trimEnd())).toEqual({
        kind: "answered",
        conversation: FIRST,
        step: 2,
      });
    }
  });

  test("is passed over when it is of any other kind, not whole, or not in glog's format", () => {
    for (const text of [
      logLine(NOW, `Sending user message to conversation ${FIRST} (items=1, media=0)`),
      logLine(NOW, PRIVATE_WORDS),
      logLine(NOW, 'Surfacing tool confirmation: "Run Command" at step 2'),
      logLine(NOW, 'Surfacing tool confirmation: "RunCommand" at step two'),
      logLine(NOW, `Created conversation ${FIRST} and more`),
      `Surfacing tool confirmation: "RunCommand" at step 2`,
      `I1007 13:00:19.223691 Surfacing tool confirmation: "RunCommand" at step 2`,
      "",
    ]) {
      expect(readAgyLogLine(text.trimEnd()), text).toBeNull();
    }
  });
});

describe("what a program's log says", () => {
  test("from its start to an approval it waits for", () => {
    const state = stateOf(askingLog(NOW, FIRST, 2));
    expect(state).toEqual({
      folder: WORKSPACE,
      opened: new Set([FIRST]),
      current: FIRST,
      ask: { conversation: FIRST, step: 2, tool: "RunCommand", at: expect.any(Object) },
    });
    expect(JSON.stringify([...state.opened, state])).not.toContain("rename the helper");
  });

  test("the approval is over once it is answered", () => {
    const state = stateOf([...askingLog(NOW, FIRST, 2), answeredLine(NOW + 30 * SECOND, FIRST, 2)]);
    expect(state.ask).toBeNull();
    expect(state.current).toBe(FIRST);
  });

  test("an answer to another step or conversation leaves it", () => {
    const state = stateOf([
      ...askingLog(NOW, FIRST, 4),
      answeredLine(NOW + 30 * SECOND, FIRST, 2),
      answeredLine(NOW + 30 * SECOND, SECOND_ONE, 4),
    ]);
    expect(state.ask).toMatchObject({ conversation: FIRST, step: 4 });
  });

  test("opening another conversation takes the approval off the screen", () => {
    const state = stateOf([
      ...askingLog(NOW, FIRST, 2),
      logLine(NOW + 40 * SECOND, `Streaming conversation ${SECOND_ONE}`),
    ]);
    expect(state).toMatchObject({ current: SECOND_ONE, ask: null });
    expect(state.opened).toEqual(new Set([FIRST, SECOND_ONE]));
  });

  test("an approval asked for before any conversation is open is not one", () => {
    const state = stateOf([logLine(NOW, 'Surfacing tool confirmation: "RunCommand" at step 2')]);
    expect(state.ask).toBeNull();
  });
});

describe("whether a conversation waits for approval", () => {
  const ask = {
    conversation: FIRST,
    step: 2,
    tool: "RunCommand",
    at: { month: 10, day: 1, hour: 12, minute: 0, second: 0, millisecond: 0 },
  };

  test("while the transcript holds no step at the one that waits", () => {
    expect(waitsForApproval(ask, FIRST, 1)).toBe(true);
    expect(waitsForApproval(ask, FIRST, null)).toBe(true);
  });

  test("not once the transcript holds that step or a later one", () => {
    expect(waitsForApproval(ask, FIRST, 2)).toBe(false);
    expect(waitsForApproval(ask, FIRST, 9)).toBe(false);
  });

  test("not for another conversation, or with no approval asked", () => {
    expect(waitsForApproval(ask, SECOND_ONE, 1)).toBe(false);
    expect(waitsForApproval(null, FIRST, 1)).toBe(false);
  });
});

describe("a log line's time", () => {
  const time = (month: number, day: number) => ({
    month,
    day,
    hour: 13,
    minute: 0,
    second: 19,
    millisecond: 223,
  });

  test("is in the year it is read in", () => {
    const near = new Date(2026, 9, 7, 14, 0, 0).getTime();
    expect(agyLogTimeAt(time(10, 7), near)).toBe(new Date(2026, 9, 7, 13, 0, 19, 223).getTime());
  });

  test("written on 31 December and read on 1 January is in the year before", () => {
    const near = new Date(2027, 0, 1, 0, 5, 0).getTime();
    expect(agyLogTimeAt(time(12, 31), near)).toBe(new Date(2026, 11, 31, 13, 0, 19, 223).getTime());
  });

  test("is none for a day that does not exist", () => {
    expect(agyLogTimeAt(time(2, 30), NOW)).toBeNull();
    expect(agyLogTimeAt(time(13, 1), NOW)).toBeNull();
  });
});
