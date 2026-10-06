import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, test } from "vitest";

import {
  createClearHistoryRoute,
  isEmptyObject,
  MAX_CLEAR_BODY_BYTES,
} from "@collector/history/clearRoute";
import type { ClearOutcome } from "@collector/history/historyKeeper";

/** The headers the dashboard's own page sends to clear the history. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "clear-history",
  "content-type": "application/json",
  "content-length": "2",
};

/** A request with a body, as Node hands one over. A header set to undefined is not sent. */
function request(
  options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {},
): IncomingMessage {
  const text = options.body ?? "{}";
  const body = Readable.from(text === "" ? [] : [Buffer.from(text)]);
  const headers = Object.fromEntries(
    Object.entries({ ...FROM_THE_PAGE, ...options.headers }).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return Object.assign(body, {
    method: options.method ?? "POST",
    headers,
  }) as unknown as IncomingMessage;
}

/** A keeper that clears as a test says, and counts what it was asked. */
function standIn(outcome: ClearOutcome = { ok: true, at: 1_791_204_000_000 }) {
  const asked: number[] = [];
  return {
    asked,
    keeper: {
      async clear(forget: () => void) {
        asked.push(1);
        if (outcome.ok) forget();
        return outcome;
      },
    },
  };
}

describe("isEmptyObject", () => {
  test("only {} is an empty object", () => {
    expect(isEmptyObject("{}")).toBe(true);
    expect(isEmptyObject(" { } \n")).toBe(true);
    for (const body of ["", "[]", "null", '{"all":true}', "{", '"{}"', "0"]) {
      expect([body, isEmptyObject(body)]).toEqual([body, false]);
    }
  });
});

describe("POST /api/history/clear", () => {
  test("from the dashboard's own page, it clears and says when, and the stores are emptied", async () => {
    const { keeper, asked } = standIn();
    let forgotten = 0;
    const answer = await createClearHistoryRoute({ keeper, forget: () => (forgotten += 1) })(
      request(),
    );
    expect(answer).toEqual({ status: 200, body: { ok: true, clearedAt: 1_791_204_000_000 } });
    expect(asked).toHaveLength(1);
    expect(forgotten).toBe(1);
  });

  test.each([
    ["a GET", { method: "GET" }, 405],
    ["an OPTIONS", { method: "OPTIONS" }, 405],
    ["no Origin", { headers: { origin: undefined } }, 403],
    ["another site's Origin", { headers: { origin: "https://example.com" } }, 403],
    [
      "a request the browser calls cross-site",
      { headers: { "sec-fetch-site": "cross-site" } },
      403,
    ],
    ["no action header", { headers: { "x-agent-lookout-action": undefined } }, 403],
    ["the jump's action", { headers: { "x-agent-lookout-action": "jump" } }, 403],
    ["a form's content type", { headers: { "content-type": "text/plain" } }, 415],
    ["a body said to be too long", { headers: { "content-length": "65" } }, 413],
  ] as const)("%s is refused, and nothing is cleared", async (_case, options, status) => {
    const { keeper, asked } = standIn();
    const answer = await createClearHistoryRoute({ keeper, forget: () => {} })(request(options));
    expect(answer.status).toBe(status);
    expect(answer.headers?.Connection).toBe("close");
    expect(asked).toEqual([]);
  });

  test("a body that is not {}, or longer than the limit, is refused", async () => {
    for (const [body, status] of [
      ['{"everything":true}', 400],
      ["", 400],
      ["x".repeat(MAX_CLEAR_BODY_BYTES + 1), 413],
    ] as const) {
      const { keeper, asked } = standIn();
      const answer = await createClearHistoryRoute({ keeper, forget: () => {} })(
        request({ body, headers: { "content-length": undefined } }),
      );
      expect([body.slice(0, 20), answer.status]).toEqual([body.slice(0, 20), status]);
      expect(asked).toEqual([]);
    }
  });

  test("in memory only there are no files, and it says so", async () => {
    const answer = await createClearHistoryRoute({ keeper: null, forget: () => {} })(request());
    expect(answer).toEqual({
      status: 409,
      body: {
        reason: "memory-only",
        error:
          "History is kept in memory only, with AGENT_LOOKOUT_HISTORY=off, so there are no files to clear.",
      },
    });
  });

  test("a copy that does not write the files, and files that cannot be deleted, are said apart", async () => {
    const notWriting = standIn({
      ok: false,
      reason: "not-writing",
      error: "Another copy keeps it.",
    });
    expect(
      await createClearHistoryRoute({ keeper: notWriting.keeper, forget: () => {} })(request()),
    ).toEqual({ status: 409, body: { reason: "not-writing", error: "Another copy keeps it." } });

    const failed = standIn({
      ok: false,
      reason: "failed",
      error: "One history file could not be deleted.",
    });
    expect(
      await createClearHistoryRoute({ keeper: failed.keeper, forget: () => {} })(request()),
    ).toEqual({
      status: 500,
      body: { reason: "failed", error: "One history file could not be deleted." },
    });
  });
});
