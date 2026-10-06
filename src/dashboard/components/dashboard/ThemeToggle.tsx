import type { ReactNode } from "react";

import { MoonIcon, SunIcon } from "@dashboard/assets/Icons";
import { Button } from "@dashboard/components/ui/controls/Button";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { Tooltip } from "@dashboard/components/ui/surfaces/Tooltip";
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
 * The switch in the header between Night and Day. It marks the theme in force,
 * whichever way it was chosen, and choosing one stores that choice. Following
 * the computer's own setting is offered in Settings.
 *
 * In a narrow window it is one quiet round button, the size and material of
 * the search's beside it, showing the theme in force, the moon or the sun, and
 * named for what a press does: "Switch to Day". So the header holds the
 * wordmark, the status line and both controls down to 320px.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme();
  const narrow = useNarrow();
  if (narrow) {
    const other = resolved === "dark" ? "light" : "dark";
    const label = other === "light" ? "Switch to Day" : "Switch to Night";
    return (
      <Tooltip content={label} align='end'>
        <Button
          size='icon'
          aria-label={label}
          data-part='theme'
          onClick={() => setPreference(other)}
          className={className}
        >
          {resolved === "dark" ? <MoonIcon /> : <SunIcon />}
        </Button>
      </Tooltip>
    );
  }
  return (
    <SegmentedControl
      label='Theme'
      value={resolved}
      onValueChange={setPreference}
      options={OPTIONS}
      className={className}
    />
  );
}
