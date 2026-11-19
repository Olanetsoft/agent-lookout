import { expect, test } from "vitest";

import { mapDroidStatus } from "@core/mapping/droid/droidMapping";

test("a session is unknown while Droid may have it open, and finished once it cannot", () => {
  expect(mapDroidStatus(true)).toBe("unknown");
  expect(mapDroidStatus(false)).toBe("finished");
});
