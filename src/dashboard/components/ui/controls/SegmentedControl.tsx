import { RadioGroup } from "radix-ui";
import type { ReactNode } from "react";

import { cn } from "@dashboard/lib/utils";

interface SegmentedOption<T extends string> {
  value: T;
  /** The word on the option. */
  label: string;
  /**
   * What assistive technology calls the option, when the word on it is not
   * enough on its own: the theme switch shows "Night" and says "Dark theme".
   */
  name?: string;
  icon?: ReactNode;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** What is being chosen, for assistive technology. */
  label: string;
  className?: string;
}

/**
 * A choice between a few options: a capsule well recessed into the glass, with
 * a raised thumb that slides under the chosen option. The chosen option's words
 * come up to full ink.
 *
 * The thumb is drawn once, under the options, and moved by transform. Under the
 * reduced-motion preference it moves without travelling.
 *
 * It is a radio group and behaves like one: Tab reaches the chosen option, and
 * the arrow keys move to the next option and choose it in the same step. One
 * option is always chosen.
 *
 * Radix chooses on an arrow key only while the key is still held when focus
 * lands, which a quick or synthesised key press is not. So an option is also
 * chosen when focus reaches it, however it got there.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: SegmentedControlProps<T>) {
  const chosen = options.findIndex((option) => option.value === value);
  return (
    <RadioGroup.Root
      data-slot='segmented-control'
      aria-label={label}
      orientation='horizontal'
      value={value}
      onValueChange={(next) => onValueChange(next as T)}
      className={cn(
        "relative inline-grid rounded-capsule bg-well p-0.75",
        "inset-ring inset-ring-control-rim inset-shadow-well",
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {chosen !== -1 && (
        <span
          aria-hidden
          data-part='thumb'
          className={cn(
            "pointer-events-none absolute inset-y-0.75 left-0.75 rounded-capsule bg-thumb",
            "inset-ring inset-ring-control-rim inset-shadow-top shadow-thumb",
            "motion-safe:transition-transform motion-safe:duration-220 motion-safe:ease-out",
          )}
          style={{
            width: `calc((100% - 6px) / ${options.length})`,
            transform: `translateX(${chosen * 100}%)`,
          }}
        />
      )}
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          aria-label={option.name}
          onFocus={() => {
            if (option.value !== value) onValueChange(option.value);
          }}
          className={cn(
            "relative flex h-control cursor-pointer items-center justify-center gap-2 rounded-capsule px-4",
            "text-body font-medium whitespace-nowrap text-ink-secondary transition-colors duration-120",
            "hover:text-ink data-[state=checked]:text-ink",
            option.icon !== undefined && "pl-3",
          )}
        >
          {option.icon}
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
