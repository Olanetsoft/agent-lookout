import { describe, expect, test } from "vitest";

import type { AdapterResult } from "@collector/adapters/adapter";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  COUNT_NOTE,
  LONG_NOTE,
  NEWER_FORMAT_NOTE,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  STATUS_NOTE,
  UNCHECKED_NOTE,
  UNREAD_NOTE,
  UNREAL_AGENT_CAPABILITIES,
  unrealAgentSessionsDirFor,
  WINDOWS_DETAIL,
} from "@collector/adapters/unreal-agent/index";
import { KNOWN_WAYS } from "@collector/remotes/remoteSessions";
import { MAX_OPEN_OPERATIONS } from "@core/mapping/unreal-agent/unrealAgentReplay";
import {
  DAY,
  goTime,
  headerLine,
  HOME,
  HOUR,
  idleSession,
  MINUTE,
  NOW,
  PRIVATE_ARGUMENTS,
  PRIVATE_ID,
  PRIVATE_WORDS,
  PROJECT,
  SECOND,
  SESSION_ID,
  SessionLines,
  SESSIONS_DIR,
  sessionPath,
  shellCall,
  shellOperation,
  shellState,
  STARTED_AT,
  uuidOf,
} from "@tests/fixtures/unreal-agent/unrealAgent";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";
import {
  handClock,
  memoryFiles,
  PROGRAM_STARTED_AT,
  standInUnrealProcesses,
  unrealAgentAdapterFor,
  writeSession,
} from "@tests/support/adapters/unreal-agent/unrealAgentAdapter";
import { asWritten } from "@tests/support/paths";

const ALWAYS = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const HEALTHY = `Sessions are read from the files Unreal Agent keeps in ~/.local/state/unreal-agent/sessions. ${ALWAYS}`;
const ID = `unreal-agent:${SESSION_ID}`;

function watching(
  read: string,
  folder = "~/.local/state/unreal-agent/sessions",
  run = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no Unreal Agent",
) {
  return [
    { label: "Sessions folder", value: folder },
    { label: "Read", value: read },
    { label: "Process check", value: "ps -A -o lstart=,comm=" },
    { label: "Process check run", value: run },
  ];
}

const statusOf = (result: AdapterResult, id = ID) =>
  result.sessions.find((session) => session.id === id)?.status;

const FILL = "@@FILL@@";

/** A file's bytes, with the `FILL` mark in its text made 65 MiB of text, too long to read whole. */
function overLong(text: string): Buffer {
  const [before, after] = text.split(FILL);
  return Buffer.concat([
    Buffer.from(before as string),
    Buffer.alloc(65 * 1024 * 1024, 0x61),
    Buffer.from(after as string),
  ]);
}

/** A session that waits, its first reply 65 MiB long. */
function waitsWithFill(): SessionLines {
  const lines = new SessionLines();
  lines.settings(STARTED_AT).message(STARTED_AT).turn(STARTED_AT).reply(STARTED_AT, { text: FILL });
  lines.message(STARTED_AT).turn(STARTED_AT).reply(STARTED_AT);
  return lines;
}

describe("where it looks", () => {
  test("in ~/.local/state/unreal-agent/sessions, on macOS too, saying so while it looks", () => {
    const adapter = unrealAgentAdapterFor(memoryFiles());
    expect(adapter.lookingIn).toBe(
      "Looking for Unreal Agent sessions in ~/.local/state/unreal-agent/sessions.",
    );
    expect(unrealAgentSessionsDirFor({}, HOME)).toBe(SESSIONS_DIR);
  });

  test("in XDG_STATE_HOME only when it is absolute, and in the folder its own setting names before both", () => {
    expect(unrealAgentSessionsDirFor({ XDG_STATE_HOME: "/Users/example/state" }, HOME)).toBe(
      "/Users/example/state/unreal-agent/sessions",
    );
    for (const value of ["", "relative/state", "~/state", " /Users/example/state"]) {
      expect(unrealAgentSessionsDirFor({ XDG_STATE_HOME: value }, HOME), value).toBe(SESSIONS_DIR);
    }
    expect(
      unrealAgentSessionsDirFor(
        {
          AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: " /Users/example/elsewhere ",
          XDG_STATE_HOME: "/Users/example/state",
        },
        HOME,
      ),
    ).toBe("/Users/example/elsewhere");
  });

  test("reads the files in the folder XDG_STATE_HOME names", async () => {
    const files = memoryFiles();
    const dir = "/Users/example/state/unreal-agent/sessions";
    writeSession(files, idleSession().text(), { dir, mtimeMs: NOW - MINUTE });
    const adapter = unrealAgentAdapterFor(files, {
      env: { XDG_STATE_HOME: "/Users/example/state" },
    });
    const result = await adapter.poll();
    expect(result.health.watching?.[0]).toEqual({
      label: "Sessions folder",
      value: "~/state/unreal-agent/sessions",
    });
    expect(statusOf(result)).toBe("idle");
  });
});

describe("an Unreal Agent that is not there", () => {
  test("is not found, calmly, its folder looked for again only once a minute, and no ps is run", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInUnrealProcesses();
    const adapter = unrealAgentAdapterFor(files, { now: clock.now, processes });
    const first = await adapter.poll();
    expect(first.health).toMatchObject({
      state: "unavailable",
      detail:
        "Unreal Agent was not found: there is no ~/.local/state/unreal-agent/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
    });
    files.forget();
    clock.advance(RECHECK_MS - SECOND);
    await adapter.poll();
    expect(files.count()).toBe(0);
    clock.advance(SECOND);
    writeSession(files, idleSession().text(), { mtimeMs: NOW });
    expect(statusOf(await adapter.poll())).toBe("idle");
    expect(processes.asked.count).toBe(1);
  });

  test("named by AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR with no folder there, that is an answer, looked at on every poll", async () => {
    const files = memoryFiles();
    const adapter = unrealAgentAdapterFor(files, {
      env: { AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: "/Users/example/empty" },
    });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "ok",
      detail: `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR is set, and there is no ~/empty folder, so no Unreal Agent sessions are listed. ${ALWAYS}`,
      watching: watching("not found", "~/empty"),
    });
    files.forget();
    await adapter.poll();
    expect(files.count("readdir")).toBe(1);
  });

  test("a folder that cannot be listed is an error", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    files.fail(SESSIONS_DIR);
    const result = await unrealAgentAdapterFor(files).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail:
        "Unreal Agent sessions could not be read: the folder ~/.local/state/unreal-agent/sessions could not be listed.",
    });
  });
});

describe("on Windows", () => {
  test("nothing is looked at and ps is never run", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text());
    const processes = standInUnrealProcesses();
    const adapter = unrealAgentAdapterFor(files, { platform: "win32", processes });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail: WINDOWS_DETAIL,
      watching: watching(
        "not on Windows",
        "~/.local/state/unreal-agent/sessions",
        "not run on Windows",
      ),
    });
    expect(result.sessions).toEqual([]);
    expect(files.count()).toBe(0);
    expect(processes.asked.count).toBe(0);
  });
});

describe("what is looked at", () => {
  test("only each session's file: a name that is no session file's is never looked up or opened", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - MINUTE });
    const decoys = [
      `${SESSIONS_DIR}/20261006-120000.jsonl`,
      `${SESSIONS_DIR}/notes.jsonl`,
      `${SESSIONS_DIR}/a_b.session.jsonl`,
      `${SESSIONS_DIR}/--demo--/x.session.jsonl`,
      `${SESSIONS_DIR}/operations/${SESSION_ID}/${uuidOf(5, 1)}/out`,
      `${SESSIONS_DIR}/.session-x.tmp`,
    ];
    for (const decoy of decoys) files.write(decoy, PRIVATE_WORDS);
    const result = await unrealAgentAdapterFor(files).poll();
    expect(statusOf(result)).toBe("idle");
    const touched = files.calls.map((call) => call.path);
    expect(touched).toEqual(expect.arrayContaining([SESSIONS_DIR, sessionPath()]));
    for (const call of files.calls) {
      expect([SESSIONS_DIR, sessionPath()], `${call.method} ${call.path}`).toContain(call.path);
    }
    expect(files.count("readdir")).toBe(1);
  });

  test("a link at a session file's name is passed over", async () => {
    const files = memoryFiles();
    files.special(sessionPath());
    files.touch(SESSIONS_DIR, 1);
    const result = await unrealAgentAdapterFor(files).poll();
    expect(result.sessions).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("not a file written over a day ago", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - DAY - SECOND });
    expect((await unrealAgentAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("a file whose first line names another session, or is of a newer format, is not listed, and the card says so of the newer", async () => {
    const files = memoryFiles();
    writeSession(files, headerLine(uuidOf(1, 2)), { mtimeMs: NOW });
    writeSession(files, headerLine(uuidOf(1, 3), STARTED_AT, 3), {
      id: uuidOf(1, 3),
      mtimeMs: NOW,
    });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(result.sessions).toEqual([]);
    expect(result.health.detail).toBe(`${HEALTHY} ${NEWER_FORMAT_NOTE}`);
  });
});

describe("a session", () => {
  test("that waits, read whole, while a program that started before it runs, is idle, named after its folder", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - MINUTE });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(result).toMatchObject({ basis: BASIS });
    expect(result.health).toMatchObject({
      state: "ok",
      detail: HEALTHY,
      watching: watching("every 2 seconds"),
    });
    expect(result.sessions).toEqual([
      {
        id: ID,
        source: "unreal-agent",
        surface: "unknown",
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "idle",
        startedAt: STARTED_AT,
        statusSince: STARTED_AT + 9 * SECOND,
        links: {},
        stale: false,
        lastWriteAt: NOW - MINUTE,
      },
    ]);
  });

  test("with an open turn is working, from when the turn began", async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines
      .settings(STARTED_AT + SECOND)
      .message(STARTED_AT + 2 * SECOND)
      .turn(NOW - 5 * MINUTE);
    writeSession(files, lines.text(), { mtimeMs: NOW - 5 * MINUTE });
    const [session] = (await unrealAgentAdapterFor(files).poll()).sessions;
    expect(session).toMatchObject({ status: "working", statusSince: NOW - 5 * MINUTE, name: ID });
  });

  test("whose newest reply failed is failed, whether a program runs or not", async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines.settings(STARTED_AT).message(STARTED_AT).turn(STARTED_AT);
    lines.reply(NOW - 10 * MINUTE, { stop: "max_output_tokens" });
    writeSession(files, lines.text(), { mtimeMs: NOW - 10 * MINUTE });
    const processes = standInUnrealProcesses();
    const adapter = unrealAgentAdapterFor(files, { processes });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "failed",
      statusSince: NOW - 10 * MINUTE,
    });
    processes.running();
    const closed = await unrealAgentAdapterFor(files, { processes }).poll();
    expect(statusOf(closed)).toBe("failed");
  });

  test("quit with Ctrl+C is finished, at its last write", async () => {
    const files = memoryFiles();
    const lines = idleSession();
    lines.hard(NOW - MINUTE);
    writeSession(files, lines.text(), { mtimeMs: NOW - MINUTE });
    expect((await unrealAgentAdapterFor(files).poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
  });

  test("of a runner is finished once it waits", async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines.settings(STARTED_AT).message(STARTED_AT).whenIdle(STARTED_AT).turn(STARTED_AT);
    shellCall(lines, STARTED_AT + SECOND, 1);
    writeSession(files, lines.text(), { mtimeMs: NOW - MINUTE });
    expect(statusOf(await unrealAgentAdapterFor(files).poll())).toBe("working");
    lines.turn(STARTED_AT + 5 * SECOND).reply(STARTED_AT + 6 * SECOND);
    writeSession(files, lines.text(), { mtimeMs: NOW - 30 * SECOND });
    expect(statusOf(await unrealAgentAdapterFor(files).poll())).toBe("finished");
  });

  test("of a runner whose reply is written between its file's lookup and its opening is working", async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines
      .settings(STARTED_AT)
      .message(STARTED_AT)
      .whenIdle(STARTED_AT)
      .turn(NOW - 6 * SECOND);
    const file = writeSession(files, lines.text(), { mtimeMs: NOW - 6 * SECOND });
    const before = lines.text();
    lines.reply(NOW);
    const reply = lines.text().slice(before.length);
    let added = false;
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        // The reply, which its tool calls' statuses can follow, is added after the lookup.
        if (!added && asWritten(target) === file) {
          added = true;
          files.append(file, reply, { mtimeMs: NOW });
        }
        return info;
      },
    };
    const result = await unrealAgentAdapterFor(files, { io }).poll();
    expect(added).toBe(true);
    expect(result.sessions[0]).toMatchObject({ status: "working", lastWriteAt: NOW });
  });

  test("whose file cannot be opened after it grew keeps what was read, and its last write is the lookup's", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const lines = idleSession();
    const file = writeSession(files, lines.text(), { mtimeMs: NOW - MINUTE });
    const adapter = unrealAgentAdapterFor(files, { now: clock.now });
    expect(statusOf(await adapter.poll())).toBe("idle");
    const before = lines.text();
    lines.message(NOW);
    files.append(file, lines.text().slice(before.length), { mtimeMs: NOW });
    files.failOpen(file);
    clock.advance(5 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "idle", lastWriteAt: NOW });
  });

  test("with a line it does not know is unknown, and the card says why", async () => {
    const files = memoryFiles();
    const lines = idleSession();
    lines.control(NOW - MINUTE, "pause");
    writeSession(files, lines.text(), { mtimeMs: NOW - MINUTE });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(statusOf(result)).toBe("unknown");
    expect(result.health.detail).toBe(`${HEALTHY} ${UNREAD_NOTE}`);
  });

  test(`running more than ${MAX_OPEN_OPERATIONS} commands is unknown, as a line it does not read`, async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines.settings(STARTED_AT).message(STARTED_AT).turn(STARTED_AT).reply(STARTED_AT);
    for (let n = 1; n <= MAX_OPEN_OPERATIONS + 1; n += 1) {
      lines.operation(shellOperation(uuidOf(5, n), "awaiting", {}));
    }
    writeSession(files, lines.text(), { mtimeMs: NOW - MINUTE });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(statusOf(result)).toBe("unknown");
    expect(result.health.detail).toContain(UNREAD_NOTE);
  });

  test("that waits in a file over 64 MiB, which is not read whole, is unknown, and the card says why", async () => {
    const files = memoryFiles();
    writeSession(files, overLong(waitsWithFill().text()), { mtimeMs: NOW - MINUTE });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(statusOf(result)).toBe("unknown");
    expect(result.health.detail).toBe(`${HEALTHY} ${LONG_NOTE}`);
  });

  test("that waits in a file over 64 MiB is finished once no program runs, and the card says nothing of its length", async () => {
    const files = memoryFiles();
    writeSession(files, overLong(waitsWithFill().text()), { mtimeMs: NOW - MINUTE });
    const processes = standInUnrealProcesses({ ok: true, starts: [], unknownStart: false });
    const result = await unrealAgentAdapterFor(files, { processes }).poll();
    expect(statusOf(result)).toBe("finished");
    expect(result.health.detail).not.toContain(LONG_NOTE);
  });

  test("quit with Ctrl+C in a file over 64 MiB is finished, and the card says nothing of its length", async () => {
    const files = memoryFiles();
    const lines = waitsWithFill();
    lines.hard(STARTED_AT);
    writeSession(files, overLong(lines.text()), { mtimeMs: NOW - MINUTE });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(statusOf(result)).toBe("finished");
    expect(result.health.detail).toBe(HEALTHY);
  });

  test("quit with Ctrl+C in a file over 64 MiB while an older command ran is finished, and the card says nothing of its length", async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines.settings(STARTED_AT).message(STARTED_AT).turn(STARTED_AT);
    const firstTurn = lines.turnId;
    const op = shellCall(lines, STARTED_AT, 1, { end: false });
    lines.heartbeat(STARTED_AT).turn(STARTED_AT).reply(STARTED_AT, { text: FILL });
    lines.heartbeat(STARTED_AT).turn(STARTED_AT).reply(STARTED_AT).hard(STARTED_AT);
    const done = shellState({ operationId: op, ended: true });
    lines.operation(shellOperation(op, "canceling"));
    lines.operation(shellOperation(op, "canceled", done));
    lines.completed(STARTED_AT, "call_1", [shellOperation(op, "canceled", done)], firstTurn);
    writeSession(files, overLong(lines.text()), { mtimeMs: NOW - MINUTE });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(statusOf(result)).toBe("finished");
    expect(result.health.detail).toBe(HEALTHY);
  });

  test("takes no time more than 2 seconds before its start", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession(SESSION_ID, NOW - HOUR).text(), { mtimeMs: NOW - 2 * HOUR });
    const [session] = (await unrealAgentAdapterFor(files).poll()).sessions;
    expect(session).not.toHaveProperty("lastWriteAt");
  });
});

describe("whether a program could hold a session", () => {
  test("with none running, every session is finished but a failed one, and the card says so", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - MINUTE });
    const failed = new SessionLines(uuidOf(1, 2));
    failed.settings(STARTED_AT).turn(STARTED_AT).reply(STARTED_AT, { stop: "refused" });
    writeSession(files, failed.text(), { id: uuidOf(1, 2), mtimeMs: NOW - MINUTE });
    const processes = standInUnrealProcesses({ ok: true, starts: [], unknownStart: false });
    const result = await unrealAgentAdapterFor(files, { processes }).poll();
    expect(result.basis).toBe(BASIS_CLOSED);
    expect(statusOf(result)).toBe("finished");
    expect(statusOf(result, `unreal-agent:${uuidOf(1, 2)}`)).toBe("failed");
    expect(result.health.detail).toBe(
      `${HEALTHY} No Unreal Agent program runs, so each session shows as finished, unless its last reply failed or Agent Lookout cannot tell how it ended.`,
    );
  });

  test("when ps cannot say, no session is idle or finished, but one that ended", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - MINUTE });
    const ended = idleSession(uuidOf(1, 2));
    ended.hard(STARTED_AT + 20 * SECOND);
    writeSession(files, ended.text(), { id: uuidOf(1, 2), mtimeMs: NOW - MINUTE });
    const processes = standInUnrealProcesses({ ok: false });
    const result = await unrealAgentAdapterFor(files, { processes }).poll();
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(statusOf(result)).toBe("unknown");
    expect(statusOf(result, `unreal-agent:${uuidOf(1, 2)}`)).toBe("finished");
    expect(result.health.detail).toBe(
      `${HEALTHY} ps could not be run to tell whether Unreal Agent runs, so no session is shown as idle, nor as finished unless Unreal Agent wrote that it ended.`,
    );
  });

  test("a session last written before every running program started is finished", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - 30 * MINUTE });
    const processes = standInUnrealProcesses({
      ok: true,
      starts: [NOW - 10 * MINUTE],
      unknownStart: false,
    });
    expect(statusOf(await unrealAgentAdapterFor(files, { processes }).poll())).toBe("finished");
  });

  test("more sessions waiting than programs that could hold them are unknown, and the card says why", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession(SESSION_ID, STARTED_AT).text(), { mtimeMs: NOW - 2 * MINUTE });
    writeSession(files, idleSession(uuidOf(1, 2), STARTED_AT + MINUTE).text(), {
      id: uuidOf(1, 2),
      mtimeMs: NOW - MINUTE,
    });
    const result = await unrealAgentAdapterFor(files).poll();
    expect(result.sessions.map((session) => session.status)).toEqual(["unknown", "unknown"]);
    expect(result.health.detail).toBe(`${HEALTHY} ${COUNT_NOTE}`);
    const two = standInUnrealProcesses({
      ok: true,
      starts: [PROGRAM_STARTED_AT, PROGRAM_STARTED_AT],
      unknownStart: false,
    });
    const balanced = await unrealAgentAdapterFor(files, { processes: two }).poll();
    expect(balanced.sessions.map((session) => session.status)).toEqual(["idle", "idle"]);
  });

  test("a clock set forward on Linux keeps the start rule from closing a session written before", async () => {
    const files = memoryFiles();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - 10 * MINUTE });
    const clock = handClock();
    let mono = 0;
    const processes = standInUnrealProcesses();
    const adapter = unrealAgentAdapterFor(files, {
      now: clock.now,
      monotonic: () => mono,
      platform: "linux",
      processes,
    });
    expect(statusOf(await adapter.poll())).toBe("idle");
    // Two seconds pass, the clock moves an hour, and ps now shows the program as started after the write.
    mono += 2 * SECOND;
    clock.advance(HOUR);
    processes.running(NOW + 30 * MINUTE);
    expect(statusOf(await adapter.poll())).not.toBe("finished");
    // Without the guard, as a poll of a new adapter at that time, the same answer would close it.
    const fresh = unrealAgentAdapterFor(files, { now: clock.now, platform: "linux", processes });
    expect(statusOf(await fresh.poll())).toBe("finished");
  });
});

describe("ps", () => {
  test("is asked only while a session is listed, at most every 10 seconds", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInUnrealProcesses();
    const adapter = unrealAgentAdapterFor(files, { now: clock.now, processes });
    files.mkdir(SESSIONS_DIR);
    await adapter.poll();
    expect(processes.asked.count).toBe(0);
    writeSession(files, idleSession().text(), { mtimeMs: NOW - MINUTE });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(PROCESS_CHECK_MS - SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("is asked again after 2 seconds when a file is written after, or up to 2 seconds before, an answer that showed none", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInUnrealProcesses({ ok: true, starts: [], unknownStart: false });
    const adapter = unrealAgentAdapterFor(files, { now: clock.now, processes });
    writeSession(files, idleSession().text(), { mtimeMs: NOW - MINUTE });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    // Kept a second before the answer, as a disk that keeps whole seconds can.
    writeSession(files, idleSession().text(), { mtimeMs: NOW - SECOND });
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
    clock.advance(SECOND);
    writeSession(files, idleSession().text(), { mtimeMs: clock.now() });
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
    // A clock set back counts as due.
    clock.set(NOW - MINUTE);
    await adapter.poll();
    expect(processes.asked.count).toBe(3);
  });

  test("an answer that showed none closes a session last written over 2 seconds before it", async () => {
    const files = memoryFiles();
    const clock = handClock();
    writeSession(files, idleSession().text(), { mtimeMs: NOW - 10 * SECOND });
    const processes = standInUnrealProcesses({ ok: true, starts: [], unknownStart: false });
    const adapter = unrealAgentAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    // A program starts 20 seconds later, after the write, and is the only one: L3 alone would not close it.
    clock.advance(PROCESS_CHECK_MS);
    processes.running(NOW + 5 * SECOND);
    expect(statusOf(await adapter.poll())).toBe("finished");
  });

  test("the ways it reads are the ones another machine's are taken under", () => {
    expect(KNOWN_WAYS.get("unreal-agent")).toEqual([BASIS, BASIS_CLOSED, BASIS_WITHOUT_PROCESSES]);
  });
});

describe("what leaves the file", () => {
  test("no private word reaches a session or the card, and only IDs, times and the folder are turned into text", async () => {
    const files = memoryFiles();
    const lines = new SessionLines();
    lines
      .settings(STARTED_AT)
      .message(STARTED_AT, PRIVATE_ID)
      .heartbeat(STARTED_AT)
      .turn(STARTED_AT);
    shellCall(lines, STARTED_AT, 1);
    lines.error(STARTED_AT, PRIVATE_ID).turn(STARTED_AT, "compaction").reply(STARTED_AT);
    lines.turn(STARTED_AT).reply(STARTED_AT, { failure: { Code: "x", Message: PRIVATE_WORDS } });
    writeSession(files, lines.text(), { mtimeMs: NOW - MINUTE });
    const adapter = unrealAgentAdapterFor(files);
    let result: AdapterResult | undefined;
    const seen = await watchDecodingWhile(async () => {
      result = await adapter.poll();
    });
    const text = JSON.stringify(result);
    for (const word of [PRIVATE_WORDS, PRIVATE_ARGUMENTS, PRIVATE_ID]) {
      expect(text).not.toContain(word);
      expect(seen.join("\n")).not.toContain(word);
    }
    const allowed = new Set([
      SESSION_ID,
      goTime(STARTED_AT),
      goTime(STARTED_AT + SECOND),
      ...[1, 2, 3, 4].map((n) => uuidOf(3, n)),
      uuidOf(5, 1),
      PROJECT,
      JSON.stringify(PROJECT),
    ]);
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) expect(allowed, value).toContain(value);
    expect(statusOf(result as AdapterResult)).toBe("failed");
  });
});

describe("the declaration", () => {
  test("says nothing needs you, and no Jump, tokens, Stop or Answer", () => {
    expect(UNREAL_AGENT_CAPABILITIES["needs-you"].level).toBe("no");
    for (const capability of ["jump", "tokens", "stop", "answer"] as const) {
      expect(UNREAL_AGENT_CAPABILITIES[capability].level, capability).toBe("no");
    }
    expect(UNREAL_AGENT_CAPABILITIES["quiet-for"]).toEqual({ level: "yes" });
  });
});
