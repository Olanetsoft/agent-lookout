import { describe, expect, test } from "vitest";

import { isWebhookHost, notificationsHeaderValue, readNotificationsHeader } from "@core/api";
import type { NoticeEvent } from "@core/notices/sessionChanges";

describe("the notifications header", () => {
  test("is off for no events, on for a wait alone, and names the events for any other choice", () => {
    expect(notificationsHeaderValue([])).toBe("off");
    expect(notificationsHeaderValue(["needs-you"])).toBe("on");
    expect(notificationsHeaderValue(["needs-you", "finished"])).toBe(
      "on; events=needs-you,finished",
    );
    expect(notificationsHeaderValue(["ended", "failed"])).toBe("on; events=failed,ended");
    expect(notificationsHeaderValue(["finished", "needs-you", "ended", "failed"])).toBe(
      "on; events=needs-you,finished,failed,ended",
    );
  });

  test("reads back every value it writes", () => {
    const choices: NoticeEvent[][] = [
      [],
      ["needs-you"],
      ["finished"],
      ["needs-you", "finished"],
      ["failed", "ended"],
      ["needs-you", "finished", "failed", "ended"],
    ];
    for (const events of choices) {
      expect(readNotificationsHeader(notificationsHeaderValue(events))).toEqual(events);
    }
  });

  test("the old values say what they said before: on is a wait alone, and off is none", () => {
    expect(readNotificationsHeader("on")).toEqual(["needs-you"]);
    expect(readNotificationsHeader("off")).toEqual([]);
    expect(readNotificationsHeader(" ON ")).toEqual(["needs-you"]);
    expect(readNotificationsHeader("Off")).toEqual([]);
  });

  test("the new value is read whatever its spaces, case and order", () => {
    expect(readNotificationsHeader("on;events=finished")).toEqual(["finished"]);
    expect(readNotificationsHeader(" On ; Events = Ended , needs-you ")).toEqual([
      "needs-you",
      "ended",
    ]);
    // An empty list says off.
    expect(readNotificationsHeader("on; events=")).toEqual([]);
  });

  test.each([
    "",
    "yes",
    "true",
    "1",
    "on off",
    "on, off",
    "off, on",
    "on;",
    "on; events",
    "on; event=finished",
    "on; events=finish",
    "on; events=finished,,failed",
    "on; events=finished;failed",
    "on; events=finished, off",
    "on; events=needs-you, on; events=failed",
    "off; events=finished",
    "events=finished",
    "on; events=finished; more=1",
  ])("anything else says nothing: %j", (value) => {
    expect(readNotificationsHeader(value)).toBeNull();
  });
});

describe("isWebhookHost", () => {
  test("takes a host name, with underscores or a dot at the end, and an address in brackets", () => {
    for (const host of [
      "hooks.slack.com",
      "hooks.slack.com.",
      "relay_one.example.test",
      "xn--caf-dma.example.com",
      "127.0.0.1",
      "localhost",
      "[::1]",
      `${"a".repeat(249)}.com`,
    ]) {
      expect(isWebhookHost(host), host).toBe(true);
    }
  });

  test("takes nothing more than a host, no other character, and no name longer than DNS allows", () => {
    for (const host of [
      "",
      ".",
      "hooks..slack.com",
      "hooks.slack.com/services/T0000/s3cret",
      "https://hooks.slack.com",
      "name@hooks.slack.com",
      "hooks.slack.com?token=s3cret",
      "hooks.slack.com:443",
      "a*b.example.com",
      "a!b.example.com",
      "a~b.example.com",
      "a,b.example.com",
      "a$b.example.com",
      `${"a".repeat(250)}.com`,
    ]) {
      expect(isWebhookHost(host), host).toBe(false);
    }
  });
});
