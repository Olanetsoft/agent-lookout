// Allow and Deny from the Mac app's own notifications and its menu bar.
//
// A press there names the session, the request it showed and the answer, as
// a press on the dashboard does, and goes through the collector's own answer
// (`createAnswerer` in `src/collector/answers/answerRoute.ts`), the path the
// page's request takes, in this process, with no route of its own: the
// session must be listed, the request held under that id and confirmed,
// Allow only when the collector offers it, not one being answered already,
// the hook still waiting on it, and the registry, read once more, saying the
// session waits in the same wait. The Events log then has it as an answer by
// Agent Lookout. Before that, the app makes two checks only it can: nothing
// is taken in the first second what was pressed was shown, as on the page,
// and nothing while this Mac is locked, should macOS let a notification's
// buttons be pressed on the lock screen.
//
// What a press came to is never left unsaid. One from a notification that
// sent nothing is followed by a notification that says why, and what to do
// now its buttons are gone: click it, to answer in the window. One from the
// menu is the line under the menu's headline for a minute, and one that sent
// nothing opens the menu again, so the line is read at once.

import { answerOutcomeWords } from "../../core/answers/askWords.ts";
import { settled } from "../../core/answers/settle.ts";
import type { Notice } from "../../core/notices/waiting.ts";
import type { AnswerDecision, Session, SessionsSnapshot } from "../../core/sessions/session.ts";
import { oneLine } from "../../core/text.ts";
import type { InProcessOutcome } from "../../collector/answers/answering.ts";
import type { Collector } from "../../collector/collector.ts";
import type { Poller } from "../../collector/poller.ts";
import type { MenuBarSnapshot } from "../menu-bar/menuBarMenu.ts";

/** How long the menu says what the last press in it came to. */
export const MENU_NOTE_MS = 60_000;

/**
 * What became of a press in the app: what the collector said, or that the app
 * sent nothing because it was pressed in the first second it was shown, or
 * while this Mac was locked, or that the answer could not be given at all.
 */
export type DesktopOutcome = InProcessOutcome | "too-soon-shown" | "locked" | "failed";

/** A press of Deny or Allow, in a notification or in the menu bar's menu. */
export interface AnswerPress {
  sessionId: string;
  /** The session's name, as what was pressed showed it. */
  name: string;
  /** Agent Lookout's own id for the request that was shown. */
  requestId: string;
  decision: AnswerDecision;
  /** When what was pressed was shown, or null when that is not known. */
  shownAt: number | null;
  from: "notification" | "menu";
}

/**
 * What is said of a press, once it is answered or refused. A refusal the
 * person can put right says how, where the press came from: a notification
 * that said it is clicked to open the session's details, and the menu, open
 * again, is pressed again.
 */
export function pressWords(
  outcome: DesktopOutcome,
  decision: AnswerDecision,
  from: AnswerPress["from"],
): string {
  switch (outcome) {
    case "answered":
      return answerOutcomeWords(decision === "allow" ? "allowed" : "denied");
    case "too-soon-shown":
      return `It was pressed within a second of being shown, so nothing was sent. ${
        from === "notification" ? "Click to answer it in Agent Lookout." : "Press again."
      }`;
    case "locked":
      return `Nothing is answered while this Mac is locked, so nothing was sent. ${
        from === "notification"
          ? "Click to answer it once it is unlocked."
          : "Press again once it is unlocked."
      }`;
    case "unavailable":
      return "Agent Lookout is not answering permission prompts now, so nothing was sent.";
    default:
      return answerOutcomeWords(outcome);
  }
}

/** What the app's answers need of the collector. */
export interface AnsweringCollector {
  poller: Pick<Poller, "getSnapshot">;
  answering: Pick<Collector["answering"], "serve" | "check" | "answer">;
}

export interface DesktopAnswersOptions {
  /** The collector, once it is made: it is made after the notifier that needs this. */
  collector: () => AnsweringCollector | null;
  /** Whether this Mac's screen is locked. One that cannot tell is taken as locked. */
  locked: () => boolean;
  /** Shows a notification with no buttons, about a session. */
  tell: (notice: Notice, sessionId: string) => void;
  /** Told that what the menu says of the last press changed; `refused` when nothing was sent. */
  menuChanged: (refused: boolean) => void;
  now?: () => number;
}

export interface DesktopAnswers {
  /**
   * A session as it is now, with its held request, once the held requests
   * were checked again, so one whose wait the poll has just seen is there.
   * Undefined when it is not listed, or answering is off.
   */
  heldFor(sessionId: string): Promise<Session | undefined>;
  /** Answers a press, or says why not, and resolves with what it came to. */
  press(press: AnswerPress): Promise<DesktopOutcome>;
  /** A poll's snapshot as the page is sent it, with each held request. */
  served(snapshot: SessionsSnapshot): SessionsSnapshot;
  /** A poll's snapshot as the menu bar shows it: each held request, and what the last press in it came to. */
  forMenu(snapshot: SessionsSnapshot): MenuBarSnapshot;
  /**
   * Hands a poll's snapshot to `show`, as the page is sent it and as the menu
   * bar shows it, at once and again once the held requests were checked, so
   * a request whose wait this poll was the first to see is offered at once.
   */
  follow(
    snapshot: SessionsSnapshot,
    show: (served: SessionsSnapshot, menu: MenuBarSnapshot) => void,
  ): void;
}

export function createDesktopAnswers(options: DesktopAnswersOptions): DesktopAnswers {
  const now = options.now ?? Date.now;
  /** What the last press in the menu came to, and when. */
  let note: { text: string; at: number } | null = null;

  function lockedNow(): boolean {
    try {
      return options.locked();
    } catch {
      return true;
    }
  }

  async function decide(press: AnswerPress): Promise<DesktopOutcome> {
    const answer = options.collector()?.answering.answer;
    if (answer === undefined) return "unavailable";
    if (!settled(press.shownAt, now())) return "too-soon-shown";
    if (lockedNow()) return "locked";
    try {
      return await answer(press.sessionId, press.requestId, press.decision);
    } catch {
      return "failed";
    }
  }

  function served(snapshot: SessionsSnapshot): SessionsSnapshot {
    return options.collector()?.answering.serve(snapshot) ?? snapshot;
  }

  function forMenu(snapshot: SessionsSnapshot): MenuBarSnapshot {
    const { sessions, sources } = served(snapshot);
    if (note !== null && now() - note.at >= MENU_NOTE_MS) note = null;
    return { sessions, sources, note: note?.text ?? null };
  }

  function showSafely(
    snapshot: SessionsSnapshot,
    show: (served: SessionsSnapshot, menu: MenuBarSnapshot) => void,
  ): void {
    try {
      show(served(snapshot), forMenu(snapshot));
    } catch {
      // Shown again at the next poll.
    }
  }

  return {
    async heldFor(sessionId) {
      const collector = options.collector();
      if (collector === null || collector.answering.answer === undefined) return undefined;
      try {
        await collector.answering.check();
      } catch {
        // The request is shown as the last check left it.
      }
      return collector.answering
        .serve(collector.poller.getSnapshot())
        .sessions.find((session) => session.id === sessionId);
    },

    async press(press) {
      const outcome = await decide(press);
      const words = pressWords(outcome, press.decision, press.from);
      const refused = outcome !== "answered";
      if (press.from === "menu") {
        note = { text: `${oneLine(press.name)}: ${words}`, at: now() };
        options.menuChanged(refused);
      } else if (refused) {
        options.tell({ title: press.name, body: words }, press.sessionId);
      }
      return outcome;
    },

    served,

    forMenu,

    follow(snapshot, show) {
      showSafely(snapshot, show);
      const collector = options.collector();
      if (collector === null || collector.answering.answer === undefined) return;
      void collector.answering
        .check()
        .catch(() => {
          // The request is shown as the last check left it.
        })
        .then(() => showSafely(collector.poller.getSnapshot(), show));
    },
  };
}
