import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

import type { NotificationTestOutcome } from "@core/notices/appNotifications";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { useNotificationSetting } from "@dashboard/hooks/notifications/useNotificationSetting";
import { requestNotificationTest } from "@dashboard/lib/notifications/appNotifications";
import {
  getNotificationSetting,
  turnOnNotifications,
} from "@dashboard/lib/notifications/notificationSetting";
import { inAppWindow } from "@dashboard/lib/shell/appWindow";

interface NotificationPromptProps {
  /** Whether the page is in the Mac app's window. Tests say which it is. */
  inApp?: boolean;
  /** What sends the test notification. Defaults to asking the app. For tests. */
  sendTest?: () => Promise<NotificationTestOutcome | null>;
}

/**
 * The question the Overview asks once, in the Mac app only: whether to turn
 * notifications on. It is there while no choice about them has ever been
 * stored in the app, and goes for good once either answer is chosen, here or
 * on the Notifications card in Settings.
 *
 * Turn on turns them on and sends one test notification, so macOS asks whether
 * Agent Lookout may show notifications then, while the person is looking,
 * rather than at the first wait. What macOS made of it is said in the
 * question's place. Not now stores off. Notifications stay off until the
 * person turns them on, as everywhere else.
 *
 * In a browser it is never drawn: a tab's notifications are turned on in
 * Settings, where the browser asks its own question.
 */
export function NotificationPrompt({
  inApp = inAppWindow(),
  sendTest = requestNotificationTest,
}: NotificationPromptProps = {}) {
  return inApp ? <Question sendTest={sendTest} /> : null;
}

/**
 * Where the question is:
 *
 * asking     the question, with Turn on and Not now
 * sending    Turn on was pressed and the test is out: the question, with a
 *            line in place of its buttons
 * shown      macOS took the test, so nothing is drawn
 * noted      the test was not shown, or macOS has not answered yet: a note in
 *            the question's place
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
const TURNED_ON = "Notifications are on in this app.";

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
 * Its focus goes to the view once it is answered or dismissed, so the keyboard
 * stays where the eye is and is not dropped to the top of the page.
 */
function keepFocusInView(event: MouseEvent<HTMLElement>): void {
  event.currentTarget.closest<HTMLElement>("main")?.focus({ preventScroll: true });
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
 * anything to say, a screen reader is told what Turn on came to: that a test
 * is being sent, then once that notifications are on, or the note. That line
 * is the only one that speaks: the question and the note are not live regions,
 * since each step changes the same box in place, and its words would be said
 * again.
 *
 * The note can be dismissed. It is never stored, so it is gone the next time
 * the Overview is drawn, and a question answered once never comes back.
 */
function Question({ sendTest }: Required<Pick<NotificationPromptProps, "sendTest">>) {
  const { chosen, turnOff } = useNotificationSetting();
  // Asked only when nothing was stored as the Overview was drawn.
  const [asked] = useState(!chosen);
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

  if (!asked) return null;

  const turnOn = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    setStep({ kind: "sending" });
    setSaid(SENDING);
    // Called inside the click, so a browser that asks sees it come from the press.
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
        setSaid(TURNED_ON);
        return;
      }
      const note = noteFor(answer);
      setStep({ kind: "noted", note });
      setSaid(`${note.title}. ${note.said}`);
    })();
  };
  const notNow = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    turnOff();
  };
  const dismiss = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    setStep({ kind: "dismissed" });
    setSaid("");
  };

  const question = (row: ReactNode) => (
    <Callout title='Get a notification when a session needs you?' titleId={titleId} live={false}>
      <p>
        macOS shows one from Agent Lookout each time a session starts waiting for you, with this
        window open or closed. You can change this in Settings.
      </p>
      {row}
    </Callout>
  );

  let drawn: ReactNode = null;
  if (step.kind === "asking" && !chosen) {
    drawn = question(
      <div role='group' aria-labelledby={titleId} className={ROW}>
        <Button size='sm' onClick={turnOn}>
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
