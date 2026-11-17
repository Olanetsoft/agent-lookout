import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_WITHOUT_PROCESSES,
  before2215,
  DEEPSEEK_HARNESS_CAPABILITIES,
  MAX_CHILD_LOGS,
  MAX_HEADER_READS,
  MAX_SESSIONS,
  NEWER_FORMAT_NOTE,
  NO_ZSTD_ADVICE,
  OLDER_FORMAT_NOTE,
  PS_FAILED_NOTE,
  RELATIVE_HOME_NOTE,
  STATUS_NOTE,
  TOO_LONG_NOTE,
  UNCHECKED_NOTE,
  UNREAD_NOTE,
  WINDOWS_NOTE,
} from "@collector/adapters/deepseek-harness/index";
import { QUIET_MS } from "@core/mapping/deepseek-harness/deepseekHarnessMapping";
import {
  batch,
  CHILD_ID,
  childHeaderLine,
  DAY,
  endedTurn,
  HOME,
  headerLine,
  line,
  logPath,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  SESSION_ID,
  SESSIONS_DIR,
  sessionIdOf,
  STARTED_AT,
  uuidOf,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";
import {
  BOOT_AT,
  deepseekHarnessAdapterFor,
  handClock,
  memoryFiles,
  OWN_PID,
  psLine,
  standInPs,
  writeLog,
  type MemoryFiles,
} from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";
import {
  compressedLog,
  frame,
  HAS_ZSTD,
  NO_ZSTD_REASON,
} from "@tests/support/adapters/deepseek-harness/frames";
import { watchDecodingWhile } from "@tests/support/adapters/unreal-agent/decodeSpy";

const T = NOW - 10 * MINUTE;
const ID = `deepseek-harness:${SESSION_ID}`;

/** A plain log, so these tests hold on a Node.js without Zstandard. */
const plain = (
  files: MemoryFiles,
  text: string | Uint8Array,
  options: Parameters<typeof writeLog>[2] = {},
) => writeLog(files, text, { compressed: false, ...options });

/** A `ps` that shows a node started before every session. */
const nodeRuns = () => standInPs([psLine(100, STARTED_AT - HOUR_BEFORE, "node")]);
const HOUR_BEFORE = 60 * MINUTE;

describe("the adapter", () => {
  test("declares what it can report, and says where it looks", () => {
    const adapter = deepseekHarnessAdapterFor(memoryFiles());
    expect(adapter.capabilities).toBe(DEEPSEEK_HARNESS_CAPABILITIES);
    expect(adapter.id).toBe("deepseek-harness");
    expect(adapter.label).toBe("DeepSeek Harness");
    expect(adapter.lookingIn).toBe("Looking for DeepSeek Harness sessions in ~/.dsh/sessions.");
  });

  test("with no sessions folder, is not found, looks again once a minute, and runs nothing", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const ps = standInPs();
    const adapter = deepseekHarnessAdapterFor(files, { now: clock.now, ps });
    const first = await adapter.poll();
    expect(first.health).toMatchObject({
      state: "unavailable",
      detail:
        "DeepSeek Harness was not found: there is no ~/.dsh/sessions folder. Agent Lookout looks again every minute.",
    });
    expect(first.sessions).toEqual([]);
    files.forget();
    clock.advance(30 * SECOND);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    clock.advance(30 * SECOND);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
    // A clock set back counts as time enough.
    files.forget();
    clock.set(NOW - 10 * MINUTE);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
    expect(ps.runs).toEqual([]);
  });

  test("named by AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME with no sessions folder there, that is an answer, looked for on every poll", async () => {
    const files = memoryFiles();
    const adapter = deepseekHarnessAdapterFor(files, {
      env: { AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: "/Users/example/empty" },
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(
      "AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME is set, and there is no ~/empty/sessions folder, so no DeepSeek Harness sessions are listed.",
    );
    files.forget();
    await adapter.poll();
    expect(files.count("stat")).toBe(1);
  });

  test("a sessions folder that is not a folder, or cannot be listed, is an error", async () => {
    const file = memoryFiles();
    file.write(SESSIONS_DIR, "x");
    expect((await deepseekHarnessAdapterFor(file).poll()).health).toMatchObject({
      state: "error",
      detail: "DeepSeek Harness sessions could not be read: ~/.dsh/sessions is not a folder.",
    });
    const refused = memoryFiles();
    refused.mkdir(SESSIONS_DIR);
    refused.fail(SESSIONS_DIR, "EACCES");
    expect((await deepseekHarnessAdapterFor(refused).poll()).health).toMatchObject({
      state: "error",
      detail:
        "DeepSeek Harness sessions could not be read: the folder ~/.dsh/sessions could not be listed.",
    });
  });

  test("a DSH_HOME that is not absolute is passed over, and said so", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    const { health } = await deepseekHarnessAdapterFor(files, {
      env: { DSH_HOME: "relative/dsh" },
    }).poll();
    expect(health.detail).toContain(RELATIVE_HOME_NOTE);
  });

  test("says what it reads and runs, with no Node.js version in it", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    const { health } = await deepseekHarnessAdapterFor(files).poll();
    expect(health.watching).toEqual([
      { label: "Sessions folder", value: "~/.dsh/sessions" },
      { label: "Read", value: "every 2 seconds" },
      { label: "Zstandard", value: "node:zlib" },
      { label: "Process check", value: "ps -A -o pid=,lstart=,comm=" },
      { label: "Process check run", value: "every 10 seconds at most" },
    ]);
    expect(health.detail).toBe(
      `Sessions are read from the logs DeepSeek Harness keeps in ~/.dsh/sessions. ${STATUS_NOTE} ${UNCHECKED_NOTE}`,
    );
    const windows = await deepseekHarnessAdapterFor(files, {
      platform: "win32",
      zstd: null,
    }).poll();
    expect(windows.health.watching).toContainEqual({
      label: "Zstandard",
      value: "not in this Node.js",
    });
    expect(windows.health.watching).toContainEqual({
      label: "Process check run",
      value: "not run on Windows",
    });
  });

  test("never rejects: what goes wrong is a sentence", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T)));
    const broken = deepseekHarnessAdapterFor(files, {
      uptimeMs: () => {
        throw new Error("uptime");
      },
    });
    expect((await broken.poll()).health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading DeepSeek Harness sessions.",
    });
  });
});

describe("a session", () => {
  test("is shown with its title, folder and status, and nothing private", async () => {
    const files = memoryFiles();
    plain(
      files,
      headerLine() +
        batch(
          line.turnStart(0, T),
          line.userMessage(1, T + 1),
          line.title(2, T + 2, PRIVATE_WORDS[8], "fallback"),
          line.title(3, T + 3, "Fix the build", "provider"),
          line.toolCall(4, T + 4, "call_1", "bash"),
          line.approvalAsked(5, T + 5),
        ),
    );
    const { sessions, basis } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions).toEqual([
      {
        id: ID,
        source: "deepseek-harness",
        surface: "unknown",
        name: "Fix the build",
        cwd: `${HOME}/code/demo-project`,
        project: "demo-project",
        status: "needs-you",
        waitingReason: "permission",
        startedAt: STARTED_AT,
        statusSince: T + 5,
        links: {},
        stale: false,
      },
    ]);
    expect(basis).toBe(BASIS);
    for (const word of PRIVATE_WORDS) expect(JSON.stringify(sessions), word).not.toContain(word);
  });

  test("only the header, IDs, kinds and a title of its own are turned into text", async () => {
    const files = memoryFiles();
    plain(
      files,
      headerLine() +
        batch(
          line.turnStart(0, T),
          line.userMessage(1, T),
          line.assistantMessage(2, T),
          line.title(3, T, PRIVATE_WORDS[8], "fallback"),
          line.toolCall(
            4,
            T,
            "call_1",
            "exit_plan_mode",
            JSON.stringify({ plan: PRIVATE_WORDS[7] }),
          ),
          line.toolResult(5, T, "call_1"),
          line.approvalAsked(6, T),
          line.approvalDecided(7, T),
          line.turnEnd(8, T, "error"),
          line.aborted(9, T, "hook"),
        ),
    );
    plain(files, childHeaderLine() + batch(line.title(0, T, "Child title", "provider")), {
      id: CHILD_ID,
    });
    const adapter = deepseekHarnessAdapterFor(files, { ps: nodeRuns() });
    const seen = await watchDecodingWhile(() => adapter.poll());
    for (const word of [...PRIVATE_WORDS, "Child title"])
      expect(seen.join(" "), word).not.toContain(word);
  });

  test("of a subagent is not shown, and its turns count for its session", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(...endedTurn(0, T)));
    plain(files, childHeaderLine() + batch(line.turnStart(0, T + 60_000)), { id: CHILD_ID });
    const { sessions } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions.map((one) => [one.id, one.status, one.statusSince])).toEqual([
      [ID, "working", T + 60_000],
    ]);
  });

  test("of a subagent's subagent counts for the session at the top, and one of no session shown is read no further than its first line", async () => {
    const files = memoryFiles();
    const grandchild = sessionIdOf(3);
    plain(files, headerLine() + batch(...endedTurn(0, T)));
    plain(files, childHeaderLine() + batch(...endedTurn(0, T)), { id: CHILD_ID });
    plain(
      files,
      childHeaderLine(grandchild, CHILD_ID) +
        batch(line.turnStart(0, T + 1), line.approvalAsked(1, T + 2)),
      {
        id: grandchild,
      },
    );
    const orphan = sessionIdOf(4);
    const orphanLog = plain(
      files,
      childHeaderLine(orphan, "session-gone") + batch(line.turnStart(0, T)),
      { id: orphan },
    );
    const adapter = deepseekHarnessAdapterFor(files, { ps: nodeRuns() });
    const { sessions } = await adapter.poll();
    expect(sessions.map((one) => [one.id, one.status])).toEqual([[ID, "needs-you"]]);
    const orphanReads = files.reads.filter((one) => one.path === orphanLog);
    expect(orphanReads.every((one) => one.position + one.length <= 4096)).toBe(true);
    expect(orphanReads).toHaveLength(1);
    files.forget();
    await adapter.poll();
    expect(files.count("openRegular")).toBe(0);
  });

  test("a subagent's write keeps its session's open turn working, past 30 minutes of its own quiet", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, NOW - 40 * MINUTE)), {
      mtimeMs: NOW - 40 * MINUTE,
    });
    plain(files, childHeaderLine() + batch(...endedTurn(0, NOW - 2 * MINUTE)), {
      id: CHILD_ID,
      mtimeMs: NOW - MINUTE,
    });
    const { sessions } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions[0]).toMatchObject({ status: "working", lastWriteAt: NOW - MINUTE });
  });

  test("an open turn quiet for 30 minutes is unknown, and a wait too, unless the desktop app runs", async () => {
    const files = memoryFiles();
    const quiet = NOW - QUIET_MS;
    plain(
      files,
      headerLine() + batch(line.turnStart(0, quiet - MINUTE), line.approvalAsked(1, quiet)),
      { mtimeMs: quiet },
    );
    expect(
      (await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll()).sessions[0]?.status,
    ).toBe("unknown");
    const desktop = standInPs([psLine(13, STARTED_AT - MINUTE, "DeepSeek Harness")]);
    expect(
      (await deepseekHarnessAdapterFor(files, { ps: desktop }).poll()).sessions[0],
    ).toMatchObject({
      status: "needs-you",
      statusSince: quiet,
    });
    const windows = await deepseekHarnessAdapterFor(files, { platform: "win32" }).poll();
    expect(windows.sessions[0]?.status).toBe("unknown");
  });

  test("a wait that goes on across polls keeps the time it began, though its first ask is answered", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const file = plain(
      files,
      headerLine() + batch(line.turnStart(0, T), line.approvalAsked(1, T + 1, uuidOf(7, 1))),
    );
    const adapter = deepseekHarnessAdapterFor(files, { now: clock.now, ps: nodeRuns() });
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(T + 1);
    files.append(file, batch(line.approvalAsked(2, T + 5, uuidOf(7, 2))));
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(T + 1);
    files.append(file, batch(line.approvalDecided(3, T + 6, uuidOf(7, 1))));
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(T + 1);
    // A wait that shares nothing with the last is new.
    files.append(
      file,
      batch(
        line.approvalDecided(4, T + 7, uuidOf(7, 2)),
        line.toolCall(5, T + 8, "call_9", "ask_user_question"),
      ),
    );
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      statusSince: T + 8,
      waitingReason: "question",
    });
  });

  test("an error is failed whatever ps says, until the session is reopened", async () => {
    const files = memoryFiles();
    const file = plain(files, headerLine() + batch(...endedTurn(0, T, "error")));
    const adapter = deepseekHarnessAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "failed",
      statusSince: T + 3,
    });
    files.append(file, batch(line.endSeed(4, NOW - MINUTE, false)));
    const reopened = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(reopened.sessions[0]).toMatchObject({ status: "idle", statusSince: NOW - MINUTE });
  });

  test("a fork's copied end, and the closers after it, are not its own", async () => {
    const files = memoryFiles();
    plain(
      files,
      headerLine({ isSeeded: true }) +
        batch(
          line.turnStart(0, STARTED_AT - DAY),
          line.aborted(1, STARTED_AT - DAY, "disposed"),
          line.endSeed(2, STARTED_AT - DAY, true),
          line.turnEnd(3, STARTED_AT - DAY, "forked"),
        ),
    );
    expect(
      (await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll()).sessions[0],
    ).toMatchObject({
      status: "idle",
      statusSince: STARTED_AT,
    });
  });

  test("closed mid-turn by DeepSeek Harness is finished; with no program left, finished since its last write", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T), line.aborted(1, T + 1, "disposed")));
    expect((await deepseekHarnessAdapterFor(files).poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: T + 1,
    });
    const gone = memoryFiles();
    plain(gone, headerLine() + batch(line.turnStart(0, T)), { mtimeMs: T + 5 });
    expect((await deepseekHarnessAdapterFor(gone).poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: T + 5,
    });
  });

  test("a crash mid-turn, mid-approval, and the resume that follows", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const ps = nodeRuns();
    const file = plain(
      files,
      headerLine() +
        batch(
          line.turnStart(0, T),
          line.toolCall(1, T + 1, "call_1", "bash"),
          line.approvalAsked(2, T + 2),
        ),
      {
        mtimeMs: T + 2,
      },
    );
    const adapter = deepseekHarnessAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    // Killed: no program that could write it is left.
    ps.set([]);
    clock.advance(10 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    // Reopened: the resume closes the turn, and marks where it was reopened.
    ps.set([psLine(200, NOW, "node")]);
    files.append(
      file,
      batch(
        line.syntheticResult(3, T + 2, "call_1"),
        line.turnEnd(4, T + 2, "interrupted"),
        line.endSeed(5, NOW + 10 * SECOND, false),
      ),
      { mtimeMs: NOW + 10 * SECOND },
    );
    clock.advance(10 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: NOW + 10 * SECOND,
    });
  });

  test("last written more than a minute before the computer started is finished, and ps is not asked for it", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T)), { mtimeMs: T });
    const ps = nodeRuns();
    const { sessions } = await deepseekHarnessAdapterFor(files, {
      ps,
      uptimeMs: () => NOW - T - 2 * MINUTE,
    }).poll();
    expect(sessions[0]?.status).toBe("finished");
    expect(ps.runs).toEqual([]);
  });

  test("whose log is in a newer format, first seen so, is not shown; one already read shows as unknown", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T)));
    files.write(logPath(SESSION_ID, { compressed: false, version: 5 }), "x");
    const fresh = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(fresh.sessions).toEqual([]);
    expect(fresh.health.detail).toContain(NEWER_FORMAT_NOTE);
    expect(files.count("openRegular")).toBe(0);

    const later = memoryFiles();
    const clock = handClock();
    plain(
      later,
      headerLine() + batch(line.turnStart(0, T), line.title(1, T, "Fix the build", "user")),
    );
    const adapter = deepseekHarnessAdapterFor(later, { now: clock.now, ps: nodeRuns() });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    later.write(logPath(SESSION_ID, { compressed: false, version: 5 }), "x");
    clock.advance(60 * SECOND);
    later.forget();
    const { sessions, health } = await adapter.poll();
    expect(sessions.map((one) => [one.id, one.name, one.status])).toEqual([
      [ID, "Fix the build", "unknown"],
    ]);
    expect(health.detail).toContain(NEWER_FORMAT_NOTE);
    expect(later.count("openRegular")).toBe(0);
  });

  test("with only logs of an older format, is not shown, and said so", async () => {
    const files = memoryFiles();
    files.write(logPath(SESSION_ID, { version: 3 }), "x");
    const { sessions, health } = await deepseekHarnessAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(health.detail).toContain(OLDER_FORMAT_NOTE);
  });

  test("whose folder holds logs of both kinds is not shown", async () => {
    const files = memoryFiles();
    plain(files, headerLine());
    files.write(logPath(SESSION_ID, { version: 3 }), "x");
    expect((await deepseekHarnessAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("whose lines cannot be followed is unknown, and said so", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T), line.turnStart(7, T)));
    const { sessions, health } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(health.detail).toContain(UNREAD_NOTE);
  });

  test("whose log is too long to read is unknown, with its folder's name, and said so", async () => {
    const files = memoryFiles();
    const header = headerLine();
    const big = new Uint8Array(64 * 1024 * 1024 + 1);
    big.set(new TextEncoder().encode(header));
    big.fill(0x0a, header.length);
    plain(files, big);
    const { sessions, health } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions[0]).toMatchObject({ name: "demo-project", status: "unknown" });
    expect(health.detail).toContain(TOO_LONG_NOTE);
  });

  test("a log older than a day is left out", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(...endedTurn(0, T)), { mtimeMs: NOW - DAY - 1 });
    expect((await deepseekHarnessAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("two folders of one session's name are shown once, the newest", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(...endedTurn(0, T, "error")), { mtimeMs: NOW - MINUTE });
    plain(files, headerLine() + batch(...endedTurn(0, T)), {
      project: "--other--",
      mtimeMs: NOW - SECOND,
    });
    const { sessions } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions.map((one) => one.status)).toEqual(["idle"]);
  });
});

describe("its times", () => {
  test("a log written ahead of the clock gives an open turn no last write, so it is unknown and never finished", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T)), { mtimeMs: NOW + 5 * MINUTE });
    // ps shows no program that could write it: with a last write that could be right, it would be finished.
    const { sessions } = await deepseekHarnessAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({ status: "unknown" });
    expect(sessions[0]).not.toHaveProperty("lastWriteAt");
  });

  test("a session that began after its log's time that cannot be right is listed, with no start", async () => {
    const files = memoryFiles();
    plain(files, headerLine({ createdAt: NOW + 5 * MINUTE }) + batch(line.turnStart(0, T)));
    const { sessions } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions[0]).toMatchObject({ startedAt: null, status: "working" });
  });

  test("what a log said after polls is what a fresh read of it says", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const file = plain(files, headerLine() + batch(line.turnStart(0, T)));
    const adapter = deepseekHarnessAdapterFor(files, { now: clock.now, ps: nodeRuns() });
    await adapter.poll();
    files.append(
      file,
      batch(line.title(1, T + 1, "First name", "provider"), line.turnEnd(2, T + 2, "completed")),
    );
    clock.advance(2 * SECOND);
    await adapter.poll();
    files.append(
      file,
      batch(line.turnStart(3, T + 3, 2), line.title(4, T + 4, PRIVATE_WORDS[8], "fallback")),
    );
    clock.advance(2 * SECOND);
    const polled = (await adapter.poll()).sessions;
    const fresh = (
      await deepseekHarnessAdapterFor(files, { now: clock.now, ps: nodeRuns() }).poll()
    ).sessions;
    expect(polled).toEqual(fresh);
    expect(polled[0]).toMatchObject({
      name: "demo-project",
      status: "working",
      statusSince: T + 3,
    });
  });
});

describe("its caps", () => {
  test(`reads at most ${MAX_HEADER_READS} first lines a poll, and shows at most ${MAX_SESSIONS} sessions`, async () => {
    const files = memoryFiles();
    const count = MAX_HEADER_READS + 10;
    for (let n = 0; n < count; n++) {
      const id = sessionIdOf(n + 100);
      plain(files, headerLine({ id }) + batch(...endedTurn(0, T)), { id, mtimeMs: NOW - n * 10 });
    }
    const adapter = deepseekHarnessAdapterFor(files, { ps: nodeRuns() });
    files.forget();
    const first = await adapter.poll();
    expect(first.sessions).toHaveLength(MAX_SESSIONS);
    // Each of the shown ones read on, from what its first look left open.
    expect(files.count("openRegular")).toBe(MAX_HEADER_READS + MAX_SESSIONS);
    files.forget();
    await adapter.poll();
    expect(files.count("openRegular")).toBe(10);
  });

  test(`reads at most ${MAX_CHILD_LOGS} subagents' logs past their first line`, async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(...endedTurn(0, T)));
    for (let n = 0; n < MAX_CHILD_LOGS + 5; n++) {
      const id = sessionIdOf(n + 500);
      plain(files, childHeaderLine(id) + batch(line.turnStart(0, T)), {
        id,
        mtimeMs: NOW - n * 10 - 5_000,
      });
    }
    const adapter = deepseekHarnessAdapterFor(files, { ps: nodeRuns() });
    files.forget();
    await adapter.poll();
    // One for each first line, one for the session, one for each subagent read on.
    expect(files.count("openRegular")).toBe(MAX_CHILD_LOGS + 5 + 1 + 1 + MAX_CHILD_LOGS);
  });
});

describe("ps", () => {
  test("is asked only while a session's status can change with it, and at most every 10 seconds", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const ps = nodeRuns();
    const file = plain(files, headerLine() + batch(...endedTurn(0, T, "error")));
    const adapter = deepseekHarnessAdapterFor(files, { now: clock.now, ps });
    await adapter.poll();
    expect(ps.runs).toEqual([]);
    files.append(file, batch(line.endSeed(4, T + 10, false)));
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    clock.advance(9 * SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    clock.advance(SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);
    // A clock set back counts as time enough.
    clock.set(NOW - MINUTE);
    await adapter.poll();
    expect(ps.runs).toHaveLength(3);
    expect(ps.runs[0]).toEqual({
      args: ["-A", "-o", "pid=,lstart=,comm="],
      options: { utc: true },
    });
  });

  test("is never asked on Windows, where a session is never finished by it and the way of reading is named apart", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(line.turnStart(0, T)), { mtimeMs: T });
    const ps = standInPs();
    const result = await deepseekHarnessAdapterFor(files, {
      platform: "win32",
      ps,
      uptimeMs: () => 1,
    }).poll();
    expect(ps.runs).toEqual([]);
    expect(result.sessions[0]?.status).toBe("working");
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toContain(WINDOWS_NOTE);
  });

  test("that fails, or lists no Agent Lookout, finishes nothing but by the computer's start, and the way of reading follows the answer in use", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const ps = standInPs();
    plain(files, headerLine() + batch(line.turnStart(0, T)), { mtimeMs: T });
    const adapter = deepseekHarnessAdapterFor(files, { now: clock.now, ps });
    ps.fail();
    const failed = await adapter.poll();
    expect(failed.sessions[0]?.status).toBe("working");
    expect(failed.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(failed.health.detail).toContain(PS_FAILED_NOTE);
    // Not asked again within 10 seconds: the answer in use still cannot say.
    ps.set([]);
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).basis).toBe(BASIS_WITHOUT_PROCESSES);
    clock.advance(10 * SECOND);
    const answered = await adapter.poll();
    expect(answered.basis).toBe(BASIS);
    expect(answered.sessions[0]?.status).toBe("finished");
    // A table without Agent Lookout's own process cannot say either.
    ps.own(false);
    clock.advance(10 * SECOND);
    const unlisted = await adapter.poll();
    expect(unlisted.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(unlisted.sessions[0]?.status).toBe("working");
    // The computer's start still finishes a session last written before it.
    const booted = await deepseekHarnessAdapterFor(files, {
      ps,
      uptimeMs: () => NOW - T - 2 * MINUTE,
    }).poll();
    expect(booted.sessions[0]?.status).toBe("finished");
  });

  test("a node started after the last write, beyond a minute, does not keep a session open; one before does", async () => {
    const files = memoryFiles();
    plain(files, headerLine() + batch(...endedTurn(0, T)), { mtimeMs: T + 3 });
    const late = standInPs([psLine(100, T + 3 + 61 * SECOND, "node")]);
    expect((await deepseekHarnessAdapterFor(files, { ps: late }).poll()).sessions[0]?.status).toBe(
      "finished",
    );
    const near = standInPs([psLine(100, T + 3 + 30 * SECOND, "node")]);
    expect((await deepseekHarnessAdapterFor(files, { ps: near }).poll()).sessions[0]?.status).toBe(
      "idle",
    );
    // Agent Lookout's own node, however early it started, is not one.
    const own = standInPs([]);
    expect((await deepseekHarnessAdapterFor(files, { ps: own }).poll()).sessions[0]?.status).toBe(
      "finished",
    );
    expect(OWN_PID).toBeGreaterThan(0);
    expect(BOOT_AT).toBeLessThan(T);
  });
});

describe("without Zstandard", () => {
  test("a computer with only compressed logs lists none, says why, and advises an update below 22.15", async () => {
    const files = memoryFiles();
    writeLog(files, "compressed bytes");
    const old = await deepseekHarnessAdapterFor(files, {
      zstd: null,
      nodeVersion: "v22.14.0",
    }).poll();
    expect(old.health).toMatchObject({
      state: "error",
      detail:
        "This Node.js, v22.14.0, cannot read Zstandard, which DeepSeek Harness compresses its session logs with, so no DeepSeek Harness sessions are listed. Node.js 22.15 and later can.",
      advice: NO_ZSTD_ADVICE,
    });
    const newer = await deepseekHarnessAdapterFor(files, {
      zstd: null,
      nodeVersion: "v24.1.0",
    }).poll();
    expect(newer.health.state).toBe("error");
    expect(newer.health.detail).not.toContain("22.15");
    expect(newer.health).not.toHaveProperty("advice");
    expect(files.count("openRegular")).toBe(0);
  });

  test("uncompressed logs are listed, and the compressed ones counted", async () => {
    const files = memoryFiles();
    writeLog(files, "compressed bytes");
    plain(files, headerLine({ id: sessionIdOf(2) }) + batch(...endedTurn(0, T)), {
      id: sessionIdOf(2),
    });
    const { health, sessions } = await deepseekHarnessAdapterFor(files, {
      zstd: null,
      nodeVersion: "v22.12.0",
      ps: nodeRuns(),
    }).poll();
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
    expect(health.detail).toContain(
      "1 DeepSeek Harness session log is compressed with Zstandard, which this Node.js, v22.12.0, cannot read, so it is not shown. Node.js 22.15 and later can.",
    );
  });

  test("with no logs at all, all is well, and said so", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS_DIR);
    const { health } = await deepseekHarnessAdapterFor(files, {
      zstd: null,
      nodeVersion: "v22.12.0",
    }).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(
      "so a compressed log would not be shown. Node.js 22.15 and later can.",
    );
  });

  test("a version is older than 22.15 by its numbers", () => {
    expect(before2215("v22.14.9")).toBe(true);
    expect(before2215("v20.19.0")).toBe(true);
    expect(before2215("v22.15.0")).toBe(false);
    expect(before2215("v23.1.0")).toBe(false);
    expect(before2215("odd")).toBe(false);
  });
});

describe.skipIf(!HAS_ZSTD)(`compressed logs (${NO_ZSTD_REASON} otherwise)`, () => {
  test("are read as the uncompressed ones are", async () => {
    const files = memoryFiles();
    writeLog(
      files,
      compressedLog(
        headerLine(),
        batch(line.turnStart(0, T)),
        batch(line.title(1, T, "Fix the build", "provider")),
      ),
    );
    const { sessions } = await deepseekHarnessAdapterFor(files, { ps: nodeRuns() }).poll();
    expect(sessions[0]).toMatchObject({ name: "Fix the build", status: "working" });
    expect(frame("x\n").byteLength).toBeGreaterThan(0);
  });
});
