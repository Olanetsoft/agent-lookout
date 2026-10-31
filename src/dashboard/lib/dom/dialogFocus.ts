import type { KeyboardEvent } from "react";

type Focusable = HTMLElement | SVGElement;

/**
 * For a dialog's `onKeyDown`: Tab from the dialog's last control goes round to
 * its first, and Shift+Tab from its first control, from its title or from the
 * dialog itself goes round to its last. The control it comes to is brought
 * into view.
 *
 * Radix's focus trap makes the same two wraps, but it focuses without
 * scrolling, so in a dialog taller than the window the control it comes to can
 * be out of sight. And it wraps Shift+Tab only from the first control. A title
 * that focus starts on, and the dialog, which a click on plain text in it
 * focuses, both take focus with tabIndex -1 and come before that control. From
 * either, the browser moves focus out of the dialog backwards and the trap puts
 * it straight back, so the key seems to do nothing.
 *
 * The controls are found by the trap's own rules, so the ones this picks are
 * the ones the trap treats as first and last, and it runs before the trap,
 * which then finds nothing left to do. Every other key, and Tab or Shift+Tab
 * from anywhere else, is left to the browser.
 */
export function wrapTab(event: KeyboardEvent<HTMLElement>): void {
  const { altKey, ctrlKey, metaKey, shiftKey } = event;
  if (event.key !== "Tab" || altKey || ctrlKey || metaKey) return;
  if (event.defaultPrevented) return;

  const dialog = event.currentTarget;
  const active = document.activeElement;
  if (!active || !dialog.contains(active)) return;
  const [first, last] = tabbableEdges(dialog);
  if (!first || !last) return;
  // The dialog contains its first control, so it comes before it as well.
  const atStart =
    active === first ||
    Boolean(first.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING);
  const to = shiftKey ? (atStart ? last : undefined) : active === last ? first : undefined;
  if (!to) return;

  event.preventDefault();
  if (to === active) return;
  to.focus();
  // As the trap does, and as Tab into a field does, what is typed in it is selected.
  if (to instanceof HTMLInputElement) to.select();
}

/**
 * The first and last controls Tab reaches in a container, by the rules of
 * Radix's focus trap: a tabIndex of 0 or more, not disabled, not hidden, not a
 * hidden input, and drawn.
 */
function tabbableEdges(container: HTMLElement): [Focusable | undefined, Focusable | undefined] {
  const candidates: Focusable[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const element = node as Focusable & { disabled?: boolean; hidden?: boolean };
      const hiddenInput = element instanceof HTMLInputElement && element.type === "hidden";
      if (element.disabled || element.hidden || hiddenInput) return NodeFilter.FILTER_SKIP;
      return element.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });
  while (walker.nextNode()) candidates.push(walker.currentNode as Focusable);

  const drawn = isDrawnIn(container);
  return [candidates.find(drawn), [...candidates].reverse().find(drawn)];
}

/**
 * Whether an element in the container is drawn. As in the trap, a browser
 * without `checkVisibility` looks for a hidden or undisplayed element instead.
 */
function isDrawnIn(container: HTMLElement): (element: Focusable) => boolean {
  const canCheck =
    typeof container.checkVisibility === "function" &&
    container.checkVisibility({ checkVisibilityCSS: true });
  if (canCheck) return (element) => element.checkVisibility({ checkVisibilityCSS: true });
  return (element) => {
    if (getComputedStyle(element).visibility === "hidden") return false;
    let node: Element | null = element;
    while (node && node !== container) {
      if (getComputedStyle(node).display === "none") return false;
      node = node.parentElement;
    }
    return true;
  };
}
