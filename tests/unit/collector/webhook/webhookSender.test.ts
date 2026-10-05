import { describe, expect, test } from "vitest";

import {
  failureReason,
  outcomeOfStatus,
  postHeaders,
  requestOptions,
} from "@collector/webhook/webhookSender";

describe("postHeaders", () => {
  test("say it is JSON, how long it is in bytes, and who sends it, and nothing else", () => {
    expect(postHeaders('{"text":"café"}', "1.2.3")).toEqual({
      "Content-Type": "application/json",
      "Content-Length": "16",
      "User-Agent": "Agent Lookout/1.2.3",
    });
  });
});

describe("requestOptions", () => {
  test("ask for a connection of its own, and for the certificate to be checked whatever the environment says", () => {
    expect(requestOptions("{}", "1.2.3")).toEqual({
      method: "POST",
      headers: postHeaders("{}", "1.2.3"),
      agent: false,
      rejectUnauthorized: true,
    });
  });
});

describe("outcomeOfStatus", () => {
  test("only a 2xx answer counts as posted", () => {
    expect(outcomeOfStatus(200)).toEqual({ sent: true });
    expect(outcomeOfStatus(204)).toEqual({ sent: true });
  });

  test("a redirect is not followed, and says so", () => {
    for (const status of [301, 302, 307, 308]) {
      expect(outcomeOfStatus(status)).toEqual({
        sent: false,
        reason: "the address answered with a redirect, which is not followed",
      });
    }
  });

  test("a refusal and a problem at the other end give the status, and nothing the answer said", () => {
    expect(outcomeOfStatus(403)).toEqual({
      sent: false,
      reason: "the address refused the post (status 403)",
    });
    expect(outcomeOfStatus(429).sent).toBe(false);
    expect(outcomeOfStatus(500)).toEqual({
      sent: false,
      reason: "the receiving service had a problem (status 500)",
    });
    expect(outcomeOfStatus(0)).toEqual({
      sent: false,
      reason: "the address's answer could not be understood",
    });
  });
});

describe("failureReason", () => {
  test("is chosen from the error's code alone, never its message", () => {
    const withAddress = (code: string) =>
      Object.assign(new Error("connect to https://hooks.example.com/services/s3cret failed"), {
        code,
      });
    expect(failureReason(withAddress("ECONNREFUSED"))).toBe("nothing answered at the address");
    expect(failureReason(withAddress("ENOTFOUND"))).toBe("the address's host could not be found");
    expect(failureReason(withAddress("ETIMEDOUT"))).toBe("the address did not answer in time");
    for (const code of [
      "CERT_HAS_EXPIRED",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "ERR_SSL_WRONG_VERSION_NUMBER",
      "EPROTO",
    ]) {
      expect(failureReason(withAddress(code))).toBe("the secure connection to the address failed");
    }
    expect(failureReason(withAddress("ECONNRESET"))).toBe("the connection to the address failed");
    expect(failureReason(new Error("https://hooks.example.com/services/s3cret"))).toBe(
      "the post could not be sent",
    );
    expect(failureReason(undefined)).toBe("the post could not be sent");
  });
});
