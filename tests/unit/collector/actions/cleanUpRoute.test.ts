import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import { MAX_CLEAN_UP_SESSIONS, type CleanUpResponse } from "@core/api";
import type { Session, SessionEvent, SessionsSnapshot } from "@core/sessions/session";
import {
  cleanUpEntriesIn,
  createCleanUpRoute,
  MAX_CLEAN_UP_BODY_BYTES,
} from "@collector/actions/cleanUpRoute";
import {
  createActionLimiter,
  type Acted,
  type Confirmed,
  type Stopper,
} from "@collector/actions/stopSession";
import type { StopTarget } from "@collector/actions/stopTargets";
import type { RegistryEntry } from "@collector/adapters/claude-code/registry";
import { makeSession } from "@tests/fixtures/session";

const HOUR = 60 * 60 * 1000;
/** When each session went idle, as the page shows it: a little over a day before now. */
const IDLE_SINCE = 1_700_000_000_000;
const NOW = IDLE_SINCE + 25 * HOUR;

const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "clean-up",
  "content-type": "application/json",
};

const idOf = (n: number) => `claude-code:00000000-0000-4000-8000-00000000000${n}`;

/** A request with a body, as Node hands one over. A header set to undefined is not sent. */
function request(
  body: unknown,
  headers: Record<string, string | undefined> = {},
  method = "POST",
): IncomingMessage {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const stream = Readable.from(text === "" ? [] : [Buffer.from(text)]);
  const all = Object.fromEntries(
    Object.entries({
      ...FROM_THE_PAGE,
      "content-length": String(Buffer.byteLength(text)),
      ...headers,
    }).filter(([, value]) => value !== undefined),
  );
  return Object.assign(stream, { method, headers: all }) as unknown as IncomingMessage;
}

const asked = (...numbers: number[]) => ({
  sessions: numbers.map((n) => ({ sessionId: idOf(n), statusSince: IDLE_SINCE })),
});

/** A session left running: idle for a day and an hour, alive, and one the collector can stop. */
function leftRunning(n: number, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: idOf(n),
    name: `demo-${n}`,
    status: "idle",
    statusSince: IDLE_SINCE,
    stale: true,
    pid: 4240 + n,
    alive: true,
    stop: { how: "signal" },
    ...overrides,
  });
}

function targetOf(n: number, how: "signal" | "background" = "signal"): StopTarget {
  const found = {
    sessionId: idOf(n).slice("claude-code:".length),
    pid: 4240 + n,
    procStart: "Tue Nov 14 22:13:20 2023",
    registryFile: `/Users/example/.claude/sessions/${4240 + n}.json`,
  };
  return how === "signal" ? { ...found, how } : { ...found, how, jobId: `job-000${n}` };
}

/** What the registry file of session `n` says now, read again. */
type Fresh = Partial<RegistryEntry> | { refused: Exclude<Confirmed, { ok: true }>["reason"] };

function routeOver(
  sessions: Session[],
  fresh: Record<number, Fresh> = {},
  options: {
    acted?: Record<number, Acted>;
    running?: number[];
    background?: number[];
    staleAfterMs?: number;
  } = {},
) {
  const snapshot = (): SessionsSnapshot => ({ generatedAt: 1, sources: [], sessions });
  const poller = { getSnapshot: vi.fn(snapshot), pollOnce: vi.fn(async () => snapshot()) };
  const added: SessionEvent[] = [];
  const events = { add: vi.fn((more: readonly SessionEvent[]) => added.push(...more)) };
  const numberOf = (target: StopTarget) => target.pid - 4240;
  const targets = {
    targetOf: vi.fn((id: string) => {
      const n = Number(id.at(-1));
      const session = sessions.find((one) => one.id === id);
      if (!session?.stop) return undefined;
      return targetOf(n, options.background?.includes(n) ? "background" : "signal");
    }),
    askFeedSoon: vi.fn(),
  };
  const stopper: Stopper = {
    confirm: vi.fn(async (target: StopTarget): Promise<Confirmed> => {
      const said = fresh[numberOf(target)] ?? {};
      if ("refused" in said) return { ok: false, reason: said.refused };
      return {
        ok: true,
        entry: { pid: target.pid, status: "idle", statusUpdatedAt: IDLE_SINCE, ...said },
      };
    }),
    act: vi.fn(
      async (target: StopTarget) =>
        options.acted?.[numberOf(target)] ??
        (target.how === "background" ? ("stopped" as const) : ("signalled" as const)),
    ),
    waitForEnd: vi.fn(
      async (pids: readonly number[]) =>
        new Set(pids.filter((pid) => options.running?.includes(pid - 4240))),
    ),
    now: () => NOW,
  };
  const route = createCleanUpRoute({
    poller,
    events,
    targets,
    stopper,
    limiter: createActionLimiter(() => NOW),
    ...(options.staleAfterMs !== undefined && {
      staleAfterMs: () => options.staleAfterMs as number,
    }),
  });
  const outcomes = async (body: unknown) => {
    const answer = await route(request(body));
    expect(answer.status).toBe(200);
    return Object.fromEntries(
      (answer.body as CleanUpResponse).results.map((result) => [result.sessionId, result.outcome]),
    );
  };
  return { route, outcomes, stopper, added, poller, targets };
}

describe("cleanUpEntriesIn", () => {
  test("reads the sessions from a body that names them and nothing else", () => {
    expect(cleanUpEntriesIn(JSON.stringify(asked(1, 2)))).toEqual(asked(1, 2).sessions);
    expect(cleanUpEntriesIn(` ${JSON.stringify(asked(1))}\n`)).toEqual(asked(1).sessions);
  });

  test(`takes up to ${MAX_CLEAN_UP_SESSIONS} sessions and no more`, () => {
    const many = (count: number) =>
      JSON.stringify({
        sessions: Array.from({ length: count }, (_, index) => ({
          sessionId: `claude-code:${index}`,
          statusSince: IDLE_SINCE,
        })),
      });
    expect(cleanUpEntriesIn(many(MAX_CLEAN_UP_SESSIONS))).toHaveLength(MAX_CLEAN_UP_SESSIONS);
    expect(cleanUpEntriesIn(many(MAX_CLEAN_UP_SESSIONS + 1))).toBeNull();
  });

  test.each([
    ["nothing", ""],
    ["not JSON", "sessions=claude-code:1"],
    ["a list", JSON.stringify(asked(1).sessions)],
    ["no sessions", JSON.stringify({ sessions: [] })],
    ["sessions that are not a list", JSON.stringify({ sessions: { sessionId: idOf(1) } })],
    ["more beside the sessions", JSON.stringify({ ...asked(1), force: true })],
    [
      "a signal beside a session",
      JSON.stringify({ sessions: [{ ...asked(1).sessions[0], signal: "SIGKILL" }] }),
    ],
    ["a session with no time", JSON.stringify({ sessions: [{ sessionId: idOf(1) }] })],
    [
      "a session named twice",
      JSON.stringify({ sessions: [...asked(1).sessions, ...asked(1).sessions] }),
    ],
    [
      "a time that is text",
      JSON.stringify({ sessions: [{ sessionId: idOf(1), statusSince: "1700000000000" }] }),
    ],
    [
      "a time that is not whole",
      JSON.stringify({ sessions: [{ sessionId: idOf(1), statusSince: 1.5 }] }),
    ],
    ["a time before 1970", JSON.stringify({ sessions: [{ sessionId: idOf(1), statusSince: -1 }] })],
    ["an empty id", JSON.stringify({ sessions: [{ sessionId: "", statusSince: IDLE_SINCE }] })],
    [
      "an id that is not text",
      JSON.stringify({ sessions: [{ sessionId: 7, statusSince: IDLE_SINCE }] }),
    ],
    [
      "a very long id",
      JSON.stringify({ sessions: [{ sessionId: "x".repeat(301), statusSince: IDLE_SINCE }] }),
    ],
  ])("a body that holds %s names nothing", (_what, body) => {
    expect(cleanUpEntriesIn(body)).toBeNull();
  });
});

describe("POST /api/sessions/clean-up", () => {
  test("ends each session still as the page showed it, says so for each, and keeps one event each", async () => {
    const { outcomes, stopper, added, poller } = routeOver([leftRunning(1), leftRunning(2)]);

    expect(await outcomes(asked(1, 2))).toEqual({ [idOf(1)]: "ended", [idOf(2)]: "ended" });
    expect(stopper.act).toHaveBeenCalledTimes(2);
    expect(stopper.waitForEnd).toHaveBeenCalledWith([4241, 4242]);
    expect(added.map((event) => [event.sessionId, event.kind, event.by])).toEqual([
      [idOf(1), "stopped", "agent-lookout"],
      [idOf(2), "stopped", "agent-lookout"],
    ]);
    expect(poller.pollOnce).toHaveBeenCalled();
  });

  test("a session that became active again is never ended, even once it is idle again", async () => {
    const { outcomes, stopper, added } = routeOver(
      [leftRunning(1), leftRunning(2), leftRunning(3)],
      {
        // Working now.
        1: { status: "busy", statusUpdatedAt: NOW - 1_000 },
        // Waiting for the person now.
        2: { status: "waiting", statusUpdatedAt: NOW - 1_000 },
        // Idle again, since a moment after the page drew its list.
        3: { status: "idle", statusUpdatedAt: IDLE_SINCE + 1 },
      },
    );

    expect(await outcomes(asked(1, 2, 3))).toEqual({
      [idOf(1)]: "became-active",
      [idOf(2)]: "became-active",
      [idOf(3)]: "became-active",
    });
    expect(stopper.act).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  test("a session claude agents says is working is never ended, though its registry file still says idle", async () => {
    // The list comes from `claude agents`, which knows of the work before the
    // registry file does: the file still says idle since that same moment.
    const { outcomes, stopper, added } = routeOver([
      leftRunning(1, { status: "working", statusSince: NOW - 1_000, stale: false }),
      leftRunning(2, { statusSince: IDLE_SINCE + 1 }),
      leftRunning(3, { status: "needs-you", stale: false }),
    ]);

    expect(await outcomes(asked(1, 2, 3))).toEqual({
      [idOf(1)]: "became-active",
      [idOf(2)]: "became-active",
      [idOf(3)]: "became-active",
    });
    expect(stopper.act).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  test("a session the collector's list does not yet call stale is left running", async () => {
    const { outcomes, stopper } = routeOver([leftRunning(1, { stale: false })]);
    expect(await outcomes(asked(1))).toEqual({ [idOf(1)]: "not-stale" });
    expect(stopper.act).not.toHaveBeenCalled();
  });

  test("a session the page sent with an idle under a day old is left running", async () => {
    const recent = NOW - 2 * HOUR;
    const { route, stopper } = routeOver([leftRunning(1, { statusSince: recent })], {
      1: { statusUpdatedAt: recent },
    });
    const answer = await route(
      request({ sessions: [{ sessionId: idOf(1), statusSince: recent }] }),
    );

    expect((answer.body as CleanUpResponse).results).toEqual([
      { sessionId: idOf(1), outcome: "not-stale" },
    ]);
    expect(stopper.act).not.toHaveBeenCalled();
  });

  test("with the idle rule on, a session idle as long as it says is ended, and one idle less is left running", async () => {
    const twoHours = NOW - 2 * HOUR;
    const sessions = [leftRunning(1, { statusSince: twoHours })];
    const body = { sessions: [{ sessionId: idOf(1), statusSince: twoHours }] };

    const after1Hour = routeOver(
      sessions,
      { 1: { statusUpdatedAt: twoHours } },
      { staleAfterMs: HOUR },
    );
    expect((await after1Hour.route(request(body))).body).toEqual({
      results: [{ sessionId: idOf(1), outcome: "ended" }],
    });

    const after3Hours = routeOver(
      sessions,
      { 1: { statusUpdatedAt: twoHours } },
      { staleAfterMs: 3 * HOUR },
    );
    expect((await after3Hours.route(request(body))).body).toEqual({
      results: [{ sessionId: idOf(1), outcome: "not-stale" }],
    });
    expect(after3Hours.stopper.act).not.toHaveBeenCalled();
  });

  test("a mixed batch says what became of each, in the order asked, and ends only those that pass", async () => {
    const { outcomes, stopper, added } = routeOver(
      [
        leftRunning(1),
        leftRunning(2),
        leftRunning(3, { stop: undefined }),
        leftRunning(4),
        leftRunning(5),
        leftRunning(6),
      ],
      {
        2: { status: "busy", statusUpdatedAt: NOW },
        4: { refused: "cannot-confirm" },
        5: { refused: "gone" },
      },
      { running: [6] },
    );

    expect(await outcomes(asked(1, 2, 3, 4, 5, 6, 7))).toEqual({
      [idOf(1)]: "ended",
      [idOf(2)]: "became-active",
      [idOf(3)]: "unsupported",
      [idOf(4)]: "cannot-confirm",
      [idOf(5)]: "gone",
      [idOf(6)]: "still-running",
      [idOf(7)]: "gone",
    });
    // A signal for each session that passed every check, and none for the others.
    expect(vi.mocked(stopper.act).mock.calls.map(([target]) => target.pid)).toEqual([4241, 4246]);
    expect(added.map((event) => event.sessionId)).toEqual([idOf(1)]);
  });

  test("a background job is stopped with its job, its process is waited for, and the command is asked for again", async () => {
    const { outcomes, stopper, targets, poller } = routeOver(
      [leftRunning(1, { stop: { how: "background" } })],
      {},
      // Still running after the wait: Claude Code has stopped the job all the same.
      { background: [1], running: [1] },
    );

    expect(await outcomes(asked(1))).toEqual({ [idOf(1)]: "ended" });
    expect(vi.mocked(stopper.act).mock.calls[0]?.[0]).toMatchObject({
      how: "background",
      jobId: "job-0001",
    });
    expect(stopper.waitForEnd).toHaveBeenCalledWith([4241]);
    // The sessions are read again only once the wait is over.
    expect(vi.mocked(stopper.waitForEnd).mock.invocationCallOrder[0]).toBeLessThan(
      poller.pollOnce.mock.invocationCallOrder[0] as number,
    );
    expect(targets.askFeedSoon).toHaveBeenCalledOnce();
  });

  test.each(["gone", "not-allowed", "unsupported", "failed"] as const)(
    "a stop that comes to %s says so for that session",
    async (acted) => {
      const { outcomes, added } = routeOver([leftRunning(1)], {}, { acted: { 1: acted } });
      expect(await outcomes(asked(1))).toEqual({ [idOf(1)]: acted });
      expect(added).toEqual([]);
    },
  );

  test("one clean-up at a time: one asked for while another runs is refused", async () => {
    const { route, stopper } = routeOver([leftRunning(1)]);
    let finish: () => void = () => {};
    vi.mocked(stopper.waitForEnd).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(new Set());
        }),
    );
    const first = route(request(asked(1)));
    await vi.waitFor(() => expect(stopper.waitForEnd).toHaveBeenCalled());

    const second = await route(request(asked(1)));
    expect(second).toMatchObject({ status: 429, body: { reason: "too-soon" } });

    finish();
    expect((await first).status).toBe(200);
  });

  test.each([
    ["a GET", {}, "GET", 405],
    ["no Origin", { origin: undefined }, "POST", 403],
    ["another site's Origin", { origin: "https://evil.example" }, "POST", 403],
    ["a cross-site request", { "sec-fetch-site": "cross-site" }, "POST", 403],
    ["the stop's action", { "x-agent-lookout-action": "stop" }, "POST", 403],
    ["no action", { "x-agent-lookout-action": undefined }, "POST", 403],
    ["a form", { "content-type": "text/plain" }, "POST", 415],
    [
      "a body said to be too large",
      { "content-length": String(MAX_CLEAN_UP_BODY_BYTES + 1) },
      "POST",
      413,
    ],
  ] as const)(
    "a request with %s is refused, and nothing is checked",
    async (_what, headers, method, code) => {
      const { route, stopper } = routeOver([leftRunning(1)]);
      const answer = await route(request(asked(1), headers, method));

      expect(answer.status).toBe(code);
      expect(stopper.confirm).not.toHaveBeenCalled();
    },
  );

  test("a body that names more than it may is a 400, and nothing is checked", async () => {
    const { route, stopper } = routeOver([leftRunning(1)]);
    const answer = await route(request({ ...asked(1), all: true }));

    expect(answer.status).toBe(400);
    expect((answer.body as { error: string }).error).toMatch(/^The body must name from 1 to 20/);
    expect(stopper.confirm).not.toHaveBeenCalled();
  });
});
