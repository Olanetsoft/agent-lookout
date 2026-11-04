import { describe, expect, test } from "vitest";

import { continueSession, SOURCE_ID } from "@collector/adapters/continue/toSession";
import { CREATED_AT, NOW, PROJECT, SESSION_ID } from "@tests/fixtures/continue/continue";

const FROM_THE_LIST = { id: SESSION_ID, folder: PROJECT, createdAt: CREATED_AT };

describe("one session in the shared model", () => {
  test("is named by its folder, with its start, and its status is unknown with no time", () => {
    expect(continueSession(FROM_THE_LIST, NOW)).toEqual({
      id: `continue:${SESSION_ID}`,
      source: SOURCE_ID,
      surface: "unknown",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      status: "unknown",
      startedAt: CREATED_AT,
      statusSince: null,
      links: {},
      stale: false,
    });
  });

  test("with no folder, it is named by its id", () => {
    const session = continueSession({ ...FROM_THE_LIST, folder: null }, NOW);
    expect(session).toMatchObject({
      name: `continue:${SESSION_ID}`,
      cwd: null,
      project: null,
    });
  });

  test.each([
    ["none", null],
    ["before 2020", Date.UTC(2010, 0, 1)],
    ["ahead of the clock", NOW + 60 * 60 * 1000],
  ])("a start of %s is treated as none", (_name, createdAt) => {
    expect(continueSession({ ...FROM_THE_LIST, createdAt }, NOW).startedAt).toBeNull();
  });
});
