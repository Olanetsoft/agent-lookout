import { expect, test } from "vitest";

import {
  afterNotNow,
  ASK_AGAIN_AFTER_MS,
  notificationAskDue,
  readNotificationAsk,
  STOPPED,
  UNASKED,
  writeNotificationAsk,
  type NotificationAsk,
} from "@core/notices/notificationAsk";
import { CLOCK_SLACK_MS } from "@core/time";

const DAY = 86_400_000;
const t = 1_791_000_000_000;

const putOff = (times: number, at: number): NotificationAsk => ({ kind: "put-off", times, at });

test("it asks again after a day, then 3 days, then a week", () => {
  expect(ASK_AGAIN_AFTER_MS).toEqual([DAY, 3 * DAY, 7 * DAY]);
});

test("nothing stored reads as never put off, which is due at any time", () => {
  expect(readNotificationAsk(null)).toEqual(UNASKED);
  expect(notificationAskDue(UNASKED, t)).toBe(true);
  expect(notificationAskDue(UNASKED, 0)).toBe(true);
});

test.each([
  [1, DAY],
  [2, 3 * DAY],
  [3, 7 * DAY],
])(
  "after %i Not now it is due once %i ms have passed since the last, and not a moment before",
  (times, wait) => {
    const ask = putOff(times, t);
    expect(notificationAskDue(ask, t)).toBe(false);
    expect(notificationAskDue(ask, t + wait - 1)).toBe(false);
    expect(notificationAskDue(ask, t + wait)).toBe(true);
    expect(notificationAskDue(ask, t + wait + 30 * DAY)).toBe(true);
  },
);

test("each Not now counts once more from the time it was pressed, and the fourth stops it", () => {
  const first = afterNotNow(UNASKED, t);
  expect(first).toEqual(putOff(1, t));

  // Pressed five days after it came due: the next wait counts from the press.
  const second = afterNotNow(first, t + 6 * DAY);
  expect(second).toEqual(putOff(2, t + 6 * DAY));

  const third = afterNotNow(second, t + 10 * DAY);
  expect(third).toEqual(putOff(3, t + 10 * DAY));

  expect(afterNotNow(third, t + 20 * DAY)).toEqual(STOPPED);
  expect(afterNotNow(STOPPED, t + 30 * DAY)).toEqual(STOPPED);
});

test("once stopped it is never due, even years later", () => {
  expect(notificationAskDue(STOPPED, t)).toBe(false);
  expect(notificationAskDue(STOPPED, t + 3650 * DAY)).toBe(false);
});

test("a last Not now further ahead of the clock than the slack is due, as after the clock was set back, and the count holds", () => {
  const ahead = putOff(3, t + CLOCK_SLACK_MS + 1);
  expect(notificationAskDue(ahead, t)).toBe(true);
  expect(afterNotNow(ahead, t)).toEqual(STOPPED);

  // Within the slack it is a time just now, and the wait counts from it.
  expect(notificationAskDue(putOff(1, t + CLOCK_SLACK_MS), t)).toBe(false);
  expect(afterNotNow(putOff(1, t + 2 * CLOCK_SLACK_MS), t)).toEqual(putOff(2, t));
});

test("a record is stored as a count and a time, or as stopped, and reads back as it was", () => {
  expect(writeNotificationAsk({ kind: "put-off", times: 2, at: t })).toBe(`{"notNow":2,"at":${t}}`);
  expect(writeNotificationAsk({ kind: "stopped" })).toBe('{"stopped":true}');
  for (const ask of [putOff(1, t), putOff(2, t), putOff(3, t), STOPPED] as const) {
    if (ask.kind === "unasked") continue;
    expect(readNotificationAsk(writeNotificationAsk(ask))).toEqual(ask);
  }
});

test.each([
  "",
  "x",
  "[]",
  "null",
  "1",
  '"text"',
  `{"notNow":0,"at":${t}}`,
  `{"notNow":-1,"at":${t}}`,
  `{"notNow":1.5,"at":${t}}`,
  `{"notNow":"1","at":${t}}`,
  '{"notNow":1}',
  '{"notNow":1,"at":-5}',
  '{"notNow":1,"at":1000}',
  `{"notNow":1,"at":"${t}"}`,
  '{"stopped":false}',
  "{}",
])("%j cannot be read, so it is as nothing stored", (text) => {
  expect(readNotificationAsk(text)).toEqual(UNASKED);
});

test.each([`{"notNow":4,"at":${t}}`, `{"notNow":9,"at":${t}}`, '{"notNow":4}'])(
  "%j is past the last wait, so it is stopped",
  (text) => {
    expect(readNotificationAsk(text)).toEqual(STOPPED);
  },
);

test("stopped wins over a count and a time stored beside it", () => {
  expect(readNotificationAsk(`{"stopped":true,"notNow":1,"at":${t}}`)).toEqual(STOPPED);
});
