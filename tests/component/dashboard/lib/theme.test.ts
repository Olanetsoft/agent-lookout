import { afterEach, expect, test, vi } from "vitest";

import {
  getThemeState,
  resetThemeForTests,
  setThemePreference,
  subscribeToTheme,
  THEME_STORAGE_KEY,
} from "@dashboard/lib/theme";

// Runs in the component project because the theme lives in localStorage, on
// <html> and in a media query.

afterEach(() => {
  localStorage.clear();
  resetThemeForTests();
  document.documentElement.removeAttribute("data-theme");
});

const systemTheme = () =>
  window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

test("dark is the default when nothing is stored", () => {
  expect(getThemeState()).toEqual({ preference: "dark", resolved: "dark" });
});

test("the stored preference is read under the agent-lookout-theme key", () => {
  expect(THEME_STORAGE_KEY).toBe("agent-lookout-theme");
  localStorage.setItem(THEME_STORAGE_KEY, "light");

  expect(getThemeState()).toEqual({ preference: "light", resolved: "light" });
});

test("a stored value that is not a theme falls back to dark", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "sepia");

  expect(getThemeState()).toEqual({ preference: "dark", resolved: "dark" });
});

test("system resolves to what the computer is set to, and html only ever carries light or dark", () => {
  setThemePreference("system");

  expect(getThemeState()).toEqual({ preference: "system", resolved: systemTheme() });
  expect(document.documentElement.getAttribute("data-theme")).toBe(systemTheme());
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
});

test("choosing a theme stores it, applies it and tells listeners", () => {
  const listener = vi.fn();
  const stop = subscribeToTheme(listener);

  setThemePreference("light");

  expect(listener).toHaveBeenCalledTimes(1);
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  // The window takes the day's warm stone.
  expect(getComputedStyle(document.documentElement).backgroundColor).toBe("rgb(212, 208, 202)");

  stop();
  setThemePreference("dark");
  expect(listener).toHaveBeenCalledTimes(1);
});

test("the first subscriber puts the theme on html when no inline script has", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light");
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);

  const stop = subscribeToTheme(() => {});

  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  stop();
});
