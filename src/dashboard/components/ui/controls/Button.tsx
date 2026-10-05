import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@dashboard/lib/utils";

const button = cva(
  [
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap",
    "rounded-capsule text-body font-medium",
    "transition-[background-color,color,filter] duration-120",
    "disabled:pointer-events-none disabled:opacity-50",
  ],
  {
    variants: {
      /**
       * quiet      a capsule of quiet fill inside a control rim, with a light
       *            along its top and grey words. Every button but one. Under the
       *            pointer or the keyboard its fill and its words come up.
       * needs-you  the lamp's fill inside its edge, with a top light, the lamp's
       *            glow under it and dark words. Only the Jump button of a
       *            session that needs the person now, in the hero, so it is the
       *            one solid button on the screen when it is there, and absent
       *            otherwise.
       */
      variant: {
        quiet: [
          "bg-fill-quiet text-ink-secondary inset-ring inset-ring-control-rim inset-shadow-top",
          "hover:bg-fill-selected hover:text-ink",
          "focus-visible:bg-fill-selected focus-visible:text-ink",
        ],
        "needs-you": [
          "bg-status-needs-you font-semibold text-on-needs-you",
          "inset-ring inset-ring-status-needs-you-edge inset-shadow-lit shadow-glow",
          "hover:brightness-105 active:brightness-97",
        ],
      },
      size: {
        /** 28px tall and at least 64px wide, so a column of them lines up. */
        sm: "h-button min-w-16 px-4",
        /** 38px tall, for the hero. */
        hero: "h-button-hero px-6.5 text-row",
        /** A 28px circle, for a button that is only an icon. */
        icon: "size-button",
      },
    },
    defaultVariants: {
      variant: "quiet",
      size: "sm",
    },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof button> & {
    /** Render the child element, a link for example, with the button's look. */
    asChild?: boolean;
  };

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot='button'
      data-variant={variant ?? "quiet"}
      {...(asChild ? {} : { type: "button" as const })}
      className={cn(button({ variant, size }), className)}
      {...props}
    />
  );
}
