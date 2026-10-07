import { expect, test } from "vitest";

import { delayInWords, lastSendWords } from "@dashboard/lib/notifications/sendingWords";

test("a delay is said in the largest whole unit", () => {
  expect(delayInWords(0)).toBe("0 seconds");
  expect(delayInWords(1_000)).toBe("1 second");
  expect(delayInWords(5_000)).toBe("5 seconds");
  expect(delayInWords(60_000)).toBe("1 minute");
  expect(delayInWords(90_000)).toBe("90 seconds");
  expect(delayInWords(300_000)).toBe("5 minutes");
  expect(delayInWords(3_600_000)).toBe("1 hour");
  expect(delayInWords(5_400_000)).toBe("90 minutes");
});

test("the line on the last send names what each channel sends", () => {
  const nouns = {
    plural: "pushes",
    failed: "The last push failed",
    held: "Pushes are held back",
    lastAt: "Last sent at",
  };
  const now = new Date(2026, 9, 5, 14, 30).getTime();
  const at = new Date(2026, 9, 5, 14, 2).getTime();
  const until = new Date(2026, 9, 5, 15, 2).getTime();
  expect(lastSendWords({ last: null, limitedUntil: null }, now, nouns)).toEqual({
    title: null,
    detail: null,
  });
  expect(lastSendWords({ last: { at, sent: true }, limitedUntil: null }, now, nouns)).toEqual({
    title: null,
    detail: "Last sent at 14:02.",
  });
  expect(
    lastSendWords(
      { last: { at, sent: false, reason: "pushover had a problem" }, limitedUntil: until },
      now,
      nouns,
    ),
  ).toEqual({
    title: "The last push failed",
    detail:
      "Pushover had a problem. No more will be tried until 15:02, as 20 were tried in the last hour.",
  });
  expect(lastSendWords({ last: { at, sent: true }, limitedUntil: until }, now, nouns)).toEqual({
    title: "Pushes are held back",
    detail: "20 pushes were tried in the last hour, the most it tries. The next can go at 15:02.",
  });
});
