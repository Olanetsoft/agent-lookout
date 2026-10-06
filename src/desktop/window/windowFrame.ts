// The shape of the app's window: its sizes, its background before the page
// paints, and where its three buttons sit.
//
// The window has no title bar. Its buttons sit on the top cell of the rail,
// centred across the rail and level with the middle of the header, so they
// cover nothing. The numbers here follow the stylesheet: the rail is inset 12px
// from the window's edges and is 76px wide in the app at every width, and its
// top cell, like the header, is 56px tall.
//
// It imports nothing from Electron, so it is tested in plain Node.

/** The window's size the first time it opens. */
export const DEFAULT_WINDOW_SIZE = { width: 1280, height: 860 } as const;

/** The smallest the window may be made. The dashboard holds at this width with the rail in full. */
export const MIN_WINDOW_SIZE = { width: 480, height: 520 } as const;

/**
 * The ground's top colour at Night, the default theme: the window's colour
 * until the page says which theme is in force. The page says so with
 * `<meta name="theme-color">`, and the window remembers it for next time.
 */
export const NIGHT_GROUND = "#090908";

/** The rail and the header, as the stylesheet draws them in the app. */
const RAIL = { inset: 12, width: 76, cellHeight: 56 } as const;

/**
 * The three buttons as macOS draws them: each button's width and height, and
 * the distance from one button's left edge to the next. Measured from a
 * window's standard buttons: 14 by 14, 23 apart, on macOS 26, and 14 by 16, 20
 * apart, on the versions before it.
 */
export function windowButtons(macosMajor: number): { width: number; height: number; step: number } {
  return macosMajor >= 26
    ? { width: 14, height: 14, step: 23 }
    : { width: 14, height: 16, step: 20 };
}

/**
 * Where the first of the window's buttons goes, in Electron's terms: `x` from
 * the window's left edge, and `y` from its top. The three are centred across
 * the rail, and on the middle of the rail's top cell, which is the middle of
 * the header too.
 */
export function windowButtonPosition(macosMajor: number): { x: number; y: number } {
  const buttons = windowButtons(macosMajor);
  const clusterWidth = 2 * buttons.step + buttons.width;
  return {
    x: Math.round(RAIL.inset + (RAIL.width - clusterWidth) / 2),
    y: Math.round(RAIL.inset + (RAIL.cellHeight - buttons.height) / 2),
  };
}

/** The major version of macOS from `process.getSystemVersion()`, such as 26 from "26.5.2", or 0. */
export function macosMajorVersion(systemVersion: string): number {
  const major = Number.parseInt(systemVersion, 10);
  return Number.isFinite(major) && major > 0 ? major : 0;
}
