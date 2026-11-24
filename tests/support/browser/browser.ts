// Pointer and keyboard helpers for component tests, which share one browser page.

import { cdp, userEvent } from "vitest/browser";

/**
 * Moves the pointer off everything, to the top-left corner of the page, the way
 * a hand does: in more than one step. A tooltip that can itself be pointed at
 * only closes once it sees the pointer moving somewhere else.
 */
export async function pointAway(): Promise<void> {
  await userEvent.hover(document.body, { position: { x: 4, y: 4 } });
  await userEvent.hover(document.body, { position: { x: 1, y: 1 } });
}

/**
 * Puts the keyboard at the top of the page, so the next Tab reaches the first
 * control. Tests share one page: a Tab past the last control in one test leaves
 * the page, and the next test would start from wherever that left it.
 */
export function startAtTop(): void {
  const marker = document.createElement("span");
  marker.tabIndex = -1;
  document.body.prepend(marker);
  marker.focus();
  marker.remove();
}

/**
 * Presses a control the way Chromium does when VoiceOver, Voice Control or
 * Switch Control presses it: focus first, if it has none, and then the pointer
 * and mouse events and the click, all at once.
 */
export function assistivePress(control: HTMLElement): void {
  control.focus();
  control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, isPrimary: true }));
  control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  control.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, isPrimary: true }));
  control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  control.click();
}

/**
 * Ends the run of presses the last one could be of, as a page drawn afresh
 * would: with a touch that became a scroll, and a key that presses nothing.
 */
export function forgetPresses(): void {
  document.dispatchEvent(new PointerEvent("pointercancel"));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
}

/** Presses the pointer at a point of the window, whatever is there, so many times, about a fifth of a second apart. */
export async function pressAt(x: number, y: number, times = 1): Promise<void> {
  const body = document.body.getBoundingClientRect();
  await userEvent.click(document.body, {
    position: { x: x - body.left, y: y - body.top },
    force: true,
    clickCount: times,
    delay: 100,
  });
}

/** Taps a finger at a point of the window, as `pressAt` presses the pointer. */
export async function tapAt(x: number, y: number, times = 1): Promise<void> {
  // The page under test is in a frame of the one the browser is told of.
  const frame = window.frameElement?.getBoundingClientRect();
  const scale = frame ? frame.width / window.innerWidth : 1;
  const point = { x: (frame?.left ?? 0) + x * scale, y: (frame?.top ?? 0) + y * scale };
  const touch = (type: string, touchPoints: object[]) =>
    (cdp() as { send?: (method: string, params: object) => Promise<unknown> }).send?.(
      "Input.dispatchTouchEvent",
      { type, touchPoints },
    );
  for (let tap = 0; tap < times; tap += 1) {
    if (tap > 0) await new Promise((resolve) => setTimeout(resolve, 150));
    await touch("touchStart", [point]);
    await touch("touchEnd", []);
  }
}

/** The middle of an element, as a point of the window. */
export function middleOf(element: Element): [x: number, y: number] {
  const { left, top, width, height } = element.getBoundingClientRect();
  return [left + width / 2, top + height / 2];
}

/** Holds a key down, as long as it takes a keyboard to repeat it so many times. */
export async function holdKey(key: string, repeats: number): Promise<void> {
  for (let press = 0; press <= repeats; press += 1) await userEvent.keyboard(`{${key}>}`);
  await userEvent.keyboard(`{/${key}}`);
}
