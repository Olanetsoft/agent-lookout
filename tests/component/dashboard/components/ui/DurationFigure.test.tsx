import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { DurationFigure } from "@dashboard/components/ui/DurationFigure";
import { durationParts } from "@dashboard/lib/format";
import { rgbOf } from "@tests/support/colours";

test("a duration figure sets its numbers in the sans at the figure's size, and its unit letters at the unit size in the secondary ink", async () => {
  const screen = await render(
    <p className='text-wait font-medium' data-testid='figure'>
      <DurationFigure parts={durationParts(252_000)} />
    </p>,
  );
  const figure = screen.container.querySelector('[data-slot="duration-figure"]') as HTMLElement;
  const style = getComputedStyle(figure);

  expect(figure.textContent).toBe("4m12s");
  // The sans, with figures that keep their width as it ticks.
  expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(style.fontVariantNumeric).toBe("tabular-nums");
  // At whatever size the figure is set: the hero's wait here.
  expect(style.fontSize).toBe(getComputedStyle(screen.getByTestId("figure").element()).fontSize);
  expect(parseFloat(style.fontSize)).toBeGreaterThanOrEqual(38);

  const units = [...figure.querySelectorAll('[data-part="unit"]')];
  expect(units.map((unit) => unit.textContent)).toEqual(["m", "s"]);
  for (const unit of units) {
    expect(getComputedStyle(unit).fontSize).toBe("22px");
    expect(getComputedStyle(unit).fontWeight).toBe("500");
    expect(getComputedStyle(unit).color).toBe(rgbOf("var(--ink-secondary)"));
  }
});

test("a duration figure keeps its width as it ticks, so nothing beside it moves", async () => {
  const screen = await render(
    <div style={{ display: "flex" }}>
      <p className='text-wait' data-testid='a'>
        <DurationFigure parts={durationParts(4 * 60_000 + 11_000)} />
      </p>
      <p className='text-wait' data-testid='b'>
        <DurationFigure parts={durationParts(4 * 60_000 + 17_000)} />
      </p>
    </div>,
  );
  const width = (id: string) => screen.getByTestId(id).element().getBoundingClientRect().width;

  expect(width("a")).toBe(width("b"));
});

test("a duration under a minute is one figure, and one over an hour is hours and minutes", async () => {
  const screen = await render(
    <div>
      <DurationFigure parts={durationParts(38_000)} />
      <DurationFigure parts={durationParts(65 * 60_000)} />
    </div>,
  );
  const figures = [...screen.container.querySelectorAll('[data-slot="duration-figure"]')];

  expect(figures.map((figure) => figure.textContent)).toEqual(["38s", "1h05m"]);
});
