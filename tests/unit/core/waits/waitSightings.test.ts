import { describe, expect, test } from "vitest";

import {
  lastSeenWithin,
  sightingsBySession,
  waitStretches,
  type WaitSighting,
} from "@core/waits/waitSightings";

const listed = (sessionId: string, at: number): WaitSighting => ({
  sessionId,
  sessionName: "demo-project",
  at,
  way: "main",
});
const lost = (sessionId: string, at: number, lastSeen: number): WaitSighting => ({
  ...listed(sessionId, at),
  lastSeen,
});

describe("sightingsBySession", () => {
  test("puts each session's sightings together, oldest first, whatever order they came in", () => {
    const later = lost("claude-code:a", 30, 20);
    const earlier = listed("claude-code:a", 10);
    const other = listed("claude-code:b", 20);
    const held = [later, other, earlier];
    expect(sightingsBySession(held)).toEqual(
      new Map([
        ["claude-code:a", [earlier, later]],
        ["claude-code:b", [other]],
      ]),
    );
    expect(held).toEqual([later, other, earlier]);
  });
});

describe("lastSeenWithin", () => {
  const own = [listed("claude-code:a", 10), lost("claude-code:a", 30, 20)];

  test("is the last poll that listed the session, once it was lost and not seen again", () => {
    expect(lastSeenWithin(own, 0, 100)).toBe(20);
  });

  test("is null while the newest sighting says it is listed", () => {
    expect(lastSeenWithin([...own, listed("claude-code:a", 40)], 0, 100)).toBeNull();
    expect(lastSeenWithin(own.slice(0, 1), 0, 100)).toBeNull();
    expect(lastSeenWithin([], 0, 100)).toBeNull();
  });

  test("reads only what falls in the wait: from when it began, and before when it ended", () => {
    expect(lastSeenWithin(own, 31, 100)).toBeNull();
    expect(lastSeenWithin(own, 30, 100)).toBe(20);
    expect(lastSeenWithin(own, 0, 30)).toBeNull();
  });
});

describe("waitStretches", () => {
  const id = "claude-code:a";
  const relisted = (at: number, began: number): WaitSighting => ({ ...listed(id, at), began });

  test("is one stretch when nothing cuts it", () => {
    expect(waitStretches([], 10, 100)).toEqual([{ from: 10, to: 100 }]);
    expect(waitStretches([lost(id, 30, 20), listed(id, 40)], 10, 100)).toEqual([
      { from: 10, to: 100 },
    ]);
  });

  test("cuts at the last poll that listed the session, and goes on from the status time", () => {
    expect(waitStretches([lost(id, 30, 20), relisted(50, 40)], 10, 100)).toEqual([
      { from: 10, to: 20 },
      { from: 40, to: 100 },
    ]);
  });

  test("cuts as often as a new wait began", () => {
    const own = [lost(id, 30, 20), relisted(50, 40), lost(id, 70, 60), relisted(90, 80)];
    expect(waitStretches(own, 10, 100)).toEqual([
      { from: 10, to: 20 },
      { from: 40, to: 60 },
      { from: 80, to: 100 },
    ]);
  });

  test("reads only what falls in the wait, and needs it to have been lost in it", () => {
    expect(waitStretches([relisted(50, 40)], 10, 100)).toEqual([{ from: 10, to: 100 }]);
    expect(waitStretches([lost(id, 5, 4), relisted(50, 40)], 10, 100)).toEqual([
      { from: 10, to: 100 },
    ]);
    expect(waitStretches([lost(id, 30, 20), relisted(50, 40)], 10, 45)).toEqual([
      { from: 10, to: 45 },
    ]);
  });
});
