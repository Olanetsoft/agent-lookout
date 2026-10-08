// The notifications the collector shows itself while no window of the app is
// open, shown by macOS as coming from Agent Lookout. The standalone server
// shows them by running `osascript`, which macOS files under Script Editor;
// the app shows them with its own.
//
// A notification of a wait, or of a reminder of one, is about a session, and
// a click on it opens that session's details. While Agent Lookout holds that
// session's permission request it has Deny and, when the whole request fits
// in it as written, Allow (`answers/answerOffer.ts`). A press goes to the
// app's answers (`answers/desktopAnswers.ts`), which make every check a press
// on the dashboard makes. Such a notification is kept by its request, since
// one that is collected loses its buttons, and taken down once a button on it
// is pressed, whatever the press came to, or once its request has been
// answered, let go or replaced. A reminder's says how long the session has
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

/** How many notifications with no buttons are held on to, so a click on one can still be heard. */
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
  /** Shows a notification with no buttons, about a session when one is named. */
  tell(notice: Notice, sessionId?: string): void;
  /**
   * Takes each poll's snapshot, as the page is sent it, and takes down a
   * notification whose request is no longer held for its session.
   */
  observe(snapshot: Pick<SessionsSnapshot, "sessions">): void;
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
  /** The notifications with buttons, by the request they answer. */
  const asking = new Map<string, { notification: NotificationLike; sessionId: string }>();
  let warned = false;
  let refusal: string | null = null;

  /** Keeps a notification with no buttons, so it is not collected and its click lost. */
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

  function forget(requestId: string, notification: NotificationLike): void {
    if (asking.get(requestId)?.notification === notification) asking.delete(requestId);
  }

  function takeDown(notification: NotificationLike): void {
    try {
      notification.close();
    } catch {
      // It has gone already.
    }
  }

  function present(offer: NoticeOffer, sessionId?: string, requestId?: string): void {
    try {
      if (!notifications.isSupported()) return;
      /** The held request a press answers, when it has buttons. */
      const held =
        answers !== undefined && sessionId !== undefined && requestId !== undefined
          ? { answers, sessionId, requestId }
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
      notification.on("click", () => options.onClick(sessionId));
      listen(notification);
      if (held !== null && decisions.length > 0) {
        const { requestId: id } = held;
        notification.on("action", (details) => {
          const decision = decisions[details.actionIndex];
          if (decision === undefined) return;
          // Pressed, its buttons have done their part: what came of it is
          // said by a notification of its own when nothing was sent.
          forget(id, notification);
          takeDown(notification);
          void held.answers
            .press({
              sessionId: held.sessionId,
              name: offer.title,
              requestId: id,
              decision,
              shownAt,
              from: "notification",
            })
            .catch(() => {
              // The answers say what came of it themselves.
            });
        });
        notification.on("close", () => forget(id, notification));
        // A reminder of the same request takes the place of the first, so
        // one set of buttons stands for it.
        const older = asking.get(id);
        asking.set(id, { notification, sessionId: held.sessionId });
        if (older !== undefined) takeDown(older.notification);
      } else {
        keep(notification);
      }
      notification.show();
      shownAt = now();
    } catch {
      // Not shown. There is nobody to tell.
    }
  }

  function show(notice: Notice, about?: NoticeAbout): void {
    if (about === undefined || answers === undefined) {
      present(noticeOffer(notice), about?.sessionId);
      return;
    }
    const { sessionId, waitedMs } = about;
    void answers
      .heldFor(sessionId)
      .catch(() => undefined)
      .then((session) => {
        const ask = session?.ask;
        present(noticeOffer(notice, ask, waitedMs), sessionId, ask?.requestId);
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
    show,
    test,
    lastRefusal: () => refusal,
    tell(notice, sessionId) {
      present(noticeOffer(notice), sessionId);
    },
    observe(snapshot) {
      for (const [requestId, { notification, sessionId }] of asking) {
        const session = snapshot.sessions.find((listed) => listed.id === sessionId);
        if (session?.ask?.requestId === requestId) continue;
        asking.delete(requestId);
        takeDown(notification);
      }
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
