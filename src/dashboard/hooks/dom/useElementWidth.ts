import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The width of an element in whole pixels, kept current as it is resized. It is
 * 0 until the element has been measured, so a caller can hold back whatever
 * depends on the width until then.
 */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // Fires once when it starts watching, and again whenever the box changes size.
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
