import { ANSWER_SETTLE_MS } from "@core/answers/settle";

/** How far from a press the next can land and still be meant for the same place: about a fingertip. */
const NEAR_PX = 20;

/** A press, and when the rest of it last came: presses soon after it that were meant for what it was on. */
interface Press {
  /** The control it was on, or else whatever it was on. */
  on: Element | null;
  at: number;
  restAt: number;
  /** Whether the newest press is the rest of it. */
  rest: boolean;
}

/** How far across and down an element was scrolled. */
type Scrolled = [holder: Element, left: number, top: number];

interface Pointed extends Press {
  x: number;
  y: number;
  /** What holds it, as it was scrolled then, and whether a wheel has turned since. */
  scrolled: Scrolled[];
  wheeled: boolean;
}

/** The pointer's last press that was not the rest of another, and where that was. */
let pointed: Pointed | null = null;
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
  return { on, at: event.timeStamp, restAt: -Infinity, rest: false };
}

function restOf(press: Press, event: Event): void {
  press.restAt = event.timeStamp;
  press.rest = true;
}

/** What holds an element, and how far each is scrolled. */
function scrolledOf(on: Element | null): Scrolled[] {
  const holders: Scrolled[] = [];
  for (let at = on; at; at = at.parentElement) holders.push([at, at.scrollLeft, at.scrollTop]);
  return holders;
}

/** Where a press was, gone with the page as far as the person has scrolled that since. */
function placeNow({ x, y, scrolled, wheeled }: Pointed): [x: number, y: number] {
  // What was not scrolled by a wheel came there itself, as when the page gets shorter.
  if (!wheeled) return [x, y];
  for (const [holder, left, top] of scrolled) {
    x -= holder.scrollLeft - left;
    y -= holder.scrollTop - top;
  }
  return [x, y];
}

// A press is the rest of one less than a second before it, and near it, when it
// is on something else and what that one was on is no longer where it was.
document.addEventListener(
  "pointerdown",
  (event) => {
    const { clientX: x, clientY: y } = event;
    const on = controlOf(event.target);
    const [wasX, wasY] = pointed ? placeNow(pointed) : [x, y];
    if (
      pointed !== null &&
      on !== pointed.on &&
      soonAfter(pointed.at, event) &&
      Math.hypot(x - wasX, y - wasY) <= NEAR_PX &&
      controlOf(document.elementFromPoint(wasX, wasY)) !== pointed.on
    ) {
      restOf(pointed, event);
    } else {
      pointed = { ...first(on, event), x, y, scrolled: scrolledOf(on), wheeled: false };
    }
  },
  true,
);
document.addEventListener("wheel", () => pointed && (pointed.wheeled = true), {
  capture: true,
  passive: true,
});
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
      restOf(keyed, event);
    else keyed = first(on, event);
  },
  true,
);
// Held, it is the same press as it is let go, which is when the click comes.
document.addEventListener("pointerup", (event) => pointed?.rest && restOf(pointed, event), true);
document.addEventListener("keyup", (event) => keyed?.rest && restOf(keyed, event), true);

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
