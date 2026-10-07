import { describe, expect, test } from "vitest";

import type { PhoneKind } from "@collector/outbound/phoneMessage";
import { pushoverBody } from "@collector/pushover/pushoverMessage";

const message = (kind: PhoneKind) => ({
  kind,
  title: "billing-webhooks finished",
  message: "Seen at 14:01",
});

describe("pushoverBody", () => {
  test("is the token, the key, the title, the lines and a priority, in that order, and nothing else", () => {
    const body = pushoverBody("app-token", "user-key", message("finished"));
    expect(body).toEqual({
      token: "app-token",
      user: "user-key",
      title: "billing-webhooks finished",
      message: "Seen at 14:01",
      priority: -1,
    });
    expect(Object.keys(body)).toEqual(["token", "user", "title", "message", "priority"]);
  });

  test.each<[PhoneKind, number]>([
    ["needs-you", 0],
    ["reminder", 0],
    ["test", 0],
    ["finished", -1],
    ["failed", -1],
    ["ended", -1],
    ["quiet-summary", -1],
  ])(
    "a push of %s has priority %i, never one that sounds through Pushover's own quiet hours",
    (kind, priority) => {
      const body = pushoverBody("t", "u", message(kind));
      expect(body.priority).toBe(priority);
      for (const field of [
        "url",
        "url_title",
        "html",
        "sound",
        "device",
        "retry",
        "expire",
        "callback",
      ]) {
        expect(body).not.toHaveProperty(field);
      }
    },
  );
});
