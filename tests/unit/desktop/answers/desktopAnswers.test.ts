import { describe, expect, test, vi } from "vitest";

import type { InProcessOutcome } from "@collector/answers/answering";
import type { Notice } from "@core/notices/waiting";
import type { Session, SessionsSnapshot } from "@core/sessions/session";
import {
  createDesktopAnswers,
  MENU_NOTE_MS,
  pressWords,
  type AnswerPress,
  type AnsweringCollector,
  type DesktopOutcome,
} from "@desktop/answers/desktopAnswers";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";

const waiting: Session = makeSession({
  id: ID,
  name: "checkout-flow",
  status: "needs-you",
  waitingReason: "permission",
});

const ASK = { requestId: REQUEST_ID, tool: "Bash", command: "npm test", allow: true, until: NOW };

/** The app's answers over a stand-in collector that answers as told, on a clock the test moves. */
function setUp(
  options: {
    outcome?: InProcessOutcome | Error;
    answeringOff?: boolean;
    locked?: () => boolean;
  } = {},
) {
  let now = NOW;
  const steps: string[] = [];
  const snapshot: SessionsSnapshot = { generatedAt: NOW, sources: [], sessions: [waiting] };
  const answer = vi.fn(async (): Promise<InProcessOutcome> => {
    steps.push("answer");
    const { outcome = "answered" } = options;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const collector: AnsweringCollector = {
    poller: { getSnapshot: () => snapshot },
    answering: {
      serve: (given) => {
        steps.push("serve");
        return {
          ...given,
          sessions: given.sessions.map((session) => ({ ...session, ask: ASK })),
        };
      },
      check: async () => void steps.push("check"),
      ...(!options.answeringOff && { answer }),
    },
  };
  const told: { notice: Notice; sessionId: string }[] = [];
  const menuChanged = vi.fn<(refused: boolean) => void>();
  const answers = createDesktopAnswers({
    collector: () => collector,
    locked: options.locked ?? (() => false),
    tell: (notice, sessionId) => void told.push({ notice, sessionId }),
    menuChanged,
    now: () => now,
  });
  return {
    answers,
    answer,
    steps,
    told,
    menuChanged,
    snapshot,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

function press(more: Partial<AnswerPress> = {}): AnswerPress {
  return {
    sessionId: ID,
    name: "checkout-flow",
    requestId: REQUEST_ID,
    decision: "allow",
    shownAt: NOW - 2_000,
    from: "notification",
    ...more,
  };
}

describe("a press from a notification", () => {
  test("goes to the collector's own answer once it has been shown a second, and says nothing more once answered", async () => {
    const { answers, answer, told } = setUp();
    expect(await answers.press(press())).toBe("answered");
    expect(answer).toHaveBeenCalledWith(ID, REQUEST_ID, "allow");
    expect(told).toEqual([]);
  });

  test("in the first second it was shown sends nothing, and a notification says why and to click it", async () => {
    const { answers, answer, told } = setUp();
    expect(await answers.press(press({ shownAt: NOW - 999 }))).toBe("too-soon-shown");
    expect(await answers.press(press({ shownAt: null }))).toBe("too-soon-shown");
    expect(answer).not.toHaveBeenCalled();
    expect(told).toEqual([
      {
        notice: {
          title: "checkout-flow",
          body: "It was pressed within a second of being shown, so nothing was sent. Click to answer it in Agent Lookout.",
        },
        sessionId: ID,
      },
      expect.anything(),
    ]);
  });

  test("while this Mac is locked sends nothing, and one that cannot tell is taken as locked", async () => {
    for (const locked of [
      () => true,
      () => {
        throw new Error("no idle state");
      },
    ]) {
      const { answers, answer, told } = setUp({ locked });
      expect(await answers.press(press())).toBe("locked");
      expect(answer).not.toHaveBeenCalled();
      expect(told[0]?.notice.body).toBe(
        "Nothing is answered while this Mac is locked, so nothing was sent. Click to answer it once it is unlocked.",
      );
    }
  });

  test.each<[InProcessOutcome, string]>([
    ["no-ask", "That request is no longer held, so nothing was sent."],
    ["gone", "It was answered in the session, or is no longer waiting, so nothing was sent."],
    ["not-allowable", "Only Deny is offered for this request."],
    ["too-soon", "That request is being answered."],
    ["unavailable", "Agent Lookout is not answering permission prompts now, so nothing was sent."],
  ])("the collector's %s is told in its own words", async (outcome, words) => {
    const { answers, told } = setUp({ outcome });
    expect(await answers.press(press())).toBe(outcome);
    expect(told).toEqual([{ notice: { title: "checkout-flow", body: words }, sessionId: ID }]);
  });

  test("an answer that throws is one that could not be given, and is told", async () => {
    const { answers, told } = setUp({ outcome: new Error("broken") });
    expect(await answers.press(press())).toBe("failed");
    expect(told[0]?.notice.body).toBe("The answer could not be handed to the session.");
  });

  test("with answering off, nothing is answered and nothing is held", async () => {
    const { answers, steps } = setUp({ answeringOff: true });
    expect(await answers.press(press())).toBe("unavailable");
    expect(await answers.heldFor(ID)).toBeUndefined();
    expect(steps).toEqual([]);
  });
});

describe("a press from the menu", () => {
  test("is the menu's line for a minute, answered or not, and one that sent nothing opens the menu again", async () => {
    const { answers, menuChanged, told, snapshot, tick } = setUp({ outcome: "gone" });
    expect(answers.forMenu(snapshot).note).toBeNull();
    await answers.press(press({ from: "menu", decision: "deny" }));
    expect(menuChanged).toHaveBeenLastCalledWith(true);
    expect(told).toEqual([]);
    expect(answers.forMenu(snapshot).note).toBe(
      "checkout-flow: It was answered in the session, or is no longer waiting, so nothing was sent.",
    );
    tick(MENU_NOTE_MS);
    expect(answers.forMenu(snapshot).note).toBeNull();
  });

  test("in the first second the menu was shown, the line says to press again", async () => {
    const { answers, answer, snapshot } = setUp();
    expect(await answers.press(press({ from: "menu", shownAt: NOW - 999 }))).toBe("too-soon-shown");
    expect(answer).not.toHaveBeenCalled();
    expect(answers.forMenu(snapshot).note).toBe(
      "checkout-flow: It was pressed within a second of being shown, so nothing was sent. Press again.",
    );
  });

  test("an answer is said there too, and does not open the menu again", async () => {
    const { answers, menuChanged, snapshot } = setUp();
    await answers.press(press({ from: "menu", decision: "deny" }));
    expect(menuChanged).toHaveBeenLastCalledWith(false);
    expect(answers.forMenu(snapshot).note).toBe(
      "checkout-flow: Denied from Agent Lookout. Claude carries on without it.",
    );
  });
});

test("a session's held request is read once the held requests were checked again", async () => {
  const { answers, steps } = setUp();
  expect((await answers.heldFor(ID))?.ask).toEqual(ASK);
  expect(steps).toEqual(["check", "serve"]);
  expect(await answers.heldFor("claude-code:another")).toBeUndefined();
});

test("the menu and the notifications are handed each poll's snapshot as the page is sent it", () => {
  const { answers, snapshot } = setUp();
  expect(answers.served(snapshot).sessions[0]?.ask).toEqual(ASK);
  expect(answers.forMenu(snapshot)).toEqual({
    sessions: [{ ...waiting, ask: ASK }],
    sources: [],
    note: null,
  });
});

test("each outcome has words of its own", () => {
  const outcomes: DesktopOutcome[] = [
    "answered",
    "no-ask",
    "not-allowable",
    "gone",
    "too-soon",
    "unavailable",
    "too-soon-shown",
    "locked",
    "failed",
  ];
  for (const from of ["notification", "menu"] as const) {
    const words = outcomes.map((outcome) => pressWords(outcome, "deny", from));
    expect(new Set(words).size).toBe(outcomes.length);
  }
  expect(pressWords("answered", "allow", "menu")).toBe("Allowed from Agent Lookout.");
  expect(pressWords("locked", "allow", "menu")).toBe(
    "Nothing is answered while this Mac is locked, so nothing was sent. Press again once it is unlocked.",
  );
});

test("each poll is shown at once, and again once the held requests were checked, so a request its wait was first seen in is offered at once", async () => {
  const { answers, snapshot, steps } = setUp();
  const shown: string[] = [];
  answers.follow(snapshot, (served, menu) => {
    shown.push(`${served.sessions[0]?.ask?.requestId} ${menu.sessions.length}`);
  });
  expect(shown).toEqual([`${REQUEST_ID} 1`]);
  await vi.waitFor(() => expect(shown).toHaveLength(2));
  expect(steps).toEqual(["serve", "serve", "check", "serve", "serve"]);

  const off = setUp({ answeringOff: true });
  const once: number[] = [];
  off.answers.follow(off.snapshot, () => void once.push(1));
  await Promise.resolve();
  expect(once).toEqual([1]);
});
