import type { ReactNode } from "react";

import { MoonIcon, SunIcon } from "@dashboard/assets/Icons";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { useNarrow } from "@dashboard/hooks/dom/useMediaQuery";
import { useTheme } from "@dashboard/hooks/shell/useTheme";
import type { ResolvedTheme } from "@dashboard/lib/shell/theme";

const OPTIONS = [
  { value: "dark", label: "Night", name: "Dark theme", icon: <MoonIcon /> },
  { value: "light", label: "Day", name: "Light theme", icon: <SunIcon /> },
] as const satisfies readonly {
  value: ResolvedTheme;
  label: string;
  name: string;
  icon: ReactNode;
}[];

/**
 * In a narrow window the moon and the sun stand alone, so the header fits a
 * phone. Each option keeps its name for assistive technology. The control pads
 * an option with an icon less on its left, ahead of the word; with no word,
 * the icon takes back the difference on its right, so it sits in the middle.
 */
const ICONS_ONLY = OPTIONS.map((option) => ({
  ...option,
  label: "",
  icon: <span className='-mr-1 flex'>{option.icon}</span>,
}));

/**
 * The switch in the header between Night and Day. It marks the theme in force,
 * whichever way it was chosen, and choosing one stores that choice. Following
 * the computer's own setting is offered in Settings.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme();
  const narrow = useNarrow();
  return (
    <SegmentedControl
      label='Theme'
      value={resolved}
      onValueChange={setPreference}
      options={narrow ? ICONS_ONLY : OPTIONS}
      className={className}
    />
  );
}
