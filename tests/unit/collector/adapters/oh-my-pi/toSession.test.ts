import { describe, expect, test } from "vitest";

import type { OmpSessionFile } from "@collector/adapters/oh-my-pi/sessionFile";
import { ohMyPiId, ohMyPiSession, SOURCE_ID } from "@collector/adapters/oh-my-pi/toSession";
import { CLOCK_SLACK_MS } from "@core/time";
import { CWD, HOUR, MINUTE, NOW, SESSION_ID } from "@tests/fixtures/oh-my-pi/ohMyPi";

const FILE: OmpSessionFile = {
  id: SESSION_ID,
  cwd: CWD,
  startedAt: NOW - HOUR,
  title: "Fix the flaky tests",
  tail: { state: "ok", newest: { sort: "prompt" }, behind: null, cutOff: null },
};

const WORKING = { status: "working" as const, since: null, showsLastWrite: true };

describe("one Oh My Pi session in the shared model", () => {
  test("names it by its title, else its folder's, else its ID", () => {
    const session = ohMyPiSession({
      file: FILE,
      status: WORKING,
      writtenAt: NOW - MINUTE,
      now: NOW,
    });
    expect(session).toEqual({
      id: `oh-my-pi:${SESSION_ID}`,
      source: SOURCE_ID,
      surface: "unknown",
      name: "Fix the flaky tests",
      cwd: CWD,
      project: "demo-project",
      status: "working",
      startedAt: NOW - HOUR,
      statusSince: null,
      links: {},
      stale: false,
      lastWriteAt: NOW - MINUTE,
    });
    expect(ohMyPiId(SESSION_ID)).toBe(session.id);
    const untitled = { ...FILE, title: null };
    expect(ohMyPiSession({ file: untitled, status: WORKING, writtenAt: null, now: NOW }).name).toBe(
      "demo-project",
    );
    expect(
      ohMyPiSession({
        file: { ...untitled, cwd: null },
        status: WORKING,
        writtenAt: null,
        now: NOW,
      }).name,
    ).toBe(`oh-my-pi:${SESSION_ID}`);
    expect(
      ohMyPiSession({ file: { ...FILE, title: "   " }, status: WORKING, writtenAt: null, now: NOW })
        .name,
    ).toBe("demo-project");
  });

  test("shows its last write only while it works, and passes its times through plausibleTime", () => {
    const needs = {
      status: "needs-you" as const,
      since: NOW - MINUTE,
      waitingReason: "question" as const,
      showsLastWrite: false,
    };
    const waiting = ohMyPiSession({ file: FILE, status: needs, writtenAt: NOW - MINUTE, now: NOW });
    expect(waiting).toMatchObject({
      status: "needs-you",
      statusSince: NOW - MINUTE,
      waitingReason: "question",
    });
    expect(waiting.lastWriteAt).toBeUndefined();
    const ahead = ohMyPiSession({
      file: { ...FILE, startedAt: NOW + CLOCK_SLACK_MS + 1 },
      status: WORKING,
      writtenAt: NOW + CLOCK_SLACK_MS + 1,
      now: NOW,
    });
    expect(ahead.startedAt).toBeNull();
    expect(ahead.lastWriteAt).toBeUndefined();
  });
});
