import { expect, test } from "vitest";

import { mapPiStatus } from "@core/mapping/pi/piMapping";

test("a session Pi may have open is unknown, since nothing says what it is doing", () => {
  expect(mapPiStatus(true)).toBe("unknown");
});

test("a session no pi program can hold is finished", () => {
  expect(mapPiStatus(false)).toBe("finished");
});
