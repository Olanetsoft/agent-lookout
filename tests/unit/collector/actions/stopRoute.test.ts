import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import type { Session, SessionEvent, SessionsSnapshot } from "@core/sessions/session";
import { actionRefusalFor } from "@collector/handler";
import { createStopRoute, MAX_STOP_BODY_BYTES, stopRefusalFor } from "@collector/actions/stopRoute";
import {
  createActionLimiter,
  type Acted,
  type Confirmed,
  type Stopper,
} from "@collector/actions/stopSession";
import type { StopTarget } from "@collector/actions/stopTargets";
import { makeSession } from "@tests/fixtures/session";

/** The headers the dashboard's own page sends. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "stop",
  "content-type": "application/json",
  "content-length": "62",
};

/** Headers only, for the checks made before a body is read. */
function head(
  headers: Record<string, string | string[] | undefined> = {},
  method = "POST",
): Pick<IncomingMessage, "method" | "headers"> {
  return { method, headers: { ...FROM_THE_PAGE, ...headers } };
}

const status = (req: Pick<IncomingMessage, "method" | "headers">) => stopRefusalFor(req)?.status;

const ID = "claude-code:00000000-0000-4000-8000-000000000001";

/** A request with a body, as Node hands one over. A header set to undefined is not sent. */
function request(
  options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {},
): IncomingMessage {
  const text = options.body ?? JSON.stringify({ sessionId: ID });
  const body = Readable.from(text === "" ? [] : [Buffer.from(text)]);
  const headers = Object.fromEntries(
    Object.entries({
      ...FROM_THE_PAGE,
      "content-length": String(Buffer.byteLength(text)),
      ...options.headers,
    }).filter(([, value]) => value !== undefined),
  );
  return Object.assign(body, {
    method: options.method ?? "POST",
    headers,
  }) as unknown as IncomingMessage;
}

const TARGET: StopTarget = {
  how: "signal",
  sessionId: "00000000-0000-4000-8000-000000000001",
  pid: 4241,
  procStart: "Tue Nov 14 22:13:20 2023",
  registryFile: "/Users/example/.claude/sessions/4241.json",
};

const JOB: StopTarget = { ...TARGET, how: "background", jobId: "7c5dcf5d" };

/** A session the collector lists and can stop. */
function listed(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: ID,
    source: "claude-code",
    name: "checkout-flow",
    status: "working",
    pid: 4241,
    alive: true,
    stop: { how: "signal" },
    ...overrides,
  });
}

/** The route over stand-ins: a poller holding these sessions, a stopper that does as told. */
function routeOver(
  sessions: Session[] = [listed()],
  options: {
    target?: StopTarget | undefined;
    confirmed?: Confirmed;
    acted?: Acted;
    running?: number[];
    now?: () => number;
  } = {},
) {
  const snapshot = (): SessionsSnapshot => ({ generatedAt: 1, sources: [], sessions });
  const poller = {
    getSnapshot: vi.fn(snapshot),
    pollOnce: vi.fn(async () => snapshot()),
  };
  const added: SessionEvent[] = [];
  const events = { add: vi.fn((more: readonly SessionEvent[]) => added.push(...more)) };
  const target = "target" in options ? options.target : TARGET;
  const targets = { targetOf: vi.fn(() => target), askFeedSoon: vi.fn() };
  const stopper: Stopper = {
    confirm: vi.fn(async () => options.confirmed ?? ({ ok: true, entry: { pid: 4241 } } as const)),
    act: vi.fn(async () => options.acted ?? "signalled"),
    waitForEnd: vi.fn(async () => new Set(options.running ?? [])),
    now: () => 1_700_000_000_000,
  };
  const limiter = createActionLimiter(options.now ?? (() => 1_000));
  const route = createStopRoute({ poller, events, targets, stopper, limiter });
  return { route, poller, events, added, targets, stopper, limiter };
}

describe("stopRefusalFor, as the jump route's checks with its own action", () => {
  test("a POST from the dashboard's own page may proceed", () => {
    expect(stopRefusalFor(head())).toBeNull();
    expect(stopRefusalFor(head({ origin: "http://localhost:5173" }))).toBeNull();
    expect(stopRefusalFor(head({ origin: "http://[::1]:4777" }))).toBeNull();
    expect(stopRefusalFor(head({ "sec-fetch-site": undefined }))).toBeNull();
    expect(stopRefusalFor(head({ "content-length": undefined }))).toBeNull();
    expect(stopRefusalFor(head({ "content-type": "application/json; charset=utf-8" }))).toBeNull();
  });

  test("the stop's action opens no other route, and no other route's opens the stop", () => {
    expect(actionRefusalFor(head(), "jump", MAX_STOP_BODY_BYTES)?.status).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "jump" }))).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "clean-up" }))).toBe(403);
  });

  test.each(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "a %s is refused with 405 and no CORS header",
    (method) => {
      const refusal = stopRefusalFor(head({}, method));
      expect(refusal?.status).toBe(405);
      expect(refusal?.headers?.Allow).toBe("POST");
      expect(
        Object.keys(refusal?.headers ?? {})
          .join()
          .toLowerCase(),
      ).not.toContain("access-control");
    },
  );

  test.each([
    undefined,
    "https://evil.example",
    "http://evil.example:4777",
    "http://localhost.evil.example",
    "null",
    "",
    "file://",
  ])("an Origin of %j is refused", (origin) => {
    expect(status(head({ origin }))).toBe(403);
  });

  test("an Origin sent twice is refused", () => {
    expect(status(head({ origin: ["http://127.0.0.1:4777", "https://evil.example"] }))).toBe(403);
  });

  test.each(["cross-site", "same-site", "none"])(
    "a request the browser marks %s is refused",
    (site) => {
      expect(status(head({ "sec-fetch-site": site }))).toBe(403);
    },
  );

  test.each([undefined, "", "Stop", "stop ", "kill", "stop, stop"])(
    "without the header that names the action, as with %j, it is refused",
    (value) => {
      const refusal = stopRefusalFor(head({ "x-agent-lookout-action": value }));
      expect(refusal?.status).toBe(403);
      expect((refusal?.body as { error: string }).error).toContain("X-Agent-Lookout-Action: stop");
    },
  );

  test.each([undefined, "text/plain", "application/x-www-form-urlencoded", "text/json"])(
    "a body sent as %j is refused with 415",
    (type) => {
      expect(status(head({ "content-type": type }))).toBe(415);
    },
  );

  test("a body said to be larger than the limit is refused with 413 before it is read", () => {
    expect(status(head({ "content-length": String(MAX_STOP_BODY_BYTES) }))).toBeUndefined();
    expect(status(head({ "content-length": String(MAX_STOP_BODY_BYTES + 1) }))).toBe(413);
    expect(status(head({ "content-length": "-1" }))).toBe(413);
  });
});

describe("POST /api/sessions/stop", () => {
  test("stops the session the collector found, says so, keeps an event and reads the sessions again", async () => {
    const { route, stopper, added, poller } = routeOver();
    const answer = await route(request());

    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(stopper.confirm).toHaveBeenCalledWith(TARGET);
    expect(stopper.act).toHaveBeenCalledWith(TARGET);
    expect(stopper.waitForEnd).toHaveBeenCalledWith([4241]);
    expect(added).toEqual([
      expect.objectContaining({
        sessionId: ID,
        sessionName: "checkout-flow",
        kind: "stopped",
        from: "working",
        by: "agent-lookout",
      }),
    ]);
    expect(poller.pollOnce).toHaveBeenCalled();
  });

  test("a poll that still lists it, as one under way before the stop would, is followed by one more", async () => {
    const { route, poller } = routeOver();
    await route(request());
    // The stand-in always lists it, so it is asked twice and no more.
    expect(poller.pollOnce).toHaveBeenCalledTimes(2);
  });

  test("a background job is stopped by its job, and the command is asked for again", async () => {
    const { route, stopper, targets } = routeOver([listed({ stop: { how: "background" } })], {
      target: JOB,
      acted: "stopped",
    });

    expect((await route(request())).status).toBe(200);
    expect(stopper.act).toHaveBeenCalledWith(JOB);
    expect(stopper.waitForEnd).not.toHaveBeenCalled();
    expect(targets.askFeedSoon).toHaveBeenCalledOnce();
  });

  test("a process still running 10 seconds after SIGTERM is a 202 that says so, with no event", async () => {
    const { route, added } = routeOver(undefined, { running: [4241] });
    const answer = await route(request());

    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({
      ok: false,
      error: "Agent Lookout asked the session to stop, and it is still running 10 seconds later.",
      reason: "still-running",
    });
    expect(added).toEqual([]);
  });

  test("a session the collector does not list has gone, and nothing is checked or sent", async () => {
    const { route, stopper } = routeOver([]);
    const answer = await route(request());

    expect(answer).toMatchObject({ status: 404, body: { reason: "gone" } });
    expect(stopper.confirm).not.toHaveBeenCalled();
    expect(stopper.act).not.toHaveBeenCalled();
  });

  test.each([
    ["no target was found for it", listed(), undefined],
    ["the page is not told it can be stopped", listed({ stop: undefined }), TARGET],
    ["it is a Codex session", listed({ source: "codex", stop: undefined }), undefined],
  ])("a session that is listed but %s is not stopped", async (_what, session, target) => {
    const { route, stopper } = routeOver([session], { target });
    const answer = await route(request());

    expect(answer).toMatchObject({ status: 409, body: { reason: "unsupported" } });
    expect(stopper.confirm).not.toHaveBeenCalled();
    expect(stopper.act).not.toHaveBeenCalled();
  });

  test.each([
    ["gone", 404],
    ["unsupported", 409],
    ["cannot-confirm", 409],
    ["not-allowed", 403],
  ] as const)(
    "a check made again that says %s is answered with %i, and nothing is sent",
    async (reason, code) => {
      const { route, stopper, added } = routeOver(undefined, {
        confirmed: { ok: false, reason },
      });
      const answer = await route(request());

      expect(answer.status).toBe(code);
      expect(answer.body).toMatchObject({ reason });
      expect((answer.body as { error: string }).error).toMatch(/^[A-Z].*\.$/);
      expect(stopper.act).not.toHaveBeenCalled();
      expect(added).toEqual([]);
    },
  );

  test.each([
    ["gone", 404],
    ["not-allowed", 403],
    ["unsupported", 409],
    ["failed", 500],
  ] as const)("a stop that comes to %s is answered with %i, with no event", async (acted, code) => {
    const { route, added } = routeOver(undefined, { acted });
    const answer = await route(request());

    expect(answer).toMatchObject({ status: code, body: { reason: acted } });
    expect(added).toEqual([]);
  });

  test("one stop a second, and one at a time", async () => {
    const time = { now: 1_000 };
    const { route, stopper } = routeOver(undefined, { now: () => time.now });

    expect((await route(request())).status).toBe(200);
    time.now += 999;
    const second = await route(request());
    expect(second).toMatchObject({ status: 429, body: { reason: "too-soon" } });
    expect(second.headers?.["Retry-After"]).toBe("1");
    expect(stopper.act).toHaveBeenCalledTimes(1);

    time.now += 1;
    expect((await route(request())).status).toBe(200);
  });

  test("a refused request does not use up the second a stop is given", async () => {
    const { route } = routeOver();
    await route(request({ headers: { origin: undefined } }));
    await route(request({ body: JSON.stringify({ sessionId: "claude-code:nobody" }) }));
    expect((await route(request())).status).toBe(200);
  });

  test.each([
    ["is not JSON", "sessionId=claude-code"],
    ["is empty", ""],
    ["names a process beside the session", JSON.stringify({ sessionId: ID, pid: 1 })],
    ["names a signal beside the session", JSON.stringify({ sessionId: ID, signal: "SIGKILL" })],
    ["is a list", JSON.stringify([ID])],
  ])("a body that %s is a 400, and nothing is checked", async (_what, body) => {
    const { route, stopper } = routeOver();
    const answer = await route(request({ body }));

    expect(answer.status).toBe(400);
    expect(stopper.confirm).not.toHaveBeenCalled();
  });

  test("a body larger than the limit is a 413, whether it says so or not", async () => {
    const { route, stopper } = routeOver();
    const large = JSON.stringify({ sessionId: ID, padding: "x".repeat(MAX_STOP_BODY_BYTES) });

    expect((await route(request({ body: large }))).status).toBe(413);
    expect(
      (await route(request({ body: large, headers: { "content-length": undefined } }))).status,
    ).toBe(413);
    expect(stopper.confirm).not.toHaveBeenCalled();
  });
});
