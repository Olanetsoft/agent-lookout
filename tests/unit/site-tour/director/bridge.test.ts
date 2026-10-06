import { expect, test } from "vitest";

import { readPageMessage } from "@site-tour/director/bridge";

test.each([
  [{ type: "scene", index: 3, step: 0, lamp: null }],
  [{ type: "scene", index: 0, step: 1, lamp: "waiting" }],
  [{ type: "theme", theme: "light" }],
  [{ type: "lamp", lamp: "quiet" }],
  [{ type: "mode", mode: "yours" }],
  [{ type: "tap", x: 120.5, y: 40 }],
])("the page's %j is taken as it was said", (message) => {
  expect(readPageMessage(message)).toEqual(message);
});

test.each([
  [null],
  ["scene"],
  [{ type: "scene", index: -1, step: 0, lamp: null }],
  [{ type: "scene", index: 1.5, step: 0, lamp: null }],
  [{ type: "scene", index: 1, step: 0, lamp: "lit" }],
  [{ type: "theme", theme: "system" }],
  [{ type: "mode", mode: "auto" }],
  [{ type: "tap", x: Number.NaN, y: 0 }],
  [{ type: "navigate", to: "https://example.com" }],
])("%j is not a message, and is ignored", (message) => {
  expect(readPageMessage(message)).toBeNull();
});

test("nothing but what the page may say is carried over", () => {
  expect(readPageMessage({ type: "theme", theme: "dark", extra: "<script>" })).toEqual({
    type: "theme",
    theme: "dark",
  });
});
