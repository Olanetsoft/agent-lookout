import { cn } from "@dashboard/lib/utils";

/*
 * The drawn icons of the dashboard: one for each view in the rail, at 20px; the
 * moon and the sun of the theme switch, at 14px; and the small signs of the
 * controls and notes: the tick of a checkbox at 12px, the close mark and the
 * magnifier at 16px, the four arrows and the ⌘ of the keys at 14px, two of the
 * arrows also moving a rule, and the circled i of a note and circled ! of an
 * error at 18px. Each is drawn on a grid as wide as it is shown, so its line is
 * the width written on it: 1.5px for all but the moon and the sun, which are
 * 1.4px. The arrows, and the stems of the i and the !, sit a quarter of a pixel
 * off the middle of their grid, so that on a 2x screen the edges of their
 * straight line fall on whole pixels when the icon does. Each is a line in the
 * current colour, with no fill, so it takes the colour of the words beside it.
 * Whatever holds one carries its name, so each is hidden from assistive
 * technology.
 */

export interface IconProps {
  className?: string;
  /** A data attribute goes on to the drawing: the shortcuts sheet marks each key's sign with the character it stands for. */
  [data: `data-${string}`]: string | undefined;
}

/** A wide panel over a tall one and a narrow one: the Overview. */
export function OverviewIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 20 20'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinejoin='round'
      className={cn("size-icon shrink-0", className)}
    >
      <rect x='2.75' y='3.25' width='14.5' height='4' rx='1' />
      <rect x='2.75' y='10.25' width='8.5' height='6.5' rx='1' />
      <rect x='14.25' y='10.25' width='3' height='6.5' rx='1' />
    </svg>
  );
}

/** Three lines gathered into one point: where the sessions come from. */
export function SourcesIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 20 20'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn("size-icon shrink-0", className)}
    >
      <path d='M2.75 4.5h4l3.4 4.2M2.75 10h7.5M2.75 15.5h4l3.4-4.2' />
      <circle cx='13.75' cy='10' r='3.25' />
    </svg>
  );
}

/** Two sliders: the Settings. */
export function SettingsIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 20 20'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      className={cn("size-icon shrink-0", className)}
    >
      <path d='M2.75 6.25h7M14.75 6.25h2.5M2.75 13.75h2.5M10.25 13.75h7' />
      <circle cx='12.25' cy='6.25' r='2.25' />
      <circle cx='7.75' cy='13.75' r='2.25' />
    </svg>
  );
}

/** A crescent: the night theme. */
export function MoonIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.4'
      strokeLinejoin='round'
      className={cn("size-mark shrink-0", className)}
    >
      <path d='M11.9 8.4A5.2 5.2 0 0 1 5.6 2.1a5.2 5.2 0 1 0 6.3 6.3z' />
    </svg>
  );
}

/** A disc with eight short rays: the day theme. */
export function SunIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.4'
      strokeLinecap='round'
      className={cn("size-mark shrink-0", className)}
    >
      <circle cx='7' cy='7' r='2.6' />
      <path d='M7 1v1.4M7 11.6V13M1 7h1.4M11.6 7H13M2.8 2.8l1 1M10.2 10.2l1 1M2.8 11.2l1-1M10.2 3.8l1-1' />
    </svg>
  );
}

/** A tick, its short stroke at 45 degrees and its long one rising to the right: a ticked box. */
export function CheckIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 12 12'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn("size-3 shrink-0", className)}
    >
      <path d='M2.5 6.25 4.75 8.5 9.5 3.5' />
    </svg>
  );
}

/** Two strokes crossed at right angles: the close mark. */
export function CloseIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 16 16'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      className={cn("size-4 shrink-0", className)}
    >
      <path d='M4.25 4.25l7.5 7.5M11.75 4.25l-7.5 7.5' />
    </svg>
  );
}

/** A lens with a short handle to the lower right: the magnifier of the search. */
export function SearchIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 16 16'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      className={cn("size-4 shrink-0", className)}
    >
      <circle cx='7' cy='7' r='4.75' />
      <path d='M10.5 10.5l3.25 3.25' />
    </svg>
  );
}

/** A circle with an i in it: a note. */
export function InfoIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 18 18'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      className={cn("size-4.5 shrink-0", className)}
    >
      <circle cx='9' cy='9' r='7.25' />
      <path d='M9.25 8.75v3.5M9.25 5.75h.01' />
    </svg>
  );
}

/** A circle with an exclamation mark in it: an error. */
export function AlertIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 18 18'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      className={cn("size-4.5 shrink-0", className)}
    >
      <circle cx='9' cy='9' r='7.25' />
      <path d='M9.25 5.75v3.5M9.25 12.25h.01' />
    </svg>
  );
}

/** An arrow pointing up: the up arrow key, and moving a rule up. */
export function ArrowUpIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d='M7.25 11.25v-8.5M3.5 6.5l3.75-3.75L11 6.5' />
    </svg>
  );
}

/** An arrow pointing down: the down arrow key, and moving a rule down. */
export function ArrowDownIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d='M7.25 2.75v8.5M3.5 7.5l3.75 3.75L11 7.5' />
    </svg>
  );
}

/** An arrow pointing left: the left arrow key. */
export function ArrowLeftIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d='M11.25 6.75h-8.5M6.5 3 2.75 6.75 6.5 10.5' />
    </svg>
  );
}

/** An arrow pointing right: the right arrow key. */
export function ArrowRightIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      strokeLinecap='round'
      strokeLinejoin='round'
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d='M2.75 6.75h8.5M7.5 3l3.75 3.75L7.5 10.5' />
    </svg>
  );
}

/** A square with a loop at each corner, drawn as one line: the ⌘ of the Command key. */
export function CommandIcon({ className, ...data }: IconProps) {
  return (
    <svg
      {...data}
      data-slot='icon'
      viewBox='0 0 14 14'
      aria-hidden
      fill='none'
      stroke='currentColor'
      strokeWidth='1.5'
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d='M8.75 3.25v7.5a2 2 0 1 0 2-2h-7.5a2 2 0 1 0 2 2v-7.5a2 2 0 1 0-2 2h7.5a2 2 0 1 0-2-2z' />
    </svg>
  );
}
