import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session, SourceHealth } from "@core/session";
import { CountsRow } from "@dashboard/components/hero/CountsRow";
import { countState } from "@dashboard/lib/sessions";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser";
import { rgbOf, warmPaint } from "@tests/support/colours";

const NOW = new Date(2026, 0, 5, 18, 0, 0).getTime();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function session(n: number, overrides: Partial<Session>): Session {
  return makeSession({
    id: `claude-code:00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    name: `project-${n}`,
    ...overrides,
  });
}

const OK: SourceHealth[] = [
  { id: "claude-code", label: "Claude Code", state: "ok", checkedAt: NOW },
];

const SESSIONS: Session[] = [
  session(1, { status: "needs-you", statusSince: NOW - 4 * MINUTE }),
  session(2, { status: "needs-you", statusSince: NOW - 38_000 }),
  session(3, { status: "working", statusSince: NOW - 34 * MINUTE }),
  session(4, { status: "idle", statusSince: NOW - 65 * MINUTE }),
  session(5, { status: "idle", stale: true, statusSince: NOW - 3 * DAY }),
];

const LABELS = ["Working", "Idle", "Stale", "Sessions"];

function renderCounts(
  sessions: Session[] | null,
  sources: SourceHealth[] = OK,
  onOpenHistory?: (metric: "needsYou" | "working" | "idle") => void,
) {
  return render(
    <div style={{ width: 760, padding: 20 }}>
      <CountsRow counts={countState(sessions, sources)} asOf={NOW} onOpenHistory={onOpenHistory} />
    </div>,
  );
}

function countOf(container: HTMLElement, label: string): HTMLElement {
  return container.querySelector(`[data-slot="count"][aria-label="${label}"]`) as HTMLElement;
}

const valueOf = (container: HTMLElement, label: string) =>
  countOf(container, label).querySelector('[data-part="value"]')?.textContent ?? null;
const noteOf = (container: HTMLElement, label: string) =>
  countOf(container, label).querySelector('[data-part="note"]')?.textContent ?? null;

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  await page.viewport(414, 896);
});

test("the four counts are Working, Idle, Stale and Sessions, each a figure, a label and a note", async () => {
  const screen = await renderCounts(SESSIONS);
  const counts = [...screen.container.querySelectorAll('[data-slot="count"]')];

  await expect.element(screen.getByRole("group", { name: "Summary" })).toBeVisible();
  expect(counts.map((count) => count.getAttribute("aria-label"))).toEqual(LABELS);
  expect(LABELS.map((label) => valueOf(screen.container, label))).toEqual(["1", "1", "1", "5"]);
  expect(noteOf(screen.container, "Working")).toBe("longest 34m 00s");
  // The longest idle is the session idle 65 minutes, not the stale one's three days.
  expect(noteOf(screen.container, "Idle")).toBe("longest 1h 05m");
  expect(noteOf(screen.container, "Stale")).toBe("idle a day or more");
  // Nothing has finished, so there is no "0 finished".
  expect(noteOf(screen.container, "Sessions")).toBe("5 open");

  // Every session is counted once: the two that need the person are the hero's,
  // and with them the counts add up to the total.
  const needsYou = 2;
  const counted = ["Working", "Idle", "Stale"].map((label) =>
    Number(valueOf(screen.container, label)),
  );
  expect(needsYou + counted.reduce((sum, value) => sum + value, 0)).toBe(
    Number(valueOf(screen.container, "Sessions")),
  );

  // Needs you is the hero itself, not one of the counts. No Longest wait either.
  expect(countOf(screen.container, "Needs you")).toBeNull();
  expect(countOf(screen.container, "Longest wait")).toBeNull();
});

test("the figures are the sans at the stat size, with figures that keep their width, and the first three carry their mark", async () => {
  const screen = await renderCounts(SESSIONS);
  const value = countOf(screen.container, "Working").querySelector('[data-part="value"]')!;
  const style = getComputedStyle(value);

  expect(style.fontSize).toBe("28px");
  expect(style.fontWeight).toBe("500");
  expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(style.fontVariantNumeric).toContain("tabular-nums");
  expect(style.color).toBe(rgbOf("var(--ink)"));
  const label = getComputedStyle(
    countOf(screen.container, "Working").querySelector('[data-part="label"]')!,
  );
  expect(label.fontSize).toBe("13px");
  expect(label.fontWeight).toBe("600");
  // The notes are in the secondary ink: the hero never takes the muted one.
  const note = countOf(screen.container, "Working").querySelector('[data-part="note"]')!;
  expect(getComputedStyle(note).color).toBe(rgbOf("var(--ink-secondary)"));
  expect(getComputedStyle(note).fontSize).toBe("12px");

  const markOf = (label: string) =>
    countOf(screen.container, label)
      .querySelector('[data-slot="status-mark"]')
      ?.getAttribute("data-kind") ?? null;
  expect(LABELS.map(markOf)).toEqual(["working", "idle", "stale", null]);
  // No boxes: the counts sit straight on the hero's glass.
  for (const label of LABELS) {
    const box = getComputedStyle(countOf(screen.container, label));
    expect(box.backgroundColor, label).toBe("rgba(0, 0, 0, 0)");
    expect(box.borderTopWidth, label).toBe("0px");
  }
  expect(warmPaint(screen.container)).toEqual([]);
});

test("Sessions counts endings, and failures only when there are any", async () => {
  const ended = [
    ...SESSIONS.slice(2),
    session(6, { status: "finished", statusSince: NOW - MINUTE }),
    session(7, { status: "failed", statusSince: NOW - MINUTE }),
    session(8, { status: "failed", statusSince: NOW - MINUTE }),
  ];
  const screen = await renderCounts(ended);
  expect(valueOf(screen.container, "Sessions")).toBe("6");
  expect(noteOf(screen.container, "Sessions")).toBe("3 open, 1 finished, 2 failed");

  await screen.rerender(
    <CountsRow
      counts={countState(
        ended.filter((s) => s.status !== "finished"),
        OK,
      )}
      asOf={NOW}
    />,
  );
  expect(noteOf(screen.container, "Sessions")).toBe("3 open, 2 failed");
});

test("with sessions whose start was not reported, there is no longest", async () => {
  const screen = await renderCounts([
    session(1, { status: "working", statusSince: null }),
    session(2, { status: "idle", statusSince: null }),
  ]);

  expect(noteOf(screen.container, "Working")).toBe("time not reported");
  expect(noteOf(screen.container, "Idle")).toBe("time not reported");
});

test("with no sessions and a source read, each count is a real zero, and says so", async () => {
  const screen = await renderCounts([]);

  expect(LABELS.map((label) => valueOf(screen.container, label))).toEqual(["0", "0", "0", "0"]);
  expect(noteOf(screen.container, "Working")).toBe("none working");
  expect(noteOf(screen.container, "Idle")).toBe("none idle");
  expect(noteOf(screen.container, "Sessions")).toBe("none running");
});

test("before the first answer each count holds its place, with no number, and says what it counts", async () => {
  const screen = await render(
    <div style={{ width: 760, padding: 20 }}>
      <CountsRow counts={countState(null, OK)} asOf={NOW} />
      <CountsRow counts={countState(SESSIONS, OK)} asOf={NOW} />
    </div>,
  );
  const [pending, known] = [...screen.container.querySelectorAll('[data-slot="counts-row"]')] as [
    HTMLElement,
    HTMLElement,
  ];

  expect(pending.querySelectorAll('[data-part="placeholder"]')).toHaveLength(4);
  expect(pending.querySelector('[data-part="value"]')).toBeNull();
  expect(pending.textContent).not.toMatch(/\d/);
  // The layout does not jump when the numbers come.
  expect(pending.getBoundingClientRect().height).toBe(known.getBoundingClientRect().height);
  expect(
    [...pending.querySelectorAll('[data-part="note"]')].map((note) => note.textContent),
  ).toEqual(["busy with a task", "ready for a prompt", "idle a day or more", "all sessions found"]);
});

test.each(["unavailable", "error", "searching"] as const)(
  "when the only source is %s, each count is a dash that says Not known, because nothing was counted",
  async (sourceState) => {
    const screen = await renderCounts([], [{ ...OK[0]!, state: sourceState }]);

    for (const label of LABELS) {
      expect(valueOf(screen.container, label), label).toBe("–");
    }
    await expect.element(screen.getByRole("img", { name: "Not known" }).first()).toBeVisible();
    expect(screen.getByRole("img", { name: "Not known" }).all()).toHaveLength(4);
    // The note under a dash says why there is no count. It never says "found".
    expect(noteOf(screen.container, "Sessions")).toBe(
      sourceState === "searching" ? "not counted yet" : "no source to count",
    );
    const text = screen.container.textContent ?? "";
    expect(text).not.toContain("all sessions found");
    expect(text).not.toContain("none running");
    expect(text).not.toContain("none working");
  },
);

test("sessions found through a source that then failed are still counted", async () => {
  const screen = await renderCounts(
    [session(1, { status: "working", statusSince: NOW - MINUTE })],
    [{ ...OK[0]!, state: "error" }],
  );

  expect(valueOf(screen.container, "Sessions")).toBe("1");
  expect(valueOf(screen.container, "Working")).toBe("1");
});

test.each([
  ["loading", null, OK],
  ["counted", SESSIONS, OK],
  ["empty", [], OK],
  ["uncounted", [], [{ ...OK[0]!, state: "searching" }]],
] as const)("notes are short lower-case fragments when %s", async (_name, sessions, sources) => {
  const screen = await renderCounts(sessions as Session[] | null, sources as SourceHealth[]);
  const notes = [...screen.container.querySelectorAll('[data-part="note"]')];

  expect(notes).toHaveLength(4);
  for (const note of notes) {
    const text = note.textContent ?? "";
    expect(text).toMatch(/^[a-z0-9]/);
    expect(text).not.toMatch(/\.$/);
    expect(text.split(" ").length).toBeLessThanOrEqual(5);
  }
});

test("four across on a wide screen and two across below 1181px", async () => {
  const screen = await renderCounts(SESSIONS);
  const row = screen.container.querySelector('[data-slot="counts-row"]') as HTMLElement;
  const columns = () => getComputedStyle(row).gridTemplateColumns.split(" ").length;

  expect(columns()).toBe(4);
  await page.viewport(1181, 800);
  expect(columns()).toBe(4);
  await page.viewport(1180, 800);
  expect(columns()).toBe(2);
  await page.viewport(375, 800);
  expect(columns()).toBe(2);
});

test("Working and Idle open their history from a real button whose hit area is the whole count; Stale and Sessions open nothing", async () => {
  const onOpenHistory = vi.fn();
  const screen = await renderCounts(SESSIONS, OK, onOpenHistory);
  const working = countOf(screen.container, "Working");
  const button = screen.getByRole("button", { name: "Working: open history" });

  for (const label of ["Stale", "Sessions"]) {
    expect(countOf(screen.container, label).querySelector("button"), label).toBeNull();
    expect(getComputedStyle(countOf(screen.container, label)).cursor, label).not.toBe("pointer");
  }
  await expect.element(button).toHaveAttribute("aria-haspopup", "dialog");

  // The button's own box is its label. Its hit area is stretched over the count.
  const hit = getComputedStyle(button.element(), "::after");
  const box = working.getBoundingClientRect();
  expect(hit.position).toBe("absolute");
  expect(parseFloat(hit.width)).toBeCloseTo(box.width, 0);
  expect(parseFloat(hit.height)).toBeCloseTo(box.height, 0);
  expect(getComputedStyle(working).cursor).toBe("pointer");

  // A click on the figure opens it too.
  await userEvent.click(working.querySelector('[data-part="value"]') as HTMLElement, {
    // The button's hit area lies over the figure, which is the point of the test.
    force: true,
  });
  expect(onOpenHistory).toHaveBeenLastCalledWith("working");
  expect(getComputedStyle(working).outlineStyle).toBe("none");

  // By keyboard: Tab reaches it, the ring is drawn around the whole count, Enter opens it.
  await pointAway();
  startAtTop();
  await userEvent.tab();
  await expect.element(button).toHaveFocus();
  const ring = getComputedStyle(working);
  expect(ring.outlineStyle).toBe("solid");
  expect(ring.outlineWidth).toBe("2px");
  expect(ring.outlineColor).toBe(rgbOf("var(--focus)"));
  expect(getComputedStyle(button.element()).outlineStyle).toBe("none");
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "Idle: open history" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  expect(onOpenHistory).toHaveBeenLastCalledWith("idle");
});

test.each(["dark", "light"] as const)(
  "in the %s theme a count that opens lights under the pointer as one quiet rounded shape, and nothing in the row moves",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await renderCounts(SESSIONS, OK, vi.fn());
    const working = countOf(screen.container, "Working");
    const stale = countOf(screen.container, "Stale");
    const figure = working.querySelector('[data-part="value"]') as HTMLElement;
    const before = figure.getBoundingClientRect();

    expect(getComputedStyle(working).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(getComputedStyle(working).transitionDuration).toBe("0.12s");
    await userEvent.hover(figure, { force: true });
    await vi.waitFor(() =>
      expect(getComputedStyle(working).backgroundColor).toBe(rgbOf("var(--fill-hover)")),
    );
    expect(getComputedStyle(working).borderTopLeftRadius).toBe("14px");
    // The shape reaches into the gaps around the count; the count stays where it was.
    expect(figure.getBoundingClientRect().toJSON()).toEqual(before.toJSON());
    expect(working.getBoundingClientRect().left).toBeLessThan(before.left);
    // It is never warm.
    expect(warmPaint(working)).toEqual([]);

    // A count that opens nothing does not light.
    await userEvent.hover(stale);
    await new Promise((done) => setTimeout(done, 200));
    expect(getComputedStyle(stale).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  },
);

test("at the width of a phone a note wraps between words, never inside a duration", async () => {
  await page.viewport(375, 800);
  const screen = await render(
    <div style={{ width: 280 }}>
      <CountsRow counts={countState(SESSIONS, OK)} asOf={NOW} />
    </div>,
  );

  for (const label of ["Working", "Idle"]) {
    const note = countOf(screen.container, label).querySelector('[data-part="note"]')!;
    const value = note.querySelector('[data-part="note-value"]') as HTMLElement;
    expect(value.textContent, label).toMatch(/^\d+[hm] \d\d[ms]$/);
    expect(getComputedStyle(value).whiteSpace, label).toBe("nowrap");
    // The duration is on one line, whatever the note does around it.
    expect(value.getClientRects(), label).toHaveLength(1);
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

test("a count that was not counted has no history to open", async () => {
  const onOpenHistory = vi.fn();
  const screen = await renderCounts([], [{ ...OK[0]!, state: "searching" }], onOpenHistory);

  expect(screen.container.querySelector("button")).toBeNull();
  const loading = await renderCounts(null, OK, onOpenHistory);
  expect(loading.container.querySelector("button")).toBeNull();
});

test("a note too long for its count is cut on one line on a wide screen", async () => {
  const screen = await render(
    <div style={{ width: 520 }}>
      <CountsRow
        counts={countState(
          [...SESSIONS, session(6, { status: "finished" }), session(7, { status: "failed" })],
          OK,
        )}
        asOf={NOW}
      />
    </div>,
  );
  const note = countOf(screen.container, "Sessions").querySelector(
    '[data-part="note"]',
  ) as HTMLElement;
  const style = getComputedStyle(note);

  expect(style.whiteSpace).toBe("nowrap");
  expect(style.textOverflow).toBe("ellipsis");
});
