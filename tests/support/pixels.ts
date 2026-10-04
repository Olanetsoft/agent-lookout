// Reading what the browser actually drew, for the few things the DOM cannot say:
// where a masked pattern shows, and whether two patterns line up. A screenshot
// of one element is decoded into its pixels.

import { onTestFinished } from "vitest";
import { page } from "vitest/browser";

import { resolveColour, type Rgba } from "@tests/support/colours";

/**
 * Sizes the test page so the runner shows it at its real size, until the test
 * finishes. A taller page is scaled down to fit, and its screenshots with it,
 * which blurs a 1px line into its neighbours.
 */
export async function atFullSize(): Promise<void> {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(1200, 700);
}

export interface Pixels {
  /** The element's size, in CSS pixels. */
  width: number;
  height: number;
  /** The colour drawn at a point, in CSS pixels from the element's top-left corner. */
  at(x: number, y: number): Rgba;
}

/** The pixels of an element as it is drawn on the page now. */
export async function pixelsOf(element: Element): Promise<Pixels> {
  const base64 = await page.screenshot({ element, save: false });
  const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("No 2D canvas to read the screenshot with.");
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const box = element.getBoundingClientRect();
  const scale = bitmap.width / box.width;
  if (Math.abs(scale - 1) > 0.01 || Math.abs(bitmap.height - box.height) > 1) {
    throw new Error(
      `The screenshot is ${bitmap.width} by ${bitmap.height} for a box of ${box.width} by ${box.height}. Call atFullSize() first, and keep the element in view.`,
    );
  }

  return {
    width: bitmap.width / scale,
    height: bitmap.height / scale,
    at(x, y) {
      const px = Math.min(bitmap.width - 1, Math.max(0, Math.floor(x * scale)));
      const py = Math.min(bitmap.height - 1, Math.max(0, Math.floor(y * scale)));
      const index = (py * bitmap.width + px) * 4;
      return [data[index]!, data[index + 1]!, data[index + 2]!, data[index + 3]! / 255];
    },
  };
}

/** Relative luminance, WCAG 2.1, of a drawn pixel. */
function luminanceOf([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The contrast ratio of two drawn colours. */
export function contrastOf(a: Rgba, b: Rgba): number {
  const [x, y] = [luminanceOf(a), luminanceOf(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Run of words on the page, with the colour it is set in. */
export interface TextOnPage {
  element: Element;
  /** Its words, for a failure message. */
  text: string;
  /** The colour the words are set in. */
  ink: Rgba;
  /**
   * The worst point behind its words: of the pixels drawn behind its box with
   * every glyph hidden, the brightest 3% at Night, or the darkest 3% by Day.
   */
  backdrop: Rgba;
}

/** Every element under `root` that sets words of its own, as a box with something in it. */
function wordsUnder(root: Element): Element[] {
  return [root, ...root.querySelectorAll("*")].filter((element) => {
    if (element instanceof SVGElement || element.closest("[aria-hidden='true'] svg")) return false;
    const own = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
    );
    if (!own) return false;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== "hidden";
  });
}

/**
 * The words under `root` and the worst point of what is drawn behind each, read
 * from the page as it is painted: glass, light and all. The page is drawn once
 * as it is, for the colour of each run of words, and once with every glyph and
 * mark made transparent, for what is behind it. Of the pixels in a box, the
 * brightest 3% at Night, or the darkest 3% by Day, is the backdrop: the place
 * the words are hardest to read.
 *
 * Call atFullSize() first, and keep `root` in view.
 */
export async function textBackdrops(
  root: Element,
  worst: "brightest" | "darkest",
): Promise<TextOnPage[]> {
  const runs = wordsUnder(root).map((element) => ({
    element,
    text: element.textContent?.trim().slice(0, 40) ?? "",
    ink: resolveColour(getComputedStyle(element).color),
    box: element.getBoundingClientRect(),
  }));

  const hide = document.createElement("style");
  hide.textContent = `
    [data-hide-glyphs], [data-hide-glyphs] * { color: transparent !important; caret-color: transparent !important; text-shadow: none !important; }
    [data-hide-glyphs] svg { visibility: hidden !important; }
  `;
  document.head.append(hide);
  root.setAttribute("data-hide-glyphs", "");
  let pixels: Pixels;
  try {
    pixels = await pixelsOf(root);
  } finally {
    root.removeAttribute("data-hide-glyphs");
    hide.remove();
  }

  const origin = root.getBoundingClientRect();
  return runs.map(({ element, text, ink, box }) => {
    const drawn: Rgba[] = [];
    for (let y = box.top - origin.top; y < box.bottom - origin.top; y += 1) {
      for (let x = box.left - origin.left; x < box.right - origin.left; x += 1) {
        drawn.push(pixels.at(x, y));
      }
    }
    drawn.sort((a, b) => luminanceOf(a) - luminanceOf(b));
    const at =
      worst === "brightest" ? Math.floor(drawn.length * 0.97) : Math.floor(drawn.length * 0.03);
    const backdrop = drawn[Math.min(drawn.length - 1, Math.max(0, at))] ?? [0, 0, 0, 1];
    return { element, text, ink, backdrop };
  });
}

function distance(a: Rgba, b: Rgba): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Whether a drawn pixel is, give or take rounding, the colour of a CSS expression. */
export function isNear(colour: Rgba, expression: string, within = 6): boolean {
  return distance(colour, resolveColour(expression)) <= within;
}

/**
 * Whether the hatch is drawn along a level line, from `from` to `to` in CSS
 * pixels. Its lines are 1px wide and cross the line every 8.5px or so, so over
 * any stretch longer than that at least one pixel comes close to the unmeasured
 * colour, and nothing else on a card does.
 */
export function hatchedAlong(pixels: Pixels, y: number, from: number, to: number): boolean {
  const hatch = resolveColour("var(--unmeasured)");
  for (let x = from; x < to; x += 0.5) {
    if (distance(pixels.at(x, y), hatch) < 40) return true;
  }
  return false;
}
