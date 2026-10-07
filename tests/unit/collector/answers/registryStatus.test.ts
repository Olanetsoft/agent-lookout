import { expect, test, vi } from "vitest";

import type { Session } from "@core/sessions/session";
import { createRegistryStatus } from "@collector/answers/registryStatus";
import { makeSession } from "@tests/fixtures/session";
import { asWritten } from "@tests/support/paths";

const UUID = "00000000-0000-4000-8000-000000000001";
const ID = `claude-code:${UUID}`;

function reader(sessions: Session[], files: Record<string, string>) {
  const readFile = vi.fn(async (file: string) => {
    const content = files[asWritten(file)];
    if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return content;
  });
  const status = createRegistryStatus({
    snapshot: () => ({ generatedAt: 1, sources: [], sessions }),
    env: { AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/.claude" },
    readFile,
  });
  return { status, readFile };
}

const listed = makeSession({ id: ID, status: "needs-you", pid: 4241, alive: true });
const FILE = "/Users/example/.claude/sessions/4241.json";
const entry = (fields: Record<string, unknown>) =>
  JSON.stringify({ pid: 4241, sessionId: UUID, kind: "interactive", ...fields });

const PERMISSION = { status: "waiting", waitingFor: "permission prompt", statusUpdatedAt: 1_700 };

test("the session's own registry file is read again, by the pid the collector lists it with", async () => {
  const { status, readFile } = reader([listed], { [FILE]: entry(PERMISSION) });
  expect(await status.statusOf(ID)).toEqual({
    status: "waiting",
    wait: "1700|permission prompt",
  });
  expect(readFile.mock.calls.map(([file]) => asWritten(file))).toEqual([FILE]);
});

test("a later wait reads as another wait: its time or its reason differs", async () => {
  const later = reader([listed], { [FILE]: entry({ ...PERMISSION, statusUpdatedAt: 1_800 }) });
  const first = reader([listed], { [FILE]: entry(PERMISSION) });
  expect(await later.status.statusOf(ID)).not.toEqual(await first.status.statusOf(ID));
});

test("any other status, or a wait for anything but permission, is not waiting", async () => {
  for (const said of [
    { status: "busy" },
    { status: "idle" },
    { status: "shell" },
    { status: "waiting", waitingFor: "input needed" },
    { status: "waiting" },
  ]) {
    const { status } = reader([listed], { [FILE]: entry(said) });
    expect(await status.statusOf(ID), JSON.stringify(said)).toEqual({ status: "not-waiting" });
  }
});

test("a file that is gone, of another session or another pid, or unreadable, says nothing", async () => {
  for (const content of [
    undefined,
    entry({ ...PERMISSION, sessionId: "someone-else" }),
    entry({ ...PERMISSION, pid: 9999 }),
    "not json",
  ]) {
    const files: Record<string, string> = content === undefined ? {} : { [FILE]: content };
    const { status } = reader([listed], files);
    expect(await status.statusOf(ID)).toEqual({ status: "unknown" });
  }
});

test("a session the collector does not list, with no pid, or whose process ended, is not read", async () => {
  for (const sessions of [
    [],
    [{ ...listed, pid: undefined }],
    [{ ...listed, alive: false }],
    [{ ...listed, source: "codex" as const }],
  ]) {
    const { status, readFile } = reader(sessions, { [FILE]: entry(PERMISSION) });
    expect(await status.statusOf(ID)).toEqual({ status: "unknown" });
    expect(readFile).not.toHaveBeenCalled();
  }
});
