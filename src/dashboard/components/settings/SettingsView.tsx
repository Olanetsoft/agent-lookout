import type { HistoryResponse } from "@core/api";
import { NOTICE_EVENTS, type NoticeEvent } from "@core/notices/sessionChanges";
import { NOTICE_EVENT_LABEL } from "@core/notices/waiting";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { HistoryCard } from "@dashboard/components/settings/HistoryCard";
import { MenuBarCard } from "@dashboard/components/settings/MenuBarCard";
import { UpdatesCard } from "@dashboard/components/settings/UpdatesCard";
import { useNow } from "@dashboard/hooks/data/useNow";
import { useNotificationSetting } from "@dashboard/hooks/notifications/useNotificationSetting";
import {
  useOutboundStatus,
  type OutboundStatusReading,
} from "@dashboard/hooks/notifications/useOutboundStatus";
import { useTheme } from "@dashboard/hooks/shell/useTheme";
import { emailWords, fetchEmailStatus } from "@dashboard/lib/notifications/emailStatus";
import type { SendingWords } from "@dashboard/lib/notifications/sendingWords";
import { fetchWebhookStatus, webhookWords } from "@dashboard/lib/notifications/webhookStatus";
import { inAppWindow } from "@dashboard/lib/shell/appWindow";
import type { ThemePreference } from "@dashboard/lib/shell/theme";

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

/**
 * Whether notifications are sent, and for which events. They are off until
 * the person turns them on here, and pressing the button is the only thing in
 * the app that asks the browser for permission.
 *
 * The state is said in words beside a button that changes it. It is not the
 * switch the theme uses, because that chooses as soon as it has focus, and the
 * browser can refuse "on". When it does, or cannot show notifications at all,
 * the state stays off and a note says why and what to do. While they are on,
 * the events are listed under it, each with a switch of its own.
 *
 * Every request the page makes tells the app what these are set to, and the
 * notifications the app shows itself, when no page is open, follow them.
 */
function NotificationsCard() {
  const { on, permission, events, turnOn, turnOff, chooseEvent } = useNotificationSetting();

  return (
    <SectionCard title='Notifications'>
      <div className='px-6 pb-6'>
        {/* As tall as its button, so what follows keeps its place when there is none. */}
        <div className='flex min-h-button flex-wrap items-center gap-x-3 gap-y-2'>
          {/* Said again to a screen reader when the button changes it. */}
          <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
            {on ? "Notifications are on." : "Notifications are off."}
          </p>
          {permission !== "unsupported" && (
            <Button size='sm' onClick={on ? turnOff : turnOn}>
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

        {permission === "denied" && (
          <Callout title='Notifications are blocked' className='mt-3'>
            <p>
              Your browser is blocking notifications from this address. Allow them for this address
              in the browser's site settings, then turn them on here.
            </p>
          </Callout>
        )}
        {permission === "unsupported" && (
          <Callout title='This browser cannot show notifications' className='mt-3'>
            <p>Open Agent Lookout in a browser that can, then turn them on here.</p>
          </Callout>
        )}

        {/* Says what turning them on does, and nothing of what this browser can do. */}
        <p className='mt-3 text-body text-ink-secondary'>
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
          On a Mac they also arrive when no dashboard tab is open, for as long as Agent Lookout
          keeps running, and those stay until you clear them. What each agent can report, under{" "}
          <a
            href='#sources'
            className='rounded-bar underline decoration-rule-strong underline-offset-2 transition-colors duration-120 hover:text-ink'
          >
            Sources
          </a>
          , says which agents can be seen waiting.
        </p>
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
 * Whether the app sends something off this computer one way, by email or to
 * a webhook, for which events, and how the last one went. It is only read
 * here. Both are set up in the environment Agent Lookout starts with, so the
 * card has no control, and the button for notifications does not cover them.
 * Before the app has answered, the card says nothing.
 *
 * While it is on, a line under the state says whether a wait's email or post
 * says what the session is asking, which is off unless its setting is on.
 *
 * A setting that is wrong, a send that failed and the hourly limit are said in
 * the info note that says notifications are blocked, so a channel that is not
 * working never reads like one that is.
 */
function SendingCard({ title, words }: { title: string; words: SendingWords | null }) {
  return (
    <SectionCard title={title}>
      <div className='px-6 pb-6'>
        <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
          {words?.state}
        </p>
        {words?.asking && (
          <p data-part='asking' className='mt-3 text-body text-ink-secondary'>
            {words.asking}
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
      </div>
    </SectionCard>
  );
}

/** Where the person's data goes, as the facts about this copy say it. */
function whereDataGoes(emailing: boolean, posting: boolean): string {
  if (emailing && posting) return "Sent only in the emails and posts you set up";
  if (emailing) return "Sent only in the emails you set up";
  if (posting) return "Sent only in the webhook posts you set up";
  return "Agent Lookout sends it nowhere";
}

interface SettingsViewProps {
  /** The history the page holds, as `/api/history` last answered. Null before the app has answered. */
  history?: Pick<HistoryResponse, "startedAt" | "since" | "kept"> | null;
  now?: number;
  /** Told once the history has been cleared, so the page reads it again at once. */
  onHistoryCleared?: () => void;
  /** Whether the page is in the Mac app's window, which alone shows the Menu bar and Updates cards. */
  inApp?: boolean;
}

/**
 * Settings, in the main area in place of the Overview: the theme, with the
 * choice to follow the computer that the header's switch does not offer,
 * whether to be notified and of what, where the history is kept and the button
 * that clears it, in the Mac app whether it shows in the menu bar and its
 * updates, whether email and a webhook have been set up, and a few facts about
 * this copy of the app.
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
  inApp = inAppWindow(),
}: SettingsViewProps = {}) {
  const { preference, setPreference } = useTheme();
  // The page's own clock, when the page does not hand one in.
  const ticking = useNow();
  const email = useOutboundStatus(fetchEmailStatus);
  const webhook = useOutboundStatus(fetchWebhookStatus);
  // Emails and webhook posts are the only things Agent Lookout sends off this
  // computer, and only once set up.
  const emailing = typeof email?.status === "object" && email.status.on;
  const posting = typeof webhook?.status === "object" && webhook.status.on;

  return (
    <div
      data-slot='settings-view'
      className='grid grid-cols-12 items-start gap-4 max-wide:flex max-wide:flex-col'
    >
      {/*
       * The settings on the left, and on the right what is only read: email,
       * the webhook and the facts about this copy, as Sources keeps its
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

        <NotificationsCard />

        <HistoryCard history={history} now={now ?? ticking} onCleared={onHistoryCleared} />

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
        <SectionCard title='This copy'>
          <FactList className='px-6 pb-3'>
            <FactRow label='Version' mono>
              v{__APP_VERSION__}
            </FactRow>
            <FactRow label='Your data'>{whereDataGoes(emailing, posting)}</FactRow>
          </FactList>
        </SectionCard>
      </div>
    </div>
  );
}
