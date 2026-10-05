import { Button } from "@dashboard/components/ui/Button";
import { Callout } from "@dashboard/components/ui/Callout";
import { FactList, FactRow } from "@dashboard/components/ui/FactRow";
import { SectionCard } from "@dashboard/components/ui/SectionCard";
import { SegmentedControl } from "@dashboard/components/ui/SegmentedControl";
import { useNotificationSetting } from "@dashboard/hooks/useNotificationSetting";
import { useTheme } from "@dashboard/hooks/useTheme";
import type { ThemePreference } from "@dashboard/lib/theme";

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
          Notifications come from this page, so it has to stay open in a tab. Only Claude Code
          sessions can be seen waiting, so a Codex session never sends one.
        </p>
      </div>
    </SectionCard>
  );
}

/**
 * Settings, in the main area in place of the Overview: the theme, with the
 * choice to follow the computer that the header's switch does not offer,
 * whether to be notified when a session starts waiting, and a few facts about
 * this copy of the app.
 */
export function SettingsView() {
  const { preference, setPreference } = useTheme();

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
      </div>

      <SectionCard title='This copy' className='col-span-4 max-wide:w-full'>
        <FactList className='px-6 pb-3'>
          <FactRow label='Version' mono>
            v{__APP_VERSION__}
          </FactRow>
          <FactRow label='Your data'>Stays on this computer</FactRow>
        </FactList>
      </SectionCard>
    </div>
  );
}
