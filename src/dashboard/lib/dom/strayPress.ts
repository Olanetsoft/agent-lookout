import { ANSWER_SETTLE_MS } from "@core/answers/settle";

/** How far from a press the next can land and still be meant for the same place: about a fingertip. */
const NEAR_PX = 20;

/**
 * Presses one after another, each less than a second after the one before: what
 * the first was on, and when the last was.
 */
interface Run {
  on: Element | null;
  at: number;
}

/** A run of the pointer's, where its first press was. */
let pointed: (Run & { x: number; y: number }) | null = null;
/** A run of Enter or Space, held or pressed again, with no other key between. */
let keyed: Run | null = null;

/** The control an event is on, or else whatever it is on. */
function controlOf(event: Event): Element | null {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest("button, a") ?? target;
}

function soonAfter(run: Run | null, event: Event): run is Run {
  return run !== null && event.timeStamp - run.at < ANSWER_SETTLE_MS;
}

/** The run a press of the pointer is of, or null when it is a first one. */
function pointedRun(event: MouseEvent): typeof pointed {
  return pointed !== null &&
    soonAfter(pointed, event) &&
    Math.hypot(event.clientX - pointed.x, event.clientY - pointed.y) <= NEAR_PX
    ? pointed
    : null;
}

document.addEventListener(
  "pointerdown",
  (event) => {
    const { clientX: x, clientY: y, timeStamp: at } = event;
    pointed = { ...(pointedRun(event) ?? { on: controlOf(event), x, y }), at };
  },
  true,
);
// A touch that became a scroll was no press.
document.addEventListener("pointercancel", () => (pointed = null), true);
document.addEventListener(
  "keydown",
  (event) => {
    if (event.key !== "Enter" && event.key !== " ") keyed = null;
    else keyed = { on: soonAfter(keyed, event) ? keyed.on : controlOf(event), at: event.timeStamp };
  },
  true,
);

/**
 * Whether a click on a control is the rest of a press meant for another: the
 * second half of a double click or a double tap, where this control has come
 * to the place the first half was on, or a key held, or pressed again, where
 * the first press moved focus to this control. A press on a control that was
 * there all along is never one, and nor is one made by assistive technology or
 * by the page itself, which come with neither the pointer nor a key.
 */
export function isStrayPress(event: MouseEvent, control: Element): boolean {
  if (!event.isTrusted) return false;
  // A key's click comes with no count. One of Enter in a form's field is on no focused control.
  const run =
    event.detail > 0
      ? pointedRun(event)
      : control === document.activeElement && soonAfter(keyed, event)
        ? keyed
        : null;
  return run !== null && run.on !== control;
}
