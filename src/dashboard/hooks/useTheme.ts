import { useSyncExternalStore } from "react";

import {
  getThemeState,
  setThemePreference,
  subscribeToTheme,
  type ThemePreference,
  type ThemeState,
} from "@dashboard/lib/theme";

export interface UseTheme extends ThemeState {
  setPreference: (preference: ThemePreference) => void;
}

export function useTheme(): UseTheme {
  const state = useSyncExternalStore(subscribeToTheme, getThemeState);
  return { ...state, setPreference: setThemePreference };
}
