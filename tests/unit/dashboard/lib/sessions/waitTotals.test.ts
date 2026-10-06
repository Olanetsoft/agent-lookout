import { afterEach, describe, expect, test } from "vitest";

import type { WaitDay, WaitPeriod, WaitsResponse } from "@core/api";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import {
  coverageNote,
  dayInWords,
  dayLabel,
  fetchWaitTotals,
  noWaitsLine,
  openPart,
  waitsAt,
  waitsCount,
} from "@dashboard/lib/sessions/waitTotals";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const at = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 9, day, hours, minutes).getTime();

const NOW = at(6, 15);

function day(n: number, overrides: Partial<WaitDay> = {}): WaitDay {
  return {
    day: `2026-10-0${n}`,
    from: at(n, 0),
    to: n === 6 ? NOW : at(n + 1, 0),
    waitedMs: 0,
    openMs: 0,
    waits: 0,
    measuredMs: 0,
    ...overrides,
  };
}

function period(overrides: Partial<WaitPeriod> = {}): WaitPeriod {
  return {
    from: at(6, 0),
    to: NOW,
    waitedMs: 42 * MINUTE,
    openMs: 0,
    waits: 6,
    measuredMs: 9 * HOUR + 12 * MINUTE,
    days: [],
    sessions: [],
    sessionCount: 0,
    ...overrides,
  };
}

function waits(overrides: Partial<WaitsResponse> = {}): WaitsResponse {
  return {
    at: NOW,
    today: period(),
    sevenDays: period({ from: new Date(2026, 8, 30).getTime(), measuredMs: 52 * HOUR }),
    since: { at: at(1, 9), by: "started" },
    where: "disk",
    ...overrides,
  };
}

afterEach(() => setApiHost());

describe("the words", () => {
  test("how many waits, or that nothing was measured", () => {
    expect(waitsCount(period({ waits: 1 }))).toBe("1 wait");
    expect(waitsCount(period({ waits: 6 }))).toBe("6 waits");
    expect(waitsCount(period({ waits: 0, waitedMs: 0 }))).toBe("No waits");
    expect(waitsCount(period({ measuredMs: 0 }))).toBe("Not measured");
  });

  test("a day is today, yesterday, or its weekday and date", () => {
    expect(dayLabel(day(6), NOW)).toBe("Today");
    expect(dayLabel(day(5), NOW)).toBe("Yesterday");
    expect(dayLabel(day(3), NOW)).not.toMatch(/day$/);
    expect(dayLabel(day(3), NOW, true)).toMatch(/3/);
  });

  test("a day's bar in words says how long, how many, whether one still waits and how much was measured", () => {
    expect(
      dayInWords(
        day(6, { waitedMs: 42 * MINUTE, openMs: MINUTE, waits: 6, measuredMs: 9 * HOUR }),
        NOW,
      ),
    ).toBe("Today: waited 42 minutes in 6 waits, still waiting, measured for 9 hours");
    expect(dayInWords(day(5, { measuredMs: HOUR }), NOW)).toBe(
      "Yesterday: no session waited, measured for 1 hour",
    );
    expect(dayInWords(day(5), NOW)).toBe("Yesterday: not measured");
  });

  test("only today's bar has an open part: a wait open since yesterday is answered there, and says nothing of still waiting", () => {
    const yesterday = day(5, {
      waitedMs: 30 * MINUTE,
      openMs: 20 * MINUTE,
      waits: 1,
      measuredMs: HOUR,
    });
    expect(openPart(yesterday, NOW)).toBe(0);
    expect(openPart(day(6, { openMs: 20 * MINUTE }), NOW)).toBe(20 * MINUTE);
    expect(dayInWords(yesterday, NOW)).toBe(
      "Yesterday: waited 30 minutes in 1 wait, measured for 1 hour",
    );
  });

  test("what is counted: only the time Agent Lookout was running, and where the history begins inside the seven days", () => {
    expect(coverageNote(waits({ since: { at: at(20, 9) - 30 * 24 * HOUR, by: "trimmed" } }))).toBe(
      "Only the time Agent Lookout was running is counted: 9h 12m of today so far, and 2d 04h of the last 7 days.",
    );
    expect(coverageNote(waits())).toBe(
      "Only the time Agent Lookout was running is counted: 9h 12m of today so far, and 2d 04h of the last 7 days. The history it keeps begins at 09:00 on Oct 1.",
    );
    expect(coverageNote(waits({ since: { at: at(6, 11, 5), by: "cleared" } }))).toBe(
      "Only the time Agent Lookout was running is counted: 9h 12m of today so far, and 2d 04h of the last 7 days. The history was cleared at 11:05.",
    );
    expect(coverageNote(waits({ today: period({ measuredMs: 0 }) }))).toMatch(
      /: none of today so far, and 2d 04h of the last 7 days\./,
    );
  });

  test("with history in memory only, it says that only the time since Agent Lookout started is counted", () => {
    expect(
      coverageNote(
        waits({
          where: "memory",
          since: { at: at(6, 13), by: "started" },
          today: period({ measuredMs: 2 * HOUR }),
          sevenDays: period({ measuredMs: 2 * HOUR }),
        }),
      ),
    ).toBe(
      "History is kept in memory only, because AGENT_LOOKOUT_HISTORY is set to off, so only the time since Agent Lookout started at 13:00 is counted: 2h 00m of today so far.",
    );
    // A run that went on across midnight has more of the 7 days than of today.
    expect(
      coverageNote(
        waits({
          where: "memory",
          since: { at: at(5, 22), by: "started" },
          today: period({ measuredMs: 15 * HOUR }),
          sevenDays: period({ measuredMs: 17 * HOUR }),
        }),
      ),
    ).toMatch(/: 15h 00m of today so far, and 17h 00m of the last 7 days\.$/);
  });

  test("an empty list says whether nobody waited or nothing was measured", () => {
    expect(noWaitsLine(period({ waits: 0 }), "today")).toBe("No session waited on you today.");
    expect(noWaitsLine(period({ measuredMs: 0 }), "sevenDays")).toBe(
      "Nothing was measured in the last 7 days.",
    );
  });
});

describe("waitsAt", () => {
  const open = waits({
    today: period({
      waitedMs: 30 * MINUTE,
      openMs: 10 * MINUTE,
      days: [day(6, { waitedMs: 30 * MINUTE, openMs: 10 * MINUTE, waits: 2, measuredMs: HOUR })],
      sessions: [
        {
          sessionId: "claude-code:2",
          name: "project-2",
          waitedMs: 20 * MINUTE,
          waits: 1,
          open: false,
        },
        {
          sessionId: "claude-code:1",
          name: "demo-project",
          waitedMs: 10 * MINUTE,
          waits: 1,
          open: true,
        },
      ],
    }),
  });

  test("each open wait, and the time measured, go on from the answer to the moment given", () => {
    const later = waitsAt(open, NOW + 11 * MINUTE);
    expect(later.at).toBe(NOW + 11 * MINUTE);
    expect(later.today).toMatchObject({
      to: NOW + 11 * MINUTE,
      waitedMs: 41 * MINUTE,
      openMs: 21 * MINUTE,
      measuredMs: 9 * HOUR + 23 * MINUTE,
    });
    expect(later.today.days[0]).toMatchObject({
      to: NOW + 11 * MINUTE,
      waitedMs: 41 * MINUTE,
      openMs: 21 * MINUTE,
      measuredMs: HOUR + 11 * MINUTE,
    });
    // The open one has overtaken the answered one.
    expect(later.today.sessions.map((session) => [session.name, session.waitedMs])).toEqual([
      ["demo-project", 21 * MINUTE],
      ["project-2", 20 * MINUTE],
    ]);
  });

  test("an answer from now, from later, from another day or from a day nothing measured is as it was", () => {
    expect(waitsAt(open, NOW)).toBe(open);
    expect(waitsAt(open, NOW - MINUTE)).toBe(open);
    expect(waitsAt(open, at(7, 0, 1))).toBe(open);
    const unmeasured = waits({ today: period({ measuredMs: 0 }) });
    expect(waitsAt(unmeasured, NOW + MINUTE)).toBe(unmeasured);
  });
});

describe("fetchWaitTotals", () => {
  test("asks the app's own server, and reads its answer", async () => {
    const asked: string[] = [];
    const sent = waits({ today: period({ days: [day(6)] }) });
    setApiHost(async (path) => {
      asked.push(path);
      return new Response(JSON.stringify(sent));
    });
    expect(await fetchWaitTotals()).toEqual(sent);
    expect(asked).toEqual(["/api/waits"]);
  });

  test("is null for an error, an answer that is not one, or no answer", async () => {
    setApiHost(async () => new Response("{}", { status: 500 }));
    expect(await fetchWaitTotals()).toBeNull();
    setApiHost(async () => new Response("<!doctype html>"));
    expect(await fetchWaitTotals()).toBeNull();
    setApiHost(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await fetchWaitTotals()).toBeNull();
  });
});
