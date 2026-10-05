// Status files as an agent writes them, for the tests of the status-file
// source. Every value is invented. Product code never imports this file.

/** The home folder the unit tests give the adapter. */
export const HOME = "/Users/example";

/** The folder the adapter reads by default, under that home. */
export const STATUS_DIR = `${HOME}/.agent-lookout/sessions`;

/** A clock in the middle of a working day, for the unit tests. */
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * The text of one status file: an agent called Night Shift working on
 * checkout-flow, with any field replaced, added or, as `undefined`, left out.
 */
export function statusFile(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: "Night Shift",
    name: "checkout-flow",
    cwd: "/Users/example/code/checkout-flow",
    status: "working",
    ...fields,
  });
}
