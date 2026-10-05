import { afterEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { StatusTrack, type TrackSegment } from "@dashboard/components/ui/charts/StatusTrack";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";
import { atFullSize, hatchedAlong, pixelsOf } from "@tests/support/browser/pixels";

const START = new Date(2026, 0, 5, 17, 0, 0).getTime();
const END = START + 60 * 60_000;
const at = (minutes: number) => START + minutes * 60_000;

/** Ten stretches across the hour, one of each way a track can be drawn. */
const EVERY_KIND: TrackSegment[] = [
  { from: at(0), to: at(6), kind: "unmeasured" },
  { from: at(6), to: at(12), kind: "working" },
  { from: at(12), to: at(18), kind: "needs-you" },
  { from: at(18), to: at(24), kind: "idle" },
  { from: at(24), to: at(30), kind: "stale" },
  { from: at(30), to: at(36), kind: "unknown" },
  { from: at(36), to: at(42), kind: "working" },
  { from: at(42), to: at(48), kind: "finished" },
  { from: at(48), to: at(54), kind: "failed" },
  { from: at(54), to: at(60), kind: "needs-you", ongoing: true, open: true },
];

function renderTrack(segments: readonly TrackSegment[] = EVERY_KIND) {
  return render(
    <div style={{ width: 720, padding: 20 }}>
      <StatusTrack segments={segments} start={START} end={END} label='demo-project' />
    </div>,
  );
}

function stretches(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-part="segment"]')];
}

/** The mark inside a stretch, and its box. */
function markOf(stretch: HTMLElement) {
  const mark = stretch.querySelector<HTMLElement>('[data-part="mark"]');
  return { mark, box: mark?.getBoundingClientRect(), style: mark && getComputedStyle(mark) };
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("a track is 30px tall, and every stretch takes its whole height to be pointed at", async () => {
  const screen = await renderTrack();
  const track = screen.container.querySelector('[data-slot="status-track"]') as HTMLElement;

  expect(track.getBoundingClientRect().height).toBe(30);
  for (const stretch of stretches(screen.container)) {
    expect(stretch.getBoundingClientRect().height, stretch.dataset.kind).toBe(30);
  }
  await expect
    .element(screen.getByRole("group", { name: /^demo-project: status over time/ }))
    .toBeVisible();
});

test("height says how much a stretch wanted the person: 16px waiting, 10px working, 2px idle", async () => {
  const screen = await renderTrack();
  const [, working, answered, idle, stale, unknown] = stretches(screen.container);
  const open = stretches(screen.container).at(-1) as HTMLElement;

  expect(markOf(open).box?.height).toBe(16);
  expect(markOf(answered!).box?.height).toBe(16);
  expect(markOf(working!).box?.height).toBe(10);
  expect(markOf(idle!).box?.height).toBe(2);
  expect(markOf(stale!).box?.height).toBe(2);
  expect(markOf(unknown!).box?.height).toBe(6);
  // Each is centred in the track.
  const track = open.getBoundingClientRect();
  for (const stretch of [open, working!, idle!]) {
    const box = markOf(stretch).box!;
    expect(box.top - track.top).toBeCloseTo(track.bottom - box.bottom, 0);
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme a wait still open is amber with its glow, and one that ended is hollow in the idle colour, faintly filled",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderTrack();
    const all = stretches(screen.container);
    const answered = all[2] as HTMLElement;
    const open = all.at(-1) as HTMLElement;

    expect(open.dataset.open).toBe("true");
    expect(markOf(open).style?.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(markOf(open).style?.boxShadow).toContain(rgbOf("var(--status-needs-you-edge)"));
    expect(markOf(open).style?.boxShadow).toContain(rgbOf("var(--glow-needs-you)"));

    // The same fills as everywhere else: the answered fill inside a 1.5px edge.
    expect(answered.dataset.open).toBe("false");
    expect(markOf(answered).style?.backgroundColor).toBe(rgbOf("var(--answered-fill)"));
    expect(markOf(answered).style?.boxShadow).toBe(
      `${rgbOf("var(--status-idle)")} 0px 0px 0px 1.5px inset`,
    );
    // Amber is only for the wait that is open now.
    expect(warmPaint(answered)).toEqual([]);
    for (const stretch of all.slice(0, -1)) {
      expect(warmPaint(stretch), stretch.dataset.kind).toEqual([]);
    }

    expect(markOf(all[1]!).style?.backgroundColor).toBe(rgbOf("var(--status-working-fill)"));
    // Working is lit along its top.
    expect(markOf(all[1]!).style?.boxShadow).toBe(
      `${rgbOf("var(--status-working-top)")} 0px 1px 0px 0px inset`,
    );
    expect(markOf(all[3]!).style?.backgroundColor).toBe(rgbOf("var(--status-idle)"));
  },
);

test("stale is the idle line broken into dots, and unknown a hollow band", async () => {
  const screen = await renderTrack();
  const [, , , idle, stale, unknown] = stretches(screen.container);

  expect(markOf(stale!).style?.backgroundImage).toContain("repeating-linear-gradient");
  expect(markOf(stale!).style?.backgroundImage).toContain(rgbOf("var(--status-idle)"));
  expect(markOf(stale!).style?.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(markOf(idle!).style?.backgroundImage).toBe("none");

  expect(markOf(unknown!).style?.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(markOf(unknown!).style?.boxShadow).toContain(rgbOf("var(--status-idle)"));
});

test("finished is an upright tick at the moment it ended, failed a small cross, and nothing after either", async () => {
  const screen = await renderTrack();
  const all = stretches(screen.container);
  const finished = all[7] as HTMLElement;
  const failed = all[8] as HTMLElement;

  const tick = markOf(finished).box!;
  expect([tick.width, tick.height]).toEqual([2, 12]);
  expect(tick.left).toBeCloseTo(finished.getBoundingClientRect().left, 0);
  expect(markOf(finished).style?.backgroundColor).toBe(rgbOf("var(--status-finished)"));

  const cross = failed.querySelector('svg[data-part="mark"]') as SVGSVGElement;
  expect(cross).not.toBeNull();
  const crossBox = cross.getBoundingClientRect();
  expect(crossBox.width).toBe(10);
  // Centred on the moment it failed.
  expect(crossBox.left + crossBox.width / 2).toBeCloseTo(failed.getBoundingClientRect().left, 0);
  expect(getComputedStyle(cross).color).toBe(rgbOf("var(--status-finished)"));

  // The rest of each stretch is empty: no line runs on after an ending.
  for (const stretch of [finished, failed]) {
    expect(stretch.querySelectorAll('[data-part="mark"]')).toHaveLength(1);
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme time nobody measured is hatched down the track, 3px in from its edges, and nothing else is",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    await atFullSize();
    const screen = await renderTrack([
      { from: at(0), to: at(20), kind: "unmeasured", startKnown: false },
      { from: at(20), to: at(40), kind: "working" },
      { from: at(40), to: at(50), kind: "unmeasured" },
      { from: at(50), to: at(60), kind: "idle", ongoing: true },
    ]);
    const track = screen.container.querySelector('[data-slot="status-track"]') as HTMLElement;
    const hatch = track.querySelector('[data-part="hatch"] .unmeasured-hatch') as HTMLElement;

    // The one hatch, with no ground of its own, so the glass shows between its lines.
    expect(getComputedStyle(hatch).backgroundImage).toContain(
      `repeating-linear-gradient(135deg, ${rgbOf("var(--unmeasured)")}`,
    );
    expect(getComputedStyle(hatch).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    // It shows under the two stretches nobody measured, 3px in from the top and
    // the bottom, and stops 2px short of the end of each like every mark. Behind
    // the working bar and the idle line there is nothing.
    const width = track.getBoundingClientRect().width;
    const x = (minutes: number) => (minutes / 60) * width;
    const pixels = await pixelsOf(track);
    for (const y of [3.5, 15, 26]) {
      expect(hatchedAlong(pixels, y, x(0), x(20) - 2), `first, at ${y}px`).toBe(true);
      expect(hatchedAlong(pixels, y, x(40), x(50) - 2), `second, at ${y}px`).toBe(true);
    }
    for (const y of [4, 26]) {
      expect(hatchedAlong(pixels, y, x(20) - 1.5, x(40) - 1), `behind working, at ${y}px`).toBe(
        false,
      );
      expect(hatchedAlong(pixels, y, x(50) - 1.5, width), `behind idle, at ${y}px`).toBe(false);
    }
  },
);

test("the hatch is laid across the whole track, so its lines fall in the same places on every row", async () => {
  await atFullSize();
  const screen = await render(
    <div style={{ width: 720, padding: 20 }}>
      <StatusTrack
        segments={[
          { from: at(0), to: at(20), kind: "unmeasured" },
          { from: at(20), to: at(60), kind: "idle" },
        ]}
        start={START}
        end={END}
        label='first'
      />
      <StatusTrack
        segments={[
          { from: at(0), to: at(5), kind: "working" },
          { from: at(5), to: at(40), kind: "unmeasured" },
          { from: at(40), to: at(60), kind: "idle" },
        ]}
        start={START}
        end={END}
        label='second'
      />
    </div>,
  );
  const [first, second] = [
    ...screen.container.querySelectorAll<HTMLElement>('[data-slot="status-track"]'),
  ] as [HTMLElement, HTMLElement];
  const [a, b] = [await pixelsOf(first), await pixelsOf(second)];

  // Where both are hatched, minutes 5 to 20, each line of pixels is the same in both.
  const x = (minutes: number) => (minutes / 60) * a.width;
  for (const y of [4, 12, 28]) {
    for (let px = Math.ceil(x(6)); px < x(19); px += 1) {
      expect(a.at(px, y), `at ${px}, ${y}`).toEqual(b.at(px, y));
    }
  }
});

test("time nobody measured has no mark of its own, but keeps its name, its tooltip and its place for the keyboard", async () => {
  const screen = await renderTrack([
    { from: at(0), to: at(20), kind: "unmeasured", startKnown: false },
    { from: at(20), to: at(50), kind: "idle" },
    { from: at(50), to: at(60), kind: "working", ongoing: true },
  ]);
  const [unmeasured, idle, working] = stretches(screen.container) as [
    HTMLElement,
    HTMLElement,
    HTMLElement,
  ];

  // It draws the hatch and nothing else: no mark of its own.
  expect(unmeasured.dataset.kind).toBe("unmeasured");
  expect(unmeasured.querySelector('[data-part="mark"]')).toBeNull();
  expect([...unmeasured.children].map((child) => child.getAttribute("data-part"))).toEqual([
    "hatch",
  ]);
  expect(getComputedStyle(unmeasured).backgroundImage).toBe("none");
  expect(unmeasured.getBoundingClientRect().width).toBeCloseTo(
    (unmeasured.parentElement as HTMLElement).getBoundingClientRect().width / 3,
    0,
  );
  expect(unmeasured.getAttribute("role")).toBe("img");
  expect(unmeasured.getAttribute("aria-label")).toBe(
    "Not measured, at least 20 minutes 0 seconds, 17:00:00 to 17:20:00",
  );

  // Tab lands on the stretch at the present, and Home and the arrows reach the rest.
  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(working);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Working");
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(idle);
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(unmeasured);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Not measured");
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("at least 20m 00s");
  // The first stretch is the end of the line: Left stays there.
  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(unmeasured);
  await userEvent.keyboard("{End}");
  expect(document.activeElement).toBe(working);
  await userEvent.keyboard("{Home}");
  expect(document.activeElement).toBe(unmeasured);

  // One stop on the way through the page, whichever stretch has it.
  expect(stretches(screen.container).map((stretch) => stretch.tabIndex)).toEqual([0, -1, -1]);

  // And a pointer finds it too.
  await userEvent.hover(idle);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Idle");
  await userEvent.hover(unmeasured);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Not measured");
  await pointAway();
});

test("a wait that ended reads as one that needed the person, and the open one as so far", async () => {
  const screen = await renderTrack([
    { from: at(10), to: at(14), kind: "needs-you" },
    { from: at(14), to: at(56), kind: "working" },
    { from: at(56), to: at(60), kind: "needs-you", ongoing: true, open: true },
  ]);
  const [ended, , open] = stretches(screen.container) as [HTMLElement, HTMLElement, HTMLElement];

  expect(ended.getAttribute("aria-label")).toBe(
    "Needed you, 4 minutes 0 seconds, 17:10:00 to 17:14:00",
  );
  expect(open.getAttribute("aria-label")).toBe(
    "Needs you, 4 minutes 0 seconds so far, 17:56:00 to now",
  );
});

test.each(["dark", "light"] as const)(
  "in the %s theme an open wait that stops short of the present is still amber, but reads as a minimum that ends where it was last seen",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderTrack([
      { from: at(10), to: at(48), kind: "working" },
      { from: at(48), to: at(52), kind: "needs-you", startKnown: true, open: true },
      { from: at(52), to: at(60), kind: "unmeasured", startKnown: true, ongoing: true },
    ]);
    const [, wait, tail] = stretches(screen.container) as [HTMLElement, HTMLElement, HTMLElement];

    // Open is the colour: nobody answered it.
    expect(wait.dataset.open).toBe("true");
    expect(markOf(wait).box?.height).toBe(16);
    expect(markOf(wait).style?.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    // Ongoing is the present: only the stretch after it reaches now.
    expect(wait.getAttribute("aria-label")).toBe(
      "Needs you, at least 4 minutes 0 seconds, 17:48:00 to 17:52:00",
    );
    expect(tail.getAttribute("aria-label")).toBe(
      "Not measured, 8 minutes 0 seconds so far, 17:52:00 to now",
    );

    await userEvent.hover(wait);
    const tooltip = page.getByRole("tooltip");
    await expect.element(tooltip).toHaveTextContent("Needs you");
    await expect.element(tooltip).toHaveTextContent("at least 4m 00s");
    await expect.element(tooltip).toHaveTextContent("17:48:00 to 17:52:00");
    await expect.element(tooltip).not.toHaveTextContent("so far");
    await pointAway();
  },
);

test("open means nothing on any stretch but a wait", async () => {
  const screen = await renderTrack([
    { from: at(40), to: at(50), kind: "working", open: true },
    { from: at(50), to: at(60), kind: "idle", ongoing: true, open: true },
  ]);
  const [working, idle] = stretches(screen.container) as [HTMLElement, HTMLElement];

  expect(working.dataset.open).toBeUndefined();
  expect(working.getAttribute("aria-label")).toBe(
    "Working, 10 minutes 0 seconds, 17:40:00 to 17:50:00",
  );
  expect(idle.getAttribute("aria-label")).toBe(
    "Idle, 10 minutes 0 seconds so far, 17:50:00 to now",
  );
  expect(warmPaint(screen.container)).toEqual([]);
});

test("nothing in a track moves", async () => {
  const screen = await renderTrack();
  expect(screen.container.getAnimations({ subtree: true })).toHaveLength(0);
});

test("the track draws its own time rules, and stops each where its time was not measured", async () => {
  await atFullSize();
  const screen = await render(
    <div style={{ width: 720, padding: 20 }}>
      <StatusTrack
        segments={[
          { from: at(0), to: at(20), kind: "unmeasured" },
          { from: at(20), to: at(60), kind: "idle", ongoing: true },
        ]}
        start={START}
        end={END}
        label='demo-project'
        rules={[at(-5), at(10), at(30), at(45), at(65)]}
      />
    </div>,
  );
  const track = screen.container.querySelector('[data-slot="status-track"]') as HTMLElement;
  const layer = track.querySelector('[data-part="rules"]') as HTMLElement;

  // One rule for each moment inside the window, a hairline from top to bottom.
  expect(layer.children).toHaveLength(3);
  const rule = getComputedStyle(layer.children[0] as Element);
  expect(rule.backgroundColor).toBe(rgbOf("var(--hairline)"));
  expect(rule.width).toBe("1px");
  expect(layer.getAttribute("aria-hidden")).toBe("true");

  // Above the hatch, where nothing else is drawn, the rule at 10 minutes is cut
  // away and the one at 30 shows. The hatch has no ground of its own on glass,
  // so this is what keeps a rule from running through it.
  const pixels = await pixelsOf(track);
  const x = (minutes: number) => (minutes / 60) * pixels.width;
  const drawnNear = (minutes: number, y: number) => {
    const ground = pixels.at(x(minutes) + 6, y);
    for (let px = x(minutes) - 1; px <= x(minutes) + 1.5; px += 0.5) {
      const colour = pixels.at(px, y);
      if (colour.slice(0, 3).some((channel, i) => Math.abs(channel - ground[i]!) > 4)) return true;
    }
    return false;
  };
  expect(drawnNear(10, 1)).toBe(false);
  expect(drawnNear(30, 1)).toBe(true);
  expect(drawnNear(45, 8)).toBe(true);
});

test("without rules, or with none inside the window, the track draws none", async () => {
  const screen = await render(
    <div style={{ width: 720, padding: 20 }}>
      <StatusTrack segments={EVERY_KIND} start={START} end={END} label='first' />
      <StatusTrack segments={EVERY_KIND} start={START} end={END} label='second' rules={[at(-5)]} />
    </div>,
  );

  expect(screen.container.querySelector('[data-part="rules"]')).toBeNull();
});
