import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import {
  actionRefusalFor,
  jumpRefusalFor,
  MAX_JUMP_BODY_BYTES,
  sessionIdIn,
} from "@collector/jumpRoute";

/** The headers the dashboard's own page sends. Node gives header names in lower case. */
const FROM_THE_PAGE = {
  host: "127.0.0.1:4777",
  origin: "http://127.0.0.1:4777",
  "sec-fetch-site": "same-origin",
  "x-agent-lookout-action": "jump",
  "content-type": "application/json",
  "content-length": "62",
};

/** A request with those headers, changed as a test says. A header set to undefined is not sent. */
function request(
  headers: Record<string, string | string[] | undefined> = {},
  method = "POST",
): Pick<IncomingMessage, "method" | "headers"> {
  return { method, headers: { ...FROM_THE_PAGE, ...headers } };
}

const status = (req: Pick<IncomingMessage, "method" | "headers">) => jumpRefusalFor(req)?.status;

describe("actionRefusalFor", () => {
  test("holds a route that acts to its own action and its own size", () => {
    const update = request({
      "x-agent-lookout-action": "check-for-updates",
      "content-length": "2",
    });
    expect(actionRefusalFor(update, "check-for-updates", 256)).toBeNull();
    // The jump's action does not open another route, and another route's does not open the jump.
    expect(actionRefusalFor(request(), "check-for-updates", 256)?.status).toBe(403);
    expect(jumpRefusalFor(update)?.status).toBe(403);
    expect(
      actionRefusalFor(
        request({ "x-agent-lookout-action": "check-for-updates", "content-length": "257" }),
        "check-for-updates",
        256,
      )?.status,
    ).toBe(413);
  });
});

describe("jumpRefusalFor", () => {
  test("a POST from the dashboard's own page may proceed", () => {
    expect(jumpRefusalFor(request())).toBeNull();
    expect(jumpRefusalFor(request({ origin: "http://localhost:5173" }))).toBeNull();
    expect(jumpRefusalFor(request({ origin: "http://[::1]:4777" }))).toBeNull();
  });

  test("a browser that does not mark its requests, or a body sent in pieces, may proceed", () => {
    expect(jumpRefusalFor(request({ "sec-fetch-site": undefined }))).toBeNull();
    expect(jumpRefusalFor(request({ "content-length": undefined }))).toBeNull();
    expect(
      jumpRefusalFor(request({ "content-type": "application/json; charset=utf-8" })),
    ).toBeNull();
    expect(jumpRefusalFor(request({ "content-type": "Application/JSON" }))).toBeNull();
  });

  test.each(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "a %s is refused with 405, which is what a preflight that gets this far is given",
    (method) => {
      const refusal = jumpRefusalFor(request({}, method));
      expect(refusal?.status).toBe(405);
      expect(refusal?.headers?.Allow).toBe("POST");
      expect(
        Object.keys(refusal?.headers ?? {})
          .join()
          .toLowerCase(),
      ).not.toContain("access-control");
    },
  );

  test("a request with no Origin is refused, though a GET to another route may go without one", () => {
    expect(status(request({ origin: undefined }))).toBe(403);
  });

  test.each([
    "https://evil.example",
    "http://evil.example:4777",
    "http://localhost.evil.example",
    "http://127.0.0.1.evil.example:4777",
    "null",
    "",
    "localhost:4777",
    "file://",
  ])("an Origin of %j is refused", (origin) => {
    expect(status(request({ origin }))).toBe(403);
  });

  test("an Origin sent twice is refused", () => {
    expect(status(request({ origin: ["http://127.0.0.1:4777", "https://evil.example"] }))).toBe(
      403,
    );
  });

  test.each(["cross-site", "same-site", "none"])(
    "a request the browser marks %s is refused",
    (site) => {
      expect(status(request({ "sec-fetch-site": site }))).toBe(403);
    },
  );

  test.each([undefined, "", "Jump", "jump ", "stop", "1", "jump, jump"])(
    "without the header that names the action, as with %j, it is refused",
    (value) => {
      const refusal = jumpRefusalFor(request({ "x-agent-lookout-action": value }));
      expect(refusal?.status).toBe(403);
      expect((refusal?.body as { error: string }).error).toContain("X-Agent-Lookout-Action: jump");
    },
  );

  test.each([
    undefined,
    "text/plain",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=x",
    "application/jsonp",
    "text/json",
  ])(
    "a body sent as %j, which a page elsewhere could send unasked, is refused with 415",
    (type) => {
      expect(status(request({ "content-type": type }))).toBe(415);
    },
  );

  test("a body said to be larger than the limit is refused with 413 before it is read", () => {
    expect(status(request({ "content-length": String(MAX_JUMP_BODY_BYTES) }))).toBeUndefined();
    expect(status(request({ "content-length": String(MAX_JUMP_BODY_BYTES + 1) }))).toBe(413);
    expect(status(request({ "content-length": "99999999999999999999" }))).toBe(413);
    expect(status(request({ "content-length": "-1" }))).toBe(413);
    expect(status(request({ "content-length": "many" }))).toBe(413);
  });

  test("every refusal is a sentence, and closes the connection, since the body is not read", () => {
    for (const refusal of [
      jumpRefusalFor(request({}, "GET")),
      jumpRefusalFor(request({ origin: undefined })),
      jumpRefusalFor(request({ "x-agent-lookout-action": undefined })),
      jumpRefusalFor(request({ "content-type": "text/plain" })),
      jumpRefusalFor(request({ "content-length": "5000" })),
    ]) {
      expect((refusal?.body as { error: string }).error).toMatch(/^[A-Z].*\.$/);
      expect(refusal?.headers?.Connection).toBe("close");
    }
  });

  test("the method is checked first, so a request that is not a POST learns nothing but 405", () => {
    const other = request(
      { origin: "https://evil.example", "x-agent-lookout-action": undefined },
      "OPTIONS",
    );
    expect(status(other)).toBe(405);
  });
});

describe("sessionIdIn", () => {
  test("reads the session id from a body that names it and nothing else", () => {
    const id = "claude-code:00000000-0000-4000-8000-000000000001";
    expect(sessionIdIn(JSON.stringify({ sessionId: id }))).toBe(id);
    expect(sessionIdIn(` {"sessionId":"${id}"}\n`)).toBe(id);
  });

  test.each([
    ["nothing", ""],
    ["not JSON", "sessionId=claude-code:1"],
    ["a string", '"claude-code:1"'],
    ["a list", '["claude-code:1"]'],
    ["null", "null"],
    ["an empty object", "{}"],
    ["an empty id", '{"sessionId":""}'],
    ["an id that is not a string", '{"sessionId":7}'],
    ["an id that is a list", '{"sessionId":["claude-code:1"]}'],
    ["another name for the field", '{"session":"claude-code:1"}'],
    ["a pane beside the id", '{"sessionId":"claude-code:1","pane":"%0"}'],
    ["a command beside the id", '{"sessionId":"claude-code:1","args":["kill-server"]}'],
    ["a very long id", JSON.stringify({ sessionId: "x".repeat(301) })],
  ])("a body that is %s names no session", (_what, body) => {
    expect(sessionIdIn(body)).toBeNull();
  });
});
