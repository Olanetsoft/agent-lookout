import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { EventSeverity, Session, SessionEvent, SessionStatus } from "@core/sessions/session";
import { EventsCard } from "@dashboard/components/events/EventsCard";
import { MAX_EVENTS } from "@dashboard/lib/api/collectorStore";
import { formatDay } from "@dashboard/lib/format";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

// Local times, so the clock the card prints is the same on every machine.
const NOW = new Date(2026, 0, 5, 18, 0, 0).getTime();
const at = (hours: number, minutes: number, seconds: number) =>
  new Date(2026, 0, 5, hours, minutes, seconds).getTime();

const sessionId = (n: number) =>
  `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function event(
  n: number,
  when: number,
  name: string,
  to: SessionStatus | undefined,
  severity: EventSeverity = "advisory",
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    id: `event-${n}-${when}`,
    at: when,
    sessionId: sessionId(n),
    sessionName: name,
    kind: "status-changed",
    from: "working",
    ...(to && { to }),
    severity,
    ...overrides,
  };
}

/** What the page knows of a session from the latest snapshot. */
const listed = (n: number, status: Session["status"]) => ({ id: sessionId(n), status });

const EVENTS: SessionEvent[] = [
  event(3, at(17, 59, 30), "demo-project", "needs-you", "warning"),
  event(2, at(17, 40, 2), "second-project", "failed", "critical"),
  event(1, at(9, 4, 7), "demo-project", "idle"),
];

function rows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-slot="event-row"]')];
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("events are listed in the order given, newest first, each as time, mark, name and what happened", async () => {
  const screen = await render(<EventsCard events={EVENTS} now={NOW} />);

  expect(rows(screen.container).map((row) => row.textContent)).toEqual([
    "17:59:30demo-projectstarted waiting",
    "17:40:02second-projectfailed",
    "09:04:07demo-projectwent idle",
  ]);
  await expect.element(screen.getByRole("region", { name: "Events" })).toBeVisible();

  // In that order across the row: time, then mark, then the name at 600 and the phrase.
  const row = rows(screen.container)[1] as HTMLElement;
  const time = row.querySelector("time")!.getBoundingClientRect();
  const mark = row.querySelector('[data-slot="status-mark"]')!.getBoundingClientRect();
  const name = row.querySelector('[data-part="name"]') as HTMLElement;
  const phrase = row.querySelector('[data-part="phrase"]') as HTMLElement;
  expect(time.right).toBeLessThan(mark.left);
  expect(mark.right).toBeLessThan(name.getBoundingClientRect().left);
  expect(name.getBoundingClientRect().right).toBeLessThan(phrase.getBoundingClientRect().left);
  expect(getComputedStyle(name).fontWeight).toBe("600");
  expect(getComputedStyle(name).color).toBe(rgbOf("var(--ink)"));
  expect(getComputedStyle(phrase).color).toBe(rgbOf("var(--ink-secondary)"));
});

test("times are mono, small and tabular, and the full time is in a tooltip on the same clock", async () => {
  const screen = await render(<EventsCard events={EVENTS} now={NOW} />);
  const time = screen.container.querySelector("time") as HTMLElement;
  const style = getComputedStyle(time);

  expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  expect(style.fontSize).toBe("12px");
  expect(style.fontVariantNumeric).toContain("tabular-nums");
  expect(time.getAttribute("datetime")).toBe(new Date(at(17, 59, 30)).toISOString());
  expect(screen.container.querySelector("[title]")).toBeNull();

  // The tooltip adds the date. Its clock is the column's 24-hour clock, to the second.
  await userEvent.hover(time);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toHaveTextContent(/2026.* 17:59:30$/);
  expect(tooltip.element().textContent).not.toMatch(/[AP]M/i);
  await pointAway();
});

test("every row has a mark, the status the event moved to, said for assistive technology", async () => {
  const screen = await render(
    <EventsCard
      events={[
        event(4, at(17, 50, 0), "busy-one", "working"),
        event(5, at(17, 49, 0), "done-one", "finished"),
        event(6, at(17, 48, 0), "failed-one", "failed"),
        event(7, at(17, 47, 0), "resting-one", "idle"),
        event(8, at(17, 46, 0), "odd-one", "unknown"),
        event(9, at(17, 45, 0), "gone-one", undefined, "advisory", { kind: "ended" }),
      ]}
      now={NOW}
    />,
  );
  const marks = rows(screen.container).map((row) => {
    const mark = row.querySelector('[data-slot="status-mark"]');
    return mark ? [mark.getAttribute("data-kind"), mark.getAttribute("aria-label")] : null;
  });

  expect(marks).toEqual([
    ["working", "Working"],
    ["finished", "Finished"],
    ["failed", "Failed"],
    ["idle", "Idle"],
    ["unknown", "Unknown"],
    // An ending that names no status has the ended mark.
    ["ended", "Ended"],
  ]);
  const ended = rows(screen.container).at(-1) as HTMLElement;
  expect(ended.textContent).toBe("17:45:00gone-oneended");
  await expect.element(screen.getByRole("img", { name: "Ended" })).toBeVisible();
  // In the cool family, and in line with the marks above it.
  const mark = ended.querySelector('[data-slot="status-mark"]') as SVGSVGElement;
  expect(warmPaint(mark)).toEqual([]);
  const marksLeft = rows(screen.container).map(
    (row) => row.querySelector('[data-slot="status-mark"]')!.getBoundingClientRect().left,
  );
  expect(new Set(marksLeft).size).toBe(1);
  expect(mark.getBoundingClientRect().width).toBe(14);
});

test.each(["dark", "light"] as const)(
  "in the %s theme a wait that is still open has the lit lamp, and every other is the answered mark",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const events = [
      event(3, at(17, 59, 30), "demo-project", "needs-you", "warning"),
      event(2, at(17, 58, 0), "second-project", "working", "advisory", { from: "needs-you" }),
      event(2, at(17, 56, 20), "second-project", "needs-you", "warning"),
      event(4, at(17, 50, 0), "third-project", "needs-you", "warning"),
    ];
    const screen = await render(
      <EventsCard
        events={events}
        // demo-project still waits. second-project was answered. third-project
        // is listed as waiting no longer.
        sessions={[listed(3, "needs-you"), listed(2, "working"), listed(4, "idle")]}
        now={NOW}
      />,
    );
    const [open, answeredMove, answered, gone] = rows(screen.container) as HTMLElement[];
    const markOf = (row: HTMLElement) =>
      row.querySelector('[data-slot="status-mark"]') as SVGSVGElement;

    expect(open!.dataset.lit).toBe("true");
    expect(markOf(open!).dataset.kind).toBe("needs-you");
    expect(markOf(open!).dataset.lit).toBe("true");
    expect(getComputedStyle(open!).color).toBe(rgbOf("var(--ink)"));
    expect(warmPaint(open!).length).toBeGreaterThan(0);

    for (const row of [answered!, gone!]) {
      expect(row.hasAttribute("data-lit")).toBe(false);
      expect(markOf(row).dataset.kind).toBe("answered");
      expect(markOf(row).getAttribute("aria-label")).toBe("Needed you, answered");
      expect(warmPaint(row)).toEqual([]);
    }
    expect(warmPaint(answeredMove!)).toEqual([]);
    // The log does not breathe: only the waiting row in the Sessions table does.
    expect(screen.container.getAnimations({ subtree: true })).toHaveLength(0);
  },
);

test.each(["dark", "light"] as const)(
  "in the %s theme a log with no wait open holds no warm colour, even with waits in it",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <EventsCard
        events={EVENTS}
        sessions={[listed(3, "working"), listed(2, "failed"), listed(1, "idle")]}
        history={{ startedAt: at(9, 0, 0) }}
        now={NOW}
      />,
    );

    expect(warmPaint(screen.container)).toEqual([]);
    expect(screen.container.querySelector("[data-lit]")).toBeNull();
  },
);

test("a wait that ended says how long it lasted, the length in the sans with figures that keep their width, when its start is held", async () => {
  const screen = await render(
    <EventsCard
      events={[
        event(2, at(17, 54, 12), "demo-api", "working", "advisory", { from: "needs-you" }),
        event(2, at(17, 52, 32), "demo-api", "needs-you", "warning"),
        event(5, at(17, 50, 0), "demo-docs", "idle", "advisory", { from: "needs-you" }),
      ]}
      sessions={[listed(2, "working"), listed(5, "idle")]}
      now={NOW}
    />,
  );
  const [stopped, started, unknownStart] = rows(screen.container) as HTMLElement[];

  expect(stopped!.textContent).toBe("17:54:12demo-apistopped waiting after 1m 40s");
  const length = stopped!.querySelector('[data-part="phrase"] span') as HTMLElement;
  expect(length.textContent).toBe("1m 40s");
  // A duration is a figure, not a clock time: the sans, tabular.
  expect(getComputedStyle(length).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(getComputedStyle(length).fontVariantNumeric).toBe("tabular-nums");
  expect(started!.textContent).toBe("17:52:32demo-apistarted waiting");
  // Without the event that began it, the length was not seen, and is not guessed.
  expect(unknownStart!.textContent).toBe("17:50:00demo-docswent idle");
});

test("while the log has room it ends where Agent Lookout started watching, and the head says since when", async () => {
  const screen = await render(
    <EventsCard events={EVENTS} history={{ startedAt: at(9, 0, 2) }} now={NOW} />,
  );
  const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
  const items = [...list.children].filter((item) => !item.hasAttribute("aria-hidden"));
  const start = items.at(-1) as HTMLElement;

  expect(start.getAttribute("data-slot")).toBe("event-start");
  expect(start.textContent).toBe("09:00:02Started watching");
  const mark = start.querySelector('[data-slot="status-mark"]') as SVGSVGElement;
  expect(mark.dataset.kind).toBe("lookout");
  expect(mark.getAttribute("aria-label")).toBe("Agent Lookout");
  expect(start.querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(at(9, 0, 2)).toISOString(),
  );

  const since = screen.container.querySelector('[data-part="since"]') as HTMLElement;
  expect(since.textContent).toBe("since 09:00");
  expect(getComputedStyle(since.querySelector("span")!).fontFamily).toMatch(
    /^"?Atkinson Hyperlegible Mono/,
  );
});

test("once the log is full it claims only as far back as its oldest event, and shows no start", async () => {
  const full = Array.from({ length: MAX_EVENTS }, (_, index) =>
    event(100 + (index % 5), at(17, 0, 0) - index * 30_000, `session-${index % 5}`, "idle"),
  );
  const oldest = full.at(-1) as SessionEvent;
  const screen = await render(
    <EventsCard events={full} history={{ startedAt: at(9, 0, 2) }} now={NOW} />,
  );

  expect(screen.container.querySelector('[data-slot="event-start"]')).toBeNull();
  const since = new Date(oldest.at);
  expect(screen.container.querySelector('[data-part="since"]')?.textContent).toBe(
    `since ${String(since.getHours()).padStart(2, "0")}:${String(since.getMinutes()).padStart(2, "0")}`,
  );
});

test("without the history's start, a log with room claims nothing about when it began", async () => {
  const screen = await render(<EventsCard events={EVENTS} history={null} now={NOW} />);

  expect(screen.container.querySelector('[data-slot="event-start"]')).toBeNull();
  expect(screen.container.querySelector('[data-part="since"]')).toBeNull();
});

test("prepending a new event does not rebuild the rows already on screen", async () => {
  const screen = await render(<EventsCard events={EVENTS} now={NOW} />);
  const before = rows(screen.container);

  const newer = event(4, at(17, 59, 58), "third-project", "working");
  await screen.rerender(<EventsCard events={[newer, ...EVENTS]} now={NOW} />);
  const after = rows(screen.container);

  expect(after).toHaveLength(4);
  expect(after[0]?.textContent).toBe("17:59:58third-projectstarted working");
  // The three earlier rows are the same DOM nodes, moved down by one.
  expect(after.slice(1)).toEqual(before);
});

test("events from an earlier day keep their times, under a heading that names the day", async () => {
  const earlier = [11, 12, 13, 14].map((hour, index) =>
    event(-index, new Date(2026, 0, 4, hour, 12, 24).getTime(), "old-one", "idle"),
  );
  const screen = await render(
    <div style={{ width: 420 }}>
      <EventsCard events={[...EVENTS, ...earlier.reverse()]} now={NOW} />
    </div>,
  );
  const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;

  // One heading, before the first event of the earlier day. Today has none.
  const items = [...list.children].filter((item) => !item.hasAttribute("aria-hidden"));
  expect(items.map((item) => item.getAttribute("data-slot"))).toEqual([
    "event-row",
    "event-row",
    "event-row",
    "event-day",
    "event-row",
    "event-row",
    "event-row",
    "event-row",
  ]);
  const heading = list.querySelector('[data-slot="event-day"]') as HTMLElement;
  expect(heading.textContent).toContain("4");
  expect(heading.textContent).not.toMatch(/\d\d:\d\d/);

  // Every row says when, to the second: not four rows that all read as one date.
  expect(rows(screen.container).map((row) => row.querySelector("time")?.textContent)).toEqual([
    "17:59:30",
    "17:40:02",
    "09:04:07",
    "14:12:24",
    "13:12:24",
    "12:12:24",
    "11:12:24",
  ]);

  // Where each row's text column begins. It is the same for every row only if
  // the time column has one width.
  const lefts = rows(screen.container).map((row) =>
    Math.round(row.querySelector("div")!.getBoundingClientRect().left),
  );
  expect(new Set(lefts).size).toBe(1);
});

test("a long session name is cut, and what happened stays visible", async () => {
  const long = event(
    9,
    at(17, 0, 0),
    "a-very-long-session-name-".repeat(6),
    "needs-you",
    "warning",
  );
  const screen = await render(
    <div style={{ width: 360 }}>
      <EventsCard events={[long]} now={NOW} />
    </div>,
  );
  const row = rows(screen.container)[0] as HTMLElement;
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;

  await expect.element(screen.getByText("started waiting")).toBeVisible();
  const phrase = screen.getByText("started waiting").element().getBoundingClientRect();
  expect(phrase.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 0.5);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);

  // The cut name can be reached with Tab, and its tooltip has the whole line.
  const name = row.querySelector("[data-cut]") as HTMLElement;
  await vi.waitFor(() => expect(name.dataset.cut).toBe("true"));
  startAtTop();
  for (let presses = 0; presses < 4 && document.activeElement !== name; presses += 1) {
    await userEvent.tab();
  }
  expect(document.activeElement).toBe(name);
  await expect
    .element(page.getByRole("tooltip"))
    .toHaveTextContent(`${long.sessionName} started waiting`);
});

test.each([1440, 1000, 620])(
  "at %i pixels a list with more rows than fit scrolls behind a thin scrollbar, and no row fades",
  async (width) => {
    // Beside the sessions card at 1440, and stacked under it below 1181.
    onTestFinished(() => page.viewport(414, 896));
    await page.viewport(width, 900);
    const many = Array.from({ length: 40 }, (_, index) =>
      event(100 + index, at(17, 0, 0) - index * 60_000, `session-${index}`, "idle"),
    );
    const screen = await render(
      <div style={{ width: Math.min(420, width - 48), height: 400, display: "flex" }}>
        <EventsCard events={many} now={NOW} className='flex-1' />
      </div>,
    );
    const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

    // The 4px scrollbar is drawn by the rules that Chromium honours, with its thumb
    // in the stronger rule. (The test browser hides scrollbars, so its width is
    // read from the rule rather than measured.)
    expect(getComputedStyle(list).scrollbarWidth).toBe("auto");
    expect(getComputedStyle(list, "::-webkit-scrollbar").width).toBe("4px");
    expect(getComputedStyle(list, "::-webkit-scrollbar-thumb").backgroundColor).toBe(
      rgbOf("var(--rule-strong)"),
    );

    // Nothing between the words and the eye dims the last rows in view, so every
    // row keeps the contrast its ink was chosen for.
    for (let element: Element | null = list; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      const name = `${element.tagName} ${element.getAttribute("data-slot") ?? ""}`;
      expect(style.maskImage, name).toBe("none");
      expect(style.opacity, name).toBe("1");
    }
    const lastInView = rows(screen.container).filter(
      (row) => row.getBoundingClientRect().top < list.getBoundingClientRect().bottom,
    );
    for (const row of lastInView.slice(-2)) {
      expect(getComputedStyle(row).opacity).toBe("1");
      expect(getComputedStyle(row.querySelector('[data-part="phrase"]')!).color).toBe(
        rgbOf("var(--ink-secondary)"),
      );
    }
  },
);

test.each([
  [1440, 433],
  [1440, 471],
  [1000, 900],
  [620, 900],
])(
  "at %i pixels, in a card %i pixels tall, a log longer than its room shows whole rows only, ending above the card's rim",
  async (width, height) => {
    onTestFinished(() => page.viewport(414, 896));
    await page.viewport(width, 900);
    const many = Array.from({ length: 40 }, (_, index) =>
      event(100 + index, at(17, 0, 0) - index * 60_000, `session-${index}`, "idle"),
    );
    // Beside the Sessions card it is as tall as that card; stacked, it is capped.
    const screen = await render(
      <div style={{ width: Math.min(420, width - 48), height, display: "flex" }}>
        <EventsCard events={many} now={NOW} className='flex-1' />
      </div>,
    );
    const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
    const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;

    await vi.waitFor(() => expect(list.dataset.wholeRows).toBe("true"));
    const bottom = list.getBoundingClientRect().bottom;
    // No row is sliced by the edge of what is in view.
    for (const row of list.children) {
      const box = row.getBoundingClientRect();
      if (box.top >= bottom) continue;
      expect(box.bottom, row.textContent ?? "").toBeLessThanOrEqual(bottom + 0.5);
    }
    // The last row in view ends above the card's rim, inside the card.
    expect(bottom).toBeLessThan(card.getBoundingClientRect().bottom);
    // The rest is below, behind the scrollbar.
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    // Scrolled to the end, the oldest row is in view, whole.
    list.scrollTop = list.scrollHeight;
    const last = list.lastElementChild!.getBoundingClientRect();
    expect(last.bottom).toBeLessThanOrEqual(bottom + 0.5);

    // When every row fits, the list is left to fill its card as before.
    await screen.rerender(
      <div style={{ width: Math.min(420, width - 48), height, display: "flex" }}>
        <EventsCard events={many.slice(0, 3)} now={NOW} className='flex-1' />
      </div>,
    );
    await vi.waitFor(() => expect(list.hasAttribute("data-whole-rows")).toBe(false));
    expect(list.scrollHeight).toBeLessThanOrEqual(list.clientHeight);
  },
);

test("a row is at least 38px, with no rule between rows, and nothing fills under the pointer", async () => {
  const screen = await render(<EventsCard events={EVENTS} now={NOW} />);
  const [first, second] = rows(screen.container) as [HTMLElement, HTMLElement];

  expect(second.getBoundingClientRect().height).toBe(38);
  for (const row of [first, second]) {
    expect(getComputedStyle(row).borderTopWidth).toBe("0px");
    expect(getComputedStyle(row).borderBottomWidth).toBe("0px");
  }

  await userEvent.hover(second);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(getComputedStyle(second).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(second, "::before").content).toBe("none");
  await pointAway();
});

/** Polls every two seconds from `from` up to and including `to`. */
function polls(from: number, to: number) {
  const points = [];
  for (let moment = from; moment <= to; moment += 2_000) {
    points.push({ at: moment, needsYou: 0, working: 1, idle: 0, total: 1 });
  }
  return points;
}

/** The thread past each row of the log: above and below its mark. */
function threadOf(container: HTMLElement) {
  const list = container.querySelector('[data-slot="event-list"]') as HTMLElement;
  return [...list.children].map((item) => {
    const parts = [...item.querySelectorAll<HTMLElement>('[data-part="thread"]')];
    const side = (above: boolean) =>
      parts.find((part) =>
        above ? part.className.includes("bottom-1/2") : part.className.includes("top-1/2"),
      )?.dataset.kind ?? null;
    return [item.getAttribute("data-slot"), side(true), side(false)];
  });
}

test("where the polls broke off, a row says watching resumed and how long was not measured, and the thread is dotted across the break", async () => {
  const history = {
    startedAt: at(17, 0, 0),
    points: [...polls(at(17, 0, 0), at(17, 20, 0)), ...polls(at(17, 24, 0), NOW)],
  };
  const screen = await render(
    <EventsCard
      events={[
        event(1, at(17, 30, 0), "demo-project", "working"),
        event(1, at(17, 10, 0), "demo-project", "idle"),
      ]}
      history={history}
      now={NOW}
    />,
  );

  const resumed = screen.container.querySelector('[data-slot="event-resumed"]') as HTMLElement;
  expect(resumed.textContent).toBe("17:24:00Watching resumed, 4m 00s not measured");
  // The lookout's own mark, said for assistive technology, in the cool family.
  const mark = resumed.querySelector('[data-slot="status-mark"]') as SVGSVGElement;
  expect(mark.dataset.kind).toBe("lookout");
  expect(mark.getAttribute("aria-label")).toBe("Agent Lookout");
  expect(warmPaint(resumed)).toEqual([]);
  expect(resumed.querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(at(17, 24, 0)).toISOString(),
  );

  // In time order among the events, and the start at the foot.
  expect(threadOf(screen.container)).toEqual([
    ["event-row", null, "line"],
    // From the moment it resumed down to the row before the break, nobody watched.
    ["event-resumed", "line", "dots"],
    ["event-row", "dots", "line"],
    ["event-start", "line", null],
  ]);

  // A line is the rule; dots are the muted ink, dotted.
  const parts = [...screen.container.querySelectorAll<HTMLElement>('[data-part="thread"]')];
  const line = getComputedStyle(parts.find((part) => part.dataset.kind === "line")!);
  const dots = getComputedStyle(parts.find((part) => part.dataset.kind === "dots")!);
  expect(line.backgroundColor).toBe(rgbOf("var(--rule)"));
  expect(line.width).toBe("1px");
  expect(dots.borderLeftStyle).toBe("dotted");
  expect(dots.borderLeftColor).toBe(rgbOf("var(--ink-muted)"));
  expect(dots.backgroundColor).toBe("rgba(0, 0, 0, 0)");
});

test("the marks sit on one thread, which stops just short of each mark", async () => {
  const screen = await render(
    <EventsCard events={EVENTS} history={{ startedAt: at(9, 0, 2) }} now={NOW} />,
  );
  const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
  const centre = (box: DOMRect) => box.left + box.width / 2;

  const marks = [...list.querySelectorAll('[data-slot="status-mark"]')].map((mark) =>
    mark.getBoundingClientRect(),
  );
  const parts = [...list.querySelectorAll('[data-part="thread"]')].map((part) =>
    part.getBoundingClientRect(),
  );
  expect(parts.length).toBe(2 * (marks.length - 1));
  for (const box of [...marks, ...parts]) expect(centre(box)).toBeCloseTo(centre(marks[0]!), 0);
  // Each stretch leaves a gap at the mark, so no line runs through it.
  for (const [index, mark] of marks.entries()) {
    const above = parts[2 * index - 1];
    const below = parts[2 * index];
    if (above) expect(above.bottom).toBeLessThan(mark.top);
    if (below) expect(below.top).toBeGreaterThan(mark.bottom);
  }
});

test("a pause no longer than the gap is not a break, and a break older than a full log's oldest event is not said", async () => {
  const short = {
    startedAt: at(17, 0, 0),
    points: [...polls(at(17, 0, 0), at(17, 20, 0)), ...polls(at(17, 20, 8), NOW)],
  };
  const screen = await render(
    <EventsCard
      events={[event(1, at(17, 30, 0), "demo-project", "working")]}
      history={short}
      now={NOW}
    />,
  );
  expect(screen.container.querySelector('[data-slot="event-resumed"]')).toBeNull();
  expect(screen.container.querySelector('[data-part="thread"][data-kind="dots"]')).toBeNull();

  // A full log claims nothing before its oldest event, breaks included.
  const full = Array.from({ length: MAX_EVENTS }, (_, index) =>
    event(100 + (index % 5), NOW - index * 5_000, `session-${index % 5}`, "idle"),
  );
  const older = {
    startedAt: at(16, 0, 0),
    points: [...polls(at(16, 0, 0), at(16, 30, 0)), ...polls(at(16, 40, 0), NOW)],
  };
  await screen.rerender(<EventsCard events={full} history={older} now={NOW} />);
  expect(screen.container.querySelector('[data-slot="event-resumed"]')).toBeNull();
});

test("with no events, a break alone is still said, above the start", async () => {
  const history = {
    startedAt: at(17, 0, 0),
    points: [...polls(at(17, 0, 0), at(17, 20, 0)), ...polls(at(17, 26, 0), NOW)],
  };
  const screen = await render(<EventsCard events={[]} history={history} now={NOW} />);

  expect(threadOf(screen.container).map(([slot]) => slot)).toEqual([
    "event-resumed",
    "event-start",
  ]);
  expect(screen.container.querySelector('[data-slot="event-resumed"]')?.textContent).toContain(
    "6m 00s not measured",
  );
  expect(screen.container.textContent).not.toContain("No events yet");
});

test("the log can be scrolled from the keyboard", async () => {
  const screen = await render(<EventsCard events={EVENTS} now={NOW} />);
  const list = screen.getByRole("list", { name: "Event log, newest first" });

  await expect.element(list).toHaveAttribute("tabindex", "0");
  expect(getComputedStyle(list.element()).overflowY).toBe("auto");
});

test("on a fresh start the log is the moment watching began, with a quiet line that nothing has changed since", async () => {
  const screen = await render(
    <EventsCard events={[]} history={{ startedAt: at(17, 0, 0) }} now={NOW} />,
  );

  const start = screen.container.querySelector('[data-slot="event-start"]') as HTMLElement;
  expect(start.textContent).toBe("17:00:00Started watching");
  expect(start.querySelector("time")?.getAttribute("datetime")).toBe(
    new Date(at(17, 0, 0)).toISOString(),
  );
  expect(screen.container.querySelector('[data-part="since"]')?.textContent).toBe("since 17:00");
  expect(rows(screen.container)).toHaveLength(0);

  // Under it, a quiet line, set in line with its words and read once.
  const line = screen.container.querySelector('[data-part="unchanged"]') as HTMLElement;
  await expect.element(screen.getByText("Nothing has changed since.")).toBeVisible();
  const words = line.querySelector("span:last-child") as HTMLElement;
  expect(getComputedStyle(words).color).toBe(rgbOf("var(--ink-muted)"));
  expect(getComputedStyle(words).fontSize).toBe("12px");
  const started = [...start.querySelectorAll("span")].find(
    (span) => span.textContent === "Started watching",
  ) as HTMLElement;
  expect(words.getBoundingClientRect().left).toBeCloseTo(started.getBoundingClientRect().left, 0);
  expect(words.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    started.getBoundingClientRect().bottom,
  );
  const announced = [...line.childNodes]
    .filter((node) => !(node instanceof Element && node.getAttribute("aria-hidden") === "true"))
    .map((node) => node.textContent)
    .join("");
  expect(announced).toBe("Nothing has changed since.");

  // It is neither an empty result, an error nor a spinner.
  expect(screen.container.textContent).not.toContain("No events yet");
  expect(screen.container.querySelector('[data-slot="empty-state"]')).toBeNull();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.container.querySelector('[role="status"]')).toBeNull();

  // The first event takes the place of the quiet line.
  await screen.rerender(
    <EventsCard
      events={[event(1, at(17, 5, 0), "demo-project", "working")]}
      history={{ startedAt: at(17, 0, 0) }}
      now={NOW}
    />,
  );
  expect(screen.container.querySelector('[data-part="unchanged"]')).toBeNull();
  expect(rows(screen.container)).toHaveLength(1);
  expect(screen.container.querySelector('[data-slot="event-start"]')).not.toBeNull();
});

test("with no events and no known start it says there are no events yet, and does not look like an error or a spinner", async () => {
  const screen = await render(<EventsCard events={[]} history={null} now={NOW} />);

  await expect.element(screen.getByText("No events yet")).toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.container.querySelector('[role="status"]')).toBeNull();
  expect(rows(screen.container)).toHaveLength(0);
  expect(screen.container.querySelector('[data-slot="event-start"]')).toBeNull();
});

test("beside a taller card the log takes its height, rows keep their own height, and past what fits it scrolls", async () => {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(1440, 900);
  const screen = await render(
    <div style={{ width: 420, height: 640, display: "flex" }}>
      <EventsCard
        events={EVENTS}
        history={{ startedAt: at(9, 0, 2) }}
        now={NOW}
        className='flex-1'
      />
    </div>,
  );
  const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  const items = [...list.children] as HTMLElement[];

  // Three events and the start, each a row of its own height, from the top.
  expect(items).toHaveLength(4);
  for (const item of items) expect(item.getBoundingClientRect().height).toBe(38);
  // The list fills the card to its foot, so a long log scrolls inside the card.
  expect(
    card.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom,
  ).toBeLessThanOrEqual(1);
  // Each row's words sit in its middle.
  const row = items[0]!;
  const time = row.querySelector("time")!.getBoundingClientRect();
  const middle = (box: DOMRect) => box.top + box.height / 2;
  expect(Math.abs(middle(time) - middle(row.getBoundingClientRect()))).toBeLessThanOrEqual(2);

  // Past what fits, every row is still 38px and the log scrolls.
  const many = Array.from({ length: 40 }, (_, index) =>
    event(100 + index, at(17, 0, 0) - index * 60_000, `session-${index}`, "idle"),
  );
  await screen.rerender(
    <div style={{ width: 420, height: 640, display: "flex" }}>
      <EventsCard events={many} now={NOW} className='flex-1' />
    </div>,
  );
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
  for (const item of rows(screen.container)) {
    expect(item.getBoundingClientRect().height).toBe(38);
  }
});

test("in a narrow window, what happened goes under the name when the two do not fit, and nothing is cut", async () => {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(375, 900);
  const screen = await render(
    <div style={{ width: 279 }}>
      <EventsCard
        events={[
          event(2, at(17, 54, 12), "demo-api", "working", "advisory", { from: "needs-you" }),
          event(2, at(17, 52, 32), "demo-api", "needs-you", "warning"),
        ]}
        sessions={[listed(2, "working")]}
        now={NOW}
      />
    </div>,
  );
  const [stopped] = rows(screen.container) as HTMLElement[];
  const name = stopped!.querySelector('[data-part="name"]') as HTMLElement;
  const phrase = stopped!.querySelector('[data-part="phrase"]') as HTMLElement;
  const length = phrase.querySelector("span") as HTMLElement;

  // The name keeps its line, uncut, and the phrase goes under it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(name.dataset.cut).toBe("false");
  expect(phrase.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    name.getBoundingClientRect().bottom - 1,
  );
  // Nothing runs out of the row, and the length of the wait stays in one piece.
  expect(phrase.getBoundingClientRect().right).toBeLessThanOrEqual(
    stopped!.getBoundingClientRect().right,
  );
  expect(length.getClientRects()).toHaveLength(1);
  const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
});

/** Three events after 17:40 and two before, with the wait among the new ones still open. */
const AWAY_SINCE = at(17, 40, 30);
const WHILE_AWAY: SessionEvent[] = [
  event(21, at(17, 58, 4), "checkout-flow", "needs-you", "warning"),
  event(22, at(17, 51, 40), "billing-webhooks", "finished"),
  event(23, at(17, 44, 12), "search-indexing", "idle"),
  event(24, at(17, 39, 55), "docs-site", "working"),
  event(25, at(17, 31, 0), "api-rate-limits", "idle"),
];

/** The line where the person left off, if it is drawn. */
const newLine = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-slot="event-new"]');

test.each([
  ["dark", 1440, 420],
  ["light", 1440, 420],
  ["dark", 375, 279],
  ["light", 375, 279],
] as const)(
  "in the %s theme at %i pixels, a line sits under what arrived while the page was away, the head counts it, and neither is warm",
  async (theme, width, cardWidth) => {
    document.documentElement.setAttribute("data-theme", theme);
    onTestFinished(() => page.viewport(414, 896));
    await page.viewport(width, 900);
    const screen = await render(
      <div style={{ width: cardWidth }}>
        <EventsCard
          events={WHILE_AWAY}
          sessions={[listed(21, "needs-you"), listed(23, "idle")]}
          history={{ startedAt: at(17, 0, 0) }}
          newSince={AWAY_SINCE}
          now={NOW}
        />
      </div>,
    );
    const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
    const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    const line = newLine(screen.container) as HTMLElement;

    // Between the newest event seen before and the first that is new.
    expect([...list.children].map((item) => item.getAttribute("data-slot"))).toEqual([
      "event-row",
      "event-row",
      "event-row",
      "event-new",
      "event-row",
      "event-row",
      "event-start",
    ]);
    expect(line.textContent).toBe("New since 17:40:30");
    expect(line.querySelector("time")?.getAttribute("datetime")).toBe(
      new Date(AWAY_SINCE).toISOString(),
    );
    // A screen reader meets it in its place in the list, in the same words.
    await expect
      .element(screen.getByRole("listitem").filter({ hasText: "New since 17:40:30" }))
      .toBeVisible();

    // Quiet words, as a card's note.
    const words = line.querySelector('[data-part="words"]') as HTMLElement;
    const wordsStyle = getComputedStyle(words);
    expect(wordsStyle.color).toBe(rgbOf("var(--ink-muted)"));
    expect(wordsStyle.fontSize).toBe("12px");
    expect(wordsStyle.fontWeight).toBe("500");
    expect(getComputedStyle(line.querySelector("time")!).fontVariantNumeric).toBe("tabular-nums");
    // The words begin where every event's words begin, stay on one line and
    // inside the row's inset.
    const eventWords = rows(screen.container)[0]!.querySelector("div")!.getBoundingClientRect();
    expect(words.getBoundingClientRect().left).toBeCloseTo(eventWords.left, 0);
    expect(words.getClientRects()).toHaveLength(1);
    const inset = line.getBoundingClientRect().right - 24;
    expect(words.getBoundingClientRect().right).toBeLessThanOrEqual(inset + 0.5);
    // Wide, a rule in the thread's colour runs on to the inset. Narrow, the words
    // fill the row, and there is no stub of a rule.
    const rule = line.querySelector('[data-part="rule"]') as HTMLElement;
    if (width > 760) {
      expect(getComputedStyle(rule).backgroundColor).toBe(rgbOf("var(--rule)"));
      expect(rule.getBoundingClientRect().height).toBe(1);
      expect(rule.getBoundingClientRect().right).toBeCloseTo(inset, 0);
    } else {
      expect(getComputedStyle(rule).display).toBe("none");
    }
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);

    // The count beside the title, in the card's quiet count. "3 new" to the eye.
    // A screen reader hears ", the log" after it, so the aside's "since 17:00"
    // is not taken for since when they are new.
    const count = card.querySelector('[data-part="count"]') as HTMLElement;
    expect(count.textContent).toBe("3 new, the log");
    expect(count.querySelector(".sr-only")?.textContent).toBe(", the log");
    expect(card.querySelector('[data-part="aside"]')?.textContent).toBe("since 17:00");
    expect(getComputedStyle(count).color).toBe(rgbOf("var(--ink-muted)"));
    expect(getComputedStyle(count).fontSize).toBe("15px");
    expect(getComputedStyle(count).fontVariantNumeric).toBe("tabular-nums");
    await expect.element(screen.getByRole("region", { name: "Events" })).toBeVisible();

    // The wait that is still open keeps its lamp. Nothing else turns warm.
    const [open, ...others] = rows(screen.container);
    expect(warmPaint(open!).length).toBeGreaterThan(0);
    for (const row of others) expect(warmPaint(row)).toEqual([]);
    expect(warmPaint(line)).toEqual([]);
    expect(warmPaint(card.querySelector('[data-part="head"]')!)).toEqual([]);
  },
);

test("with nothing newer than the line, or no line asked for, the log is as it was", async () => {
  const screen = await render(<EventsCard events={WHILE_AWAY} now={NOW} />);
  expect(newLine(screen.container)).toBeNull();
  expect(screen.container.querySelector('[data-part="count"]')).toBeNull();

  await screen.rerender(<EventsCard events={WHILE_AWAY} newSince={at(17, 58, 4)} now={NOW} />);
  expect(newLine(screen.container)).toBeNull();
  expect(screen.container.querySelector('[data-part="count"]')).toBeNull();

  // And the line goes when the page takes it away.
  await screen.rerender(<EventsCard events={WHILE_AWAY} newSince={AWAY_SINCE} now={NOW} />);
  expect(newLine(screen.container)).not.toBeNull();
  await screen.rerender(<EventsCard events={WHILE_AWAY} newSince={null} now={NOW} />);
  expect(newLine(screen.container)).toBeNull();
  expect(screen.container.querySelector('[data-part="count"]')).toBeNull();
  expect(rows(screen.container)).toHaveLength(5);
});

test("away overnight, the line names the day it was left on and sits over that day's heading, and a break stays dotted past both", async () => {
  const evening = new Date(2026, 0, 4, 22, 15, 0).getTime();
  const history = {
    startedAt: new Date(2026, 0, 4, 20, 0, 0).getTime(),
    // Polled until 22:16, asleep, and polled again from 07:30.
    points: [
      ...polls(new Date(2026, 0, 4, 20, 0, 0).getTime(), new Date(2026, 0, 4, 22, 16, 0).getTime()),
      ...polls(at(7, 30, 0), NOW),
    ],
  };
  const screen = await render(
    <EventsCard
      events={[
        event(31, at(7, 31, 2), "mobile-onboarding", "working"),
        event(32, new Date(2026, 0, 4, 22, 10, 0).getTime(), "infra-terraform", "idle"),
      ]}
      history={history}
      newSince={evening}
      now={NOW}
    />,
  );

  const line = newLine(screen.container) as HTMLElement;
  // The day as the day heading under it writes it, then the clock.
  expect(line.textContent).toBe(`New since ${formatDay(evening, NOW)} 22:15:00`);
  expect(line.nextElementSibling?.textContent).toBe(formatDay(evening, NOW));
  expect(threadOf(screen.container)).toEqual([
    ["event-row", null, "line"],
    ["event-resumed", "line", "dots"],
    // Nobody watched from 22:16 to 07:30: the dots run on past the line and the day.
    ["event-new", "dots", "dots"],
    ["event-day", "dots", "dots"],
    ["event-row", "dots", "line"],
    ["event-start", "line", null],
  ]);
  expect(screen.container.querySelector('[data-part="count"]')?.textContent).toBe("1 new, the log");
});

test("when everything the log holds is new, the line is last", async () => {
  const screen = await render(
    <EventsCard
      events={WHILE_AWAY.slice(0, 3)}
      history={{ startedAt: at(17, 42, 0) }}
      newSince={AWAY_SINCE}
      now={NOW}
    />,
  );
  const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;

  expect(list.lastElementChild?.getAttribute("data-slot")).toBe("event-new");
  expect(screen.container.querySelector('[data-part="count"]')?.textContent).toBe("3 new, the log");
});

test("the card says whether the line is in view, and that it is not once it has gone", async () => {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(1440, 900);
  const said: boolean[] = [];
  const onNewLineInView = (inView: boolean) => said.push(inView);
  const many = Array.from({ length: 40 }, (_, index) =>
    event(100 + index, at(17, 50, 0) - index * 60_000, `email-templates-${index}`, "idle"),
  );
  const card = (since: number | null) => (
    <div style={{ width: 420, height: 400, display: "flex" }}>
      <EventsCard
        events={many}
        newSince={since}
        onNewLineInView={onNewLineInView}
        now={NOW}
        className='flex-1'
      />
    </div>
  );

  // Three new events: the line is near the top, in view.
  const screen = await render(card(at(17, 47, 30)));
  await vi.waitFor(() => expect(said.at(-1)).toBe(true));

  // Scrolled down the log, it is out of view.
  const list = screen.container.querySelector('[data-slot="event-list"]') as HTMLElement;
  list.scrollTop = list.scrollHeight;
  await vi.waitFor(() => expect(said.at(-1)).toBe(false));
  list.scrollTop = 0;
  await vi.waitFor(() => expect(said.at(-1)).toBe(true));

  // Thirty new: the line is below what the log shows, so not in view.
  await screen.rerender(card(at(17, 20, 30)));
  await vi.waitFor(() => expect(said.at(-1)).toBe(false));

  // Gone, it is not in view either.
  await screen.rerender(card(at(17, 47, 30)));
  await vi.waitFor(() => expect(said.at(-1)).toBe(true));
  await screen.rerender(card(null));
  expect(said.at(-1)).toBe(false);
  expect(newLine(screen.container)).toBeNull();
});
