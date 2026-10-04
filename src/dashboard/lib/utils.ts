import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * The names `src/dashboard/styles/index.css` adds to Tailwind. tailwind-merge has
 * to be told about them. It reads a name it does not know as a colour, so without
 * this `text-row` would be dropped when `text-ink` follows it, and `rounded-panel`
 * would not give way to a later `rounded-inner`.
 */

/** The type scale. */
const TEXT_SIZES = [
  "wait",
  "name",
  "stat",
  "unit",
  "wordmark",
  "lead",
  "title",
  "row",
  "body",
  "fact",
  "caption",
  "micro",
];

/** The named sizes of the layout: `w-rail`, `h-row`, `size-mark`. */
const SIZES = [
  "window",
  "rail",
  "header",
  "row",
  "group",
  "log-row",
  "control",
  "button",
  "button-hero",
  "mark",
  "icon",
  "track",
  "label-col",
  "bar-needs-you",
  "bar-working",
  "bar-idle",
  "waited-name",
];

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: TEXT_SIZES,
      spacing: SIZES,
      leading: ["tight", "body"],
      radius: ["panel", "chrome", "inner", "row", "capsule", "tube", "bar"],
      shadow: ["thumb", "glow", "edge"],
      "inset-shadow": ["top", "well", "lit"],
      ease: ["out"],
      animate: ["lamp", "spin-loader", "rise-fast", "fade-in", "fade-out", "drop"],
    },
  },
});

/** Joins class names and lets a later Tailwind class override an earlier one. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
