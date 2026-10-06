import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Checkbox } from "@dashboard/components/ui/controls/Checkbox";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

const ring = (token: string) => `${rgbOf(`var(${token})`)} 0px 0px 0px 1px inset`;

function Ticked({ onChange }: { onChange?: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(true);
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
      aria-label='End demo-project'
    />
  );
}

test.each(["dark", "light"] as const)(
  "in the %s theme it is a 16px square of quiet fill inside the control rim, ticked in the ink, and never warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<Ticked />);
    const box = screen.getByRole("checkbox", { name: "End demo-project" }).element();
    const look = getComputedStyle(box);

    expect(box.getBoundingClientRect().width).toBe(16);
    expect(box.getBoundingClientRect().height).toBe(16);
    expect(look.boxShadow).toContain(ring("--control-rim"));
    expect(look.backgroundColor).toBe(rgbOf("var(--fill-selected)"));
    expect(look.color).toBe(rgbOf("var(--ink)"));
    expect(box.getAttribute("aria-checked")).toBe("true");
    expect(box.querySelector("svg")).not.toBeNull();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("a click or Space ticks and unticks it, and says so", async () => {
  const changed = vi.fn();
  const screen = await render(
    <div style={{ padding: 40 }}>
      <Ticked onChange={changed} />
    </div>,
  );
  const box = screen.getByRole("checkbox", { name: "End demo-project" });

  await userEvent.click(box);
  await pointAway();
  expect(box.element().getAttribute("aria-checked")).toBe("false");
  // Once its fill has come back down, which takes a moment.
  await expect
    .poll(() => getComputedStyle(box.element()).backgroundColor)
    .toBe(rgbOf("var(--fill-quiet)"));
  expect(box.element().querySelector("svg")).toBeNull();

  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(box.element());
  await userEvent.keyboard(" ");
  expect(box.element().getAttribute("aria-checked")).toBe("true");
  expect(changed.mock.calls).toEqual([[false], [true]]);
});

test("one that is disabled cannot be changed", async () => {
  const changed = vi.fn();
  const screen = await render(
    <Checkbox checked onCheckedChange={changed} disabled aria-label='End demo-project' />,
  );
  const box = screen
    .getByRole("checkbox", { name: "End demo-project" })
    .element() as HTMLButtonElement;
  box.click();
  expect(changed).not.toHaveBeenCalled();
  expect(box.disabled).toBe(true);
});

test("a press up to 4px past its edge ticks it, as a finger on a phone lands, and the area draws nothing", async () => {
  await page.viewport(375, 700);
  const changed = vi.fn();
  const screen = await render(
    <div style={{ padding: 40 }}>
      <Ticked onChange={changed} />
    </div>,
  );
  const box = screen.getByRole("checkbox", { name: "End demo-project" }).element();
  const edge = box.getBoundingClientRect();

  // What is under a point 3px out from each corner is the box.
  for (const [x, y] of [
    [edge.left - 3, edge.top - 3],
    [edge.right + 3, edge.top - 3],
    [edge.left - 3, edge.bottom + 3],
    [edge.right + 3, edge.bottom + 3],
  ] as const) {
    expect(document.elementFromPoint(x, y)).toBe(box);
  }
  // And 6px out, it is not.
  expect(document.elementFromPoint(edge.left - 6, edge.top + 8)).not.toBe(box);

  await userEvent.click(box, { position: { x: -3, y: 8 } });
  expect(changed).toHaveBeenCalledWith(false);
  const area = getComputedStyle(box, "::after");
  expect(area.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(area.boxShadow).toBe("none");
});
