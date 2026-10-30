import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { Literal } from "@dashboard/components/ui/facts/Literal";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { useKeepAwakeSetting } from "@dashboard/hooks/app/useKeepAwakeSetting";

const SWITCH = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

/** The name of the switch, beside it and for assistive technology. */
const KEEP_AWAKE = "Keep the Mac awake";

/**
 * Keep awake, in Settings, in the Mac app only: the switch that keeps the Mac
 * from going to sleep on its own while a session counts, as
 * `src/core/keep-awake/keepAwakeRule.ts` decides, and lets it sleep again once
 * none does. It is off until the person turns it on. Like the Menu bar card,
 * the switch can always be flipped, so it is the segmented control, and it
 * shows what the app says, so a change the app did not take does not look
 * taken. Nothing here is warm. Before the app has answered, the row is empty
 * and keeps its height.
 *
 * "Quiet" is the Quiet for of the Sessions list. A working session stops
 * counting 30 minutes after its newest update, and where its agent's writes
 * are measured, that is when it has been quiet for 30 minutes. A Claude Code
 * session counts while it is listed, and an OpenCode session, which never
 * shows Quiet for, stops counting 30 minutes after the prompt that began its
 * turn, as the rule says.
 */
export function KeepAwakeCard() {
  const { reading, setOn } = useKeepAwakeSetting();

  return (
    <SectionCard title='Keep awake' data-part='keep-awake'>
      <div className='px-6 pb-6'>
        {/* As tall as the switch, so the explanation keeps its place while the app answers. */}
        <div data-part='row' className='flex min-h-9 items-center justify-between gap-6'>
          {reading === "unknown" && (
            <p data-part='state' className='text-body font-medium text-ink'>
              Whether the Mac is kept awake could not be read.
            </p>
          )}
          {reading !== null && reading !== "unknown" && (
            <>
              {/* The switch carries the same name, so this is not read twice. */}
              <span aria-hidden className='text-body text-ink'>
                {KEEP_AWAKE}
              </span>
              <SegmentedControl
                label={KEEP_AWAKE}
                value={reading.on ? "on" : "off"}
                onValueChange={(value) => setOn(value === "on")}
                options={SWITCH}
              />
            </>
          )}
        </div>
        <p className='mt-3 text-body text-ink-secondary'>
          While it is on, the Mac does not go to sleep on its own while a session is working or
          needs you, on this Mac or on another machine Agent Lookout watches. The display still
          turns off. A working Claude Code session counts for as long as it works, and another
          agent's stops counting 30 minutes after its newest update.
        </p>
        <p className='mt-2 text-body text-ink-secondary'>
          Closing the lid still puts the Mac to sleep, unless it is plugged in with a display
          connected, and so do Sleep in the Apple menu and a low battery. A Mac that is asleep sends
          nothing until it wakes. Agent Lookout run with{" "}
          <code data-slot='fact' className='font-mono text-fact'>
            <Literal>npx agent-lookout</Literal>
          </code>{" "}
          cannot keep the Mac awake.
        </p>
      </div>
    </SectionCard>
  );
}
