// Reads where the browser broke a string across lines, for component tests.

/** A range over the characters from `start` to `end` of an element's text, across its text nodes. */
function rangeOf(element: Element, start: number, end: number): Range {
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let begun = false;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const next = seen + node.length;
    if (!begun && start < next) {
      range.setStart(node, start - seen);
      begun = true;
    }
    if (begun && end <= next) {
      range.setEnd(node, end - seen);
      return range;
    }
    seen = next;
  }
  throw new Error(`The text has no characters from ${start} to ${end}`);
}

/** How many lines a range of text is drawn across: one for each distinct top of its boxes. */
function linesOf(range: Range): number {
  const tops: number[] = [];
  for (const box of range.getClientRects()) {
    if (box.width === 0) continue;
    if (!tops.some((top) => Math.abs(top - box.top) < 2)) tops.push(box.top);
  }
  return tops.length;
}

/** How many lines an element's whole text is drawn across. */
export function linesDrawn(element: Element): number {
  return linesOf(rangeOf(element, 0, element.textContent?.length ?? 0));
}

/**
 * Each piece of an element's text that `pattern` finds, with the number of
 * lines it is drawn across. A piece that a line break runs through is on two.
 * It reads what was drawn, whatever elements hold the text.
 */
export function piecesDrawn(element: Element, pattern: RegExp): { piece: string; lines: number }[] {
  const text = element.textContent ?? "";
  return [...text.matchAll(pattern)].map((match) => ({
    piece: match[0],
    lines: linesOf(rangeOf(element, match.index, match.index + match[0].length)),
  }));
}
