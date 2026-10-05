import { describe, expect, test } from "vitest";

import { notificationsHeaderValue, readNotificationsHeader } from "@core/api";
import type { NoticeEvent } from "@core/sessions/waitChanges";

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
