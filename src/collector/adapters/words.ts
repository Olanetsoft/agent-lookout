/** Words every adapter says about itself on the Sources view. */

/** How often something is read, in words: "every second", "every 2 seconds", "every minute". */
export function every(ms: number): string {
  if (ms === 60_000) return "every minute";
  const seconds = ms / 1000;
  return seconds === 1 ? "every second" : `every ${seconds} seconds`;
}
