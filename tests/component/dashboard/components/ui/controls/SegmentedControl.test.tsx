import { useState } from "react";
import { expect, onTestFinished, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { SegmentedControl } from "@dashboard/components/ui/controls/SegmentedControl";
import { assistivePress, pointAway, startAtTop } from "@tests/support/browser/browser";
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

  // The parent has not taken the value, and one press still asks for it once.
  await screen.getByRole("radio", { name: "System" }).click();
  expect(onValueChange).toHaveBeenCalledTimes(1);
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
  expect(chosen).toEqual(["system", "light", "system"]);

  // Home and End choose the first and the last option.
  await userEvent.keyboard("{Home}");
  await expect.element(radio("Light")).toBeChecked();
  await userEvent.keyboard("{End}");
  await expect.element(radio("System")).toBeChecked();
  expect(chosen).toEqual(["system", "light", "system", "light", "system"]);

  // One stop for the whole group: only the chosen option is in the Tab order.
  const stops = [...screen.container.querySelectorAll<HTMLElement>('[role="radio"]')].map(
    (item) => item.tabIndex,
  );
  expect(stops).toEqual([-1, -1, 0]);
});

const onOff = [
  { value: "off", label: "Off" },
  { value: "on", label: "On" },
] as const;
type OnOff = (typeof onOff)[number]["value"];

/**
 * A switch whose parent keeps the old value until a later answer, as the Mac app's
 * switches do while their request is out. Every call is kept, in order.
 */
async function switchWaitingOnAnAnswer() {
  const calls: OnOff[] = [];
  const control = (value: OnOff) => (
    <SegmentedControl
      label='Show in menu bar'
      value={value}
      onValueChange={(next) => calls.push(next)}
      options={onOff}
    />
  );
  const screen = await render(control("off"));
  return {
    calls,
    radio: (name: string) => screen.getByRole("radio", { name }),
    answer: (value: OnOff) => screen.rerender(control(value)),
  };
}

type Switch = Awaited<ReturnType<typeof switchWaitingOnAnAnswer>>;

test.each<[string, (control: Switch) => Promise<unknown>]>([
  ["A tap, a press with no hold,", (control) => control.radio("On").click()],
  ["A click held for a moment", (control) => control.radio("On").click({ delay: 150 })],
  [
    "An arrow key still held when focus lands",
    async (control) => {
      (control.radio("Off").element() as HTMLElement).focus();
      await userEvent.keyboard("{ArrowRight>}");
      await expect.element(control.radio("On")).toHaveFocus();
      await userEvent.keyboard("{/ArrowRight}");
    },
  ],
  [
    "A quick arrow key",
    async (control) => {
      (control.radio("Off").element() as HTMLElement).focus();
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(control.radio("On")).toHaveFocus();
    },
  ],
  [
    "A press from a script, focus and then a click as the site tour's tap makes,",
    async (control) => {
      const on = control.radio("On").element() as HTMLElement;
      on.focus({ preventScroll: true });
      on.click();
    },
  ],
  [
    "A press from assistive technology, focus first and then the pointer, the mouse and the click,",
    async (control) => assistivePress(control.radio("On").element() as HTMLElement),
  ],
])("%s asks for the option once, though the parent has not taken it yet", async (_press, press) => {
  const control = await switchWaitingOnAnAnswer();

  await press(control);
  expect(control.calls).toEqual(["on"]);
  // Until the answer comes, the switch still shows the old value.
  await expect.element(control.radio("On")).not.toBeChecked();
  await expect.element(control.radio("Off")).toBeChecked();

  await control.answer("on");
  await expect.element(control.radio("On")).toBeChecked();
  expect(control.calls).toEqual(["on"]);
});

test("focus alone, with no key and no press, chooses nothing", async () => {
  const control = await switchWaitingOnAnAnswer();

  // A screen reader's cursor can carry keyboard focus onto an option as it reads.
  (control.radio("On").element() as HTMLElement).focus();
  await expect.element(control.radio("On")).toHaveFocus();
  expect(control.calls).toEqual([]);
  await expect.element(control.radio("Off")).toBeChecked();

  // Space then presses it, once.
  await userEvent.keyboard("[Space]");
  expect(control.calls).toEqual(["on"]);
});

test("a second press after the parent kept the old value asks again, once", async () => {
  const control = await switchWaitingOnAnAnswer();

  await control.radio("On").click();
  expect(control.calls).toEqual(["on"]);

  // The answer refuses the change, so the switch stays where it was.
  await control.answer("off");
  await expect.element(control.radio("Off")).toBeChecked();

  // One call per press, not one per value.
  await control.radio("On").click();
  expect(control.calls).toEqual(["on", "on"]);
  await expect.element(control.radio("On")).not.toBeChecked();

  // Once the parent has taken it, pressing the chosen option asks for nothing.
  await control.answer("on");
  await expect.element(control.radio("On")).toBeChecked();
  await control.radio("On").click();
  expect(control.calls).toEqual(["on", "on"]);
});

test("after the parent kept the old value, a key press on the option asks again, once", async () => {
  const control = await switchWaitingOnAnAnswer();

  (control.radio("Off").element() as HTMLElement).focus();
  await userEvent.keyboard("{ArrowRight>}");
  await expect.element(control.radio("On")).toHaveFocus();
  await userEvent.keyboard("{/ArrowRight}");
  expect(control.calls).toEqual(["on"]);

  // The answer refuses the change. Focus stays on On, and Space presses it.
  await control.answer("off");
  await expect.element(control.radio("Off")).toBeChecked();
  await userEvent.keyboard("[Space]");
  expect(control.calls).toEqual(["on", "on"]);

  // Back to Off, which is chosen, asks for nothing, and on to On again asks once more.
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(control.radio("Off")).toHaveFocus();
  expect(control.calls).toEqual(["on", "on"]);
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(control.radio("On")).toHaveFocus();
  expect(control.calls).toEqual(["on", "on", "on"]);
  await expect.element(control.radio("Off")).toBeChecked();
});

test("after the parent kept the old value, a press from a script asks again once focus has left", async () => {
  const control = await switchWaitingOnAnAnswer();
  const on = control.radio("On").element() as HTMLElement;
  // Focus and then a click, with no pointer or key, as the site tour's tap is.
  const tap = () => {
    on.focus({ preventScroll: true });
    on.click();
  };

  tap();
  expect(control.calls).toEqual(["on"]);
  await control.answer("off");
  await expect.element(control.radio("Off")).toBeChecked();

  // Focus leaves, as it does when something else is pressed, and the next tap asks again.
  on.blur();
  tap();
  expect(control.calls).toEqual(["on", "on"]);
  await expect.element(control.radio("Off")).toBeChecked();
});

test("after the parent kept the old value, a click of mouse events alone asks again, once", async () => {
  const control = await switchWaitingOnAnAnswer();
  const on = control.radio("On").element() as HTMLElement;

  await control.radio("On").click();
  expect(control.calls).toEqual(["on"]);
  await control.answer("off");
  await expect.element(control.radio("Off")).toBeChecked();

  // Focus is still on On. Mouse down, up and a click with no pointer events, as
  // assistive technology can press a button.
  on.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  on.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  on.click();
  expect(control.calls).toEqual(["on", "on"]);
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
