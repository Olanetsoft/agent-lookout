import { describe, expect, test } from "vitest";

import { piSession } from "@collector/adapters/pi/toSession";
import { HOUR, MINUTE, NOW, PROJECT, SECOND, SESSION_ID, STARTED_AT } from "@tests/fixtures/pi/pi";

const file = {
  id: SESSION_ID,
  cwd: PROJECT,
  startedAt: STARTED_AT,
  ownName: null,
};

const open = { file, open: true, writtenAt: NOW - MINUTE, now: NOW };
const closed = { file, open: false, writtenAt: NOW - MINUTE, now: NOW };

describe("a Pi session in the shared model", () => {
  test("holds only what is known", () => {
    expect(piSession(open)).toEqual({
      id: `pi:${SESSION_ID}`,
      source: "pi",
      surface: "unknown",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "unknown",
      startedAt: STARTED_AT,
      statusSince: null,
      links: {},
      stale: false,
    });
  });

  test("once it cannot be open, is finished at its file's last write", () => {
    expect(piSession(closed)).toMatchObject({ status: "finished", statusSince: NOW - MINUTE });
  });

  test("a modified time with a fraction of a millisecond, as a disk gives, is still a time", () => {
    expect(piSession({ ...closed, writtenAt: NOW - MINUTE + 0.5 }).statusSince).toBe(NOW - MINUTE);
  });

  test("takes the name given it, cleaned and cut as any agent's is", () => {
    expect(piSession({ ...open, file: { ...file, ownName: "Release notes" } }).name).toBe(
      "Release notes",
    );
    const long = piSession({ ...open, file: { ...file, ownName: "x".repeat(500) } });
    expect(long.name).toHaveLength(200);
  });

  test("with no name and no folder, takes its id", () => {
    const session = piSession({ ...open, file: { ...file, cwd: null, ownName: "   " } });
    expect(session).toMatchObject({
      name: `pi:${SESSION_ID}`,
      cwd: null,
      project: null,
    });
  });

  test("a time that could not be right is treated as none", () => {
    const old = piSession({
      ...closed,
      file: { ...file, startedAt: 12 },
      writtenAt: 12,
    });
    expect(old).toMatchObject({ startedAt: null, statusSince: null });
    const ahead = piSession({ ...closed, writtenAt: NOW + HOUR });
    expect(ahead).toMatchObject({ statusSince: null });
  });

  test("a last write well before its start says nothing of when it ended", () => {
    expect(piSession({ ...closed, writtenAt: STARTED_AT - MINUTE }).statusSince).toBeNull();
  });

  test("a last write a moment before its start, as a disk rounds it, is the same moment", () => {
    expect(piSession({ ...closed, writtenAt: STARTED_AT - SECOND }).statusSince).toBe(
      STARTED_AT - SECOND,
    );
  });
});

describe("a session whose status a profile's own reader gives, as Prime Agent's does", () => {
  const evidence = (status: "working" | "idle" | "finished" | "unknown", since: number | null) =>
    piSession({ ...open, sourceId: "prime-agent", evidence: { status, since } });

  test("working has its time and the file's last write, idle its time alone", () => {
    expect(evidence("working", NOW - 10 * SECOND)).toMatchObject({
      status: "working",
      statusSince: NOW - 10 * SECOND,
      lastWriteAt: NOW - MINUTE,
    });
    const idle = evidence("idle", NOW - 5 * SECOND);
    expect(idle).toMatchObject({ status: "idle", statusSince: NOW - 5 * SECOND });
    expect(idle).not.toHaveProperty("lastWriteAt");
  });

  test("finished has the file's last write, and unknown no time", () => {
    expect(evidence("finished", NOW)).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
    expect(evidence("unknown", NOW)).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("a time that could not be real is none, and a last write before the start is left out", () => {
    expect(evidence("working", NOW + HOUR).statusSince).toBeNull();
    const early = piSession({
      file,
      open: true,
      writtenAt: STARTED_AT - HOUR,
      now: NOW,
      evidence: { status: "working", since: NOW },
    });
    expect(early).not.toHaveProperty("lastWriteAt");
  });

  test("without it, a session has exactly the keys it had before", () => {
    expect(Object.keys(piSession(open)).sort()).toEqual(
      [
        "cwd",
        "id",
        "links",
        "name",
        "project",
        "source",
        "stale",
        "startedAt",
        "status",
        "statusSince",
        "surface",
      ].sort(),
    );
  });
});
