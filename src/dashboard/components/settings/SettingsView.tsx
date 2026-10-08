import type { HistoryResponse, PhoneChannel } from "@core/api";
import type { AnsweringStatus } from "@core/sessions/session";
import { NOTICE_EVENTS, type NoticeEvent } from "@core/notices/sessionChanges";
import { NOTICE_EVENT_LABEL } from "@core/notices/waiting";
import type { SessionsSnapshot } from "@core/sessions/session";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { AnswerCard } from "@dashboard/components/settings/AnswerCard";
import { HistoryCard } from "@dashboard/components/settings/HistoryCard";
import { MenuBarCard } from "@dashboard/components/settings/MenuBarCard";
import { PermissionRulesCard } from "@dashboard/components/settings/PermissionRulesCard";
import { TestSend } from "@dashboard/components/settings/TestSend";
import { TimeRulesCard } from "@dashboard/components/settings/TimeRulesCard";
import { UpdatesCard } from "@dashboard/components/settings/UpdatesCard";
import {
  useNotificationTest,
  type NotificationTest,
} from "@dashboard/hooks/app/useNotificationTest";
import { useNow } from "@dashboard/hooks/data/useNow";
import { useNotificationSetting } from "@dashboard/hooks/notifications/useNotificationSetting";
import {
  useOutboundStatus,
  type OutboundStatusReading,
} from "@dashboard/hooks/notifications/useOutboundStatus";
import { useTheme } from "@dashboard/hooks/shell/useTheme";
import { clockAt } from "@dashboard/lib/format";
import { emailWords, fetchEmailStatus } from "@dashboard/lib/notifications/emailStatus";
import type { SendingWords } from "@dashboard/lib/notifications/sendingWords";
import { fetchWebhookStatus, webhookWords } from "@dashboard/lib/notifications/webhookStatus";
import { fetchNtfyStatus, ntfyWords } from "@dashboard/lib/phone/ntfyStatus";
import { fetchPushoverStatus, pushoverWords } from "@dashboard/lib/phone/pushoverStatus";
import {
  asksGitHub,
  fetchPullRequestsStatus,
  pullRequestsWords,
} from "@dashboard/lib/pull-requests/pullRequestsStatus";
import { inAppWindow } from "@dashboard/lib/shell/appWindow";
import type { ThemePreference } from "@dashboard/lib/shell/theme";
import { cn } from "@dashboard/lib/utils";

const THEME_OPTIONS = [
  { value: "dark", label: "Night", name: "Dark theme" },
  { value: "light", label: "Day", name: "Light theme" },
  { value: "system", label: "System", name: "Follow the computer's setting" },
] as const satisfies readonly { value: ThemePreference; label: string; name: string }[];

const EVENT_SWITCH = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

/**
 * The events that send a notification, each with its own switch, under the
 * one that turns notifications on. Nothing can refuse one of these, so each is
 * the segmented control the theme uses. Shown only while notifications are on:
 * a list of switches that do nothing would be one more thing to read.
 */
function EventSwitches({
  events,
  chooseEvent,
}: {
  events: readonly NoticeEvent[];
  chooseEvent: (event: NoticeEvent, chosen: boolean) => void;
}) {
  return (
    <ul data-part='events' aria-label='What sends a notification' className='mt-3 flex flex-col'>
      {NOTICE_EVENTS.map((event) => (
        <li
          key={event}
          className='flex items-center justify-between gap-6 border-b border-hairline py-2 last:border-b-0'
        >
          {/* The switch carries the same name, so this is not read twice. */}
          <span aria-hidden className='text-body text-ink'>
            {NOTICE_EVENT_LABEL[event]}
          </span>
          <SegmentedControl
            label={NOTICE_EVENT_LABEL[event]}
            value={events.includes(event) ? "on" : "off"}
            onValueChange={(value) => chooseEvent(event, value === "on")}
            options={EVENT_SWITCH}
          />
        </li>
      ))}
    </ul>
  );
}

/** What to do when the app could not show a test. */
const RESTART_AND_TEST = "Quit Agent Lookout, open it again, and send another test.";

/** What to do when the app's window may not show notifications. */
const RESTART_AND_TURN_ON = "Quit Agent Lookout, open it again, and turn them on here.";

/** What to do when macOS will not show the app's notifications. */
const ALLOW_AND_TEST =
  "Open System Settings, choose Notifications, then Agent Lookout, and turn on Allow notifications. Then send a test again.";

/** What to do when macOS will not show the app's notifications, and what it said. */
function AllowInSystemSettings({ reason }: { reason: string }) {
  return (
    <>
      <p>{ALLOW_AND_TEST}</p>
      <p className='mt-2'>
        macOS said: <FactText>{reason}</FactText>
      </p>
    </>
  );
}

/**
 * Send a test, on the Notifications card in the Mac app only: one quiet button
 * at `sm` that asks the app for one test notification, and beside it, in a
 * polite live region that is in the page before there is anything to say,
 * what macOS made of it: "Sending a test…", then "macOS took the test at
 * 14:02.", or that it has not answered yet, as while it asks whether Agent
 * Lookout may show notifications. A refusal is the info note "macOS did not
 * allow it" under the row, with what to do and macOS's own words, and the
 * same title and what to do in the line for a screen reader alone. A test
 * that could not be shown, whether this Mac gives the app no way or Electron
 * could not make it, is the note "Agent Lookout could not show a notification",
 * with what to do.
 *
 * While no test's answer is on screen, before any press, while a test is under
 * way and after one the app did not answer, the last refusal the page knows of
 * is the same note, titled for the last notification: the one the app said
 * when the card was drawn, or the one a later test was refused with. A test
 * macOS shows clears it.
 *
 * As on the ntfy and Pushover cards, the button keeps its words and its focus
 * while a test is under way, and a press then does nothing.
 */
function AppNotificationTest({ test, now }: { test: NotificationTest; now: number }) {
  const { step, lastRefusal, send } = test;
  const sending = step.kind === "sending";
  const answer = step.kind === "answered" ? step.answer : null;

  return (
    <>
      <div className='mt-3 flex min-h-button flex-wrap items-center gap-x-3 gap-y-2'>
        <Button size='sm' onClick={send} aria-disabled={sending || undefined}>
          Send a test
        </Button>
        <p data-part='test' role='status' className='text-body text-ink'>
          {sending && "Sending a test…"}
          {step.kind === "answered" && answer?.outcome === "shown" && (
            <>
              macOS took the test at <span className='tabular-nums'>{clockAt(step.at, now)}</span>.
            </>
          )}
          {answer?.outcome === "no-answer" &&
            "macOS has not answered yet. If it asks whether Agent Lookout may show notifications, allow them, then send a test again."}
          {answer?.outcome === "refused" && (
            <span className='sr-only'>macOS did not allow it. {ALLOW_AND_TEST}</span>
          )}
          {answer?.outcome === "unsupported" && (
            <span className='sr-only'>
              Agent Lookout could not show a notification. {RESTART_AND_TEST}
            </span>
          )}
          {step.kind === "failed" && (
            <span className='sr-only'>
              The test was not sent. Agent Lookout did not answer. Try again in a moment.
            </span>
          )}
        </p>
      </div>
      {answer?.outcome === "refused" && (
        <Callout title='macOS did not allow it' className='mt-3'>
          <AllowInSystemSettings reason={answer.reason} />
        </Callout>
      )}
      {answer?.outcome === "unsupported" && (
        <Callout title='Agent Lookout could not show a notification' className='mt-3'>
          <p>{RESTART_AND_TEST}</p>
        </Callout>
      )}
      {step.kind === "failed" && (
        <Callout title='The test was not sent' className='mt-3'>
          <p>Agent Lookout did not answer. Try again in a moment.</p>
        </Callout>
      )}
      {step.kind !== "answered" && lastRefusal !== null && (
        <Callout title='macOS did not show the last notification' className='mt-3'>
          <AllowInSystemSettings reason={lastRefusal} />
        </Callout>
      )}
    </>
  );
}

/**
 * Whether what the app last heard from macOS is a refusal: a test's answer
 * while it is on screen, and otherwise, while one is under way or after the
 * app did not answer, the last refusal the page knows of.
 */
function refusedByMacOS({ step, lastRefusal }: NotificationTest): boolean {
  if (step.kind === "answered") return step.answer.outcome === "refused";
  return lastRefusal !== null;
}

/**
 * Whether notifications are sent, and for which events. They are off until
 * the person turns them on, with the button here or, in the Mac app, with Turn
 * on in the Overview's question (`dashboard/NotificationPrompt.tsx`), and
 * those two are the only things in the app that ask for permission.
 *
 * The state is said in words beside a button that changes it. It is not the
 * switch the theme uses, because that chooses as soon as it has focus, and the
 * browser can refuse "on". When it does, or cannot show notifications at all,
 * the state stays off and a note says why and what to do. While they are on,
 * the events are listed under it, each with a switch of its own.
 *
 * Every request the page makes tells the app what these are set to, and the
 * notifications the app shows itself, when no page is open, follow them.
 *
 * In the Mac app the card speaks of macOS and this app, not of a browser and
 * a tab, and says the app's setting is its own: its page keeps the choice
 * apart from any browser's. There the page's own permission always reads
 * granted, whatever macOS decides, so the card has Send a test, which says
 * what macOS made of a notification, and turning them on sends one too, so
 * macOS asks its own question then. While macOS refuses them, the state says
 * so.
 */
function NotificationsCard({ inApp, now }: { inApp: boolean; now: number }) {
  const { on, permission, events, turnOn, turnOff, chooseEvent } = useNotificationSetting();
  const test = useNotificationTest(inApp);
  const refused = inApp && refusedByMacOS(test);

  const turnOnHere = () => {
    turnOn();
    // The app's first notification is when macOS asks whether it may show them.
    if (inApp) test.send();
  };

  const state = inApp
    ? on
      ? refused
        ? "Notifications are on in this app, but macOS is not showing them."
        : "Notifications are on in this app."
      : "Notifications are off in this app."
    : on
      ? "Notifications are on."
      : "Notifications are off.";

  return (
    <SectionCard title='Notifications'>
      <div className='px-6 pb-6'>
        {/* As tall as its button, so what follows keeps its place when there is none. */}
        <div className='flex min-h-button flex-wrap items-center gap-x-3 gap-y-2'>
          {/* Said again to a screen reader when the button changes it. */}
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {state}
          </p>
          {permission !== "unsupported" && (
            <Button size='sm' onClick={on ? turnOff : turnOnHere}>
              {on ? "Turn off notifications" : "Turn on notifications"}
            </Button>
          )}
        </div>

        {on && <EventSwitches events={events} chooseEvent={chooseEvent} />}
        {on && events.length === 0 && (
          <p className='mt-3 text-body text-ink-secondary'>
            No event is switched on, so none is sent.
          </p>
        )}

        {inApp && <AppNotificationTest test={test} now={now} />}

        {permission === "denied" &&
          (inApp ? (
            <Callout title='This window is not allowed to show notifications' className='mt-3'>
              <p>{RESTART_AND_TURN_ON}</p>
            </Callout>
          ) : (
            <Callout title='Notifications are blocked' className='mt-3'>
              <p>
                Your browser is blocking notifications from this address. Allow them for this
                address in the browser's site settings, then turn them on here.
              </p>
            </Callout>
          ))}
        {permission === "unsupported" &&
          (inApp ? (
            <Callout title='This window cannot show notifications' className='mt-3'>
              <p>{RESTART_AND_TURN_ON}</p>
            </Callout>
          ) : (
            <Callout title='This browser cannot show notifications' className='mt-3'>
              <p>Open Agent Lookout in a browser that can, then turn them on here.</p>
            </Callout>
          ))}

        {/* In the app, first: the app's choice is not a browser's. */}
        {inApp && (
          <p className='mt-3 text-body text-ink-secondary'>
            This setting is the app's own. Turning notifications on in a browser does not turn them
            on here.
          </p>
        )}
        {/* Says what turning them on does, and nothing of what this browser can do. */}
        <p className={cn("text-body text-ink-secondary", inApp ? "mt-2" : "mt-3")}>
          With Needs you on, a notification appears each time a session starts waiting for you. It
          names the session and the reason, and is cleared when the session moves on.
        </p>
        {/* While they are on, the switches above say this. */}
        {!on && (
          <p className='mt-2 text-body text-ink-secondary'>
            Once they are on, you can also be told when a session finishes or fails, or ends without
            saying whether it finished, as when its process stops. Those name the session and what
            happened, and stay until you clear them.
          </p>
        )}
        <p className='mt-2 text-body text-ink-secondary'>
          {inApp
            ? "They also arrive while this window is closed, for as long as Agent Lookout keeps running, and those stay until you clear them."
            : "On a Mac they also arrive when no dashboard tab is open, for as long as Agent Lookout keeps running, and those stay until you clear them."}{" "}
          What each agent can report, under{" "}
          <a
            href='#sources'
            className='rounded-bar underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:text-ink'
          >
            Sources
          </a>
          , says which agents can be seen waiting.
        </p>
        {inApp && (
          <p className='mt-2 text-body text-ink-secondary'>
            macOS hides their banners while the display is shared or mirrored, unless Allow
            notifications when mirroring or sharing the display is on, in System Settings under
            Notifications.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

/** A card's two lines from a reading: nothing before the app has answered. */
function wordsOf<Status>(
  reading: OutboundStatusReading<Status> | null,
  unknown: string,
  words: (status: Status, now: number) => SendingWords,
): SendingWords | null {
  if (reading === null) return null;
  if (reading.status === "unknown") {
    return { state: unknown, asking: null, title: null, detail: null };
  }
  return words(reading.status, reading.readAt);
}

/**
 * Whether the app sends something off this computer one way, by email, to a
 * webhook, or as a push through ntfy or Pushover, for which events, and how
 * the last one went. It is only read here. Each is set up in the environment
 * Agent Lookout starts with, so nothing here turns one on or off, and the
 * button for notifications does not cover them. Before the app has answered,
 * the card says nothing.
 *
 * While it is on, a line under the state says whether a wait's email, post or
 * push says what the session is asking, which is off unless its setting is
 * on, and for ntfy one more says whether an access token guards the topic.
 *
 * A setting that is wrong, a send that failed and the hourly limit are said in
 * the info note that says notifications are blocked, so a channel that is not
 * working never reads like one that is.
 *
 * The ntfy and Pushover cards have one control, Send a test, while they are
 * on, last in the card: `test` names the channel it sends through.
 */
function SendingCard({
  title,
  words,
  test,
}: {
  title: string;
  words: SendingWords | null;
  /**
   * The channel Send a test goes through, while it is on, and the page's
   * clock, for the time a test went. Null for none.
   */
  test?: { channel: PhoneChannel; now: number } | null;
}) {
  return (
    <SectionCard title={title}>
      <div className='px-6 pb-6'>
        <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
          {words?.state}
        </p>
        {words?.asking && (
          <p data-part='asking' className='mt-3 text-body text-ink-secondary'>
            <FactText>{words.asking}</FactText>
          </p>
        )}
        {words?.note && (
          <p data-part='note' className='mt-3 text-body text-ink-secondary'>
            <FactText>{words.note}</FactText>
          </p>
        )}
        {words?.detail &&
          (words.title ? (
            <Callout title={words.title} className='mt-3'>
              <p>
                <FactText>{words.detail}</FactText>
              </p>
            </Callout>
          ) : (
            <p className='mt-3 text-body text-ink-secondary'>
              <FactText>{words.detail}</FactText>
            </p>
          ))}
        {test && <TestSend channel={test.channel} now={test.now} />}
      </div>
    </SectionCard>
  );
}

/** "a", "a and b", "a, b and c". */
function listOf(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Which ways of sending something off this computer are on. */
interface Sending {
  emailing: boolean;
  posting: boolean;
  pushing: boolean;
}

/**
 * Where the person's data goes, as the facts about this copy say it. While gh
 * is asked for pull requests, the names of repositories and branches go to
 * GitHub through it. While gh is missing or signed out nothing goes, and the
 * words say so.
 */
function whereDataGoes({ emailing, posting, pushing }: Sending, pullRequests: boolean): string {
  const kinds = [
    ...(emailing ? ["emails"] : []),
    ...(posting ? ["posts"] : []),
    ...(pushing ? ["pushes"] : []),
  ];
  // A post alone is named as the webhook's, so it is not taken for something else.
  const sent =
    kinds.length === 0
      ? null
      : kinds.length === 1 && posting
        ? "the webhook posts you set up"
        : `the ${listOf(kinds)} you set up`;
  if (pullRequests) {
    return sent === null
      ? "Sent only as repository and branch names, to GitHub through gh"
      : `Sent only in ${sent}, and repository and branch names to GitHub`;
  }
  return sent === null ? "Agent Lookout sends it nowhere" : `Sent only in ${sent}`;
}

interface SettingsViewProps {
  /** The history the page holds, as `/api/history` last answered. Null before the app has answered. */
  history?: Pick<HistoryResponse, "startedAt" | "since" | "kept"> | null;
  now?: number;
  /** Told once the history has been cleared, so the page reads it again at once. */
  onHistoryCleared?: () => void;
  /** Told once the time rules have changed, so the page reads the sessions again at once. */
  onTimeRulesChanged?: () => void;
  /** The page's latest snapshot, whose rules and quiet hours the Time rules card follows. Null before the first. */
  snapshot?: Pick<SessionsSnapshot, "generatedAt" | "timeRules" | "quiet"> | null;
  /** Whether the page is in the Mac app's window, which alone shows the Menu bar and Updates cards. */
  inApp?: boolean;
  /** Whether permission prompts can be answered from here, as the sessions' answer says. Null before it. */
  answering?: AnsweringStatus | null;
}

/**
 * Settings, in the main area in place of the Overview: the theme, with the
 * choice to follow the computer that the header's switch does not offer,
 * whether to be notified and of what, the time rules, where the history is kept and the button
 * that clears it, in the Mac app whether it shows in the menu bar and its
 * updates, whether email, a webhook, ntfy and Pushover have been set up, with
 * a test push for the last two, whether pull requests
 * are shown and gh can be asked for them, a few facts about this copy of the
 * app, whether permission prompts can be answered from here, and the
 * permission rules that answer them for the person.
 *
 * The page knows it is in the app's window by its address. In a browser there
 * is no Menu bar card and no Updates card: a browser tab has no menu bar item,
 * and `npx agent-lookout` and the repository never check for anything. Tests
 * say which it is with `inApp`.
 */
export function SettingsView({
  history = null,
  now,
  onHistoryCleared,
  onTimeRulesChanged,
  snapshot = null,
  inApp = inAppWindow(),
  answering = null,
}: SettingsViewProps = {}) {
  const { preference, setPreference } = useTheme();
  // The page's own clock, when the page does not hand one in.
  const ticking = useNow();
  const email = useOutboundStatus(fetchEmailStatus);
  const webhook = useOutboundStatus(fetchWebhookStatus);
  const ntfy = useOutboundStatus(fetchNtfyStatus);
  const pushover = useOutboundStatus(fetchPushoverStatus);
  const pullRequests = useOutboundStatus(fetchPullRequestsStatus);
  // Emails, webhook posts and pushes are the only things Agent Lookout sends
  // off this computer, and only once set up, with the names gh sends GitHub
  // for pull requests, once those are on and gh can be asked.
  const pushingNtfy = typeof ntfy?.status === "object" && ntfy.status.on;
  const pushingPushover = typeof pushover?.status === "object" && pushover.status.on;
  const sending: Sending = {
    emailing: typeof email?.status === "object" && email.status.on,
    posting: typeof webhook?.status === "object" && webhook.status.on,
    pushing: pushingNtfy || pushingPushover,
  };
  const askingGh = typeof pullRequests?.status === "object" && asksGitHub(pullRequests.status);
  const clock = now ?? ticking;

  return (
    <div
      data-slot='settings-view'
      className='grid grid-cols-12 items-start gap-4 max-wide:flex max-wide:flex-col'
    >
      {/*
       * The settings on the left, and on the right what is only read: email,
       * the webhook, ntfy, Pushover, pull requests and the facts about this copy, as Sources keeps its
       * explanations in the right third. When the view narrows the right stacks
       * under the left.
       */}
      <div className='col-span-8 flex min-w-0 flex-col gap-4 max-wide:w-full'>
        <SectionCard title='Theme'>
          <div className='px-6 pb-6'>
            <SegmentedControl
              label='Theme'
              value={preference}
              onValueChange={setPreference}
              options={THEME_OPTIONS}
            />
            <p className='mt-3 text-body text-ink-secondary'>
              Night is the default. System follows the setting on your computer, and changes when it
              does.
            </p>
          </div>
        </SectionCard>

        <NotificationsCard inApp={inApp} now={clock} />

        <TimeRulesCard onChanged={onTimeRulesChanged} snapshot={snapshot} />

        <HistoryCard history={history} now={clock} onCleared={onHistoryCleared} />

        {inApp && <MenuBarCard />}

        {inApp && <UpdatesCard />}
      </div>

      <div className='col-span-4 flex min-w-0 flex-col gap-4 max-wide:w-full'>
        <SendingCard
          title='Email'
          words={wordsOf(email, "Whether email is set up could not be read.", emailWords)}
        />
        <SendingCard
          title='Webhook'
          words={wordsOf(webhook, "Whether the webhook is set up could not be read.", webhookWords)}
        />
        <SendingCard
          title='ntfy'
          words={wordsOf(ntfy, "Whether ntfy is set up could not be read.", ntfyWords)}
          test={pushingNtfy ? { channel: "ntfy", now: clock } : null}
        />
        <SendingCard
          title='Pushover'
          words={wordsOf(pushover, "Whether Pushover is set up could not be read.", pushoverWords)}
          test={pushingPushover ? { channel: "pushover", now: clock } : null}
        />
        <SendingCard
          title='Pull requests'
          words={wordsOf(
            pullRequests,
            "Whether pull requests are shown could not be read.",
            pullRequestsWords,
          )}
        />
        <AnswerCard answering={answering} />
        {/* Next to Permission prompts, since a rule answers only while those can be answered. */}
        <PermissionRulesCard answering={answering} now={clock} />
        <SectionCard title='This copy'>
          <FactList className='px-6 pb-3'>
            <FactRow label='Version' mono>
              v{__APP_VERSION__}
            </FactRow>
            <FactRow label='Your data'>
              <FactText>{whereDataGoes(sending, askingGh)}</FactText>
            </FactRow>
          </FactList>
        </SectionCard>
      </div>
    </div>
  );
}
