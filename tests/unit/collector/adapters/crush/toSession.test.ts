import { describe, expect, test } from "vitest";

import type { SessionRow } from "@collector/adapters/crush/sessionRows";
import { crushSession, isListed, projectPrefix } from "@collector/adapters/crush/toSession";
import { MAX_NAME_LENGTH } from "@core/text";
import {
  DAY,
  HOUR,
  MINUTE,
  NOW,
  OTHER_PROJECT,
  PROJECT,
  SESSION_ID,
} from "@tests/fixtures/crush/crush";

function row(changes: Partial<SessionRow> = {}): SessionRow {
  return { id: SESSION_ID, createdAt: NOW - HOUR, updatedAt: NOW - MINUTE, ...changes };
}

const input = (changes: Partial<SessionRow> = {}, open = true) => ({
  folder: PROJECT,
  row: row(changes),
  open,
  now: NOW,
});

describe("a project's prefix", () => {
  test("is the source's id and a hash of the folder, which names no folder", () => {
    const prefix = projectPrefix(PROJECT);
    expect(prefix).toMatch(/^crush:[0-9a-f]{12}\/$/);
    expect(prefix).not.toContain("demo-project");
  });

  test("is the same from one poll to the next, and differs between folders", () => {
    expect(projectPrefix(PROJECT)).toBe(projectPrefix(PROJECT));
    expect(projectPrefix(PROJECT)).not.toBe(projectPrefix(OTHER_PROJECT));
  });
});

describe("a session", () => {
  test("in an open Crush has its folder, its start and no status time, and nothing it was not given", () => {
    expect(crushSession(input())).toEqual({
      id: `${projectPrefix(PROJECT)}${SESSION_ID}`,
      source: "crush",
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

  test("with no Crush running is finished, since Crush last wrote it", () => {
    expect(crushSession(input({}, false))).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
  });

  test("a folder with a very long name gives a name cut as every agent's is", () => {
    const folder = `/Users/example/${"x".repeat(250)}`;
    const session = crushSession({ ...input(), folder });
    expect(session.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
    expect(session.cwd).toBe(folder);
  });

  test("a folder whose name cleans to nothing takes its id", () => {
    const session = crushSession({ ...input(), folder: "/Users/example/   " });
    expect(session.name).toBe(session.id);
  });

  test("the same session in a copied folder has an id of its own", () => {
    const copy = crushSession({ ...input(), folder: OTHER_PROJECT });
    expect(copy.id).not.toBe(crushSession(input()).id);
  });

  test("takes a bad time as none", () => {
    const session = crushSession(input({ createdAt: null, updatedAt: null }, false));
    expect(session).toMatchObject({ startedAt: null, statusSince: null });
  });

  test("takes a time after now for none, and keeps the rest", () => {
    const session = crushSession(input({ createdAt: NOW + DAY, updatedAt: NOW + DAY }, false));
    expect(session).toMatchObject({ startedAt: null, statusSince: null, status: "finished" });
  });

  test("takes a time from before there were agents for none", () => {
    expect(crushSession(input({ createdAt: 1_000 }))).toMatchObject({ startedAt: null });
  });

  test("never has a process, a link, a last write or tokens", () => {
    const session = crushSession(input());
    for (const field of ["pid", "alive", "lastWriteAt", "tokens", "waitingReason"]) {
      expect(session).not.toHaveProperty(field);
    }
    expect(session.links).toEqual({});
  });
});

describe("isListed", () => {
  test("keeps a session written in the last 24 hours", () => {
    expect(isListed(row({ updatedAt: NOW - DAY + 1 }), NOW)).toBe(true);
  });

  test("leaves out one written longer ago, and one with no time", () => {
    expect(isListed(row({ updatedAt: NOW - DAY }), NOW)).toBe(false);
    expect(isListed(row({ updatedAt: null }), NOW)).toBe(false);
  });

  test("keeps one written ahead of a clock set back", () => {
    expect(isListed(row({ updatedAt: NOW + HOUR }), NOW)).toBe(true);
  });
});
