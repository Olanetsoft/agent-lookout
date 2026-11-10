import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Adapter, AdapterResult } from "@collector/adapters/adapter";
import { createEventStore } from "@collector/eventStore";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller, POLL_DEADLINE_MS, POLL_INTERVAL_MS } from "@collector/poller";
import type {
  Session,
  SessionEvent,
  SessionsSnapshot,
  SessionStatus,
  SourceHealth,
  SourceId,
  SourceState,
} from "@core/sessions/session";
import { DEFAULT_TIME_RULES, type TimeRules } from "@core/time-rules/timeRules";
import type { WaitSighting } from "@core/waits/waitSightings";
import { unendedWaits, waitTotals } from "@core/waits/waitTotals";
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

  test("what an adapter declares it can report goes with every health of its source, and none is made up", async () => {
    const capabilities = {
      "working-and-idle": { level: "yes" },
      "needs-you": { level: "no", reason: "This tool does not record waits." },
      finished: { level: "yes" },
      failed: { level: "yes" },
      names: { level: "yes" },
      jump: { level: "no", reason: "This tool names no place to go." },
      "quiet-for": { level: "partly", reason: "Only while it writes its file." },
      tokens: { level: "yes" },
      stop: { level: "no", reason: "It names no process to stop." },
      answer: { level: "no", reason: "It records no waits to answer." },
    } as const;
    let calls = 0;
    const declaring: Adapter = {
      id: "claude-code",
      label: "Claude Code",
      lookingIn: "Looking for sessions in a test.",
      capabilities,
      poll: async () => {
        calls += 1;
        if (calls === 2) throw new Error("boom");
        return { ...result([]), basis: "registry" };
      },
    };
    const { adapter: silent } = scriptedAdapter(result([]));
    const poller = createPoller({
      adapters: [declaring, { ...silent, id: "codex", label: "Codex" }],
      events: createEventStore(),
      history: createHistoryStore(),
    });

    // Searching, answered, and broken: the same declaration each time.
    expect(poller.getSnapshot().sources[0]?.capabilities).toBe(capabilities);
    const answered = await poller.pollOnce();
    expect(answered.sources[0]).toEqual({ ...health(), basis: "registry", capabilities });
    const broken = await poller.pollOnce();
    expect(broken.sources[0]?.state).toBe("error");
    expect(broken.sources[0]?.capabilities).toBe(capabilities);

    // An adapter that declares nothing is given nothing.
    expect(answered.sources[1]).not.toHaveProperty("capabilities");
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

describe("what the collector adds to every session", () => {
  test("the snapshot holds the sessions as the collector gave them more, from every source", async () => {
    const codex: Adapter = {
      id: "codex",
      label: "Codex",
      poll: async () => ({
        health: { id: "codex", label: "Codex", state: "ok", checkedAt: T0 },
        sessions: [makeSession({ id: "codex:a", source: "codex", status: "working" })],
      }),
    };
    const { adapter } = scriptedAdapter(result([makeSession({ id: "claude-code:a" })]));
    const given: string[][] = [];
    const poller = createPoller({
      adapters: [adapter, codex],
      events: createEventStore(),
      history: createHistoryStore(),
      annotate: async (sessions) => {
        given.push(sessions.map((session) => session.id));
        return sessions.map((session) => ({ ...session, git: { branch: "checkout-flow" } }));
      },
    });

    const snapshot = await poller.pollOnce();

    expect(given).toEqual([["claude-code:a", "codex:a"]]);
    expect(snapshot.sessions.map((session) => [session.id, session.git])).toEqual([
      ["codex:a", { branch: "checkout-flow" }],
      ["claude-code:a", { branch: "checkout-flow" }],
    ]);
  });

  test("a branch that changes is no event, and one that fails to be added stops nothing", async () => {
    const a = makeSession({ id: "claude-code:a", status: "working" });
    const { adapter } = scriptedAdapter(result([a]));
    const events = createEventStore();
    let poll = 0;
    const poller = createPoller({
      adapters: [adapter],
      events,
      history: createHistoryStore(),
      annotate: async (sessions) => {
        poll += 1;
        if (poll === 3) throw new Error("The branches could not be read.");
        return sessions.map((session) => ({ ...session, git: { branch: `branch-${poll}` } }));
      },
    });

    expect((await poller.pollOnce()).sessions[0]?.git).toEqual({ branch: "branch-1" });
    expect((await poller.pollOnce()).sessions[0]?.git).toEqual({ branch: "branch-2" });
    const third = await poller.pollOnce();
    expect(third.sessions).toEqual([a]);
    expect(events.list()).toEqual([]);
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

describe("events after a restart, with history kept from before it", () => {
  /** An event of the history kept, as the poller wrote it then. */
  function kept(
    sessionId: string,
    kind: SessionEvent["kind"],
    to: SessionStatus | undefined,
    at = T0 - 60_000,
  ): SessionEvent {
    return {
      id: `${sessionId}@${at}:${kind}`,
      at,
      sessionId,
      sessionName: sessionId.split(":")[1] as string,
      kind,
      ...(to !== undefined && { to }),
      severity: "advisory",
    };
  }

  test("the first poll is compared with what each session was last doing: what changed while stopped is an event of that poll", async () => {
    const a = makeSession({ id: "claude-code:a", name: "demo-a", status: "needs-you" });
    const b = makeSession({ id: "claude-code:b", name: "demo-b", status: "working" });
    const c = makeSession({ id: "claude-code:c", name: "demo-c", status: "idle" });
    const d = makeSession({ id: "claude-code:d", name: "demo-d", status: "working" });
    const { adapter } = scriptedAdapter(result([a, b, c, d]));
    const { poller, events } = setUp(adapter);
    poller.resume([
      // a was working, then started waiting while Agent Lookout was stopped.
      kept("claude-code:a", "appeared", "idle", T0 - 120_000),
      kept("claude-code:a", "status-changed", "working"),
      // b is working, as it was.
      kept("claude-code:b", "status-changed", "working"),
      // e was waiting, and ended while Agent Lookout was stopped.
      kept("claude-code:e", "status-changed", "needs-you"),
      // d had ended, and is back.
      kept("claude-code:d", "ended", undefined),
      // c is not in the history at all: it is taken as it is found.
    ]);
    vi.setSystemTime(T0 + 5 * 60_000);
    await poller.pollOnce();
    expect(
      events
        .list()
        .map((event) => [event.at - T0, event.sessionName, event.kind, event.from, event.to]),
    ).toEqual([
      [300_000, "e", "ended", "needs-you", undefined],
      [300_000, "demo-d", "appeared", undefined, "working"],
      [300_000, "demo-a", "status-changed", "working", "needs-you"],
    ]);

    // The polls after it are compared with the one before, as ever.
    vi.setSystemTime(T0 + 5 * 60_000 + 2_000);
    await poller.pollOnce();
    expect(events.list()).toHaveLength(3);
  });

  test("a part the first poll could not look at gets no event, then or at its first read, and the rest is compared", async () => {
    const read = makeSession({ id: "claude-code:read/a", status: "idle" });
    const refused = makeSession({ id: "claude-code:refused/b", status: "working" });
    const parts = { "claude-code:read/": "files" };
    const { adapter } = scriptedAdapter(
      {
        health: { ...health(), parts },
        sessions: [read],
        notLookedAt: ["claude-code:refused/"],
      },
      {
        health: { ...health(), parts: { ...parts, "claude-code:refused/": "files" } },
        sessions: [read, refused],
      },
    );
    const { poller, events } = setUp(adapter);
    poller.resume([
      kept("claude-code:read/a", "status-changed", "idle"),
      kept("claude-code:read/c", "status-changed", "idle"),
      // Its status differs, and d is gone: neither was seen by a poll that could say.
      kept("claude-code:refused/b", "status-changed", "idle"),
      kept("claude-code:refused/d", "status-changed", "idle"),
      // In a part this poll does not name, and that it did not fail to look at.
      kept("claude-code:gone/e", "status-changed", "idle"),
    ]);
    const logged = () => events.list().map((event) => [event.sessionId, event.kind]);

    await poller.pollOnce();
    expect(logged()).toEqual([
      ["claude-code:gone/e", "ended"],
      ["claude-code:read/c", "ended"],
    ]);

    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(logged()).toHaveLength(2);
  });

  test("a source that does not answer at first is compared once it does, and only with its own sessions", async () => {
    const a = makeSession({ id: "claude-code:a", status: "idle" });
    const { adapter } = scriptedAdapter(result([], "error"), result([a]));
    const { poller, events } = setUp(adapter);
    poller.resume([
      kept("claude-code:a", "status-changed", "working"),
      // Another source's session, which this source knows nothing of.
      kept("status-files:night-shift.json", "status-changed", "working"),
      kept("no-source", "status-changed", "working"),
    ]);
    await poller.pollOnce();
    expect(events.list()).toEqual([]);
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(
      events.list().map((event) => [event.sessionId, event.kind, event.from, event.to]),
    ).toEqual([["claude-code:a", "status-changed", "working", "idle"]]);
  });

  test("a session stopped from Agent Lookout is taken as its last status said, not as a status of its own", async () => {
    const a = makeSession({ id: "claude-code:a", name: "demo-a", status: "idle" });
    const { adapter } = scriptedAdapter(result([a]));
    const { poller, events } = setUp(adapter);
    poller.resume([
      kept("claude-code:a", "status-changed", "working", T0 - 60_000),
      // A stop that did not end it, the newest event held, says nothing of its status.
      {
        ...kept("claude-code:a", "stopped", undefined, T0 - 30_000),
        from: "working",
        by: "agent-lookout",
      },
    ]);
    vi.setSystemTime(T0 + 60_000);
    await poller.pollOnce();
    expect(events.list().map((event) => [event.kind, event.from, event.to])).toEqual([
      ["status-changed", "working", "idle"],
    ]);
  });

  test("a session on another machine is compared with what that machine's source last said of it", async () => {
    const devbox: Adapter = {
      id: "remote:devbox",
      label: "devbox",
      poll: async () => ({
        health: { id: "remote:devbox", label: "devbox", state: "ok", checkedAt: Date.now() },
        sessions: [
          makeSession({
            id: "remote:devbox:claude-code:a",
            source: "remote:devbox",
            machine: "devbox",
            name: "demo-a",
            status: "needs-you",
          }),
        ],
      }),
    };
    // A machine whose name begins the other's is a source of its own.
    const dev: Adapter = {
      id: "remote:dev",
      label: "dev",
      poll: async () => ({
        health: { id: "remote:dev", label: "dev", state: "ok", checkedAt: Date.now() },
        sessions: [],
      }),
    };
    const events = createEventStore();
    const poller = createPoller({ adapters: [dev, devbox], events, history: createHistoryStore() });
    poller.resume([kept("remote:devbox:claude-code:a", "status-changed", "working")]);
    await poller.pollOnce();
    expect(
      events.list().map((event) => [event.sessionId, event.kind, event.from, event.to]),
    ).toEqual([["remote:devbox:claude-code:a", "status-changed", "working", "needs-you"]]);
  });

  test("without history from before, the first poll is a baseline", async () => {
    const { adapter } = scriptedAdapter(result([makeSession({ id: "claude-code:a" })]));
    const { poller, events } = setUp(adapter);
    poller.resume([]);
    await poller.pollOnce();
    expect(events.list()).toEqual([]);
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

  test("the snapshot says how each source was read, so its listeners can compare the same way", async () => {
    const { adapter } = scriptedAdapter(registry([]), result([]));
    const { poller } = setUp(adapter);

    await poller.pollOnce();
    expect(poller.getSnapshot().sources).toEqual([{ ...health(), basis: "registry" }]);
    await poller.pollOnce();
    expect(poller.getSnapshot().sources[0]).not.toHaveProperty("basis");
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

describe("events of a source read in parts that can each fail alone", () => {
  // As Hermes Agent's adapter reads each profile's database apart, and names
  // in `parts` each profile it read on a poll.
  const DEFAULT = "hermes-agent:default/";
  const CODER = "hermes-agent:coder/";
  const both = { [DEFAULT]: "database", [CODER]: "database" };
  const own = makeSession({
    id: `${DEFAULT}a`,
    source: "hermes-agent",
    name: "demo-a",
    status: "idle",
  });
  const coder = makeSession({
    id: `${CODER}b`,
    source: "hermes-agent",
    name: "demo-b",
    status: "working",
  });

  function partsAdapter(...answers: [Session[], Record<string, string>][]) {
    let calls = 0;
    const adapter: Adapter = {
      id: "hermes-agent",
      label: "Hermes Agent",
      lookingIn: "Looking for sessions in a test.",
      poll: async () => {
        const [sessions, parts] = answers[Math.min(calls, answers.length - 1)] as [
          Session[],
          Record<string, string>,
        ];
        calls += 1;
        return {
          health: {
            id: "hermes-agent",
            label: "Hermes Agent",
            state: "ok",
            checkedAt: Date.now(),
            parts,
          },
          sessions,
          basis: "database",
        };
      },
    };
    return adapter;
  }

  const told = (events: ReturnType<typeof createEventStore>) =>
    events.list().map((event) => [event.sessionName, event.kind, event.from, event.to]);

  test("a part left out of one poll has not ended, and has not appeared when it is read again", async () => {
    const { poller, events } = setUp(
      partsAdapter([[own, coder], both], [[own], { [DEFAULT]: "database" }], [[own, coder], both]),
    );
    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    // The coder profile's session is not in this snapshot, which shows what was read.
    expect(poller.getSnapshot().sessions.map((session) => session.id)).toEqual([own.id]);
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    expect(events.list()).toEqual([]);
  });

  test("a part left out keeps its own last answer, so a change it made meanwhile is told once it is read again, and the other part's changes at once", async () => {
    const { poller, events } = setUp(
      partsAdapter(
        [[own, coder], both],
        [[{ ...own, status: "working" }], { [DEFAULT]: "database" }],
        [
          [
            { ...own, status: "working" },
            { ...coder, status: "needs-you" },
          ],
          both,
        ],
      ),
    );
    for (let poll = 0; poll < 3; poll += 1) {
      vi.setSystemTime(T0 + poll * 2_000);
      await poller.pollOnce();
    }
    expect(told(events)).toEqual([
      ["demo-b", "status-changed", "working", "needs-you"],
      ["demo-a", "status-changed", "idle", "working"],
    ]);
  });

  test("a part that is read and no longer lists a session has ended it, and one it lists for the first time has appeared", async () => {
    const fresh = makeSession({
      id: `${CODER}c`,
      source: "hermes-agent",
      name: "demo-c",
      status: "working",
    });
    const { poller, events } = setUp(partsAdapter([[own, coder], both], [[own, fresh], both]));
    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(told(events).sort()).toEqual([
      ["demo-b", "ended", "working", undefined],
      ["demo-c", "appeared", undefined, "working"],
    ]);
  });

  test("without parts, the same poll would tell the part left out as ended, and again as appeared", async () => {
    // What the parts are for: the same answers with no part named.
    const { poller, events } = setUp(
      partsAdapter([[own, coder], {}], [[own], {}], [[own, coder], {}]),
    );
    for (let poll = 0; poll < 3; poll += 1) {
      vi.setSystemTime(T0 + poll * 2_000);
      await poller.pollOnce();
    }
    expect(told(events)).toEqual([
      ["demo-b", "appeared", undefined, "working"],
      ["demo-b", "ended", "working", undefined],
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

describe("a wait that ends when its agent closes, in a way of reading of its own", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const asking = makeSession({ id: "claude-code:a", name: "demo-a", status: "needs-you" });
  const open = (status: SessionStatus): AdapterResult => ({
    ...result([{ ...asking, status }]),
    basis: "open",
  });
  const closed: AdapterResult = { ...result([{ ...asking, status: "finished" }]), basis: "closed" };

  /** A poller that takes one answer at each moment, in time order. */
  async function play(...steps: [number, AdapterResult][]) {
    const { adapter } = scriptedAdapter(...steps.map(([, answer]) => answer));
    const { poller, events } = setUp(adapter);
    for (const [after] of steps) {
      vi.setSystemTime(T0 + after);
      await poller.pollOnce();
    }
    return { poller, events };
  }

  const told = (events: ReturnType<typeof createEventStore>) =>
    [...events.list()]
      .sort((a, b) => a.at - b.at)
      .map((event) => [event.at - T0, event.from, event.to]);

  /** What the waits add up to, with every moment since the first poll measured. */
  function totals(events: ReturnType<typeof createEventStore>, now: number, waiting: boolean) {
    const { sevenDays } = waitTotals({
      events: events.list(),
      measured: [{ from: T0, to: T0 + now }],
      runStarts: [T0],
      waitingNow: waiting ? [{ id: asking.id, name: asking.name }] : [],
      since: T0,
      now: T0 + now,
    });
    return [sevenDays.waitedMs, sevenDays.openMs, sevenDays.waits];
  }

  test("ends on the first poll read the new way, though that poll is a baseline", async () => {
    const { events } = await play(
      [0, open("working")],
      [MINUTE, open("needs-you")],
      [2 * MINUTE, closed],
      [8 * HOUR, closed],
    );
    expect(told(events)).toEqual([
      [MINUTE, "working", "needs-you"],
      [2 * MINUTE, "needs-you", "finished"],
    ]);
    expect(totals(events, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("ends though an older poll read that way already holds the session as finished", async () => {
    const { events } = await play(
      [0, closed],
      [MINUTE, open("working")],
      [2 * MINUTE, open("needs-you")],
      [3 * MINUTE, closed],
      [8 * HOUR, closed],
    );
    expect(told(events)).toEqual([
      [2 * MINUTE, "finished", "needs-you"],
      [3 * MINUTE, "needs-you", "finished"],
    ]);
    expect(totals(events, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("a wait read again once the agent is back is a wait of its own, and the time closed counts for neither", async () => {
    const { events } = await play(
      [0, open("working")],
      [MINUTE, open("needs-you")],
      [2 * MINUTE, closed],
      [3 * HOUR, open("needs-you")],
      [3 * HOUR + 2_000, open("needs-you")],
    );
    expect(told(events)).toEqual([
      [MINUTE, "working", "needs-you"],
      [2 * MINUTE, "needs-you", "finished"],
      [3 * HOUR, "finished", "needs-you"],
    ]);
    expect(totals(events, 3 * HOUR + 5 * MINUTE, true)).toEqual([6 * MINUTE, 5 * MINUTE, 2]);
  });

  test("a wait first read as the agent opens begins there, and what follows goes on from what the log said", async () => {
    const { events } = await play(
      [0, closed],
      [MINUTE, open("needs-you")],
      [2 * MINUTE, closed],
      [3 * MINUTE, open("working")],
    );
    expect(told(events)).toEqual([
      [MINUTE, "finished", "needs-you"],
      [2 * MINUTE, "needs-you", "finished"],
      [3 * MINUTE, "finished", "working"],
    ]);
    expect(totals(events, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("a way that only reads a waiting session differently ends no wait", async () => {
    const { events } = await play(
      [0, open("working")],
      [MINUTE, open("needs-you")],
      [2 * MINUTE, { ...open("working"), basis: "fallback" }],
      [3 * MINUTE, open("needs-you")],
    );
    expect(told(events)).toEqual([[MINUTE, "working", "needs-you"]]);
    expect(totals(events, 4 * MINUTE, true)).toEqual([3 * MINUTE, 3 * MINUTE, 1]);
  });
});

describe("a wait whose session leaves every listing", () => {
  const SECOND = 1_000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const asking = makeSession({ id: "claude-code:a", name: "demo-a", status: "needs-you" });
  const moved: Session = { ...asking, status: "working" };
  const main = (...sessions: Session[]): AdapterResult => ({
    ...result(sessions),
    basis: "main",
  });
  const fallback = (...sessions: Session[]): AdapterResult => ({
    ...result(sessions),
    basis: "fallback",
  });

  /** What outlasts one run of Agent Lookout, as the history keeps it. */
  function kept() {
    return {
      events: createEventStore(),
      sightings: [] as WaitSighting[],
      runStarts: [] as number[],
    };
  }

  /** One run of Agent Lookout over what was kept, taking one answer at each moment, in time order. */
  async function run(history: ReturnType<typeof kept>, ...steps: [number, AdapterResult][]) {
    const { adapter } = scriptedAdapter(...steps.map(([, answer]) => answer));
    vi.setSystemTime(T0 + (steps[0] as [number, AdapterResult])[0]);
    const poller = createPoller({
      adapters: [adapter],
      events: history.events,
      history: createHistoryStore(),
      onSightings: (sightings) => history.sightings.push(...sightings),
    });
    const held = history.events.list();
    poller.resume([...unendedWaits(held), ...held], history.sightings);
    history.runStarts.push(poller.startedAt);
    for (const [after] of steps) {
      vi.setSystemTime(T0 + after);
      await poller.pollOnce();
    }
  }

  /** What the log says of a session, by when, oldest first. */
  const told = ({ events }: ReturnType<typeof kept>, id = asking.id) =>
    [...events.list()]
      .filter((event) => event.sessionId === id)
      .sort((a, b) => a.at - b.at)
      .map((event) => [event.at - T0, event.kind, event.from, event.to]);

  /** What the waits add up to at a moment: every moment since the first poll is measured, unless `measured` says. */
  function totals(
    history: ReturnType<typeof kept>,
    now: number,
    waiting: boolean,
    measured = [{ from: T0, to: T0 + now }],
  ) {
    const { sevenDays } = waitTotals({
      events: history.events.list(),
      measured,
      sightings: history.sightings,
      runStarts: history.runStarts,
      waitingNow: waiting ? [{ id: asking.id, name: asking.name }] : [],
      since: T0,
      now: T0 + now,
    });
    return [sevenDays.waitedMs, sevenDays.openMs, sevenDays.waits];
  }

  /** Polls that see a wait begin at a minute, stand to two, and lose it at three. */
  const lost: [number, AdapterResult][] = [
    [0, main(moved)],
    [MINUTE, main(asking)],
    [2 * MINUTE, main(asking)],
    [3 * MINUTE, fallback()],
  ];
  const began = [MINUTE, "status-changed", "working", "needs-you"];

  test("stops counting at the last poll that listed it, however long the fallback lasts, and the log says nothing", async () => {
    const history = kept();
    await run(history, ...lost, [8 * HOUR, fallback()]);
    expect(told(history)).toEqual([began]);
    expect(totals(history, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
    expect(totals(history, 9 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("what is kept of it says where it was lost, and nothing of what it was asking", async () => {
    const history = kept();
    const saying: Session = { ...asking, waitingText: "Run: npm test" };
    await run(history, [0, main(moved)], [MINUTE, main(saying)], [2 * MINUTE, fallback()]);
    expect(history.sightings).toEqual([
      { sessionId: asking.id, sessionName: "demo-a", at: T0 + MINUTE, way: "main" },
      {
        sessionId: asking.id,
        sessionName: "demo-a",
        at: T0 + 2 * MINUTE,
        way: "main",
        lastSeen: T0 + MINUTE,
      },
    ]);
  });

  test("seen waiting when the main way is back, it is one wait, and the time out of sight counts", async () => {
    const history = kept();
    await run(history, ...lost, [3 * HOUR, fallback()], [4 * HOUR, main(asking)]);
    expect(told(history)).toEqual([began]);
    expect(totals(history, 4 * HOUR + 5 * MINUTE, true)).toEqual([
      4 * HOUR + 4 * MINUTE,
      4 * HOUR + 4 * MINUTE,
      1,
    ]);
  });

  test("seen answered when the main way is back, the log says so then, and the wait counts up to the last poll that listed it", async () => {
    const history = kept();
    await run(history, ...lost, [3 * HOUR, fallback()], [4 * HOUR, main(moved)]);
    expect(told(history)).toEqual([began, [4 * HOUR, "status-changed", "needs-you", "working"]]);
    expect(totals(history, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("gone when the main way is back, the log says it ended then, and the wait counts up to the last poll that listed it", async () => {
    const history = kept();
    await run(history, ...lost, [3 * HOUR, fallback()], [4 * HOUR, main()]);
    expect(told(history)).toEqual([began, [4 * HOUR, "ended", "needs-you", undefined]]);
    expect(totals(history, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("listed as finished by the fallback, it ends there, and the time out of sight counts for nothing", async () => {
    const history = kept();
    const closed: Session = { ...asking, status: "finished" };
    await run(history, ...lost, [HOUR, fallback(closed)], [2 * HOUR, fallback(closed)]);
    expect(told(history)).toEqual([began, [HOUR, "status-changed", "needs-you", "finished"]]);
    expect(totals(history, 8 * HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("listed again by the fallback, still waiting, it carries on, and a later end is counted to the end", async () => {
    const history = kept();
    await run(
      history,
      ...lost,
      [HOUR, fallback(asking)],
      [2 * HOUR, main(asking)],
      [3 * HOUR, main(moved)],
    );
    expect(told(history)).toEqual([began, [3 * HOUR, "status-changed", "needs-you", "working"]]);
    expect(totals(history, 8 * HOUR, false)).toEqual([3 * HOUR - MINUTE, 0, 1]);
  });

  test("a wait of its own after one that was lost is counted whole", async () => {
    const history = kept();
    await run(
      history,
      ...lost,
      [HOUR, main(moved)],
      [2 * HOUR, main(asking)],
      [3 * HOUR, main(moved)],
    );
    expect(totals(history, 8 * HOUR, false)).toEqual([HOUR + MINUTE, 0, 2]);
  });

  test("a session a fallback's first poll lists as moved on goes on counting as it did", async () => {
    const history = kept();
    await run(history, ...lost.slice(0, 3), [3 * MINUTE, fallback(moved)]);
    expect(told(history)).toEqual([began]);
    expect(totals(history, HOUR, false)).toEqual([HOUR - MINUTE, 0, 1]);
    expect(history.sightings.filter((sighting) => sighting.lastSeen !== undefined)).toEqual([]);
  });

  test("the way that last listed a session no longer listing it is an end, whichever way that is", async () => {
    const history = kept();
    await run(
      history,
      ...lost.slice(0, 3),
      [3 * MINUTE, fallback(moved)],
      [4 * MINUTE, fallback()],
    );
    expect(told(history)).toEqual([began, [4 * MINUTE, "ended", "needs-you", undefined]]);
    expect(totals(history, HOUR, false)).toEqual([3 * MINUTE, 0, 1]);
  });

  test("an older poll read the way in use that listed the session does not make its absence an end", async () => {
    const history = kept();
    await run(
      history,
      [0, fallback(moved)],
      [MINUTE, main(moved)],
      [2 * MINUTE, main(asking)],
      [3 * MINUTE, main(asking)],
      [4 * MINUTE, fallback()],
      [HOUR, fallback()],
      [2 * HOUR, main(asking)],
    );
    expect(told(history)).toEqual([[2 * MINUTE, "status-changed", "working", "needs-you"]]);
    expect(totals(history, 2 * HOUR, true)).toEqual([
      2 * HOUR - 2 * MINUTE,
      2 * HOUR - 2 * MINUTE,
      1,
    ]);
  });

  test("a way whose own last poll had the session waiting does not end the wait by leaving it out, once another way has listed it since", async () => {
    const history = kept();
    await run(
      history,
      ...lost.slice(0, 3),
      [3 * MINUTE, fallback(asking)],
      [4 * MINUTE, fallback(asking)],
      [5 * MINUTE, main()],
    );
    expect(told(history)).toEqual([began]);
    expect(totals(history, HOUR, false)).toEqual([3 * MINUTE, 0, 1]);

    await run(history, [HOUR, fallback()]);
    expect(told(history)).toEqual([began, [HOUR, "ended", "needs-you", undefined]]);
    expect(totals(history, 2 * HOUR, false)).toEqual([3 * MINUTE, 0, 1]);
  });

  test("a way whose own last poll had the session waiting ends the wait by listing it moved on, though another way listed it since", async () => {
    const history = kept();
    await run(
      history,
      ...lost.slice(0, 3),
      [3 * MINUTE, fallback(asking)],
      [4 * MINUTE, main(moved)],
    );
    expect(told(history)).toEqual([began, [4 * MINUTE, "status-changed", "needs-you", "working"]]);
    expect(totals(history, HOUR, false)).toEqual([3 * MINUTE, 0, 1]);
  });

  test("an older poll that held the session waiting before this wait began does not end it by leaving it out", async () => {
    const history = kept();
    await run(
      history,
      [0, main(moved)],
      [SECOND, fallback(asking)],
      [MINUTE, main(moved)],
      [2 * MINUTE, main(asking)],
      [3 * MINUTE, main(asking)],
      [4 * MINUTE, fallback()],
      [HOUR, fallback()],
      [2 * HOUR, main(asking)],
    );
    expect(told(history)).toEqual([[2 * MINUTE, "status-changed", "working", "needs-you"]]);
    expect(totals(history, 2 * HOUR, true)).toEqual([
      2 * HOUR - 2 * MINUTE,
      2 * HOUR - 2 * MINUTE,
      1,
    ]);
  });

  test("a fallback's older poll that held the session waiting does not end a wait the main way lists as it leaves it out", async () => {
    const history = kept();
    await run(
      history,
      [0, fallback(asking)],
      [MINUTE, main(asking)],
      [2 * MINUTE, main(asking)],
      [3 * MINUTE, fallback()],
      [4 * MINUTE, fallback()],
      [HOUR, main(asking)],
    );
    expect(told(history)).toEqual([]);
    expect(totals(history, HOUR, true)).toEqual([HOUR, HOUR, 1]);
  });

  describe("listed by a way that did not last list it", () => {
    /** Polls that see a wait begin at two minutes, with `older` the fallback's own last poll. */
    const lostAfter = (older: AdapterResult): [number, AdapterResult][] => [
      [0, older],
      [MINUTE, main(moved)],
      [2 * MINUTE, main(asking)],
      [3 * MINUTE, main(asking)],
    ];
    const idle: Session = { ...asking, status: "idle" };

    test.each([
      ["had not listed the session", fallback(), moved],
      ["held it idle", fallback(idle), moved],
      ["held it working", fallback(moved), idle],
    ])("a way whose own last poll %s moves it on by a status new to it", async (_, older, now) => {
      const history = kept();
      await run(history, ...lostAfter(older), [4 * MINUTE, fallback(now)]);
      expect(told(history).at(-1)).toEqual([4 * MINUTE, "status-changed", "needs-you", now.status]);
      expect(totals(history, HOUR, false)).toEqual([2 * MINUTE, 0, 1]);
    });

    test("a wait only a fallback saw ends when the main way lists the session moved on, and stops there", async () => {
      const history = kept();
      await run(
        history,
        [0, main(moved)],
        [MINUTE, fallback(moved)],
        [2 * MINUTE, fallback(asking)],
        [3 * MINUTE, fallback(asking)],
        [4 * MINUTE, main(idle)],
      );
      expect(told(history).at(-1)).toEqual([4 * MINUTE, "status-changed", "needs-you", "idle"]);
      expect(totals(history, HOUR, false)).toEqual([2 * MINUTE, 0, 1]);
    });

    test("a way that sees it fail ends it, from any older poll", async () => {
      const failed: Session = { ...asking, status: "failed" };
      const history = kept();
      await run(history, ...lostAfter(fallback()), [4 * MINUTE, fallback(failed)]);
      expect(told(history).at(-1)).toEqual([4 * MINUTE, "status-changed", "needs-you", "failed"]);

      const moving = kept();
      await run(moving, ...lostAfter(fallback(moved)), [4 * MINUTE, fallback(failed)]);
      expect(told(moving).at(-1)).toEqual([4 * MINUTE, "status-changed", "needs-you", "failed"]);
    });

    test("a way that lists it finished ends it, from any older poll", async () => {
      const finished: Session = { ...asking, status: "finished" };
      const history = kept();
      await run(history, ...lostAfter(fallback(moved)), [4 * MINUTE, fallback(finished)]);
      expect(told(history).at(-1)).toEqual([4 * MINUTE, "status-changed", "needs-you", "finished"]);
    });
  });

  test("a wait found as Agent Lookout started counts for the time it was listed, and keeps its name", async () => {
    const history = kept();
    await run(history, [0, main(asking)], [MINUTE, main(asking)], [2 * MINUTE, fallback()]);
    expect(told(history)).toEqual([]);
    expect(totals(history, HOUR, false)).toEqual([MINUTE, 0, 1]);
  });

  test("a source that goes away is out of sight as any other way, and counts again if it comes back to the same wait", async () => {
    const history = kept();
    const gone: AdapterResult = result([], "unavailable");
    await run(history, ...lost.slice(0, 3), [3 * MINUTE, gone], [HOUR, gone]);
    expect(told(history)).toEqual([began]);
    expect(totals(history, HOUR, false)).toEqual([MINUTE, 0, 1]);

    const back = kept();
    await run(back, ...lost.slice(0, 3), [3 * MINUTE, gone], [HOUR, main(asking)]);
    expect(told(back)).toEqual([began]);
    expect(totals(back, HOUR, true)).toEqual([HOUR - MINUTE, HOUR - MINUTE, 1]);
  });

  test("a part of a source that is not read on a poll loses sight of its wait, and finds it again", async () => {
    const part = (read: boolean, ...sessions: Session[]): AdapterResult => {
      const answer = result(sessions);
      return read
        ? { ...answer, health: { ...answer.health, parts: { "claude-code:": "database" } } }
        : answer;
    };
    const history = kept();
    await run(
      history,
      [0, part(true, moved)],
      [MINUTE, part(true, asking)],
      [2 * MINUTE, part(true, asking)],
      [3 * MINUTE, part(false)],
    );
    expect(totals(history, HOUR, false)).toEqual([MINUTE, 0, 1]);
    expect(told(history)).toEqual([began]);

    const back = kept();
    await run(
      back,
      [0, part(true, moved)],
      [MINUTE, part(true, asking)],
      [2 * MINUTE, part(false)],
      [3 * MINUTE, part(true, asking)],
    );
    expect(told(back)).toEqual([began]);
    expect(totals(back, HOUR, true)).toEqual([HOUR - MINUTE, HOUR - MINUTE, 1]);
  });

  test("a wait out of sight for longer than the waits are kept is let go", async () => {
    const history = kept();
    const other: AdapterResult = { ...result([]), basis: "other" };
    await run(
      history,
      [0, fallback(moved)],
      [SECOND, main(moved)],
      [MINUTE, main(asking)],
      [2 * MINUTE, other],
      [10 * DAY, other],
      [10 * DAY + 2 * SECOND, fallback()],
    );
    expect(told(history).at(-1)).toEqual([10 * DAY + 2 * SECOND, "ended", "needs-you", undefined]);
  });

  test("seen waiting again by the way that lost it, a later end counts up to that end", async () => {
    const history = kept();
    await run(history, ...lost, [HOUR, main(asking)], [2 * HOUR, main(moved)]);
    expect(told(history)).toEqual([began, [2 * HOUR, "status-changed", "needs-you", "working"]]);
    expect(totals(history, 8 * HOUR, false)).toEqual([2 * HOUR - MINUTE, 0, 1]);
  });

  test("is written down once, however many polls leave it out", async () => {
    const history = kept();
    await run(history, ...lost, [HOUR, fallback()], [2 * HOUR, fallback()]);
    expect(history.sightings.filter((sighting) => sighting.lastSeen !== undefined)).toHaveLength(1);
  });

  test("a wait that ended is followed no more: the session leaving later is an end like any other, and no sighting", async () => {
    const history = kept();
    await run(
      history,
      [0, fallback(moved)],
      [MINUTE, main(moved)],
      [2 * MINUTE, main(asking)],
      [3 * MINUTE, main(moved)],
      [4 * MINUTE, fallback()],
    );
    expect(told(history).at(-1)).toEqual([4 * MINUTE, "ended", "working", undefined]);
    expect(history.sightings.filter((sighting) => sighting.lastSeen !== undefined)).toEqual([]);
  });

  test("a poll that fails says nothing of a wait, so a later end counts up to that end", async () => {
    const history = kept();
    const failed = result([], "error");
    await run(history, ...lost.slice(0, 3), [3 * MINUTE, failed], [HOUR, main(moved)]);
    expect(history.sightings.filter((sighting) => sighting.lastSeen !== undefined)).toEqual([]);
    expect(totals(history, 2 * HOUR, false)).toEqual([HOUR - MINUTE, 0, 1]);
  });

  describe("the move out of it", () => {
    /** The newest event of the session, as the log holds it. */
    const newest = ({ events }: ReturnType<typeof kept>) => events.list()[0];

    test("seen answered or gone, says the last poll that listed the session", async () => {
      for (const end of [main(moved), main()]) {
        const history = kept();
        await run(history, ...lost, [HOUR, end]);
        expect(newest(history)).toMatchObject({ at: T0 + HOUR, lastSeen: T0 + 2 * MINUTE });
      }
    });

    test("listed as finished by the fallback, says it too", async () => {
      const history = kept();
      await run(history, ...lost, [HOUR, fallback({ ...asking, status: "finished" })]);
      expect(newest(history)).toMatchObject({ to: "finished", lastSeen: T0 + 2 * MINUTE });
    });

    test("does not say it of a session seen since, or one never lost", async () => {
      const again = kept();
      await run(again, ...lost, [HOUR, main(asking)], [2 * HOUR, main(moved)]);
      expect(newest(again)).not.toHaveProperty("lastSeen");

      const never = kept();
      await run(never, ...lost.slice(0, 3), [HOUR, main(moved)]);
      expect(newest(never)).not.toHaveProperty("lastSeen");

      const gone = kept();
      await run(gone, ...lost.slice(0, 3), [HOUR, main()]);
      expect(newest(gone)).not.toHaveProperty("lastSeen");
    });

    test("does not say it of a wait that begins", async () => {
      const history = kept();
      await run(history, ...lost, [HOUR, main(moved)], [2 * HOUR, main(asking)]);
      expect(newest(history)).toMatchObject({ to: "needs-you" });
      expect(newest(history)).not.toHaveProperty("lastSeen");
    });
  });

  describe("listed waiting again with a status time of its own", () => {
    const gone: AdapterResult = result([], "unavailable");
    const since = (statusSince: number | null): Session => ({ ...asking, statusSince });
    /** A wait from one minute to two, lost at three as its source stops answering, and back at 7h01. */
    const back = (session: Session): [number, AdapterResult][] => [
      ...lost.slice(0, 3),
      [3 * MINUTE, gone],
      [7 * HOUR + MINUTE, main(session)],
    ];

    test("later than the last poll that listed it, the wait lost ended unseen, and a new one counts from that time", async () => {
      const history = kept();
      await run(history, ...back(since(T0 + 7 * HOUR)));
      expect(told(history)).toEqual([began]);
      expect(history.sightings.at(-1)).toMatchObject({ began: T0 + 7 * HOUR });
      expect(totals(history, 7 * HOUR + MINUTE, true)).toEqual([2 * MINUTE, MINUTE, 2]);
    });

    test("no later than that poll, or with none, it is one wait", async () => {
      for (const statusSince of [T0 + MINUTE, T0 + 2 * MINUTE, null]) {
        const history = kept();
        await run(history, ...back(since(statusSince)));
        expect(told(history)).toEqual([began]);
        expect(history.sightings.at(-1)).not.toHaveProperty("began");
        const waited = 7 * HOUR;
        expect(totals(history, 7 * HOUR + MINUTE, true)).toEqual([waited, waited, 1]);
      }
    });

    test("in a session never lost, a later status time cuts nothing", async () => {
      const history = kept();
      await run(history, ...lost.slice(0, 3), [HOUR, main(since(T0 + HOUR))]);
      expect(history.sightings.some((sighting) => sighting.began !== undefined)).toBe(false);
    });
  });

  describe("across a restart in the middle", () => {
    /** The first run: lost at three minutes, and stopped at an hour. */
    async function stopped(history: ReturnType<typeof kept>) {
      await run(history, ...lost, [HOUR, fallback()]);
    }
    /** Measured all of the first run and, from two hours on, the second. */
    const measured = (now: number) => [
      { from: T0, to: T0 + HOUR },
      { from: T0 + 2 * HOUR, to: T0 + now },
    ];

    test("the fallback still in use says nothing, and the count stays where it stopped", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()], [8 * HOUR, fallback()]);
      expect(told(history)).toEqual([began]);
      expect(totals(history, 8 * HOUR, false, measured(8 * HOUR))).toEqual([MINUTE, 0, 1]);
    });

    test("seen waiting when the main way is back, it is one wait, with what was measured of the time out of sight", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()], [3 * HOUR, main(asking)]);
      expect(told(history)).toEqual([began]);
      const waited = HOUR - MINUTE + HOUR + 5 * MINUTE;
      const now = 3 * HOUR + 5 * MINUTE;
      expect(totals(history, now, true, measured(now))).toEqual([waited, waited, 1]);
    });

    test("seen waiting when the main way is back, a later end counts up to that end", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()], [3 * HOUR, main(asking)], [4 * HOUR, main(moved)]);
      expect(told(history)).toEqual([began, [4 * HOUR, "status-changed", "needs-you", "working"]]);
      const waited = HOUR - MINUTE + 2 * HOUR;
      expect(totals(history, 5 * HOUR, false, measured(5 * HOUR))).toEqual([waited, 0, 1]);
    });

    test("seen answered when the main way is back, the log says so then, and the count stays where it stopped", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()], [3 * HOUR, main(moved)]);
      expect(told(history)).toEqual([began, [3 * HOUR, "status-changed", "needs-you", "working"]]);
      expect(totals(history, 4 * HOUR, false, measured(4 * HOUR))).toEqual([MINUTE, 0, 1]);
    });

    test("gone when the main way is back, the log says it ended then, and the count stays where it stopped", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()], [3 * HOUR, main()]);
      expect(told(history)).toEqual([began, [3 * HOUR, "ended", "needs-you", undefined]]);
      expect(totals(history, 4 * HOUR, false, measured(4 * HOUR))).toEqual([MINUTE, 0, 1]);
    });

    test("the main way read first says what it would have said", async () => {
      const gone = kept();
      await stopped(gone);
      await run(gone, [2 * HOUR, main()]);
      expect(told(gone)).toEqual([began, [2 * HOUR, "ended", "needs-you", undefined]]);
      expect(totals(gone, 3 * HOUR, false, measured(3 * HOUR))).toEqual([MINUTE, 0, 1]);

      const waiting = kept();
      await stopped(waiting);
      await run(waiting, [2 * HOUR, main(asking)]);
      expect(told(waiting)).toEqual([began]);
      expect(totals(waiting, 3 * HOUR, true, measured(3 * HOUR))).toEqual([
        2 * HOUR - MINUTE,
        2 * HOUR - MINUTE,
        1,
      ]);

      const answered = kept();
      await stopped(answered);
      await run(answered, [2 * HOUR, main(moved)]);
      expect(told(answered)).toEqual([began, [2 * HOUR, "status-changed", "needs-you", "working"]]);
    });

    test("the move out of the wait says the last poll that listed the session, whichever way ends it", async () => {
      const first = kept();
      await stopped(first);
      await run(first, [2 * HOUR, main()]);
      expect(first.events.list()[0]).toMatchObject({ kind: "ended", lastSeen: T0 + 2 * MINUTE });

      const later = kept();
      await stopped(later);
      await run(later, [2 * HOUR, fallback()], [3 * HOUR, main(moved)]);
      expect(later.events.list()[0]).toMatchObject({ to: "working", lastSeen: T0 + 2 * MINUTE });
    });

    test("listed waiting with a status time later than the last poll that listed it, a new wait counts from that time", async () => {
      const history = kept();
      await stopped(history);
      const statusSince = T0 + 2 * HOUR + MINUTE;
      await run(
        history,
        [2 * HOUR, fallback()],
        [2 * HOUR + 2 * MINUTE, main({ ...asking, statusSince })],
      );
      expect(told(history)).toEqual([began]);
      const now = 2 * HOUR + 3 * MINUTE;
      expect(totals(history, now, true, measured(now))).toEqual([3 * MINUTE, 2 * MINUTE, 2]);

      const first = kept();
      await stopped(first);
      await run(first, [2 * HOUR, main({ ...asking, statusSince: T0 + 90 * MINUTE })]);
      expect(told(first)).toEqual([began]);
      expect(first.sightings.at(-1)).toMatchObject({ began: T0 + 90 * MINUTE });
    });

    test.each([
      ["moved on", moved],
      ["failed", { ...asking, status: "failed" } as Session],
    ])(
      "listed %s by another way on the first poll of a run, it is compared with the history",
      async (_, now) => {
        const history = kept();
        await stopped(history);
        await run(history, [2 * HOUR, fallback(now)]);
        expect(told(history)).toEqual([
          began,
          [2 * HOUR, "status-changed", "needs-you", now.status],
        ]);
      },
    );

    test("listed finished by a way that never saw the wait, on the first poll of a run, it ends there", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback({ ...asking, status: "finished" })]);
      expect(told(history)).toEqual([began, [2 * HOUR, "status-changed", "needs-you", "finished"]]);
    });

    test("listed last by the fallback as Agent Lookout stopped, its wait is the fallback's to end", async () => {
      const history = kept();
      await run(history, ...lost.slice(0, 3), [3 * MINUTE, fallback(asking)]);
      await run(history, [HOUR, main()]);
      expect(told(history)).toEqual([began]);
      await run(history, [2 * HOUR, fallback()]);
      expect(told(history)).toEqual([began, [2 * HOUR, "ended", "needs-you", undefined]]);
    });

    test("the main way's first poll compares only the waits it last listed", async () => {
      const history = kept();
      const other = makeSession({ id: "claude-code:b", name: "demo-b", status: "working" });
      await stopped(history);
      await run(history, [2 * HOUR, fallback()], [3 * HOUR, main(asking, other)]);
      expect(told(history, other.id)).toEqual([]);
      expect(told(history)).toEqual([began]);
    });

    test("a second restart while it is out of sight changes nothing", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()]);
      await run(history, [3 * HOUR, fallback()], [4 * HOUR, main()]);
      expect(told(history)).toEqual([began, [4 * HOUR, "ended", "needs-you", undefined]]);
      expect(totals(history, 5 * HOUR, false)).toEqual([MINUTE, 0, 1]);
    });

    test("a second restart writes nothing new while the session stays out of sight", async () => {
      const history = kept();
      await stopped(history);
      await run(history, [2 * HOUR, fallback()]);
      const written = history.sightings.length;
      await run(history, [3 * HOUR, fallback()]);
      expect(history.sightings).toHaveLength(written);
    });

    test("a wait listed as Agent Lookout stopped stops where this run began, though the first good poll came later", async () => {
      const history = kept();
      await run(history, ...lost.slice(0, 3));
      await run(history, [HOUR, result([], "error")], [2 * HOUR, fallback()]);
      expect(history.sightings.at(-1)?.lastSeen).toBe(T0 + HOUR);
    });

    test("a wait listed as Agent Lookout stopped is not taken to have ended by a fallback that leaves it out", async () => {
      const history = kept();
      await run(history, ...lost.slice(0, 3));
      await run(history, [HOUR, fallback()], [2 * HOUR, fallback()]);
      expect(told(history)).toEqual([began]);
      await run(history, [3 * HOUR, fallback()]);
      const measured = [
        { from: T0, to: T0 + 2 * MINUTE },
        { from: T0 + HOUR, to: T0 + 2 * HOUR },
        { from: T0 + 3 * HOUR, to: T0 + 4 * HOUR },
      ];
      // Neither run since saw it, so neither counts.
      expect(totals(history, 4 * HOUR, false, measured)).toEqual([MINUTE, 0, 1]);

      await run(history, [5 * HOUR, main()]);
      expect(told(history)).toEqual([began, [5 * HOUR, "ended", "needs-you", undefined]]);
    });

    test("a sighting of an earlier wait says nothing of a later one the history has none for", async () => {
      const history = kept();
      await run(history, ...lost, [HOUR, main(moved)], [2 * HOUR, main(asking)]);
      history.sightings = history.sightings.filter((sighting) => sighting.at < T0 + HOUR);
      await run(history, [3 * HOUR, fallback()]);
      expect(told(history).at(-1)).toEqual([3 * HOUR, "ended", "needs-you", undefined]);
    });

    test("a history with nothing of how the wait was seen is read as before", async () => {
      const history = kept();
      await run(history, ...lost);
      history.sightings = [];
      await run(history, [HOUR, fallback()]);
      expect(told(history)).toEqual([began, [HOUR, "ended", "needs-you", undefined]]);
    });
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

describe("what a waiting session is asking", () => {
  test("is in the snapshot while the wait goes on, and in no event recorded for it", async () => {
    const id = "claude-code:00000000-0000-4000-8000-000000000002";
    const working = makeSession({ id, status: "working" });
    const asking = makeSession({
      id,
      status: "needs-you",
      waitingReason: "permission",
      waitingText: "Run: npm run deploy",
      statusSince: T0 + 2_000,
    });
    const answered = makeSession({ id, status: "working", statusSince: T0 + 4_000 });
    const { adapter } = scriptedAdapter(result([working]), result([asking]), result([answered]));
    const { poller, events, history } = setUp(adapter);

    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    const waiting = await poller.pollOnce();
    expect(waiting.sessions[0]?.waitingText).toBe("Run: npm run deploy");
    vi.setSystemTime(T0 + 4_000);
    const after = await poller.pollOnce();
    expect(after.sessions[0]).not.toHaveProperty("waitingText");

    const recorded = events.list();
    expect(recorded.map((event) => [event.kind, event.from, event.to])).toEqual([
      ["status-changed", "needs-you", "working"],
      ["status-changed", "working", "needs-you"],
    ]);
    for (const event of recorded) {
      expect(Object.keys(event)).not.toContain("waitingText");
      expect(JSON.stringify(event)).not.toContain("npm run deploy");
    }
    expect(JSON.stringify(history.list(Infinity, T0 + 4_000))).not.toContain("npm run deploy");
  });
});

describe("the time rules", () => {
  const HOUR = 60 * 60 * 1000;

  test("each snapshot carries the rules in force at its poll, asked again each time", async () => {
    const { adapter } = scriptedAdapter(result([]));
    let rules: TimeRules = DEFAULT_TIME_RULES;
    const poller = createPoller({
      adapters: [adapter],
      events: createEventStore(),
      history: createHistoryStore(),
      timeRules: () => rules,
    });
    expect((await poller.pollOnce()).timeRules).toBe(DEFAULT_TIME_RULES);
    rules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 5 } };
    expect((await poller.pollOnce()).timeRules).toBe(rules);
  });

  test("without them, the snapshot carries none, and is as it always was", async () => {
    const { adapter } = scriptedAdapter(result([]));
    const { poller } = setUp(adapter);
    const shot = await poller.pollOnce();
    expect(shot).not.toHaveProperty("timeRules");
    expect(shot).not.toHaveProperty("quiet");
  });

  test("with the idle rule on, a session idle that long is stale, in the snapshot and in the history's counts", async () => {
    const idleFor = (hours: number, n: number) =>
      makeSession({
        id: `claude-code:idle-${n}`,
        status: "idle",
        statusSince: T0 - hours * HOUR,
        stale: hours >= 24,
      });
    const sessions = [idleFor(3, 1), idleFor(30, 2), idleFor(1, 3)];
    const { adapter } = scriptedAdapter(result(sessions));
    const history = createHistoryStore();
    let rules: TimeRules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 2 } };
    const poller = createPoller({
      adapters: [adapter],
      events: createEventStore(),
      history,
      timeRules: () => rules,
    });

    const staleness = (shot: Awaited<ReturnType<typeof poller.pollOnce>>) =>
      Object.fromEntries(shot.sessions.map((session) => [session.id, session.stale]));
    expect(staleness(await poller.pollOnce())).toEqual({
      "claude-code:idle-1": true,
      "claude-code:idle-2": true,
      "claude-code:idle-3": false,
    });
    // A stale session is not counted as idle.
    expect(history.list(HOUR, T0).at(-1)).toMatchObject({ idle: 1, total: 3 });

    // A longer threshold than the day the adapters go by.
    rules = { ...DEFAULT_TIME_RULES, idle: { on: true, hours: 48 } };
    expect(staleness(await poller.pollOnce())).toEqual({
      "claude-code:idle-1": false,
      "claude-code:idle-2": false,
      "claude-code:idle-3": false,
    });

    // Off, the built-in day: the adapters' own answer, so each session is as it came.
    rules = DEFAULT_TIME_RULES;
    const shot = await poller.pollOnce();
    expect(staleness(shot)).toEqual({
      "claude-code:idle-1": false,
      "claude-code:idle-2": true,
      "claude-code:idle-3": false,
    });
    expect(shot.sessions.find((one) => one.id === "claude-code:idle-1")).toBe(sessions[0]);
  });

  test("with the rule off, stale is still worked out at the poll by the built-in day, whatever a source said", async () => {
    // As from another machine, whose own idle rule said otherwise.
    const said = [
      makeSession({ id: "claude-code:a", status: "idle", statusSince: T0 - 3 * HOUR, stale: true }),
      makeSession({
        id: "claude-code:b",
        status: "idle",
        statusSince: T0 - 30 * HOUR,
        stale: false,
      }),
    ];
    const { adapter } = scriptedAdapter(result(said));
    const poller = createPoller({
      adapters: [adapter],
      events: createEventStore(),
      history: createHistoryStore(),
      timeRules: () => DEFAULT_TIME_RULES,
    });
    const shot = await poller.pollOnce();
    expect(Object.fromEntries(shot.sessions.map((one) => [one.id, one.stale]))).toEqual({
      "claude-code:a": false,
      "claude-code:b": true,
    });
  });

  test("each snapshot says whether it was made in quiet hours, by the collector's own clock", async () => {
    const { adapter } = scriptedAdapter(result([]));
    const night = new Date(2026, 9, 5, 23, 0).getTime();
    vi.setSystemTime(night);
    let rules: TimeRules = {
      ...DEFAULT_TIME_RULES,
      quietHours: { ...DEFAULT_TIME_RULES.quietHours, on: true, from: "22:00", to: "08:00" },
    };
    const poller = createPoller({
      adapters: [adapter],
      events: createEventStore(),
      history: createHistoryStore(),
      timeRules: () => rules,
    });
    expect((await poller.pollOnce()).quiet).toBe(true);
    rules = DEFAULT_TIME_RULES;
    expect((await poller.pollOnce()).quiet).toBe(false);
  });
});

describe("a wait whose permission request Agent Lookout answered", () => {
  const id = "claude-code:00000000-0000-4000-8000-000000000003";
  const working = makeSession({ id, name: "demo-a", status: "working", statusSince: T0 - 60_000 });
  const asking = makeSession({
    id,
    name: "demo-a",
    status: "needs-you",
    waitingReason: "permission",
    statusSince: T0 + 1_000,
  });
  const goesOn = makeSession({ id, name: "demo-a", status: "working", statusSince: T0 + 5_000 });

  /** A poller told which sessions are in a wait that was answered, asked once for each poll. */
  function withAnswers(adapter: Adapter, answered: () => ReadonlySet<string>) {
    const events = createEventStore();
    const history = createHistoryStore();
    const asked: Pick<SessionsSnapshot, "sources" | "sessions">[] = [];
    const poller = createPoller({
      adapters: [adapter],
      events,
      history,
      answered: (snapshot) => {
        asked.push(snapshot);
        return answered();
      },
    });
    return { poller, events, history, asked };
  }

  test("is marked in the snapshot, and one a rule answered before any poll saw it never begins in the event log", async () => {
    const { adapter } = scriptedAdapter(
      result([working]),
      result([asking]),
      result([asking]),
      result([goesOn]),
    );
    let answered = new Set<string>();
    const { poller, events, history, asked } = withAnswers(adapter, () => answered);
    await poller.pollOnce();
    answered = new Set([id]);
    vi.setSystemTime(T0 + 2_000);
    const read = await poller.pollOnce();
    expect(read.sessions[0]).toMatchObject({ status: "needs-you", answered: true });
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    answered = new Set();
    vi.setSystemTime(T0 + 6_000);
    const after = await poller.pollOnce();
    expect(after.sessions[0]).not.toHaveProperty("answered");

    expect(events.list()).toEqual([]);
    // Nor is it in the history as needing you.
    expect(history.list(60_000, Date.now()).map((point) => point.needsYou)).toEqual([0, 0, 0, 0]);
    // Asked once for each poll, with what that poll read.
    expect(asked).toHaveLength(4);
    expect(asked[1]?.sessions.map((session) => session.status)).toEqual(["needs-you"]);
  });

  test("seen before it was answered, it ends in the log when its source says it moved on", async () => {
    const { adapter } = scriptedAdapter(
      result([working]),
      result([asking]),
      result([asking]),
      result([goesOn]),
    );
    let answered = new Set<string>();
    const { poller, events } = withAnswers(adapter, () => answered);
    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    answered = new Set([id]);
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    answered = new Set();
    vi.setSystemTime(T0 + 6_000);
    await poller.pollOnce();
    expect(events.list().map((event) => [event.at - T0, event.from, event.to])).toEqual([
      [6_000, "needs-you", "working"],
      [2_000, "working", "needs-you"],
    ]);
  });

  test("a session that first appears in such a wait appears in the log once it has moved on", async () => {
    const { adapter } = scriptedAdapter(result([]), result([asking]), result([goesOn]));
    let answered = new Set<string>();
    const { poller, events } = withAnswers(adapter, () => answered);
    await poller.pollOnce();
    answered = new Set([id]);
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(events.list()).toEqual([]);
    answered = new Set();
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();
    expect(events.list().map((event) => [event.kind, event.to])).toEqual([["appeared", "working"]]);
  });

  test("a wait that was answered is no wait to the log, though a way last said the session finished", async () => {
    const { adapter } = scriptedAdapter(
      { ...result([{ ...goesOn, status: "finished" }]), basis: "closed" },
      { ...result([asking]), basis: "open" },
    );
    const { poller, events } = withAnswers(adapter, () => new Set([id]));
    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    await poller.pollOnce();
    expect(events.list()).toEqual([]);
  });

  test("a session on another machine that its own Agent Lookout marked answered is taken as answered here", async () => {
    const there = (session: Session): Session => ({
      ...session,
      id: `remote:devbox:${session.id}`,
      source: "remote:devbox",
      machine: "devbox",
    });
    const { adapter } = scriptedAdapter(
      result([there(working)]),
      result([there({ ...asking, answered: true })]),
      result([there(goesOn)]),
    );
    // Nothing is answered here: the mark is the other machine's word alone.
    const { poller, events, history } = withAnswers(adapter, () => new Set());
    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    const read = await poller.pollOnce();
    expect(read.sessions[0]).toMatchObject({ status: "needs-you", answered: true });
    vi.setSystemTime(T0 + 4_000);
    await poller.pollOnce();

    expect(events.list()).toEqual([]);
    expect(history.list(60_000, Date.now()).map((point) => point.needsYou)).toEqual([0, 0, 0]);
  });

  test("an answer that cannot be asked for marks nothing, and the poll goes on", async () => {
    const { adapter } = scriptedAdapter(result([working]), result([asking]));
    const { poller, events } = withAnswers(adapter, () => {
      throw new Error("broken");
    });
    await poller.pollOnce();
    vi.setSystemTime(T0 + 2_000);
    const read = await poller.pollOnce();
    expect(read.sessions[0]).not.toHaveProperty("answered");
    expect(events.list().map((event) => event.to)).toEqual(["needs-you"]);
  });
});
