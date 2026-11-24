import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** A move of no more than this is not one a press could land on something else by. */
const SLACK_PX = 4;

/** Where something is laid out, how tall, and how far down each thing that holds it was scrolled then. */
interface Place {
  x: number;
  y: number;
  /** Taller, what is in it has come onto another line. */
  height: number;
  scrolled: [holder: Element, top: number][];
}

/** How far down an element can be scrolled. */
function room(holder: Element): number {
  return holder.scrollHeight - holder.clientHeight;
}

/**
 * Where an element is laid out in the page, or in the dialog that holds it,
 * however far that is scrolled and whatever moves it as it is drawn. Null when
 * it is not drawn, or a dialog is over it.
 */
function placeOf(element: HTMLElement | null): Place | null {
  if (element === null || element.closest("[aria-hidden='true']")) return null;
  // What is drawn while a dialog is open is not marked as hidden under it.
  if (document.querySelector("[role='dialog']") && !element.closest("[role='dialog']")) return null;
  const place: Place = { x: 0, y: 0, height: element.offsetHeight, scrolled: [] };
  for (let at: Element | null = element; at instanceof HTMLElement; at = at.offsetParent) {
    place.x += at.offsetLeft;
    place.y += at.offsetTop;
  }
  for (let at: Element | null = element; at; at = at.parentElement) {
    // Safari says a page pulled past its end is scrolled further than it can be.
    if (at.scrollTop > 0) place.scrolled.push([at, Math.min(at.scrollTop, room(at))]);
    // A dialog stays where it is in the window, whatever the page behind it does.
    if (getComputedStyle(at).position === "fixed") break;
  }
  return place;
}

/** Whether what was at one place came to another, or is laid out anew in it, other than by the person scrolling. */
function isMove(was: Place | null, is: Place | null): boolean {
  if (was === null || is === null) return was !== is;
  return (
    Math.abs(is.x - was.x) + Math.abs(is.y - was.y) > SLACK_PX ||
    Math.abs(is.height - was.height) > SLACK_PX ||
    // What is now too short to be scrolled that far has come down under the pointer.
    was.scrolled.some(([holder, top]) => top > room(holder) + SLACK_PX)
  );
}

/**
 * Whether what the element with this id is drawn for, `key`, has been there too
 * short a time for a press on it to be meant for it: less than `ms` since it
 * was drawn or moved, or since the page came back into sight. With a null key
 * there is nothing to press. `settling` is for drawing, and `tooSoon` is asked
 * as it is pressed.
 *
 * Its place is looked at each time it is drawn, which the page's clock does
 * every second, as anything is scrolled, and as it is pressed, since something
 * else on the page may have moved it meanwhile.
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
    seen.current = moved || !was || !is ? is : { ...was, scrolled: is.scrolled };
    if (moved) again();
  }, [id, again]);

  useLayoutEffect(look);

  useEffect(() => {
    document.addEventListener("visibilitychange", again);
    window.addEventListener("scroll", look, true);
    return () => {
      document.removeEventListener("visibilitychange", again);
      window.removeEventListener("scroll", look, true);
    };
  }, [again, look]);

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
