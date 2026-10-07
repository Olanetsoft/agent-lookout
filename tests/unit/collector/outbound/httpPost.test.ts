import { describe, expect, test } from "vitest";

import {
  connectionReason,
  jsonHeaders,
  outcomeOfPost,
  postOptions,
  type PostWords,
} from "@collector/outbound/httpPost";

const WORDS: PostWords = {
  where: "the ntfy server",
  whose: "the ntfy server's",
  notSent: "the push could not be sent",
  refused: (status) => `refused (status ${status})`,
  troubled: (status) => `troubled (status ${status})`,
};

describe("jsonHeaders and postOptions", () => {
  test("say it is JSON, how long it is in bytes and who sends it, then the channel's own, and nothing else", () => {
    expect(jsonHeaders('{"title":"café"}', "1.2.3", { Authorization: "Bearer tk_x" })).toEqual({
      "Content-Type": "application/json",
      "Content-Length": "17",
      "User-Agent": "Agent Lookout/1.2.3",
      Authorization: "Bearer tk_x",
    });
    expect(Object.keys(jsonHeaders("{}", "1.2.3"))).toEqual([
      "Content-Type",
      "Content-Length",
      "User-Agent",
    ]);
  });

  test("ask for a connection of its own, and for the certificate to be checked whatever the environment says", () => {
    expect(postOptions("{}", "1.2.3")).toEqual({
      method: "POST",
      headers: jsonHeaders("{}", "1.2.3"),
      agent: false,
      rejectUnauthorized: true,
    });
  });
});

describe("outcomeOfPost", () => {
  test("only a 2xx counts as sent, and a redirect is not followed", () => {
    expect(outcomeOfPost({ kind: "status", status: 200 }, WORDS)).toEqual({ sent: true });
    expect(outcomeOfPost({ kind: "status", status: 204 }, WORDS)).toEqual({ sent: true });
    expect(outcomeOfPost({ kind: "status", status: 302 }, WORDS)).toEqual({
      sent: false,
      reason: "the ntfy server answered with a redirect, which is not followed",
    });
  });

  test("a refusal and a problem at the other end are the channel's own words, by the status alone", () => {
    expect(outcomeOfPost({ kind: "status", status: 403 }, WORDS)).toEqual({
      sent: false,
      reason: "refused (status 403)",
    });
    expect(outcomeOfPost({ kind: "status", status: 503 }, WORDS)).toEqual({
      sent: false,
      reason: "troubled (status 503)",
    });
    expect(outcomeOfPost({ kind: "status", status: 0 }, WORDS)).toEqual({
      sent: false,
      reason: "the ntfy server's answer could not be understood",
    });
  });

  test("a post that ran out of time, or could not be made, says so", () => {
    expect(outcomeOfPost({ kind: "timeout" }, WORDS)).toEqual({
      sent: false,
      reason: "the ntfy server did not answer in time",
    });
    expect(outcomeOfPost({ kind: "unsent" }, WORDS)).toEqual({
      sent: false,
      reason: "the push could not be sent",
    });
    expect(outcomeOfPost({ kind: "error", code: "ECONNREFUSED" }, WORDS)).toEqual({
      sent: false,
      reason: "nothing answered at the ntfy server",
    });
  });
});

describe("connectionReason", () => {
  test("is chosen from the error's code alone", () => {
    expect(connectionReason("ECONNREFUSED", WORDS)).toBe("nothing answered at the ntfy server");
    expect(connectionReason("ENOTFOUND", WORDS)).toBe("the ntfy server's host could not be found");
    expect(connectionReason("EAI_AGAIN", WORDS)).toBe("the ntfy server's host could not be found");
    expect(connectionReason("ETIMEDOUT", WORDS)).toBe("the ntfy server did not answer in time");
    for (const code of [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "EPROTO",
    ]) {
      expect(connectionReason(code, WORDS)).toBe("the secure connection to the ntfy server failed");
    }
    expect(connectionReason("ECONNRESET", WORDS)).toBe("the connection to the ntfy server failed");
    expect(connectionReason(null, WORDS)).toBe("the push could not be sent");
  });
});
