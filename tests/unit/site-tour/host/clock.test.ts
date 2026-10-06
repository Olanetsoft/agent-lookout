import { expect, test } from "vitest";

import { installClock, pictureMoment } from "@site-tour/host/clock";

/** A Date whose now is a moment of our choosing, as the frame's own would be. */
function dateAt(real: number): { Date: DateConstructor; move(by: number): void } {
  let at = real;
  const Fake = class extends Date {} as DateConstructor;
  Fake.now = () => at;
  return {
    Date: Fake,
    move(by) {
      at += by;
    },
  };
}

test("the frame's day starts at the time of day the page's pictures show", () => {
  const loaded = new Date(2026, 9, 6, 22, 47, 13).getTime();
  const target = dateAt(loaded);
  const clock = installClock(target);
  const shown = new Date(clock.now());
  expect([shown.getHours(), shown.getMinutes(), shown.getSeconds()]).toEqual([9, 12, 0]);
  expect(target.Date.now()).toBe(clock.now());
  target.move(5_000);
  expect(clock.now() - pictureMoment(loaded)).toBe(5_000);
});

test("a held clock stays where it was held, or at the moment it was given", () => {
  const target = dateAt(new Date(2026, 9, 6, 8, 0, 0).getTime());
  const clock = installClock(target);
  const start = clock.now();
  clock.hold();
  target.move(3_000);
  expect(clock.now()).toBe(start);
  expect(clock.held).toBe(true);
  clock.hold(start - 60_000);
  expect(clock.now()).toBe(start - 60_000);
  clock.release();
  expect(clock.now()).toBe(start + 3_000);
  expect(clock.held).toBe(false);
});
