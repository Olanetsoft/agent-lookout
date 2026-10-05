import { expect, test } from "vitest";

import { createEventStore, EVENT_CAPACITY } from "@collector/eventStore";
import type { SessionEvent } from "@core/sessions/session";

function event(at: number, label = "a"): SessionEvent {
  return {
    id: `claude-code:${label}@${at}:status-changed`,
    at,
    sessionId: `claude-code:${label}`,
    sessionName: `demo-${label}`,
    kind: "status-changed",
    from: "working",
    to: "idle",
    severity: "advisory",
  };
}

function range(count: number, start = 1): SessionEvent[] {
  return Array.from({ length: count }, (_, index) => event(start + index));
}

test("an empty store lists nothing", () => {
  const store = createEventStore();
  expect(store.list()).toEqual([]);
  expect(store.list({ since: 0 })).toEqual([]);
  expect(store.size).toBe(0);
});

test("events are listed newest first", () => {
  const store = createEventStore();
  store.add([event(1), event(2)]);
  store.add([event(3)]);
  expect(store.list().map((item) => item.at)).toEqual([3, 2, 1]);
});

test("events from the same poll keep a steady order, last reported first", () => {
  const store = createEventStore();
  store.add([event(5, "a"), event(5, "b"), event(5, "c")]);
  expect(store.list().map((item) => item.sessionName)).toEqual(["demo-c", "demo-b", "demo-a"]);
});

test("since keeps only events after that time", () => {
  const store = createEventStore();
  store.add(range(5));
  expect(store.list({ since: 3 }).map((item) => item.at)).toEqual([5, 4]);
  expect(store.list({ since: 5 })).toEqual([]);
  expect(store.list({ since: 0 }).map((item) => item.at)).toEqual([5, 4, 3, 2, 1]);
});

test("a caller that passes the time of its newest event gets no repeats", () => {
  const store = createEventStore();
  store.add([event(10, "a"), event(10, "b")]);
  const first = store.list();
  store.add([event(12, "a")]);
  const next = store.list({ since: first[0]?.at });
  expect(next.map((item) => item.at)).toEqual([12]);
});

test("a response never carries more than 200 events, and they are the newest", () => {
  const store = createEventStore();
  store.add(range(350));
  const listed = store.list();
  expect(listed).toHaveLength(200);
  expect(listed[0]?.at).toBe(350);
  expect(listed[199]?.at).toBe(151);
  expect(store.list({ limit: 5_000 })).toHaveLength(200);
  expect(store.list({ since: 0 })).toHaveLength(200);
});

test("a smaller limit is honoured", () => {
  const store = createEventStore();
  store.add(range(10));
  expect(store.list({ limit: 3 }).map((item) => item.at)).toEqual([10, 9, 8]);
  expect(store.list({ limit: 0 })).toEqual([]);
});

test("the buffer is bounded: the oldest events are dropped", () => {
  const store = createEventStore(5);
  store.add(range(3));
  store.add(range(4, 4));
  expect(store.size).toBe(5);
  expect(store.list().map((item) => item.at)).toEqual([7, 6, 5, 4, 3]);

  store.add(range(20, 100));
  expect(store.size).toBe(5);
  expect(store.list().map((item) => item.at)).toEqual([119, 118, 117, 116, 115]);
});

test("the default buffer holds a thousand events however many arrive", () => {
  const store = createEventStore();
  for (let batch = 0; batch < 30; batch += 1) store.add(range(100, batch * 100 + 1));
  expect(EVENT_CAPACITY).toBe(1_000);
  expect(store.size).toBe(1_000);
  expect(store.list({ limit: 1 })[0]?.at).toBe(3_000);
});

test("the list is a copy: changing it does not change the store", () => {
  const store = createEventStore();
  store.add(range(3));
  store.list().pop();
  expect(store.list()).toHaveLength(3);
});
