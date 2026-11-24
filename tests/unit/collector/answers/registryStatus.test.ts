import { describe, expect, test, vi } from "vitest";

import type { Session } from "@core/sessions/session";
import { GRACE_MS, type HeldWait } from "@collector/answers/heldAsks";
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
    since: 1_700,
    pid: 4241,
  });
  expect(readFile.mock.calls.map(([file]) => asWritten(file))).toEqual([FILE]);
});

test("a wait whose file gives no status time has no time it began", async () => {
  const { status } = reader([listed], {
    [FILE]: entry({ status: "waiting", waitingFor: "permission prompt" }),
  });
  expect(await status.statusOf(ID)).toEqual({
    status: "waiting",
    wait: "|permission prompt",
    pid: 4241,
  });
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

describe("two processes with the session open", () => {
  const OTHER = "/Users/example/.claude/sessions/4242.json";
  const T = 1_700_000_000_000;
  const waitingSince = (pid: number, since: number, waitingFor = "permission prompt") =>
    JSON.stringify({
      pid,
      sessionId: UUID,
      status: "waiting",
      waitingFor,
      statusUpdatedAt: since,
    });
  /** What the registry says for a request confirmed in the wait of the process that is not listed. */
  const readFor = (request: HeldWait, listedFile: string, otherFile?: string) =>
    reader([listed], {
      [FILE]: listedFile,
      ...(otherFile !== undefined && { [OTHER]: otherFile }),
    }).status.statusOf(ID, request);

  test("a request stays with the process it was confirmed in the wait of", async () => {
    const own = { arrivedAt: T, pid: 4242, since: T + 200 };
    const other = waitingSince(4242, T + 200);
    for (const listedFile of [
      entry({ status: "busy" }),
      waitingSince(4241, T + 60_000, "input needed"),
      waitingSince(4241, T + 60_000),
      waitingSince(4241, T + 1_000),
    ]) {
      expect(await readFor(own, listedFile, other), listedFile).toMatchObject({
        status: "waiting",
        pid: 4242,
        since: T + 200,
      });
    }
    // What that one does lets it go, and nothing else.
    const waits = waitingSince(4241, T + 60_000);
    const busy = JSON.stringify({ pid: 4242, sessionId: UUID, status: "busy" });
    expect(await readFor(own, waits, busy)).toEqual({ status: "not-waiting" });
    expect(await readFor(own, waits)).toEqual({ status: "unknown" });
    const another = JSON.stringify({ ...JSON.parse(other), sessionId: "someone-else" });
    expect(await readFor(own, waits, another)).toEqual({ status: "unknown" });
  });

  test("one confirmed in an older wait of the other is read in its own, once that is listed", async () => {
    const early = { arrivedAt: T, pid: 4242, since: T - 60_000 };
    const other = waitingSince(4242, T - 60_000);
    const pidFor = async (since: number) => {
      const reading = await readFor(early, waitingSince(4241, since), other);
      return reading.status === "waiting" ? reading.pid : reading.status;
    };
    for (const since of [T - 1_000, T, T + 500, T + GRACE_MS]) {
      expect(await pidFor(since), String(since - T)).toBe(4241);
    }
    for (const since of [T - 1_001, T + GRACE_MS + 1]) {
      expect(await pidFor(since), String(since - T)).toBe(4242);
    }
    expect(await readFor(early, entry({ status: "waiting" }), other)).toMatchObject({ pid: 4242 });
  });

  test("and before it is confirmed, the process that is listed is read", async () => {
    const reading = await readFor(
      { arrivedAt: T, since: null },
      waitingSince(4241, T - 60_000),
      waitingSince(4242, T),
    );
    expect(reading).toMatchObject({ status: "waiting", pid: 4241 });
  });
});
