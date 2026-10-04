import { expect, test } from "vitest";

import { createHistoryStore, HISTORY_CAPACITY } from "@collector/historyStore";
import type { HistoryPoint } from "@core/session";

const T0 = 1_700_000_000_000;

function point(at: number, total = 1): HistoryPoint {
  return { at, needsYou: 0, working: total, idle: 0, total };
}

test("an empty store lists nothing", () => {
  const store = createHistoryStore();
  expect(store.list(900_000, T0)).toEqual([]);
  expect(store.size).toBe(0);
});

test("points are listed oldest first", () => {
  const store = createHistoryStore();
  store.add(point(T0));
  store.add(point(T0 + 2_000));
  store.add(point(T0 + 4_000));
  expect(store.list(900_000, T0 + 4_000).map((item) => item.at - T0)).toEqual([0, 2_000, 4_000]);
});

test("only points inside the window are listed, and the window ends at now", () => {
  const store = createHistoryStore();
  for (let index = 0; index < 10; index += 1) store.add(point(T0 + index * 2_000));
  const now = T0 + 18_000;

  expect(store.list(4_000, now).map((item) => item.at - T0)).toEqual([14_000, 16_000, 18_000]);
  expect(store.list(1, now).map((item) => item.at - T0)).toEqual([18_000]);
  expect(store.list(60_000, now)).toHaveLength(10);
  // Later on, the same points have aged out of a short window.
  expect(store.list(4_000, now + 60_000)).toEqual([]);
});

test("the buffer is bounded: the oldest points are dropped", () => {
  const store = createHistoryStore(3);
  for (let index = 0; index < 10; index += 1) store.add(point(T0 + index * 2_000, index));
  expect(store.size).toBe(3);
  expect(store.list(Number.MAX_SAFE_INTEGER, T0 + 18_000).map((item) => item.total)).toEqual([
    7, 8, 9,
  ]);
});

test("the default buffer holds six hours of two-second polls and no more", () => {
  expect(HISTORY_CAPACITY).toBe((6 * 60 * 60 * 1000) / 2_000);
  const store = createHistoryStore();
  for (let index = 0; index < HISTORY_CAPACITY + 500; index += 1) {
    store.add(point(T0 + index * 2_000));
  }
  expect(store.size).toBe(HISTORY_CAPACITY);
});

test("the list is a copy: changing it does not change the store", () => {
  const store = createHistoryStore();
  store.add(point(T0));
  store.list(900_000, T0).pop();
  expect(store.list(900_000, T0)).toHaveLength(1);
});
