import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "@dashboard/lib/utils";

/** A word that classifies a row, such as "Process ended". */
const badge = cva(
  "inline-flex h-5 shrink-0 items-center rounded-capsule px-2 text-caption font-medium whitespace-nowrap",
  {
    variants: {
      /**
       * neutral  a fact about the row: a capsule of quiet fill inside the control rim
       * outline  a caution about the row: the strong rule alone, with no fill
       */
      tone: {
        neutral: "bg-fill-quiet text-ink-secondary inset-ring inset-ring-control-rim",
        outline: "text-ink-secondary inset-ring inset-ring-rule-strong",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badge>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return (
    <span
      data-slot='badge'
      data-tone={tone ?? "neutral"}
      className={cn(badge({ tone }), className)}
      {...props}
    />
  );
}
