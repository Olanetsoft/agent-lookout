// Pointer and keyboard helpers for component tests, which share one browser page.

import { userEvent } from "vitest/browser";

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
