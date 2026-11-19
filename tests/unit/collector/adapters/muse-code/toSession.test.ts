import { describe, expect, test } from "vitest";

import {
  museCodeId,
  museCodeSession,
  SOURCE_ID,
  startedAtOf,
} from "@collector/adapters/muse-code/toSession";
import type { MuseCodeStatus } from "@core/mapping/muse-code/museCodeMapping";
import { CLOCK_SLACK_MS } from "@core/time";
import { CWD, HOUR, NOW, uuidAt } from "@tests/fixtures/muse-code/museCode";

const WORKING: MuseCodeStatus = { status: "working", since: NOW - HOUR, showsLastWrite: true };
const V7 = uuidAt(NOW - HOUR, 1);
const V4 = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";

const session = (fields: Partial<Parameters<typeof museCodeSession>[0]> = {}) =>
  museCodeSession({
    folderName: V7,
    cwd: CWD,
    metadataAt: NOW - 2 * HOUR,
    status: WORKING,
    writtenAt: NOW - 1_000,
    now: NOW,
    ...fields,
  });

describe("a Muse Code session in the shared model", () => {
  test("has its ID, its workspace folder's name, its status and its last write while it works", () => {
    expect(session()).toEqual({
      id: `muse-code:${V7}`,
      source: SOURCE_ID,
      surface: "unknown",
      name: "demo-project",
      cwd: CWD,
      project: "demo-project",
      status: "working",
      startedAt: NOW - HOUR,
      statusSince: NOW - HOUR,
      links: {},
      stale: false,
      lastWriteAt: NOW - 1_000,
    });
    expect(museCodeId(V7)).toBe(`muse-code:${V7}`);
  });

  test("is named muse-code: and its ID when it names no workspace folder", () => {
    expect(session({ cwd: null })).toMatchObject({
      name: `muse-code:${V7}`,
      cwd: null,
      project: null,
    });
  });

  test("shows its last write only while it works, and its reason while it waits", () => {
    const waiting = session({
      status: {
        status: "needs-you",
        since: NOW - 5_000,
        waitingReason: "permission",
        showsLastWrite: false,
      },
    });
    expect(waiting).not.toHaveProperty("lastWriteAt");
    expect(waiting.waitingReason).toBe("permission");
    expect(session({ writtenAt: NOW + CLOCK_SLACK_MS + 1 })).not.toHaveProperty("lastWriteAt");
  });
});

describe("when a session began", () => {
  test("is the time in a version 7 UUID with the RFC variant", () => {
    expect(startedAtOf(V7, null)).toBe(NOW - HOUR);
    expect(startedAtOf(V7, NOW)).toBe(NOW - HOUR);
  });

  test("is the metadata record's time for a version 4 UUID, or another variant, else none", () => {
    expect(startedAtOf(V4, NOW - 2 * HOUR)).toBe(NOW - 2 * HOUR);
    expect(startedAtOf(V4, null)).toBeNull();
    const otherVariant = `${V7.slice(0, 19)}c${V7.slice(20)}`;
    expect(startedAtOf(otherVariant, null)).toBeNull();
    expect(session({ folderName: V4 }).startedAt).toBe(NOW - 2 * HOUR);
  });

  test("is none when it cannot be right", () => {
    const future = uuidAt(NOW + 2 * CLOCK_SLACK_MS, 1);
    expect(session({ folderName: future, metadataAt: null }).startedAt).toBeNull();
    expect(session({ folderName: uuidAt(1_000, 1) }).startedAt).toBeNull();
  });
});
