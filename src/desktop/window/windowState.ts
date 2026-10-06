// What the app remembers about its window between launches: where it was, how
// big, whether it filled the screen, and the colour of the theme it last
// showed. It is one small JSON file in the app's own folder of user data, and
// nothing else is kept there.
//
// Reading never throws: a file that is missing, damaged or from another
// version gives the defaults, and a window remembered on a screen that has
// since gone opens on one that is there.
//
// It imports nothing from Electron, so it is tested in plain Node.

import { MIN_WINDOW_SIZE } from "./windowFrame.ts";

/** The file's name, in the app's folder of user data. */
export const WINDOW_STATE_FILE = "window-state.json";

/** A rectangle on the screens, in points, as Electron gives one. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** Where the window was and how big, when it was not filling the screen. */
  bounds: Bounds | null;
  /** Whether it was zoomed to fill the screen. */
  maximized: boolean;
  /** The colour of the ground in the theme it last showed, as `#rrggbb`. */
  background: string | null;
}

export const NO_WINDOW_STATE: WindowState = { bounds: null, maximized: false, background: null };

/** The farthest from the origin a remembered coordinate may be. Screens are far smaller. */
const MAX_COORDINATE = 100_000;

/** At least this much of a window must be on a screen, across and down, for it to open there. */
const MIN_VISIBLE = { width: 120, height: 60 } as const;

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function isCoordinate(value: unknown): value is number {
  return Number.isInteger(value) && Math.abs(value as number) <= MAX_COORDINATE;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounds read back from the file, or null when they are not four whole numbers in range. */
function readBounds(value: unknown): Bounds | null {
  if (!isObject(value)) return null;
  const { x, y, width, height } = value;
  if (!isCoordinate(x) || !isCoordinate(y) || !isCoordinate(width) || !isCoordinate(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) return null;
  return {
    x,
    y,
    width: Math.max(width, MIN_WINDOW_SIZE.width),
    height: Math.max(height, MIN_WINDOW_SIZE.height),
  };
}

/** A colour read back from the file, as `#rrggbb` in lower case, or null. */
export function readColour(value: unknown): string | null {
  return typeof value === "string" && HEX_COLOUR.test(value) ? value.toLowerCase() : null;
}

/** The state in the file's text, or the defaults for anything that cannot be read. */
export function readWindowState(text: string | null | undefined): WindowState {
  if (!text) return NO_WINDOW_STATE;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return NO_WINDOW_STATE;
  }
  if (!isObject(value)) return NO_WINDOW_STATE;
  return {
    bounds: readBounds(value.bounds),
    maximized: value.maximized === true,
    background: readColour(value.background),
  };
}

/** The file's text for a state. */
export function writeWindowState(state: WindowState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function overlap(a: Bounds, b: Bounds): { width: number; height: number } {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/**
 * Where to open the window: the remembered bounds on the screen that holds
 * most of them, made to fit inside that screen's work area, the part the menu
 * bar and the Dock leave free. Null when nothing was remembered, or when too
 * little of the window would be on any screen there is now, so the app opens a
 * window of the default size in the middle of the main screen instead.
 */
export function placeWindow(saved: Bounds | null, workAreas: readonly Bounds[]): Bounds | null {
  if (saved === null) return null;
  let best: Bounds | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const shared = overlap(saved, area);
    if (shared.width < MIN_VISIBLE.width || shared.height < MIN_VISIBLE.height) continue;
    if (shared.width * shared.height > bestArea) {
      best = area;
      bestArea = shared.width * shared.height;
    }
  }
  if (best === null) return null;
  const width = Math.min(saved.width, best.width);
  const height = Math.min(saved.height, best.height);
  return {
    x: clamp(saved.x, best.x, best.x + best.width - width),
    y: clamp(saved.y, best.y, best.y + best.height - height),
    width,
    height,
  };
}
