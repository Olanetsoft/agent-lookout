import { Button } from "@dashboard/components/ui/controls/Button";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";
import { FactText } from "@dashboard/components/ui/facts/FactText";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import {
  useEmailStatus,
  type EmailStatusReading,
} from "@dashboard/hooks/notifications/useEmailStatus";
import { useNotificationSetting } from "@dashboard/hooks/notifications/useNotificationSetting";
import { useTheme } from "@dashboard/hooks/shell/useTheme";
import { emailWords } from "@dashboard/lib/notifications/emailStatus";
import type { ThemePreference } from "@dashboard/lib/shell/theme";

const THEME_OPTIONS = [
  { value: "dark", label: "Night", name: "Dark theme" },
  { value: "light", label: "Day", name: "Light theme" },
  { value: "system", label: "System", name: "Follow the computer's setting" },
] as const satisfies readonly { value: ThemePreference; label: string; name: string }[];

/**
 * Whether a session that starts waiting sends a notification. They are off
 * until the person turns them on here, and pressing the button is the only
 * thing in the app that asks the browser for permission.
 *
 * The state is said in words beside a button that changes it. It is not the
 * switch the theme uses, because that chooses as soon as it has focus, and the
 * browser can refuse "on". When it does, or cannot show notifications at all,
 * the state stays off and a note says why and what to do.
 *
 * There is one switch. Every request the page makes tells the app what it is
 * set to, and the notifications the app shows itself, when no page is open,
 * follow it.
 */
function NotificationsCard() {
  const { on, permission, turnOn, turnOff } = useNotificationSetting();

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
          When notifications are on, one appears each time a session starts waiting for you. It
          names the session and the reason, and is cleared when the session moves on.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          On a Mac they also arrive when no dashboard tab is open, for as long as Agent Lookout
          keeps running, and those stay until you clear them. Only Claude Code sessions can be seen
          waiting, so a Codex session never sends one.
        </p>
      </div>
    </SectionCard>
  );
}

/**
 * Whether the app emails the person when a wait lasts, and how the last email
 * went. It is only read here. Email is set up in the environment Agent Lookout
 * starts with, so the card has no control, and the button for notifications
 * does not cover it. Before the app has answered, the card says nothing.
 */
function EmailCard({ reading }: { reading: EmailStatusReading | null }) {
  const words =
    reading === null
      ? null
      : reading.status === "unknown"
        ? { state: "Whether email is set up could not be read.", detail: null }
        : emailWords(reading.status, reading.readAt);

  return (
    <SectionCard title='Email'>
      <div className='px-6 pb-6'>
        <p data-part='state' aria-live='polite' className='text-body font-medium text-ink'>
          {words?.state}
        </p>
        {words?.detail && (
          <p className='mt-3 text-body text-ink-secondary'>
            <FactText>{words.detail}</FactText>
          </p>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Settings, in the main area in place of the Overview: the theme, with the
 * choice to follow the computer that the header's switch does not offer,
 * whether to be notified when a session starts waiting, whether email has
 * been set up, and a few facts about this copy of the app.
 */
export function SettingsView() {
  const { preference, setPreference } = useTheme();
  const email = useEmailStatus();
  // An email is the one thing Agent Lookout sends off this computer, and only once set up.
  const emailing = typeof email?.status === "object" && email.status.on;

  return (
    <div
      data-slot='settings-view'
      className='grid grid-cols-12 items-start gap-4 max-wide:flex max-wide:flex-col'
    >
      {/* One column of settings. When the view narrows it stacks above the facts. */}
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
        <EmailCard reading={email} />
      </div>

      <SectionCard title='This copy' className='col-span-4 max-wide:w-full'>
        <FactList className='px-6 pb-3'>
          <FactRow label='Version' mono>
            v{__APP_VERSION__}
          </FactRow>
          <FactRow label='Your data'>
            {emailing ? "Leaves only in the emails you set up" : "Stays on this computer"}
          </FactRow>
        </FactList>
      </SectionCard>
    </div>
  );
}
