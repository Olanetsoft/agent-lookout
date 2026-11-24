import { ANSWER_SETTLE_MS } from "@core/answers/settle";

/** How far from a press the next can land and still be meant for the same place: about a fingertip. */
const NEAR_PX = 20;

/** A press, and when the rest of it last came: presses soon after it that were meant for what it was on. */
interface Press {
  /** The control it was on, or else whatever it was on. */
  on: Element | null;
  at: number;
  restAt: number;
}

/** The pointer's last press that was not the rest of another, and where that was. */
let pointed: (Press & { x: number; y: number }) | null = null;
/** The same of Enter and Space, with no other key since. */
let keyed: Press | null = null;

/** The control an element is, or is in, or else the element. */
function controlOf(target: EventTarget | null): Element | null {
  return target instanceof Element ? (target.closest("button, a") ?? target) : null;
}

function soonAfter(at: number, event: Event): boolean {
  return event.timeStamp - at < ANSWER_SETTLE_MS;
}

/** A press that is not the rest of another. */
function first(on: Element | null, event: Event): Press {
  return { on, at: event.timeStamp, restAt: -Infinity };
}

// A press is the rest of one less than a second before it, and near it, when it
// is on something else and what that one was on is no longer where it was.
document.addEventListener(
  "pointerdown",
  (event) => {
    const { clientX: x, clientY: y } = event;
    const on = controlOf(event.target);
    if (
      pointed !== null &&
      on !== pointed.on &&
      soonAfter(pointed.at, event) &&
      Math.hypot(x - pointed.x, y - pointed.y) <= NEAR_PX &&
      controlOf(document.elementFromPoint(pointed.x, pointed.y)) !== pointed.on
    ) {
      pointed.restAt = event.timeStamp;
    } else {
      pointed = { ...first(on, event), x, y };
    }
  },
  true,
);
// What was pressed goes with the page as the person scrolls it.
document.addEventListener(
  "wheel",
  ({ deltaX, deltaY }) => {
    if (pointed === null) return;
    pointed.x -= deltaX;
    pointed.y -= deltaY;
  },
  { capture: true, passive: true },
);
// A touch that became a scroll was no press.
document.addEventListener("pointercancel", () => (pointed = null), true);
// A key that repeats is still down, however long a keyboard waits before it
// repeats one, so it is the rest of the press that moved focus.
document.addEventListener(
  "keydown",
  (event) => {
    const on = controlOf(event.target);
    if (event.key !== "Enter" && event.key !== " ") keyed = null;
    else if (keyed !== null && on !== keyed.on && (event.repeat || soonAfter(keyed.at, event)))
      keyed.restAt = event.timeStamp;
    else keyed = first(on, event);
  },
  true,
);

/**
 * Whether a click on a control is the rest of a press meant for another: the
 * second half of a double click or a double tap, where this control has come
 * to the place the first half was on, or a key held, or pressed again, where
 * the first press moved focus to this control. A press a second after that
 * first one is taken. One that is beside what the first was on, with that still
 * in its place, is never the rest of it, and nor is one made by assistive
 * technology or by the page itself, which come with neither the pointer nor a
 * key.
 */
export function isStrayPress(event: MouseEvent, control: Element): boolean {
  if (!event.isTrusted) return false;
  // A key's click comes with no count. One of Enter in a form's field is on no focused control.
  const press = event.detail > 0 ? pointed : control === document.activeElement ? keyed : null;
  return press !== null && soonAfter(press.restAt, event);
}
