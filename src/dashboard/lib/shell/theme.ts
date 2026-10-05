/**
 * The theme preference: a small store outside React.
 *
 * The stored preference is "light", "dark" or "system". `data-theme` on <html>
 * only ever carries "light" or "dark". `index.html` applies the same rule in an
 * inline script before first paint, so the two must stay in step.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "agent-lookout-theme";

const DEFAULT_PREFERENCE: ThemePreference = "dark";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

function isPreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isPreference(stored) ? stored : DEFAULT_PREFERENCE;
  } catch {
    // Storage can be blocked. Keep the default.
    return DEFAULT_PREFERENCE;
  }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(LIGHT_QUERY).matches ? "light" : "dark";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

let state: ThemeState | null = null;
const listeners = new Set<() => void>();
let stopWatchingSystem: (() => void) | null = null;

function apply(next: ThemeState): void {
  state = next;
  document.documentElement.setAttribute("data-theme", next.resolved);
  for (const listener of listeners) listener();
}

function watchSystem(): void {
  if (stopWatchingSystem) return;
  const query = window.matchMedia(LIGHT_QUERY);
  const onChange = () => {
    if (state?.preference === "system") apply({ preference: "system", resolved: systemTheme() });
  };
  query.addEventListener("change", onChange);
  stopWatchingSystem = () => query.removeEventListener("change", onChange);
}

export function getThemeState(): ThemeState {
  if (!state) {
    const preference = readStoredPreference();
    state = { preference, resolved: resolve(preference) };
  }
  return state;
}

export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  watchSystem();
  // index.html sets the attribute before first paint. A host page that cannot run
  // an inline script has not, so the first subscriber makes sure it is there.
  const { resolved } = getThemeState();
  if (document.documentElement.getAttribute("data-theme") !== resolved) {
    document.documentElement.setAttribute("data-theme", resolved);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatchingSystem) {
      stopWatchingSystem();
      stopWatchingSystem = null;
    }
  };
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Storage can be blocked. The choice still applies until the page is closed.
  }
  apply({ preference, resolved: resolve(preference) });
}

/** For tests: forget the cached state so the next read comes from storage. */
export function resetThemeForTests(): void {
  state = null;
}
