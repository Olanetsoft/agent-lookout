import { cn } from "@dashboard/lib/utils";

interface LookoutMarkProps {
  /**
   * Whether a session needs the person now. Lit, the lamp above the horizon is
   * amber with a glint on the water below it. Unlit, it is a hollow ring in the
   * current colour, and the mark holds no warm colour at all.
   */
  lit?: boolean;
  className?: string;
}

/**
 * The mark: a round lens with a horizon across it, the lower half faintly
 * filled, and a lamp above the horizon. It is drawn in the current text colour,
 * and only the lamp has a colour of its own, the one that means "needs you", so
 * the mark doubles as a status light that can be read from every view.
 */
export function LookoutMark({ lit = false, className }: LookoutMarkProps) {
  return (
    <svg
      data-slot='lookout-mark'
      data-lit={lit}
      viewBox='0 0 32 32'
      aria-hidden
      fill='none'
      className={cn("size-7.5 shrink-0", className)}
    >
      <path d='M3.63 20a13 13 0 0 0 24.74 0z' fill='currentColor' opacity='0.13' />
      <circle cx='16' cy='16' r='13' stroke='currentColor' strokeWidth='1.75' />
      <path d='M3.63 20h24.74' stroke='currentColor' strokeWidth='1.75' />
      {lit ? (
        <>
          <circle
            data-part='lamp'
            cx='20.6'
            cy='15.1'
            r='2.7'
            strokeWidth='1'
            className='fill-status-needs-you stroke-status-needs-you-edge'
          />
          <path
            data-part='glint'
            d='M18.9 23.6h3.4'
            strokeWidth='1.5'
            strokeLinecap='round'
            className='stroke-status-needs-you-edge'
          />
        </>
      ) : (
        <circle
          data-part='lamp'
          cx='20.6'
          cy='15.1'
          r='2.7'
          stroke='currentColor'
          strokeWidth='1.4'
        />
      )}
    </svg>
  );
}
