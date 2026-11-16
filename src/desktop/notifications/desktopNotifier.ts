// Every notification the collector shows in the Mac app, with its window
// open or closed, shown by macOS as coming from Agent Lookout. The page in the
// window shows none of its own: this notifier says so to the collector
// (`pagesNotify`), so nothing is held back for a page, and
// `useWaitNotifications` in the dashboard shows nothing in the app's window.
// The standalone server shows them by running `osascript`, which macOS files
// under Script Editor; the app shows them with its own.
//
// As the page's tags do, it keeps one notification of a session at a time, of
// a wait, a reminder of one, or a finish, a failure or an end, and a later one
// about the same session takes the place of the earlier, and it keeps one
// "While quiet" summary at a time. Unlike a tag, it keeps track of no more
// than the newest 20 that say a session finished, failed or ended (`KEPT`):
// one further back is left on show, and a later one about its session takes
// nothing down. A line the app tells about a press (`tell`) is not the
// session's one either, and stays beside it. The notification of a wait, or
// of a reminder of one, is taken down once the collector says the wait ended
// (`waitEnded`), and when notifications or Needs you are switched off
// (`waitsOff`), as the page takes its own down. One that says a session
// finished, failed or ended, and the summary, stay until the person clears
// them, or a later one takes their place, and a line about a press until the
// person clears it.
//
// A notification of a wait, or of a reminder of one, is about a session, and
// a click on it opens that session's details. While Agent Lookout holds that
// session's permission request it has Deny and, when the whole request fits
// in it as written, Allow (`answers/answerOffer.ts`). A press goes to the
// app's answers (`answers/desktopAnswers.ts`), which make every check a press
// on the dashboard makes. Such a notification is kept with the request it
// answers, and taken down once a button on it is pressed, whatever the press
// came to, or once its request has been answered, let go or replaced, even
// while the session still waits. A reminder's says how long the session has
// waited before what it asks.
//
// Settings can ask it for one test notification, which says what macOS made
// of it (`test`), and for the reason macOS gave the last time it would not
// show one (`lastRefusal`). The page's own `Notification` cannot tell: in the
// app it reads "granted" whatever macOS decides.
//
// It imports only types from Electron, so it is tested in plain Node with a
// stand-in for Electron's `Notification`. `main.ts` hands it Electron's.

import type { NotificationConstructorOptions } from "electron";

import type { NoticeAbout, SystemNotifier } from "../../collector/notifications/systemNotifier.ts";
import type { NotificationTestOutcome } from "../../core/notices/appNotifications.ts";
import type { Notice } from "../../core/notices/waiting.ts";
import type { Session, SessionsSnapshot } from "../../core/sessions/session.ts";
import { DECISION_LABEL, noticeOffer, type NoticeOffer } from "../answers/answerOffer.ts";
import type { AnswerPress } from "../answers/desktopAnswers.ts";

/**
 * How many notifications that nothing else holds on to are kept, so a click on
 * one can still be heard: the last 20 of any other kind, a test or a line
 * about a press among them, and the last 20 that say a session finished,
 * failed or ended, one for each session. One further back is let go, not
 * taken down, and a later one about its session no longer takes its place.
 */
const KEPT = 20;

/**
 * How long a test waits for macOS to say it showed the notification or would
 * not. The first notification an app makes has macOS ask the person whether
 * it may show them, and macOS says nothing until they answer.
 */
export const TEST_ANSWER_MS = 5_000;

/** The test notification: it says what it is, and nothing about a session. */
export const TEST_NOTICE = {
  title: "Agent Lookout",
  body: "This is a test notification.",
} as const;

/** What the notifier needs of one of Electron's notifications. */
export interface NotificationLike {
  on(event: "click", listener: () => void): unknown;
  on(event: "show", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "action", listener: (details: { actionIndex: number }) => void): unknown;
  on(event: "failed", listener: (event: unknown, error: string) => void): unknown;
  show(): void;
  close(): void;
}

/** What the notifier needs of Electron's `Notification` class. */
export interface NotificationMaker {
  isSupported(): boolean;
  create(options: NotificationConstructorOptions): NotificationLike;
}

/** What the notifier needs of the app's answers. */
export interface NoticeAnswers {
  heldFor(sessionId: string): Promise<Pick<Session, "ask"> | undefined>;
  press(press: AnswerPress): Promise<unknown>;
}

export interface DesktopNotifierOptions {
  notifications: NotificationMaker;
  /**
   * Called when the person clicks a notification: the app opens its window,
   * on the session's details when the notification is about one.
   */
  onClick: (sessionId?: string) => void;
  /** Deny and Allow, for a session whose request is held. Left out, no notification has buttons. */
  answers?: NoticeAnswers;
  now?: () => number;
  /**
   * Told, once, when macOS would not show a notification, with its reason. It
   * goes where the collector's own warnings go.
   */
  warn?: (line: string) => void;
}

/** The app's notifier: the collector's, and the app's own lines about a press. */
export interface DesktopNotifier extends SystemNotifier {
  /**
   * The page in the app's window shows no notifications of its own: the
   * dashboard shows none there (`useWaitNotifications`). So the collector
   * holds nothing back for it, and this notifier shows every one, at once,
   * with the window open or closed.
   */
  readonly pagesNotify: false;
  /** Shows a notification with no buttons, about a session when one is named. */
  tell(notice: Notice, sessionId?: string): void;
  /**
   * Takes each poll's snapshot, as the page is sent it, and takes down a
   * notification whose request is no longer held for its session.
   */
  observe(snapshot: Pick<SessionsSnapshot, "sessions">): void;
  /**
   * Takes down the notification of this session's wait, or of a reminder of
   * it, once the wait has ended, and drops one still being made.
   */
  waitEnded(sessionId: string): void;
  /**
   * Takes down the notification of every wait, and of every reminder, once
   * they are switched off, and drops those still being made. One that says a
   * session finished, failed or ended is left.
   */
  waitsOff(): void;
  /**
   * Shows one test notification, and resolves with what macOS made of it:
   * shown, refused with its reason, or unsupported, as when Electron cannot
   * make or show one, or with no answer once `TEST_ANSWER_MS` has passed. It
   * never rejects.
   */
  test(): Promise<NotificationTestOutcome>;
  /**
   * The reason macOS gave the last time it would not show a notification, or
   * null when none has been refused since one was last shown.
   */
  lastRefusal(): string | null;
}

/**
 * Where a notification is kept while it is on show, which says what takes it
 * down: a wait's, by its session, with the request its buttons answer; one
 * that says a session finished, failed or ended, by its session; the one
 * summary; or any other, among the last few, with the session a click opens.
 */
type Place =
  | { kind: "wait"; sessionId: string; requestId?: string }
  | { kind: "over"; sessionId: string }
  | { kind: "summary" }
  | { kind: "other"; sessionId?: string };

/**
 * The app's own notifications. Like the system notifier it stands in for, it
 * never throws, and a notification that cannot be shown is dropped, with one
 * line the first time to say why. The title and the text are made to stand on
 * one line, as everywhere else a session's name is shown.
 */
export function createDesktopNotifier(options: DesktopNotifierOptions): DesktopNotifier {
  const { notifications, answers } = options;
  const now = options.now ?? Date.now;
  // A notification nothing refers to may be collected, and its click lost.
  const kept: NotificationLike[] = [];
  /**
   * The notification of each session's wait, or of a reminder of it, by
   * session, with the request it answers when it has buttons, since one that
   * is collected loses its buttons.
   */
  const waits = new Map<string, { notification: NotificationLike; requestId?: string }>();
  /** The last notification that each session finished, failed or ended, by session, oldest first. */
  const over = new Map<string, NotificationLike>();
  /** The one notification that sums up quiet hours, while it is on show. */
  let summary: NotificationLike | null = null;
  /**
   * The wait whose notification is being made, by session, while its request
   * is read: one that ends, or is switched off, meanwhile is not shown.
   */
  const making = new Map<string, symbol>();
  let warned = false;
  let refusal: string | null = null;

  /** Keeps a notification no place holds, so it is not collected and its click lost. */
  function keep(notification: NotificationLike): void {
    kept.push(notification);
    if (kept.length > KEPT) kept.shift();
  }

  /**
   * Hears what macOS says of a notification: the reason it would not show
   * one is kept, and said once, and one it showed means it no longer refuses.
   */
  function listen(notification: NotificationLike): void {
    notification.on("show", () => {
      refusal = null;
    });
    notification.on("failed", (_event, error) => {
      refusal = reasonOf(error);
      if (warned) return;
      warned = true;
      options.warn?.(`macOS did not show a notification from Agent Lookout: ${error}`);
    });
  }

  function takeDown(notification: NotificationLike): void {
    try {
      notification.close();
    } catch {
      // It has gone already.
    }
  }

  /** Lets go of a notification of a session, wherever it is kept, once it has gone. */
  function forget(sessionId: string, notification: NotificationLike): void {
    if (waits.get(sessionId)?.notification === notification) waits.delete(sessionId);
    if (over.get(sessionId) === notification) over.delete(sessionId);
  }

  /**
   * Puts a notification already shown in its session's place, and takes down
   * the one that was there, of a wait or of a finish, a failure or an end: a
   * session has one at a time. The new one is set first, so the older one's
   * `close`, which Electron emits as it is taken down, lets go of nothing new.
   */
  function placeBySession(
    notification: NotificationLike,
    place: Extract<Place, { kind: "wait" | "over" }>,
  ): void {
    const { sessionId } = place;
    const older = [waits.get(sessionId)?.notification, over.get(sessionId)];
    waits.delete(sessionId);
    over.delete(sessionId);
    if (place.kind === "wait") {
      waits.set(sessionId, {
        notification,
        ...(place.requestId !== undefined && { requestId: place.requestId }),
      });
    } else {
      over.set(sessionId, notification);
      // The oldest is let go, as `kept` lets go, and left on show.
      const [oldest] = over.keys();
      if (over.size > KEPT && oldest !== undefined) over.delete(oldest);
    }
    // Electron says so when it is taken down, and when the person clears one
    // with buttons. macOS says nothing when they clear one with none.
    notification.on("close", () => forget(sessionId, notification));
    for (const each of older) if (each !== undefined && each !== notification) takeDown(each);
  }

  /** Puts the summary of quiet hours, already shown, in the place of the last, which is taken down. */
  function placeSummary(notification: NotificationLike): void {
    const older = summary;
    summary = notification;
    notification.on("close", () => {
      if (summary === notification) summary = null;
    });
    if (older !== null && older !== notification) takeDown(older);
  }

  function present(offer: NoticeOffer, place: Place): void {
    try {
      if (!notifications.isSupported()) return;
      /** The held request a press answers, when it has buttons. */
      const held =
        answers !== undefined && place.kind === "wait" && place.requestId !== undefined
          ? { answers, sessionId: place.sessionId, requestId: place.requestId }
          : null;
      const decisions = held === null ? [] : offer.decisions;
      const notification = notifications.create({
        title: offer.title,
        ...(offer.subtitle !== undefined && { subtitle: offer.subtitle }),
        body: offer.body,
        ...(decisions.length > 0 && {
          actions: decisions.map((decision) => ({
            type: "button" as const,
            text: DECISION_LABEL[decision],
          })),
        }),
      });
      /** When it was shown: the later of its `show()` and macOS saying so. */
      let shownAt: number | null = null;
      notification.on("show", () => {
        shownAt = now();
      });
      // A wait's opens its session's details, as does a line about a press.
      const opens = place.kind === "wait" || place.kind === "other" ? place.sessionId : undefined;
      notification.on("click", () => options.onClick(opens));
      listen(notification);
      if (held !== null && decisions.length > 0) {
        const { sessionId, requestId } = held;
        notification.on("action", (details) => {
          const decision = decisions[details.actionIndex];
          if (decision === undefined) return;
          // Pressed, its buttons have done their part: what came of it is
          // said by a notification of its own when nothing was sent.
          forget(sessionId, notification);
          takeDown(notification);
          void held.answers
            .press({
              sessionId,
              name: offer.title,
              requestId,
              decision,
              shownAt,
              from: "notification",
            })
            .catch(() => {
              // The answers say what came of it themselves.
            });
        });
      }
      // Shown before it takes the place of the last, so one that will not show
      // leaves the last on show, and in its place.
      notification.show();
      shownAt = now();
      if (place.kind === "wait") {
        // Only one with buttons is kept with its request, for `observe`.
        const buttons = held !== null && decisions.length > 0;
        placeBySession(
          notification,
          buttons ? place : { kind: "wait", sessionId: place.sessionId },
        );
      } else if (place.kind === "over") placeBySession(notification, place);
      else if (place.kind === "summary") placeSummary(notification);
      else keep(notification);
    } catch {
      // Not shown. There is nobody to tell.
    }
  }

  function show(notice: Notice, about?: NoticeAbout): void {
    if (about === undefined) {
      present(noticeOffer(notice), { kind: "other" });
      return;
    }
    if (about.kind === "summary") {
      present(noticeOffer(notice), { kind: "summary" });
      return;
    }
    const { sessionId } = about;
    // A later notification of the session takes the place of one still being made.
    making.delete(sessionId);
    if (about.kind === "over") {
      present(noticeOffer(notice), { kind: "over", sessionId });
      return;
    }
    if (answers === undefined) {
      present(noticeOffer(notice), { kind: "wait", sessionId });
      return;
    }
    const { waitedMs } = about;
    const token = Symbol(sessionId);
    making.set(sessionId, token);
    void answers
      .heldFor(sessionId)
      .catch(() => undefined)
      .then((session) => {
        // Its wait ended, or was switched off, or a later notification of the
        // session came, while its request was read.
        if (making.get(sessionId) !== token) return;
        making.delete(sessionId);
        const ask = session?.ask;
        present(noticeOffer(notice, ask, waitedMs), {
          kind: "wait",
          sessionId,
          ...(ask !== undefined && { requestId: ask.requestId }),
        });
      });
  }

  function test(): Promise<NotificationTestOutcome> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const settle = (outcome: NotificationTestOutcome) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(outcome);
      };
      try {
        if (!notifications.isSupported()) {
          settle({ outcome: "unsupported" });
          return;
        }
        const notification = notifications.create({ ...TEST_NOTICE });
        listen(notification);
        notification.on("show", () => settle({ outcome: "shown" }));
        notification.on("failed", (_event, error) =>
          settle({ outcome: "refused", reason: reasonOf(error) }),
        );
        notification.on("click", () => options.onClick());
        keep(notification);
        timer = setTimeout(() => settle({ outcome: "no-answer" }), TEST_ANSWER_MS);
        notification.show();
      } catch {
        // Electron could not make or show it, which is not macOS refusing it.
        settle({ outcome: "unsupported" });
      }
    });
  }

  return {
    pagesNotify: false,
    show,
    test,
    lastRefusal: () => refusal,
    tell(notice, sessionId) {
      // A line about a press is not the wait's, and is not taken down with it.
      present(noticeOffer(notice), {
        kind: "other",
        ...(sessionId !== undefined && { sessionId }),
      });
    },
    observe(snapshot) {
      for (const [sessionId, { notification, requestId }] of waits) {
        if (requestId === undefined) continue;
        const session = snapshot.sessions.find((listed) => listed.id === sessionId);
        if (session?.ask?.requestId === requestId) continue;
        waits.delete(sessionId);
        takeDown(notification);
      }
    },
    waitEnded(sessionId) {
      making.delete(sessionId);
      const shown = waits.get(sessionId);
      if (shown === undefined) return;
      waits.delete(sessionId);
      takeDown(shown.notification);
    },
    waitsOff() {
      making.clear();
      const shown = [...waits.values()];
      waits.clear();
      for (const { notification } of shown) takeDown(notification);
    },
  };
}

/** What macOS gave as its reason, as one line, or a line that says it gave none. */
function reasonOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? "macOS gave no reason." : text;
}
