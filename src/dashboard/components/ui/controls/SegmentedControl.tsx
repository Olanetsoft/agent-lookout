import { RadioGroup } from "radix-ui";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

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

/** The keys Radix's roving focus moves between options in a row on, with no modifier held. */
const MOVING_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

const movesFocus = (event: KeyboardEvent) =>
  MOVING_KEYS.has(event.key) &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey;

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
 * An option is chosen when it is pressed, or when an arrow key, Home, End,
 * Page Up or Page Down moves focus to it: Radix chooses on an arrow key only while the key is still
 * held when focus lands, which a quick or synthesised key press is not. Focus
 * that arrives any other way, as a screen reader's cursor can carry it, chooses
 * nothing. One press chooses once, even before the parent has taken the value,
 * so a switch that waits for the app's answer sends its change once. A later
 * press asks again.
 */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  label,
  className,
}: SegmentedControlProps<T>) {
  const chosen = options.findIndex((option) => option.value === value);
  // An arrow key still held when focus lands reaches an option twice: through
  // focus, and through the click Radix makes then, which decides from the value
  // the parent has taken so far. What this press has already asked for keeps
  // the second from asking again. It is forgotten when the next press starts,
  // when focus leaves and when the value changes.
  const askedThisPress = useRef<T | null>(null);
  useEffect(() => {
    askedThisPress.current = null;
  }, [value]);
  const choose = (next: T) => {
    if (next === value || next === askedThisPress.current) return;
    askedThisPress.current = next;
    onValueChange(next);
  };
  // Never prevent the default here: Radix's roving focus skips its own
  // handlers for an event that is, and the arrow keys would stop moving.
  const forget = () => {
    askedThisPress.current = null;
  };
  // The key that is moving focus between the options, if one is. Radix moves
  // focus in a task it sets up as the key goes down, so the key is noted before
  // Radix sees it and forgotten in a task set up after Radix's, once focus has
  // landed. A press of any other kind chooses through the click alone.
  const movingKey = useRef<Event | null>(null);
  const noteKey = (event: KeyboardEvent) => {
    if (movesFocus(event)) movingKey.current = event.nativeEvent;
  };
  const forgetKey = (event: KeyboardEvent) => {
    forget();
    const key = event.nativeEvent;
    setTimeout(() => {
      if (movingKey.current === key) movingKey.current = null;
    });
  };
  return (
    <RadioGroup.Root
      data-slot='segmented-control'
      aria-label={label}
      orientation='horizontal'
      value={value}
      onValueChange={(next) => choose(next as T)}
      onPointerDown={forget}
      onMouseDown={forget}
      onKeyDownCapture={noteKey}
      onKeyDown={forgetKey}
      onBlur={forget}
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
            if (movingKey.current !== null) choose(option.value);
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
