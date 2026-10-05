import { useState } from "react";
import { afterEach, expect, test } from "vitest";
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
