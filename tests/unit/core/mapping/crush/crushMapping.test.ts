import { expect, test } from "vitest";

import { mapCrushStatus } from "@core/mapping/crush/crushMapping";

test("a session Crush may have open is unknown, and one it cannot have open is finished", () => {
  expect(mapCrushStatus(true)).toBe("unknown");
  expect(mapCrushStatus(false)).toBe("finished");
});
