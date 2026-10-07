import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test, vi } from "vitest";

import type { Session, SessionEvent, SessionsSnapshot } from "@core/sessions/session";
import {
  answeredEvent,
  answerIn,
  answerRefusalFor,
  createAnswerer,
  createAnswerRoute,
  MAX_ANSWER_BODY_BYTES,
} from "@collector/answers/answerRoute";
import type { AnswerOutcome } from "@collector/answers/heldAsks";
import { actionRefusalFor } from "@collector/handler";
import { makeSession } from "@tests/fixtures/session";

/** The headers the dashboard's own page sends. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "answer",
  "content-type": "application/json",
  "content-length": "120",
};

function head(
  headers: Record<string, string | string[] | undefined> = {},
  method = "POST",
): Pick<IncomingMessage, "method" | "headers"> {
  return { method, headers: { ...FROM_THE_PAGE, ...headers } };
}

const status = (req: Pick<IncomingMessage, "method" | "headers">) => answerRefusalFor(req)?.status;

const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const ALLOW = { sessionId: ID, requestId: REQUEST_ID, decision: "allow" };

function request(
  options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {},
): IncomingMessage {
  const text = options.body ?? JSON.stringify(ALLOW);
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

function waiting(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: ID,
    name: "checkout-flow",
    status: "needs-you",
    waitingReason: "permission",
    pid: 4241,
    alive: true,
    ...overrides,
  });
}

/** The route over stand-ins: a poller holding these sessions, held requests that answer as told. */
function routeOver(sessions: Session[] = [waiting()], outcome: AnswerOutcome = "answered") {
  const snapshot = (): SessionsSnapshot => ({ generatedAt: 1, sources: [], sessions });
  const poller = { getSnapshot: vi.fn(snapshot), pollOnce: vi.fn(async () => snapshot()) };
  const added: SessionEvent[] = [];
  const events = { add: vi.fn((more: readonly SessionEvent[]) => added.push(...more)) };
  const asks = { answer: vi.fn(async () => outcome) };
  const options = { poller, events, asks, now: () => 1_700_000_000_000 };
  return {
    route: createAnswerRoute(options),
    answer: createAnswerer(options),
    poller,
    added,
    asks,
  };
}

describe("answerRefusalFor, as the jump and stop routes' checks with its own action", () => {
  test("a POST from the dashboard's own page may proceed", () => {
    expect(answerRefusalFor(head())).toBeNull();
    expect(answerRefusalFor(head({ origin: "http://localhost:5173" }))).toBeNull();
    expect(answerRefusalFor(head({ "sec-fetch-site": undefined }))).toBeNull();
    expect(answerRefusalFor(head({ "content-length": undefined }))).toBeNull();
  });

  test("the answer's action opens no other route, and no other route's opens the answer", () => {
    expect(actionRefusalFor(head(), "stop", MAX_ANSWER_BODY_BYTES)?.status).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "stop" }))).toBe(403);
    expect(status(head({ "x-agent-lookout-action": "jump" }))).toBe(403);
  });

  test.each(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "a %s is refused with 405 and no CORS header",
    (method) => {
      const refusal = answerRefusalFor(head({}, method));
      expect(refusal?.status).toBe(405);
      expect(refusal?.headers?.Allow).toBe("POST");
      expect(
        Object.keys(refusal?.headers ?? {})
          .join()
          .toLowerCase(),
      ).not.toContain("access-control");
    },
  );

  test.each([undefined, "https://evil.example", "http://localhost.evil.example", "null", ""])(
    "an Origin of %j is refused",
    (origin) => {
      expect(status(head({ origin }))).toBe(403);
    },
  );

  test.each(["cross-site", "same-site", "none"])(
    "a request the browser marks %s is refused",
    (site) => {
      expect(status(head({ "sec-fetch-site": site }))).toBe(403);
    },
  );

  test.each([undefined, "", "Answer", "answer ", "allow"])(
    "without the header that names the action, as with %j, it is refused",
    (value) => {
      const refusal = answerRefusalFor(head({ "x-agent-lookout-action": value }));
      expect(refusal?.status).toBe(403);
      expect((refusal?.body as { error: string }).error).toContain(
        "X-Agent-Lookout-Action: answer",
      );
    },
  );

  test.each([undefined, "text/plain", "application/x-www-form-urlencoded"])(
    "a body sent as %j is refused with 415",
    (type) => {
      expect(status(head({ "content-type": type }))).toBe(415);
    },
  );

  test("a body said to be larger than the limit is refused with 413 before it is read", () => {
    expect(status(head({ "content-length": String(MAX_ANSWER_BODY_BYTES) }))).toBeUndefined();
    expect(status(head({ "content-length": String(MAX_ANSWER_BODY_BYTES + 1) }))).toBe(413);
  });
});

describe("the body", () => {
  test("is exactly the session, the request and the answer", () => {
    expect(answerIn(JSON.stringify(ALLOW))).toEqual(ALLOW);
    expect(answerIn(JSON.stringify({ ...ALLOW, decision: "deny" }))?.decision).toBe("deny");
  });

  test.each([
    ["another key", { ...ALLOW, updatedInput: { command: "rm -rf /" } }],
    ["a key left out", { sessionId: ID, decision: "allow" }],
    ["an answer that is not allow or deny", { ...ALLOW, decision: "ask" }],
    ["a request id of another shape", { ...ALLOW, requestId: "1" }],
    ["a session id that is not text", { ...ALLOW, sessionId: 7 }],
    ["a list", [ALLOW]],
  ])("with %s, is refused", (_what, body) => {
    expect(answerIn(JSON.stringify(body))).toBeNull();
  });
});

describe("POST /api/permission/answer", () => {
  test("hands the answer over, says so, keeps an event of the decision alone and reads the sessions again", async () => {
    const { route, asks, added, poller } = routeOver();
    const answer = await route(request());

    expect(answer).toEqual({ status: 200, body: { ok: true, decision: "allow" } });
    expect(asks.answer).toHaveBeenCalledWith(ID, REQUEST_ID, "allow");
    expect(added).toEqual([
      {
        id: `${ID}@1700000000000:answered`,
        at: 1_700_000_000_000,
        sessionId: ID,
        sessionName: "checkout-flow",
        kind: "answered",
        from: "needs-you",
        severity: "advisory",
        by: "agent-lookout",
        decision: "allow",
      },
    ]);
    expect(poller.pollOnce).toHaveBeenCalled();
  });

  test("a session the collector does not list holds no request, and nothing is answered", async () => {
    const { route, asks } = routeOver([]);
    expect(await route(request())).toMatchObject({ status: 404, body: { reason: "no-ask" } });
    expect(asks.answer).not.toHaveBeenCalled();
  });

  test.each<[AnswerOutcome, number]>([
    ["no-ask", 404],
    ["not-allowable", 409],
    ["gone", 409],
    ["too-soon", 429],
  ])("an outcome of %s is a %i that says so, with no event", async (outcome, code) => {
    const { route, added } = routeOver(undefined, outcome);
    const answer = await route(request());
    expect(answer).toMatchObject({ status: code, body: { reason: outcome } });
    expect(added).toEqual([]);
  });

  test("a body of another shape is a 400, and nothing is answered", async () => {
    const { route, asks } = routeOver();
    const answer = await route(request({ body: JSON.stringify({ sessionId: ID }) }));
    expect(answer.status).toBe(400);
    expect(asks.answer).not.toHaveBeenCalled();
  });

  test("a request from another page is refused before its body is read", async () => {
    const { route, asks } = routeOver();
    const answer = await route(request({ headers: { origin: "https://evil.example" } }));
    expect(answer.status).toBe(403);
    expect(asks.answer).not.toHaveBeenCalled();
  });

  test("replies only once a poll begun after the answer is done, so the page's read straight after finds the wait over", async () => {
    const { route, poller } = routeOver();
    let finish = () => {};
    const answered: SessionsSnapshot = {
      generatedAt: 2,
      sources: [],
      sessions: [waiting({ answered: true })],
    };
    poller.pollOnce.mockImplementationOnce(
      () => new Promise((resolve) => (finish = () => resolve(answered))),
    );
    let replied = false;
    const answer = route(request()).then((reply) => {
      replied = true;
      return reply;
    });

    await vi.waitFor(() => expect(poller.pollOnce).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(replied).toBe(false);
    finish();
    expect(await answer).toEqual({ status: 200, body: { ok: true, decision: "allow" } });
    // That poll marked the wait answered, so it is not asked for again.
    expect(poller.pollOnce).toHaveBeenCalledTimes(1);
  });

  test("polls once more when the poll it was handed was under way already, and still finds the session needing the person", async () => {
    const { route, poller } = routeOver();
    const before: SessionsSnapshot = { generatedAt: 1, sources: [], sessions: [waiting()] };
    const after: SessionsSnapshot = {
      generatedAt: 2,
      sources: [],
      sessions: [waiting({ answered: true })],
    };
    poller.pollOnce.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect((await route(request())).status).toBe(200);
    expect(poller.pollOnce).toHaveBeenCalledTimes(2);
  });

  test.each<[string, Session[]]>([
    ["gone on working", [waiting({ status: "working", waitingReason: undefined })]],
    ["left the list", []],
  ])("polls once when the session has %s", async (_what, sessions) => {
    const { route, poller } = routeOver();
    poller.pollOnce.mockResolvedValueOnce({ generatedAt: 2, sources: [], sessions });
    expect((await route(request())).status).toBe(200);
    expect(poller.pollOnce).toHaveBeenCalledTimes(1);
  });

  test("a poll that fails leaves the answer said, for the poller's next beat to read", async () => {
    const { route, poller } = routeOver();
    poller.pollOnce.mockRejectedValueOnce(new Error("read failed"));
    expect(await route(request())).toEqual({ status: 200, body: { ok: true, decision: "allow" } });
  });

  test("a body larger than it said is a 413", async () => {
    const { route } = routeOver();
    const answer = await route(
      request({ body: " ".repeat(MAX_ANSWER_BODY_BYTES + 1), headers: { "content-length": "10" } }),
    );
    expect(answer.status).toBe(413);
  });
});

test("the event holds the decision and nothing of what was asked", () => {
  const event = answeredEvent(
    waiting({ waitingText: "Run: npm test", ask: undefined }),
    "deny",
    1_700_000_000_000,
  );
  expect(JSON.stringify(event)).not.toContain("npm test");
  expect(event).toMatchObject({ kind: "answered", decision: "deny", by: "agent-lookout" });
});

describe("the one path an answer takes, from the page or from the Mac app", () => {
  test("answers, keeps the event of an answer by Agent Lookout and reads the sessions again, as the route does", async () => {
    const { answer, asks, added, poller } = routeOver();
    expect(await answer(ID, REQUEST_ID, "deny")).toBe("answered");
    expect(asks.answer).toHaveBeenCalledWith(ID, REQUEST_ID, "deny");
    expect(added).toEqual([
      expect.objectContaining({ kind: "answered", by: "agent-lookout", decision: "deny" }),
    ]);
    expect(poller.pollOnce).toHaveBeenCalled();
  });

  test("a session not listed holds no request, and a refusal keeps no event", async () => {
    const unlisted = routeOver([]);
    expect(await unlisted.answer(ID, REQUEST_ID, "allow")).toBe("no-ask");
    expect(unlisted.asks.answer).not.toHaveBeenCalled();
    const gone = routeOver(undefined, "gone");
    expect(await gone.answer(ID, REQUEST_ID, "allow")).toBe("gone");
    expect(gone.added).toEqual([]);
    expect(gone.poller.pollOnce).not.toHaveBeenCalled();
  });
});
