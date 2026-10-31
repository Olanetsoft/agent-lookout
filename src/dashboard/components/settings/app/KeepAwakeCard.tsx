import { keepsAwake } from "@core/keep-awake/keepAwakeRule";
import { nameOnMachine, type SessionsSnapshot } from "@core/sessions/session";
import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { Literal } from "@dashboard/components/ui/facts/Literal";
import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import {
  useKeepAwakeSetting,
  type KeepAwakeReading,
} from "@dashboard/hooks/app/useKeepAwakeSetting";
import { countState } from "@dashboard/lib/sessions/sessions";

const SWITCH = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const satisfies readonly { value: "on" | "off"; label: string }[];

/** The name of the switch, beside it and for assistive technology. */
const KEEP_AWAKE = "Keep the Mac awake";

/** How many of the sessions that keep the Mac awake are named. The rest are counted. */
export const NAMED_SESSIONS = 3;

/** "checkout-flow, docs-site and billing-webhooks", or "checkout-flow, docs-site, api-tests and 2 more". */
function namesInWords(names: readonly string[]): string {
  const shown = names.slice(0, NAMED_SESSIONS);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  return shown.length <= 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * With the switch on, whether the Mac is kept awake right now, as the app
 * says, and by which sessions, as the page works them out from its own
 * snapshot by the app's rule. Null while the switch is off or the app has not
 * answered.
 */
function nowInWords(
  reading: KeepAwakeReading,
  snapshot: Pick<SessionsSnapshot, "generatedAt" | "sessions" | "sources"> | null,
): string | null {
  if (reading === null || reading === "unknown" || !reading.on) return null;
  if (reading.failed) {
    return "The Mac could not be kept awake, so it can go to sleep as usual. Agent Lookout tries again every few seconds.";
  }
  if (!reading.holding) {
    // Nothing counts, by the rule: a working session past its 30 minutes is
    // still listed as working, so the line says what the rule decided. And
    // before any session has been read, nothing has been counted at all.
    return countState(snapshot?.sessions ?? null, snapshot?.sources).counted
      ? "No session keeps the Mac awake now, so it can go to sleep as usual."
      : "Agent Lookout has not read your sessions yet.";
  }
  const names = (snapshot?.sessions ?? [])
    .filter((session) => keepsAwake(session, snapshot?.generatedAt ?? 0))
    .map((session) => nameOnMachine(session.name, session.machine));
  // The app follows a newer snapshot than the page's for a moment, so the page may name none.
  return names.length === 0
    ? "The Mac is being kept awake now."
    : `The Mac is being kept awake now, by ${namesInWords(names)}.`;
}

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
 * session whose process runs counts while it is listed, and an OpenCode session, which never
 * shows Quiet for, stops counting 30 minutes after the prompt that began its
 * turn, as the rule says.
 *
 * With the switch on, a line under it says whether the Mac is kept awake right
 * now and, while it is, names the sessions that count, on this Mac and on the
 * other machines Agent Lookout watches, by the same rule the app goes by,
 * worked out here from the page's snapshot: the app keeps nothing about them
 * and says only whether it holds the Mac awake. The app is asked again each
 * time the page has a new snapshot, so the line follows a session that starts
 * or stops counting within a poll or two. When the app could not take its
 * hold, the line says so rather than look as if it works. When nothing counts,
 * it says that no session keeps the Mac awake, not that none works: a working
 * session past its 30 minutes is still listed as working. Before any session
 * has been read, it says that, since nothing has been counted.
 */
export function KeepAwakeCard({
  snapshot = null,
}: {
  /** The page's latest snapshot, whose sessions are named while they keep the Mac awake. Null before the first. */
  snapshot?: Pick<SessionsSnapshot, "generatedAt" | "sessions" | "sources"> | null;
}) {
  const { reading, setOn } = useKeepAwakeSetting(snapshot?.generatedAt ?? null);
  const now = nowInWords(reading, snapshot);

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
        {now !== null && (
          <p data-part='now' className='mt-2 text-body text-ink'>
            {now}
          </p>
        )}
        <p className='mt-3 text-body text-ink-secondary'>
          While it is on, the Mac does not go to sleep on its own while a session is working or
          needs you, on this Mac or on another machine Agent Lookout watches. The display still
          turns off. A working Claude Code session counts while its process runs, and another
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
