import { describe, expect, test } from "vitest";

import { NTFY_WORDS, ntfyHeaders } from "@collector/ntfy/ntfySender";
import { outcomeOfPost } from "@collector/outbound/httpPost";

describe("ntfyHeaders", () => {
  test("carry the access token as a bearer, only when one is set", () => {
    expect(ntfyHeaders({ token: null })).toEqual({});
    expect(ntfyHeaders({ token: "tk_abc" })).toEqual({ Authorization: "Bearer tk_abc" });
  });
});

describe("NTFY_WORDS", () => {
  test.each([
    [401, "the ntfy server refused the access token or the topic (status 401)"],
    [403, "the ntfy server refused the access token or the topic (status 403)"],
    [413, "the ntfy server refused the push as too large (status 413)"],
    [429, "the ntfy server's rate limit was reached (status 429)"],
    [400, "the ntfy server refused the push (status 400)"],
    [500, "the ntfy server had a problem (status 500)"],
  ])("an answer of %i says why, by the status alone", (status, reason) => {
    expect(outcomeOfPost({ kind: "status", status }, NTFY_WORDS)).toEqual({ sent: false, reason });
  });

  test("a push that could not be made says so in ntfy's words", () => {
    expect(outcomeOfPost({ kind: "error", code: "ENOTFOUND" }, NTFY_WORDS)).toEqual({
      sent: false,
      reason: "the ntfy server's host could not be found",
    });
    expect(outcomeOfPost({ kind: "unsent" }, NTFY_WORDS)).toEqual({
      sent: false,
      reason: "the push could not be sent",
    });
  });
});
