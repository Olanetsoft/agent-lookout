import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** A move of no more than this is not one a press could land on something else by. */
const SLACK_PX = 4;

/** Where something is laid out, and how far down the page was scrolled then. */
interface Place {
  x: number;
  y: number;
  scrolled: number;
}

/**
 * Where an element is laid out in the page, or in the dialog that holds it,
 * however far that is scrolled and whatever moves it as it is drawn. Null when
 * it is not drawn, or a dialog is over it.
 */
function placeOf(element: HTMLElement | null): Place | null {
  if (element === null || element.closest("[aria-hidden='true']")) return null;
  const place = { x: 0, y: 0, scrolled: window.scrollY };
  for (let at: Element | null = element; at instanceof HTMLElement; at = at.offsetParent) {
    place.x += at.offsetLeft;
    place.y += at.offsetTop;
  }
  return place;
}

/** Whether what was at one place came to another, other than by the person scrolling. */
function isMove(was: Place | null, is: Place | null): boolean {
  if (was === null || is === null) return was !== is;
  if (Math.abs(is.x - was.x) + Math.abs(is.y - was.y) > SLACK_PX) return true;
  // A page now too short to be scrolled that far has come down under the pointer.
  const { scrollHeight, clientHeight } = document.documentElement;
  return was.scrolled > scrollHeight - clientHeight + SLACK_PX;
}

/**
 * Whether what the element with this id is drawn for, `key`, has been there too
 * short a time for a press on it to be meant for it: less than `ms` since it
 * was drawn or moved, or since the page came back into sight. With a null key
 * there is nothing to press. `settling` is for drawing, and `tooSoon` is asked
 * as it is pressed.
 *
 * Its place is looked at each time it is drawn, which the page's clock does
 * every second, and as it is pressed, since something else on the page may
 * have moved it meanwhile.
 */
export function useSettling(
  id: string,
  key: string | null,
  ms: number,
): { settling: boolean; tooSoon: () => boolean } {
  const [moves, setMoves] = useState(0);
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const seen = useRef<Place | null>(null);
  const soon = useRef(true);
  const turn = key === null ? null : `${moves} ${key}`;

  const again = useCallback(() => {
    soon.current = ms > 0;
    setMoves((count) => count + 1);
  }, [ms]);

  const look = useCallback(() => {
    const was = seen.current;
    const is = placeOf(document.getElementById(id));
    const moved = isMove(was, is);
    // A drift is measured from where it settled.
    seen.current = moved || was === null ? is : { ...was, scrolled: window.scrollY };
    if (moved) again();
  }, [id, again]);

  useLayoutEffect(look);

  useEffect(() => {
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [again]);

  useLayoutEffect(() => {
    soon.current = true;
    if (turn === null) return;
    const timer = setTimeout(() => {
      soon.current = false;
      setSettledFor(turn);
    }, ms);
    return () => clearTimeout(timer);
  }, [turn, ms]);

  const tooSoon = useCallback(() => {
    look();
    return soon.current;
  }, [look]);

  return { settling: turn !== null && settledFor !== turn, tooSoon };
}
