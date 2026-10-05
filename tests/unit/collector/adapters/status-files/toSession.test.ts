import { expect, test } from "vitest";

import { MAX_NAME_LENGTH, type StatusFile } from "@collector/adapters/status-files/statusFile";
import { SOURCE_ID, statusFileSession } from "@collector/adapters/status-files/toSession";
import { STALE_THRESHOLD_MS } from "@core/sessions/staleness";
import { MINUTE, NOW } from "@tests/fixtures/statusFiles";

const FILE: StatusFile = {
  agent: "Night Shift",
  name: "checkout-flow",
  cwd: "/Users/example/code/checkout-flow",
  status: "working",
};

function session(
  file: Partial<StatusFile> = {},
  extra: { statusSince?: number | null; alive?: boolean } = {},
) {
  return statusFileSession({
    fileName: "night-shift.json",
    file: { ...FILE, ...file },
    statusSince: extra.statusSince === undefined ? NOW - MINUTE : extra.statusSince,
    alive: extra.alive,
    now: NOW,
  });
}

test("a status file becomes a session of its own source, named by its file and its agent", () => {
  expect(SOURCE_ID).toBe("status-files");
  expect(session()).toEqual({
    id: "status-files:night-shift.json",
    source: "status-files",
    agent: "Night Shift",
    surface: "unknown",
    name: "checkout-flow",
    cwd: "/Users/example/code/checkout-flow",
    project: "checkout-flow",
    status: "working",
    startedAt: null,
    statusSince: NOW - MINUTE,
    links: {},
    stale: false,
  });
});

test("it never has a link or a Jump, whatever the file holds", () => {
  const made = session();
  expect(made.links).toEqual({});
  expect(made).not.toHaveProperty("jump");
});

test("a session with no name is named after its folder, then after its file", () => {
  expect(session({ name: undefined }).name).toBe("checkout-flow");
  expect(session({ name: undefined, cwd: undefined })).toMatchObject({
    name: "night-shift",
    cwd: null,
    project: null,
  });
});

test("a name taken from the file's name is cleaned and cut as a name in the file is", () => {
  const named = (fileName: string) =>
    statusFileSession({
      fileName,
      file: { agent: "Night Shift", status: "working" },
      statusSince: null,
      now: NOW,
    });
  // A mark that runs the text the other way would show this as "evilexe.txt".
  expect(named("evil‮txt.exe.json").name).toBe("evil txt.exe");
  expect(named("line\nbreak\u0007.json").name).toBe("line break");
  expect(named(`${"a".repeat(250)}.json`).name).toBe("a".repeat(MAX_NAME_LENGTH));
  // With nothing left of it, the agent names the session. The id keeps the file's name.
  expect(named("\u0007.json")).toMatchObject({
    id: "status-files:\u0007.json",
    name: "Night Shift",
  });
});

test("waiting needs the person, with the file's reason", () => {
  expect(session({ status: "waiting", reason: "question" })).toMatchObject({
    status: "needs-you",
    waitingReason: "question",
  });
  expect(session({ status: "waiting" })).toMatchObject({
    status: "needs-you",
    waitingReason: "other",
  });
  expect(session({ status: "waiting" })).not.toHaveProperty("waitingDetail");
});

test("finished, failed and a status this version does not know are said as they are", () => {
  expect(session({ status: "finished" }).status).toBe("finished");
  expect(session({ status: "failed" }).status).toBe("failed");
  expect(session({ status: "paused" }).status).toBe("unknown");
});

test("a pid is passed on with whether its process is alive", () => {
  expect(session({ pid: 4242 }, { alive: true })).toMatchObject({ pid: 4242, alive: true });
  expect(session({ pid: 4242, status: "finished" }, { alive: false })).toMatchObject({
    pid: 4242,
    alive: false,
  });
  expect(session()).not.toHaveProperty("pid");
  expect(session()).not.toHaveProperty("alive");
});

test("an idle session is stale after a day in that status, by the time it is given", () => {
  expect(session({ status: "idle" }, { statusSince: NOW - STALE_THRESHOLD_MS }).stale).toBe(true);
  expect(session({ status: "idle" }, { statusSince: NOW - STALE_THRESHOLD_MS + 1 }).stale).toBe(
    false,
  );
  // Without a time, how long it has been idle was not measured.
  expect(session({ status: "idle" }, { statusSince: null }).stale).toBe(false);
});
