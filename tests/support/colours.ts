// Colour helpers for component tests: reading a colour the page computed,
// resolving a token in the current theme, contrast, and finding anything on the
// page painted in a warm colour. The needs-you tokens are the only warm colours
// in the system, so a warm paint anywhere is amber where amber does not belong.

/** Red, green and blue from 0 to 255, and alpha from 0 to 1. */
export type Rgba = [number, number, number, number];

const COLOUR =
  /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)|color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)/g;

function alphaOf(value: string | undefined): number {
  if (value === undefined) return 1;
  return value.endsWith("%") ? Number(value.slice(0, -1)) / 100 : Number(value);
}

/** Every colour written in a computed value, such as the several in a box-shadow or a gradient. */
export function coloursIn(value: string): Rgba[] {
  const found: Rgba[] = [];
  for (const match of value.matchAll(COLOUR)) {
    if (match[1] !== undefined) {
      found.push([Number(match[1]), Number(match[2]), Number(match[3]), alphaOf(match[4])]);
    } else {
      found.push([
        Number(match[5]) * 255,
        Number(match[6]) * 255,
        Number(match[7]) * 255,
        alphaOf(match[8]),
      ]);
    }
  }
  return found;
}

/** The one colour in a computed value. */
export function parseColour(value: string): Rgba {
  const [colour] = coloursIn(value);
  if (!colour) throw new Error(`Cannot read the colour "${value}".`);
  return colour;
}

/** Any CSS colour expression, tokens and color-mix included, as the current theme resolves it. */
export function resolveColour(expression: string): Rgba {
  const probe = document.createElement("div");
  probe.style.color = expression;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return parseColour(value);
}

/** A token's value as `rgb(...)`, the way getComputedStyle writes an opaque colour. */
export function rgbOf(expression: string): string {
  const [r, g, b, a] = resolveColour(expression).map((part, index) =>
    index < 3 ? Math.round(part) : part,
  ) as Rgba;
  return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG 2.1 contrast ratio of two opaque colours, given as CSS expressions. */
export function contrast(foreground: string, background: string): number {
  const a = luminance(resolveColour(foreground));
  const b = luminance(resolveColour(background));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The least chroma a warm colour has: how far apart its brightest and dimmest
 * channels are, from 0 to 1. The system's whites, greys and blacks all carry the
 * faintest warmth, a chroma of .07 at most, and the lamp's colours sit at .13 for
 * the dark words on the lamp and .5 and up for the rest. A measure of saturation
 * would not do: it counts a near-white with a trace of warmth as fully warm.
 */
const WARM_CHROMA = 0.1;

/**
 * Whether a colour is warm: a visible red, orange or yellow with real colour in
 * it. The warm undertone of the ground, the glass, the ink and the rules is too
 * faint to count, and the cool family is all silver and blue-grey.
 */
export function isWarm([r, g, b, a]: Rgba): boolean {
  if (a < 0.05) return false;
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  if (max - min < WARM_CHROMA) return false;
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  let hue: number;
  if (max === rn) hue = (60 * ((gn - bn) / (max - min)) + 360) % 360;
  else if (max === gn) hue = 60 * ((bn - rn) / (max - min)) + 120;
  else hue = 60 * ((rn - gn) / (max - min)) + 240;
  return hue < 75 || hue > 320;
}

/** The needs-you colour tokens: with the lamp's light, the only warm colours in the system. */
export const NEEDS_YOU_TOKENS = [
  "--status-needs-you",
  "--status-needs-you-edge",
  "--label-needs-you",
  "--on-needs-you",
  "--glow-needs-you",
] as const;

/**
 * The lamp's light: the light behind the hero, written as three channels, and
 * the hero's edge catching it, written as a gradient. Warm, and drawn only
 * while a session needs the person.
 */
export const LAMP_TOKENS = ["--lamp", "--rim-lamp"] as const;

/**
 * Every colour a token holds, as the current theme resolves it, whatever form
 * it is written in: a colour, three channels for `rgb(var(--token))`, or a
 * gradient or a shadow with colours in it. A number, such as a strength, holds
 * none.
 */
export function tokenColours(token: string): Rgba[] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
  if (raw === "") return [];
  if (/^[\d.]+\s+[\d.]+\s+[\d.]+$/.test(raw)) return [resolveColour(`rgb(${raw})`)];
  if (/^-?[\d.]+(%|px|deg)?$/.test(raw)) return [];
  // A custom property keeps what was written, so a hex value in a gradient is
  // still hex. Each is resolved on its own.
  const hexes = [...raw.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((match) => resolveColour(match[0]));
  return [...coloursIn(raw), ...hexes];
}

const BOX_PROPERTIES = [
  "background-color",
  "background-image",
  "box-shadow",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
] as const;

/** What one box paints, leaving out a border or an outline that is not drawn. */
function paintOf(style: CSSStyleDeclaration, svg: boolean, withText: boolean): [string, string][] {
  const paint: [string, string][] = [];
  for (const property of BOX_PROPERTIES) {
    if (property.startsWith("border-")) {
      const side = property.split("-")[1];
      if (
        style.getPropertyValue(`border-${side}-style`) === "none" ||
        parseFloat(style.getPropertyValue(`border-${side}-width`)) === 0
      ) {
        continue;
      }
    }
    paint.push([property, style.getPropertyValue(property)]);
  }
  if (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) {
    paint.push(["outline-color", style.outlineColor]);
  }
  if (withText) paint.push(["color", style.color]);
  if (svg) {
    paint.push(["fill", style.fill], ["stroke", style.stroke]);
  }
  return paint;
}

/** A short name for an element in a failure message. */
function describe(element: Element, pseudo = ""): string {
  const slot = element.getAttribute("data-slot") ?? element.getAttribute("data-part");
  const text = element.textContent?.trim().slice(0, 30);
  return `<${element.tagName.toLowerCase()}${slot ? ` ${slot}` : ""}${pseudo}>${text ? ` "${text}"` : ""}`;
}

/** Whether an element has text of its own to paint, or draws with its colour. */
function usesColour(element: Element): boolean {
  if (element instanceof SVGElement) return true;
  return [...element.childNodes].some(
    (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
  );
}

/** What one element paints in a warm colour, its own pseudo-elements included, described. */
function warmPaintOf(element: Element): string[] {
  const found: string[] = [];
  const svg = element instanceof SVGElement;
  const boxes: [CSSStyleDeclaration, string, boolean][] = [
    [getComputedStyle(element), "", usesColour(element)],
  ];
  for (const pseudo of ["::before", "::after"]) {
    const style = getComputedStyle(element, pseudo);
    if (style.content !== "none" && style.content !== "normal") boxes.push([style, pseudo, true]);
  }
  for (const [style, pseudo, withText] of boxes) {
    for (const [property, value] of paintOf(style, svg && pseudo === "", withText)) {
      if (coloursIn(value).some(isWarm)) {
        found.push(`${describe(element, pseudo)} ${property}: ${value}`);
      }
    }
  }
  return found;
}

/** Every element under `root`, itself included, that paints something warm of its own. */
export function warmElements(root: Element = document.body): Element[] {
  return [root, ...root.querySelectorAll("*")].filter((element) => warmPaintOf(element).length > 0);
}

/**
 * Everything under `root`, pseudo-elements included, that paints a warm colour:
 * its words, its fill, its stroke, its background, a border or outline that is
 * drawn, or a shadow. Each is described, so a failure says what and where.
 */
export function warmPaint(root: Element = document.body): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap(warmPaintOf);
}
