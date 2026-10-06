import { expect, test } from "vitest";

import {
  DEFAULT_WINDOW_SIZE,
  macosMajorVersion,
  MIN_WINDOW_SIZE,
  NIGHT_GROUND,
  windowButtonPosition,
  windowButtons,
} from "@desktop/window/windowFrame";

/** The rail in the app: inset 12px, 76px wide, with a 56px top cell level with the header. */
const RAIL = { left: 12, right: 88, top: 12, bottom: 68 };

test.each([26, 27, 15, 13])(
  "on macOS %i the three buttons sit inside the rail's top cell, centred across it and on the header's middle",
  (major) => {
    const { x, y } = windowButtonPosition(major);
    const buttons = windowButtons(major);
    const left = x;
    const right = x + 2 * buttons.step + buttons.width;
    expect(left).toBeGreaterThan(RAIL.left);
    expect(right).toBeLessThan(RAIL.right);
    expect(Math.abs(left - RAIL.left - (RAIL.right - right))).toBeLessThanOrEqual(1);
    expect(y).toBeGreaterThan(RAIL.top);
    expect(y + buttons.height).toBeLessThan(RAIL.bottom);
    expect(Math.abs(y + buttons.height / 2 - (RAIL.top + RAIL.bottom) / 2)).toBeLessThanOrEqual(1);
  },
);

test("on macOS 26 the buttons are where the measurements put them", () => {
  expect(windowButtons(26)).toEqual({ width: 14, height: 14, step: 23 });
  expect(windowButtonPosition(26)).toEqual({ x: 20, y: 33 });
});

test("the version is read from the system's version string", () => {
  expect(macosMajorVersion("26.5.2")).toBe(26);
  expect(macosMajorVersion("15.7")).toBe(15);
  expect(macosMajorVersion("")).toBe(0);
  expect(macosMajorVersion("unknown")).toBe(0);
});

test("the window opens large enough for two columns, and can be made no smaller than the dashboard holds", () => {
  expect(DEFAULT_WINDOW_SIZE.width).toBeGreaterThan(1180);
  expect(MIN_WINDOW_SIZE.width).toBeGreaterThanOrEqual(375);
  expect(MIN_WINDOW_SIZE.width).toBeLessThan(DEFAULT_WINDOW_SIZE.width);
  expect(MIN_WINDOW_SIZE.height).toBeLessThan(DEFAULT_WINDOW_SIZE.height);
});

test("before the page says its theme, the window is the Night ground", () => {
  expect(NIGHT_GROUND).toBe("#090908");
});
