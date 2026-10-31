import { useState } from "react";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Button } from "@dashboard/components/ui/controls/Button";
import { DetailsModal } from "@dashboard/components/ui/surfaces/DetailsModal";
import { startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

/** A page with a button that opens the dialog, as a count opens its history. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 40 }}>
      <Button onClick={() => setOpen(true)}>Open history</Button>
      <DetailsModal
        open={open}
        onOpenChange={setOpen}
        title='Working'
        description='How many sessions were working.'
      >
        <p>
          <Button>First inside</Button>
          <Button>Second inside</Button>
        </p>
      </DetailsModal>
    </div>
  );
}

/**
 * A dialog that is mostly reading, as a session's details are: focus starts on
 * its title. After its two controls come buttons Tab never reaches: one that is
 * disabled, one that is not drawn, one drawn unseen, one inside a part that is
 * not drawn, and one taken out of the order.
 */
function ReadingHarness() {
  return (
    <DetailsModal
      open
      onOpenChange={() => {}}
      title='checkout-flow'
      description='What it is doing now.'
      focusTitle
    >
      <p>
        <Button>First inside</Button>
        <Button>Second inside</Button>
        <Button disabled>Not now</Button>
        <Button style={{ display: "none" }}>Not drawn</Button>
        <Button style={{ visibility: "hidden" }}>Not seen</Button>
        <span style={{ display: "none" }}>
          <Button>In a closed part</Button>
        </span>
        <Button tabIndex={-1}>Out of the order</Button>
      </p>
    </DetailsModal>
  );
}

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test.each(["dark", "light"] as const)(
  "in the %s theme the dialog is floating glass with real blur behind it, over a flat scrim",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<Harness />);
    await screen.getByRole("button", { name: "Open history" }).click();

    const dialog = page.getByRole("dialog", { name: "Working" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog).toHaveAccessibleDescription("How many sessions were working.");
    const element = dialog.element();
    const style = getComputedStyle(element);

    // The densest tint, so its words hold their contrast over the lamp's light.
    expect(element.getAttribute("data-slot")).toBe("details-modal");
    expect(style.backgroundColor).toBe(rgbOf("var(--glass-float)"));
    expect(style.backdropFilter).toMatch(/^blur\(30px\) saturate\(/);
    expect(style.borderRadius).toBe("24px");
    expect(style.borderTopWidth).toBe("0px");
    expect(style.boxShadow).not.toBe("none");
    expect(getComputedStyle(element, "::before").backgroundImage).toMatch(/linear-gradient/);
    // The scrim is a flat fill: the dialog's own glass is the only blur.
    const scrim = document.querySelector('[data-slot="scrim"]') as HTMLElement;
    expect(getComputedStyle(scrim).backgroundColor).toBe(rgbOf("var(--scrim)"));
    expect(getComputedStyle(scrim).backdropFilter).toBe("none");
    expect(warmPaint(element)).toEqual([]);

    await userEvent.keyboard("{Escape}");
    await expect.element(dialog).not.toBeInTheDocument();
  },
);

test("the dialog holds focus while it is open, closes on Escape and gives focus back to what opened it", async () => {
  const screen = await render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open history" });

  startAtTop();
  await userEvent.tab();
  await expect.element(opener).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  const dialog = page.getByRole("dialog", { name: "Working" });
  await expect.element(dialog).toBeVisible();

  for (let presses = 0; presses < 6; presses += 1) {
    await userEvent.tab();
    expect(dialog.element().contains(document.activeElement)).toBe(true);
  }
  // The close button is a 28px circle, named for what it does.
  const close = page.getByRole("button", { name: "Close" });
  const box = close.element().getBoundingClientRect();
  expect([box.width, box.height]).toEqual([28, 28]);

  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();

  // Closing with its button gives focus back too.
  await opener.click();
  await expect.element(dialog).toBeVisible();
  await close.click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("Shift+Tab from the title goes to the last control, and Tab from there goes round to Close", async () => {
  await render(<ReadingHarness />);
  const dialog = page.getByRole("dialog", { name: "checkout-flow" });
  const title = dialog.getByRole("heading", { name: "checkout-flow" });
  const close = dialog.getByRole("button", { name: "Close" });
  const first = dialog.getByRole("button", { name: "First inside" });
  const second = dialog.getByRole("button", { name: "Second inside" });

  await expect.element(title).toHaveFocus();
  // Past the disabled control and the one that is not drawn, with its focus ring.
  await userEvent.tab({ shift: true });
  await expect.element(second).toHaveFocus();
  expect(second.element().matches(":focus-visible")).toBe(true);
  await userEvent.tab({ shift: true });
  await expect.element(first).toHaveFocus();
  await userEvent.tab();
  await userEvent.tab();
  await expect.element(close).toHaveFocus();
});

test("Tab from the title still goes to Close", async () => {
  await render(<ReadingHarness />);
  const dialog = page.getByRole("dialog", { name: "checkout-flow" });

  await expect.element(dialog.getByRole("heading", { name: "checkout-flow" })).toHaveFocus();
  await userEvent.tab();
  await expect.element(dialog.getByRole("button", { name: "Close" })).toHaveFocus();
});

test("after a click on plain text, Shift+Tab goes to the last control and Tab to Close", async () => {
  await render(<ReadingHarness />);
  const dialog = page.getByRole("dialog", { name: "checkout-flow" });
  const description = dialog.getByText("What it is doing now.");

  // Plain text takes no focus, so the click puts it on the dialog itself.
  await description.click();
  expect(document.activeElement).toBe(dialog.element());
  await userEvent.tab({ shift: true });
  const second = dialog.getByRole("button", { name: "Second inside" });
  await expect.element(second).toHaveFocus();
  expect(second.element().matches(":focus-visible")).toBe(true);

  await description.click();
  expect(document.activeElement).toBe(dialog.element());
  await userEvent.tab();
  await expect.element(dialog.getByRole("button", { name: "Close" })).toHaveFocus();
});

test("in a browser without checkVisibility, as an older Safari, Shift+Tab from the title still skips what Tab never reaches", async () => {
  const own = Object.getOwnPropertyDescriptor(Element.prototype, "checkVisibility");
  Object.defineProperty(Element.prototype, "checkVisibility", {
    configurable: true,
    value: undefined,
  });
  onTestFinished(() => {
    if (own) Object.defineProperty(Element.prototype, "checkVisibility", own);
  });
  await render(<ReadingHarness />);
  const dialog = page.getByRole("dialog", { name: "checkout-flow" });
  const second = dialog.getByRole("button", { name: "Second inside" });

  await expect.element(dialog.getByRole("heading", { name: "checkout-flow" })).toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(second).toHaveFocus();
  // Found the same way with no checkVisibility, it is still the last: Tab from it goes round.
  await userEvent.tab();
  await expect.element(dialog.getByRole("button", { name: "Close" })).toHaveFocus();
});

/**
 * A dialog taller than the window, with focus on its title, where Close is the
 * first control and a button far below it the last.
 */
async function renderTall() {
  await render(
    <DetailsModal open onOpenChange={() => {}} title='checkout-flow' focusTitle>
      <div style={{ height: 2400 }} />
      <Button>At the end</Button>
    </DetailsModal>,
  );
  const dialog = page.getByRole("dialog", { name: "checkout-flow" });
  await expect.element(dialog.getByRole("heading", { name: "checkout-flow" })).toHaveFocus();
  // Once it has risen into place, so what is measured is where it stays.
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  return {
    close: dialog.getByRole("button", { name: "Close" }),
    end: dialog.getByRole("button", { name: "At the end" }),
  };
}

function inView(element: Element): boolean {
  const box = element.getBoundingClientRect();
  return box.top >= 0 && box.bottom <= window.innerHeight;
}

test("in a dialog taller than the window, Shift+Tab from the title brings the last control into view", async () => {
  const { end } = await renderTall();
  expect(end.element().getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);

  await userEvent.tab({ shift: true });
  await expect.element(end).toHaveFocus();
  expect(inView(end.element())).toBe(true);
});

test("in a dialog taller than the window, Tab from the last control goes round to the first and brings it into view", async () => {
  const { close, end } = await renderTall();
  await userEvent.tab({ shift: true });
  await expect.element(end).toHaveFocus();
  expect(inView(close.element())).toBe(false);

  await userEvent.tab();
  await expect.element(close).toHaveFocus();
  expect(close.element().matches(":focus-visible")).toBe(true);
  expect(inView(close.element())).toBe(true);
});

test("in a dialog taller than the window, Shift+Tab from the first control goes round to the last and brings it into view", async () => {
  const { close, end } = await renderTall();
  await userEvent.tab();
  await expect.element(close).toHaveFocus();
  expect(inView(end.element())).toBe(false);

  await userEvent.tab({ shift: true });
  await expect.element(end).toHaveFocus();
  expect(end.element().matches(":focus-visible")).toBe(true);
  expect(inView(end.element())).toBe(true);
});
