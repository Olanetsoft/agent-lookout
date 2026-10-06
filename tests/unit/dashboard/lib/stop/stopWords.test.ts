import { expect, test } from "vitest";

import {
  DESKTOP_NO_STOP,
  DESKTOP_STOP_THERE,
  resumeCommand,
  stopDoes,
  stopInterrupts,
  stopQuestion,
} from "@dashboard/lib/stop/stopWords";
import { makeSession } from "@tests/fixtures/session";

const UUID = "00000000-0000-4000-8000-000000000001";

const text = (runs: { text: string }[]) => runs.map((run) => run.text).join("");
const commands = (runs: { text: string; fact: boolean }[]) =>
  runs.filter((run) => run.fact).map((run) => run.text);

test("the question names the session", () => {
  expect(stopQuestion({ name: "checkout-flow" })).toBe("Stop checkout-flow?");
});

test("a Claude Code session's conversation is opened again with claude --resume and its own id", () => {
  expect(resumeCommand(makeSession({ id: `claude-code:${UUID}` }))).toBe(`claude --resume ${UUID}`);
  expect(resumeCommand(makeSession({ id: `codex:${UUID}`, source: "codex" }))).toBeNull();
  expect(resumeCommand(makeSession({ id: "claude-code:" }))).toBeNull();
});

test("in a terminal, its process ends now and the conversation is kept, with the command in the mono", () => {
  const runs = stopDoes(
    makeSession({ id: `claude-code:${UUID}`, surface: "terminal", stop: { how: "signal" } }),
  );
  expect(text(runs)).toBe(
    `Its process ends now. The conversation is kept, and claude --resume ${UUID} opens it again.`,
  );
  expect(commands(runs)).toEqual(["claude --resume", UUID]);
});

test("claude --resume is never broken across lines, and the ID after it may be", () => {
  const runs = stopDoes(
    makeSession({ id: `claude-code:${UUID}`, surface: "vscode", stop: { how: "signal" } }),
  );
  const whole = runs.filter((run) => run.fact).map((run) => [run.text, run.whole === true]);
  expect(whole).toEqual([
    ["claude --resume", true],
    [UUID, false],
  ]);
});

test("in VS Code, it says the session history opens it too", () => {
  const runs = stopDoes(
    makeSession({ id: `claude-code:${UUID}`, surface: "vscode", stop: { how: "signal" } }),
  );
  expect(text(runs)).toBe(
    `Its process ends now. The conversation is kept: open it again from the session history in VS Code, or with claude --resume ${UUID}.`,
  );
});

test("a background job is stopped with claude stop", () => {
  const runs = stopDoes(
    makeSession({ id: `claude-code:${UUID}`, surface: "terminal", stop: { how: "background" } }),
  );
  expect(text(runs)).toBe(
    `Agent Lookout asks Claude Code to stop this background job with claude stop. The conversation is kept, and claude --resume ${UUID} opens it again.`,
  );
  expect(commands(runs)).toEqual(["claude stop", "claude --resume", UUID]);
});

test("a row of the sessions left running says only where to stop a desktop app's session", () => {
  expect(DESKTOP_STOP_THERE).toBe("Stop it in the desktop app.");
  expect(DESKTOP_NO_STOP.startsWith(DESKTOP_STOP_THERE)).toBe(true);
});

test("what is lost: the work under way, or the question left unanswered, and nothing for an idle one", () => {
  expect(stopInterrupts({ status: "working" })).toBe(
    "It is working now. What it is doing will stop part-way.",
  );
  expect(stopInterrupts({ status: "needs-you" })).toBe(
    "It is waiting for you. The question is left unanswered.",
  );
  expect(stopInterrupts({ status: "idle" })).toBeNull();
});
