import { describe, expect, test } from "vitest";

import {
  autohandCodeSession,
  type AutohandCodeSessionInput,
} from "@collector/adapters/autohand-code/toSession";
import type { MetadataFacts } from "@core/mapping/autohand-code/autohandCodeMapping";
import {
  CREATED_AT,
  NOW,
  PID,
  PROJECT,
  SESSION_ID,
} from "@tests/fixtures/autohand-code/autohandCode";

const facts = (more: Partial<MetadataFacts> = {}): MetadataFacts => ({
  status: "active",
  createdAt: CREATED_AT,
  lastActiveAt: NOW - 30_000,
  closedAt: null,
  importedAt: null,
  projectPath: PROJECT,
  title: null,
  client: "terminal",
  ...more,
});

const input = (more: Partial<AutohandCodeSessionInput> = {}): AutohandCodeSessionInput => ({
  sessionId: SESSION_ID,
  status: "working",
  statusSince: NOW - 10_000,
  facts: facts(),
  writtenAt: NOW - 20_000.4,
  heartbeat: {
    workspaceRoot: "/private/Users/example/code/demo-project",
    mode: "interactive",
    startedAt: CREATED_AT - 5_000,
  },
  process: { pid: PID, alive: true },
  now: NOW,
  ...more,
});

describe("an Autohand Code session", () => {
  test("is named by the name you gave it, else its folder's, else its id", () => {
    expect(autohandCodeSession(input({ facts: facts({ title: "Fix the login form" }) })).name).toBe(
      "Fix the login form",
    );
    expect(autohandCodeSession(input()).name).toBe("demo-project");
    expect(
      autohandCodeSession(input({ facts: facts({ projectPath: null }), heartbeat: null })).name,
    ).toBe(`autohand-code:${SESSION_ID}`);
  });

  test("works in its metadata.json's folder, else its heartbeat's", () => {
    expect(autohandCodeSession(input()).cwd).toBe(PROJECT);
    expect(autohandCodeSession(input({ facts: null })).cwd).toBe(
      "/private/Users/example/code/demo-project",
    );
  });

  test("runs in VS Code when its metadata.json says so, else in a terminal by its heartbeat's mode", () => {
    const surface = (more: Partial<AutohandCodeSessionInput>) =>
      autohandCodeSession(input(more)).surface;
    expect(surface({ facts: facts({ client: "vscode" }) })).toBe("vscode");
    expect(surface({ facts: facts({ client: null }) })).toBe("terminal");
    const mode = (value: "interactive" | "command" | "rpc" | null) => ({
      workspaceRoot: null,
      mode: value,
      startedAt: null,
    });
    expect(surface({ facts: facts({ client: null }), heartbeat: mode("command") })).toBe(
      "terminal",
    );
    // A process that serves a client is in no terminal this knows.
    expect(surface({ heartbeat: mode("rpc") })).toBe("unknown");
    expect(surface({ heartbeat: mode(null) })).toBe("terminal");
    expect(surface({ facts: facts({ client: null }), heartbeat: null })).toBe("unknown");
  });

  test("started when its metadata.json says it was made, else when its heartbeat does", () => {
    expect(autohandCodeSession(input()).startedAt).toBe(CREATED_AT);
    expect(autohandCodeSession(input({ facts: null })).startedAt).toBe(CREATED_AT - 5_000);
  });

  test("was last written when its metadata.json was, in whole milliseconds, not before it started, and never from its heartbeat", () => {
    expect(autohandCodeSession(input()).lastWriteAt).toBe(NOW - 20_001);
    expect(autohandCodeSession(input({ writtenAt: CREATED_AT - 1_000 })).lastWriteAt).toBe(
      CREATED_AT - 1_000,
    );
    expect(autohandCodeSession(input({ writtenAt: CREATED_AT - 1_001 }))).not.toHaveProperty(
      "lastWriteAt",
    );
    expect(autohandCodeSession(input({ writtenAt: NOW + 120_000 }))).not.toHaveProperty(
      "lastWriteAt",
    );
    expect(autohandCodeSession(input({ facts: null, writtenAt: null }))).not.toHaveProperty(
      "lastWriteAt",
    );
  });

  test("has its process only from this poll's heartbeat, and no link, jump, stop or tokens", () => {
    const session = autohandCodeSession(input());
    expect(session).toMatchObject({ pid: PID, alive: true, id: `autohand-code:${SESSION_ID}` });
    const ended = autohandCodeSession(input({ status: "finished", process: null }));
    expect(ended).not.toHaveProperty("pid");
    expect(ended).not.toHaveProperty("alive");
    for (const absent of ["jump", "stop", "tokens", "waitingText", "waitingDetail", "ask"]) {
      expect(session, absent).not.toHaveProperty(absent);
    }
    expect(session.links).toEqual({});
  });

  test("gives a reason only while it needs you, and is stale after a day idle", () => {
    expect(
      autohandCodeSession(input({ status: "needs-you", waitingReason: "other" })).waitingReason,
    ).toBe("other");
    expect(
      autohandCodeSession(input({ status: "idle", waitingReason: "other" })),
    ).not.toHaveProperty("waitingReason");
    const day = 24 * 60 * 60_000;
    expect(autohandCodeSession(input({ status: "idle", statusSince: NOW - day })).stale).toBe(true);
    expect(autohandCodeSession(input({ status: "idle", statusSince: NOW - day + 1 })).stale).toBe(
      false,
    );
  });
});
