import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { HistoryPoint, Session, SessionsSnapshot, SourceHealth } from "@core/sessions/session";
import { DashboardView } from "@dashboard/components/dashboard/DashboardView";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";
import { SESSIONS_LAYOUT_STORAGE_KEY } from "@dashboard/lib/shell/sessionsLayout";
import { makeSession } from "@tests/fixtures/session";
import { quietWaits } from "@tests/fixtures/waits";
import { pointAway } from "@tests/support/browser/browser";
import { rgbOf, warmElements, warmPaint } from "@tests/support/browser/colours";
import { atFullSize, contrastOf, textBackdrops } from "@tests/support/browser/pixels";

const NOW = new Date(2026, 0, 5, 18, 0, 0).getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const jumpLink = (n: number) => `vscode://anthropic.claude-code/open?session=${uuid(n)}`;

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({ id: `claude-code:${uuid(n)}`, ...overrides });
}

const OK: SourceHealth = { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: NOW };

function snapshotOf(sessions: Session[], sources: SourceHealth[] = [OK]): SessionsSnapshot {
  return { generatedAt: NOW, sources, sessions };
}

const SESSIONS: Session[] = [
  session(1, {
    name: "blocked-one",
    surface: "vscode",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - (4 * MINUTE + 12_000),
    links: { open: jumpLink(1) },
  }),
  session(2, {
    name: "asked-one",
    status: "needs-you",
    waitingReason: "question",
    statusSince: NOW - 38_000,
  }),
  session(3, {
    name: "busy-one",
    surface: "vscode",
    status: "working",
    cwd: "/Users/example/code/other",
    statusSince: NOW - 34 * MINUTE,
    links: { open: jumpLink(3) },
  }),
  session(4, { name: "idle-one", status: "idle", statusSince: NOW - 65 * MINUTE }),
  session(5, { name: "stale-one", status: "idle", stale: true, statusSince: NOW - 3 * DAY }),
];

/** The same sessions with nobody waiting. */
const CALM: Session[] = SESSIONS.filter((s) => s.status !== "needs-you");

/** Polls every two seconds for the last ten minutes. */
function steadyHistory(counts: { needsYou: number; working: number; idle: number }) {
  const points: HistoryPoint[] = [];
  for (let at = NOW - 10 * MINUTE; at <= NOW; at += 2_000) {
    points.push({ at, ...counts, total: counts.needsYou + counts.working + counts.idle });
  }
  return { points, startedAt: NOW - 10 * MINUTE };
}

function state(overrides: Partial<CollectorState>): CollectorState {
  return {
    phase: "live",
    snapshot: snapshotOf(SESSIONS),
    events: [],
    history: steadyHistory({ needsYou: 2, working: 1, idle: 1 }),
    lastOkAt: NOW,
    problem: null,
    problemKind: null,
    ...overrides,
  };
}

const LOADING = state({ phase: "connecting", snapshot: null, history: null, lastOkAt: null });

/** The ground the app draws behind every view, so glass is measured over what it sits on. */
function Ground() {
  return (
    <div aria-hidden className='ground'>
      <i className='ground-main' />
      <i className='ground-deep' />
      <i className='ground-far' />
    </div>
  );
}

function renderView(collector: CollectorState, now = NOW, onOpenHistory = vi.fn()) {
  return render(
    <>
      <Ground />
      <DashboardView state={collector} now={now} onRetry={() => {}} onOpenHistory={onOpenHistory} />
    </>,
  );
}

const slot = (container: ParentNode, name: string) =>
  container.querySelector(`[data-slot="${name}"]`) as HTMLElement;
const rectOf = (element: Element) => element.getBoundingClientRect();

/** Brings every animation that ends to its end, such as the lamp's light rising into place. */
function settle() {
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
  }
}

/** Whether two boxes share any area. */
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

beforeEach(() => {
  // The Waits card asks the app for its totals. Here no session waited this week.
  setApiHost(async (path) =>
    path === "/api/waits" ? new Response(JSON.stringify(quietWaits(NOW))) : new Response("{}"),
  );
});

afterEach(async () => {
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
  localStorage.removeItem(SESSIONS_LAYOUT_STORAGE_KEY);
  await page.viewport(414, 896);
});

/** Once the Waits card has its answer, so what the page shows has settled. */
async function waitsRead(screen: { container: HTMLElement }) {
  await vi.waitFor(() =>
    expect(screen.container.querySelector('[data-part="waits"]')).not.toBeNull(),
  );
}

test("wide, the hero and Last hour share the first row at 1.75 to 1, then Sessions and Events, then the timeline and Waits across both, 16px apart", async () => {
  await page.viewport(1440, 1000);
  const screen = await renderView(state({}));
  await waitsRead(screen);
  const grid = slot(screen.container, "overview-grid");
  const [hero, lastHour, sessions, events, timeline, waits] = [
    slot(screen.container, "hero"),
    screen.getByRole("region", { name: "Last hour" }).element(),
    screen.getByRole("region", { name: /^Sessions/ }).element(),
    screen.getByRole("region", { name: "Events" }).element(),
    screen.getByRole("region", { name: "Timeline" }).element(),
    screen.getByRole("region", { name: "Waits", exact: true }).element(),
  ].map((element) => element as HTMLElement) as [
    HTMLElement,
    HTMLElement,
    HTMLElement,
    HTMLElement,
    HTMLElement,
    HTMLElement,
  ];

  // In the document, and so for the keyboard and a screen reader, in that order.
  const order = [hero, lastHour, sessions, events, timeline, waits];
  for (let index = 1; index < order.length; index += 1) {
    expect(
      order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }

  const columns = getComputedStyle(grid).gridTemplateColumns.split(" ").map(parseFloat);
  expect(columns).toHaveLength(2);
  expect(columns[0]! / columns[1]!).toBeCloseTo(1.75, 2);
  expect(getComputedStyle(grid).columnGap).toBe("16px");
  expect(getComputedStyle(grid).rowGap).toBe("16px");

  const [h, l, s, e, t, w] = order.map(rectOf) as [
    DOMRect,
    DOMRect,
    DOMRect,
    DOMRect,
    DOMRect,
    DOMRect,
  ];
  // The hero at the top left, Last hour beside it.
  expect(h.top).toBe(l.top);
  expect(l.left - h.right).toBe(16);
  expect(h.width).toBeCloseTo(columns[0]!, 0);
  // Sessions under the hero, Events under Last hour, as wide as each.
  expect(s.left).toBe(h.left);
  expect(s.width).toBeCloseTo(h.width, 0);
  expect(e.left).toBe(l.left);
  expect(s.top - Math.max(h.bottom, l.bottom)).toBe(16);
  expect(e.top).toBe(s.top);
  // The timeline across both, under them.
  expect(t.top - Math.max(s.bottom, e.bottom)).toBe(16);
  expect(t.left).toBe(h.left);
  expect(t.right).toBe(l.right);
  // Waits, the review of the day and the week, last and across both.
  expect(w.top - t.bottom).toBe(16);
  expect(w.left).toBe(h.left);
  expect(w.right).toBe(l.right);

  // One timeline row per session, in the order of the Sessions list with the
  // waiting ones first: the hero's sessions, then the table's.
  const drawn = [...timeline.querySelectorAll('[data-slot="timeline-row"] [data-part="name"]')];
  expect(drawn.map((name) => name.textContent)).toEqual([
    "blocked-one",
    "asked-one",
    "busy-one",
    "idle-one",
    "stale-one",
  ]);
});

test.each([1180, 760, 375])(
  "at %i pixels the layout is one column, hero first, then Last hour, Sessions, Events, the timeline and Waits, and nothing runs off the side",
  async (width) => {
    await page.viewport(width, 1000);
    const screen = await renderView(state({}));
    await waitsRead(screen);
    const order = [
      slot(screen.container, "hero"),
      screen.getByRole("region", { name: "Last hour" }).element(),
      screen.getByRole("region", { name: /^Sessions/ }).element(),
      screen.getByRole("region", { name: "Events" }).element(),
      screen.getByRole("region", { name: "Timeline" }).element(),
      screen.getByRole("region", { name: "Waits", exact: true }).element(),
    ].map(rectOf);

    expect(
      getComputedStyle(slot(screen.container, "overview-grid")).gridTemplateColumns.split(" "),
    ).toHaveLength(1);
    for (let index = 1; index < order.length; index += 1) {
      expect(order[index]!.top - order[index - 1]!.bottom, `card ${index}`).toBe(16);
      expect(order[index]!.left, `card ${index}`).toBe(order[0]!.left);
      expect(order[index]!.width, `card ${index}`).toBe(order[0]!.width);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("the lamp's light lies behind the hero in its own cell, and follows it when the layout stacks", async () => {
  await page.viewport(1440, 1000);
  const screen = await renderView(state({}));
  const hero = slot(screen.container, "hero");
  const light = slot(screen.container, "hero-light");

  expect(light.dataset.light).toBe("lamp");
  expect(light.classList.contains("lamp-light")).toBe(true);
  expect(light.getAttribute("aria-hidden")).toBe("true");
  // Behind the glass: drawn first, and under it.
  expect(light.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(Number(getComputedStyle(light).zIndex)).toBeLessThan(
    Number(getComputedStyle(hero).zIndex),
  );
  // Its warmth rises from behind the hero's top left, and never past the hero's
  // right edge, so it cannot widen the page.
  settle();
  const grid = rectOf(slot(screen.container, "overview-grid"));
  const wide = rectOf(light);
  expect(overlaps(wide, rectOf(hero))).toBe(true);
  expect(light.offsetLeft - hero.offsetLeft).toBe(-60);
  expect(light.offsetTop - hero.offsetTop).toBe(-90);
  expect(wide.right).toBeLessThanOrEqual(rectOf(hero).right + 1);

  // Stacked, it is still behind the hero, and the page is no wider for it.
  for (const width of [1180, 375]) {
    await page.viewport(width, 1000);
    const stacked = rectOf(light);
    expect(overlaps(stacked, rectOf(hero)), `${width}`).toBe(true);
    expect(light.offsetTop - hero.offsetTop, `${width}`).toBe(-90);
    expect(light.offsetLeft - hero.offsetLeft, `${width}`).toBe(-60);
    expect(stacked.right, `${width}`).toBeLessThanOrEqual(rectOf(hero).right + 1);
    expect(document.documentElement.scrollWidth, `${width}`).toBeLessThanOrEqual(window.innerWidth);
  }
  expect(grid.width).toBeGreaterThan(0);
});

test("with nothing waiting the silver rest light holds the hero instead, and before anything is counted neither light is drawn", async () => {
  await page.viewport(1440, 1000);
  const screen = await renderView(state({ snapshot: snapshotOf(CALM) }));
  const light = () =>
    screen.container.querySelector('[data-slot="hero-light"]') as HTMLElement | null;

  expect(light()?.dataset.light).toBe("rest");
  expect(light()?.classList.contains("rest-light")).toBe(true);
  expect(overlaps(rectOf(light()!), rectOf(slot(screen.container, "hero")))).toBe(true);

  for (const quiet of [
    LOADING,
    state({ snapshot: snapshotOf([], [{ ...OK, state: "searching" }]) }),
    state({ snapshot: snapshotOf([], [{ ...OK, state: "unavailable" }]) }),
  ]) {
    await screen.rerender(
      <DashboardView state={quiet} now={NOW} onRetry={() => {}} onOpenHistory={vi.fn()} />,
    );
    expect(light()).toBeNull();
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme every word in the hero keeps AA against the brightest of what is drawn behind it, busy and quiet",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    await atFullSize();
    // A pointer left over Jump by an earlier test would measure its hover colour.
    await pointAway();
    const worst = theme === "dark" ? "brightest" : "darkest";

    const screen = await renderView(state({}));
    for (const [name, collector] of [
      ["busy", state({})],
      ["quiet", state({ snapshot: snapshotOf(CALM) })],
    ] as const) {
      await screen.rerender(
        <>
          <Ground />
          <DashboardView state={collector} now={NOW} onRetry={() => {}} />
        </>,
      );
      const hero = slot(screen.container, "hero");
      expect(hero.dataset.light).toBe(name === "busy" ? "lamp" : "rest");
      window.scrollTo(0, 0);
      // The lamp rises into place over a second: measure it where it settles.
      settle();

      const runs = await textBackdrops(hero, worst);
      expect(runs.length, name).toBeGreaterThan(10);
      for (const { text, ink, backdrop } of runs) {
        const ratio = contrastOf(ink, backdrop);
        expect(
          ratio,
          `${theme} ${name}: "${text}" is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  },
);

test("before the first answer the layout holds its place with spinners, no numbers and no light", async () => {
  const screen = await renderView(LOADING);

  await expect.element(screen.getByText("Reading sessions").first()).toBeVisible();
  // The hero, Last hour, Sessions, Events, the timeline and Waits each hold their place.
  expect(screen.container.querySelectorAll('[data-slot="loading"]')).toHaveLength(6);
  expect(screen.container.querySelectorAll('[data-part="placeholder"]')).toHaveLength(4);
  expect(screen.container.querySelector('[data-part="value"]')).toBeNull();
  // Waiting is not a failure and not an empty result, and nothing is lit.
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("No agents are running");
  expect(screen.container.querySelector('[data-slot="hero-light"]')).toBeNull();
  expect(warmPaint(slot(screen.container, "dashboard"))).toEqual([]);
});

test("when the collector never answered, it shows a connection problem on glass, not an empty dashboard", async () => {
  const onRetry = vi.fn();
  const down = state({
    phase: "unreachable",
    snapshot: null,
    history: null,
    lastOkAt: null,
    problem: "The local server did not answer.",
    problemKind: "no-answer",
  });
  const screen = await render(<DashboardView state={down} now={NOW} onRetry={onRetry} />);

  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout is not answering");
  await expect.element(alert).toHaveTextContent("Check that Agent Lookout is still running");
  await expect.element(screen.getByText("The local server did not answer.")).toBeVisible();
  const card = getComputedStyle(
    screen.getByRole("region", { name: "Connection problem" }).element(),
  );
  expect(card.backgroundColor).toBe(rgbOf("var(--glass-card)"));
  expect(card.borderRadius).toBe("24px");
  // No hero, no counts full of zeros, no spinner and no "no agents" message.
  expect(screen.container.querySelector('[data-slot="hero"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="count"]')).toBeNull();
  expect(screen.container.querySelector('[data-slot="loading"]')).toBeNull();
  expect(screen.container.textContent).not.toContain("No agents are running");

  // Its one button is the quiet capsule.
  const retry = screen.getByRole("button", { name: "Try now" });
  expect(getComputedStyle(retry.element()).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
  await retry.click();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test.each([
  {
    kind: "error-status",
    problem: "The local server answered /api/sessions with error 500.",
    title: "Agent Lookout answered with an error",
    advice: "Its local server is running",
  },
  {
    kind: "not-data",
    problem: "The local server answered /api/sessions with something that is not data.",
    title: "The answer was not session data",
    advice: "served without its collector",
  },
] as const)(
  "a $kind failure is not described as no answer: title, advice and detail agree",
  async ({ kind, problem, title, advice }) => {
    const down = state({
      phase: "unreachable",
      snapshot: null,
      history: null,
      lastOkAt: null,
      problem,
      problemKind: kind,
    });
    const screen = await render(<DashboardView state={down} now={NOW} onRetry={() => {}} />);

    const alert = screen.getByRole("alert");
    await expect.element(alert).toHaveTextContent(title);
    await expect.element(alert).toHaveTextContent(advice);
    // The server did answer. Nothing on the page may say that it did not.
    const text = screen.container.textContent ?? "";
    expect(text).toContain(problem);
    expect(text).not.toContain("is not answering");
    expect(text).not.toContain("could not reach");
    // The route in the detail is a literal string, in mono.
    const route = screen.container.querySelector('[data-slot="unreachable"] dl [data-slot="fact"]');
    expect(route?.textContent).toBe("/api/sessions");
    expect(getComputedStyle(route as Element).fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  },
);

test("when the collector stops answering, the last data stays under a notice that says how old it is", async () => {
  const onRetry = vi.fn();
  const stalled = state({
    phase: "stalled",
    lastOkAt: NOW - 14_000,
    problem: "The local server did not answer.",
  });
  const screen = await render(<DashboardView state={stalled} now={NOW} onRetry={onRetry} />);

  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout has stopped updating");
  await expect.element(alert).toHaveTextContent("17:59:46");
  await expect.element(alert).toHaveTextContent("14s ago");
  // The notice is on top, above the hero.
  expect(rectOf(alert.element()).bottom).toBeLessThanOrEqual(
    rectOf(slot(screen.container, "hero")).top,
  );
  // The last good data is still on screen.
  expect(slot(screen.container, "hero").dataset.state).toBe("several");
  await expect.element(screen.getByText("blocked-one").first()).toBeVisible();

  const retry = screen.getByRole("button", { name: "Try now" });
  await retry.click();
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test("the stale notice is announced once: its age ticks on screen but not in what is read out", async () => {
  const stalled = state({ phase: "stalled", lastOkAt: NOW - 14_000 });
  const screen = await render(<DashboardView state={stalled} now={NOW} onRetry={() => {}} />);
  const alert = screen.getByRole("alert").element();
  /** The alert as assistive technology gets it: without what is hidden from it. */
  const announced = () => {
    const copy = alert.cloneNode(true) as HTMLElement;
    for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    return copy.textContent;
  };
  const before = announced();
  const age = alert.querySelector('[data-part="age"]') as HTMLElement;

  expect(before).toContain("at 17:59:46.");
  expect(before).not.toContain("ago");
  expect(age.textContent).toContain("(14s ago)");
  expect(age.getAttribute("aria-hidden")).toBe("true");
  expect(age.getAttribute("aria-live")).toBe("off");
  // The clock and the age beside it are one run, a clock time in a sentence: in
  // the sans, as the sentence is, with figures that keep their width.
  expect(getComputedStyle(age).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(getComputedStyle(age.parentElement!).fontVariantNumeric).toContain("tabular-nums");
  expect(getComputedStyle(age.parentElement!).fontSize).toBe(
    getComputedStyle(age.parentElement!.parentElement!).fontSize,
  );
  expect(age.parentElement?.textContent).toBe("17:59:46 (14s ago)");

  for (const later of [1_000, 2_000, 61_000]) {
    await screen.rerender(<DashboardView state={stalled} now={NOW + later} onRetry={() => {}} />);
    expect(announced()).toBe(before);
  }
  expect(age.textContent).toContain("(1m 15s ago)");
});

test("once the collector stops answering, time in status stops at the last answer, in the hero and in the table", async () => {
  const lastOkAt = NOW - 14_000;
  const stalled = state({ phase: "stalled", lastOkAt });
  const screen = await render(<DashboardView state={stalled} now={NOW} onRetry={() => {}} />);
  const heroTime = () =>
    slot(screen.container, "hero").querySelector('[data-part="wait"] [data-slot="duration-figure"]')
      ?.textContent;
  const rowTime = () =>
    screen.container.querySelector('[data-slot="session-row"] [data-part="duration"] [aria-hidden]')
      ?.textContent;

  // blocked-one began waiting 4m 12s before NOW, so 3m 58s before the last answer.
  expect(heroTime()).toBe("3m58s");
  // busy-one has worked 34m before NOW, so 33m 46s before the last answer. The
  // table gives it in its short form.
  expect(rowTime()).toBe("33m");

  // The clock goes on, a minute past the last answer. Nothing was measured, so
  // the durations do not: the row would read 34m if it counted on.
  await screen.rerender(<DashboardView state={stalled} now={NOW + 60_000} onRetry={() => {}} />);
  expect(heroTime()).toBe("3m58s");
  expect(rowTime()).toBe("33m");

  // When answers come back, they count up to the present again.
  const live = state({ phase: "live", lastOkAt: NOW + 60_000 });
  await screen.rerender(<DashboardView state={live} now={NOW + 60_000} onRetry={() => {}} />);
  expect(heroTime()).toBe("5m12s");
  expect(rowTime()).toBe("35m");
});

test("a short blip shows no notice", async () => {
  const blip = state({ phase: "live", problem: "The local server did not answer." });
  const screen = await render(<DashboardView state={blip} now={NOW} onRetry={() => {}} />);

  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  expect(slot(screen.container, "hero").dataset.state).toBe("several");
});

test("with no sessions the hero says nothing needs you, the counts read zero, and Sessions says no agents are running", async () => {
  const empty = state({
    snapshot: snapshotOf([]),
    history: steadyHistory({ needsYou: 0, working: 0, idle: 0 }),
  });
  const screen = await render(<DashboardView state={empty} now={NOW} onRetry={() => {}} />);

  await expect.element(screen.getByText("No agents are running")).toBeVisible();
  await expect
    .element(screen.getByRole("heading", { level: 2, name: "Nothing needs you" }))
    .toBeVisible();
  // The log is the moment watching began, with nothing since.
  await expect.element(screen.getByText("Nothing has changed since.")).toBeVisible();
  const value = (label: string) =>
    screen.container.querySelector(`[data-slot="count"][aria-label="${label}"] [data-part="value"]`)
      ?.textContent;
  expect(["Working", "Idle", "Stale", "Sessions"].map(value)).toEqual(["0", "0", "0", "0"]);
});

test.each(["dark", "light"] as const)(
  "in the %s theme loading, empty, never answered and stopped updating each look their own, and none is warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const states: Record<string, CollectorState> = {
      loading: LOADING,
      empty: state({
        snapshot: snapshotOf([]),
        history: steadyHistory({ needsYou: 0, working: 0, idle: 0 }),
      }),
      "never answered": state({
        phase: "unreachable",
        snapshot: null,
        history: null,
        lastOkAt: null,
        problem: "The local server did not answer.",
        problemKind: "no-answer",
      }),
      "stopped updating": state({
        phase: "stalled",
        snapshot: snapshotOf(CALM),
        history: steadyHistory({ needsYou: 0, working: 1, idle: 1 }),
        events: [
          {
            id: "event-1",
            at: NOW - 20_000,
            sessionId: CALM[0]!.id,
            sessionName: CALM[0]!.name,
            kind: "status-changed",
            from: "idle",
            to: "working",
            severity: "advisory",
          },
        ],
        lastOkAt: NOW - 14_000,
      }),
    };
    const screen = await render(<DashboardView state={LOADING} now={NOW} onRetry={() => {}} />);

    const signatures: string[] = [];
    for (const [name, collector] of Object.entries(states)) {
      await screen.rerender(<DashboardView state={collector} now={NOW} onRetry={() => {}} />);
      // With an answer in, the Waits card asks for its own, which comes at once here.
      if (collector.snapshot) await waitsRead(screen);
      const has = (selector: string) => screen.container.querySelector(selector) !== null;
      signatures.push(
        [
          has('[data-slot="loading"]') && "spinner",
          has('[role="alert"]') && "alert",
          has('[data-slot="count"] [data-part="value"]') && "figures",
          has('[data-slot="unreachable"]') && "connection card",
          has('[data-slot="empty-state"]') && "empty words",
          has('[data-slot="session-row"]') && "rows",
        ]
          .filter(Boolean)
          .join(" + "),
      );
      expect(warmPaint(screen.container), name).toEqual([]);
    }
    expect(signatures).toEqual([
      "spinner",
      "figures + empty words",
      "alert + connection card",
      "alert + figures + rows",
    ]);
  },
);

test("only the hero holds amber while sessions wait: the table below it has none", async () => {
  const screen = await render(<DashboardView state={state({})} now={NOW} onRetry={() => {}} />);
  const sessions = screen.getByRole("region", { name: /^Sessions/ }).element();

  // The waiting sessions are the hero's. The table holds the rest, and is not warm.
  expect(sessions.querySelectorAll('[data-slot="session-row"]')).toHaveLength(3);
  expect(sessions.textContent).not.toContain("blocked-one");
  expect(warmPaint(sessions)).toEqual([]);
  // But its count is every session.
  expect(sessions.querySelector('[data-part="count"]')?.textContent).toBe("5");
  // The only solid buttons on the Overview are the hero's.
  const solid = [...screen.container.querySelectorAll<HTMLElement>('[data-slot="button"]')].filter(
    (button) => getComputedStyle(button).backgroundColor === rgbOf("var(--status-needs-you)"),
  );
  expect(solid.length).toBeGreaterThan(0);
  for (const button of solid) {
    expect(
      button.closest('[data-slot="hero"]'),
      button.getAttribute("aria-label") ?? "",
    ).not.toBeNull();
  }
});

test("keyboard focus on a session's Jump in the table follows it up into the hero when it starts waiting", async () => {
  await page.viewport(1440, 1000);
  const busy = SESSIONS[2] as Session;
  const before = state({ snapshot: snapshotOf(CALM) });
  const screen = await render(<DashboardView state={before} now={NOW} onRetry={() => {}} />);
  const tableJump = screen.getByRole("link", { name: "Jump to busy-one in VS Code" });
  (tableJump.element() as HTMLElement).focus();
  await expect.element(tableJump).toHaveFocus();

  const waiting = CALM.map((s) =>
    s.id === busy.id
      ? {
          ...s,
          status: "needs-you" as const,
          waitingReason: "permission" as const,
          statusSince: NOW,
        }
      : s,
  );
  await screen.rerender(
    <DashboardView state={state({ snapshot: snapshotOf(waiting) })} now={NOW} onRetry={() => {}} />,
  );

  const heroJump = slot(screen.container, "hero").querySelector(
    `[data-slot="hero-session"][data-session="${busy.id}"] [data-part="jump"]`,
  ) as HTMLElement;
  expect(heroJump).not.toBeNull();
  await vi.waitFor(() => expect(document.activeElement).toBe(heroJump));
});

test("when a session moves to another group of the table, keyboard focus on its Jump moves with it", async () => {
  await page.viewport(1440, 1000);
  const moving = session(6, {
    name: "moving-one",
    status: "idle",
    statusSince: NOW - MINUTE,
    links: { open: jumpLink(6) },
  });
  const steady = session(7, { name: "steady-one", status: "idle", links: { open: jumpLink(7) } });
  const view = (sessions: Session[]) => (
    <DashboardView state={state({ snapshot: snapshotOf(sessions) })} now={NOW} onRetry={() => {}} />
  );
  const screen = await render(view([moving, steady]));
  const jumpOf = () =>
    screen.getByRole("link", { name: "Jump to moving-one in Terminal" }).element() as HTMLElement;
  const first = jumpOf();
  first.focus();
  expect(first.closest('[data-slot="session-group"]')?.getAttribute("data-group")).toBe("idle");

  // It starts working, and its row is drawn again under Working.
  await screen.rerender(view([{ ...moving, status: "working", statusSince: NOW }, steady]));
  const moved = jumpOf();
  expect(moved).not.toBe(first);
  expect(first.isConnected).toBe(false);
  expect(moved.closest('[data-slot="session-group"]')?.getAttribute("data-group")).toBe("working");
  await vi.waitFor(() => expect(document.activeElement).toBe(moved));
});

test("focus that has moved elsewhere is left there when a session moves", async () => {
  const moving = session(6, {
    name: "moving-one",
    status: "idle",
    statusSince: NOW - MINUTE,
    links: { open: jumpLink(6) },
  });
  const view = (sessions: Session[]) => (
    <div>
      <button type='button'>Elsewhere</button>
      <DashboardView
        state={state({ snapshot: snapshotOf(sessions) })}
        now={NOW}
        onRetry={() => {}}
      />
    </div>
  );
  const screen = await render(view([moving]));
  const jump = screen.getByRole("link", { name: "Jump to moving-one in Terminal" }).element();
  (jump as HTMLElement).focus();
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" }).element() as HTMLElement;
  elsewhere.focus();

  await screen.rerender(view([{ ...moving, status: "working" }]));
  expect(document.activeElement).toBe(elsewhere);

  // Nor is it pulled back once the page has let it go.
  (
    screen.getByRole("link", { name: "Jump to moving-one in Terminal" }).element() as HTMLElement
  ).focus();
  (document.activeElement as HTMLElement).blur();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await screen.rerender(view([moving]));
  expect(document.activeElement).toBe(document.body);
});

test("the hero's title and the Working and Idle counts open their history, and Stale and Sessions open nothing", async () => {
  const onOpenHistory = vi.fn();
  const screen = await renderView(state({}), NOW, onOpenHistory);
  const count = (label: string) =>
    screen.container.querySelector(`[data-slot="count"][aria-label="${label}"]`) as HTMLElement;

  await screen.getByRole("button", { name: "Needs you" }).click();
  expect(onOpenHistory).toHaveBeenLastCalledWith("needsYou");
  await screen.getByRole("button", { name: "Working: open history" }).click();
  expect(onOpenHistory).toHaveBeenLastCalledWith("working");
  await screen.getByRole("button", { name: "Idle: open history" }).click();
  expect(onOpenHistory).toHaveBeenLastCalledWith("idle");
  for (const label of ["Stale", "Sessions"]) {
    expect(count(label).querySelector("button"), label).toBeNull();
  }
});

test("the hero, Last hour, Sessions, Events and the timeline are glass: the hero raised, the rest at card height", async () => {
  onTestFinished(() => document.documentElement.removeAttribute("data-theme"));
  const screen = await renderView(state({}));

  expect(getComputedStyle(slot(screen.container, "hero")).backgroundColor).toBe(
    rgbOf("var(--glass-raised)"),
  );
  for (const name of ["Last hour", /^Sessions/, "Events", "Timeline"]) {
    const card = screen.getByRole("region", { name }).element();
    expect(getComputedStyle(card).backgroundColor, String(name)).toBe(rgbOf("var(--glass-card)"));
    // None of them blurs: nothing passes behind a card.
    expect(getComputedStyle(card).backdropFilter, String(name)).toBe("none");
  }
  expect(getComputedStyle(slot(screen.container, "hero")).backdropFilter).toBe("none");
});

/**
 * The width the app's frame leaves the Overview in a window this wide: the
 * window less its 12px insets, the rail and the gap beside it. The rail narrows
 * to its icons at 760 and below.
 */
const overviewWidth = (window: number) => window - (window <= 760 ? 92 : 112);

test.each([
  ["dark", 1440, 4],
  ["light", 1440, 4],
  ["dark", 1000, 4],
  ["light", 1000, 4],
  ["dark", 375, 1],
  ["light", 375, 1],
] as const)(
  "in the %s theme at %i pixels, the board takes the Sessions card's place with %i columns across, nothing runs off the side, and only the lamp is warm",
  async (theme, width, across) => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
    await page.viewport(width, 1000);
    const screen = await render(
      <>
        <Ground />
        <div style={{ width: overviewWidth(width) }}>
          <DashboardView state={state({})} now={NOW} onRetry={() => {}} />
        </div>
      </>,
    );
    settle();
    const sessions = screen.getByRole("region", { name: /^Sessions/ }).element() as HTMLElement;
    const board = sessions.querySelector('[data-slot="session-board"]') as HTMLElement;

    // The hero, Last hour, Events and the timeline stay where they are, in order.
    const order = [
      slot(screen.container, "hero"),
      screen.getByRole("region", { name: "Last hour" }).element(),
      sessions,
      screen.getByRole("region", { name: "Events" }).element(),
      screen.getByRole("region", { name: "Timeline" }).element(),
    ];
    for (let index = 1; index < order.length; index += 1) {
      expect(
        order[index - 1]!.compareDocumentPosition(order[index]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    if (width === 1440) {
      const [hero, events] = [rectOf(order[0]!), rectOf(order[3]!)];
      expect(rectOf(sessions).left).toBe(hero.left);
      expect(rectOf(sessions).width).toBeCloseTo(hero.width, 0);
      expect(events.top).toBe(rectOf(sessions).top);
    }

    expect(board).not.toBeNull();
    expect(sessions.querySelector('[data-slot="session-list"]')).toBeNull();
    const columns = [...board.querySelectorAll<HTMLElement>('[data-slot="board-column"]')];
    expect(columns.map((column) => column.dataset.column)).toEqual([
      "needs-you",
      "working",
      "idle",
      "ended",
    ]);
    expect(new Set(columns.map((column) => Math.round(rectOf(column).left))).size).toBe(across);
    // Each column keeps its head, laid one under another on a phone.
    for (const column of columns) {
      expect(column.querySelector("h3")).not.toBeNull();
      expect(rectOf(column).right).toBeLessThanOrEqual(rectOf(sessions).right);
    }
    expect(sessions.scrollWidth).toBeLessThanOrEqual(sessions.clientWidth);
    for (const card of board.querySelectorAll<HTMLElement>('[data-slot="board-card"]')) {
      expect(card.scrollWidth, card.dataset.session).toBeLessThanOrEqual(card.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    // On the board, the waiting sessions' marks are the only warm paint.
    const warm = warmElements(board);
    expect(warm.length).toBeGreaterThan(0);
    for (const element of warm) {
      expect(
        element.closest('[data-slot="status-mark"][data-kind="needs-you"]'),
        element.outerHTML.slice(0, 80),
      ).not.toBeNull();
    }
    // And the only solid buttons on the Overview are still the hero's.
    for (const button of screen.container.querySelectorAll<HTMLElement>('[data-slot="button"]')) {
      if (getComputedStyle(button).backgroundColor !== rgbOf("var(--status-needs-you)")) continue;
      expect(button.closest('[data-slot="hero"]'), button.ariaLabel ?? "").not.toBeNull();
    }
  },
);

test("on the board a card moves to its new column with the next answer, and keyboard focus on its Jump goes with it", async () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
  await page.viewport(1440, 1000);
  const moving = session(6, {
    name: "moving-one",
    status: "idle",
    statusSince: NOW - MINUTE,
    links: { open: jumpLink(6) },
  });
  const steady = session(7, { name: "steady-one", status: "idle", statusSince: NOW - 2 * MINUTE });
  const view = (sessions: Session[]) => (
    <DashboardView state={state({ snapshot: snapshotOf(sessions) })} now={NOW} onRetry={() => {}} />
  );
  const columnOf = (element: Element) =>
    element.closest('[data-slot="board-column"]')?.getAttribute("data-column");
  const screen = await render(view([moving, steady]));
  const jumpOf = () =>
    screen.getByRole("link", { name: "Jump to moving-one in Terminal" }).element() as HTMLElement;
  const first = jumpOf();
  expect(columnOf(first)).toBe("idle");
  first.focus();

  // The next answer says it is working: its card is drawn under Working, and
  // nothing had to be pressed or dragged.
  await screen.rerender(view([{ ...moving, status: "working", statusSince: NOW }, steady]));
  const moved = jumpOf();
  expect(first.isConnected).toBe(false);
  expect(columnOf(moved)).toBe("working");
  await vi.waitFor(() => expect(document.activeElement).toBe(moved));
  const heads = () =>
    [...screen.container.querySelectorAll('[data-slot="board-column"] h3')].map(
      (head) => head.textContent,
    );
  expect(heads()).toEqual(["Needs you0", "Working1", "Idle1", "Finished or failed0"]);

  // It starts waiting: the hero has it, and so does the board's Needs you
  // column, where focus stays, on the board it was on.
  await screen.rerender(
    view([
      { ...moving, status: "needs-you", waitingReason: "permission", statusSince: NOW },
      steady,
    ]),
  );
  const cards = screen.container.querySelectorAll(
    `[data-slot="board-card"][data-session="${moving.id}"]`,
  );
  expect(cards).toHaveLength(1);
  expect(columnOf(cards[0]!)).toBe("needs-you");
  expect(
    slot(screen.container, "hero").querySelector(`[data-session="${moving.id}"]`),
  ).not.toBeNull();
  await vi.waitFor(() =>
    expect(document.activeElement?.closest('[data-slot="board-card"]')).toBe(cards[0]),
  );
  expect(heads()).toEqual(["Needs you1", "Working0", "Idle1", "Finished or failed0"]);
});
