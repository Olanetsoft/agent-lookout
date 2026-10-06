import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { WaitDay, WaitPeriod, WaitsResponse } from "@core/api";
import { WaitsCard } from "@dashboard/components/waits/WaitsCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import type { CollectorHistory } from "@dashboard/lib/api/collectorStore";
import { rgbOf, warmElements, warmPaint } from "@tests/support/browser/colours";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** A moment on the local clock in an ordinary week of October. */
const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 9, day, hours, minutes).getTime();

const NOW = at(6, 15);

const pad2 = (value: number) => String(value).padStart(2, "0");

/** The `n`th of the seven days, from the Wednesday before at 0 to today at 6. */
function day(n: number, overrides: Partial<WaitDay> = {}): WaitDay {
  const start = new Date(2026, 8, 30 + n);
  const from = start.getTime();
  return {
    day: `${start.getFullYear()}-${pad2(start.getMonth() + 1)}-${pad2(start.getDate())}`,
    from,
    to: Math.min(NOW, from + 24 * HOUR),
    waitedMs: 0,
    openMs: 0,
    waits: 0,
    measuredMs: 0,
    ...overrides,
  };
}

/** Seven days, Wednesday to Tuesday: two not measured, one measured with no wait, and four with waits. */
function week(open = false): WaitDay[] {
  return [
    day(0),
    day(1),
    day(2, { measuredMs: 6 * HOUR }),
    day(3, { waitedMs: 12 * MINUTE, waits: 2, measuredMs: 8 * HOUR }),
    day(4, { waitedMs: 41 * MINUTE, waits: 5, measuredMs: 10 * HOUR }),
    day(5, { waitedMs: 20 * MINUTE, waits: 3, measuredMs: 9 * HOUR }),
    day(6, {
      waitedMs: 30 * MINUTE,
      openMs: open ? 10 * MINUTE : 0,
      waits: 4,
      measuredMs: 9 * HOUR + 12 * MINUTE,
    }),
  ];
}

function sum(days: readonly WaitDay[], key: "waitedMs" | "openMs" | "waits" | "measuredMs") {
  return days.reduce((total, item) => total + item[key], 0);
}

function waits(open = false, overrides: Partial<WaitsResponse> = {}): WaitsResponse {
  const days = week(open);
  const today = days.at(-1) as WaitDay;
  const totals = (list: WaitDay[]) => ({
    waitedMs: sum(list, "waitedMs"),
    openMs: sum(list, "openMs"),
    waits: sum(list, "waits"),
    measuredMs: sum(list, "measuredMs"),
  });
  const todayPeriod: WaitPeriod = {
    from: today.from,
    to: NOW,
    ...totals([today]),
    days: [today],
    sessions: [
      { sessionId: "claude-code:1", name: "demo-project", waitedMs: 22 * MINUTE, waits: 3, open },
      {
        sessionId: "claude-code:2",
        name: "project-2",
        waitedMs: 8 * MINUTE,
        waits: 1,
        open: false,
      },
    ],
    sessionCount: 2,
  };
  const sevenDays: WaitPeriod = {
    from: (days[0] as WaitDay).from,
    to: NOW,
    ...totals(days),
    days,
    sessions: Array.from({ length: 7 }, (_, n) => ({
      sessionId: `claude-code:${n + 1}`,
      name: n === 0 ? "demo-project" : `project-${n + 1}`,
      waitedMs: (40 - n * 5) * MINUTE,
      waits: 7 - n,
      open: open && n === 0,
    })),
    sessionCount: 9,
  };
  return {
    at: NOW,
    today: todayPeriod,
    sevenDays,
    since: { at: (days[2] as WaitDay).from + 9 * HOUR, by: "started" },
    where: "disk",
    ...overrides,
  };
}

/** Answers `/api/waits` with what the test says, made afresh for each request, and writes down each path asked for. */
function answering(answer: () => unknown) {
  const asked: string[] = [];
  setApiHost(async (path) => {
    asked.push(path);
    const body = await answer();
    return body instanceof Response ? body : new Response(JSON.stringify(body));
  });
  return asked;
}

const history = (startedAt: number): CollectorHistory => ({ startedAt, points: [] });

const rectOf = (element: Element) => element.getBoundingClientRect();

function part(root: ParentNode, name: string): HTMLElement {
  return root.querySelector(`[data-part="${name}"]`) as HTMLElement;
}

const days = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLElement>('[data-part="day"]'),
];

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(414, 896);
});

test("it gives today and the last seven days, day by day, and the sessions that waited longest, from the app's answer", async () => {
  const asked = answering(() => waits());
  const screen = await render(<WaitsCard history={history(NOW - HOUR)} sessions={[]} asOf={NOW} />);
  const card = screen.getByRole("region", { name: "Waits", exact: true });

  await expect.element(card.getByText("By day")).toBeVisible();
  expect(asked).toEqual(["/api/waits"]);
  // It says who waited on whom, as Last hour does.
  expect(part(screen.container, "sum").textContent).toBe(
    "Sessions waited on you for 30m 00s today, in 4 waits",
  );
  // Each figure is a term and its values, so they are read together.
  const figures = [...screen.container.querySelectorAll('dl > [data-part="figure"]')].map(
    (figure) =>
      [...figure.children].map((child) => `${child.tagName.toLowerCase()}:${child.textContent}`),
  );
  expect(figures).toEqual([
    ["dt:Today", "dd:30 minutes30m 00s", "dd:4 waits"],
    ["dt:Last 7 days", "dd:1 hour 43 minutes1h 43m", "dd:14 waits"],
  ]);
  expect(part(screen.container, "coverage").textContent).toBe(
    "Only the time Agent Lookout was running is counted: 9h 12m of today so far, and 1d 18h of the last 7 days. The history it keeps begins at 09:00 on Oct 2.",
  );

  // Seven days, oldest first, today last, each with its total and how much was measured.
  expect(days(screen.container).map((row) => part(row, "value").textContent)).toEqual([
    "–",
    "–",
    "0s",
    "12m 00s",
    "41m 00s",
    "20m 00s",
    "30m 00s",
  ]);
  const [first, , quiet, , , yesterday, today] = days(screen.container) as HTMLElement[];
  expect(part(today as HTMLElement, "label").textContent).toBe("Today");
  expect(part(yesterday as HTMLElement, "label").textContent).toBe("Yesterday");
  expect(part(today as HTMLElement, "measured").textContent).toBe("measured 9h 12m");
  expect(part(today as HTMLElement, "track").getAttribute("aria-label")).toBe(
    "Today: waited 30 minutes in 4 waits, measured for 9 hours 12 minutes",
  );
  // A day nobody measured is hatched, with a dash, never a zero.
  expect(part(first as HTMLElement, "unmeasured")).not.toBeNull();
  expect(part(first as HTMLElement, "measured").textContent).toBe("not measured");
  expect(part(first as HTMLElement, "track").getAttribute("aria-label")).toMatch(/: not measured$/);
  // A day measured with no wait has no bar and no hatch.
  expect(part(quiet as HTMLElement, "bar")).toBeNull();
  expect(part(quiet as HTMLElement, "unmeasured")).toBeNull();

  // Today's longest waits first, then the seven days'.
  const names = () =>
    [...screen.container.querySelectorAll('[data-part="session"]')].map(
      (row) => `${part(row, "name").textContent} ${part(row, "times").textContent}`,
    );
  expect(names()).toEqual(["demo-project 3 waits", "project-2 1 wait"]);
  await card.getByRole("radio", { name: "7 days" }).click();
  expect(names()).toEqual([
    "demo-project 7 waits",
    "project-2 6 waits",
    "project-3 5 waits",
    "project-4 4 waits",
    "project-5 3 waits",
  ]);
  expect(part(screen.container, "more").textContent).toBe("and 4 more");
});

test("the bars share one scale: the longest day fills the track, and none is shorter than a quarter of an hour", async () => {
  answering(() => waits());
  const screen = await render(<WaitsCard history={null} sessions={[]} asOf={NOW} />);
  await expect.element(screen.getByText("By day")).toBeVisible();
  const share = (row: HTMLElement) =>
    part(row, "bar").getBoundingClientRect().width /
    part(row, "track").getBoundingClientRect().width;
  const rows = days(screen.container);
  expect(share(rows[4] as HTMLElement)).toBeCloseTo(1, 2);
  expect(share(rows[3] as HTMLElement)).toBeCloseTo(12 / 41, 2);
});

test.each(["dark", "light"] as const)(
  "in the %s theme nothing is warm unless a wait is open now, and then only today's open part of its bar",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    let open = false;
    answering(() => waits(open));
    const screen = await render(
      <WaitsCard history={history(NOW - HOUR)} sessions={[]} asOf={NOW} />,
    );
    await expect.element(screen.getByText("By day")).toBeVisible();
    expect(warmPaint(screen.container)).toEqual([]);

    open = true;
    // A restart, which the history the page holds shows, asks again at once.
    await screen.rerender(
      <WaitsCard history={history(NOW - 30 * MINUTE)} sessions={[]} asOf={NOW} />,
    );
    await vi.waitFor(() =>
      expect(part(screen.container, "times").textContent).toContain("waiting now"),
    );
    const today = days(screen.container).at(-1) as HTMLElement;
    const openPart = today.querySelector('[data-kind="open"]') as HTMLElement;
    expect(getComputedStyle(openPart).backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(warmElements(screen.container)).toEqual([openPart]);
    // Open and answered differ in shape too: a filled block against an outlined one.
    const answered = today.querySelector('[data-kind="answered"]') as HTMLElement;
    expect(getComputedStyle(answered).backgroundColor).toBe(rgbOf("var(--answered-fill)"));
    expect(answered.getBoundingClientRect().right).toBeLessThan(
      openPart.getBoundingClientRect().left,
    );
  },
);

test("with history kept in memory only it says that only the time since Agent Lookout started counts, and why", async () => {
  answering(() => waits(false, { where: "memory", since: { at: at(6, 13), by: "started" } }));
  const screen = await render(<WaitsCard history={null} sessions={[]} asOf={NOW} />);
  await expect.element(screen.getByText("By day")).toBeVisible();
  expect(part(screen.container, "coverage").textContent).toMatch(
    /^History is kept in memory only, because AGENT_LOOKOUT_HISTORY is set to off, so only the time since Agent Lookout started at 13:00 is counted: 9h 12m of today so far/,
  );
});

test("a wait open since yesterday is amber only in today's bar, and only today's bar says it still waits", async () => {
  const answer = waits(true);
  const yesterday = answer.sevenDays.days[5] as WaitDay;
  answer.sevenDays.days[5] = { ...yesterday, openMs: 5 * MINUTE };
  answering(() => answer);
  const screen = await render(<WaitsCard history={null} sessions={[]} asOf={NOW} />);
  await expect.element(screen.getByText("By day")).toBeVisible();
  const rows = days(screen.container);
  const [before, today] = rows.slice(-2) as HTMLElement[];
  expect(before!.dataset.open).toBe("false");
  expect(before!.querySelector('[data-kind="open"]')).toBeNull();
  expect(part(before!, "track").getAttribute("aria-label")).not.toContain("still waiting");
  // All of yesterday's bar is answered: as long as its total.
  const answered = before!.querySelector('[data-kind="answered"]') as HTMLElement;
  expect(answered.getBoundingClientRect().width).toBeCloseTo(
    part(before!, "bar").getBoundingClientRect().width,
    0,
  );
  expect(today!.dataset.open).toBe("true");
  expect(part(today!, "track").getAttribute("aria-label")).toContain("still waiting");
  expect(warmElements(screen.container)).toEqual([today!.querySelector('[data-kind="open"]')]);
});

test("between answers a wait still open goes on, with the hero and Last hour, second by second", async () => {
  const asked = answering(() => waits(true));
  const screen = await render(<WaitsCard history={null} sessions={[]} asOf={NOW} />);
  await expect.element(screen.getByText("By day")).toBeVisible();
  const today = () => days(screen.container).at(-1) as HTMLElement;
  const openWidth = () =>
    (today().querySelector('[data-kind="open"]') as HTMLElement).getBoundingClientRect().width;
  const before = openWidth();

  await screen.rerender(<WaitsCard history={null} sessions={[]} asOf={NOW + 20 * SECOND} />);
  expect(asked).toHaveLength(1);
  expect(part(screen.container, "sum").textContent).toBe(
    "Sessions waited on you for 30m 20s today, in 4 waits",
  );
  expect(part(today(), "value").textContent).toBe("30m 20s");
  expect(part(part(screen.container, "session"), "value").textContent).toContain("22m 20s");
  expect(openWidth()).toBeGreaterThan(before);
  // Only an open wait goes on: the answered one stands.
  const answered = [
    ...screen.container.querySelectorAll('[data-part="session"]'),
  ][1] as HTMLElement;
  expect(part(answered, "value").textContent).toContain("8m 00s");
});

test("it asks again as the page comes back into sight, and as a wait opens or ends", async () => {
  const asked = answering(() => waits());
  const screen = await render(<WaitsCard history={null} sessions={[]} asOf={NOW} />);
  await expect.element(screen.getByText("By day")).toBeVisible();
  expect(asked).toHaveLength(1);

  document.dispatchEvent(new Event("visibilitychange"));
  await vi.waitFor(() => expect(asked).toHaveLength(2));

  const waiting = [{ id: "claude-code:1", status: "needs-you" as const }];
  await screen.rerender(<WaitsCard history={null} sessions={waiting} asOf={NOW} />);
  await vi.waitFor(() => expect(asked).toHaveLength(3));
  // A poll that finds the same sessions waiting asks nothing more.
  await screen.rerender(<WaitsCard history={null} sessions={[...waiting]} asOf={NOW} />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(asked).toHaveLength(3);
  await screen.rerender(<WaitsCard history={null} sessions={[]} asOf={NOW} />);
  await vi.waitFor(() => expect(asked).toHaveLength(4));
});

test("before the answer it waits; with no answer it says so; and an answer that later fails keeps what was read", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let answer: () => unknown = async () => {
    await held;
    return new Response("<!doctype html>");
  };
  answering(() => answer());
  const screen = await render(<WaitsCard history={history(NOW - HOUR)} sessions={[]} asOf={NOW} />);
  await expect.element(screen.getByText("Reading waits")).toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();

  release();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("How long sessions waited could not be read");

  answer = () => waits();
  await screen.rerender(
    <WaitsCard history={history(NOW - 10 * MINUTE)} sessions={[]} asOf={NOW} />,
  );
  await expect.element(screen.getByText("By day")).toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();

  let failed = 0;
  answer = () => {
    failed += 1;
    return new Response("{}", { status: 500 });
  };
  await screen.rerender(<WaitsCard history={history(NOW - 5 * MINUTE)} sessions={[]} asOf={NOW} />);
  await vi.waitFor(() => expect(failed).toBe(1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(days(screen.container)).toHaveLength(7);
});

test.each([375, 1280])(
  "at %i pixels nothing reaches past the card, and every figure is whole",
  async (width) => {
    await page.viewport(width, 900);
    answering(() => waits(true));
    const screen = await render(
      <div style={{ width: width === 375 ? 343 : 1200 }}>
        <WaitsCard history={null} sessions={[]} asOf={NOW} />
      </div>,
    );
    await expect.element(screen.getByText("By day")).toBeVisible();
    const frame = screen.container.firstElementChild as HTMLElement;
    const right = frame.getBoundingClientRect().right;

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    for (const element of frame.querySelectorAll("*")) {
      expect(
        element.getBoundingClientRect().right,
        element.outerHTML.slice(0, 80),
      ).toBeLessThanOrEqual(right + 0.5);
    }
    for (const value of frame.querySelectorAll<HTMLElement>('[data-part="value"]')) {
      expect(value.scrollWidth, value.textContent ?? "").toBeLessThanOrEqual(value.clientWidth);
    }

    // Every day's track is as long as the others, hatched or not, so the bars share one scale.
    const tracks = days(frame).map((each) => part(each, "track").getBoundingClientRect());
    for (const each of tracks) {
      expect(each.width).toBeCloseTo(tracks[0]!.width, 0);
      expect(each.left).toBeCloseTo(tracks[0]!.left, 0);
    }

    const byDay = part(frame, "by-day").getBoundingClientRect();
    const longest = part(frame, "longest").getBoundingClientRect();
    const row = days(frame)[3] as HTMLElement;
    const track = part(row, "track").getBoundingClientRect();
    const label = part(row, "label").getBoundingClientRect();
    const value = part(row, "value").getBoundingClientRect();
    const measured = part(row, "measured").getBoundingClientRect();
    const [today, sevenDays] = [...frame.querySelectorAll('[data-part="figure"]')].map(rectOf);
    if (width === 375) {
      // One column: the longest waits under the days, and the two figures one under the other.
      expect(longest.top).toBeGreaterThanOrEqual(byDay.bottom);
      expect(sevenDays!.top).toBeGreaterThanOrEqual(today!.bottom);
      // Each day on two lines, the day and its total, then its bar and how much was measured,
      // with no word broken over a line.
      expect(value.top).toBe(label.top);
      expect(track.top).toBeGreaterThanOrEqual(label.bottom);
      expect(
        Math.abs(measured.top + measured.height / 2 - (track.top + track.height / 2)),
      ).toBeLessThan(2);
      for (const each of days(frame)) {
        expect(
          part(each, "label").getBoundingClientRect().height,
          each.textContent ?? "",
        ).toBeLessThan(24);
      }
      // The switch takes a line of its own under the heading.
      const heading = (
        part(frame, "longest").querySelector("h3") as HTMLElement
      ).getBoundingClientRect();
      const choice = (
        part(frame, "longest").querySelector('[data-slot="segmented-control"]') as HTMLElement
      ).getBoundingClientRect();
      expect(choice.top).toBeGreaterThanOrEqual(heading.bottom);
    } else {
      // Two columns side by side, each bar beside its day.
      expect(longest.left).toBeGreaterThanOrEqual(byDay.right);
      expect(Math.abs(longest.top - byDay.top)).toBeLessThan(2);
      expect(track.left).toBeGreaterThanOrEqual(label.right);
    }
  },
);

test("a long session name is cut, and stays reachable in full", async () => {
  const long = "a-session-name-far-too-long-for-the-list-of-longest-waits-to-show";
  const answer = waits();
  answer.today.sessions[0] = { ...answer.today.sessions[0]!, name: long };
  answering(() => answer);
  await page.viewport(375, 900);
  const screen = await render(
    <div style={{ width: 343 }}>
      <WaitsCard history={null} sessions={[]} asOf={NOW} />
    </div>,
  );
  await expect.element(screen.getByText("By day")).toBeVisible();
  const name = part(screen.container, "name");
  await expect.poll(() => name.dataset.cut).toBe("true");
  expect(name.textContent).toBe(long);
  expect(name.getAttribute("tabindex")).toBe("0");
});

test.each([375, 1280])(
  "at %ipx, two sessions of one name in the longest waits, one here and one on another machine, are told apart",
  async (width) => {
    await page.viewport(width, 900);
    answering(() => {
      const answer = waits();
      answer.today.sessions = [
        {
          sessionId: "claude-code:1",
          name: "demo-local",
          waitedMs: 22 * MINUTE,
          waits: 3,
          open: false,
        },
        {
          sessionId: "remote:devbox:claude-code:1",
          name: "demo-local",
          waitedMs: 8 * MINUTE,
          waits: 1,
          open: false,
        },
      ];
      return answer;
    });
    const screen = await render(
      <WaitsCard history={history(NOW - HOUR)} sessions={[]} asOf={NOW} />,
    );
    await expect.element(screen.getByText("By day")).toBeVisible();
    const [here, there] = [
      ...screen.container.querySelectorAll<HTMLElement>('[data-part="session"]'),
    ] as [HTMLElement, HTMLElement];
    expect(part(here, "machine")).toBeNull();
    expect(part(there, "machine").textContent).toBe(" on devbox");
    expect(part(there, "name").textContent).toBe("demo-local on devbox");
    expect(part(here, "name").textContent).toBe("demo-local");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);
