import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { useMenuBarSetting } from "@dashboard/hooks/app/useMenuBarSetting";

const SWITCH = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

/** The name of the switch, beside it and for assistive technology. */
const SHOW = "Show in menu bar";

/**
 * Menu bar, in Settings, in the Mac app only: the switch that puts Agent
 * Lookout's icon in the menu bar, with the count of sessions that need you
 * beside it and a menu that lists them, or takes it away. It is on until the
 * person turns it off. The switch can always be flipped, so it is the
 * segmented control, and it shows what the app says, so a change the app did
 * not take does not look taken. Nothing here is warm. Before the app has
 * answered, the row is empty and keeps its height.
 */
export function MenuBarCard() {
  const { reading, setShown } = useMenuBarSetting();

  return (
    <SectionCard title='Menu bar' data-part='menu-bar'>
      <div className='px-6 pb-6'>
        {/* As tall as the switch, so the explanation keeps its place while the app answers. */}
        <div data-part='row' className='flex min-h-9 items-center justify-between gap-6'>
          {reading === "unknown" && (
            <p data-part='state' className='text-body font-medium text-ink'>
              Whether Agent Lookout is in the menu bar could not be read.
            </p>
          )}
          {reading !== null && reading !== "unknown" && (
            <>
              {/* The switch carries the same name, so this is not read twice. */}
              <span aria-hidden className='text-body text-ink'>
                {SHOW}
              </span>
              <SegmentedControl
                label={SHOW}
                value={reading.show ? "on" : "off"}
                onValueChange={(value) => setShown(value === "on")}
                options={SWITCH}
              />
            </>
          )}
        </div>
        <p className='mt-3 text-body text-ink-secondary'>
          While it is on, Agent Lookout's icon in the menu bar shows how many sessions need you,
          with the window open or closed. Click it to list them, with how long each has waited and
          what it is asking, and choose one to open its details.
        </p>
      </div>
    </SectionCard>
  );
}
