import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type { NotificationTestOutcome } from "@core/notices/appNotifications";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { useNotificationAsk } from "@dashboard/hooks/notifications/useNotificationAsk";
import { requestNotificationTest } from "@dashboard/lib/notifications/appNotifications";
import {
  getNotificationSetting,
  turnOnNotifications,
} from "@dashboard/lib/notifications/notificationSetting";
import { inAppWindow } from "@dashboard/lib/shell/appWindow";

interface NotificationPromptProps {
  /**
   * Whether the page is in the Mac app's window: the question then speaks of
   * macOS and this window, and Turn on sends a test. Tests say which it is.
   */
  inApp?: boolean;
  /** What sends the test notification in the app. Defaults to asking the app. For tests. */
  sendTest?: () => Promise<NotificationTestOutcome | null>;
}

/**
 * The question the Overview asks, in a browser and in the Mac app: whether to
 * turn notifications on. It is there while they are not on and the browser
 * neither blocks them nor has no way to show them. After Not now it comes back
 * about a day later, then 3 days, then a week, each counted from the last Not
 * now, and after the fourth not again (`useNotificationAsk`). It never comes
 * back once they are turned off on the Notifications card in Settings.
 *
 * Turn on does what the card's Turn on notifications does. In a browser that
 * is the browser's own question, and if the browser blocks them, a note in the
 * question's place says so and points to Settings. In the app it also sends one
 * test notification, so macOS asks whether Agent Lookout may show
 * notifications then, while the person is looking, rather than at the first
 * wait, and what macOS made of it is said in the question's place. Not now
 * leaves them as they were.
 */
export function NotificationPrompt({
  inApp = inAppWindow(),
  sendTest = requestNotificationTest,
}: NotificationPromptProps = {}) {
  return <Question inApp={inApp} sendTest={sendTest} />;
}

/**
 * Where the question is:
 *
 * asking     the question, with Turn on and Not now
 * sending    in the app, Turn on was pressed and the test is out: the
 *            question, with a line in place of its buttons
 * shown      notifications are on, and in the app macOS took the test, so
 *            nothing is drawn
 * noted      in the app, the test was not shown, or macOS has not answered
 *            yet; in a browser, it blocks them: a note in the question's place
 * dismissed  the note was dismissed
 */
type Step =
  | { kind: "asking" }
  | { kind: "sending" }
  | { kind: "shown" }
  | { kind: "noted"; note: Note }
  | { kind: "dismissed" };

/** A note in the question's place, and what a screen reader is told of it. */
interface Note {
  title: string;
  body: ReactNode;
  said: string;
}

const SENDING = "Sending a test…";
const TURNED_ON_IN_APP = "Notifications are on in this app.";
/** The card's own words, in a browser. */
const TURNED_ON = "Notifications are on.";

/** The link to Settings, in a sentence, as the other links in the page's words are. */
function SettingsLink() {
  return (
    <a
      href='#settings'
      className='rounded-bar underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:text-ink'
    >
      Settings
    </a>
  );
}

/**
 * What the Overview says when the test was not shown. Settings says why and
 * what to do, so this only points there. "no-answer" is what happens while
 * macOS asks the person whether the app may show notifications, so it is not
 * said as a failure.
 */
function noteFor(answer: NotificationTestOutcome | null): Note {
  if (answer === null) {
    return {
      title: "The test was not sent",
      body: (
        <>
          Agent Lookout did not answer. <SettingsLink /> can send another test, under Notifications.
        </>
      ),
      said: "Agent Lookout did not answer. Settings can send another test, under Notifications.",
    };
  }
  if (answer.outcome === "no-answer") {
    return {
      title: "macOS has not answered yet",
      body: (
        <>
          If macOS asks whether Agent Lookout may show notifications, allow them. <SettingsLink />{" "}
          can send another test, under Notifications.
        </>
      ),
      said: "If macOS asks whether Agent Lookout may show notifications, allow them. Settings can send another test, under Notifications.",
    };
  }
  return {
    title: "macOS did not show the test notification",
    body: (
      <>
        Open <SettingsLink /> and send a test under Notifications to see why and what to do.
      </>
    ),
    said: "Open Settings and send a test under Notifications to see why and what to do.",
  };
}

/**
 * What the Overview says in a browser when Turn on ended with the browser
 * blocking them. The Notifications card in Settings says how to allow them, so
 * this only points there.
 */
function blockedNote(): Note {
  return {
    title: "Notifications are blocked",
    body: (
      <>
        Your browser is blocking them for this address. <SettingsLink /> says how to allow them,
        under Notifications.
      </>
    ),
    said: "Your browser is blocking them for this address. Settings says how to allow them, under Notifications.",
  };
}

/** The view a press was made in, which holds the focus once the question is answered. */
function viewOf(event: MouseEvent<HTMLElement>): HTMLElement | null {
  return event.currentTarget.closest<HTMLElement>("main");
}

/**
 * Its focus goes to the view once it is answered or dismissed, so the keyboard
 * stays where the eye is and is not dropped to the top of the page.
 */
function keepFocusInView(event: MouseEvent<HTMLElement>): void {
  viewOf(event)?.focus({ preventScroll: true });
}

/** A row under the words, as tall as its buttons, so the note keeps its height as they go. */
const ROW = "mt-3 flex min-h-button flex-wrap items-center gap-2";

/**
 * An info note, as quiet as every other note: nothing in it is warm, since a
 * question about notifications is not a session that needs the person. Its
 * two buttons sit under the words, so the words keep their width when the view
 * is narrow, in a group named by the question.
 *
 * Under it, in a polite live region that is in the page before there is
 * anything to say, a screen reader is told what Turn on came to: in the app
 * that a test is being sent, then once that notifications are on, or the note.
 * That line is the only one that speaks: the question and the note are not
 * live regions, since each step changes the same box in place, and its words
 * would be said again.
 *
 * The note can be dismissed. It is never stored, so it is gone the next time
 * the Overview is drawn. Once Turn on has moved past the question, the line
 * and the note stay whatever the setting says, until the Overview is drawn
 * again.
 */
function Question({ inApp, sendTest }: Required<NotificationPromptProps>) {
  const { asking, putOff } = useNotificationAsk();
  // Whether the question has been drawn on this Overview: until it has, there
  // is nothing to say, and nothing is drawn at all.
  const [seen, setSeen] = useState(asking);
  const [step, setStep] = useState<Step>({ kind: "asking" });
  const [said, setSaid] = useState("");
  const titleId = useId();
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Kept as the page draws: once the question is drawn, the line under it stays.
  if (asking && !seen) setSeen(true);
  if (!asking && !seen) return null;

  const turnOnInApp = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    setStep({ kind: "sending" });
    setSaid(SENDING);
    // Called inside the click, so a window that asks sees it come from the press.
    const turningOn = turnOnNotifications();
    void (async () => {
      await turningOn;
      if (!mounted.current) return;
      // Not turned on, as when this window may not show notifications: ask again.
      if (!getNotificationSetting().on) {
        setStep({ kind: "asking" });
        setSaid("");
        return;
      }
      const answer = await sendTest();
      if (!mounted.current) return;
      if (answer?.outcome === "shown") {
        setStep({ kind: "shown" });
        setSaid(TURNED_ON_IN_APP);
        return;
      }
      const note = noteFor(answer);
      setStep({ kind: "noted", note });
      setSaid(`${note.title}. ${note.said}`);
    })();
  };
  // As the card's button does: the browser's own question, and no test.
  const turnOnInBrowser = (event: MouseEvent<HTMLElement>) => {
    const view = viewOf(event);
    // Called inside the click, so the browser sees it come from the press.
    const turningOn = turnOnNotifications();
    void (async () => {
      await turningOn;
      if (!mounted.current) return;
      const { on, permission } = getNotificationSetting();
      if (on) {
        setStep({ kind: "shown" });
        setSaid(TURNED_ON);
        view?.focus({ preventScroll: true });
        return;
      }
      if (permission === "denied") {
        const note = blockedNote();
        setStep({ kind: "noted", note });
        setSaid(`${note.title}. ${note.said}`);
        view?.focus({ preventScroll: true });
      }
      // Otherwise the browser's question was closed unanswered: the question
      // stays as it was, with the focus on Turn on.
    })();
  };
  const notNow = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    putOff();
  };
  const dismiss = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    setStep({ kind: "dismissed" });
    setSaid("");
  };

  const question = (row: ReactNode) => (
    <Callout title='Get a notification when a session needs you?' titleId={titleId} live={false}>
      <p>
        {inApp
          ? "macOS shows one from Agent Lookout each time a session starts waiting for you, with this window open or closed. You can change this in Settings."
          : "Your browser shows one each time a session starts waiting for you, while a dashboard tab is open. You can change this in Settings."}
      </p>
      {row}
    </Callout>
  );

  let drawn: ReactNode = null;
  if (step.kind === "asking" && asking) {
    drawn = question(
      <div role='group' aria-labelledby={titleId} className={ROW}>
        <Button size='sm' onClick={inApp ? turnOnInApp : turnOnInBrowser}>
          Turn on
        </Button>
        <Button size='sm' onClick={notNow}>
          Not now
        </Button>
      </div>,
    );
  } else if (step.kind === "sending") {
    drawn = question(
      <p data-part='sending' className={ROW}>
        {SENDING}
      </p>,
    );
  } else if (step.kind === "noted") {
    drawn = (
      <Callout title={step.note.title} live={false}>
        <p>{step.note.body}</p>
        <div className={ROW}>
          <Button size='sm' onClick={dismiss}>
            Dismiss
          </Button>
        </div>
      </Callout>
    );
  }

  return (
    <>
      {drawn && <div data-slot='notification-prompt'>{drawn}</div>}
      {/* Out of the flow, so it adds no gap to the view once nothing else is drawn. */}
      <p data-part='prompt-said' role='status' className='sr-only'>
        {said}
      </p>
    </>
  );
}
