import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { WaitedOnYou } from "@dashboard/components/hero/WaitedOnYou";
import type { WaitedOnYou as Waits } from "@dashboard/lib/waits";
import { rgbOf, warmPaint } from "@tests/support/colours";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const at = (hours: number, minutes: number, seconds = 0) =>
  new Date(2026, 0, 5, hours, minutes, seconds).getTime();

const NOW = at(14, 32, 30);

/** Three sessions that waited: one still waiting, two answered, the last cut at the period's start. */
function waits(overrides: Partial<Waits> = {}): Waits {
  const sessions = [
    { id: "a", name: "demo-project", ms: 4 * MINUTE + 11 * SECOND, open: true, startKnown: true },
    { id: "b", name: "project-2", ms: MINUTE + 40 * SECOND, open: false, startKnown: true },
    { id: "c", name: "project-3", ms: 30 * SECOND, open: false, startKnown: false },
  ];
  return {
    period: { from: at(13, 32, 30), to: NOW, bound: "held", today: false },
    sessions,
    totalMs: sessions.reduce((sum, s) => sum + s.ms, 0),
    gaps: [{ from: at(14, 6), to: at(14, 10) }],
    unmeasuredMs: 4 * MINUTE,
    lastWait: null,
    ...overrides,
  };
}

function renderWaits(value: Waits | null) {
  return render(
    <div style={{ width: 760 }}>
      <WaitedOnYou waits={value} />
    </div>,
  );
}

const rows = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-part="waited"]'),
];
const piece = (row: HTMLElement, name: string) =>
  row.querySelector(`[data-part="${name}"]`) as HTMLElement;

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(414, 896);
});

test("one bar per session that waited, in the order given, each with its name, its track and its value", async () => {
  const screen = await renderWaits(waits());

  await expect
    .element(screen.getByRole("group", { name: "Waited on you since 13:32" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("heading", { level: 3, name: "Waited on you since 13:32" }))
    .toBeVisible();
  expect(rows(screen.container).map((row) => piece(row, "who").textContent)).toEqual([
    "demo-project",
    "project-2",
    "project-3",
  ]);
  expect(rows(screen.container).map((row) => piece(row, "value").textContent)).toEqual([
    "4m 11s",
    "1m 40s",
    "30s",
  ]);
  // The total sits on the right.
  expect(screen.container.querySelector('[data-part="total"]')?.textContent).toBe("6m 21s in all");
});

test.each(["dark", "light"] as const)(
  "in the %s theme a wait still open is a filled amber bar with its glow, and an answered one is outlined in the idle colour",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderWaits(waits());
    const [open, answered] = rows(screen.container) as [HTMLElement, HTMLElement];
    const openBar = getComputedStyle(piece(open, "bar"));
    const answeredBar = getComputedStyle(piece(answered, "bar"));

    expect(open.dataset.open).toBe("true");
    expect(openBar.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(openBar.boxShadow).toContain(rgbOf("var(--glow-needs-you)"));
    expect(getComputedStyle(piece(open, "value")).color).toBe(rgbOf("var(--label-needs-you)"));
    expect(getComputedStyle(piece(open, "who")).color).toBe(rgbOf("var(--ink)"));

    // Not by colour alone: answered is an outline, faintly filled.
    expect(answered.dataset.open).toBe("false");
    expect(answeredBar.backgroundColor).toBe(rgbOf("var(--answered-fill)"));
    expect(answeredBar.boxShadow).toBe(`${rgbOf("var(--status-idle)")} 0px 0px 0px 1.5px inset`);
    expect(getComputedStyle(piece(answered, "value")).color).toBe(rgbOf("var(--ink-secondary)"));
    expect(warmPaint(answered)).toEqual([]);

    // With no wait open, nothing here is warm.
    await screen.rerender(
      <WaitedOnYou
        waits={waits({ sessions: waits().sessions.map((s) => ({ ...s, open: false })) })}
      />,
    );
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("each track says in words what it shows, a wait cut at the period's start as a minimum", async () => {
  const screen = await renderWaits(waits());
  const labels = rows(screen.container).map((row) =>
    piece(row, "track").getAttribute("aria-label"),
  );

  expect(labels).toEqual([
    "demo-project has waited 4 minutes 11 seconds, still waiting",
    "project-2 waited 1 minute 40 seconds, answered",
    "project-3 waited at least 30 seconds, answered",
  ]);
  for (const row of rows(screen.container)) {
    expect(piece(row, "track").getAttribute("role")).toBe("img");
    // The value on screen repeats the label, so it is not read twice.
    expect(piece(row, "value").getAttribute("aria-hidden")).toBe("true");
  }
});

test("bars are drawn to a scale of at least seven minutes, so a short wait reads as short", async () => {
  const screen = await renderWaits(waits());
  const share = (row: HTMLElement) =>
    piece(row, "bar").getBoundingClientRect().width /
    piece(row, "track").getBoundingClientRect().width;
  const [open, answered] = rows(screen.container) as [HTMLElement, HTMLElement];

  // The longest is 4m 11s, under seven minutes, so seven minutes is the full track.
  expect(share(open)).toBeCloseTo((4 * 60 + 11) / (7 * 60), 2);
  expect(share(answered)).toBeCloseTo(100 / (7 * 60), 2);

  // Past seven minutes the longest wait fills the track.
  const longer = waits({
    sessions: [
      { id: "a", name: "demo-project", ms: 14 * MINUTE, open: true, startKnown: true },
      { id: "b", name: "project-2", ms: 7 * MINUTE, open: false, startKnown: true },
    ],
  });
  await screen.rerender(<WaitedOnYou waits={longer} />);
  const [first, second] = rows(screen.container) as [HTMLElement, HTMLElement];
  expect(share(first)).toBeCloseTo(1, 2);
  expect(share(second)).toBeCloseTo(0.5, 2);
});

test("an open wait's bar grows as it goes on", async () => {
  const screen = await renderWaits(waits());
  const width = () =>
    piece(rows(screen.container)[0] as HTMLElement, "bar").getBoundingClientRect().width;
  const before = width();

  const later = waits();
  (later.sessions[0] as Waits["sessions"][number]).ms += MINUTE;
  await screen.rerender(<WaitedOnYou waits={later} />);

  expect(width()).toBeGreaterThan(before);
  expect(piece(rows(screen.container)[0] as HTMLElement, "value").textContent).toBe("5m 11s");
});

test("the note says from when it was measured and how much was not, in plain words", async () => {
  const screen = await renderWaits(waits());
  const note = () => screen.container.querySelector('[data-part="note"]')?.textContent;

  expect(note()).toBe("Measured since 13:32, with 4m 00s not measured after 14:06.");

  await screen.rerender(<WaitedOnYou waits={waits({ gaps: [], unmeasuredMs: 0 })} />);
  expect(note()).toBe("Measured since 13:32.");
});

test("it says today only when the period reaches back to midnight", async () => {
  const screen = await renderWaits(
    waits({ period: { from: at(0, 0), to: NOW, bound: "midnight", today: true }, gaps: [] }),
  );

  await expect.element(screen.getByRole("group", { name: "Waited on you today" })).toBeVisible();
  expect(screen.container.querySelector("h3")?.textContent).toBe("Waited on you today");
  // The note still says where the measuring began.
  expect(screen.container.querySelector('[data-part="note"]')?.textContent).toBe(
    "Measured since 00:00.",
  );
});

test("with no session waiting in the period it says so, with no bars and no total", async () => {
  const screen = await renderWaits(waits({ sessions: [], totalMs: 0 }));

  expect(rows(screen.container)).toHaveLength(0);
  expect(screen.container.querySelector('[data-part="total"]')).toBeNull();
  expect(screen.container.querySelector('[data-part="note"]')?.textContent).toBe(
    "No session waited on you. Measured since 13:32, with 4m 00s not measured after 14:06.",
  );
});

test("without the history it claims nothing, and says why", async () => {
  const screen = await renderWaits(null);

  await expect.element(screen.getByRole("group", { name: "Waited on you" })).toBeVisible();
  expect(rows(screen.container)).toHaveLength(0);
  expect(screen.container.querySelector('[data-part="note"]')?.textContent).toBe(
    "The history could not be read, so how long sessions waited is not known.",
  );
});

test.each([375, 1280])(
  "at %i pixels a long name is cut inside the hero, stays reachable in full, and its value and the total stay in sight",
  async (width) => {
    await page.viewport(width, 800);
    const long = "a-session-name-far-too-long-for-the-bars-of-waits-to-show-whole-ok";
    const value = waits();
    value.sessions[0] = { ...value.sessions[0]!, name: long };
    const screen = await render(
      <div style={{ width: width === 375 ? 296 : 760 }}>
        <WaitedOnYou waits={value} />
      </div>,
    );
    const frame = screen.container.firstElementChild as HTMLElement;
    const right = frame.getBoundingClientRect().right;
    const [row] = rows(screen.container) as [HTMLElement];
    const who = piece(row, "who");

    // Nothing reaches past the hero, so the page never scrolls sideways.
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const element of frame.querySelectorAll("*")) {
      expect(
        element.getBoundingClientRect().right,
        element.outerHTML.slice(0, 60),
      ).toBeLessThanOrEqual(right + 0.5);
    }
    // The value and the total are whole and in sight.
    const shown = piece(row, "value");
    expect(shown.textContent).toBe("4m 11s");
    expect(shown.scrollWidth).toBeLessThanOrEqual(shown.clientWidth);
    const total = screen.container.querySelector('[data-part="total"]') as HTMLElement;
    expect(total.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
    // The name is cut with an ellipsis, and is a Tab stop whose tooltip has it all.
    await expect.poll(() => who.dataset.cut).toBe("true");
    expect(who.textContent).toBe(long);
    expect(getComputedStyle(who).textOverflow).toBe("ellipsis");
    expect(who.getAttribute("tabindex")).toBe("0");
    expect(piece(row, "track").getAttribute("aria-label")).toContain(long);
  },
);

test("in a narrow window each bar takes the whole width under its name and value", async () => {
  await page.viewport(375, 800);
  const screen = await render(
    <div style={{ width: 320 }}>
      <WaitedOnYou waits={waits()} />
    </div>,
  );
  const [row] = rows(screen.container) as [HTMLElement];
  const track = piece(row, "track").getBoundingClientRect();
  const who = piece(row, "who").getBoundingClientRect();

  expect(track.width).toBeCloseTo(row.getBoundingClientRect().width, 0);
  expect(track.top).toBeGreaterThanOrEqual(who.bottom);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
