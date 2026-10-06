/**
 * The notification that the daily check found a new version, held through
 * quiet hours like every other notification. One found while they hold is
 * shown once they end, as the collector's next snapshot says, and a later one
 * found meanwhile takes its place. Settings says what was found all the same.
 */

export interface QuietNotice<Found> {
  /** The check found a version: shown now, or held while it is quiet. */
  found(found: Found): void;
  /** Takes whether it is quiet now, as each snapshot says: one held is shown once it is not. */
  quietNow(quiet: boolean): void;
}

export function createQuietNotice<Found>(options: {
  /** Whether it is quiet at this moment, by the collector's rules and clock. */
  isQuiet: () => boolean;
  show: (found: Found) => void;
}): QuietNotice<Found> {
  const { isQuiet, show } = options;
  let held: { found: Found } | null = null;

  return {
    found(found) {
      if (isQuiet()) held = { found };
      else show(found);
    },

    quietNow(quiet) {
      if (quiet || held === null) return;
      const { found } = held;
      held = null;
      show(found);
    },
  };
}
