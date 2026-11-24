import { describe, expect, test } from "vitest";

import { sightingsBySession, type WaitSighting } from "@core/waits/waitSightings";

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
