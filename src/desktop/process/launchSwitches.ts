// Switches the app refuses to start with.
//
// Chromium's remote debugging switches open the window's page to any program
// that connects: through a port on 127.0.0.1, or through a pair of pipes. Such
// a program can then do whatever the page can, Jump included, and the page
// holds the app's permission to bring a Terminal or iTerm2 tab forward. Any
// program running as this user could start the app with one. The Electron
// fuses already shut the Node debugger and `NODE_OPTIONS` out of the packaged
// app; these switches are not covered by a fuse, so the packaged app quits when
// it is given one. A development run keeps them, for the developer tools.
//
// It imports nothing from Electron, so it is tested in plain Node.

/** The switches that open the page to another program. */
export const DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;

/**
 * The first switch the app was started with that it refuses, or null when it
 * may start. `hasSwitch` is `app.commandLine.hasSwitch`.
 */
export function refusedSwitch(
  hasSwitch: (name: string) => boolean,
  packaged: boolean,
): string | null {
  if (!packaged) return null;
  return DEBUGGING_SWITCHES.find((name) => hasSwitch(name)) ?? null;
}
