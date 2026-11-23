import { expect, test } from "vitest";

import { copilotCliId, copilotCliSession } from "@collector/adapters/copilot-cli/toSession";
import { CWD, NOW, SESSION_ID } from "@tests/fixtures/copilot-cli/copilotCli";

test("a session is named after its working folder, with its last write while it works", () => {
  const session = copilotCliSession({
    folderName: SESSION_ID,
    cwd: CWD,
    startedAt: NOW - 60_000,
    status: { status: "working", since: NOW - 30_000, showsLastWrite: true },
    writtenAt: NOW - 1_000.5,
    now: NOW,
  });
  expect(session).toEqual({
    id: copilotCliId(SESSION_ID),
    source: "copilot-cli",
    surface: "unknown",
    name: "demo-project",
    cwd: CWD,
    project: "demo-project",
    status: "working",
    startedAt: NOW - 60_000,
    statusSince: NOW - 30_000,
    links: {},
    stale: false,
    lastWriteAt: NOW - 1_001,
  });
});

test("with no folder it is named by its ID, and a wait carries its reason and no last write", () => {
  const session = copilotCliSession({
    folderName: SESSION_ID,
    cwd: null,
    startedAt: NOW + 3_600_000,
    status: {
      status: "needs-you",
      since: NOW - 5_000,
      waitingReason: "permission",
      showsLastWrite: false,
    },
    writtenAt: NOW - 1_000,
    now: NOW,
  });
  expect(session).toMatchObject({
    name: `copilot-cli:${SESSION_ID}`,
    project: null,
    // A start that cannot be right is none.
    startedAt: null,
    waitingReason: "permission",
  });
  expect(session).not.toHaveProperty("lastWriteAt");
  for (const absent of ["pid", "jump", "stop", "tokens", "waitingText"]) {
    expect(session, absent).not.toHaveProperty(absent);
  }
});
