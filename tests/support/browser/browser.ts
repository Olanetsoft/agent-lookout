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

/** Sends the browser an event of its own making, as a hand or a keyboard would. */
async function send(method: string, params: object): Promise<void> {
  await (cdp() as { send?: (method: string, params: object) => Promise<unknown> }).send?.(
    method,
    params,
  );
}

/** A point of the window, as a point of the browser's page: the page under test is in a frame of it. */
function inBrowser(x: number, y: number): { x: number; y: number } {
  const frame = window.frameElement?.getBoundingClientRect();
  const scale = frame ? frame.width / window.innerWidth : 1;
  return { x: (frame?.left ?? 0) + x * scale, y: (frame?.top ?? 0) + y * scale };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Presses the pointer at a point of the window, whatever is there, so many
 * times, about a fifth of a second apart. It scrolls nothing to get there.
 */
export async function pressAt(x: number, y: number, times = 1, heldMs = 100): Promise<void> {
  const mouse = (type: string, more: object = {}) =>
    send("Input.dispatchMouseEvent", { type, ...inBrowser(x, y), ...more });
  await mouse("mouseMoved");
  for (let clickCount = 1; clickCount <= times; clickCount += 1) {
    if (clickCount > 1) await wait(100);
    await mouse("mousePressed", { button: "left", clickCount });
    await wait(heldMs);
    await mouse("mouseReleased", { button: "left", clickCount });
  }
}

/** Taps a finger at a point of the window, as `pressAt` presses the pointer. */
export async function tapAt(x: number, y: number, times = 1): Promise<void> {
  const touch = (type: string, touchPoints: object[]) =>
    send("Input.dispatchTouchEvent", { type, touchPoints });
  for (let tap = 0; tap < times; tap += 1) {
    if (tap > 0) await wait(150);
    await touch("touchStart", [inBrowser(x, y)]);
    await touch("touchEnd", []);
  }
}

/** The middle of an element, as a point of the window. */
export function middleOf(element: Element): [x: number, y: number] {
  const { left, top, width, height } = element.getBoundingClientRect();
  return [left + width / 2, top + height / 2];
}

/** What the browser is told of a key that is held. */
const HELD = {
  Enter: { key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 },
  " ": { key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 },
};

/** Holds a key down, as long as a keyboard that waits `delayMs` first takes to repeat it so many times. */
export async function holdKey(key: keyof typeof HELD, repeats: number, delayMs = 0): Promise<void> {
  await userEvent.keyboard(`{${key}>}`);
  await wait(delayMs);
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", autoRepeat: true, ...HELD[key] });
  }
  await userEvent.keyboard(`{/${key}}`);
}
