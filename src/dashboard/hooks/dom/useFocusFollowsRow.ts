import { useLayoutEffect, useRef, type FocusEvent, type RefObject } from "react";

/** What had focus inside the container: which row, and which part of it. */
interface Focused {
  /** The row's key, the value of its key attribute. */
  key: string;
  /** The row's `data-slot`, such as "session-row", so a row of the same kind is preferred. */
  slot: string | null;
  /** The `data-part` of what had focus, such as "jump". */
  part: string | null;
  element: HTMLElement;
}

/** The handlers to put on the container, beside the ref. */
interface FocusHandlers<T extends HTMLElement> {
  onFocus: (event: FocusEvent<T>) => void;
  onBlur: (event: FocusEvent<T>) => void;
}

/** Whether Tab can reach this element as it is now. */
function canTakeFocus(element: HTMLElement | null): element is HTMLElement {
  return element !== null && element.isConnected && element.tabIndex >= 0;
}

/**
 * Keeps focus with a row when the row is drawn somewhere else.
 *
 * When a session changes status its row moves to another group, which is
 * another `<tbody>`, so the browser is handed a new row and the old one, with
 * the button that had focus, leaves the page. Focus would fall back to the top
 * of the page. Instead it follows the row: to the same part of the row with the
 * same key when that part can take focus, or else to the row's Jump. Where two
 * rows have that key, it goes to the one of the same kind as the row it left.
 *
 * Focus is followed only when it was lost because the row moved. Once the
 * person moves focus anywhere else, or away from the page, it is forgotten.
 *
 * `rows` selects the rows inside the container and `key` names the attribute
 * that tells them apart. It returns the ref and the two handlers for the
 * container.
 */
export function useFocusFollowsRow<T extends HTMLElement>(
  rows: string,
  key: string,
  fallbackPart = "jump",
): [RefObject<T | null>, FocusHandlers<T>] {
  const ref = useRef<T>(null);
  const focused = useRef<Focused | null>(null);

  // After every change to the page: if what had focus has lost it and nothing
  // else has taken it, it goes back to the same row.
  useLayoutEffect(() => {
    const last = focused.current;
    const container = ref.current;
    if (!last || !container) return;
    const active = document.activeElement;
    if (active === last.element) return;
    if (active !== null && active !== document.body) {
      focused.current = null;
      return;
    }

    let target: HTMLElement | null = last.element.isConnected ? last.element : null;
    if (!target) {
      const same = [...container.querySelectorAll<HTMLElement>(rows)].filter(
        (candidate) => candidate.getAttribute(key) === last.key,
      );
      // A session can be drawn twice, in the hero and as a card on the board.
      // Focus stays with the kind of row it was in when there is one.
      const row =
        same.find((candidate) => candidate.getAttribute("data-slot") === last.slot) ?? same[0];
      const part = (name: string | null) =>
        name === null ? null : (row?.querySelector<HTMLElement>(`[data-part="${name}"]`) ?? null);
      target = [part(last.part), part(fallbackPart)].find(canTakeFocus) ?? null;
    }
    if (target) target.focus();
    else focused.current = null;
  });

  const onFocus = (event: FocusEvent<T>) => {
    const element = event.target as HTMLElement;
    const row = element.closest<HTMLElement>(rows);
    const rowKey = row?.getAttribute(key);
    focused.current = rowKey
      ? {
          key: rowKey,
          slot: row?.getAttribute("data-slot") ?? null,
          part: element.getAttribute("data-part"),
          element,
        }
      : null;
  };

  const onBlur = (event: FocusEvent<T>) => {
    const next = event.relatedTarget;
    // Somewhere else inside: its own focus event says where.
    if (next instanceof Node && ref.current?.contains(next)) return;
    if (next !== null) {
      focused.current = null;
      return;
    }
    // Nowhere to go. That is the person clicking the page or leaving the window,
    // or the browser taking focus from a row it is about to take out. Which it
    // was is known once the change is done: a row taken out is no longer in the
    // page, and its focus has been given back by then.
    const element = event.target as HTMLElement;
    setTimeout(() => {
      if (focused.current?.element === element && element.isConnected) focused.current = null;
    });
  };

  return [ref, { onFocus, onBlur }];
}
