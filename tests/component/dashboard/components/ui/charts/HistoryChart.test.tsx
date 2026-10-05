import { expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { HistoryChart } from "@dashboard/components/ui/charts/HistoryChart";
import { startAtTop } from "@tests/support/browser/browser";
import { rgbOf } from "@tests/support/browser/colours";

test("a history chart draws both axes, hatches unmeasured time and reads out the count under the pointer", async () => {
  const start = new Date(2026, 0, 5, 17, 45, 0).getTime();
  const end = start + 900_000;
  // Measured for the last ten minutes only: 1, then 3 from the tenth minute.
  const samples = [];
  for (let at = start + 300_000; at <= end; at += 2_000) {
    samples.push({ at, value: at < start + 600_000 ? 1 : 3 });
  }
  const screen = await render(
    <div style={{ width: 630 }}>
      <HistoryChart
        samples={samples}
        start={start}
        end={end}
        tone='needs-you'
        label='Sessions that need you over the last 15 minutes'
        describe={(count) => `${count} need you`}
      />
    </div>,
  );
  const chart = screen.getByRole("slider");
  await vi.waitFor(() => expect(chart.element().querySelector("svg")).not.toBeNull());
  const svg = chart.element().querySelector("svg") as SVGSVGElement;
  const box = chart.element().getBoundingClientRect();
  const texts = (part: string) => [...svg.querySelectorAll(part)].map((node) => node.textContent);

  // A count axis in whole numbers from zero, and a time axis on round clock times.
  expect(svg.getBoundingClientRect().height).toBe(220);
  expect(texts("g > text").filter((text) => /^\d+$/.test(text ?? ""))).toEqual([
    "0",
    "1",
    "2",
    "3",
  ]);
  // At this width there is room for a mark every five minutes, clear of the edges.
  expect(texts('[data-part="time-tick"]')).toEqual(["17:50", "17:55"]);

  // The first third was not measured: hatched and labelled, with no line through it.
  // The hatch is the one a sparkline uses, drawn under the plot.
  const band = chart.element().querySelector('[data-part="unmeasured"]') as HTMLElement;
  const line = svg.querySelector('[data-part="line"]') as SVGPathElement;
  expect(band.classList.contains("unmeasured-hatch")).toBe(true);
  expect(getComputedStyle(band).backgroundImage).toContain("repeating-linear-gradient(135deg");
  expect(band.getBoundingClientRect().left).toBeCloseTo(box.left + 30, 0);
  expect(band.getBoundingClientRect().width).toBeCloseTo((box.width - 30 - 12) / 3, 0);
  const label = svg.querySelector('[data-part="unmeasured-label"]') as SVGTextElement;
  expect(label.textContent).toBe("Not measured");
  // A halo of the floating glass around its letters, so the hatch does not run
  // through them. It is drawn under the letters, not over them.
  expect(getComputedStyle(label).stroke).toBe(rgbOf("var(--glass-float)"));
  expect(getComputedStyle(label).paintOrder).toMatch(/^stroke/);
  expect(line.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    band.getBoundingClientRect().right - 1,
  );
  // The needs-you line is drawn in the lamp's edge, which holds its contrast in daylight.
  expect(getComputedStyle(line).stroke).toBe(rgbOf("var(--status-needs-you-edge)"));
  expect(getComputedStyle(svg.querySelector("text") as Element).fontFamily).toMatch(
    /^"?Atkinson Hyperlegible Mono/,
  );
  // The floor of the count axis is the stronger rule; the rest are hairlines.
  const grid = [...svg.querySelectorAll('[data-part="grid"]')].map(
    (rule) => getComputedStyle(rule).stroke,
  );
  expect(grid[0]).toBe(rgbOf("var(--rule-strong)"));
  expect(new Set(grid.slice(1))).toEqual(new Set([rgbOf("var(--hairline)")]));

  // Nothing is read out until something points.
  expect(chart.element().querySelector('[data-part="crosshair"]')).toBeNull();
  const plotLeft = 30;
  const plotWidth = box.width - 30 - 12;
  const pointAt = (share: number) =>
    userEvent.hover(chart, { position: { x: plotLeft + plotWidth * share, y: 100 } });

  // The reading is two lines: the time under the pointer, to within the second
  // or two that one pixel is worth, and the count then.
  const reading = () =>
    [...chart.element().querySelectorAll('[data-part="reading"] span')].map(
      (line) => line.textContent,
    );

  await pointAt(0.9);
  await vi.waitFor(() => expect(reading()[1]).toBe("3 need you"));
  expect(reading()[0]).toMatch(/^17:58:(2[89]|3[01])$/);
  // The reading is a small box of floating glass inside a rule, so it reads over
  // the chart and the glass alike, with no blur of its own.
  const readingBox = getComputedStyle(chart.element().querySelector('[data-part="reading"]')!);
  expect(readingBox.backgroundColor).toBe(rgbOf("var(--glass-float)"));
  expect(readingBox.boxShadow).toContain(`${rgbOf("var(--rule)")} 0px 0px 0px 1px inset`);
  expect(readingBox.borderRadius).toBe("10px");
  expect(readingBox.backdropFilter).toBe("none");
  expect(chart.element().querySelector('[data-part="crosshair"] circle')).not.toBeNull();

  await pointAt(0.5);
  await vi.waitFor(() => expect(reading()[1]).toBe("1 need you"));
  expect(reading()[0]).toMatch(/^17:52:(2[89]|3[01])$/);

  // Over the hatch it says so, and draws no dot: there is no value there.
  await pointAt(0.1);
  await vi.waitFor(() => expect(reading()[1]).toBe("Not measured"));
  expect(reading()[0]).toMatch(/^17:46:(2[89]|3[01])$/);
  expect(chart.element().querySelector('[data-part="crosshair"] circle')).toBeNull();
});

test("a history chart can be read with the keyboard", async () => {
  const start = new Date(2026, 0, 5, 17, 45, 0).getTime();
  const end = start + 900_000;
  const samples = [];
  for (let at = start + 300_000; at <= end; at += 2_000) {
    samples.push({ at, value: at < start + 600_000 ? 1 : 3 });
  }
  const screen = await render(
    <div style={{ width: 630 }}>
      <HistoryChart
        samples={samples}
        start={start}
        end={end}
        tone='working'
        label='Sessions working'
        describe={(count) => `${count} working`}
      />
    </div>,
  );
  const chart = screen.getByRole("slider", { name: /Sessions working/ });

  // At rest, assistive technology hears the present.
  await expect.element(chart).toHaveAttribute("aria-valuetext", "18:00:00: 3 working");

  startAtTop();
  await userEvent.tab();
  await expect.element(chart).toHaveFocus();
  await vi.waitFor(() =>
    expect(chart.element().querySelector('[data-part="crosshair"]')).not.toBeNull(),
  );

  // Each arrow is a sixtieth of the window: 15 seconds here.
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  await expect.element(chart).toHaveAttribute("aria-valuetext", "17:59:30: 3 working");
  await userEvent.keyboard("{PageDown}{PageDown}{PageDown}");
  await expect.element(chart).toHaveAttribute("aria-valuetext", "17:52:00: 1 working");
  await userEvent.keyboard("{Home}");
  await expect.element(chart).toHaveAttribute("aria-valuetext", "17:45:00: Not measured");
  await userEvent.keyboard("{End}");
  await expect.element(chart).toHaveAttribute("aria-valuetext", "18:00:00: 3 working");
});
