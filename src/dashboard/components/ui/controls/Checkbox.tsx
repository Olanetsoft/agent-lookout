import { Check } from "lucide-react";
import { Checkbox as RadixCheckbox } from "radix-ui";

import { cn } from "@dashboard/lib/utils";

interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** What is ticked, for assistive technology, when no label beside it names it. */
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A tick box, for choosing some of a list: a 16px square of quiet fill inside
 * the control rim, with the control's top light. Ticked, its fill comes up and
 * a tick in the ink sits in it. Nothing about it is warm. A Radix checkbox, so
 * Space ticks it and it is read as one.
 *
 * It answers to a press 4px past its edge on every side, an area of 24px
 * square, so a finger on a phone finds it. That area draws nothing.
 */
export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...rest
}: CheckboxProps) {
  return (
    <RadixCheckbox.Root
      data-slot='checkbox'
      checked={checked}
      onCheckedChange={(next) => onCheckedChange(next === true)}
      disabled={disabled}
      className={cn(
        "relative inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-bar",
        "after:absolute after:-inset-1",
        "bg-fill-quiet text-ink inset-ring inset-ring-control-rim inset-shadow-top",
        "transition-colors duration-120 hover:bg-fill-selected data-[state=checked]:bg-fill-selected",
        "disabled:cursor-default disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      <RadixCheckbox.Indicator>
        <Check aria-hidden className='size-3' strokeWidth={2.5} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}
