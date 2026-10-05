import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { HistoryResponse } from "@core/api";
import type { HistoryPoint, SourceHealth } from "@core/sessions/session";
import { LastHourCard } from "@dashboard/components/last-hour/LastHourCard";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const at = (hours: number, minutes: number, seconds = 0) =>
  new Date(2026, 0, 5, hours, minutes, seconds).getTime();

const NOW = at(14, 32, 30);
const START = NOW - 60 * MINUTE;

type Counts = Pick<HistoryPoint, "needsYou" | "working" | "idle">;

function polls(from: number, to: number, counts: Counts): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (let moment = from; moment <= to; moment += 2 * SECOND) {
    points.push({
      at: moment,
      ...counts,
      total: counts.needsYou + counts.working + counts.idle,
    });
  }
  return points;
}

/**
 * Watching began at 13:50. A wait from 13:55 to 14:00 was answered; polls broke
 * off from 14:06 to 14:10; and a wait that began at 14:25 is still open.
 */
const HOUR: HistoryResponse = {
  startedAt: at(13, 50),
  points: [
    ...polls(at(13, 50), at(13, 54, 58), { needsYou: 0, working: 2, idle: 1 }),
    ...polls(at(13, 55), at(13, 59, 58), { needsYou: 1, working: 1, idle: 1 }),
    ...polls(at(14, 0), at(14, 6), { needsYou: 0, working: 2, idle: 1 }),
    ...polls(at(14, 10), at(14, 24, 58), { needsYou: 0, working: 1, idle: 1 }),
    ...polls(at(14, 25), NOW, { needsYou: 1, working: 1, idle: 1 }),
  ],
};

/** An hour measured with nothing running in it. */
const QUIET_HOUR: HistoryResponse = {
  startedAt: at(14, 0),
  points: polls(at(14, 0), NOW, { needsYou: 0, working: 0, idle: 0 }),
};

/** Watched for longer than the hour, with nothing running in it. */
const WHOLE_QUIET_HOUR: HistoryResponse = {
  startedAt: at(12, 0),
  points: polls(START, NOW, { needsYou: 0, working: 0, idle: 0 }),
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WAITING = makeSession({
  id: `claude-code:${uuid(1)}`,
  status: "needs-you",
  statusSince: at(14, 25),
});
const ANSWERED = { ...WAITING, status: "working" as const, statusSince: at(14, 31) };
const OK: SourceHealth = { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: NOW };

type CardProps = Parameters<typeof LastHourCard>[0];

function renderCard(props: Partial<CardProps> = {}) {
  return render(
    <div style={{ width: 520, height: 420, display: "flex" }}>
      <LastHourCard
        sessions={[WAITING]}
        sources={[OK]}
        history={HOUR}
        now={NOW}
        className='flex-1'
        {...props}
      />
    </div>,
  );
}

const chartOf = (container: HTMLElement) =>
  container.querySelector('[data-slot="last-hour-chart"]') as HTMLElement;
const bars = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-part="bar"]'),
];

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(414, 896);
});

test("a card called Last hour, every five minutes, with the time sessions waited on you in all above the bars", async () => {
  const screen = await renderCard();

  await expect.element(screen.getByRole("region", { name: "Last hour" })).toBeVisible();
  expect(screen.container.querySelector('[data-part="aside"]')?.textContent).toBe(
    "every 5 minutes",
  );
  // Five minutes answered and seven and a half still open.
  expect(screen.container.querySelector('[data-part="sum"]')?.textContent).toBe(
    "Sessions waited on you for 12m 30s in all",
  );
});

test("one bar for each measured stretch of a bucket, the hatch wherever nothing was measured, and no bar for zero", async () => {
  const screen = await renderCard();
  const chart = chartOf(screen.container);
  const box = chart.getBoundingClientRect();
  const span = 60 * MINUTE;
  const xOf = (moment: number) => box.left + ((moment - START) / span) * box.width;

  // 13:50 to 14:05, 14:05 to 14:06 alone, then 14:10 to now: nine bars.
  expect(bars(screen.container)).toHaveLength(9);
  for (const bar of bars(screen.container)) {
    const rect = bar.getBoundingClientRect();
    expect(rect.height).toBeGreaterThan(0);
    // Each stands on the baseline.
    expect(rect.bottom).toBeCloseTo(box.bottom, 0);
    expect(bar.classList.contains("bar-tube")).toBe(true);
  }

  // The time before watching began, and the break, are hatched from top to bottom.
  const hatch = [...chart.querySelectorAll<HTMLElement>('[data-part="unmeasured"]')];
  expect(hatch).toHaveLength(2);
  for (const band of hatch) {
    expect(band.classList.contains("unmeasured-hatch")).toBe(true);
    expect(band.getBoundingClientRect().height).toBeCloseTo(box.height, 0);
  }
  expect(hatch[0]!.getBoundingClientRect().left).toBeCloseTo(xOf(START), 0);
  expect(hatch[0]!.getBoundingClientRect().right).toBeCloseTo(xOf(at(13, 50)), 0);
  expect(hatch[1]!.getBoundingClientRect().left).toBeCloseTo(xOf(at(14, 6)), 0);
  expect(hatch[1]!.getBoundingClientRect().right).toBeCloseTo(xOf(at(14, 10)), 0);
  // No bar is drawn over a stretch nobody measured.
  for (const bar of bars(screen.container)) {
    const rect = bar.getBoundingClientRect();
    expect(rect.left >= xOf(at(13, 50)) - 1, "after watching began").toBe(true);
    expect(rect.right <= xOf(at(14, 6)) + 1 || rect.left >= xOf(at(14, 10)) - 1).toBe(true);
  }
  // The partly watched bucket's bar spans only its measured minute.
  const partly = bars(screen.container).find(
    (bar) => Math.abs(bar.getBoundingClientRect().left - xOf(at(14, 5))) < 1,
  ) as HTMLElement;
  expect(partly.getBoundingClientRect().width).toBeLessThan((MINUTE / span) * box.width);

  // Measured hours with nothing running draw no bar at all, not a bar of zero.
  const empty = await render(
    <div style={{ width: 520, height: 420, display: "flex" }}>
      <LastHourCard
        sessions={[]}
        sources={[OK]}
        history={{
          startedAt: at(13, 0),
          points: polls(at(13, 0), NOW, { needsYou: 0, working: 0, idle: 0 }),
        }}
        now={NOW}
      />
    </div>,
  );
  expect(bars(empty.container)).toHaveLength(0);
});

test("a bar is as tall as the sessions open then, filled from the baseline: needs you, then working, with idle the empty glass above", async () => {
  const screen = await renderCard();
  const chart = chartOf(screen.container);
  const height = chart.getBoundingClientRect().height;
  const box = (bar: HTMLElement) => bar.getBoundingClientRect();

  // The axis tops out at three. 14:10 to 14:25 had two sessions; the rest three.
  const [first] = bars(screen.container) as [HTMLElement];
  expect(box(first).height).toBeCloseTo(height, 0);
  const lower = bars(screen.container).filter((bar) => box(bar).height < height - 2);
  expect(lower).toHaveLength(3);
  for (const bar of lower) expect(box(bar).height).toBeCloseTo((2 / 3) * height, 0);

  // The bucket with the open wait: the wait on the baseline, working above it.
  const latest = bars(screen.container).at(-1) as HTMLElement;
  const segments = [...latest.querySelectorAll<HTMLElement>('[data-part="segment"]')];
  expect(segments.map((segment) => segment.dataset.kind)).toEqual(["open", "working"]);
  expect(box(segments[0]!).bottom).toBeGreaterThan(box(segments[1]!).bottom);
  // A third each: needs you, working, and the idle third left empty.
  for (const segment of segments) {
    expect(box(segment).height).toBeCloseTo(box(latest).height / 3, 0);
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme a wait still open is amber, an answered one hollow, and only an open wait puts Needs you in the legend",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderCard();
    const cardOf = () =>
      screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
    const card = cardOf();
    const kinds = () =>
      [...cardOf().querySelectorAll<HTMLElement>('[data-part="segment"]')].map(
        (s) => s.dataset.kind,
      );
    const legend = () =>
      [...cardOf().querySelectorAll('[data-slot="last-hour-legend"] li')].map(
        (li) => li.textContent,
      );

    const open = card.querySelector('[data-part="segment"][data-kind="open"]') as HTMLElement;
    expect(getComputedStyle(open).backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    const answered = card.querySelector(
      '[data-part="segment"][data-kind="answered"]',
    ) as HTMLElement;
    expect(getComputedStyle(answered).backgroundColor).toBe(rgbOf("var(--answered-fill)"));
    expect(getComputedStyle(answered).boxShadow).toContain(rgbOf("var(--status-idle)"));
    expect(warmPaint(answered)).toEqual([]);
    expect(legend()).toEqual(["Working", "Needs you", "Answered", "Idle", "Not measured"]);

    // Answered at 14:31: every wait in the hour is over, and nothing in the card is warm.
    await screen.rerender(
      <LastHourCard sessions={[ANSWERED]} sources={[OK]} history={HOUR} now={NOW} />,
    );
    expect(kinds()).not.toContain("open");
    expect(kinds()).toContain("answered");
    expect(legend()).toEqual(["Working", "Answered", "Idle", "Not measured"]);
    expect(warmPaint(cardOf())).toEqual([]);
  },
);

test("at rest the chart reads out the latest five minutes, and the keyboard moves through them with the arrows, Home and End", async () => {
  const screen = await renderCard();
  const chart = screen.getByRole("slider", { name: /^Last hour, every five minutes/ });

  await expect
    .element(chart)
    .toHaveAttribute("aria-valuetext", "14:30 to now: needs you 1.0, working 1.0, idle 1.0");
  expect(chart.element().getAttribute("aria-valuemin")).toBe("0");
  // Thirteen buckets: the first cut by the window, the last ending now.
  expect(chart.element().getAttribute("aria-valuemax")).toBe("12");

  startAtTop();
  await userEvent.tab();
  await expect.element(chart).toHaveFocus();
  // The reading box shows the bucket the keyboard is on.
  await vi.waitFor(() =>
    expect(chart.element().querySelector('[data-part="reading"]')?.textContent).toContain(
      "14:30 to now",
    ),
  );

  await userEvent.keyboard("{ArrowLeft}");
  await expect
    .element(chart)
    .toHaveAttribute("aria-valuetext", "14:25 to 14:30: needs you 1.0, working 1.0, idle 1.0");
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}");
  await expect
    .element(chart)
    .toHaveAttribute(
      "aria-valuetext",
      "14:05 to 14:10: working 2.0, idle 1.0, measured for 1m 00s",
    );
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  await expect
    .element(chart)
    .toHaveAttribute("aria-valuetext", "13:55 to 14:00: answered 1.0, working 1.0, idle 1.0");
  await userEvent.keyboard("{Home}");
  await expect.element(chart).toHaveAttribute("aria-valuetext", "13:32 to 13:35: not measured");
  await expect.element(chart).toHaveAttribute("aria-valuenow", "0");
  // The first is the end of the line.
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(chart).toHaveAttribute("aria-valuenow", "0");
  await userEvent.keyboard("{End}");
  await expect.element(chart).toHaveAttribute("aria-valuenow", "12");
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(chart).toHaveAttribute("aria-valuenow", "12");
});

test("pointing at the chart reads out the bucket under the pointer, and leaving it puts the reading back", async () => {
  const screen = await renderCard();
  const chart = chartOf(screen.container);
  const box = chart.getBoundingClientRect();
  const pointAt = (moment: number) =>
    userEvent.hover(chart, {
      position: { x: ((moment - START) / (60 * MINUTE)) * box.width, y: box.height / 2 },
    });
  const reading = () =>
    [...chart.querySelectorAll('[data-part="reading"] span')].map((line) => line.textContent);

  expect(chart.querySelector('[data-part="reading"]')).toBeNull();
  await pointAt(at(14, 12));
  await vi.waitFor(() =>
    expect(chart.getAttribute("aria-valuetext")).toBe("14:10 to 14:15: working 1.0, idle 1.0"),
  );
  expect(reading()).toEqual(["14:10 to 14:15", "Working 1.0", "Idle 1.0"]);
  // The bucket is lit under the pointer, over its whole height and no wider,
  // with the selected fill inside a rule, so it shows on the brightest glass.
  const chosen = chart.querySelector('[data-part="chosen"]') as HTMLElement;
  expect(getComputedStyle(chosen).backgroundColor).toBe(rgbOf("var(--fill-selected)"));
  expect(getComputedStyle(chosen).boxShadow).toContain(rgbOf("var(--rule)"));
  expect(chosen.getBoundingClientRect().height).toBeCloseTo(box.height, 0);
  expect(chosen.getBoundingClientRect().width).toBeLessThan(box.width / 11);

  await pointAt(at(13, 40));
  await vi.waitFor(() =>
    expect(chart.getAttribute("aria-valuetext")).toBe("13:40 to 13:45: not measured"),
  );
  expect(reading()).toEqual(["13:40 to 13:45", "Not measured"]);

  await pointAway();
  await vi.waitFor(() => expect(chart.querySelector('[data-part="reading"]')).toBeNull());
  expect(chart.getAttribute("aria-valuetext")).toBe(
    "14:30 to now: needs you 1.0, working 1.0, idle 1.0",
  );
});

test("its description reads every bucket, and says where nothing was measured", async () => {
  const screen = await renderCard();
  const chart = chartOf(screen.container);
  const description = document.getElementById(chart.getAttribute("aria-describedby") ?? "");

  expect(description?.classList.contains("sr-only")).toBe(true);
  const text = description?.textContent ?? "";
  expect(text).toMatch(
    /^The average number of sessions in each status, every five minutes over the last hour\. Not measured from 13:32 to 13:50, and from 14:06 to 14:10\. /,
  );
  expect(text.match(/ to (\d\d:\d\d|now): /g)).toHaveLength(13);
  expect(text).toContain("13:45 to 13:50: not measured.");
  expect(text).toContain("13:50 to 13:55: working 2.0, idle 1.0.");
  expect(text).toMatch(/14:30 to now: needs you 1\.0, working 1\.0, idle 1\.0\.$/);
});

test("the axes: counts in mono on the right, and clock times in mono that end at now", async () => {
  const screen = await renderCard();
  const chart = chartOf(screen.container);
  const axis = screen.container.querySelector('[data-slot="last-hour-axis"]') as HTMLElement;

  const counts = [...chart.querySelectorAll('[data-part="grid"] span')].map((n) => n.textContent);
  expect(counts).toEqual(["0", "3"]);
  // The baseline is the stronger rule, the rest hairlines.
  const grid = [...chart.querySelectorAll<HTMLElement>('[data-part="grid"]')];
  expect(getComputedStyle(grid[0]!).backgroundColor).toBe(rgbOf("var(--rule-strong)"));
  expect(getComputedStyle(grid[1]!).backgroundColor).toBe(rgbOf("var(--hairline)"));

  await vi.waitFor(() =>
    expect(axis.querySelectorAll('[data-part="time-tick"]').length).toBeGreaterThan(0),
  );
  const ticks = [...axis.querySelectorAll('[data-part="time-tick"]')].map((n) => n.textContent);
  for (const tick of ticks) expect(tick).toMatch(/^\d\d:(00|05|10|15|20|25|30|35|40|45|50|55)$/);
  expect(axis.querySelector('[data-part="now"]')?.textContent).toBe("now");
  expect(getComputedStyle(axis).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  // "now" sits at the right edge, where the bars end.
  const now = (axis.querySelector('[data-part="now"]') as HTMLElement).getBoundingClientRect();
  expect(now.right).toBeCloseTo(chart.getBoundingClientRect().right, 0);
});

test("with no wait in the hour it says so, and where some of the hour was not measured it says that instead", async () => {
  const calm: HistoryResponse = {
    startedAt: at(13, 0),
    points: polls(at(13, 0), NOW, { needsYou: 0, working: 1, idle: 0 }),
  };
  const busy = makeSession({ status: "working", statusSince: at(13, 0) });
  const screen = await renderCard({ sessions: [busy], history: calm });
  const sum = () => screen.container.querySelector('[data-part="sum"]')?.textContent;

  expect(sum()).toBe("No session waited on you in the last hour");
  await screen.rerender(
    <LastHourCard
      sessions={[busy]}
      sources={[OK]}
      history={{ ...calm, startedAt: at(14, 0) }}
      now={NOW}
    />,
  );
  expect(sum()).toBe("No session waited on you in the time measured");
});

test.each(["dark", "light"] as const)(
  "in the %s theme waiting, a history that failed, no source, still looking and an empty hour each look their own",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const states: Record<string, Partial<CardProps>> = {
      waiting: { sessions: null, history: null },
      failed: { history: null },
      "no source": {
        sessions: [],
        sources: [{ ...OK, state: "unavailable" }],
        history: QUIET_HOUR,
      },
      looking: { sessions: [], sources: [{ ...OK, state: "searching" }], history: QUIET_HOUR },
      empty: { sessions: [], history: QUIET_HOUR },
    };
    const signatures: Record<string, string> = {};
    for (const [name, props] of Object.entries(states)) {
      const screen = await renderCard(props);
      const card = screen.container.querySelector('[data-slot="section-card"]') as HTMLElement;
      const has = (selector: string) => card.querySelector(selector) !== null;
      signatures[name] = [
        has('[data-slot="loading"]') && "spinner",
        has('[role="alert"]') && "alert",
        has('[data-slot="callout"][data-tone="info"]') && "note",
        has('[data-slot="empty-state"]') && "empty words",
        has('[data-slot="last-hour-chart"]') && "chart",
      ]
        .filter(Boolean)
        .join(" + ");
      // None of them claims an hour of zeros.
      expect(has('[data-part="bar"]'), name).toBe(false);
      expect(warmPaint(card), name).toEqual([]);
    }

    expect(signatures).toEqual({
      waiting: "spinner",
      failed: "alert",
      "no source": "note",
      looking: "spinner",
      empty: "empty words",
    });
  },
);

test("each state says what it is in words", async () => {
  const words: [Partial<CardProps>, string][] = [
    [{ sessions: null, history: null }, "Reading the last hour"],
    [{ history: null }, "The last hour could not be read"],
    [
      { sessions: [], sources: [{ ...OK, state: "error" }], history: QUIET_HOUR },
      "The last hour was not measured",
    ],
    [
      { sessions: [], sources: [{ ...OK, state: "searching" }], history: QUIET_HOUR },
      "Looking for sessions",
    ],
    // Watched since 14:00 only: the half hour before was not measured, so only
    // the time since then is called empty.
    [{ sessions: [], history: QUIET_HOUR }, "No sessions since 14:00"],
    [{ sessions: [], history: WHOLE_QUIET_HOUR }, "No sessions in the last hour"],
  ];
  for (const [props, text] of words) {
    const screen = await renderCard(props);
    expect(screen.container.textContent, text).toContain(text);
  }
});
