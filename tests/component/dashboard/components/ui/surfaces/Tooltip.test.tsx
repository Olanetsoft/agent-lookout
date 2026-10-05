import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Button } from "@dashboard/components/ui/controls/Button";
import { Tooltip, Truncated } from "@dashboard/components/ui/surfaces/Tooltip";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf } from "@tests/support/browser/colours";

test("a tooltip opens on hover and on keyboard focus, as floating glass with real blur behind it", async () => {
  const screen = await render(
    <div style={{ padding: 80 }}>
      <Tooltip content='Open sources'>
        <Button>Sources</Button>
      </Tooltip>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Sources" });
  const tooltip = page.getByRole("tooltip");

  await trigger.hover();
  await expect.element(tooltip).toHaveTextContent("Open sources");
  const element = document.querySelector('[data-slot="tooltip"]') as HTMLElement;
  const box = getComputedStyle(element);
  // The densest glass, so its words hold their contrast over anything, the
  // lamp's light included, with real blur because the page passes behind it.
  expect(box.backgroundColor).toBe(rgbOf("var(--glass-float)"));
  expect(box.backdropFilter).toMatch(/^blur\(30px\) saturate\(/);
  expect(box.borderTopWidth).toBe("0px");
  expect(box.borderRadius).toBe("10px");
  expect(box.boxShadow).not.toBe("none");
  // A rim of light along its edge.
  expect(getComputedStyle(element, "::before").backgroundImage).toMatch(/linear-gradient/);
  expect(box.color).toBe(rgbOf("var(--ink)"));
  expect(box.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(box.fontSize).toBe("12px");

  await pointAway();
  await expect.element(tooltip).not.toBeInTheDocument();

  startAtTop();
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await expect.element(tooltip).toHaveTextContent("Open sources");
  await userEvent.keyboard("{Escape}");
  await expect.element(tooltip).not.toBeInTheDocument();
});

test("a tooltip does not open when focus is only put back by the page", async () => {
  const screen = await render(
    <div style={{ padding: 80 }}>
      <Tooltip content='Open sources'>
        <Button>Sources</Button>
      </Tooltip>
      <Button>Elsewhere</Button>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Sources" });

  // The mouse is in use, and a script moves focus: nobody asked for the tooltip.
  await screen.getByRole("button", { name: "Elsewhere" }).click();
  (trigger.element() as HTMLElement).focus();
  await expect.element(trigger).toHaveFocus();
  expect(trigger.element().matches(":focus-visible")).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});

test("a tooltip opened by Tab stays open while the page scrolls its element into view", async () => {
  const screen = await render(
    <div style={{ paddingTop: 2000, paddingBottom: 2000 }}>
      <Tooltip content='Open sources'>
        <Button>Sources</Button>
      </Tooltip>
    </div>,
  );
  const trigger = screen.getByRole("button", { name: "Sources" });
  const tooltip = page.getByRole("tooltip");
  window.scrollTo(0, 0);

  // The button is far below the fold, so reaching it makes the page scroll. Radix
  // closes a tooltip whose element scrolls, and this scroll is not the person leaving.
  startAtTop();
  await userEvent.tab();
  await expect.element(trigger).toHaveFocus();
  await vi.waitFor(() => expect(window.scrollY).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect.element(tooltip).toHaveTextContent("Open sources");

  // A scroll after that is the person moving on, and closes it as before.
  window.scrollBy(0, 100);
  await expect.element(tooltip).not.toBeInTheDocument();
  window.scrollTo(0, 0);
});

test("cut text gets a tooltip and a Tab stop only while it is cut", async () => {
  const text = "a-long-name-that-will-not-fit-in-a-narrow-box-however-hard-it-tries";
  const screen = await render(
    <div data-testid='box' style={{ width: 160, display: "flex" }}>
      <Truncated data-testid='text'>{text}</Truncated>
    </div>,
  );
  const node = screen.getByTestId("text").element() as HTMLElement;

  await vi.waitFor(() => expect(node.dataset.cut).toBe("true"));
  expect(node.tabIndex).toBe(0);
  expect(node.textContent).toBe(text);
  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(node);
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(text);

  // Given room, it is plain text again.
  (screen.getByTestId("box").element() as HTMLElement).style.width = "900px";
  await vi.waitFor(() => expect(node.dataset.cut).toBe("false"));
  expect(node.hasAttribute("tabindex")).toBe(false);
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

test("letters taller than a tight line are not a cut: only text that is missing is", async () => {
  // The name size sets its line tighter than its letters, so they reach past the
  // box by a few pixels. That is no part of the text missing.
  const screen = await render(
    <div style={{ width: 600, display: "flex" }}>
      <Truncated data-testid='one' className='text-name font-semibold'>
        a-short-name
      </Truncated>
    </div>,
  );
  const one = screen.getByTestId("one").element() as HTMLElement;
  expect(one.scrollHeight).toBeGreaterThan(one.clientHeight);
  expect(one.scrollWidth).toBeLessThanOrEqual(one.clientWidth);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(one.dataset.cut).toBe("false");
  expect(one.hasAttribute("tabindex")).toBe(false);

  // On two lines, the same tight letters are still not a cut, and a third line is.
  const words = "a name long enough to wrap onto a second line in this box";
  const two = await render(
    <div data-testid='box' style={{ width: 600, display: "flex" }}>
      <Truncated data-testid='two' lines={2} className='text-name font-semibold'>
        {words}
      </Truncated>
    </div>,
  );
  const clamped = two.getByTestId("two").element() as HTMLElement;
  expect(clamped.clientHeight).toBeGreaterThan(one.clientHeight * 1.5);
  expect(clamped.scrollHeight).toBeGreaterThan(clamped.clientHeight);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(clamped.dataset.cut).toBe("false");

  (two.getByTestId("box").element() as HTMLElement).style.width = "260px";
  await vi.waitFor(() => expect(clamped.dataset.cut).toBe("true"));
  expect(clamped.tabIndex).toBe(0);
  expect(clamped.textContent).toBe(words);
});

test("a tooltip that holds a machine fact is set in the mono", async () => {
  const screen = await render(
    <div style={{ padding: 80 }}>
      <Tooltip content='/Users/example/code/demo' mono>
        <Button>Folder</Button>
      </Tooltip>
    </div>,
  );

  await screen.getByRole("button", { name: "Folder" }).hover();
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("/Users/example/code/demo");
  const box = getComputedStyle(document.querySelector('[data-slot="tooltip"]') as HTMLElement);
  expect(box.fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
  expect(box.fontSize).toBe("12.5px");
  await pointAway();
});
