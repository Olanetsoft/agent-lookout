// Keeps the Mac from going to sleep on its own while the switch Keep the Mac
// awake is on and a session counts, by the rule in
// `src/core/keep-awake/keepAwakeRule.ts`: one that needs you, on this Mac or
// another one Agent Lookout watches, a working Claude Code session whose
// process runs, or another agent's working session updated in the last 30
// minutes. It follows each poll's snapshot, as the Dock badge does, so it is
// right with the window closed.
//
// It holds one blocker at most, Electron's `powerSaveBlocker` of the type
// `prevent-app-suspension`, which macOS takes as an assertion that stops idle
// sleep and lets the display sleep. It lets go once no session counts, at
// once when the switch is turned off, and as the app quits. Closing the lid,
// unless the Mac is plugged in with a display connected, Sleep in the Apple
// menu and a low battery put the Mac to sleep whatever it holds.
//
// The switch is read from `keep-awake-state.json` once, as it is made, and
// written there each time it is turned (`keepAwakeSettings.ts`). Of each
// snapshot it keeps one thing, whether any session counted, and nothing about
// any session.
//
// It imports nothing from Electron, so it is tested in plain Node with a
// stand-in for the blocker. `main.ts` hands it Electron's.

import type { KeepAwakeStatus } from "../../core/keep-awake/appKeepAwake.ts";
import { anyKeepsAwake, type KeepAwakeSession } from "../../core/keep-awake/keepAwakeRule.ts";
import type { KeepAwakeSettingsStore } from "./keepAwakeSettings.ts";

/** What it needs of Electron's `powerSaveBlocker`. */
export interface KeepAwakeBlocker {
  /** Takes a blocker, and gives its id. */
  start(type: "prevent-app-suspension"): number;
  /** Lets go of the blocker with that id. */
  stop(id: number): void;
}

export interface KeepAwakeOptions {
  blocker: KeepAwakeBlocker;
  settings: KeepAwakeSettingsStore;
  /** Told when the blocker could not be taken or let go. */
  warn?: (line: string) => void;
}

/** What it reads of each poll's snapshot. */
export interface KeepAwakeSnapshot {
  generatedAt: number;
  sessions: readonly KeepAwakeSession[];
}

export interface KeepAwake {
  /** Takes each poll's snapshot, and takes or lets go of the blocker to match it. */
  follow(snapshot: KeepAwakeSnapshot): void;
  /** Whether the switch is on. */
  status(): KeepAwakeStatus;
  /** Turns the switch on or off, remembers it, takes or lets go of the blocker at once, and says which it is. */
  setOn(on: boolean): KeepAwakeStatus;
  /** Lets go of the blocker, as the app quits. Nothing is taken after it. */
  stop(): void;
}

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const { blocker, settings, warn } = options;
  let on = settings.read().on;
  /** Whether a session counted in the last snapshot. */
  let counts = false;
  /** The blocker held, or null. Never more than one. */
  let id: number | null = null;
  /** Whether a failed start has been told of, so a start failing at every poll is told once. */
  let warnedStart = false;
  let stopped = false;

  function release(): void {
    if (id === null) return;
    const held = id;
    // Taken as let go whatever the call does, so it is never let go twice.
    id = null;
    try {
      blocker.stop(held);
    } catch (error) {
      warn?.(`The Mac could not be let go to sleep: ${String(error)}`);
    }
  }

  function apply(): void {
    const wanted = on && counts && !stopped;
    if (wanted && id === null) {
      try {
        id = blocker.start("prevent-app-suspension");
        warnedStart = false;
      } catch (error) {
        // Tried again at the next poll.
        if (!warnedStart) warn?.(`The Mac could not be kept awake: ${String(error)}`);
        warnedStart = true;
      }
    } else if (!wanted && id !== null) {
      release();
    }
  }

  return {
    follow(snapshot) {
      counts = anyKeepsAwake(snapshot.sessions, snapshot.generatedAt);
      apply();
    },
    status() {
      return { on };
    },
    setOn(next) {
      on = next;
      settings.write({ on });
      apply();
      return { on };
    },
    stop() {
      stopped = true;
      release();
    },
  };
}
