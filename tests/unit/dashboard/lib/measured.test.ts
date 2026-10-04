import { expect, test } from "vitest";

import { quietPhrase, uncovered, type Span } from "@dashboard/lib/measured";

const MINUTE = 60_000;

/** A moment on the local clock, on one ordinary winter day. */
const at = (hours: number, minutes: number) => new Date(2026, 0, 5, hours, minutes).getTime();

const HOUR: Span = { from: at(13, 30), to: at(14, 30) };

test("an hour measured from end to end is the last hour", () => {
  expect(quietPhrase(HOUR, [])).toBe("in the last hour");
  expect(quietPhrase(HOUR, [], "in the last fifteen minutes")).toBe("in the last fifteen minutes");
});

test("an hour measured only since a moment inside it is said from that moment", () => {
  // Agent Lookout started at 14:28, two minutes before the present.
  const gaps = uncovered([{ from: at(14, 28), to: at(14, 30) }], HOUR);
  expect(quietPhrase(HOUR, gaps)).toBe("since 14:28");
});

test("an hour with a break in it, or with its end not measured, is said of the time measured", () => {
  const broken = uncovered(
    [
      { from: at(13, 30), to: at(13, 50) },
      { from: at(14, 0), to: at(14, 30) },
    ],
    HOUR,
  );
  expect(quietPhrase(HOUR, broken)).toBe("in the time measured");

  const stopped = uncovered([{ from: at(13, 30), to: at(14, 10) }], HOUR);
  expect(quietPhrase(HOUR, stopped)).toBe("in the time measured");

  const late = uncovered([{ from: at(13, 45), to: at(14, 20) }], HOUR);
  expect(quietPhrase(HOUR, late)).toBe("in the time measured");
});

test("an hour nobody measured has nothing to be said of", () => {
  expect(quietPhrase(HOUR, [HOUR])).toBeNull();
  expect(quietPhrase(HOUR, uncovered([], HOUR))).toBeNull();
  // A minute short of the whole is still something measured.
  expect(quietPhrase(HOUR, [{ from: HOUR.from, to: HOUR.to - MINUTE }])).toBe("since 14:29");
});
