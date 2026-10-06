import { expect, test } from "vitest";

import {
  DEFAULT_HOLD_MS,
  holdMsFrom,
  MAX_HOLD_MS,
  readAnswerSetup,
} from "@collector/answers/answerSettings";

const HOME = "/Users/example";

test("by default the socket is in Agent Lookout's own folder, and a request is held five minutes", () => {
  expect(readAnswerSetup({}, HOME, "darwin")).toEqual({
    on: true,
    socketPath: "/Users/example/.agent-lookout/answer.sock",
    holdMs: DEFAULT_HOLD_MS,
    problem: null,
    ownFolder: true,
  });
  expect(DEFAULT_HOLD_MS).toBe(300_000);
});

test("AGENT_LOOKOUT_ANSWER=off turns it off, with nothing to say", () => {
  for (const value of ["off", "OFF", " off "]) {
    expect(readAnswerSetup({ AGENT_LOOKOUT_ANSWER: value }, HOME, "darwin")).toMatchObject({
      on: false,
      problem: null,
    });
  }
  expect(readAnswerSetup({ AGENT_LOOKOUT_ANSWER: "on" }, HOME, "darwin").on).toBe(true);
});

test("AGENT_LOOKOUT_ANSWER_SOCKET names another socket", () => {
  expect(
    readAnswerSetup({ AGENT_LOOKOUT_ANSWER_SOCKET: "/tmp/al/answer.sock" }, HOME, "darwin"),
  ).toMatchObject({ on: true, socketPath: "/tmp/al/answer.sock", ownFolder: false });
  // Named, but in Agent Lookout's own folder, it is still that folder.
  expect(
    readAnswerSetup(
      { AGENT_LOOKOUT_ANSWER_SOCKET: "/Users/example/.agent-lookout/other.sock" },
      HOME,
      "darwin",
    ),
  ).toMatchObject({ on: true, ownFolder: true });
});

test("with another Claude home, nothing is answered unless the socket is named too", () => {
  const env = { AGENT_LOOKOUT_CLAUDE_HOME: "/tmp/claude-home" };
  expect(readAnswerSetup(env, HOME, "darwin")).toMatchObject({ on: false, quiet: true });
  expect(
    readAnswerSetup({ ...env, AGENT_LOOKOUT_ANSWER_SOCKET: "/tmp/al/a.sock" }, HOME, "darwin").on,
  ).toBe(true);
});

test("a socket path longer than a socket can have is refused, never cut short", () => {
  const long = `/tmp/${"x".repeat(100)}/answer.sock`;
  const setup = readAnswerSetup({ AGENT_LOOKOUT_ANSWER_SOCKET: long }, HOME, "darwin");
  expect(setup.on).toBe(false);
  expect(setup.problem).toContain("AGENT_LOOKOUT_ANSWER_SOCKET");
});

test("AGENT_LOOKOUT_ANSWER_WAIT is whole seconds from 5 to 540, and anything else turns it off", () => {
  expect(holdMsFrom(undefined)).toBe(DEFAULT_HOLD_MS);
  expect(holdMsFrom("")).toBe(DEFAULT_HOLD_MS);
  expect(holdMsFrom("60")).toBe(60_000);
  expect(holdMsFrom("5")).toBe(5_000);
  expect(holdMsFrom("540")).toBe(MAX_HOLD_MS);
  for (const value of ["4", "541", "1.5", "-1", "ten", "600"]) {
    expect(holdMsFrom(value), value).toBeNull();
  }
  const setup = readAnswerSetup({ AGENT_LOOKOUT_ANSWER_WAIT: "ten" }, HOME, "darwin");
  expect(setup.on).toBe(false);
  expect(setup.problem).toContain("AGENT_LOOKOUT_ANSWER_WAIT");
});

test("it is not offered on Windows", () => {
  expect(readAnswerSetup({}, "C:\\Users\\example", "win32")).toMatchObject({ on: false });
});
