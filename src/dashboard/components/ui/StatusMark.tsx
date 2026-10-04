import type { SessionStatus } from "@core/session";
import { STATUS_LABEL } from "@dashboard/lib/status";
import { cn } from "@dashboard/lib/utils";

/**
 * What a mark can stand for: a session's status, and four things that only the
 * history shows. `stale` is an idle session left a day or more, `answered` is a
 * wait that is over, `ended` is a session that has gone without saying how it
 * finished, and `lookout` is Agent Lookout itself, in the events log.
 */
export type MarkKind = SessionStatus | "stale" | "answered" | "ended" | "lookout";

const MARK_LABEL: Record<MarkKind, string> = {
  ...STATUS_LABEL,
  stale: "Stale",
  answered: "Needed you, answered",
  ended: "Ended",
  lookout: "Agent Lookout",
};

/**
 * Each mark is drawn in `currentColor`, so its colour is set once here. Only the
 * lamp is warm. In the day theme the lamp's fill is too pale to stand on its own,
 * so the needs-you mark is coloured by its edge and the fill sits inside it.
 */
const TONE: Record<MarkKind, string> = {
  "needs-you": "text-status-needs-you-edge",
  working: "text-status-working",
  idle: "text-status-idle",
  stale: "text-status-idle",
  unknown: "text-status-idle",
  answered: "text-status-idle",
  lookout: "text-status-idle",
  finished: "text-status-finished",
  failed: "text-status-finished",
  ended: "text-ink-muted",
};

interface StatusMarkProps {
  kind: MarkKind;
  /**
   * Announce the mark to assistive technology. Leave it off when the status is
   * written out in text right beside it.
   */
  labelled?: boolean;
  /**
   * The lamp's ring breathes. For the row of a session that is waiting now, and
   * nowhere else. It never runs under the reduced-motion preference.
   */
  breathing?: boolean;
  /**
   * The needs-you mark with its light out, in the ink colour: the shape stays, so
   * the Needs you tile keeps its mark, and no warm colour is on the screen.
   */
  unlit?: boolean;
  className?: string;
}

/**
 * The mark for a status. Every mark is one 14px circle with more or less light in
 * it, so the list still reads in greyscale:
 *
 *   needs you   a lit dot inside a ring (the lamp)
 *   working     a half-filled circle
 *   idle        an open ring
 *   stale       a broken ring
 *   unknown     an open ring with a short bar inside
 *   finished    a tick
 *   failed      a cross
 *   ended       a short dash, in muted ink: gone, with no word on how
 *   answered    a hollow dot inside a ring
 *   lookout     a hatched square, for Agent Lookout itself
 */
export function StatusMark({
  kind,
  labelled = false,
  breathing = false,
  unlit = false,
  className,
}: StatusMarkProps) {
  const needsYou = kind === "needs-you";
  const lit = needsYou && !unlit;

  return (
    <svg
      data-slot='status-mark'
      data-kind={kind}
      data-lit={needsYou ? lit : undefined}
      data-breathing={lit && breathing ? true : undefined}
      viewBox='0 0 14 14'
      fill='none'
      stroke='currentColor'
      className={cn("size-mark shrink-0", needsYou && unlit ? "text-ink" : TONE[kind], className)}
      {...(labelled ? { role: "img", "aria-label": MARK_LABEL[kind] } : { "aria-hidden": true })}
    >
      {(needsYou || kind === "answered") && (
        <>
          <circle
            data-part='halo'
            cx='7'
            cy='7'
            r='6'
            strokeWidth='1.2'
            strokeOpacity='0.5'
            // The animation is added only where motion is allowed, so under the
            // reduced-motion preference the lamp never starts.
            className={cn(lit && breathing && "motion-safe:animate-lamp")}
          />
          <circle
            data-part='lamp'
            cx='7'
            cy='7'
            r='3.1'
            strokeWidth={lit ? 1 : 1.3}
            className={cn(lit && "fill-status-needs-you")}
          />
        </>
      )}
      {kind === "working" && (
        <>
          <circle cx='7' cy='7' r='5' strokeWidth='1.5' />
          <path d='M7 2a5 5 0 0 1 0 10z' fill='currentColor' stroke='none' />
        </>
      )}
      {kind === "idle" && <circle cx='7' cy='7' r='5' strokeWidth='1.5' />}
      {kind === "stale" && (
        <circle cx='7' cy='7' r='5' strokeWidth='1.5' strokeDasharray='2.62 2.62' />
      )}
      {kind === "unknown" && (
        <>
          <circle cx='7' cy='7' r='5' strokeWidth='1.5' />
          <path d='M5 7h4' strokeWidth='1.5' strokeLinecap='round' />
        </>
      )}
      {kind === "finished" && (
        <path
          d='M2.6 7.5l2.9 2.9 5.9-6.4'
          strokeWidth='1.75'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      )}
      {kind === "failed" && (
        <path d='M3.8 3.8l6.4 6.4M10.2 3.8l-6.4 6.4' strokeWidth='1.75' strokeLinecap='round' />
      )}
      {/* The stroke of the tick and the cross, laid flat: an ending with nothing to say. */}
      {kind === "ended" && <path d='M3.5 7h7' strokeWidth='1.75' strokeLinecap='round' />}
      {kind === "lookout" && (
        <>
          <rect x='2.5' y='2.5' width='9' height='9' rx='1.5' strokeWidth='1.3' />
          <path d='M5 11.2l6.2-6.2M2.8 9l6.2-6.2' strokeWidth='1.1' />
        </>
      )}
    </svg>
  );
}
