import { describe, expect, test } from "vitest";

import { droidSession, SOURCE_ID } from "@collector/adapters/droid/toSession";
import { EARLIEST_PLAUSIBLE_TIME_MS } from "@core/time";
import { CWD, MINUTE, NOW, SESSION_ID } from "@tests/fixtures/droid/droid";

const file = { id: SESSION_ID, cwd: CWD };

describe("a Droid session", () => {
  test("is named after its folder, with no start time, app, link or last write", () => {
    const session = droidSession({ file, open: true, writtenAt: NOW - MINUTE, now: NOW });
    expect(SOURCE_ID).toBe("droid");
    expect(session).toEqual({
      id: `droid:${SESSION_ID}`,
      source: "droid",
      surface: "unknown",
      name: "demo-project",
      cwd: CWD,
      project: "demo-project",
      status: "unknown",
      startedAt: null,
      statusSince: null,
      links: {},
      stale: false,
    });
  });

  test("is named by its ID when its first line names no folder", () => {
    const session = droidSession({
      file: { id: SESSION_ID, cwd: null },
      open: true,
      writtenAt: NOW,
      now: NOW,
    });
    expect(session.name).toBe(`droid:${SESSION_ID}`);
    expect(session.project).toBeNull();
  });

  test("is finished since its file's last write once Droid cannot have it open", () => {
    const session = droidSession({ file, open: false, writtenAt: NOW - MINUTE + 0.5, now: NOW });
    expect(session.status).toBe("finished");
    expect(session.statusSince).toBe(NOW - MINUTE);
  });

  test("has no status time when its last write could not be right", () => {
    for (const writtenAt of [EARLIEST_PLAUSIBLE_TIME_MS - 1, NOW + 2 * MINUTE]) {
      expect(droidSession({ file, open: false, writtenAt, now: NOW }).statusSince).toBeNull();
    }
  });
});
