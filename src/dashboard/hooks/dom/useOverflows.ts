import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * Whether an element's content is taller than the element shows, so that it
 * scrolls. It is measured before the page is painted, again whenever
 * `content` changes, and whenever the element or what is in it changes size,
 * as when the window is narrowed and the text wraps onto more lines.
 */
export function useOverflows<T extends HTMLElement>(
  content: unknown,
): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    // Fires once when it starts watching, and again whenever a box changes size.
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [content]);

  return [ref, overflows];
}
