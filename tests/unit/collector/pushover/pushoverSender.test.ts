import { describe, expect, test } from "vitest";

import { outcomeOfPost } from "@collector/outbound/httpPost";
import { PUSHOVER_ENDPOINT, PUSHOVER_WORDS } from "@collector/pushover/pushoverSender";

describe("PUSHOVER_WORDS", () => {
  test("every push goes to Pushover's messages API over HTTPS", () => {
    expect(PUSHOVER_ENDPOINT).toBe("https://api.pushover.net/1/messages.json");
  });

  test.each([
    [400, "Pushover refused the push: check the application's token and the user key (status 400)"],
    [429, "Pushover's monthly limit for the application was reached (status 429)"],
    [403, "Pushover refused the push (status 403)"],
    [500, "Pushover had a problem (status 500)"],
  ])("an answer of %i says why, by the status alone", (status, reason) => {
    expect(outcomeOfPost({ kind: "status", status }, PUSHOVER_WORDS)).toEqual({
      sent: false,
      reason,
    });
  });

  test("a push that could not be made says so in Pushover's words", () => {
    expect(outcomeOfPost({ kind: "timeout" }, PUSHOVER_WORDS)).toEqual({
      sent: false,
      reason: "Pushover did not answer in time",
    });
    expect(outcomeOfPost({ kind: "error", code: "ENOTFOUND" }, PUSHOVER_WORDS)).toEqual({
      sent: false,
      reason: "Pushover's host could not be found",
    });
  });
});
