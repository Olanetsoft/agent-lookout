import { FactList, FactRow } from "@dashboard/components/ui/FactRow";
import { SectionCard } from "@dashboard/components/ui/SectionCard";
import { SegmentedControl } from "@dashboard/components/ui/SegmentedControl";
import { useTheme } from "@dashboard/hooks/useTheme";
import type { ThemePreference } from "@dashboard/lib/theme";

const THEME_OPTIONS = [
  { value: "dark", label: "Night", name: "Dark theme" },
  { value: "light", label: "Day", name: "Light theme" },
  { value: "system", label: "System", name: "Follow the computer's setting" },
] as const satisfies readonly { value: ThemePreference; label: string; name: string }[];

/**
 * Settings, in the main area in place of the Overview. For now that is the
 * theme, with the choice to follow the computer that the header's switch does
 * not offer, and a few facts about this copy of the app.
 */
export function SettingsView() {
  const { preference, setPreference } = useTheme();

  return (
    <div
      data-slot='settings-view'
      className='grid grid-cols-12 items-start gap-4 max-wide:flex max-wide:flex-col'
    >
      <SectionCard title='Theme' className='col-span-8 max-wide:w-full'>
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
