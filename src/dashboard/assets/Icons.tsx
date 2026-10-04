import { cn } from "@dashboard/lib/utils";

/*
 * The drawn icons of the frame: one for each view in the rail, at 20px, and the
 * moon and the sun of the theme switch, at 14px. Each is a 1.5px line in the
 * current colour, with no fill, so it takes the colour of the words beside it.
 * The rail and the switch always set a label beside them, so each is hidden from
 * assistive technology.
 */

interface IconProps {
  className?: string;
}

/** A wide panel over a tall one and a narrow one: the Overview. */
export function OverviewIcon({ className }: IconProps) {
  return (
    <svg
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
export function SourcesIcon({ className }: IconProps) {
  return (
    <svg
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
export function SettingsIcon({ className }: IconProps) {
  return (
    <svg
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
export function MoonIcon({ className }: IconProps) {
  return (
    <svg
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
export function SunIcon({ className }: IconProps) {
  return (
    <svg
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
