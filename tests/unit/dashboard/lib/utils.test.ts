import { expect, test } from "vitest";

import { cn } from "@dashboard/lib/utils";

test("a named text size survives being merged with a text colour", () => {
  // Without the tailwind-merge setup in utils.ts, `text-row` would be dropped here.
  expect(cn("text-row", "text-ink")).toBe("text-row text-ink");
  expect(cn("text-ink", "text-label-muted")).toBe("text-label-muted");
  expect(cn("text-row", "text-caption")).toBe("text-caption");
});
