import { expect, test } from "vitest";

import { mapGooseStatus } from "@core/mapping/goose/gooseMapping";

test("a session Goose may have open is unknown", () => {
  expect(mapGooseStatus(true)).toBe("unknown");
});

test("with no Goose running, a session is finished", () => {
  expect(mapGooseStatus(false)).toBe("finished");
});
