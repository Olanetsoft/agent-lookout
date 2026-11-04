import { describe, expect, test } from "vitest";

import { gooseSession, isListed } from "@collector/adapters/goose/toSession";
import type { SessionRow } from "@collector/adapters/goose/sessionRows";
import { DAY, HOUR, MINUTE, NOW, PROJECT } from "@tests/fixtures/goose/goose";

function row(changes: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "20261001_1",
    folder: PROJECT,
    ownName: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - MINUTE,
    ...changes,
  };
}

describe("a session", () => {
  test("in an open Goose has its folder, its start and no status time, and nothing it was not given", () => {
    expect(gooseSession({ row: row(), open: true, now: NOW })).toEqual({
      id: "goose:20261001_1",
      source: "goose",
      surface: "unknown",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "unknown",
      startedAt: NOW - HOUR,
      statusSince: null,
      links: {},
      stale: false,
    });
  });

  test("with no Goose running is finished, since Goose last wrote it", () => {
    expect(gooseSession({ row: row(), open: false, now: NOW })).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
  });

  test("is named by the person's own name when it has one", () => {
    const session = gooseSession({
      row: row({ ownName: "Release notes" }),
      open: true,
      now: NOW,
    });
    expect(session.name).toBe("Release notes");
    expect(session.project).toBe("demo-project");
  });

  test("with a name made of spaces takes its folder's", () => {
    expect(gooseSession({ row: row({ ownName: "   " }), open: true, now: NOW }).name).toBe(
      "demo-project",
    );
  });

  test("a name the person gave is cleaned and cut as every agent's is", () => {
    const session = gooseSession({
      row: row({ ownName: `Release\u0007 notes\u202e\n${"x".repeat(300)}` }),
      open: true,
      now: NOW,
    });
    expect(session.name).toBe(`Release  notes  ${"x".repeat(184)}`);
  });

  test("with no folder and no name takes its id", () => {
    const session = gooseSession({ row: row({ folder: null }), open: true, now: NOW });
    expect(session).toMatchObject({
      name: "goose:20261001_1",
      cwd: null,
      project: null,
    });
  });

  test("a time that cannot be right is not shown", () => {
    const session = gooseSession({
      row: row({ createdAt: 1_000, updatedAt: NOW + DAY }),
      open: false,
      now: NOW,
    });
    expect(session).toMatchObject({ startedAt: null, statusSince: null });
  });
});

describe("whether a session is listed", () => {
  test("for 24 hours after Goose last wrote it", () => {
    expect(isListed(row({ updatedAt: NOW - DAY + 1 }), NOW)).toBe(true);
    expect(isListed(row({ updatedAt: NOW - DAY }), NOW)).toBe(false);
  });

  test("not when no time of it is known", () => {
    expect(isListed(row({ updatedAt: null }), NOW)).toBe(false);
  });

  test("a time ahead of a clock set back keeps it", () => {
    expect(isListed(row({ updatedAt: NOW + DAY }), NOW)).toBe(true);
  });
});
