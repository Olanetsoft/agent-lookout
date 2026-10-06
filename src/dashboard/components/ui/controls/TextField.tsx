import type { ComponentProps } from "react";

import { cn } from "@dashboard/lib/utils";

/**
 * A short field to type a value in, such as a number of minutes or a time: a
 * capsule well recessed into the glass, as the segmented control's is, as
 * tall as one of its options, with the words in ink at `text-body` and
 * tabular numerals, so a number keeps its width as it changes. The width is
 * the caller's, for what the field holds. Nothing about it is warm.
 *
 * It is a plain text input, so the browser draws none of its own controls in
 * it, and the caller reads what was typed when the person leaves the field or
 * presses Enter. `aria-invalid` gives it a stronger rim while what it holds
 * cannot be taken.
 */
export function TextField({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot='text-field'
      type='text'
      autoComplete='off'
      autoCorrect='off'
      autoCapitalize='off'
      spellCheck={false}
      className={cn(
        "h-control min-w-0 rounded-capsule bg-well px-3 text-center text-body text-ink tabular-nums",
        "inset-ring inset-ring-control-rim inset-shadow-well",
        "placeholder:text-ink-muted aria-invalid:inset-ring-rule-strong",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
