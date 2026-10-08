import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  LAST_MESSAGE_PATH,
  NOTIFICATIONS_HEADER,
  type HistoryKept,
  type HistorySince,
} from "@core/api";
import type { HistoryPoint, SessionEvent, SessionsSnapshot } from "@core/sessions/session";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import type { Beat } from "@dashboard/lib/api/beat";
import {
  createCollectorStore,
  fetchHistory,
  fetchLastMessage,
  HISTORY_KEPT_MS,
  HISTORY_WINDOW_MS,
  MAX_EVENTS,
  mergeEvents,
  POLL_INTERVAL_MS,
  STALE_AFTER_MS,
} from "@dashboard/lib/api/collectorStore";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function event(n: number, at: number): SessionEvent {
  return {
    id: `event-${n}`,
    at,
    sessionId: "claude-code:00000000-0000-4000-8000-000000000001",
    sessionName: "demo-project",
    kind: "status-changed",
    from: "working",
    to: "idle",
    severity: "advisory",
  };
}

function point(at: number): HistoryPoint {
  return { at, needsYou: 0, working: 0, idle: 1, total: 1 };
}

/** The history requests among everything asked for, in order. */
function historyRequests(collector: { requests: string[] }): string[] {
  return collector.requests.filter((path) => path.startsWith("/api/history"));
}

function snapshot(): SessionsSnapshot {
  return {
    generatedAt: Date.now(),
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: Date.now() }],
    sessions: [makeSession()],
  };
}

interface FakeCollector {
  up: boolean;
  events: SessionEvent[];
  startedAt: number;
  /** Where its history begins and where it is kept, when it says. */
  since?: HistorySince;
  kept?: HistoryKept;
  /**
   * Every point the collector holds. An answer carries the ones inside the
   * window asked for. Null answers with one point at the present, whatever is asked.
   */
  points: HistoryPoint[] | null;
  /** Makes the history route alone fail, while the others answer. */
  historyUp: boolean;
  /** Replaces the sessions answer, to imitate a server that misbehaves. */
  sessionsAnswer: (() => Response) | null;
  requests: string[];
  host: ApiHost;
  sessionRequests: () => number;
}

/** A stand-in for the collector's API, answering through the `apiRequest` seam. */
function fakeCollector(): FakeCollector {
  const collector: FakeCollector = {
    up: true,
    events: [],
    startedAt: T0 - 60_000,
    points: null,
    historyUp: true,
    sessionsAnswer: null,
    requests: [],
    host: async (path) => {
      collector.requests.push(path);
      if (!collector.up) throw new TypeError("Failed to fetch");
      const url = new URL(path, "http://localhost");
      switch (url.pathname) {
        case "/api/sessions":
          return collector.sessionsAnswer ? collector.sessionsAnswer() : json(snapshot());
        case "/api/events": {
          const since = Number(url.searchParams.get("since") ?? 0);
          const newestFirst = [...collector.events].sort((a, b) => b.at - a.at);
          return json({ events: newestFirst.filter((e) => e.at > since) });
        }
        case "/api/history": {
          if (!collector.historyUp) return json({ error: "Not now." }, 500);
          const from = Date.now() - Number(url.searchParams.get("windowMs"));
          return json({
            points: collector.points?.filter((p) => p.at >= from) ?? [point(Date.now())],
            startedAt: collector.startedAt,
            ...(collector.since && { since: collector.since }),
            ...(collector.kept && { kept: collector.kept }),
          });
        }
        default:
          return json({ error: "There is nothing at that address." }, 404);
      }
    },
    sessionRequests: () => collector.requests.filter((path) => path === "/api/sessions").length,
  };
  return collector;
}

/**
 * One turn of the event loop. A message to itself comes back at the next
 * turn, where a zero-delay timer waits for the system's clock to tick: on
 * Windows only every 15 milliseconds or so, which a test of 150 beats would
 * spend its whole time on.
 */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/** Lets promises and whatever waits for the next turn run. Only the interval and the clock are faked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await nextTurn();
}

async function beat(ms: number = POLL_INTERVAL_MS): Promise<void> {
  vi.advanceTimersByTime(ms);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"], now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  setApiHost();
});

test("the first answer makes the store live, with sessions, events and history", async () => {
  const collector = fakeCollector();
  collector.events = [event(1, T0 - 5_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  expect(store.getState()).toMatchObject({ phase: "connecting", snapshot: null });

  const stop = store.subscribe(() => {});
  await settle();

  const state = store.getState();
  expect(state.phase).toBe("live");
  expect(state.snapshot?.sessions).toHaveLength(1);
  expect(state.events.map((e) => e.id)).toEqual(["event-1"]);
  expect(state.history?.startedAt).toBe(T0 - 60_000);
  expect(state.lastOkAt).toBe(T0);
  expect(state.problem).toBeNull();
  expect(state.problemKind).toBeNull();
  stop();
});

test("each of the three requests says whether this page's notifications are on", async () => {
  const said: [string, string | null][] = [];
  const collector = fakeCollector();
  setApiHost((path, init) => {
    said.push([
      new URL(path, "http://localhost").pathname,
      new Headers(init?.headers).get(NOTIFICATIONS_HEADER),
    ]);
    return collector.host(path, init);
  });
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();

  // Outside a browser the page's notifications are never on.
  expect(said).toEqual([
    ["/api/sessions", "off"],
    ["/api/events", "off"],
    ["/api/history", "off"],
  ]);

  said.length = 0;
  await fetchHistory(6 * 60 * 60 * 1000);
  expect(said).toEqual([["/api/history", "off"]]);
  stop();
});

test("it asks for the three routes on every beat", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  expect(collector.requests).toEqual([
    "/api/sessions",
    "/api/events?since=0",
    "/api/history?windowMs=3600000",
  ]);

  await beat();
  await beat();

  expect(collector.sessionRequests()).toBe(3);
  expect(collector.requests).toHaveLength(9);
  stop();
});

test("the first poll asks for the last hour of history, and later polls for 15 minutes", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();
  await beat();

  expect(HISTORY_KEPT_MS).toBe(60 * 60 * 1_000);
  expect(HISTORY_WINDOW_MS).toBe(15 * 60 * 1_000);
  expect(historyRequests(collector)).toEqual([
    "/api/history?windowMs=3600000",
    "/api/history?windowMs=900000",
    "/api/history?windowMs=900000",
  ]);
  stop();
});

test("the hour is asked for again until it is answered", async () => {
  const collector = fakeCollector();
  collector.historyUp = false;
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();

  // The sessions were answered, so the page is live. It has no history yet.
  expect(store.getState().phase).toBe("live");
  expect(store.getState().history).toBeNull();

  collector.historyUp = true;
  await beat();
  await beat();

  expect(historyRequests(collector)).toEqual([
    "/api/history?windowMs=3600000",
    "/api/history?windowMs=3600000",
    "/api/history?windowMs=3600000",
    "/api/history?windowMs=900000",
  ]);
  expect(store.getState().history).not.toBeNull();
  stop();
});

test("the hour held is kept current from the 15 minutes polled, and trimmed as it ages", async () => {
  const collector = fakeCollector();
  collector.startedAt = T0 - 2 * 60 * 60_000;
  // A point every minute for the last 70 minutes.
  collector.points = [];
  for (let minutes = 70; minutes >= 0; minutes -= 1) {
    collector.points.push(point(T0 - minutes * 60_000));
  }
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();

  // The whole hour, from the first answer.
  const first = store.getState().history?.points ?? [];
  expect(first[0]?.at).toBe(T0 - 60 * 60_000);
  expect(first).toHaveLength(61);

  // A new point arrives with the next poll, in an answer that only goes back 15 minutes.
  collector.points.push(point(T0 + POLL_INTERVAL_MS));
  await beat();

  const second = store.getState().history?.points ?? [];
  expect(second[0]?.at).toBe(T0 - 60 * 60_000);
  expect(second[second.length - 1]?.at).toBe(T0 + POLL_INTERVAL_MS);
  expect(second).toHaveLength(62);
  // No point is held twice, and they are still in time order.
  expect(new Set(second.map((p) => p.at)).size).toBe(second.length);
  expect([...second].sort((a, b) => a.at - b.at)).toEqual(second);

  // Five minutes on, what is older than the hour has been let go.
  for (let i = 0; i < 150; i += 1) await beat();
  const later = store.getState().history?.points ?? [];
  const now = T0 + 151 * POLL_INTERVAL_MS;
  expect(later[0]?.at).toBeGreaterThanOrEqual(now - HISTORY_KEPT_MS - 60_000);
  expect(later[0]?.at).toBeLessThan(now - HISTORY_KEPT_MS + 60_000);
  stop();
});

test("after the collector restarts, the hour is asked for again", async () => {
  const collector = fakeCollector();
  collector.startedAt = T0 - 2 * 60 * 60_000;
  collector.points = [point(T0 - 30 * 60_000), point(T0 - 60_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();
  expect(store.getState().history?.points).toHaveLength(2);

  // A new process: a new start time, and none of the old one's points.
  collector.startedAt = T0 + 3_000;
  collector.points = [point(T0 + 3_500)];
  await beat();

  expect(store.getState().history).toEqual({
    startedAt: T0 + 3_000,
    points: [point(T0 + 3_500)],
  });

  await beat();
  await beat();

  expect(historyRequests(collector)).toEqual([
    "/api/history?windowMs=3600000",
    "/api/history?windowMs=900000",
    "/api/history?windowMs=900000",
    "/api/history?windowMs=3600000",
    "/api/history?windowMs=900000",
  ]);
  expect(store.getState().history?.startedAt).toBe(T0 + 3_000);
  stop();
});

test("after a silence longer than the 15 minutes polled, the hour is asked for again", async () => {
  const collector = fakeCollector();
  collector.startedAt = T0 - 2 * 60 * 60_000;
  collector.points = [point(T0 - 60_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();

  // Twenty minutes with no answers. The collector went on polling all the while.
  collector.up = false;
  for (let i = 0; i < 600; i += 1) await beat();
  collector.points.push(point(T0 + 5 * 60_000), point(T0 + 19 * 60_000));
  collector.up = true;
  await beat();

  expect(historyRequests(collector).at(-1)).toBe("/api/history?windowMs=3600000");
  // The point from the middle of the silence is there: 15 minutes would have missed it.
  expect(store.getState().history?.points.map((p) => p.at)).toEqual([
    T0 - 60_000,
    T0 + 5 * 60_000,
    T0 + 19 * 60_000,
  ]);
  stop();
});

test("a slow poll is never joined by a second one", async () => {
  const collector = fakeCollector();
  const waiting: Array<() => void> = [];
  setApiHost(async (path, init) => {
    await new Promise<void>((resolve) => waiting.push(resolve));
    return collector.host(path, init);
  });
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});

  // Three beats pass while the first poll's requests are still open.
  await beat();
  await beat();
  await beat();
  expect(waiting).toHaveLength(3);
  expect(store.getState().phase).toBe("connecting");

  for (const release of waiting.splice(0)) release();
  await settle();
  expect(store.getState().phase).toBe("live");

  // With the slow poll finished, the next beat polls again.
  await beat();
  expect(waiting).toHaveLength(3);
  for (const release of waiting.splice(0)) release();
  await settle();
  stop();
});

test("a collector that never answers is unreachable after two tries, not after one", async () => {
  const collector = fakeCollector();
  collector.up = false;
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();

  // One failure could be a slow start. The page still says it is connecting.
  expect(store.getState()).toMatchObject({ phase: "connecting", snapshot: null });

  await beat();
  expect(store.getState()).toMatchObject({
    phase: "unreachable",
    snapshot: null,
    problem: "The local server did not answer.",
    problemKind: "no-answer",
  });
  stop();
});

test("a page of HTML with a 200 status is a failure, not an empty list of sessions", async () => {
  // A dev server with no collector mounted answers every path with index.html.
  const collector = fakeCollector();
  collector.sessionsAnswer = () =>
    new Response("<!doctype html><html></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();

  expect(store.getState().phase).toBe("unreachable");
  expect(store.getState().snapshot).toBeNull();
  expect(store.getState().problem).toBe(
    "The local server answered /api/sessions with something that is not data.",
  );
  // Something answered, so the page must not go on to say that nothing did.
  expect(store.getState().problemKind).toBe("not-data");
  stop();
});

test("an error status is reported with its number", async () => {
  const collector = fakeCollector();
  collector.sessionsAnswer = () => json({ error: "refused" }, 403);
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();

  expect(store.getState().problem).toBe("The local server answered /api/sessions with error 403.");
  expect(store.getState().problemKind).toBe("error-status");
  stop();
});

test("JSON in the wrong shape is a failure", async () => {
  const collector = fakeCollector();
  collector.sessionsAnswer = () => json({ sessions: "none" });
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();

  expect(store.getState().phase).toBe("unreachable");
  expect(store.getState().problem).toMatch(/shape this page cannot read/);
  expect(store.getState().problemKind).toBe("not-data");
  stop();
});

test("one wrongly shaped session does not take the others, or the page, down with it", async () => {
  const collector = fakeCollector();
  collector.sessionsAnswer = () =>
    json({
      generatedAt: T0,
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: T0 }],
      sessions: [
        makeSession({ id: "claude-code:good", name: "good" }),
        // A name that is an object would throw when drawn; so would missing links.
        { ...makeSession({ id: "claude-code:odd-name" }), name: { a: 1 } },
        { ...makeSession({ id: "claude-code:no-links", name: "no-links" }), links: undefined },
        "not a session at all",
      ],
    });
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();

  const state = store.getState();
  expect(state.phase).toBe("live");
  expect(state.problem).toBeNull();
  expect(state.snapshot?.sessions.map((session) => session.name)).toEqual([
    "good",
    "demo",
    "no-links",
  ]);
  for (const session of state.snapshot?.sessions ?? []) {
    expect(typeof session.name).toBe("string");
    expect(session.links).toBeTypeOf("object");
  }
  stop();
});

test("a longer window of history is asked for by its length, and read like any other answer", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);

  const history = await fetchHistory(6 * 60 * 60 * 1_000);

  expect(collector.requests).toEqual(["/api/history?windowMs=21600000"]);
  expect(history.startedAt).toBe(T0 - 60_000);
  expect(history.points).toHaveLength(1);

  collector.up = false;
  await expect(fetchHistory(3_600_000)).rejects.toThrow("The local server did not answer.");
});

describe("what one session last said", () => {
  const ID = "claude-code:00000000-0000-4000-8000-000000000001";

  /** Answers the one route with what is given, and keeps what was asked. */
  function answering(respond: () => Response | Promise<Response>) {
    const asked: { path: string; init?: RequestInit }[] = [];
    setApiHost(async (path, init) => {
      asked.push({ path, init });
      return respond();
    });
    return asked;
  }

  test("is asked for by the session's id, written for an address, and read as it was sent", async () => {
    const sent = { message: { text: "Done.\n\nTwo files changed.", cut: false } };
    const asked = answering(() => json(sent));

    expect(await fetchLastMessage(ID)).toEqual(sent);
    expect(asked.map(({ path }) => path)).toEqual([
      `${LAST_MESSAGE_PATH}?id=claude-code%3A00000000-0000-4000-8000-000000000001`,
    ]);
    // Asked as every route is: for JSON, said of this page's notifications, and bounded in time.
    const headers = new Headers(asked[0]?.init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get(NOTIFICATIONS_HEADER)).toBe("off");
    expect(asked[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(asked[0]?.init?.method).toBeUndefined();
  });

  test("why there is none is read too, with the setting that turned it off", async () => {
    answering(() => json({ message: null, reason: "off", setting: "AGENT_LOOKOUT_WAITING_TEXT" }));
    expect(await fetchLastMessage(ID)).toEqual({
      message: null,
      reason: "off",
      setting: "AGENT_LOOKOUT_WAITING_TEXT",
    });
  });

  test("a server that has read as many transcripts as it will this second is busy, not a failure", async () => {
    answering(() => json({ error: "Too many." }, 429));
    expect(await fetchLastMessage(ID)).toBe("busy");
  });

  test.each([
    ["with error 404", () => json({ error: "No session with that id is listed." }, 404)],
    ["with error 500", () => json({ error: "Something went wrong." }, 500)],
    ["with something that is not data", () => new Response("<!doctype html>", { status: 200 })],
    ["a last message in a shape this page cannot read", () => json({ message: "Done." })],
    [
      "The local server did not answer.",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
  ])("any other answer is a failure that says what went wrong: %s", async (words, respond) => {
    answering(respond);
    await expect(fetchLastMessage(ID)).rejects.toThrow(words);
  });
});

test("when the collector stops answering, the last data stays and is called stale", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  expect(store.getState().phase).toBe("live");

  collector.up = false;

  // A blip shorter than the stale threshold changes nothing on screen.
  await beat();
  expect(Date.now() - T0).toBeLessThanOrEqual(STALE_AFTER_MS);
  expect(store.getState().phase).toBe("live");
  expect(store.getState().problem).toBe("The local server did not answer.");

  // Past the threshold it is stale, and the snapshot is still there.
  await beat();
  await beat();
  expect(Date.now() - T0).toBeGreaterThan(STALE_AFTER_MS);
  expect(store.getState().phase).toBe("stalled");
  expect(store.getState().snapshot?.sessions).toHaveLength(1);
  expect(store.getState().lastOkAt).toBe(T0);

  // It recovers on its own when the collector comes back.
  collector.up = true;
  await beat();
  expect(store.getState()).toMatchObject({ phase: "live", problem: null, problemKind: null });
  expect(store.getState().lastOkAt).toBe(Date.now());
  stop();
});

test("events are asked for since the newest one held, and merged newest first", async () => {
  const collector = fakeCollector();
  collector.events = [event(1, T0 - 9_000), event(2, T0 - 4_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  expect(store.getState().events.map((e) => e.id)).toEqual(["event-2", "event-1"]);

  collector.events.push(event(3, T0 + 1_000));
  await beat();

  expect(collector.requests).toContain(`/api/events?since=${T0 - 4_000}`);
  expect(store.getState().events.map((e) => e.id)).toEqual(["event-3", "event-2", "event-1"]);
  stop();
});

test("the event list keeps its identity when nothing new arrives", async () => {
  // Rows are keyed by id; an unchanged list must not be rebuilt on every beat.
  const collector = fakeCollector();
  collector.events = [event(1, T0 - 9_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  const before = store.getState().events;

  await beat();

  expect(store.getState().events).toBe(before);
  stop();
});

test("a restarted collector replaces the event list instead of adding to it", async () => {
  const collector = fakeCollector();
  collector.events = [event(1, T0 - 9_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();

  // The new process starts its ids again from 1.
  collector.startedAt = T0 + 500;
  collector.events = [event(1, T0 + 1_000)];
  await beat();

  expect(store.getState().history?.startedAt).toBe(T0 + 500);
  expect(store.getState().events).toEqual([event(1, T0 + 1_000)]);
  stop();
});

test("once the history has been cleared, what the page held from before goes, events and history alike", async () => {
  const collector = fakeCollector();
  collector.events = [event(1, T0 - 9_000)];
  collector.points = [point(T0 - 9_000), point(T0 - 7_000)];
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  expect(store.getState().events).toHaveLength(1);

  // Cleared at T0 + 500, by the same collector: its start time stands.
  collector.since = { at: T0 + 500, by: "cleared" };
  collector.events = [event(2, T0 + 1_000)];
  collector.points = [point(T0 + 1_000)];
  await beat();

  const state = store.getState();
  expect(state.history?.startedAt).toBe(T0 - 60_000);
  expect(state.history?.since).toEqual({ at: T0 + 500, by: "cleared" });
  expect(state.history?.points.map((held) => held.at)).toEqual([T0 + 1_000]);
  expect(state.events).toEqual([event(2, T0 + 1_000)]);

  // The next beat joins on to it as usual.
  collector.points = [point(T0 + 1_000), point(T0 + 3_000)];
  await beat();
  expect(store.getState().history?.points.map((held) => held.at)).toEqual([T0 + 1_000, T0 + 3_000]);
  stop();
});

test("where the history is kept, and where it begins, go with the history the page holds", async () => {
  const collector = fakeCollector();
  collector.since = { at: T0 - 86_400_000, by: "started" };
  collector.kept = {
    where: "disk",
    folder: "~/.agent-lookout/history",
    bytes: 4_096,
    maxBytes: 20 * 1024 * 1024,
    maxAgeMs: 8 * 86_400_000,
    canClear: true,
    problem: null,
  };
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  await beat();
  expect(store.getState().history).toMatchObject({ since: collector.since, kept: collector.kept });
  stop();
});

test("polling stops when nothing is listening and starts again when something is", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const store = createCollectorStore();
  const stop = store.subscribe(() => {});
  await settle();
  stop();

  await beat();
  await beat();
  expect(collector.sessionRequests()).toBe(1);

  const stopAgain = store.subscribe(() => {});
  await settle();
  expect(collector.sessionRequests()).toBe(2);
  stopAgain();
});

test("refresh polls at once and tells listeners", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const store = createCollectorStore();
  const listener = vi.fn();
  const stop = store.subscribe(listener);
  await settle();
  listener.mockClear();

  store.refresh();
  await settle();

  expect(collector.sessionRequests()).toBe(2);
  expect(listener).toHaveBeenCalledTimes(1);
  stop();
});

/** A beat the test drives by hand, which writes down how it was started and stopped. */
function handBeat() {
  const hand = {
    started: [] as number[],
    stops: 0,
    tick: null as (() => void) | null,
    beat: ((tick, intervalMs) => {
      hand.started.push(intervalMs);
      hand.tick = tick;
      return () => {
        hand.stops += 1;
        hand.tick = null;
      };
    }) satisfies Beat,
  };
  return hand;
}

test("with a beat of its own, the store polls when that beat ticks and not on the timer", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const hand = handBeat();
  const store = createCollectorStore({ beat: hand.beat });

  // Nothing is listening, so the beat has not been started.
  expect(hand.started).toEqual([]);
  const stop = store.subscribe(() => {});
  await settle();
  // The first poll is made at once, and the beat is started with the poll interval.
  expect(hand.started).toEqual([POLL_INTERVAL_MS]);
  expect(collector.sessionRequests()).toBe(1);

  // The page's own timer passing asks for nothing.
  await beat();
  await beat();
  expect(collector.sessionRequests()).toBe(1);

  hand.tick?.();
  await settle();
  hand.tick?.();
  await settle();
  expect(collector.sessionRequests()).toBe(3);
  expect(store.getState().phase).toBe("live");
  stop();
});

test("the beat is stopped when the last listener leaves, and started afresh for the next", async () => {
  const collector = fakeCollector();
  setApiHost(collector.host);
  const hand = handBeat();
  const store = createCollectorStore({ beat: hand.beat, intervalMs: 500 });

  const stopFirst = store.subscribe(() => {});
  const stopSecond = store.subscribe(() => {});
  await settle();
  // One beat, however many are listening.
  expect(hand.started).toEqual([500]);

  stopFirst();
  expect(hand.stops).toBe(0);
  stopSecond();
  expect(hand.stops).toBe(1);

  const stopAgain = store.subscribe(() => {});
  await settle();
  expect(hand.started).toEqual([500, 500]);
  expect(collector.sessionRequests()).toBe(2);
  stopAgain();
  expect(hand.stops).toBe(2);
});

test("a beat that ticks while a poll is still out does not start a second one", async () => {
  const collector = fakeCollector();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const answer = collector.host;
  collector.host = async (path, init) => {
    await held;
    return answer(path, init);
  };
  setApiHost(collector.host);
  const hand = handBeat();
  const store = createCollectorStore({ beat: hand.beat });
  const stop = store.subscribe(() => {});
  await settle();

  hand.tick?.();
  hand.tick?.();
  await settle();
  release();
  await settle();

  expect(collector.sessionRequests()).toBe(1);
  stop();
});

test("merging keeps the newest events and drops the oldest past the limit", () => {
  const known = Array.from({ length: MAX_EVENTS }, (_, i) => event(i, T0 - i * 1_000));
  const merged = mergeEvents(known, [event(9_999, T0 + 1_000), event(0, T0)]);

  expect(merged).toHaveLength(MAX_EVENTS);
  expect(merged[0]?.id).toBe("event-9999");
  // The repeat of event 0 was not added twice, and the oldest one fell off the end.
  expect(merged.filter((e) => e.id === "event-0")).toHaveLength(1);
  expect(merged.some((e) => e.id === `event-${MAX_EVENTS - 1}`)).toBe(false);
});
