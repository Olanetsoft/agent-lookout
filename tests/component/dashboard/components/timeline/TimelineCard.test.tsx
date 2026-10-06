import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type {
  HistoryPoint,
  Session,
  SessionEvent,
  SessionStatus,
  SourceHealth,
} from "@core/sessions/session";
import { TimelineCard } from "@dashboard/components/timeline/TimelineCard";
import type { CollectorHistory } from "@dashboard/lib/api/collectorStore";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";
import { atFullSize, hatchedAlong, pixelsOf } from "@tests/support/browser/pixels";

const NOW = new Date(2026, 0, 5, 18, 0, 0).getTime();
const MINUTE = 60_000;
const ago = (minutes: number) => NOW - minutes * MINUTE;

const SOURCE: SourceHealth = {
  id: "claude-code",
  label: "Claude Code",
  state: "ok",
  checkedAt: NOW,
};

function id(n: number): string {
  return `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({ id: id(n), startedAt: null, statusSince: null, ...overrides });
}

function polls(from: number, to: number): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (let at = from; at <= to; at += 2_000) {
    points.push({ at, needsYou: 0, working: 0, idle: 1, total: 1 });
  }
  return points;
}

/** A collector that began so many minutes ago and has polled without a break since. */
function running(minutes: number): CollectorHistory {
  return { startedAt: ago(minutes), points: polls(ago(minutes), NOW) };
}

let serial = 0;
function event(
  n: number,
  name: string,
  at: number,
  kind: SessionEvent["kind"],
  from?: SessionStatus,
  to?: SessionStatus,
): SessionEvent {
  serial += 1;
  return {
    id: `event-${serial}`,
    at,
    sessionId: id(n),
    sessionName: name,
    kind,
    ...(from && { from }),
    ...(to && { to }),
    severity: "advisory",
  };
}

const SESSIONS: Session[] = [
  session(1, { name: "idle-one", status: "idle" }),
  session(2, { name: "blocked-one", status: "needs-you", statusSince: ago(4) }),
  session(3, { name: "busy-one", status: "working" }),
];

const EVENTS: SessionEvent[] = [
  event(2, "blocked-one", ago(4), "status-changed", "working", "needs-you"),
  event(4, "gone-one", ago(10), "ended", "idle"),
  event(3, "busy-one", ago(20), "status-changed", "idle", "working"),
  event(4, "gone-one", ago(25), "status-changed", "working", "idle"),
];

/** The same hour with the wait answered: nothing needs the person now. */
const ANSWERED_SESSIONS: Session[] = [
  session(1, { name: "idle-one", status: "idle" }),
  session(2, { name: "blocked-one", status: "working", statusSince: ago(2) }),
  session(3, { name: "busy-one", status: "working" }),
];
const ANSWERED_EVENTS: SessionEvent[] = [
  event(2, "blocked-one", ago(2), "status-changed", "needs-you", "working"),
  ...EVENTS,
];

function rowOf(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>('[data-slot="timeline-row"]')].find(
    (candidate) => candidate.querySelector('[data-part="name"]')?.textContent === name,
  );
  if (!row) throw new Error(`No row named ${name}`);
  return row;
}

function rowNames(container: HTMLElement): (string | null | undefined)[] {
  return [...container.querySelectorAll('[data-slot="timeline-row"]')].map(
    (row) => row.querySelector('[data-part="name"]')?.textContent,
  );
}

function segmentsOf(container: HTMLElement, name: string): HTMLElement[] {
  return [...rowOf(container, name).querySelectorAll<HTMLElement>('[data-part="segment"]')];
}

function legend(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[data-slot="timeline-legend"] li')].map((item) =>
    item.getAttribute("data-kind"),
  );
}

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("there is one row per session, in the order of the Sessions list, then the ones that ended", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );

  await expect.element(screen.getByRole("region", { name: "Timeline" })).toBeVisible();
  await expect
    .element(screen.getByRole("list", { name: "Sessions over the last hour" }))
    .toBeVisible();
  expect(rowNames(screen.container)).toEqual(["blocked-one", "busy-one", "idle-one", "gone-one"]);

  // The one that ended says so to a screen reader, and its track stops.
  const ended = screen.container.querySelector('[data-slot="timeline-row"][data-ended="true"]');
  expect(ended?.querySelector('[data-part="name"]')?.textContent).toBe("gone-one");
  await expect
    .element(screen.getByRole("group", { name: /^gone-one, ended: status over time/ }))
    .toBeVisible();
  const last = segmentsOf(screen.container, "gone-one").at(-1) as HTMLElement;
  const track = last.parentElement as HTMLElement;
  expect(last.getBoundingClientRect().right).toBeLessThan(
    track.getBoundingClientRect().right - track.getBoundingClientRect().width / 10,
  );
});

test("each name has the mark of what its session is doing now, and one that has left the list has none", async () => {
  const screen = await render(
    <TimelineCard
      sessions={[...SESSIONS, session(5, { name: "stale-one", status: "idle", stale: true })]}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );
  const markOf = (name: string) =>
    rowOf(screen.container, name)
      .querySelector('[data-slot="status-mark"]')
      ?.getAttribute("data-kind") ?? null;

  expect(markOf("blocked-one")).toBe("needs-you");
  expect(markOf("busy-one")).toBe("working");
  expect(markOf("idle-one")).toBe("idle");
  expect(markOf("stale-one")).toBe("stale");
  expect(markOf("gone-one")).toBeNull();
  const room = rowOf(screen.container, "gone-one").querySelector('[data-part="no-mark"]');
  expect(room?.getBoundingClientRect().width).toBe(14);
});

test("the label column is 188px wide, 140px at 760 pixels and below, and every row is 30px, with every other row on a zebra fill", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );
  const labelWidth = () => {
    const row = rowOf(screen.container, "busy-one");
    return (
      row.querySelector('[data-slot="status-track"]')!.getBoundingClientRect().left -
      row.getBoundingClientRect().left
    );
  };

  expect(labelWidth()).toBe(188);
  const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="timeline-row"]')];
  for (const row of rows) {
    expect(row.getBoundingClientRect().height).toBe(30);
    // Rounded, so a zebra row reads as a shape on the glass, not a band.
    expect(getComputedStyle(row).borderRadius).toBe("10px");
    expect(getComputedStyle(row).borderBottomWidth).toBe("0px");
  }
  expect(rows.map((row) => getComputedStyle(row).backgroundColor)).toEqual(
    rows.map((_, index) => (index % 2 === 0 ? rgbOf("var(--fill-zebra)") : "rgba(0, 0, 0, 0)")),
  );
  await page.viewport(760, 900);
  expect(labelWidth()).toBe(140);
});

test("each row is drawn by status over time, as the events say, at a height for how much it wanted the person", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );

  const kinds = (name: string) =>
    segmentsOf(screen.container, name).map((segment) => segment.dataset.kind);
  expect(kinds("blocked-one")).toEqual(["working", "needs-you"]);
  expect(kinds("busy-one")).toEqual(["idle", "working"]);
  expect(kinds("idle-one")).toEqual(["idle"]);
  expect(kinds("gone-one")).toEqual(["working", "idle"]);

  // Placed by time: four minutes of sixty is the last fifteenth of the track.
  const [working, waiting] = segmentsOf(screen.container, "blocked-one") as [
    HTMLElement,
    HTMLElement,
  ];
  const track = (waiting.parentElement as HTMLElement).getBoundingClientRect();
  const box = waiting.getBoundingClientRect();
  expect(box.right).toBeCloseTo(track.right, 0);
  expect(box.width / track.width).toBeCloseTo(4 / 60, 2);

  const markHeight = (segment: HTMLElement) =>
    segment.querySelector('[data-part="mark"]')!.getBoundingClientRect().height;
  expect(markHeight(waiting)).toBe(16);
  expect(markHeight(working)).toBe(10);
  expect(markHeight(segmentsOf(screen.container, "idle-one")[0]!)).toBe(2);
});

test.each(["dark", "light"] as const)(
  "in the %s theme the open wait is amber and an answered one is hollow",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <TimelineCard
        sessions={[
          session(2, { name: "blocked-one", status: "needs-you", statusSince: ago(4) }),
          session(6, { name: "answered-one", status: "working", statusSince: ago(30) }),
        ]}
        sources={[SOURCE]}
        events={[
          event(2, "blocked-one", ago(4), "status-changed", "working", "needs-you"),
          event(6, "answered-one", ago(30), "status-changed", "needs-you", "working"),
          event(6, "answered-one", ago(36), "status-changed", "working", "needs-you"),
        ]}
        history={running(120)}
        now={NOW}
      />,
    );
    const open = segmentsOf(screen.container, "blocked-one").at(-1) as HTMLElement;
    const answered = segmentsOf(screen.container, "answered-one").find(
      (segment) => segment.dataset.kind === "needs-you",
    ) as HTMLElement;

    expect(open.dataset.open).toBe("true");
    expect(getComputedStyle(open.querySelector('[data-part="mark"]')!).backgroundColor).toBe(
      rgbOf("var(--status-needs-you)"),
    );
    expect(answered.dataset.open).toBe("false");
    // Hollow in the idle colour, faintly filled: the fill every answered wait has.
    const hollow = getComputedStyle(answered.querySelector('[data-part="mark"]')!);
    expect(hollow.backgroundColor).toBe(rgbOf("var(--answered-fill)"));
    expect(hollow.boxShadow).toBe(`${rgbOf("var(--status-idle)")} 0px 0px 0px 1.5px inset`);
    expect(warmPaint(rowOf(screen.container, "answered-one"))).toEqual([]);
  },
);

/** A row's track, where its stretches and its hatch are drawn. */
function trackOf(container: HTMLElement, name: string): HTMLElement {
  return rowOf(container, name).querySelector('[data-slot="status-track"]') as HTMLElement;
}

/** Where a moment falls along a track, in CSS pixels from its left edge. */
function xOf(track: HTMLElement, minutesAgo: number): number {
  return ((60 - minutesAgo) / 60) * track.getBoundingClientRect().width;
}

test("time nobody measured is hatched on each row it hides, never drawn as idle", async () => {
  await atFullSize();
  const screen = await render(
    <TimelineCard
      sessions={[
        session(1, { name: "idle-one", status: "idle" }),
        session(3, { name: "busy-one", status: "working" }),
      ]}
      sources={[SOURCE]}
      events={[]}
      history={running(15)}
      now={NOW}
    />,
  );

  // The track keeps the stretch, with its name, and draws no bar or line for it.
  const [unmeasured, idle] = segmentsOf(screen.container, "idle-one") as [HTMLElement, HTMLElement];
  expect(unmeasured.dataset.kind).toBe("unmeasured");
  expect(unmeasured.querySelector('[data-part="mark"]')).toBeNull();
  expect(idle.dataset.kind).toBe("idle");
  const track = (idle.parentElement as HTMLElement).getBoundingClientRect();
  expect(unmeasured.getBoundingClientRect().width / track.width).toBeCloseTo(45 / 60, 2);
  expect(idle.getBoundingClientRect().width / track.width).toBeCloseTo(15 / 60, 2);
  expect(unmeasured.getAttribute("role")).toBe("img");
  expect(unmeasured.getAttribute("aria-label")).toMatch(/^Not measured, at least 45 minutes/);

  // Each row carries the one hatch for itself: there is no band across the card.
  expect(screen.container.querySelector('[data-slot="timeline-gaps"]')).toBeNull();
  for (const name of ["idle-one", "busy-one"]) {
    const own = trackOf(screen.container, name);
    const hatch = own.querySelector('[data-part="hatch"] .unmeasured-hatch') as HTMLElement;
    expect(hatch, name).not.toBeNull();
    const pixels = await pixelsOf(own);
    expect(hatchedAlong(pixels, 6, 0, xOf(own, 15) - 2), name).toBe(true);
    expect(hatchedAlong(pixels, 6, xOf(own, 15), pixels.width), name).toBe(false);
  }
});

test("a break in the polls and the time after answers stop are hatched on the row, and nothing else is", async () => {
  await atFullSize();
  const lastAnswer = ago(6);
  const screen = await render(
    <TimelineCard
      sessions={[session(1, { name: "idle-one", status: "idle" })]}
      sources={[SOURCE]}
      events={[]}
      history={{
        startedAt: ago(120),
        points: [...polls(ago(120), ago(40)), ...polls(ago(36), lastAnswer)],
      }}
      now={NOW}
      asOf={lastAnswer}
    />,
  );

  const track = trackOf(screen.container, "idle-one");
  const pixels = await pixelsOf(track);
  const x = (minutesAgo: number) => xOf(track, minutesAgo);
  // The break, from 40 to 36 minutes ago, and the six minutes since the last answer.
  expect(hatchedAlong(pixels, 6, x(40), x(36) - 2)).toBe(true);
  expect(hatchedAlong(pixels, 6, x(6), pixels.width - 2)).toBe(true);
  // The idle stretches either side of the break.
  expect(hatchedAlong(pixels, 6, 0, x(40) - 2)).toBe(false);
  expect(hatchedAlong(pixels, 6, x(36), x(6) - 2)).toBe(false);
});

test("a status its source vouches for is drawn with no hatch behind it, though other rows are hatched there", async () => {
  await atFullSize();
  const screen = await render(
    <TimelineCard
      sessions={[
        session(3, { name: "busy-one", status: "working", statusSince: ago(40) }),
        session(1, { name: "idle-one", status: "idle" }),
      ]}
      sources={[SOURCE]}
      events={[]}
      history={running(15)}
      now={NOW}
    />,
  );

  // Watching began 15 minutes ago. The source says busy-one has worked for 40.
  const busy = trackOf(screen.container, "busy-one");
  const idle = trackOf(screen.container, "idle-one");
  const bar = busy
    .querySelector('[data-kind="working"] [data-part="mark"]')!
    .getBoundingClientRect();
  expect(bar.left - busy.getBoundingClientRect().left).toBeCloseTo(xOf(busy, 40), 0);

  const [busyPixels, idlePixels] = [await pixelsOf(busy), await pixelsOf(idle)];
  // From 40 to 15 minutes ago only the row that was not vouched for is hatched,
  // above its bar and below it as well as where the bar is not.
  for (const y of [5, 25]) {
    expect(hatchedAlong(busyPixels, y, xOf(busy, 40) - 1.5, xOf(busy, 15)), `at ${y}px`).toBe(
      false,
    );
    expect(hatchedAlong(idlePixels, y, xOf(idle, 40), xOf(idle, 15) - 2), `at ${y}px`).toBe(true);
  }
  // Before the source's word, nothing is known of busy-one either.
  expect(hatchedAlong(busyPixels, 5, 0, xOf(busy, 40) - 2)).toBe(true);
});

test("each track's time rules stop where its time was not measured, and its stretches lie over them", async () => {
  await atFullSize();
  const screen = await render(
    <TimelineCard
      sessions={[session(1, { name: "idle-one", status: "idle" })]}
      sources={[SOURCE]}
      events={[]}
      history={running(15)}
      now={NOW}
    />,
  );

  const track = trackOf(screen.container, "idle-one");
  // The rules are placed once the axis has been measured.
  await expect
    .poll(() => track.querySelectorAll('[data-part="rules"] > span').length)
    .toBeGreaterThan(0);
  const layer = track.querySelector('[data-part="rules"]') as HTMLElement;
  // The hatch has no ground of its own on glass, so the rules are cut away where
  // it is, by a mask on the layer they are drawn in.
  const hatch = track.querySelector('[data-part="hatch"] .unmeasured-hatch') as HTMLElement;
  expect(getComputedStyle(hatch).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(layer).maskImage).toMatch(/linear-gradient/);
  expect(getComputedStyle(layer).pointerEvents).toBe("none");
  // The stretches take the pointer, wherever a rule runs under them.
  const rules = [...layer.querySelectorAll<HTMLElement>(":scope > span")];
  for (const rule of rules) {
    const box = rule.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + 0.5, box.top + box.height / 2);
    expect(hit?.closest('[data-part="segment"]')).not.toBeNull();
  }

  // Down each rule, above and below the hatch and the idle line: it shows where
  // the row was measured, from 15 minutes ago, and nowhere in the hatched
  // stretch before that.
  const pixels = await pixelsOf(track);
  const left = track.getBoundingClientRect().left;
  const xs = rules.map((rule) => rule.getBoundingClientRect().left - left + 0.5);
  const ruleShows = (x: number) =>
    [1, 28].some((y) => {
      const ground = pixels.at(x + 5, y);
      return [x - 1, x, x + 1].some((near) =>
        pixels
          .at(near, y)
          .slice(0, 3)
          .some((channel, index) => Math.abs(channel - ground[index]!) > 4),
      );
    });
  const hidden = xs.filter((x) => x < xOf(track, 15) - 2);
  const shown = xs.filter((x) => x > xOf(track, 15) + 1);
  expect(hidden.length).toBeGreaterThan(0);
  expect(shown.length).toBeGreaterThan(0);
  for (const x of hidden) expect(ruleShows(x), `rule at ${x}px`).toBe(false);
  for (const x of shown) expect(ruleShows(x), `rule at ${x}px`).toBe(true);
});

test("pointing at a stretch says the status and how long it lasted", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );

  const [worked, waiting] = segmentsOf(screen.container, "blocked-one") as [
    HTMLElement,
    HTMLElement,
  ];
  await userEvent.hover(waiting);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toHaveTextContent("Needs you");
  await expect.element(tooltip).toHaveTextContent("4m 00s so far");
  await expect.element(tooltip).toHaveTextContent("17:56:00 to now");

  await userEvent.hover(worked);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Working");
  // It began before the window, so its length is a minimum.
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("at least 56m 00s");
  await pointAway();
});

test("each track is one Tab stop, and the arrow keys move along it", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );
  await expect.element(screen.getByRole("region", { name: "Timeline" })).toBeVisible();

  startAtTop();
  await userEvent.tab();
  const [worked, waiting] = segmentsOf(screen.container, "blocked-one") as [
    HTMLElement,
    HTMLElement,
  ];
  // Tab lands on the stretch at the present.
  expect(document.activeElement).toBe(waiting);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Needs you");
  expect(getComputedStyle(waiting).outlineColor).toBe(rgbOf("var(--focus)"));

  await userEvent.keyboard("{ArrowLeft}");
  expect(document.activeElement).toBe(worked);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("Working");

  // The next Tab leaves the track for the next one.
  await userEvent.tab();
  expect(document.activeElement).toBe(segmentsOf(screen.container, "busy-one").at(-1));
});

test("the axis marks round clock times in mono, and ends at the present with the clock and the word now", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW + 7 * MINUTE + 30_000}
    />,
  );

  const axis = screen.container.querySelector('[data-slot="timeline-axis"]') as HTMLElement;
  await expect
    .poll(() => axis.querySelectorAll('[data-part="time-tick"]').length)
    .toBeGreaterThan(0);
  const ticks = [...axis.querySelectorAll<HTMLElement>('[data-part="time-tick"]')];
  expect(ticks.map((tick) => tick.textContent)).toEqual([
    "17:10",
    "17:20",
    "17:30",
    "17:40",
    "17:50",
    "18:00",
  ]);
  for (const tick of [...ticks, axis]) {
    expect(getComputedStyle(tick).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  }
  expect(getComputedStyle(axis).fontSize).toBe("11px");

  // The right-hand end of the axis is the present, and it is under the end of the tracks.
  const now = axis.querySelector('[data-part="now"]') as HTMLElement;
  expect(now.textContent).toBe("18:07 now");
  const track = screen.container.querySelector('[data-slot="status-track"]') as HTMLElement;
  expect(now.getBoundingClientRect().right).toBeCloseTo(track.getBoundingClientRect().right, 0);
  // No label runs into it.
  const lastTick = ticks.at(-1) as HTMLElement;
  expect(lastTick.getBoundingClientRect().right).toBeLessThan(now.getBoundingClientRect().left);

  // A rule runs down every track at each marked time, in the hairline, so the
  // rules of the rows meet in one line.
  for (const track of screen.container.querySelectorAll<HTMLElement>(
    '[data-slot="status-track"]',
  )) {
    const rules = [...track.querySelectorAll<HTMLElement>('[data-part="rules"] > span')];
    expect(rules).toHaveLength(ticks.length);
    rules.forEach((rule, index) => {
      const tick = (ticks[index] as HTMLElement).getBoundingClientRect();
      expect(rule.getBoundingClientRect().left).toBeCloseTo(tick.left + tick.width / 2, 0);
      expect(getComputedStyle(rule).backgroundColor).toBe(rgbOf("var(--hairline)"));
    });
  }
});

test("the legend sits in the card's head beside 'last hour, one row per session', and names Needs you only while a wait is open", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );
  const head = screen.container.querySelector('[data-slot="section-card"] > header') as HTMLElement;
  const key = screen.getByRole("list", { name: "Legend" });

  expect(head.contains(key.element())).toBe(true);
  expect(head.querySelector('[data-part="sub"]')?.textContent).toBe(
    "last hour, one row per session",
  );
  expect(legend(screen.container)).toEqual([
    "needs-you",
    "answered",
    "working",
    "idle",
    "stale",
    "finished",
    "unmeasured",
  ]);
  expect([...key.element().querySelectorAll("li")].map((item) => item.textContent)).toEqual([
    "Needs you",
    "Answered",
    "Working",
    "Idle",
    "Stale",
    "Finished",
    "Not measured",
  ]);
  // The swatches are the bars' own fills, each a 14px block or line, so the
  // legend reads exactly as the rows and the other charts do.
  const swatch = (kind: string) =>
    key.element().querySelector(`[data-kind="${kind}"] i`) as HTMLElement;
  expect(swatch("needs-you").classList.contains("bar-open")).toBe(true);
  expect(swatch("answered").classList.contains("bar-answered")).toBe(true);
  expect(swatch("working").classList.contains("bar-working")).toBe(true);
  expect(swatch("idle").classList.contains("bar-idle")).toBe(true);
  expect(swatch("stale").classList.contains("stale-dots")).toBe(true);
  expect(swatch("unmeasured").classList.contains("unmeasured-hatch")).toBe(true);
  for (const kind of ["needs-you", "answered", "working", "unmeasured"]) {
    const box = swatch(kind).getBoundingClientRect();
    expect([box.width, box.height], kind).toEqual([14, 10]);
  }
  // A swatch has no glow: that is for a bar.
  expect(getComputedStyle(swatch("needs-you")).boxShadow).not.toContain(
    rgbOf("var(--glow-needs-you)"),
  );
  expect(getComputedStyle(key.element()).fontSize).toBe("12px");

  // The wait is answered: the legend holds no amber either.
  await screen.rerender(
    <TimelineCard
      sessions={ANSWERED_SESSIONS}
      sources={[SOURCE]}
      events={ANSWERED_EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );
  expect(legend(screen.container)).toEqual([
    "answered",
    "working",
    "idle",
    "stale",
    "finished",
    "unmeasured",
  ]);

  // Failed and Unknown are named only when a row shows them.
  await screen.rerender(
    <TimelineCard
      sessions={[
        session(1, { name: "odd-one", status: "unknown" }),
        session(7, { name: "failed-one", status: "failed", statusSince: ago(3) }),
      ]}
      sources={[SOURCE]}
      events={[event(7, "failed-one", ago(3), "status-changed", "working", "failed")]}
      history={running(120)}
      now={NOW}
    />,
  );
  expect(legend(screen.container)).toEqual([
    "answered",
    "working",
    "idle",
    "stale",
    "finished",
    "failed",
    "unknown",
    "unmeasured",
  ]);
});

test.each(["dark", "light"] as const)(
  "in the %s theme, with no wait open, nothing in the timeline is warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <TimelineCard
        sessions={ANSWERED_SESSIONS}
        sources={[SOURCE]}
        events={ANSWERED_EVENTS}
        history={running(30)}
        now={NOW}
      />,
    );

    await expect.element(screen.getByRole("region", { name: "Timeline" })).toBeVisible();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("once answers stop, time after the last one is not measured, and no status is drawn over it", async () => {
  const lastAnswer = ago(6);
  const screen = await render(
    <TimelineCard
      sessions={[session(1, { name: "busy-one", status: "working", statusSince: ago(30) })]}
      sources={[SOURCE]}
      events={[]}
      history={{ startedAt: ago(120), points: polls(ago(120), lastAnswer) }}
      now={NOW}
      asOf={lastAnswer}
    />,
  );

  const segments = segmentsOf(screen.container, "busy-one");
  expect(segments.at(-1)?.dataset.kind).toBe("unmeasured");
  expect(segments.slice(0, -1).every((segment) => segment.dataset.kind === "working")).toBe(true);
  const tail = segments.at(-1) as HTMLElement;
  const track = (tail.parentElement as HTMLElement).getBoundingClientRect();
  expect(tail.getBoundingClientRect().right).toBeCloseTo(track.right, 0);
  expect(tail.getBoundingClientRect().width / track.width).toBeCloseTo(6 / 60, 2);
  expect(tail.querySelector('[data-part="mark"]')).toBeNull();
});

test("a wait cut off where answers stopped stays open, but only the stretch after it reaches now", async () => {
  const lastAnswer = ago(6);
  const screen = await render(
    <TimelineCard
      sessions={[session(2, { name: "blocked-one", status: "needs-you", statusSince: ago(10) })]}
      sources={[SOURCE]}
      events={[event(2, "blocked-one", ago(10), "status-changed", "working", "needs-you")]}
      history={{ startedAt: ago(120), points: polls(ago(120), lastAnswer) }}
      now={NOW}
      asOf={lastAnswer}
    />,
  );

  const segments = segmentsOf(screen.container, "blocked-one");
  const wait = segments.find((segment) => segment.dataset.kind === "needs-you") as HTMLElement;
  const tail = segments.at(-1) as HTMLElement;

  // Nobody answered it as far as anyone knows, so it is still the lamp's colour.
  expect(wait.dataset.open).toBe("true");
  expect(getComputedStyle(wait.querySelector('[data-part="mark"]')!).backgroundColor).toBe(
    rgbOf("var(--status-needs-you)"),
  );
  expect(legend(screen.container)).toContain("needs-you");
  // But it is known only up to the last answer: it does not reach the present,
  // and its length is a minimum.
  expect(wait.getAttribute("aria-label")).toBe(
    "Needs you, at least 4 minutes, 17:50:00 to 17:54:00",
  );
  expect(tail.dataset.kind).toBe("unmeasured");
  expect(tail.getAttribute("aria-label")).toBe("Not measured, 6 minutes so far, 17:54:00 to now");
  // One stretch on the row claims the present, not two.
  expect(
    segments.filter((segment) => segment.getAttribute("aria-label")?.endsWith("to now")),
  ).toEqual([tail]);

  await userEvent.hover(wait);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toHaveTextContent("Needs you");
  await expect.element(tooltip).toHaveTextContent("at least 4m 00s");
  await expect.element(tooltip).toHaveTextContent("17:50:00 to 17:54:00");
  await expect.element(tooltip).not.toHaveTextContent("so far");
  await pointAway();
});

test("before the first answer the card holds its place with a spinner", async () => {
  const screen = await render(
    <TimelineCard sessions={null} events={[]} history={null} now={NOW} />,
  );

  await expect.element(screen.getByRole("region", { name: "Timeline" })).toBeVisible();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Reading the last hour");
  expect(screen.container.querySelector('[data-slot="loading"]')).not.toBeNull();
  expect(screen.container.querySelector('[data-slot="empty-state"]')).toBeNull();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="timeline-legend"]')).toBeNull();
});

test("with a source that answers and nothing run, it says no sessions, of the time that was measured", async () => {
  const screen = await render(
    <TimelineCard sessions={[]} sources={[SOURCE]} events={[]} history={running(30)} now={NOW} />,
  );

  // Watched for half an hour: the half hour before is not called empty.
  await expect.element(screen.getByText("No sessions since 17:30")).toBeVisible();
  expect(screen.container.textContent).not.toContain("in the last hour");

  // Watched for longer than the hour, the whole hour was measured.
  await screen.rerender(
    <TimelineCard sessions={[]} sources={[SOURCE]} events={[]} history={running(120)} now={NOW} />,
  );
  await expect.element(screen.getByText("No sessions in the last hour")).toBeVisible();

  // With a break in the middle, only the time measured is said to be empty.
  const broken = running(120);
  broken.points = broken.points.filter((point) => point.at < ago(40) || point.at > ago(25));
  await screen.rerender(
    <TimelineCard sessions={[]} sources={[SOURCE]} events={[]} history={broken} now={NOW} />,
  );
  await expect.element(screen.getByText("No sessions in the time measured")).toBeVisible();
  expect(screen.container.querySelector('[data-slot="empty-state"]')).not.toBeNull();
  expect(screen.container.querySelector('[data-slot="loading"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="callout"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="timeline-rows"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="timeline-legend"]')).toBeNull();
});

test("a session that ended more than an hour ago is not a row", async () => {
  const screen = await render(
    <TimelineCard
      sessions={[]}
      sources={[SOURCE]}
      events={[event(4, "long-gone", ago(75), "ended", "idle")]}
      history={running(120)}
      now={NOW}
    />,
  );

  await expect.element(screen.getByText("No sessions in the last hour")).toBeVisible();
  expect(screen.container.textContent).not.toContain("long-gone");
});

test("when the history could not be read it is an error, not an empty hour", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={null}
      now={NOW}
    />,
  );

  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("The last hour could not be read");
  await expect.element(alert).toHaveTextContent("The page asks again every two seconds.");
  expect(screen.container.querySelector('[data-slot="empty-state"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="loading"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("No sessions in the last hour");
  expect(warmPaint(screen.container)).toEqual([]);
});

test.each(["unavailable", "error"] as const)(
  "when the only source is %s, the hour is called not measured, never empty",
  async (state) => {
    const screen = await render(
      <TimelineCard
        sessions={[]}
        sources={[{ ...SOURCE, state }]}
        events={[]}
        history={{ startedAt: ago(30), points: [] }}
        now={NOW}
      />,
    );

    const notice = screen.getByRole("status");
    await expect.element(notice).toHaveTextContent("The last hour was not measured");
    await expect.element(notice).toHaveTextContent("No source could be read");
    expect(screen.container.textContent).not.toContain("No sessions in the last hour");
    expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  },
);

test("while a source is still being looked for, the card waits and does not call the hour empty", async () => {
  const screen = await render(
    <TimelineCard
      sessions={[]}
      sources={[{ ...SOURCE, state: "searching" }]}
      events={[]}
      history={{ startedAt: NOW, points: [] }}
      now={NOW}
    />,
  );

  await expect.element(screen.getByRole("status")).toHaveTextContent("Looking for sessions");
  expect(screen.container.textContent).not.toContain("No sessions in the last hour");
});

test.each([900, 620])(
  "a long name is cut and stays reachable, and nothing in the card overflows at %i pixels",
  async (width) => {
    await page.viewport(width, 900);
    const long = "a-session-with-a-name-far-too-long-to-fit-beside-its-track-in-the-card";
    const screen = await render(
      <div style={{ width: width - 48 }}>
        <TimelineCard
          sessions={[session(1, { name: long, status: "working" }), ...SESSIONS.slice(1)]}
          sources={[SOURCE]}
          events={EVENTS}
          history={running(120)}
          now={NOW}
        />
      </div>,
    );

    const card = screen.getByRole("region", { name: "Timeline" }).element();
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    const name = screen.getByText(long).element() as HTMLElement;
    await expect.element(name).toHaveAttribute("data-cut", "true");
    expect(name.tabIndex).toBe(0);
    // Every track starts at the same place, whatever the length of its name.
    const lefts = [...card.querySelectorAll('[data-slot="status-track"]')].map(
      (track) => track.getBoundingClientRect().left,
    );
    expect(new Set(lefts).size).toBe(1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("nothing in the timeline is animated", async () => {
  const screen = await render(
    <TimelineCard
      sessions={SESSIONS}
      sources={[SOURCE]}
      events={EVENTS}
      history={running(120)}
      now={NOW}
    />,
  );
  const card = screen.getByRole("region", { name: "Timeline" }).element();
  await expect.element(card).toBeVisible();

  for (const element of card.querySelectorAll("*")) {
    expect(getComputedStyle(element).animationName).toBe("none");
  }
  expect(card.getAnimations({ subtree: true })).toHaveLength(0);
});
