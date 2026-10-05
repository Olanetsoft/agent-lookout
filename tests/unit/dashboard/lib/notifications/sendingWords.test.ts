import { expect, test } from "vitest";

import { delayInWords } from "@dashboard/lib/notifications/sendingWords";

test("a delay is said in the largest whole unit", () => {
  expect(delayInWords(0)).toBe("0 seconds");
  expect(delayInWords(1_000)).toBe("1 second");
  expect(delayInWords(5_000)).toBe("5 seconds");
  expect(delayInWords(60_000)).toBe("1 minute");
  expect(delayInWords(90_000)).toBe("90 seconds");
  expect(delayInWords(300_000)).toBe("5 minutes");
  expect(delayInWords(3_600_000)).toBe("1 hour");
  expect(delayInWords(5_400_000)).toBe("90 minutes");
});
