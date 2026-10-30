import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { HistoryPanel } from "@dashboard/components/panels/HistoryPanel";
import type { CollectorState } from "@dashboard/lib/api/collectorStore";

const MINUTE = 60_000;

/** A poll every two seconds for the last ten minutes: one session needs you, two work, one is idle. */
function state(now: number): CollectorState {
  const points = [];
  for (let at = now - 10 * MINUTE; at <= now; at += 2_000) {
    points.push({ at, needsYou: 1, working: 2, idle: 1, total: 4 });
  }
  return {
    phase: "live",
    snapshot: null,
    events: [],
    history: { points, startedAt: now - 10 * MINUTE },
    lastOkAt: now,
    problem: null,
    problemKind: null,
  };
}

// The three dialogs draw the same chart, so each is checked.
test.each([
  { metric: "needsYou", title: "Needs you", chart: "Sessions that need you", count: "1 needs you" },
  { metric: "working", title: "Working", chart: "Sessions working", count: "2 working" },
  { metric: "idle", title: "Idle", chart: "Idle sessions", count: "1 idle" },
] as const)(
  "Shift+Tab from the $title chart, reached with Tab, goes back to the time window and then to Close",
  async ({ metric, title, chart: chartLabel, count }) => {
    const now = Date.now();
    await render(
      <HistoryPanel metric={metric} open onOpenChange={() => {}} now={now} state={state(now)} />,
    );
    const dialog = page.getByRole("dialog", { name: title });
    const close = dialog.getByRole("button", { name: "Close" });
    const window15 = dialog.getByRole("radio", { name: "15 min" });
    const chart = dialog.getByRole("slider", {
      name: new RegExp(`^${chartLabel} over the last 15 minutes`),
    });
    const part = (name: string) => chart.element().querySelector(`[data-part="${name}"]`);

    await expect.element(close).toHaveFocus();
    const atRest = chart.element().getAttribute("aria-valuetext");
    expect(atRest).toMatch(new RegExp(`^\\d\\d:\\d\\d:\\d\\d: ${count}$`));

    await userEvent.tab();
    await expect.element(window15).toHaveFocus();
    await userEvent.tab();
    await expect.element(chart).toHaveFocus();
    await vi.waitFor(() => {
      expect(part("reading")).not.toBeNull();
      expect(part("crosshair")).not.toBeNull();
    });

    // Back out of the chart: to the time window, never the dialog itself.
    await userEvent.tab({ shift: true });
    await expect.element(window15).toHaveFocus();
    // The reading goes once focus has left, and the chart says the present again.
    await vi.waitFor(() => {
      expect(part("reading")).toBeNull();
      expect(part("crosshair")).toBeNull();
    });
    expect(chart.element().getAttribute("aria-valuetext")).toBe(atRest);

    await userEvent.tab({ shift: true });
    await expect.element(close).toHaveFocus();

    // Tab to the chart again, and the reading is back at the present.
    await userEvent.tab();
    await userEvent.tab();
    await expect.element(chart).toHaveFocus();
    await vi.waitFor(() => expect(part("reading")).not.toBeNull());
    expect(chart.element().getAttribute("aria-valuetext")).toBe(atRest);
  },
);

test("the chart's reading goes when focus leaves it by Tab or by a click in the dialog", async () => {
  const now = Date.now();
  await render(
    <HistoryPanel metric='working' open onOpenChange={() => {}} now={now} state={state(now)} />,
  );
  const dialog = page.getByRole("dialog", { name: "Working" });
  const close = dialog.getByRole("button", { name: "Close" });
  const chart = dialog.getByRole("slider", {
    name: /Sessions working over the last 15 minutes/,
  });
  const part = (name: string) => chart.element().querySelector(`[data-part="${name}"]`);
  const reached = async () => {
    await expect.element(chart).toHaveFocus();
    await vi.waitFor(() => expect(part("reading")).not.toBeNull());
  };
  const gone = () =>
    vi.waitFor(() => {
      expect(part("reading")).toBeNull();
      expect(part("crosshair")).toBeNull();
    });

  await expect.element(close).toHaveFocus();
  await userEvent.tab();
  await userEvent.tab();
  await reached();

  // Tab past the chart: focus goes round to Close, and the reading goes.
  await userEvent.tab();
  await expect.element(close).toHaveFocus();
  await gone();

  // Back to the chart, then a click on the words under it.
  await userEvent.tab({ shift: true });
  await reached();
  await dialog.getByText("What this counts").click();
  expect(dialog.element().contains(document.activeElement)).toBe(true);
  expect(document.activeElement).not.toBe(chart.element());
  await gone();
});

test("Shift+Tab from the chart, clicked with the pointer still on it, goes back to the time window", async () => {
  const now = Date.now();
  await render(
    <HistoryPanel metric='working' open onOpenChange={() => {}} now={now} state={state(now)} />,
  );
  const dialog = page.getByRole("dialog", { name: "Working" });
  const window15 = dialog.getByRole("radio", { name: "15 min" });
  const chart = dialog.getByRole("slider", {
    name: /Sessions working over the last 15 minutes/,
  });
  const part = (name: string) => chart.element().querySelector(`[data-part="${name}"]`);

  // The pointer stays on the chart after the click, so the reading follows it.
  await chart.click();
  await expect.element(chart).toHaveFocus();
  await vi.waitFor(() => expect(part("reading")).not.toBeNull());

  await userEvent.tab({ shift: true });
  await expect.element(window15).toHaveFocus();
});
