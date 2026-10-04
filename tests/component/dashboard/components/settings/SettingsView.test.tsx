import { afterEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { SettingsView } from "@dashboard/components/settings/SettingsView";
import { resetThemeForTests, THEME_STORAGE_KEY } from "@dashboard/lib/theme";
import { rgbOf, warmPaint } from "@tests/support/colours";
import { preferColorScheme } from "@tests/support/media";

afterEach(() => {
  localStorage.clear();
  resetThemeForTests();
  document.documentElement.removeAttribute("data-theme");
});

test("the theme offers Night, Day and System, named for assistive technology, with Night the default", async () => {
  const screen = await render(<SettingsView />);
  const theme = screen.getByRole("radiogroup", { name: "Theme" });

  await expect.element(screen.getByRole("region", { name: "Theme" })).toBeVisible();
  expect(
    [...theme.element().querySelectorAll('[role="radio"]')].map((radio) => [
      radio.textContent,
      radio.getAttribute("aria-label"),
    ]),
  ).toEqual([
    ["Night", "Dark theme"],
    ["Day", "Light theme"],
    ["System", "Follow the computer's setting"],
  ]);
  await expect.element(screen.getByRole("radio", { name: "Dark theme" })).toBeChecked();
});

test("a theme chosen here is applied and remembered", async () => {
  const screen = await render(<SettingsView />);

  await screen.getByRole("radio", { name: "Light theme" }).click();
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(212, 208, 202)");
  await expect.element(screen.getByRole("radio", { name: "Light theme" })).toBeChecked();

  // Remembered: the page is drawn afresh and the choice is still there.
  await screen.unmount();
  resetThemeForTests();
  const again = await render(<SettingsView />);
  await expect.element(again.getByRole("radio", { name: "Light theme" })).toBeChecked();
});

test("System follows the computer's setting, and changes when it does", async () => {
  await preferColorScheme("light");
  const screen = await render(<SettingsView />);

  await screen.getByRole("radio", { name: "Follow the computer's setting" }).click();
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");

  await preferColorScheme("dark");
  await vi.waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(9, 9, 8)");
  // The choice is still System: only what it resolves to has changed.
  await expect
    .element(screen.getByRole("radio", { name: "Follow the computer's setting" }))
    .toBeChecked();
});

test("the facts about this copy say its version and that its data stays on this computer", async () => {
  const screen = await render(<SettingsView />);
  const copy = screen.getByRole("region", { name: "This copy" });

  const rows = [...copy.element().querySelectorAll('[data-slot="fact-row"]')].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);
  expect(rows).toEqual([
    ["Version", `v${__APP_VERSION__}`],
    ["Your data", "Stays on this computer"],
  ]);
  expect(__APP_VERSION__).toMatch(/^\d+\.\d+\.\d+/);
});

test.each(["dark", "light"] as const)(
  "in the %s theme the view is glass cards, with no warm colour",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<SettingsView />);

    const cards = screen.container.querySelectorAll('[data-slot="section-card"]');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(getComputedStyle(card).backgroundColor).toBe(rgbOf("var(--glass-card)"));
      expect(getComputedStyle(card).borderRadius).toBe("24px");
      expect(getComputedStyle(card).backdropFilter).toBe("none");
    }
    // The choice of theme is the recessed well with its thumb.
    const well = screen.getByRole("radiogroup").element();
    expect(getComputedStyle(well).backgroundColor).toBe(rgbOf("var(--well)"));
    expect(well.querySelector('[data-part="thumb"]')).not.toBeNull();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);
