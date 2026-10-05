// What the person's computer says it prefers, for component tests: reduced
// motion and a light or dark colour scheme. The browser is told through the
// `emulateMedia` command that vite.config.ts gives the component project, and
// is put back to its own setting when the test finishes.

import { onTestFinished } from "vitest";
import { commands } from "vitest/browser";

interface EmulatedMedia {
  colorScheme?: "light" | "dark" | null;
  reducedMotion?: "reduce" | "no-preference" | null;
}

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMedia: (media: EmulatedMedia) => Promise<void>;
  }
}

/** Asks for as little motion as possible, until the test finishes. */
export async function preferReducedMotion(): Promise<void> {
  onTestFinished(() => commands.emulateMedia({ reducedMotion: null }));
  await commands.emulateMedia({ reducedMotion: "reduce" });
}

/** Sets the computer's own colour scheme, until the test finishes. */
export async function preferColorScheme(scheme: "light" | "dark"): Promise<void> {
  onTestFinished(() => commands.emulateMedia({ colorScheme: null }));
  await commands.emulateMedia({ colorScheme: scheme });
}
