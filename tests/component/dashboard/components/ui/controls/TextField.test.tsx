import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { TextField } from "@dashboard/components/ui/controls/TextField";
import { startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

const ring = (token: string) => `${rgbOf(`var(${token})`)} 0px 0px 0px 1px inset`;

test.each(["dark", "light"] as const)(
  "in the %s theme it is the switches' recessed well, as tall as one of their options, with ink words in tabular numerals, and never warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <TextField aria-label='Minutes' defaultValue='10' className='w-16' />,
    );
    const field = screen.getByRole("textbox", { name: "Minutes" }).element();
    const look = getComputedStyle(field);

    expect(field.getAttribute("data-slot")).toBe("text-field");
    expect(field.getBoundingClientRect().height).toBe(30);
    expect(field.getBoundingClientRect().width).toBe(64);
    expect(look.backgroundColor).toBe(rgbOf("var(--well)"));
    expect(look.boxShadow).toContain(ring("--control-rim"));
    expect(look.borderRadius).toBe("999px");
    expect(look.color).toBe(rgbOf("var(--ink)"));
    expect(look.fontSize).toBe("13px");
    expect(look.fontVariantNumeric).toBe("tabular-nums");
    expect(look.textAlign).toBe("center");
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("it is a plain text field: the browser fills and corrects nothing in it", async () => {
  const screen = await render(<TextField aria-label='Quiet from' defaultValue='22:00' />);
  const field = screen.getByRole("textbox", { name: "Quiet from" }).element();
  expect(field.getAttribute("type")).toBe("text");
  expect(field.getAttribute("autocomplete")).toBe("off");
  expect(field.getAttribute("autocorrect")).toBe("off");
  expect(field.getAttribute("spellcheck")).toBe("false");
});

test("what cannot be taken gives it the strong rim", async () => {
  const screen = await render(<TextField aria-label='Minutes' aria-invalid defaultValue='0' />);
  const field = screen.getByRole("textbox", { name: "Minutes" }).element();
  expect(getComputedStyle(field).boxShadow).toContain(ring("--rule-strong"));
});

test("Tab reaches it, and it shows the one focus ring", async () => {
  const screen = await render(<TextField aria-label='Minutes' defaultValue='10' />);
  startAtTop();
  await userEvent.tab();
  const field = screen.getByRole("textbox", { name: "Minutes" }).element();
  expect(document.activeElement).toBe(field);
  const look = getComputedStyle(field);
  expect(look.outlineStyle).toBe("solid");
  expect(look.outlineWidth).toBe("2px");
  expect(look.outlineColor).toBe(rgbOf("var(--focus)"));
});
