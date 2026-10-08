import { afterEach, describe, expect, onTestFinished, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  coloursIn,
  isWarm,
  LAMP_TOKENS,
  NEEDS_YOU_TOKENS,
  resolveColour,
  rgbOf,
  tokenColours,
  type Rgba,
} from "@tests/support/browser/colours";
import { startAtTop } from "@tests/support/browser/browser";
import { preferReducedMotion } from "@tests/support/browser/media";
import { contrastOf } from "@tests/support/browser/pixels";

// The stylesheet, src/dashboard/styles/index.css, read as the app reads it: the
// colour tokens in both themes, the ground and the glass they make, the contrast
// every word keeps on that glass with the light behind it, the bundled fonts and
// motion. Every value is read from the real stylesheet, so changing a token
// there is checked here.

type Theme = "dark" | "light";

/** Every raw colour token, night then day. */
const TOKENS: Record<string, [night: string, day: string]> = {
  "--ground-top": ["#060605", "#d4d0ca"],
  "--glass-chrome": ["rgba(11, 10, 9, 0.64)", "rgba(252, 251, 249, 0.52)"],
  "--glass-card": ["rgba(13, 12, 11, 0.66)", "rgba(255, 255, 254, 0.56)"],
  "--glass-raised": ["rgba(25, 23, 21, 0.68)", "rgba(255, 255, 255, 0.66)"],
  "--glass-float": ["rgba(21, 20, 18, 0.88)", "rgba(253, 252, 250, 0.84)"],
  "--fill-quiet": ["rgba(255, 248, 238, 0.055)", "rgba(255, 255, 255, 0.62)"],
  "--fill-hover": ["rgba(255, 248, 238, 0.045)", "rgba(255, 255, 255, 0.55)"],
  "--fill-selected": ["rgba(255, 248, 238, 0.1)", "rgba(255, 255, 255, 0.85)"],
  "--fill-zebra": ["rgba(255, 248, 238, 0.022)", "rgba(38, 32, 26, 0.035)"],
  "--control-rim": ["rgba(255, 248, 238, 0.11)", "rgba(38, 32, 26, 0.13)"],
  "--control-top": ["rgba(255, 248, 238, 0.1)", "rgba(255, 255, 255, 0.9)"],
  "--well": ["rgba(0, 0, 0, 0.3)", "rgba(38, 32, 26, 0.055)"],
  "--thumb": ["rgba(255, 248, 238, 0.11)", "#ffffff"],
  "--hairline": ["rgba(255, 248, 238, 0.085)", "rgba(38, 32, 26, 0.08)"],
  "--rule": ["rgba(255, 248, 238, 0.135)", "rgba(38, 32, 26, 0.13)"],
  "--rule-strong": ["rgba(255, 248, 238, 0.24)", "rgba(38, 32, 26, 0.28)"],
  "--ink": ["#f3f0ea", "#181613"],
  "--ink-secondary": ["#c3beb5", "#3f3b36"],
  "--ink-muted": ["#9e988f", "#5b564f"],
  "--status-needs-you": ["#ffb547", "#f4a62a"],
  "--status-needs-you-edge": ["#ffb547", "#a35a00"],
  "--label-needs-you": ["#ffb547", "#864600"],
  "--on-needs-you": ["#221400", "#221400"],
  "--glow-needs-you": ["rgba(255, 170, 60, 0.5)", "rgba(214, 128, 20, 0.4)"],
  "--status-working": ["#a9bcd4", "#36577e"],
  "--status-working-fill": ["#86a0bd", "#5b7ca4"],
  "--status-working-top": ["rgba(255, 255, 255, 0.16)", "rgba(255, 255, 255, 0.22)"],
  "--status-idle": ["#948e85", "#6f6961"],
  "--answered-fill": ["rgba(148, 142, 133, 0.26)", "rgba(111, 105, 97, 0.14)"],
  "--status-finished": ["#9e988f", "#5b564f"],
  "--tube": ["rgba(255, 248, 238, 0.04)", "rgba(255, 255, 255, 0.62)"],
  "--tube-rim": ["rgba(255, 248, 238, 0.15)", "rgba(38, 32, 26, 0.16)"],
  "--tube-top": ["rgba(255, 248, 238, 0.2)", "#ffffff"],
  "--unmeasured": ["#4b463f", "#b2aca3"],
  "--focus": ["#c3d3e6", "#36577e"],
  "--scrim": ["rgba(0, 0, 0, 0.6)", "rgba(38, 32, 26, 0.28)"],
};

/** The lights, as three channels and a strength, and how far glass saturates. */
const LIGHTS: Record<string, [night: string, day: string]> = {
  "--field": ["218 214 207", "255 255 255"],
  "--field-deep": ["142 137 130", "240 235 227"],
  "--field-strength": ["0.16", "0.72"],
  "--lamp": ["255 166 60", "255 176 80"],
  "--lamp-strength": ["0.48", "0.46"],
  "--rest": ["226 221 213", "255 255 255"],
  "--rest-strength": ["0.28", "0.7"],
  "--saturate": ["118%", "160%"],
  "--saturate-hero": ["185%", "190%"],
  "--grain": ["0.3", "0.3"],
};

/** Tokens written as gradients and shadows, read for the colours in them. */
const PAINTS = [
  "--ground",
  "--rim",
  "--rim-raised",
  "--rim-lamp",
  "--rim-rest",
  "--sheen",
  "--elev-1",
  "--elev-2",
  "--elev-3",
];

/** The navy look and the looks before it, none of which may resolve to anything any more. */
const RETIRED_TOKENS = [
  "--page",
  "--rail",
  "--surface",
  "--surface-raised",
  "--surface-band",
  "--tint-needs-you",
  "--rule-needs-you",
  "--shadow-lit",
  "--baseline",
  "--chart-ink",
  "--chart-warm",
  "--series-blue",
  "--status-good",
  "--status-critical",
  "--status-failed",
  "--label-working",
  "--label-finished",
  "--label-failed",
  "--label-muted",
];

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

/** A raw token's value, as the stylesheet writes it. */
function raw(token: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

/** A hex colour, or an rgba() as written above, the way getComputedStyle writes it. */
function computed(value: string): string {
  if (value.startsWith("rgba")) return value;
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Two colours as getComputedStyle writes them, alike but for how the browser
 * rounds an alpha: it keeps 256 steps, so 0.045 comes back as 0.043.
 */
function expectColour(actual: string, expected: string, token: string) {
  const [a, b] = [resolveColour(actual), resolveColour(expected)];
  expect(a.slice(0, 3), `${token}: ${actual}`).toEqual(b.slice(0, 3));
  expect(Math.abs(a[3] - b[3]), `${token}: ${actual} against ${expected}`).toBeLessThan(0.004);
}

/** An element on the page, with these classes, removed when the test finishes. */
function probe(className: string, parent: Element = document.body): HTMLElement {
  const element = document.createElement("div");
  element.className = className;
  element.textContent = "probe";
  parent.append(element);
  onTestFinished(() => element.remove());
  return element;
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/*
 * Glass, composited by hand: what a person sees through a pane at its worst
 * point. The ground at its brightest (Night) or darkest (Day) stop, the
 * brightest light that can sit behind the pane at its peak, then the pane's own
 * tint over all of it. Words are checked against that.
 */

/** `top` laid over `bottom` at the top's alpha. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as Rgba;
}

/** A light's colour saturated as the hero's lights are, by CSS's saturate() matrix. */
function saturated([r, g, b, a]: Rgba, amount: number): Rgba {
  const s = amount;
  const clamp = (value: number) => Math.min(255, Math.max(0, value));
  return [
    clamp((0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b),
    clamp((0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b),
    a,
  ];
}

/** A light at its peak: three channels at its strength. */
function light(token: string, strength: string, scale = 1): Rgba {
  const [r, g, b] = raw(token).split(/\s+/).map(Number) as [number, number, number];
  return [r, g, b, Number(raw(strength)) * scale];
}

/** The ground at the point where words on glass are hardest to read. */
function worstGround(theme: Theme): Rgba {
  // Night: the lightest stop, at the foot. Day: the darkest, at the top.
  return theme === "dark" ? resolveColour("#0c0b0a") : resolveColour("var(--ground-top)");
}

/** Every backdrop words sit on, at its worst point, by name. */
function backdrops(theme: Theme): Record<string, Rgba> {
  const ground = worstGround(theme);
  // The lights brighten the ground at night. By day they are white and only
  // lighten it, so the worst point is the ground without them.
  const lit = theme === "dark" ? over(light("--field", "--field-strength"), ground) : ground;
  const hero = Number(raw("--saturate-hero").replace("%", "")) / 100;
  // The lamp's core over its own wash, saturated as the layer is, over the field.
  const lamp = [
    saturated(light("--lamp", "--lamp-strength", 0.3), hero),
    saturated(light("--lamp", "--lamp-strength"), hero),
  ].reduce((below, layer) => over(layer, below), lit);
  const rest = [
    saturated(light("--rest", "--rest-strength", 0.5), hero),
    saturated(light("--rest", "--rest-strength"), hero),
  ].reduce((below, layer) => over(layer, below), lit);
  const glass = (token: string, behind: Rgba) => over(resolveColour(`var(${token})`), behind);
  return {
    "rail and header": glass("--glass-chrome", lit),
    card: glass("--glass-card", lit),
    "floating glass over the lamp": glass("--glass-float", lamp),
    "the rail's selection": over(
      resolveColour("var(--fill-selected)"),
      glass("--glass-chrome", lit),
    ),
    "the hero over the lamp's core": glass("--glass-raised", lamp),
    "the hero over the rest light": glass("--glass-raised", rest),
  };
}

/** Which words may sit on each backdrop. The hero never takes the muted ink. */
const WORDS_ON: Record<string, string[]> = {
  "rail and header": ["--ink", "--ink-secondary", "--ink-muted"],
  card: ["--ink", "--ink-secondary", "--ink-muted", "--label-needs-you"],
  "floating glass over the lamp": ["--ink", "--ink-secondary", "--ink-muted", "--label-needs-you"],
  "the rail's selection": ["--ink"],
  "the hero over the lamp's core": ["--ink", "--ink-secondary", "--label-needs-you"],
  "the hero over the rest light": ["--ink", "--ink-secondary"],
};

/**
 * Every colour a status mark or a bar is drawn in. The lamp is checked by its
 * edge: in daylight its fill is too pale to stand alone and is never drawn
 * without it.
 */
const MARK_TOKENS = [
  "--status-needs-you-edge",
  "--status-working",
  "--status-working-fill",
  "--status-idle",
  "--status-finished",
  // The ended dash.
  "--ink-muted",
  "--focus",
];

describe.each([
  ["dark", 0],
  ["light", 1],
] as const)("the %s theme", (theme, column) => {
  test("every raw token has the value of its theme", () => {
    applyTheme(theme);
    for (const [token, values] of Object.entries(TOKENS)) {
      expectColour(rgbOf(`var(${token})`), computed(values[column]), token);
    }
    for (const [token, values] of Object.entries(LIGHTS)) {
      expect(raw(token), token).toBe(values[column]);
    }
  });

  test.each(Object.keys(WORDS_ON))(
    "words on %s keep AA at its worst point, the light behind it included",
    (backdrop) => {
      applyTheme(theme);
      const behind = backdrops(theme)[backdrop] as Rgba;
      for (const token of WORDS_ON[backdrop] ?? []) {
        const ratio = contrastOf(resolveColour(`var(${token})`), behind);
        expect(ratio, `${token} on ${backdrop} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );

  test("dark words on the lamp's fill meet AA, for the one solid button", () => {
    applyTheme(theme);
    const ratio = contrastOf(
      resolveColour("var(--on-needs-you)"),
      resolveColour("var(--status-needs-you)"),
    );
    expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  test.each(MARK_TOKENS)(
    "%s meets 3:1 for a mark or a bar on a card at its worst point",
    (token) => {
      applyTheme(theme);
      const ratio = contrastOf(resolveColour(`var(${token})`), backdrops(theme).card as Rgba);
      expect(ratio, `${token} on a card is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    },
  );

  test("the warm tokens are exactly the needs-you set and the lamp's light", () => {
    applyTheme(theme);
    const warmSet = new Set<string>([...NEEDS_YOU_TOKENS, ...LAMP_TOKENS]);
    for (const token of [...Object.keys(TOKENS), ...Object.keys(LIGHTS), ...PAINTS]) {
      const colours = tokenColours(token);
      const warm = colours.some(isWarm);
      expect(warm, `${token}: ${raw(token)}`).toBe(warmSet.has(token));
    }
    for (const token of warmSet) expect(tokenColours(token).length, token).toBeGreaterThan(0);
  });

  test("the ground is layered and fixed behind the content, never a flat colour", () => {
    applyTheme(theme);
    const ground = probe("ground");
    ground.textContent = "";
    const fields = ["ground-main", "ground-deep", "ground-far"].map((name) => {
      const field = document.createElement("i");
      field.className = name;
      ground.append(field);
      return field;
    });
    const style = getComputedStyle(ground);

    // Fixed to the window and behind everything, so panels slide over its light.
    expect(style.position).toBe("fixed");
    expect(style.zIndex).toBe("-1");
    expect(style.pointerEvents).toBe("none");
    // A gradient through three stops, not one colour.
    expect(style.backgroundImage).toMatch(/^linear-gradient\(/);
    expect(coloursOfImage(style.backgroundImage).length).toBeGreaterThanOrEqual(2);
    // Three fields of light, each a radial glow.
    for (const field of fields) {
      expect(getComputedStyle(field).backgroundImage, field.className).toMatch(/radial-gradient/);
    }
    // The main field is turned across the top right.
    expect(getComputedStyle(fields[0]!).transform).not.toBe("none");
    // A fine dither over it all, drawn in the page with no request.
    const dither = getComputedStyle(ground, "::after");
    expect(dither.backgroundImage).toMatch(/^url\("data:image\/svg\+xml/);
    expect(dither.mixBlendMode).toBe("overlay");
    expect(dither.opacity).toBe(LIGHTS["--grain"]![column]);

    // The page itself is not painted over it, and the window's own edge is the
    // ground's top colour.
    expect(getComputedStyle(document.body).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(document.body).backgroundImage).toBe("none");
    expect(getComputedStyle(document.documentElement).backgroundColor).toBe(
      computed(TOKENS["--ground-top"]![column]),
    );
  });

  test("glass comes at three heights, each with its own tint, rim and shadow, and none of them blurs", () => {
    applyTheme(theme);
    const heights = (["chrome", "card", "raised"] as const).map((height) => {
      const element = probe(`glass-${height}`);
      const style = getComputedStyle(element);
      const rim = getComputedStyle(element, "::before");
      const sheen = getComputedStyle(element, "::after");
      return { height, element, style, rim, sheen };
    });

    for (const { height, style, rim, sheen } of heights) {
      const token = height === "chrome" ? "--glass-chrome" : `--glass-${height}`;
      expect(style.backgroundColor, height).toBe(rgbOf(`var(${token})`));
      expect(style.borderTopWidth, height).toBe("0px");
      // No blur of its own: that is for what something passes behind.
      expect(style.backdropFilter, height).toBe("none");
      // The rim: a 1px edge of light cut from a gradient by a mask.
      expect(rim.content, height).toBe('""');
      expect(rim.backgroundImage, height).toMatch(/linear-gradient/);
      expect(rim.paddingTop, height).toBe("1px");
      expect(rim.maskComposite, height).toMatch(/^exclude(, exclude)*$/);
      // The sheen, under the top edge, behind the content.
      expect(sheen.backgroundImage, height).toMatch(/linear-gradient/);
      expect(sheen.zIndex, height).toBe("-1");
    }

    const [chrome, card, raised] = heights as [
      (typeof heights)[0],
      (typeof heights)[0],
      (typeof heights)[0],
    ];
    expect(chrome.style.borderRadius).toBe("22px");
    expect(card.style.borderRadius).toBe("24px");
    expect(raised.style.borderRadius).toBe("24px");
    // Three distinct tints, rims and shadows.
    for (const part of [
      (h: typeof chrome) => h.style.backgroundColor,
      (h: typeof chrome) => h.style.boxShadow,
    ]) {
      expect(new Set(heights.map(part)).size).toBe(3);
    }
    expect(raised.rim.backgroundImage).not.toBe(card.rim.backgroundImage);
    // Each height's shadow is its own elevation, the hero's the deepest.
    expect(chrome.style.boxShadow).toBe(shadowOf("var(--elev-1)"));
    expect(card.style.boxShadow).toBe(shadowOf("var(--elev-2)"));
    expect(raised.style.boxShadow).toBe(shadowOf("var(--elev-3)"));
    expect(blurOfDeepestDrop(raised.style.boxShadow)).toBeGreaterThan(
      blurOfDeepestDrop(card.style.boxShadow),
    );
    expect(blurOfDeepestDrop(card.style.boxShadow)).toBeGreaterThan(
      blurOfDeepestDrop(chrome.style.boxShadow),
    );
    // The hero's glass is the brightest at night and the most opaque white by day.
    expect(resolveColour("var(--glass-raised)")[3]).toBeGreaterThan(
      resolveColour("var(--glass-card)")[3],
    );
  });

  test("the hero's rim catches the lamp while a session waits, and the rest light while none does", () => {
    applyTheme(theme);
    const hero = probe("glass-raised");
    const rimColours = () => coloursOfImage(getComputedStyle(hero, "::before").backgroundImage);

    expect(rimColours().some(isWarm)).toBe(false);
    hero.dataset.light = "lamp";
    expect(rimColours().some(isWarm)).toBe(true);
    hero.dataset.light = "rest";
    const rest = getComputedStyle(hero, "::before").backgroundImage;
    expect(rimColours().some(isWarm)).toBe(false);
    expect(rest).not.toBe(getComputedStyle(probe("glass-raised"), "::before").backgroundImage);
  });

  test("the two lights behind the hero: the lamp is warm and rises into place, the rest light is silver and still", () => {
    applyTheme(theme);
    const lamp = probe("lamp-light");
    const rest = probe("rest-light");

    for (const element of [lamp, rest]) {
      const style = getComputedStyle(element);
      expect(style.position).toBe("absolute");
      expect(style.pointerEvents).toBe("none");
      expect(style.zIndex).toBe("0");
      expect(style.filter).toMatch(/^saturate\(/);
    }
    const lampColours = [
      ...coloursOfImage(getComputedStyle(lamp).backgroundImage),
      ...coloursOfImage(getComputedStyle(lamp, "::before").backgroundImage),
    ];
    const restColours = [
      ...coloursOfImage(getComputedStyle(rest).backgroundImage),
      ...coloursOfImage(getComputedStyle(rest, "::before").backgroundImage),
    ];
    expect(lampColours.some(isWarm)).toBe(true);
    expect(restColours.length).toBeGreaterThan(0);
    expect(restColours.some(isWarm)).toBe(false);
    expect(getComputedStyle(lamp).animationName).toBe("lamp-rise");
    expect(getComputedStyle(lamp).animationDuration).toBe("1.2s");
    expect(getComputedStyle(rest).animationName).toBe("none");
  });

  test("the bar fills keep one look everywhere: open, answered, working, idle, the tube and the hatch", () => {
    applyTheme(theme);
    const open = getComputedStyle(probe("bar-open"));
    expect(open.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(open.boxShadow).toContain(
      `${rgbOf("var(--status-needs-you-edge)")} 0px 0px 0px 1px inset`,
    );
    // The glow is for a bar, not a swatch.
    expect(open.boxShadow).not.toContain(rgbOf("var(--glow-needs-you)"));
    expect(getComputedStyle(probe("bar-open bar-glow")).boxShadow).toContain(
      rgbOf("var(--glow-needs-you)"),
    );

    const answered = getComputedStyle(probe("bar-answered"));
    expect(answered.backgroundColor).toBe(rgbOf("var(--answered-fill)"));
    expect(answered.boxShadow).toBe(`${rgbOf("var(--status-idle)")} 0px 0px 0px 1.5px inset`);

    const working = getComputedStyle(probe("bar-working"));
    expect(working.backgroundColor).toBe(rgbOf("var(--status-working-fill)"));
    expect(working.boxShadow).toBe(`${rgbOf("var(--status-working-top)")} 0px 1px 0px 0px inset`);

    expect(getComputedStyle(probe("bar-idle")).backgroundColor).toBe(rgbOf("var(--status-idle)"));
    expect(getComputedStyle(probe("stale-dots")).backgroundImage).toContain(
      rgbOf("var(--status-idle)"),
    );
    const tube = getComputedStyle(probe("bar-tube"));
    expect(tube.backgroundColor).toBe(rgbOf("var(--tube)"));
    expect(tube.boxShadow).toContain(rgbOf("var(--tube-rim)"));
  });
});

/** Every colour in a computed background image. */
function coloursOfImage(value: string): Rgba[] {
  return coloursIn(value);
}

/** A shadow token as the browser computes it on an element. */
function shadowOf(expression: string): string {
  const element = document.createElement("div");
  element.style.boxShadow = expression;
  document.body.append(element);
  const value = getComputedStyle(element).boxShadow;
  element.remove();
  return value;
}

/** The blur of the largest layer of a box shadow, in pixels. */
function blurOfDeepestDrop(shadow: string): number {
  const blurs = [...shadow.matchAll(/\) (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px/g)].map((match) =>
    Number(match[3]),
  );
  return Math.max(...blurs);
}

test("the muted ink is kept out of the hero because at night it falls short over the lamp", () => {
  applyTheme("dark");
  // The rule the hero follows has a reason. If this ever reaches 4.5, the rule
  // can be relaxed; until then the hero must not use it.
  const behind = backdrops("dark")["the hero over the lamp's core"] as Rgba;
  const ratio = contrastOf(resolveColour("var(--ink-muted)"), behind);
  expect(ratio).toBeLessThan(4.5);
});

test("night is the default, with no data-theme set", () => {
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(6, 6, 5)");
  expect(rgbOf("var(--glass-card)")).toBe("rgba(13, 12, 11, 0.66)");
  expect(rgbOf("var(--ink)")).toBe("rgb(243, 240, 234)");
  expect(getComputedStyle(document.documentElement).colorScheme).toBe("dark");
});

test("the dark variant follows data-theme", () => {
  const element = probe("text-ink-muted dark:text-status-working");

  applyTheme("dark");
  expect(getComputedStyle(element).color).toBe("rgb(169, 188, 212)");
  applyTheme("light");
  expect(getComputedStyle(element).color).toBe("rgb(91, 86, 79)");
  expect(getComputedStyle(document.documentElement).colorScheme).toBe("light");
});

test("the retired tokens are gone, the navy surfaces among them", () => {
  for (const theme of ["dark", "light"] as const) {
    applyTheme(theme);
    for (const token of RETIRED_TOKENS) {
      expect(raw(token), `${theme} ${token}`).toBe("");
    }
  }
  // Nor do their classes paint anything.
  for (const old of ["bg-surface", "bg-rail", "bg-page", "bg-surface-band", "bg-tint-needs-you"]) {
    expect(getComputedStyle(probe(old)).backgroundColor, old).toBe("rgba(0, 0, 0, 0)");
  }
});

test("real blur is one class, of the glass-blur radius and the theme's saturation, and glass alone has none", () => {
  for (const theme of ["dark", "light"] as const) {
    applyTheme(theme);
    const blurred = getComputedStyle(probe("glass-chrome glass-blur"));
    const saturate = Number(LIGHTS["--saturate"]![theme === "dark" ? 0 : 1].replace("%", "")) / 100;
    expect(blurred.backdropFilter, theme).toBe(`blur(30px) saturate(${saturate})`);
  }
  for (const glass of ["glass-chrome", "glass-card", "glass-raised", "glass-float"]) {
    expect(getComputedStyle(probe(glass)).backdropFilter, glass).toBe("none");
  }
});

test("where the mask cannot be composited, the rim is a plain inset 1px highlight", () => {
  // Chromium supports the mask, so the fallback is read from the stylesheet
  // itself: it must exist, be guarded by the right test, and draw a plain edge.
  const fallbacks: CSSSupportsRule[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSSupportsRule && /mask-composite/.test(rule.conditionText)) {
        fallbacks.push(rule);
      }
      if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) visit(sheet.cssRules);

  expect(fallbacks).toHaveLength(1);
  const [fallback] = fallbacks as [CSSSupportsRule];
  expect(fallback.conditionText.replace(/\s+/g, " ")).toBe(
    "not ((mask-composite: exclude) or (-webkit-mask-composite: xor))",
  );
  // The guard is false here, so the mask draws the rim in this browser.
  expect(CSS.supports(fallback.conditionText)).toBe(false);
  const [rule] = [...fallback.cssRules] as [CSSStyleRule];
  for (const glass of ["glass-chrome", "glass-card", "glass-raised", "glass-float"]) {
    expect(rule.selectorText, glass).toContain(glass);
  }
  expect(rule.selectorText).toContain("::before");
  expect(rule.style.getPropertyValue("background")).toMatch(/none/);
  expect(rule.style.getPropertyValue("mask")).toMatch(/none/);
  expect(rule.style.getPropertyValue("box-shadow")).toMatch(/inset 0 1px 0 var\(--control-top\)/);
});

test("the corners are the system's own, and the old ones produce nothing", () => {
  const corners: Record<string, string> = {
    "rounded-panel": "24px",
    "rounded-chrome": "22px",
    "rounded-inner": "14px",
    "rounded-row": "10px",
    "rounded-capsule": "999px",
    "rounded-tube": "6px",
    "rounded-bar": "4px",
  };
  for (const [name, value] of Object.entries(corners)) {
    expect(getComputedStyle(probe(name)).borderRadius, name).toBe(value);
  }
  for (const old of [
    "rounded-control",
    "rounded-card",
    "rounded-xs",
    "rounded-sm",
    "rounded-md",
    "rounded-lg",
    "rounded-xl",
  ]) {
    expect(getComputedStyle(probe(old)).borderRadius, old).toBe("0px");
  }
});

test("the type scale is the system's own, the hero's name and wait come down a step at 760px, and old sizes produce nothing", async () => {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(1280, 800);
  const sizes: Record<string, string> = {
    "text-wait": "46px",
    "text-name": "34px",
    "text-stat": "28px",
    "text-unit": "22px",
    "text-wordmark": "19px",
    "text-lead": "16px",
    "text-title": "15px",
    "text-row": "14px",
    "text-body": "13px",
    "text-fact": "12.5px",
    "text-caption": "12px",
    "text-micro": "11px",
  };
  for (const [name, value] of Object.entries(sizes)) {
    expect(getComputedStyle(probe(name)).fontSize, name).toBe(value);
  }
  await page.viewport(760, 800);
  expect(getComputedStyle(probe("text-name")).fontSize).toBe("28px");
  expect(getComputedStyle(probe("text-wait")).fontSize).toBe("38px");
  expect(getComputedStyle(probe("text-stat")).fontSize).toBe("28px");
  await page.viewport(761, 800);
  expect(getComputedStyle(probe("text-name")).fontSize).toBe("34px");

  // Tailwind's own sizes are switched off: they inherit the body's 14px.
  for (const old of ["text-xs", "text-sm", "text-base", "text-lg", "text-xl", "text-2xl"]) {
    expect(getComputedStyle(probe(old)).fontSize, old).toBe("14px");
  }
});

test("the layout's sizes: the rail, the header, the window inset, a control, the timeline's row, label column and bars", async () => {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(1280, 800);
  const sizes: [string, keyof CSSStyleDeclaration, string][] = [
    ["w-rail", "width", "76px"],
    ["h-header", "height", "56px"],
    ["p-window", "paddingTop", "12px"],
    ["h-control", "height", "30px"],
    ["h-track", "height", "30px"],
    ["w-label-col", "width", "188px"],
    ["w-waited-name", "width", "132px"],
    ["h-bar-needs-you", "height", "16px"],
    ["h-bar-working", "height", "10px"],
    ["h-bar-idle", "height", "2px"],
    ["h-button", "height", "28px"],
    ["h-button-hero", "height", "38px"],
  ];
  for (const [name, property, value] of sizes) {
    expect(getComputedStyle(probe(`block ${name}`))[property], name).toBe(value);
  }
  await page.viewport(760, 800);
  expect(getComputedStyle(probe("block w-label-col")).width).toBe("140px");
  expect(getComputedStyle(probe("block w-waited-name")).width).toBe("104px");
  // The old sizes are gone.
  for (const old of ["h-tile", "h-row-lit", "w-edge-lit"]) {
    const style = getComputedStyle(probe(`block ${old}`));
    expect([style.height, style.width].includes("116px") || style.height === "60px", old).toBe(
      false,
    );
  }
});

test("the hatch is one 1px diagonal every 6px in the unmeasured colour, with no ground of its own", () => {
  const style = getComputedStyle(probe("unmeasured-hatch"));
  expect(style.backgroundImage).toBe(
    `repeating-linear-gradient(135deg, ${rgbOf("var(--unmeasured)")} 0px, ${rgbOf("var(--unmeasured)")} 1px, rgba(0, 0, 0, 0) 1px, rgba(0, 0, 0, 0) 6px)`,
  );
  // Glass shows between its lines.
  expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
});

test("words are set in Atkinson Hyperlegible Next, and clock times and literal strings in its mono, tightened", () => {
  const words = getComputedStyle(probe(""));
  const facts = getComputedStyle(probe("font-mono"));

  expect(words.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next"?,/);
  expect(facts.fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono"?,/);
  expect(facts.letterSpacing).toBe(`${-0.02 * parseFloat(facts.fontSize)}px`);
  expect(facts.wordSpacing).toBe(`${-0.22 * parseFloat(facts.fontSize)}px`);
  expect(facts.fontVariantNumeric).toBe("tabular-nums");
});

test("the bundled fonts load from the app itself, in the three weights the interface uses", async () => {
  for (const family of ["Atkinson Hyperlegible Next", "Atkinson Hyperlegible Mono"]) {
    for (const weight of [400, 500, 600]) {
      // `load` resolves with the faces it fetched. An empty list would mean the
      // family is declared but no file was found.
      const faces = await document.fonts.load(`${weight} 14px "${family}"`, "Needs you 04:12");
      expect(faces.length, `${family} ${weight}`).toBeGreaterThan(0);
    }
  }

  const fontFiles = performance
    .getEntriesByType("resource")
    .map((entry) => new URL(entry.name))
    .filter((url) => /\.woff2?$/.test(url.pathname));
  expect(fontFiles.some((url) => /atkinson-hyperlegible-next/.test(url.pathname))).toBe(true);
  expect(fontFiles.some((url) => /atkinson-hyperlegible-mono/.test(url.pathname))).toBe(true);
  for (const url of fontFiles) {
    expect(url.origin).toBe(location.origin);
  }
  // No other family is declared.
  const declared = [...document.fonts].map((face) => face.family.replace(/"/g, ""));
  expect(new Set(declared)).toEqual(
    new Set(["Atkinson Hyperlegible Next", "Atkinson Hyperlegible Mono"]),
  );
});

test("each font face is a .woff2 file and nothing else, so no .woff is shipped", () => {
  const sources: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of rules) {
      if (rule instanceof CSSFontFaceRule) sources.push(rule.style.getPropertyValue("src"));
      else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) visit(sheet.cssRules);

  // Two families in three weights, each in a Latin and an extended Latin file.
  expect(sources).toHaveLength(12);
  for (const src of sources) {
    const urls = [...src.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((match) => match[1]);
    expect(urls, src).toHaveLength(1);
    expect(new URL(urls[0], location.href).pathname, src).toMatch(/\.woff2$/);
    expect(src).toMatch(/format\(["']?woff2["']?\)/);
  }
});

test("the focus ring is 2px of the focus colour, 2px outside what has focus", async () => {
  const button = document.createElement("button");
  button.textContent = "probe";
  document.body.prepend(button);
  onTestFinished(() => button.remove());

  // The ring is for focus the keyboard gave.
  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(button);
  const style = getComputedStyle(button);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.outlineOffset).toBe("2px");
  expect(style.outlineColor).toBe(rgbOf("var(--focus)"));
});

describe("motion", () => {
  /** A ring that breathes the way the waiting lamp does. */
  function lamp(): SVGCircleElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    ring.setAttribute("class", "motion-safe:animate-lamp");
    svg.append(ring);
    document.body.append(svg);
    onTestFinished(() => svg.remove());
    return ring;
  }

  /** A ground with its three fields. */
  function ground(): { ground: HTMLElement; fields: HTMLElement[] } {
    const element = probe("ground");
    element.textContent = "";
    const fields = ["ground-main", "ground-deep", "ground-far"].map((name) => {
      const field = document.createElement("i");
      field.className = name;
      element.append(field);
      return field;
    });
    return { ground: element, fields };
  }

  /** Every rule the page has whose animation names one of these, wherever it is nested. */
  function rulesStarting(names: RegExp): CSSRule[] {
    const starts: CSSRule[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        const style = (rule as CSSStyleRule).style as CSSStyleDeclaration | undefined;
        if (style && names.test(`${style.animation} ${style.animationName}`)) starts.push(rule);
        if ("cssRules" in rule && !(rule instanceof CSSKeyframesRule)) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);
    return starts;
  }

  function guarded(rule: CSSRule): boolean {
    for (let parent = rule.parentRule; parent; parent = parent.parentRule) {
      if (
        parent instanceof CSSMediaRule &&
        /prefers-reduced-motion:\s*no-preference/.test(parent.conditionText)
      ) {
        return true;
      }
    }
    return false;
  }

  test("the lamp breathes once every 3.2 seconds, between two strengths of its ring", () => {
    const style = getComputedStyle(lamp());
    expect(style.animationName).toBe("lamp");
    expect(style.animationDuration).toBe("3.2s");
    expect(style.animationTimingFunction).toBe("ease-in-out");
    expect(style.animationIterationCount).toBe("infinite");
  });

  test("the lamp's breathing, its light rising and the drift are set only where motion is allowed", () => {
    // The waiting lamp, the lamp's light and the three fields each have one. Every
    // one sits inside the guard, so a class named in the docs, say, cannot set it
    // moving under reduced motion.
    for (const names of [/\blamp\b/, /\blamp-rise\b/, /\bdrift-(main|deep|far)\b/]) {
      const starts = rulesStarting(names);
      expect(starts.length, String(names)).toBeGreaterThan(0);
      for (const rule of starts) expect(guarded(rule), rule.cssText).toBe(true);
    }
  });

  test("the drift moves the light by transform alone, slowly, and pauses on request", () => {
    const keyframes: CSSKeyframesRule[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSKeyframesRule && /^drift-/.test(rule.name)) keyframes.push(rule);
        else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) visit(sheet.cssRules);

    expect(keyframes.map((rule) => rule.name).sort()).toEqual([
      "drift-deep",
      "drift-far",
      "drift-main",
    ]);
    for (const rule of keyframes) {
      for (const frame of rule.cssRules) {
        const style = (frame as CSSKeyframeRule).style;
        const properties = [...Array(style.length).keys()].map((index) => style.item(index));
        // Only transform: nothing that makes the page lay out or repaint the glass.
        expect(properties, rule.name).toEqual(["transform"]);
      }
    }

    const { ground: element, fields } = ground();
    for (const field of fields) {
      const style = getComputedStyle(field);
      expect(style.animationName, field.className).toMatch(/^drift-/);
      // Over minutes, not seconds.
      expect(parseFloat(style.animationDuration), field.className).toBeGreaterThanOrEqual(60);
      expect(style.animationPlayState, field.className).toBe("running");
    }
    element.dataset.drift = "paused";
    for (const field of fields) {
      expect(getComputedStyle(field).animationPlayState, field.className).toBe("paused");
    }
  });

  test("under reduced motion the lamp, its light and the drift never start, and anything else that moves stops at once", async () => {
    await preferReducedMotion();
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);

    expect(getComputedStyle(lamp()).animationName).toBe("none");
    expect(getComputedStyle(probe("lamp-light")).animationName).toBe("none");
    for (const field of ground().fields) {
      expect(getComputedStyle(field).animationName, field.className).toBe("none");
    }
    const spinner = getComputedStyle(probe("animate-spin-loader"));
    expect(spinner.animationName).toBe("spin-loader");
    expect(parseFloat(spinner.animationDuration)).toBeLessThan(0.001);
    expect(spinner.animationIterationCount).toBe("1");
    // A transition, such as the switch's sliding thumb, takes no time.
    const thumb = getComputedStyle(probe("transition-transform duration-220"));
    expect(parseFloat(thumb.transitionDuration)).toBeLessThan(0.001);
  });
});
