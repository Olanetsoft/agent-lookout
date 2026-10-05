import { useState } from "react";
import { expect, onTestFinished, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

test("the segmented control is a set of radios that the arrow keys move through", async () => {
  const onValueChange = vi.fn();
  const options = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ] as const;
  const screen = await render(
    <SegmentedControl label='Theme' value='dark' onValueChange={onValueChange} options={options} />,
  );

  await expect.element(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect.element(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();

  await screen.getByRole("radio", { name: "System" }).click();
  expect(onValueChange).toHaveBeenLastCalledWith("system");

  // Pressing the chosen option again must not clear the choice.
  onValueChange.mockClear();
  await screen.getByRole("radio", { name: "Dark" }).click();
  expect(onValueChange).not.toHaveBeenCalled();

  (screen.getByRole("radio", { name: "Dark" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(screen.getByRole("radio", { name: "System" })).toHaveFocus();
});

test("an arrow key chooses the option it moves to, as a radio group does", async () => {
  const options = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ] as const;
  type Choice = (typeof options)[number]["value"];
  const chosen: Choice[] = [];
  function Harness() {
    const [value, setValue] = useState<Choice>("dark");
    return (
      <SegmentedControl
        label='Theme'
        value={value}
        onValueChange={(next) => {
          chosen.push(next);
          setValue(next);
        }}
        options={options}
      />
    );
  }
  const screen = await render(<Harness />);
  const radio = (name: string) => screen.getByRole("radio", { name });

  // Tab lands on the chosen option, and choosing nothing new changes nothing.
  startAtTop();
  await userEvent.tab();
  await expect.element(radio("Dark")).toHaveFocus();
  expect(chosen).toEqual([]);

  // A key press with no hold at all: focus moves, and the choice moves with it.
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(radio("System")).toHaveFocus();
  await expect.element(radio("System")).toBeChecked();
  await expect.element(radio("Dark")).not.toBeChecked();

  // It wraps, and left goes back.
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(radio("Light")).toBeChecked();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(radio("System")).toBeChecked();
  expect(new Set(chosen)).toEqual(new Set(["system", "light"]));
  expect(chosen[chosen.length - 1]).toBe("system");

  // One stop for the whole group: only the chosen option is in the Tab order.
  const stops = [...screen.container.querySelectorAll<HTMLElement>('[role="radio"]')].map(
    (item) => item.tabIndex,
  );
  expect(stops).toEqual([-1, -1, 0]);
});

test("an option can carry a name for assistive technology beside the word it shows", async () => {
  const options = [
    { value: "dark", label: "Night", name: "Dark theme" },
    { value: "light", label: "Day", name: "Light theme" },
  ] as const;
  const screen = await render(
    <SegmentedControl label='Theme' value='dark' onValueChange={() => {}} options={options} />,
  );

  await expect.element(screen.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  const night = screen.getByRole("radio", { name: "Dark theme" });
  await expect.element(night).toBeChecked();
  await expect.element(night).toHaveTextContent("Night");
  await expect.element(screen.getByRole("radio", { name: "Light theme" })).toHaveTextContent("Day");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the options sit in a recessed capsule well, and a raised thumb lies under the chosen one",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    onTestFinished(() => document.documentElement.removeAttribute("data-theme"));
    // Tests share one page, and the last click may have left the pointer where an
    // option is about to be drawn. These are the colours at rest, so it moves off.
    await pointAway();
    const options = [
      { value: "dark", label: "Night" },
      { value: "light", label: "Day" },
    ] as const;
    const screen = await render(
      <SegmentedControl label='Theme' value='dark' onValueChange={() => {}} options={options} />,
    );
    const well = screen.getByRole("radiogroup", { name: "Theme" }).element();
    const thumb = well.querySelector('[data-part="thumb"]') as HTMLElement;
    const chosen = getComputedStyle(screen.getByRole("radio", { name: "Night" }).element());
    const other = getComputedStyle(screen.getByRole("radio", { name: "Day" }).element());
    const wellStyle = getComputedStyle(well);
    const thumbStyle = getComputedStyle(thumb);

    // The well: recessed into the glass, inside the control's rim, with shade at its top.
    expect(wellStyle.backgroundColor).toBe(rgbOf("var(--well)"));
    expect(wellStyle.boxShadow).toContain(`${rgbOf("var(--control-rim)")} 0px 0px 0px 1px inset`);
    expect(wellStyle.boxShadow).toContain(`${rgbOf("var(--well-shade)")} 0px 1px 2px 0px inset`);
    expect(wellStyle.borderTopWidth).toBe("0px");
    expect(wellStyle.borderRadius).toBe("999px");

    // The thumb: raised out of it, with a top light and a soft drop, hidden from
    // assistive technology.
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect(thumbStyle.backgroundColor).toBe(rgbOf("var(--thumb)"));
    expect(thumbStyle.boxShadow).toContain(`${rgbOf("var(--control-top)")} 0px 1px 0px 0px inset`);
    expect(thumbStyle.boxShadow).toContain(`${rgbOf("var(--thumb-drop)")} 0px 2px 6px -2px`);
    expect(thumbStyle.borderRadius).toBe("999px");

    // The options are clear, and only the chosen one's words come up to full ink.
    expect(chosen.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(other.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(chosen.color).toBe(rgbOf("var(--ink)"));
    expect(other.color).toBe(rgbOf("var(--ink-secondary)"));
    expect(chosen.height).toBe("30px");
    expect(warmPaint(well)).toEqual([]);
  },
);

test("the thumb lies under the chosen option and slides to the next one chosen", async () => {
  const options = [
    { value: "dark", label: "Night" },
    { value: "light", label: "Day" },
    { value: "system", label: "System" },
  ] as const;
  const screen = await render(
    <SegmentedControl label='Theme' value='dark' onValueChange={() => {}} options={options} />,
  );
  const well = screen.getByRole("radiogroup", { name: "Theme" }).element();
  const thumb = () =>
    (well.querySelector('[data-part="thumb"]') as HTMLElement).getBoundingClientRect();
  const option = (name: string) =>
    screen.getByRole("radio", { name }).element().getBoundingClientRect();
  const under = (name: string) => {
    const [t, o] = [thumb(), option(name)];
    expect(Math.abs(t.left - o.left), name).toBeLessThan(1);
    expect(Math.abs(t.width - o.width), name).toBeLessThan(1);
  };

  under("Night");
  // It moves by transform, so nothing lays out again as it slides.
  const style = getComputedStyle(well.querySelector('[data-part="thumb"]') as HTMLElement);
  expect(style.transitionProperty).toContain("transform");
  expect(style.left).toBe("3px");

  await screen.rerender(
    <SegmentedControl label='Theme' value='system' onValueChange={() => {}} options={options} />,
  );
  await vi.waitFor(() => under("System"));
  await screen.rerender(
    <SegmentedControl label='Theme' value='light' onValueChange={() => {}} options={options} />,
  );
  await vi.waitFor(() => under("Day"));
});
