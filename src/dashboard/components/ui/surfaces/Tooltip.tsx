import { Tooltip as TooltipPrimitive } from "radix-ui";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type RefObject,
} from "react";

import { Literal } from "@dashboard/components/ui/facts/Literal";
import { cn } from "@dashboard/lib/utils";

/** Long enough that a pointer crossing a row does not set off a trail of tooltips. */
const OPEN_DELAY_MS = 250;

/** A scroll this soon after keyboard focus is the page bringing the element into view. */
const FOCUS_SCROLL_MS = 250;

/**
 * True while a scroll event is being handled. Radix asks a tooltip to close from
 * its own scroll listener, and this is how that request is told from any other,
 * such as Escape. This listener is added when the module loads, before any
 * tooltip opens, so it runs before Radix's.
 */
let scrolling = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "scroll",
    () => {
      scrolling = true;
      setTimeout(() => {
        scrolling = false;
      });
    },
    { capture: true, passive: true },
  );
}

interface TooltipProps {
  /** What it says. With nothing to say, no tooltip opens. */
  content: ReactNode;
  /** The element it describes. It must take a ref and spread its props. */
  children: ReactNode;
  /** Set for a machine fact: a path, a time. A path then breaks only after a slash. */
  mono?: boolean;
  /** Set false to keep it closed, for text that is only sometimes cut. */
  enabled?: boolean;
  side?: ComponentProps<typeof TooltipPrimitive.Content>["side"];
  align?: ComponentProps<typeof TooltipPrimitive.Content>["align"];
}

/**
 * The one tooltip: floating glass, the densest tint, with real blur behind it, a
 * rim of light and the deepest shadow, on 10px corners. It floats over whatever
 * is under it, the lamp's light included, and its words keep their contrast.
 *
 * It opens on hover, and on keyboard focus when the element it describes can be
 * focused, so nothing in it is for mouse users only. It does not open when focus
 * is put back by the page, after a panel closes for example, because nobody
 * asked for it then.
 *
 * Radix closes a tooltip when the element it describes scrolls. Reaching an
 * element with Tab can make the page scroll it into view, and that scroll is not
 * the person leaving, so the tooltip stays open through it. Any later scroll
 * closes it as before.
 */
export function Tooltip({
  content,
  children,
  mono = false,
  enabled = true,
  side = "top",
  align = "center",
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  // When the keyboard reached the element, for as long as it keeps focus.
  const focusedAt = useRef(-Infinity);
  const show = enabled && content !== null && content !== undefined && content !== "";

  return (
    <TooltipPrimitive.Provider delayDuration={OPEN_DELAY_MS}>
      <TooltipPrimitive.Root
        open={open && show}
        onOpenChange={(next) => {
          const broughtIntoView =
            scrolling && performance.now() - focusedAt.current < FOCUS_SCROLL_MS;
          if (!next && broughtIntoView) return;
          setOpen(next);
        }}
      >
        <TooltipPrimitive.Trigger
          asChild
          onFocus={(event) => {
            if (!event.currentTarget.matches(":focus-visible")) {
              event.preventDefault();
              return;
            }
            focusedAt.current = performance.now();
          }}
          onBlur={() => {
            focusedAt.current = -Infinity;
          }}
        >
          {children}
        </TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-slot='tooltip'
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={12}
            className={cn(
              "glass-float glass-blur z-60 max-w-[min(26rem,calc(100vw-1.5rem))] animate-in rounded-row",
              "px-2.5 py-1.5 wrap-anywhere text-ink duration-120 fade-in-0",
              mono ? "font-mono text-fact" : "text-caption font-medium",
            )}
          >
            {mono && typeof content === "string" ? <Literal>{content}</Literal> : content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

/**
 * Whether the text is drawn short of what it says.
 *
 * One line never wraps, so only its width can cut it. The letters can still
 * reach past the line box, at the name size whose line is set tighter than the
 * letters, and that is no part of the text missing.
 *
 * Two lines are also cut when a third would follow. A hidden line adds a whole
 * line's height to the scroll height, while letters reaching past a tight line
 * add a few pixels, so anything under half a line is the letters.
 */
function isCut(element: HTMLElement, lines: 1 | 2): boolean {
  if (element.scrollWidth > element.clientWidth) return true;
  if (lines === 1) return false;
  const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
  const reach = Number.isFinite(lineHeight) ? lineHeight / 2 : 1;
  return element.scrollHeight - element.clientHeight > reach;
}

interface TruncatedProps extends Omit<ComponentProps<"span">, "children"> {
  /** The full text. It is always in the page; only its drawing is cut. */
  children: ReactNode;
  /** How many lines it may take before it is cut. */
  lines?: 1 | 2;
  /** What the tooltip says. Defaults to the text itself. */
  tooltip?: string;
  /** Set when the tooltip is a machine fact. */
  mono?: boolean;
  /**
   * Makes the text a link to this address, as a session's name is a link to its
   * details. A link is always a stop on the way through the page.
   */
  href?: string;
  /** With `href`, `_blank` opens a link that leaves the page in a tab of its own. */
  target?: "_blank";
}

/**
 * Text that is cut with an ellipsis when it does not fit, and stays reachable in
 * full. While it is cut it has a tooltip with the whole text and can be reached
 * with Tab, so the rest is not for mouse users only. While it fits it is plain
 * text: no tooltip, and no stop on the way through the page.
 *
 * With `href` it is a link, cut the same way, whose tooltip opens on the link.
 */
export function Truncated({
  children,
  lines = 1,
  tooltip,
  mono = false,
  href,
  target,
  className,
  ...props
}: TruncatedProps) {
  const ref = useRef<HTMLElement>(null);
  const [cut, setCut] = useState(false);
  const full = tooltip ?? (typeof children === "string" ? children : "");

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Fires once when it starts watching, and again whenever the box changes size.
    const observer = new ResizeObserver(() => setCut(isCut(element, lines)));
    observer.observe(element);
    return () => observer.disconnect();
    // New text in a box of the same size can be cut where the old text was not.
  }, [full, lines]);

  const look = cn(lines === 1 ? "truncate" : "line-clamp-2", "rounded-bar", className);
  return (
    <Tooltip content={full} enabled={cut} mono={mono}>
      {href !== undefined ? (
        <a
          ref={ref as RefObject<HTMLAnchorElement | null>}
          href={href}
          target={target}
          data-cut={cut}
          className={look}
          {...(props as ComponentProps<"a">)}
        >
          {children}
        </a>
      ) : (
        <span ref={ref} data-cut={cut} tabIndex={cut ? 0 : undefined} className={look} {...props}>
          {children}
        </span>
      )}
    </Tooltip>
  );
}
