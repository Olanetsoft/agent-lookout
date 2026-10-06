/**
 * What the dashboard does in a tab that it must not do in the landing page's
 * frame, and what it does there instead.
 *
 * - A link to a place in the dashboard replaces the frame's address, so the
 *   page's history never fills with the views a visitor clicked through.
 *   A link to the repository opens in a new tab. Every other link, a VS Code
 *   link and a session's pull request among them, goes nowhere: nothing
 *   leaves the page.
 * - While the page is driving the tour, nothing in the frame takes focus, so a
 *   new view never pulls the keyboard out of the page.
 * - Bringing something into view scrolls the frame alone, never the page
 *   around it.
 */

export interface FrameGuards {
  /** Whether the frame is the visitor's to use. While not, nothing in it takes focus. */
  setYours(yours: boolean): void;
}

/** The scroll boxes an element sits in, nearest first, ending with the frame's own page. */
function scrollers(element: Element, doc: Document): Element[] {
  const found: Element[] = [];
  for (let at = element.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === "auto" || overflowY === "scroll") && at.scrollHeight > at.clientHeight) {
      found.push(at);
    }
  }
  if (doc.scrollingElement) found.push(doc.scrollingElement);
  return found;
}

/** How far to move a box so the element is where `block` asks, or 0 when it is already. */
function distance(
  element: DOMRect,
  box: { top: number; bottom: number },
  block: ScrollLogicalPosition,
): number {
  const height = box.bottom - box.top;
  switch (block) {
    case "start":
      return element.top - box.top;
    case "end":
      return element.bottom - box.bottom;
    case "center":
      return element.top + element.height / 2 - (box.top + height / 2);
    default:
      if (element.top < box.top) return element.top - box.top;
      if (element.bottom > box.bottom)
        return Math.min(element.bottom - box.bottom, element.top - box.top);
      return 0;
  }
}

export function guardFrame(win: Window & typeof globalThis = window): FrameGuards {
  const doc = win.document;
  let yours = false;

  doc.addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (win.location.hash !== href) win.location.replace(href);
        return;
      }
      event.preventDefault();
      if (
        link.protocol === "https:" &&
        link.hostname === "github.com" &&
        !/\/pull\/\d+$/.test(link.pathname)
      ) {
        win.open(link.href, "_blank", "noopener,noreferrer");
      }
    },
    { capture: true },
  );

  const focus = win.HTMLElement.prototype.focus;
  win.HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (!yours && !doc.hasFocus()) return;
    focus.call(this, options);
  };
  const svgFocus = win.SVGElement.prototype.focus;
  win.SVGElement.prototype.focus = function (this: SVGElement, options?: FocusOptions) {
    if (!yours && !doc.hasFocus()) return;
    svgFocus.call(this, options);
  };

  win.Element.prototype.scrollIntoView = function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions,
  ) {
    const options = typeof arg === "object" ? arg : {};
    const block = typeof arg === "boolean" ? (arg ? "start" : "end") : (options.block ?? "start");
    for (const box of scrollers(this, doc)) {
      const edges =
        box === doc.scrollingElement
          ? { top: 0, bottom: win.innerHeight }
          : box.getBoundingClientRect();
      const by = distance(this.getBoundingClientRect(), edges, block);
      if (by === 0) continue;
      if (box === doc.scrollingElement) win.scrollBy({ top: by, behavior: options.behavior });
      else box.scrollBy({ top: by, behavior: options.behavior });
    }
  };

  return {
    setYours(next) {
      yours = next;
    },
  };
}
