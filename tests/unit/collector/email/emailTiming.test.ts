import { describe, expect, test } from "vitest";

import {
  emailTiming,
  HOUR_MS,
  limitLiftsAt,
  sendsInLastHour,
  waitBegan,
} from "@collector/email/emailTiming";
import { EMAILS_PER_HOUR } from "@core/api";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

/** `count` emails, one a minute, the last at `lastAt`. */
const sends = (count: number, lastAt: number) =>
  Array.from({ length: count }, (_, index) => lastAt - (count - 1 - index) * MINUTE);

describe("emailTiming", () => {
  test("a wait is due once it has lasted the delay, and not a millisecond before", () => {
    expect(emailTiming(T0, MINUTE, [], T0)).toBe("wait");
    expect(emailTiming(T0, MINUTE, [], T0 + MINUTE - 1)).toBe("wait");
    expect(emailTiming(T0, MINUTE, [], T0 + MINUTE)).toBe("send");
    expect(emailTiming(T0, MINUTE, [], T0 + 10 * MINUTE)).toBe("send");
  });

  test("with no delay, a wait is due the moment it is seen", () => {
    expect(emailTiming(T0, 0, [], T0)).toBe("send");
  });

  test(`after ${EMAILS_PER_HOUR} emails in an hour, a due wait is held until the oldest is an hour old`, () => {
    const now = T0 + 30 * MINUTE;
    const full = sends(EMAILS_PER_HOUR, now);
    const oldest = full[0] as number;

    expect(emailTiming(T0, 0, full.slice(1), now)).toBe("send");
    expect(emailTiming(T0, 0, full, now)).toBe("limited");
    expect(emailTiming(T0, 0, full, oldest + HOUR_MS - 1)).toBe("limited");
    expect(emailTiming(T0, 0, full, oldest + HOUR_MS)).toBe("send");
    // The limit does not make a wait due that is not.
    expect(emailTiming(now, MINUTE, full, now)).toBe("wait");
  });

  test("emails sent more than an hour ago do not count", () => {
    const now = T0 + 5 * HOUR_MS;
    expect(emailTiming(T0, 0, sends(100, now - HOUR_MS), now)).toBe("send");
  });
});

describe("the hourly limit", () => {
  test("only the sends of the last hour count, oldest first", () => {
    const now = T0 + 2 * HOUR_MS;
    expect(
      sendsInLastHour([now - HOUR_MS, now - 5, now - HOUR_MS + 1, now - 3 * HOUR_MS], now),
    ).toEqual([now - HOUR_MS + 1, now - 5]);
  });

  test("it says when the next email may go only while it is full", () => {
    const now = T0 + HOUR_MS;
    expect(limitLiftsAt([], now)).toBeNull();
    expect(limitLiftsAt(sends(EMAILS_PER_HOUR - 1, now), now)).toBeNull();
    const full = sends(EMAILS_PER_HOUR, now);
    expect(limitLiftsAt(full, now)).toBe((full[0] as number) + HOUR_MS);
    // The sends need not come in order.
    expect(limitLiftsAt([...full].reverse(), now)).toBe((full[0] as number) + HOUR_MS);
  });

  test("a clock that went back an hour still counts the sends it made", () => {
    const sent = sends(EMAILS_PER_HOUR, T0 + HOUR_MS);
    expect(emailTiming(T0 - HOUR_MS, 0, sent, T0)).toBe("limited");
  });
});

describe("waitBegan", () => {
  test("is the source's status time when it gave one", () => {
    expect(waitBegan(T0 - 5_000, T0)).toBe(T0 - 5_000);
    expect(waitBegan(T0, T0)).toBe(T0);
  });

  test("is when the collector first saw the wait when the source gave no time, or one ahead of the clock", () => {
    expect(waitBegan(null, T0)).toBe(T0);
    expect(waitBegan(T0 + 30_000, T0)).toBe(T0);
  });
});
