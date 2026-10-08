import { describe, expect, test } from "vitest";

import { MIN_WINDOW_SIZE } from "@desktop/window/windowFrame";
import {
  NO_WINDOW_STATE,
  placeWindow,
  readColour,
  readWindowState,
  WINDOW_STATE_FILE,
  writeWindowState,
  type Bounds,
  type WindowState,
} from "@desktop/window/windowState";

const SAVED: WindowState = {
  bounds: { x: 120, y: 80, width: 1200, height: 800 },
  maximized: false,
  background: "#060605",
};

describe("reading the file", () => {
  test("it is one small JSON file", () => {
    expect(WINDOW_STATE_FILE).toBe("window-state.json");
  });

  test("what was written is read back as it was", () => {
    expect(readWindowState(writeWindowState(SAVED))).toEqual(SAVED);
    const zoomed = { ...SAVED, maximized: true, background: "#d4d0ca" };
    expect(readWindowState(writeWindowState(zoomed))).toEqual(zoomed);
  });

  test.each([null, undefined, "", "not json", "[]", "42", "null", '"text"'])(
    "%j gives the defaults",
    (text) => {
      expect(readWindowState(text)).toEqual(NO_WINDOW_STATE);
    },
  );

  test("a field that cannot be read is left at its default, and the rest is kept", () => {
    const read = (fields: Record<string, unknown>) =>
      readWindowState(JSON.stringify({ ...SAVED, ...fields }));

    for (const bounds of [
      null,
      "big",
      [],
      { x: 1, y: 2, width: 800 },
      { x: 1.5, y: 2, width: 800, height: 600 },
      { x: "1", y: 2, width: 800, height: 600 },
      { x: 1, y: 2, width: 0, height: 600 },
      { x: 1, y: 2, width: -800, height: 600 },
      { x: 1e9, y: 2, width: 800, height: 600 },
      { x: Number.NaN, y: 2, width: 800, height: 600 },
    ]) {
      expect(read({ bounds }), JSON.stringify(bounds)).toEqual({ ...SAVED, bounds: null });
    }
    for (const maximized of ["true", 1, null]) {
      expect(read({ maximized }).maximized).toBe(false);
    }
    for (const background of ["#fff", "black", "rgb(0,0,0)", "#0606059", 9, null, "url(x)"]) {
      expect(read({ background }).background, String(background)).toBeNull();
    }
  });

  test("a colour is kept in lower case", () => {
    expect(readColour("#D4D0CA")).toBe("#d4d0ca");
  });

  test("a window remembered smaller than the smallest allowed opens at the smallest", () => {
    const read = readWindowState(
      JSON.stringify({ ...SAVED, bounds: { x: 0, y: 0, width: 100, height: 100 } }),
    );
    expect(read.bounds).toEqual({ x: 0, y: 0, ...MIN_WINDOW_SIZE });
  });
});

describe("placing the window", () => {
  const laptop: Bounds = { x: 0, y: 25, width: 1512, height: 920 };
  const external: Bounds = { x: 1512, y: -200, width: 2560, height: 1415 };

  test("nothing remembered opens a default window in the middle of the main screen", () => {
    expect(placeWindow(null, [laptop])).toBeNull();
  });

  test("a window that is on a screen opens where it was", () => {
    expect(placeWindow(SAVED.bounds, [laptop])).toEqual(SAVED.bounds);
    const there = { x: 2000, y: 0, width: 1400, height: 900 };
    expect(placeWindow(there, [laptop, external])).toEqual(there);
  });

  test("a window on a screen that has gone opens on the main screen's default instead", () => {
    expect(placeWindow({ x: 2000, y: 0, width: 1400, height: 900 }, [laptop])).toBeNull();
  });

  test("a window barely on a screen does not open there", () => {
    expect(placeWindow({ x: 1450, y: 100, width: 1000, height: 700 }, [laptop])).toBeNull();
  });

  test("a window partly off its screen is brought inside it, and one too big is made to fit", () => {
    expect(placeWindow({ x: 900, y: 600, width: 1000, height: 700 }, [laptop])).toEqual({
      x: 512,
      y: 245,
      width: 1000,
      height: 700,
    });
    expect(placeWindow({ x: -50, y: 0, width: 3000, height: 2000 }, [laptop])).toEqual(laptop);
  });

  test("a window across two screens opens on the one that held most of it", () => {
    const across = { x: 1100, y: 100, width: 1000, height: 700 };
    expect(placeWindow(across, [laptop, external])).toEqual({ ...across, x: 1512 });
  });
});
