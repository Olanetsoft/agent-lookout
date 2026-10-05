import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Adapter, AdapterResult } from "@collector/adapters/adapter";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller, POLL_DEADLINE_MS, POLL_INTERVAL_MS } from "@collector/poller";
import type { Session, SourceHealth, SourceId, SourceState } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const T0 = 1_700_000_000_000;

function health(state: SourceState = "ok", detail?: string): SourceHealth {
  return { id: "claude-code", label: "Claude Code", state, detail, checkedAt: Date.now() };
}

function result(sessions: Session[], state: SourceState = "ok"): AdapterResult {
  return { health: health(state), sessions };
}

/** An adapter that answers with whatever the test queued, one answer per poll. */
function scriptedAdapter(...answers: AdapterResult[]) {
  let calls = 0;
  const adapter: Adapter = {
    id: "claude-code",
    label: "Claude Code",
    lookingIn: "Looking for sessions in a test.",
    poll: async () => {
      const answer = answers[Math.min(calls, answers.length - 1)] as AdapterResult;
      calls += 1;
      return answer;
    },
  };
  return {
    adapter,
    get calls() {
      return calls;
    },
  };
}

function setUp(adapter: Adapter, intervalMs?: number) {
  const events = createEventStore();
  const history = createHistoryStore();
  const poller = createPoller({ adapters: [adapter], events, history, intervalMs });
  return { poller, events, history };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the snapshot", () => {
  test("before the first poll finishes, each source is searching and says where", () => {
    const { adapter } = scriptedAdapter(result([]));
    const { poller } = setUp(adapter);
    expect(poller.getSnapshot()).toEqual({
      generatedAt: T0,
      sources: [
        {
          id: "claude-code",
          label: "Claude Code",
          state: "searching",
          detail: "Looking for sessions in a test.",
          checkedAt: T0,
        },
      ],
      sessions: [],
    });
  });

  test("after a poll it holds the source's health and its sessions, sorted", async () => {
    const idle = makeSession({ id: "claude-code:idle", status: "idle" });
    const waiting = makeSession({ id: "claude-code:waiting", status: "needs-you" });
    const working = makeSession({ id: "claude-code:working", status: "working" });
    const { adapter } = scriptedAdapter(result([idle, working, waiting]));
    const { poller } = setUp(adapter);

    const snapshot = await poller.pollOnce();

    expect(snapshot.generatedAt).toBe(T0);
    expect(snapshot.sources).toEqual([health("ok")]);
    expect(snapshot.sessions.map((session) => session.id)).toEqual([
      "claude-code:waiting",
      "claude-code:working",
      "claude-code:idle",
    ]);
    expect(poller.getSnapshot()).toBe(snapshot);
  });
});

describe("a listener to the snapshots", () => {
  test("hears each snapshot once it is the latest, in order", async () => {
    const a = makeSession({ id: "claude-code:a", status: "working" });
    const { adapter } = scriptedAdapter(result([a]), result([{ ...a, status: "needs-you" }]));
    const heard: [string | undefined, boolean][] = [];
    const poller = createPoller({
      adapters: [adapter],
      events: createEventStore(),
      history: createHistoryStore(),
      onSnapshot: (snapshot) => {
        heard.push([snapshot.sessions[0]?.status, poller.getSnapshot() === snapshot]);
      },
    });

    await poller.pollOnce();
    await poller.pollOnce();

    expect(heard).toEqual([
      ["working", true],
      ["needs-you", true],
    ]);
  });

  test("one that throws does not fail the poll or stop the next", async () => {
    const { adapter } = scriptedAdapter(result([makeSession()]));
    let heard = 0;
    const events = createEventStore();
    const history = createHistoryStore();
    const poller = createPoller({
      adapters: [adapter],
      events,
      history,
      onSnapshot: () => {
        heard += 1;
        throw new Error("The listener failed.");
      },
    });

    const first = await poller.pollOnce();
    await poller.pollOnce();

    expect(first.sessions).toHaveLength(1);
    expect(poller.getSnapshot().sources[0]?.state).toBe("ok");
    expect(heard).toBe(2);
    expect(history.list(60_000, Date.now())).toHaveLength(2);
  });
});

describe("the schedule", () => {
  test("the interval is two seconds", () => {
    expect(POLL_INTERVAL_MS).toBe(2_000);
  });

  test("start polls at once, then every two seconds, until stopped", async () => {
    const scripted = scriptedAdapter(result([]));
    const { poller } = setUp(scripted.adapter);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(scripted.calls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(scripted.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scripted.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(scripted.calls).toBe(5);

    poller.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(scripted.calls).toBe(5);
  });

  test("starting twice does not double the polling", async () => {
    const scripted = scriptedAdapter(result([]));
    const { poller } = setUp(scripted.adapter);
    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(scripted.calls).toBe(3);
    poller.stop();
  });

  test("a slow poll is never overlapped by the next one", async () => {
    let running = 0;
    let mostAtOnce = 0;
    let calls = 0;
    const slow: Adapter = {
      id: "claude-code",
      label: "Claude Code",
      poll: async () => {
        calls += 1;
        running += 1;
        mostAtOnce = Math.max(mostAtOnce, running);
        // Each poll takes 5 seconds: longer than two intervals.
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        running -= 1;
        return result([]);
      },
    };
    const { poller, history } = setUp(slow);

    poller.start();
    await vi.advanceTimersByTimeAsync(4_999);
    // Ticks at 2s and 4s arrived while the first poll was still running.
    expect(calls).toBe(1);
    expect(history.size).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(history.size).toBe(1);
    // The next poll begins on the next tick, at 6s, not the moment the slow one ends.
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mostAtOnce).toBe(1);
    expect(calls).toBeGreaterThan(3);
    poller.stop();
  });

  test("asking for a poll while one is under way joins it and does not start another", async () => {
    let calls = 0;
    const slow: Adapter = {
      id: "claude-code",
      label: "Claude Code",
      poll: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return result([]);
      },
    };
    const { poller } = setUp(slow);

    const first = poller.pollOnce();
    const second = poller.pollOnce();
    expect(second).toBe(first);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBe(await second);
    expect(calls).toBe(1);

    const third = poller.pollOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await third;
    expect(calls).toBe(2);
  });

  test("startedAt is when polling began", () => {
    const { adapter } = scriptedAdapter(result([]));
    const { poller } = setUp(adapter);
    expect(poller.startedAt).toBe(T0);
    vi.setSystemTime(T0 + 7_000);
    poller.start();
    expect(poller.startedAt).toBe(T0 + 7_000);
    poller.stop();
  });
});

describe("events", () => {
  test("the first poll is the baseline and produces no events", async () => {
    const { adapter } = scriptedAdapter(
      result([makeSession({ status: "needs-you" }), makeSession({ id: "claude-code:2" })]),
    );
    const { poller, events } = setUp(adapter);
    await poller.pollOnce();
    expect(events.list()).toEqual([]);
  });

  test("later polls are diffed against the one before", async () => {
    const a = makeSession({ id: "claude-code:a", name: "demo-a", status: "working" });
    const b = makeSession({ id: "claude-code:b", name: "demo-b", status: "idle" });
    const c = makeSession({ id: "claude-code:c", name: "demo-c", status: "working" });
    const { adapter } = scriptedAdapter(
      result([a, b]),
      result([{ ...a, status: "needs-you", waitingReason: "permission" }, b]),
      result([{ ...a, status: "failed" }, c]),
    );
    const { poller, events } = setUp(adapter);

    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(events.list()).toEqual([
      {
        id: `claude-code:a@${T0 + 2_000}:status-changed`,
        at: T0 + 2_000,
        sessionId: "claude-code:a",
        sessionName: "demo-a",
        kind: "status-changed",
        from: "working",
        to: "needs-you",
        severity: "warning",
      },
    ]);

    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    expect(
      events.list().map((event) => [event.at - T0, event.sessionName, event.kind, event.severity]),
    ).toEqual([
      [4_000, "demo-b", "ended", "advisory"],
      [4_000, "demo-c", "appeared", "advisory"],
      [4_000, "demo-a", "status-changed", "critical"],
      [2_000, "demo-a", "status-changed", "warning"],
    ]);
  });

  test("a source that is not set up has been read, with no sessions, so what it lists once set up has appeared", async () => {
    const custom = makeSession({ id: "status-files:night-shift.json", name: "checkout-flow" });
    const notSetUp: AdapterResult = { ...result([], "not-set-up"), basis: "files" };
    const { adapter } = scriptedAdapter(
      notSetUp,
      { ...result([custom]), basis: "files" },
      notSetUp,
    );
    const { poller, events } = setUp(adapter);

    await poller.pollOnce();
    expect(events.list()).toEqual([]);
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(events.list().map((event) => [event.sessionName, event.kind])).toEqual([
      ["checkout-flow", "appeared"],
    ]);
    // Taken away again, the folder holds nothing, so the session has ended.
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    expect(events.list().map((event) => [event.sessionName, event.kind])).toEqual([
      ["checkout-flow", "ended"],
      ["checkout-flow", "appeared"],
    ]);
  });

  test("a source that fails for one poll does not end every session and bring them back", async () => {
    const a = makeSession({ id: "claude-code:a", status: "working" });
    const b = makeSession({ id: "claude-code:b", status: "idle" });
    const { adapter } = scriptedAdapter(
      result([a, b]),
      result([], "error"),
      result([], "unavailable"),
      result([{ ...a, status: "idle" }, b]),
    );
    const { poller, events } = setUp(adapter);

    await poller.pollOnce();
    await poller.pollOnce();
    expect(poller.getSnapshot().sessions).toEqual([]);
    expect(poller.getSnapshot().sources[0]?.state).toBe("error");
    await poller.pollOnce();
    expect(events.list()).toEqual([]);

    // When the source answers again, only the real change is reported.
    await poller.pollOnce();
    expect(
      events.list().map((event) => [event.sessionId, event.kind, event.from, event.to]),
    ).toEqual([["claude-code:a", "status-changed", "working", "idle"]]);
  });

  test("a session that really ended while the source was failing is reported when it recovers", async () => {
    const a = makeSession({ id: "claude-code:a" });
    const b = makeSession({ id: "claude-code:b" });
    const { adapter } = scriptedAdapter(result([a, b]), result([], "error"), result([a]));
    const { poller, events } = setUp(adapter);
    await poller.pollOnce();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(events.list().map((event) => [event.sessionId, event.kind])).toEqual([
      ["claude-code:b", "ended"],
    ]);
  });
});

describe("events when an adapter changes how it reads its source", () => {
  const feed = (sessions: Session[]): AdapterResult => ({ ...result(sessions), basis: "feed" });
  const registry = (sessions: Session[]): AdapterResult => ({
    ...result(sessions),
    basis: "registry",
  });

  test("a fallback poll is a new baseline, not a wave of endings and arrivals", async () => {
    const live = makeSession({ id: "claude-code:live", status: "working" });
    const background = makeSession({ id: "claude-code:job", status: "needs-you" });
    const { adapter } = scriptedAdapter(
      feed([live, background]),
      // The fallback cannot see the background job and reports a different status.
      registry([{ ...live, status: "unknown" }]),
      feed([live, background]),
    );
    const { poller, events } = setUp(adapter);

    await poller.pollOnce();
    await poller.pollOnce();
    expect(poller.getSnapshot().sessions.map((session) => session.id)).toEqual([
      "claude-code:live",
    ]);
    await poller.pollOnce();

    expect(events.list()).toEqual([]);
  });

  test("polls read the same way are still compared, in the fallback as in the feed", async () => {
    const a = makeSession({ id: "claude-code:a", status: "working" });
    const { adapter } = scriptedAdapter(
      feed([a]),
      registry([a]),
      registry([{ ...a, status: "idle" }]),
      feed([{ ...a, status: "idle" }]),
      feed([{ ...a, status: "needs-you" }]),
    );
    const { poller, events } = setUp(adapter);
    for (let poll = 0; poll < 5; poll += 1) await poller.pollOnce();

    expect(events.list().map((event) => [event.from, event.to])).toEqual([
      ["idle", "needs-you"],
      ["working", "idle"],
    ]);
  });
});

describe("changes that happen across a switch between two ways of reading", () => {
  const feed = (sessions: Session[]): AdapterResult => ({ ...result(sessions), basis: "feed" });
  const registry = (sessions: Session[]): AdapterResult => ({
    ...result(sessions),
    basis: "registry",
  });
  const a = makeSession({ id: "claude-code:a", name: "demo-a", status: "working" });
  const b = makeSession({ id: "claude-code:b", name: "demo-b", status: "idle" });
  const told = (events: ReturnType<typeof createEventStore>) =>
    events.list().map((event) => [event.sessionName, event.kind, event.from, event.to]);

  test("a one-poll fallback does not swallow a change or an ending: both are reported on return", async () => {
    const { adapter } = scriptedAdapter(
      feed([a, b]),
      registry([{ ...a, status: "needs-you" }, b]),
      feed([{ ...a, status: "needs-you" }]),
      feed([{ ...a, status: "needs-you" }]),
    );
    const { poller, events } = setUp(adapter);

    await poller.pollOnce();
    await poller.pollOnce();
    expect(events.list()).toEqual([]);

    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    expect(told(events)).toEqual([
      ["demo-b", "ended", "idle", undefined],
      ["demo-a", "status-changed", "working", "needs-you"],
    ]);
    expect(events.list()[1]?.severity).toBe("warning");

    await poller.pollOnce();
    expect(events.list()).toHaveLength(2);
  });

  test("an ending already reported during the fallback is not reported again on return", async () => {
    const { adapter } = scriptedAdapter(
      feed([a, b]),
      registry([a, b]),
      registry([a]),
      feed([a]),
      feed([a]),
    );
    const { poller, events } = setUp(adapter);
    for (let poll = 0; poll < 5; poll += 1) await poller.pollOnce();
    expect(told(events)).toEqual([["demo-b", "ended", "idle", undefined]]);
  });

  test("an arrival already reported during the fallback is not reported again on return", async () => {
    const c = makeSession({ id: "claude-code:c", name: "demo-c", status: "working" });
    const { adapter } = scriptedAdapter(
      feed([a]),
      registry([a]),
      registry([a, c]),
      registry([a, { ...c, status: "needs-you" }]),
      feed([a, { ...c, status: "idle" }]),
    );
    const { poller, events } = setUp(adapter);
    for (let poll = 0; poll < 5; poll += 1) await poller.pollOnce();
    // On return the feed has never seen the session, but the log has: it reads
    // as one more change of status, from where the log left it.
    expect(told(events)).toEqual([
      ["demo-c", "status-changed", "needs-you", "idle"],
      ["demo-c", "status-changed", "working", "needs-you"],
      ["demo-c", "appeared", undefined, "working"],
    ]);
  });

  test("a session only the fallback can see is reported when it ends, once", async () => {
    const d = makeSession({ id: "claude-code:d", name: "demo-d", status: "idle" });
    const { adapter } = scriptedAdapter(
      feed([a]),
      registry([a, d]),
      registry([a]),
      feed([a]),
      registry([a]),
    );
    const { poller, events } = setUp(adapter);
    for (let poll = 0; poll < 5; poll += 1) await poller.pollOnce();
    expect(told(events)).toEqual([["demo-d", "ended", "idle", undefined]]);
  });

  test("a long fallback, then a return to a feed that is as it was, says nothing new", async () => {
    const job = makeSession({ id: "claude-code:job", name: "nightly-report", status: "needs-you" });
    const { adapter } = scriptedAdapter(
      feed([a, job]),
      registry([a]),
      registry([{ ...a, status: "idle" }]),
      registry([a]),
      feed([a, job]),
    );
    const { poller, events } = setUp(adapter);
    for (let poll = 0; poll < 5; poll += 1) await poller.pollOnce();
    expect(told(events)).toEqual([
      ["demo-a", "status-changed", "idle", "working"],
      ["demo-a", "status-changed", "working", "idle"],
    ]);
  });
});

describe("a source that does not answer", () => {
  /** An adapter whose polls are answered by hand, or never. */
  function manualAdapter() {
    const resolvers: ((answer: AdapterResult) => void)[] = [];
    const adapter: Adapter = {
      id: "claude-code",
      label: "Claude Code",
      lookingIn: "Looking for sessions in a test.",
      poll: () => new Promise((resolve) => resolvers.push(resolve)),
    };
    return {
      adapter,
      get calls() {
        return resolvers.length;
      },
      answer: (call: number, answer: AdapterResult) => resolvers[call]?.(answer),
    };
  }

  test("the deadline is fifteen seconds", () => {
    expect(POLL_DEADLINE_MS).toBe(15_000);
  });

  test("a first poll that never returns becomes an error, not an endless search", async () => {
    const stuck = manualAdapter();
    const { poller, history } = setUp(stuck.adapter);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_DEADLINE_MS - 1);
    expect(poller.getSnapshot().sources[0]?.state).toBe("searching");

    await vi.advanceTimersByTimeAsync(1);
    expect(poller.getSnapshot().sources[0]).toEqual({
      id: "claude-code",
      label: "Claude Code",
      state: "error",
      detail:
        "Claude Code has not answered for 15 seconds. Agent Lookout is still waiting for it and will show its sessions when it answers.",
      checkedAt: T0 + POLL_DEADLINE_MS,
    });
    expect(poller.getSnapshot().sessions).toEqual([]);
    // Nothing was measured, so nothing is charted.
    expect(history.size).toBe(0);
    poller.stop();
  });

  test("a later poll that never returns stops the last good snapshot being served as healthy", async () => {
    const source = manualAdapter();
    const { poller } = setUp(source.adapter);

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    source.answer(0, result([makeSession()]));
    await vi.advanceTimersByTimeAsync(0);
    expect(poller.getSnapshot().sources[0]?.state).toBe("ok");
    expect(poller.getSnapshot().sessions).toHaveLength(1);

    // The second poll starts at 2 s and is never answered.
    await vi.advanceTimersByTimeAsync(2_000 + POLL_DEADLINE_MS);
    expect(source.calls).toBe(2);
    expect(poller.getSnapshot().sources[0]?.state).toBe("error");
    expect(poller.getSnapshot().sessions).toEqual([]);
    poller.stop();
  });

  test("it is not asked again while its answer is still awaited, and the polls keep coming", async () => {
    const stuck = manualAdapter();
    const { poller } = setUp(stuck.adapter);

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_DEADLINE_MS + 60_000);

    // One question, however many polls went by.
    expect(stuck.calls).toBe(1);
    const source = poller.getSnapshot().sources[0];
    expect(source?.state).toBe("error");
    // The snapshot is fresh: later polls were not held up behind the stuck one.
    expect(poller.getSnapshot().generatedAt).toBeGreaterThan(T0 + POLL_DEADLINE_MS + 55_000);
    expect(source?.detail).toMatch(/^Claude Code has not answered for 7\d seconds\./);
    poller.stop();
  });

  test("when the answer finally arrives it is shown, and polling goes on as before", async () => {
    const slow = manualAdapter();
    const { poller, events } = setUp(slow.adapter);
    const session = makeSession({ id: "claude-code:a", status: "working" });

    poller.start();
    await vi.advanceTimersByTimeAsync(POLL_DEADLINE_MS + 5_000);
    expect(poller.getSnapshot().sources[0]?.state).toBe("error");

    slow.answer(0, result([session]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(poller.getSnapshot().sources[0]?.state).toBe("ok");
    expect(poller.getSnapshot().sessions).toHaveLength(1);

    // The poll after that asks afresh, and its answer is compared as usual.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(slow.calls).toBe(2);
    slow.answer(1, result([{ ...session, status: "needs-you" }]));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.list().map((event) => [event.from, event.to])).toEqual([
      ["working", "needs-you"],
    ]);
    poller.stop();
  });

  test("one stuck source does not hold back another", async () => {
    const stuck = manualAdapter();
    const healthy = scriptedAdapter(result([makeSession()]));
    const events = createEventStore();
    const history = createHistoryStore();
    const poller = createPoller({
      adapters: [stuck.adapter, healthy.adapter],
      events,
      history,
      deadlineMs: 1_000,
    });

    poller.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(poller.getSnapshot().sources.map((source) => source.state)).toEqual(["error", "ok"]);

    const before = healthy.calls;
    await vi.advanceTimersByTimeAsync(10_000);
    // Every two seconds, not every deadline.
    expect(healthy.calls - before).toBe(5);
    expect(stuck.calls).toBe(1);
    poller.stop();
  });
});

describe("history", () => {
  test("each poll that got an answer appends one point", async () => {
    const { adapter } = scriptedAdapter(
      result([
        makeSession({ id: "claude-code:a", status: "needs-you" }),
        makeSession({ id: "claude-code:b", status: "working" }),
        makeSession({ id: "claude-code:c", status: "idle" }),
        makeSession({ id: "claude-code:d", status: "finished" }),
      ]),
      result([]),
    );
    const { poller, history } = setUp(adapter);

    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();

    expect(history.list(60_000, T0 + 2_000)).toEqual([
      { at: T0, needsYou: 1, working: 1, idle: 1, total: 4 },
      { at: T0 + 2_000, needsYou: 0, working: 0, idle: 0, total: 0 },
    ]);
  });

  test("a poll in which the source did not answer leaves a gap, not a zero", async () => {
    const one = [makeSession({ status: "working" })];
    const { adapter } = scriptedAdapter(result(one), result([], "error"), result(one));
    const { poller, history } = setUp(adapter);

    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();

    expect(history.list(60_000, T0 + 4_000).map((point) => [point.at - T0, point.total])).toEqual([
      [0, 1],
      [4_000, 1],
    ]);
  });
});

describe("history with more than one source", () => {
  /** An adapter for one source that answers with whatever the test queued, one answer per poll. */
  function sourceAdapter(id: SourceId, ...answers: [Session[], SourceState][]): Adapter {
    const label = id === "codex" ? "Codex" : "Claude Code";
    let calls = 0;
    return {
      id,
      label,
      lookingIn: `Looking for ${label} sessions in a test.`,
      poll: async () => {
        const [sessions, state] = answers[Math.min(calls, answers.length - 1)] as [
          Session[],
          SourceState,
        ];
        calls += 1;
        return { health: { id, label, state, checkedAt: Date.now() }, sessions };
      },
    };
  }

  const working = (id: SourceId, count: number) =>
    Array.from({ length: count }, (_, index) =>
      makeSession({ id: `${id}:${index}`, source: id, status: "working" }),
    );

  /** Polls once per answer, two seconds apart, and returns each point as [seconds, working]. */
  async function chart(...adapters: Adapter[]) {
    const history = createHistoryStore();
    const poller = createPoller({ adapters, events: createEventStore(), history });
    for (let poll = 0; poll < 6; poll += 1) {
      vi.setSystemTime(T0 + poll * 2_000);
      await poller.pollOnce();
    }
    return history
      .list(60_000, T0 + 10_000)
      .map((point) => [(point.at - T0) / 1000, point.working]);
  }

  const claude = working("claude-code", 4);
  const codex = working("codex", 1);

  test("a source that answered and then fails for a poll leaves a gap, not a drop", async () => {
    const points = await chart(
      sourceAdapter("claude-code", [claude, "ok"], [[], "error"], [claude, "ok"]),
      sourceAdapter("codex", [codex, "ok"]),
    );
    expect(points).toEqual([
      [0, 5],
      [4, 5],
      [6, 5],
      [8, 5],
      [10, 5],
    ]);
  });

  test("a source that keeps failing leaves a gap for as long as it fails", async () => {
    const points = await chart(
      sourceAdapter(
        "claude-code",
        [claude, "ok"],
        [[], "error"],
        [[], "error"],
        [[], "error"],
        [claude, "ok"],
      ),
      sourceAdapter("codex", [codex, "ok"]),
    );
    expect(points).toEqual([
      [0, 5],
      [8, 5],
      [10, 5],
    ]);
  });

  test("a source that turns unavailable leaves a gap for one poll, then counts as having none", async () => {
    const points = await chart(
      sourceAdapter("claude-code", [claude, "ok"]),
      sourceAdapter("codex", [codex, "ok"], [[], "unavailable"]),
    );
    expect(points).toEqual([
      [0, 5],
      [4, 4],
      [6, 4],
      [8, 4],
      [10, 4],
    ]);
  });

  test("a folder of status files that is taken away leaves a gap for one poll, then counts as having none", async () => {
    const custom = working("status-files", 2);
    const points = await chart(
      sourceAdapter("claude-code", [claude, "ok"]),
      sourceAdapter("status-files", [custom, "ok"], [[], "not-set-up"]),
    );
    expect(points).toEqual([
      [0, 6],
      [4, 4],
      [6, 4],
      [8, 4],
      [10, 4],
    ]);
    // Never set up, it holds back no one.
    const never = await chart(
      sourceAdapter("claude-code", [claude, "ok"]),
      sourceAdapter("status-files", [[], "not-set-up"]),
    );
    expect(never.map(([, count]) => count)).toEqual([4, 4, 4, 4, 4, 4]);
  });

  test("a source that has never answered does not hold back one that has", async () => {
    const neverOk = await chart(
      sourceAdapter("claude-code", [claude, "ok"]),
      sourceAdapter("codex", [[], "error"]),
    );
    expect(neverOk).toHaveLength(6);
    const notInstalled = await chart(
      sourceAdapter("claude-code", [claude, "ok"]),
      sourceAdapter("codex", [[], "unavailable"]),
    );
    expect(notInstalled.map(([, count]) => count)).toEqual([4, 4, 4, 4, 4, 4]);
  });

  test("a source found later is counted from its first answer, with no gap", async () => {
    const points = await chart(
      sourceAdapter("claude-code", [claude, "ok"]),
      sourceAdapter("codex", [[], "unavailable"], [[], "unavailable"], [codex, "ok"]),
    );
    expect(points.map(([, count]) => count)).toEqual([4, 4, 5, 5, 5, 5]);
  });
});

describe("an adapter that breaks its promise", () => {
  test("a throwing adapter becomes an error state and the poller carries on", async () => {
    let calls = 0;
    const broken: Adapter = {
      id: "claude-code",
      label: "Claude Code",
      poll: async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom at /Users/example/secret.ts:1:1");
        return result([makeSession()]);
      },
    };
    const { poller, history } = setUp(broken);

    const first = await poller.pollOnce();
    expect(first.sessions).toEqual([]);
    expect(first.sources).toEqual([
      {
        id: "claude-code",
        label: "Claude Code",
        state: "error",
        detail: "Something unexpected went wrong while reading Claude Code sessions.",
        checkedAt: T0,
      },
    ]);
    expect(history.size).toBe(0);

    const second = await poller.pollOnce();
    expect(second.sources[0]?.state).toBe("ok");
    expect(second.sessions).toHaveLength(1);
  });
});
