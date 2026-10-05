import { afterEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { StatusMark, type MarkKind } from "@dashboard/components/ui/status/StatusMark";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";
import { preferReducedMotion } from "@tests/support/browser/media";

const KINDS: MarkKind[] = [
  "needs-you",
  "working",
  "idle",
  "stale",
  "unknown",
  "finished",
  "failed",
  "ended",
  "answered",
  "lookout",
];

/** The mark of this kind in the rendered markup. */
function markOf(container: HTMLElement, kind: MarkKind, nth = 0): SVGSVGElement {
  const marks = container.querySelectorAll<SVGSVGElement>(
    `[data-slot="status-mark"][data-kind="${kind}"]`,
  );
  const mark = marks[nth];
  if (!mark) throw new Error(`No ${kind} mark`);
  return mark;
}

/** The drawing itself, with colour and motion left out: the same markup is the same shape. */
function shapeOf(mark: Element): string {
  return mark.innerHTML.replace(/ class="[^"]*"/g, "");
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("every kind is drawn in its own shape, so a list of them reads without colour", async () => {
  const screen = await render(
    <div>
      {KINDS.map((kind) => (
        <StatusMark key={kind} kind={kind} />
      ))}
    </div>,
  );

  const shapes = KINDS.map((kind) => shapeOf(markOf(screen.container, kind)));
  expect(new Set(shapes).size).toBe(KINDS.length);
  // One 14px square for all of them.
  for (const kind of KINDS) {
    const box = markOf(screen.container, kind).getBoundingClientRect();
    expect([box.width, box.height], kind).toEqual([14, 14]);
  }
});

test("a labelled mark announces its status, and an unlabelled one stays silent", async () => {
  const screen = await render(
    <div>
      {KINDS.map((kind) => (
        <StatusMark key={kind} kind={kind} labelled />
      ))}
      <StatusMark kind='idle' />
    </div>,
  );

  const names = KINDS.map((kind) => markOf(screen.container, kind).getAttribute("aria-label"));
  expect(names).toEqual([
    "Needs you",
    "Working",
    "Idle",
    "Stale",
    "Unknown",
    "Finished",
    "Failed",
    "Ended",
    "Needed you, answered",
    "Agent Lookout",
  ]);
  await expect.element(screen.getByRole("img", { name: "Needs you" })).toBeVisible();
  const silent = markOf(screen.container, "idle", 1);
  expect(silent.getAttribute("aria-hidden")).toBe("true");
  expect(silent.hasAttribute("role")).toBe(false);
});

test.each(["dark", "light"] as const)(
  "in the %s theme only the lit lamp is warm: every other mark is in the cool family",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <div>
        {KINDS.filter((kind) => kind !== "needs-you").map((kind) => (
          <StatusMark key={kind} kind={kind} />
        ))}
        <StatusMark kind='needs-you' unlit />
      </div>,
    );
    expect(warmPaint(screen.container)).toEqual([]);

    // Each is drawn in its own status colour.
    const colour = (kind: MarkKind) => getComputedStyle(markOf(screen.container, kind)).color;
    expect(colour("working")).toBe(rgbOf("var(--status-working)"));
    for (const kind of ["idle", "stale", "unknown", "answered", "lookout"] as const) {
      expect(colour(kind), kind).toBe(rgbOf("var(--status-idle)"));
    }
    expect(colour("finished")).toBe(rgbOf("var(--status-finished)"));
    expect(colour("failed")).toBe(rgbOf("var(--status-finished)"));
    expect(colour("ended")).toBe(rgbOf("var(--ink-muted)"));
  },
);

test("an ending with no word on how is a level dash, drawn with the tick's and the cross's stroke", async () => {
  const screen = await render(
    <div>
      <StatusMark kind='finished' />
      <StatusMark kind='failed' />
      <StatusMark kind='ended' />
      <StatusMark kind='unknown' />
    </div>,
  );
  const paths = (kind: MarkKind) => [...markOf(screen.container, kind).querySelectorAll("path")];
  const [dash] = paths("ended") as [SVGPathElement];

  // One stroke and nothing round about it: no ring, so it is not the unknown mark.
  expect(paths("ended")).toHaveLength(1);
  expect(markOf(screen.container, "ended").querySelectorAll("circle, rect")).toHaveLength(0);
  const box = dash.getBBox();
  expect(box.height).toBe(0);
  // Short, and centred in the 14px square.
  expect(box.width).toBeGreaterThanOrEqual(6);
  expect(box.width).toBeLessThanOrEqual(8);
  expect(box.x + box.width / 2).toBe(7);
  expect(box.y).toBe(7);
  // The same weight and ends as the other two endings, so the three read as one family.
  for (const kind of ["finished", "failed"] as const) {
    const [stroke] = paths(kind) as [SVGPathElement];
    expect(getComputedStyle(dash).strokeWidth, kind).toBe(getComputedStyle(stroke).strokeWidth);
    expect(getComputedStyle(dash).strokeLinecap, kind).toBe(getComputedStyle(stroke).strokeLinecap);
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme the lamp is lit in the needs-you colours, and unlit it is a hollow ring in ink",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <div>
        <StatusMark kind='needs-you' />
        <StatusMark kind='needs-you' unlit />
      </div>,
    );
    const lit = markOf(screen.container, "needs-you", 0);
    const unlit = markOf(screen.container, "needs-you", 1);
    const lamp = (mark: Element) => getComputedStyle(mark.querySelector('[data-part="lamp"]')!);

    expect(lit.dataset.lit).toBe("true");
    // The outline is the edge colour, which holds its contrast in daylight, and the fill sits inside it.
    expect(getComputedStyle(lit).color).toBe(rgbOf("var(--status-needs-you-edge)"));
    expect(lamp(lit).stroke).toBe(rgbOf("var(--status-needs-you-edge)"));
    expect(lamp(lit).fill).toBe(rgbOf("var(--status-needs-you)"));

    expect(unlit.dataset.lit).toBe("false");
    expect(getComputedStyle(unlit).color).toBe(rgbOf("var(--ink)"));
    expect(lamp(unlit).fill).toBe("none");
    expect(warmPaint(unlit)).toEqual([]);
    // The same rings: only the light in them changes.
    expect(unlit.querySelectorAll("circle")).toHaveLength(lit.querySelectorAll("circle").length);
  },
);

test("the lamp breathes only when asked, only while lit, and never under reduced motion", async () => {
  const screen = await render(
    <div>
      <StatusMark kind='needs-you' breathing />
      <StatusMark kind='needs-you' />
      <StatusMark kind='needs-you' unlit breathing />
      <StatusMark kind='answered' breathing />
    </div>,
  );
  const halo = (kind: MarkKind, nth: number) =>
    getComputedStyle(markOf(screen.container, kind, nth).querySelector('[data-part="halo"]')!);

  expect(halo("needs-you", 0).animationName).toBe("lamp");
  expect(halo("needs-you", 0).animationDuration).toBe("3.2s");
  expect(markOf(screen.container, "needs-you", 0).dataset.breathing).toBe("true");
  expect(halo("needs-you", 1).animationName).toBe("none");
  expect(halo("needs-you", 2).animationName).toBe("none");
  expect(halo("answered", 0).animationName).toBe("none");
  // Nothing in any other mark moves.
  expect(screen.container.getAnimations({ subtree: true })).toHaveLength(1);

  await preferReducedMotion();
  expect(halo("needs-you", 0).animationName).toBe("none");
  expect(screen.container.getAnimations({ subtree: true })).toHaveLength(0);
});
