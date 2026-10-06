import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createFeed } from "@site-tour/feed/derive";
import { createTourStore } from "@site-tour/host/tourStore";

const T0 = Date.UTC(2026, 9, 5, 8, 12, 0);
let now = T0;
let held = false;

beforeEach(() => {
  vi.useFakeTimers();
  now = T0;
  held = false;
});

afterEach(() => {
  vi.useRealTimers();
});

const make = () => createTourStore({ feed: createFeed(T0), now: () => now, held: () => held });

test("it is live from the start, at the quiet moment, with nothing waiting", () => {
  const state = make().getState();
  expect(state.phase).toBe("live");
  expect(state.snapshot?.sessions.some((session) => session.status === "needs-you")).toBe(false);
});

test("moving to a moment tells its listeners, and moving to the same one does not", () => {
  const store = make();
  const heard = vi.fn();
  const stop = store.subscribe(heard);
  store.show("waiting");
  store.show("waiting");
  expect(heard).toHaveBeenCalledTimes(1);
  expect(store.getState().snapshot?.sessions.filter((s) => s.status === "needs-you")).toHaveLength(
    1,
  );
  stop();
});

test("a moment shown again is what it was", () => {
  const store = make();
  store.show("waiting");
  const first = store.getState();
  store.show("answered");
  store.show("waiting");
  expect(store.getState()).toEqual(first);
});

test("it moves on with the present every two seconds, and holds still while the clock does", () => {
  const store = make();
  const heard = vi.fn();
  const stop = store.subscribe(heard);
  now += 2_000;
  vi.advanceTimersByTime(2_000);
  expect(heard).toHaveBeenCalledTimes(1);
  expect(store.getState().lastOkAt).toBe(now);
  held = true;
  vi.advanceTimersByTime(6_000);
  expect(heard).toHaveBeenCalledTimes(1);
  stop();
  held = false;
  vi.advanceTimersByTime(6_000);
  expect(heard).toHaveBeenCalledTimes(1);
});

test("moving on from the wait answers it then, and the log says it waited that long", () => {
  const store = make();
  store.show("waiting");
  now = T0 + 25_000;
  store.show("answered");
  expect(store.waitLeftAt()).toBe(T0 + 25_000);
  expect(store.shown()).toEqual({ moment: "answered", answeredAt: T0 + 25_000 });
  expect(store.getState().events[0]).toMatchObject({
    sessionName: "checkout-flow",
    to: "working",
    at: T0 + 25_000,
  });
});

test("a wait never shown is answered as the hour ended", () => {
  const store = make();
  now = T0 + 25_000;
  store.show("answered");
  expect(store.waitLeftAt()).toBeNull();
  expect(store.getState().events[0]).toMatchObject({ sessionName: "checkout-flow", at: T0 });
});

test("starting again forgets the wait seen and the history cleared", () => {
  const store = make();
  store.show("waiting");
  store.show("answered");
  store.clear(T0 + 1_000);
  store.restart();
  expect(store.moment()).toBe("quiet");
  expect(store.waitLeftAt()).toBeNull();
  expect(store.clearedAt()).toBeNull();
});
