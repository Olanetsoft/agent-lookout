import type { DurationPart } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";

interface DurationFigureProps {
  parts: readonly DurationPart[];
  className?: string;
}

/**
 * A duration at figure size: the numbers in the sans at whatever size the figure
 * is set, with tabular numerals so it keeps its width as it ticks, and the unit
 * letters at the unit size in the secondary ink beside them. So `2m 07s` reads
 * as one figure, and the numbers lead.
 */
export function DurationFigure({ parts, className }: DurationFigureProps) {
  return (
    <span
      data-slot='duration-figure'
      className={cn("inline-flex items-baseline gap-1.5 tabular-nums", className)}
    >
      {parts.map((part) => (
        <span key={part.unit} className='inline-flex items-baseline'>
          {part.value}
          <span data-part='unit' className='ml-0.5 text-unit font-medium text-ink-secondary'>
            {part.unit}
          </span>
        </span>
      ))}
    </span>
  );
}
