import { describe, expect, test } from "vitest";

import {
  AGENT_DIR_NOTE,
  BASIS,
  BASIS_WITHOUT_PROCESSES,
  BUN_NOTE,
  FOLDERS_CHECK_MS,
  NEWER_FORMAT_NOTE,
  NOT_A_SESSION_NOTE,
  OH_MY_PI_CAPABILITIES,
  ompNamesFor,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  PS_FAILED_NOTE,
  RECHECK_MS,
  SESSION_DIR_NOTE,
  STATUS_NOTE,
  TOO_FAR_NOTE,
  UNCHECKED_NOTE,
  UNREAD_NOTE,
  WINDOWS_NOTE,
} from "@collector/adapters/oh-my-pi/index";
import { MAX_TAIL_BYTES } from "@collector/adapters/oh-my-pi/tail";
import {
  DSH_TABLE_ARGS,
  dshInTable,
  dshWriter,
  type DshPrograms,
} from "@collector/adapters/deepseek-harness/processes";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { EMPTY_CHANGE_MEMORY, sessionChanges } from "@core/notices/sessionChanges";
import { CLOCK_SLACK_MS, WRITE_TIME_STEP_MS } from "@core/time";
import {
  codexLines,
  CWD,
  header,
  HOME,
  HOUR,
  iso,
  line,
  message,
  MINUTE,
  NOW,
  passedLines,
  PRIVATE_CODEX_TITLE,
  PRIVATE_WORDS,
  PROJECT_FOLDER,
  PROJECT_FOLDER_NAME,
  SECOND,
  SESSION_ID,
  sessionExit,
  sessionIdOf,
  sessionPath,
  SESSIONS,
  sessionText,
  toolStart,
} from "@tests/fixtures/oh-my-pi/ohMyPi";
import {
  appendSession,
  BOOT_AT,
  handClock,
  memoryFiles,
  ohMyPiAdapterFor,
  OMP_LINE,
  OWN_PID,
  psLine,
  standInPs,
  writeSession,
} from "@tests/support/adapters/oh-my-pi/ohMyPiAdapter";
import { asWritten } from "@tests/support/paths";

const FILE = sessionPath();
const MAC_NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE} ${BUN_NOTE}`;
const LINUX_NOTES = `${STATUS_NOTE} ${UNCHECKED_NOTE}`;
const READ_DETAIL = `Sessions are read from the files Oh My Pi keeps in ~/.omp/agent/sessions. ${MAC_NOTES}`;
const MAC_RUN =
  "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no omp, .omp-wrapped or bun";

/** The rows Sources shows. */
function watching(read: string, folder = "~/.omp/agent/sessions", processCheckRun = MAC_RUN) {
  return [
    { label: "Sessions folder", value: folder },
    { label: "Read", value: read },
    {
      label: "Files read",
      value:
        "Line 1 and line 2 of each .jsonl, the start of line 3, and its newest lines back to the one that decides, at most 8 MiB, as bytes. Only the title, line 2 and three times become text",
    },
    { label: "Process check", value: "ps -A -o pid=,lstart=,comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

/** A file system with one session's file, written a minute before `NOW` unless a test says otherwise. */
function filesWith(text: string = sessionText(), mtimeMs = NOW - MINUTE, file = FILE) {
  const files = memoryFiles();
  writeSession(files, file, text, mtimeMs);
  return files;
}

/** The status of the one session a poll lists, after two polls, so its title is read too. */
async function statusOf(text: string, options: Parameters<typeof ohMyPiAdapterFor>[1] = {}) {
  const files = filesWith(text);
  const adapter = ohMyPiAdapterFor(files, options);
  await adapter.poll();
  return (await adapter.poll()).sessions[0];
}

describe("an Oh My Pi that is not there", () => {
  test("is not found, calmly, and looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const ps = standInPs();
    const adapter = ohMyPiAdapterFor(files, { now: clock.now, ps });
    expect(adapter.lookingIn).toBe("Looking for Oh My Pi sessions in ~/.omp/agent/sessions.");
    expect(adapter.capabilities).toBe(OH_MY_PI_CAPABILITIES);
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "oh-my-pi",
      label: "Oh My Pi",
      state: "unavailable",
      detail:
        "Oh My Pi was not found: there is no ~/.omp/agent/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    clock.advance(RECHECK_MS - SECOND);
    files.forget();
    await adapter.poll();
    expect(files.count("readdir")).toBe(0);
    clock.advance(SECOND);
    await adapter.poll();
    expect(files.count("readdir")).toBe(1);
    expect(ps.runs).toHaveLength(0);
  });

  test("a missing Oh My Pi is looked for again on a poll whose clock was set back", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = ohMyPiAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).health.state).toBe("unavailable");
    writeSession(files, FILE, sessionText(message("user")), NOW - HOUR - MINUTE);
    files.forget();
    clock.set(NOW - HOUR);
    const { health, sessions } = await adapter.poll();
    expect(files.count("readdir", (target) => target === SESSIONS)).toBe(1);
    expect(health.state).toBe("ok");
    expect(sessions).toHaveLength(1);
  });

  test("a home Agent Lookout's own setting names with no sessions is an answer, not a missing Oh My Pi", async () => {
    const files = memoryFiles();
    const adapter = ohMyPiAdapterFor(files, {
      env: { AGENT_LOOKOUT_OMP_HOME: `${HOME}/omp-empty` },
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_OMP_HOME is set, and there is no ~/omp-empty/sessions folder, so no Oh My Pi sessions are listed. ${MAC_NOTES}`,
    );
    expect(health.watching?.[0]).toEqual({
      label: "Sessions folder",
      value: "~/omp-empty/sessions",
    });
  });

  test("a folder that cannot be listed is an error", async () => {
    const files = memoryFiles();
    files.mkdir(SESSIONS);
    files.fail(SESSIONS);
    const { health } = await ohMyPiAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail:
        "Oh My Pi sessions could not be read: the folder ~/.omp/agent/sessions could not be listed.",
    });
  });

  test("something unexpected is said as a sentence", async () => {
    const files = filesWith();
    const monotonic = () => {
      throw new TypeError("boom");
    };
    const { health } = await ohMyPiAdapterFor(files, { monotonic }).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "Something unexpected went wrong while reading Oh My Pi sessions.",
    });
  });
});

describe("a session's status", () => {
  test("working while a prompt, a result or a tool is newest and an omp backs it", async () => {
    for (const lines of [
      message("user"),
      message("user") + message("assistant") + message("toolResult"),
      message("user") + toolStart("bash"),
    ]) {
      expect(await statusOf(sessionText(lines))).toMatchObject({
        status: "working",
        statusSince: null,
        lastWriteAt: NOW - MINUTE,
      });
    }
  });

  test("needs you while its ask tool waits, since the ask began", async () => {
    const session = await statusOf(
      sessionText(message("user") + toolStart("ask", NOW - 2 * MINUTE)),
    );
    expect(session).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 2 * MINUTE,
      waitingReason: "question",
    });
  });

  test("finished or failed once Oh My Pi writes that it stopped, even after an aborted result and reply", async () => {
    expect(
      await statusOf(sessionText(message("user") + sessionExit("normal", NOW - 3 * MINUTE))),
    ).toMatchObject({
      status: "finished",
      statusSince: NOW - 3 * MINUTE,
    });
    expect(
      await statusOf(
        sessionText(
          toolStart("bash") +
            sessionExit("fatal", NOW - 3 * MINUTE) +
            message("toolResult") +
            message("assistant"),
        ),
      ),
    ).toMatchObject({ status: "failed", statusSince: NOW - 3 * MINUTE });
  });

  test("finished or failed once Oh My Pi writes that it stopped, when its abort starts tools after the exit, and with no ps asked", async () => {
    const exitAt = NOW - MINUTE;
    /** A quit mid-turn: what Oh My Pi's abort writes after the exit, within 15 seconds of it. */
    const quit = (kind: "normal" | "fatal") => [
      sessionText(
        message("user") +
          toolStart("bash", exitAt - MINUTE) +
          sessionExit(kind, exitAt) +
          message("toolResult") +
          toolStart("bash", exitAt) +
          message("toolResult") +
          message("assistant"),
      ),
      sessionText(
        message("user") +
          sessionExit(kind, exitAt) +
          message("assistant") +
          toolStart("bash", exitAt) +
          message("toolResult"),
      ),
    ];
    for (const kind of ["normal", "fatal"] as const) {
      const status = kind === "fatal" ? "failed" : "finished";
      for (const text of quit(kind)) {
        const windows = ohMyPiAdapterFor(filesWith(text, exitAt + 5 * SECOND), {
          platform: "win32",
        });
        expect((await windows.poll()).sessions[0]).toMatchObject({
          status,
          statusSince: exitAt,
        });
        const ps = standInPs([OMP_LINE]);
        const mac = ohMyPiAdapterFor(filesWith(text, exitAt + 5 * SECOND), { ps });
        expect((await mac.poll()).sessions[0]).toMatchObject({ status, statusSince: exitAt });
        expect(ps.runs).toHaveLength(0);
      }
    }
  });

  test("a round after the exit, as /retry runs, written more than 15 seconds after it, is not finished by it", async () => {
    const exitAt = NOW - MINUTE;
    const files = filesWith(sessionText(message("user") + sessionExit("normal", exitAt)), exitAt);
    const clock = handClock();
    const adapter = ohMyPiAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: exitAt,
    });
    const roundAt = exitAt + 20 * SECOND;
    const statuses: (string | undefined)[] = [];
    for (const step of [
      toolStart("bash", roundAt),
      message("toolResult", { at: roundAt }),
      toolStart("bash", roundAt),
      message("toolResult", { at: roundAt }),
      message("assistant", { at: roundAt }),
    ]) {
      appendSession(files, FILE, step, roundAt);
      clock.advance(2 * SECOND);
      statuses.push((await adapter.poll()).sessions[0]?.status);
    }
    expect(statuses).toEqual(["working", "working", "working", "working", "unknown"]);
  });

  test("a rename long after an exit its abort wrote a tool's start after leaves it finished since the exit, with no ps asked", async () => {
    const exitAt = NOW - 2 * HOUR;
    /** A quit mid-turn: the aborted reply, then a tool's start and its aborted result, a moment after the exit. */
    const text = sessionText(
      message("user", { at: exitAt - MINUTE }) +
        sessionExit("normal", exitAt) +
        message("assistant", { at: exitAt + SECOND }) +
        toolStart("bash", exitAt + SECOND) +
        message("toolResult", { at: exitAt + 2 * SECOND }),
    );
    const renameAt = NOW - MINUTE;
    /** The line a rename from the picker, or `/rename`, adds: no prompt. */
    const rename = line({
      type: "title_change",
      id: "0000000a",
      parentId: "00000009",
      timestamp: iso(renameAt),
      title: "demo-project",
      source: "user",
    });
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const files = filesWith(text, exitAt + 5 * SECOND);
      // The omp whose picker renames it, which started after the exit.
      const ps = standInPs([OMP_LINE]);
      const adapter = ohMyPiAdapterFor(files, { platform, ps });
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        status: "finished",
        statusSince: exitAt,
      });
      appendSession(files, FILE, rename, renameAt);
      const renamed = (await adapter.poll()).sessions[0];
      expect(renamed, platform).toMatchObject({ status: "finished", statusSince: exitAt });
      expect(renamed, platform).not.toHaveProperty("lastWriteAt");
      expect(ps.runs, platform).toHaveLength(0);
    }
  });

  test("a rename long after a session ended on a reply or a result with no exit leaves it finished since that line, with one Finished", async () => {
    const endAt = NOW - 2 * HOUR;
    /** The line a rename from another omp's picker adds, as its slot is rewritten: no prompt. */
    const rename = (at: number) =>
      line({
        type: "title_change",
        id: "0000000a",
        parentId: "00000009",
        timestamp: iso(at),
        title: "demo-project",
        source: "user",
      });
    const ended = [
      // `/new` leaves the old session on its reply, with no exit.
      message("user", { at: endAt - MINUTE }) + message("assistant", { at: endAt }),
      // A crash leaves it on a tool's result.
      message("user", { at: endAt - MINUTE }) +
        toolStart("bash", endAt - MINUTE) +
        message("toolResult", { at: endAt }),
    ];
    const header = { at: endAt - 2 * MINUTE };
    for (const lines of ended) {
      const files = filesWith(sessionText(lines, { header }), endAt);
      const clock = handClock();
      // The omp that wrote it, which started before.
      const ps = standInPs([psLine(7001, endAt - HOUR, "omp")]);
      const adapter = ohMyPiAdapterFor(files, { now: clock.now, ps });
      let memory = EMPTY_CHANGE_MEMORY;
      const shown: { status?: string; since?: number | null }[] = [];
      const changes: string[] = [];
      const poll = async () => {
        const result = await adapter.poll();
        const session = result.sessions[0];
        shown.push({ status: session?.status, since: session?.statusSince });
        const next = sessionChanges(memory, {
          generatedAt: clock.now(),
          sources: [{ ...result.health, basis: result.basis }],
          sessions: result.sessions,
        });
        memory = next.memory;
        changes.push(...next.changes.map(({ event }) => event));
      };
      await poll();
      // It quits.
      ps.set([]);
      clock.advance(PROCESS_CHECK_MS);
      await poll();
      // Another omp, started long after, renames it from its picker.
      clock.advance(PROCESS_CHECK_MS);
      ps.set([psLine(7003, clock.now() - 8 * SECOND, "omp")]);
      const renameAt = clock.now() - 4 * SECOND;
      const slot = { title: "demo-project", source: "user", updatedAt: renameAt } as const;
      files.rewrite(FILE, sessionText(lines + rename(renameAt), { slot, header }), {
        mtimeMs: renameAt,
      });
      await poll();
      // That omp quits.
      ps.set([]);
      clock.advance(PROCESS_CHECK_MS);
      await poll();
      expect(shown).toEqual([
        { status: "unknown", since: null },
        { status: "finished", since: endAt },
        { status: "finished", since: endAt },
        { status: "finished", since: endAt },
      ]);
      expect(changes).toEqual(["finished"]);
    }
  });

  test("a copy, as a fork, a branch or an import makes, whose lines keep their times, is backed by the omp that made it", async () => {
    const endAt = NOW - 2 * HOUR;
    const copiedAt = NOW - MINUTE;
    const text = sessionText(
      message("user", { at: endAt - MINUTE }) + message("assistant", { at: endAt }),
      { header: { at: copiedAt } },
    );
    const clock = handClock();
    // The omp that made the copy, which started after the reply it copied.
    const ps = standInPs([psLine(7003, copiedAt - 10 * MINUTE, "omp")]);
    const adapter = ohMyPiAdapterFor(filesWith(text, copiedAt), { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "unknown",
      statusSince: null,
    });
    ps.set([]);
    clock.advance(PROCESS_CHECK_MS);
    // Finished since it was made, not since a reply from before it began.
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: copiedAt,
    });
  });

  test("an aborted line after the exit, written more than 15 seconds after it, is not finished by it, whenever the file was last written", async () => {
    const exitAt = NOW - 2 * MINUTE;
    const lateAt = exitAt + 15 * SECOND + 1;
    const text = sessionText(
      message("user", { at: exitAt - MINUTE }) +
        sessionExit("normal", exitAt) +
        toolStart("bash", exitAt) +
        message("toolResult", { at: lateAt }),
    );
    // A disk that keeps a file's time in steps of 2 seconds puts its last write within 15 seconds of the exit.
    const writtenAt = exitAt + 14 * SECOND;
    const ps = standInPs([OMP_LINE]);
    const adapter = ohMyPiAdapterFor(filesWith(text, writtenAt), { ps });
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "working" });
    expect(ps.runs).toHaveLength(1);
    const windows = ohMyPiAdapterFor(filesWith(text, writtenAt), { platform: "win32" });
    expect((await windows.poll()).sessions[0]).toMatchObject({ status: "unknown" });
  });

  test("unknown after a reply, as idle never shows", async () => {
    expect(await statusOf(sessionText())).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("finished once no omp that started before its last write runs, by a ps asked late enough", async () => {
    const ps = standInPs([psLine(7001, NOW - MINUTE + MINUTE + SECOND, "omp")]);
    expect(await statusOf(sessionText(message("user")), { ps })).toMatchObject({
      status: "finished",
      statusSince: NOW - MINUTE,
    });
    expect(await statusOf(sessionText(message("user")), { ps: standInPs([]) })).toMatchObject({
      status: "finished",
    });
  });

  test("a turn quiet for 30 minutes is unknown", async () => {
    const files = filesWith(sessionText(message("user")), NOW - 30 * MINUTE);
    const adapter = ohMyPiAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
  });

  test("a needs-you time stays while cache warming moves the file's time", async () => {
    const files = filesWith(sessionText(message("user") + toolStart("ask", NOW - 2 * MINUTE)));
    const clock = handClock();
    const adapter = ohMyPiAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 2 * MINUTE,
    });
    for (let poll = 1; poll <= 3; poll += 1) {
      clock.advance(5 * MINUTE);
      appendSession(files, FILE, passedLines(clock.now()), clock.now());
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        status: "needs-you",
        statusSince: NOW - 2 * MINUTE,
      });
    }
  });

  test("a bun on a Mac may write a session and backs none; on Linux it is no omp at all", async () => {
    const bun = standInPs([psLine(7002, NOW - HOUR, "/Users/example/.bun/bin/bun")]);
    expect(await statusOf(sessionText(message("user")), { ps: bun })).toMatchObject({
      status: "unknown",
    });
    const linux = await statusOf(sessionText(message("user")), {
      platform: "linux",
      ps: standInPs([psLine(7002, NOW - HOUR, "bun")]),
    });
    expect(linux).toMatchObject({ status: "finished" });
    expect(ompNamesFor("linux").maybe.size).toBe(0);
    expect(ompNamesFor("darwin").maybe.has("bun")).toBe(true);
  });

  test("omp's daemon and tiny workers on Linux do not match, and Nix's name does", () => {
    const table = [
      psLine(OWN_PID, NOW, "node"),
      psLine(1, NOW - HOUR, "omp daemon"),
      psLine(2, NOW - HOUR, "omp tiny gpt-4o"),
    ].join("\n");
    expect(dshInTable(table, OWN_PID, ompNamesFor("linux"))).toEqual({
      ok: true,
      ownListed: true,
      programs: [],
    });
    const nix = [psLine(OWN_PID, NOW, "node"), psLine(3, NOW - HOUR, ".omp-wrapped")].join("\n");
    expect(dshInTable(nix, OWN_PID, ompNamesFor("linux"))).toMatchObject({
      programs: [{ desktop: true }],
    });
  });
});

describe("asking ps", () => {
  test("only while a session whose status it could change is listed", async () => {
    const ps = standInPs([OMP_LINE]);
    const finished = filesWith(
      sessionText(message("user") + sessionExit("normal", NOW - 2 * MINUTE)),
    );
    await ohMyPiAdapterFor(finished, { ps }).poll();
    expect(ps.runs).toHaveLength(0);
    // Last written more than a minute before the computer started.
    const old = filesWith(sessionText(message("user")), BOOT_AT - 2 * MINUTE);
    await ohMyPiAdapterFor(old, { ps, now: () => BOOT_AT + HOUR }).poll();
    expect(ps.runs).toHaveLength(0);
    const open = filesWith(sessionText(message("user")));
    await ohMyPiAdapterFor(open, { ps }).poll();
    expect(ps.runs).toEqual([{ args: DSH_TABLE_ARGS, options: { utc: true } }]);
  });

  test("every 10 seconds, and sooner, not within 2 seconds, when a session is written after an answer that listed no omp", async () => {
    const files = filesWith(sessionText(message("user")), NOW - MINUTE);
    const clock = handClock();
    const ps = standInPs([]);
    const adapter = ohMyPiAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(ps.runs).toHaveLength(1);
    // Written up to 2 seconds before the answer: asked again once 2 seconds have passed.
    appendSession(files, FILE, message("user"), clock.now() - SECOND);
    ps.set([psLine(7001, clock.now() - 3 * SECOND, "omp")]);
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    expect(ps.runs).toHaveLength(1);
    clock.advance(PROMPT_PROCESS_CHECK_MS - SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    expect(ps.runs).toHaveLength(2);
    // An omp listed: the next ask waits the full 10 seconds.
    appendSession(files, FILE, message("user"), clock.now());
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);
    clock.advance(PROCESS_CHECK_MS - PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(ps.runs).toHaveLength(3);
  });

  test("an answer that does not list Agent Lookout's own process, or no answer, cannot say", async () => {
    const ps = standInPs([OMP_LINE]);
    ps.own(false);
    const files = filesWith(sessionText(message("user")));
    const adapter = ohMyPiAdapterFor(files, { ps });
    const result = await adapter.poll();
    expect(result.sessions[0]?.status).toBe("unknown");
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toBe(`${READ_DETAIL} ${PS_FAILED_NOTE}`);
    const failing = standInPs();
    failing.fail();
    expect(
      (await ohMyPiAdapterFor(filesWith(sessionText(message("user"))), { ps: failing }).poll())
        .basis,
    ).toBe(BASIS_WITHOUT_PROCESSES);
  });

  test("allows nothing for a rounded write time on an answer asked because the clock was set back, for files unchanged since", async () => {
    const files = filesWith(sessionText(message("user")), NOW - SECOND);
    const clock = handClock();
    const ps = standInPs([]);
    const adapter = ohMyPiAdapterFor(files, { now: clock.now, ps });
    // Asked a second after the write: too soon to tell.
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    clock.set(NOW - SECOND / 2);
    // Set back: asked again, and the file is as that poll found it.
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(ps.runs).toHaveLength(2);
  });

  test("keeps the computer's start at its earliest while it runs", async () => {
    const at = BOOT_AT + HOUR;
    const files = filesWith(sessionText(message("user")), at - MINUTE);
    let uptime = HOUR;
    const ps = standInPs([psLine(7001, BOOT_AT + MINUTE, "omp")]);
    const clock = handClock(at);
    const adapter = ohMyPiAdapterFor(files, { ps, uptimeMs: () => uptime, now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    // The clock less the uptime moves past the last write, as when the clock is set forward: the start stays.
    uptime = 0;
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    // A start worked out as earlier is taken.
    uptime = 2 * HOUR + SECOND;
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a session last written more than a minute before the computer started is finished, with no ps asked", async () => {
    const ps = standInPs([OMP_LINE]);
    const files = filesWith(sessionText(message("user")), BOOT_AT - 2 * MINUTE);
    const result = await ohMyPiAdapterFor(files, { ps, now: () => BOOT_AT + HOUR }).poll();
    expect(result.sessions[0]).toMatchObject({
      status: "finished",
      statusSince: BOOT_AT - 2 * MINUTE,
    });
    expect(ps.runs).toHaveLength(0);
  });

  test("on a Mac, a clock set back keeps the start rule from finishing a write made since", async () => {
    const files = filesWith(sessionText(message("user")), NOW - MINUTE);
    const clock = handClock();
    let mono = 0;
    const ps = standInPs([psLine(7001, NOW - 2 * MINUTE, "omp")]);
    const adapter = ohMyPiAdapterFor(files, { now: clock.now, monotonic: () => mono, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    // The clock is set back an hour, and omp, started before, writes after: its start looks later.
    clock.set(NOW - HOUR);
    mono += 2 * SECOND;
    appendSession(files, FILE, message("user"), NOW - HOUR + SECOND);
    clock.advance(10 * SECOND);
    mono += 10 * SECOND;
    expect((await adapter.poll()).sessions[0]?.status).not.toBe("finished");
  });
});

describe("the files", () => {
  test("of two files that hold one ID, the newer is kept", async () => {
    const files = filesWith(sessionText(message("user")), NOW - MINUTE);
    writeSession(
      files,
      sessionPath(SESSION_ID, `${SESSIONS}/-other`),
      sessionText(toolStart("ask")),
      NOW - 2 * MINUTE,
    );
    const { sessions } = await ohMyPiAdapterFor(files).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.status).toBe("working");
  });

  test("goes by the open file's time when it is later than the lstat's", async () => {
    const files = filesWith(sessionText(message("user")), NOW - 40 * MINUTE);
    let written = false;
    const io: ReadOnlyIo = {
      ...files.io,
      async lstat(target) {
        const info = await files.io.lstat(target);
        if (!written && asWritten(target) === FILE) {
          written = true;
          files.append(FILE, message("user"), { mtimeMs: NOW - MINUTE });
        }
        return info;
      },
    };
    const { sessions } = await ohMyPiAdapterFor(files, { io }).poll();
    expect(sessions[0]).toMatchObject({ status: "working", lastWriteAt: NOW - MINUTE });
  });

  test("a link at a file's name or at its project folder's is not followed", async () => {
    const files = memoryFiles();
    files.special(FILE);
    expect((await ohMyPiAdapterFor(files).poll()).sessions).toEqual([]);
    expect(files.count("openRegular")).toBe(0);
    const linked = filesWith();
    const io: ReadOnlyIo = {
      ...linked.io,
      async lstat(target) {
        const info = await linked.io.lstat(target);
        return asWritten(target) === PROJECT_FOLDER ? { ...info, kind: "other" } : info;
      },
    };
    expect((await ohMyPiAdapterFor(linked, { io }).poll()).sessions).toEqual([]);
    expect(linked.count("openRegular")).toBe(0);
  });

  test("the folder of a session's own files beside it is never listed", async () => {
    const files = filesWith();
    writeSession(
      files,
      `${PROJECT_FOLDER}/2026-10-01T11-00-00-000Z_${SESSION_ID}/agent-1.jsonl`,
      sessionText(toolStart("ask")),
    );
    const { sessions } = await ohMyPiAdapterFor(files).poll();
    expect(sessions).toHaveLength(1);
    expect(
      files.count(
        "readdir",
        (target) => target.includes(`_${SESSION_ID}/`) || target.endsWith(`_${SESSION_ID}`),
      ),
    ).toBe(0);
  });

  test("reads the files in the folder PI_CODING_AGENT_SESSION_DIR names, flat", async () => {
    const flat = "/Users/example/flat-sessions";
    const files = filesWith(
      sessionText(message("user")),
      NOW - MINUTE,
      sessionPath(SESSION_ID, flat),
    );
    const result = await ohMyPiAdapterFor(files, {
      env: { PI_CODING_AGENT_SESSION_DIR: flat },
    }).poll();
    expect(result.sessions).toHaveLength(1);
    expect(result.health.watching?.[0]).toEqual({
      label: "Sessions folder",
      value: "~/flat-sessions",
    });
  });

  test("works out the folder again on a poll whose clock was set back", async () => {
    const xdg = "/Users/example/.local/share";
    const files = filesWith(sessionText(message("user")));
    const clock = handClock();
    const adapter = ohMyPiAdapterFor(files, { now: clock.now, env: { XDG_DATA_HOME: xdg } });
    expect((await adapter.poll()).health.watching?.[0]).toEqual({
      label: "Sessions folder",
      value: "~/.omp/agent/sessions",
    });
    writeSession(
      files,
      sessionPath(sessionIdOf(2), `${xdg}/omp/sessions/${PROJECT_FOLDER_NAME}`),
      sessionText(message("user"), { header: { id: sessionIdOf(2) } }),
      NOW - HOUR - MINUTE,
    );
    clock.set(NOW - HOUR);
    const moved = await adapter.poll();
    expect(moved.sessions.map((session) => session.id)).toEqual([`oh-my-pi:${sessionIdOf(2)}`]);
    expect(moved.health.watching?.[0]).toEqual({
      label: "Sessions folder",
      value: "~/.local/share/omp/sessions",
    });
  });

  test("works out the folder again once a minute, and a folder that moved is read afresh", async () => {
    const xdg = "/Users/example/.local/share";
    const files = filesWith(sessionText(message("user")));
    const clock = handClock();
    const adapter = ohMyPiAdapterFor(files, { now: clock.now, env: { XDG_DATA_HOME: xdg } });
    expect(adapter.lookingIn).toBe(
      "Looking for Oh My Pi sessions in ~/.local/share/omp/sessions, when ~/.local/share/omp is there, or else ~/.omp/agent/sessions.",
    );
    expect((await adapter.poll()).sessions).toHaveLength(1);
    expect(adapter.lookingIn).toBe("Looking for Oh My Pi sessions in ~/.omp/agent/sessions.");
    // Oh My Pi's XDG folder is made: within the minute the answer holds.
    writeSession(
      files,
      sessionPath(sessionIdOf(2), `${xdg}/omp/sessions/${PROJECT_FOLDER_NAME}`),
      sessionText(message("user"), { header: { id: sessionIdOf(2) } }),
    );
    clock.advance(FOLDERS_CHECK_MS - SECOND);
    expect((await adapter.poll()).sessions[0]?.id).toBe(`oh-my-pi:${SESSION_ID}`);
    clock.advance(SECOND);
    const moved = await adapter.poll();
    expect(moved.sessions.map((session) => session.id)).toEqual([`oh-my-pi:${sessionIdOf(2)}`]);
    expect(moved.health.watching?.[0]).toEqual({
      label: "Sessions folder",
      value: "~/.local/share/omp/sessions",
    });
    expect(adapter.lookingIn).toBe("Looking for Oh My Pi sessions in ~/.local/share/omp/sessions.");
    expect(files.count("stat")).toBe(2);
  });

  test("the folder Oh My Pi keeps a project's files in reaches nothing shown or kept", async () => {
    const result = await ohMyPiAdapterFor(
      filesWith(sessionText(message("user"), { header: { cwd: CWD } })),
    ).poll();
    const text = JSON.stringify(result);
    expect(text).not.toContain(PROJECT_FOLDER_NAME);
    expect(result.sessions[0]).toMatchObject({ cwd: CWD, project: "demo-project" });
  });

  test("nothing of a prompt, a reply, a tool, a summary or a Codex session's copy's title reaches a session or the card", async () => {
    const files = filesWith(
      sessionText(
        message("user") +
          passedLines() +
          toolStart("bash") +
          message("toolResult") +
          message("assistant"),
      ),
    );
    writeSession(
      files,
      sessionPath(sessionIdOf(2)),
      sessionText(codexLines(1), {
        slot: { title: PRIVATE_CODEX_TITLE, source: "auto" },
        header: { id: sessionIdOf(2) },
      }),
    );
    const adapter = ohMyPiAdapterFor(files);
    await adapter.poll();
    const text = JSON.stringify(await adapter.poll());
    for (const word of PRIVATE_WORDS) expect(text).not.toContain(word);
  });
});

describe("the card", () => {
  test("says what it reads, with the Mac's note, and names the way", async () => {
    const result = await ohMyPiAdapterFor(filesWith(sessionText(message("user")))).poll();
    expect(result.health).toMatchObject({
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
    });
    expect(result.basis).toBe(BASIS);
    const linux = await ohMyPiAdapterFor(filesWith(sessionText(message("user"))), {
      platform: "linux",
    }).poll();
    expect(linux.health.detail).toBe(
      `Sessions are read from the files Oh My Pi keeps in ~/.omp/agent/sessions. ${LINUX_NOTES}`,
    );
    expect(linux.health.watching?.[4]?.value).toBe(
      "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no omp or .omp-wrapped",
    );
  });

  test("names each cause of unknown, a file not a session's and a newer one", async () => {
    const files = filesWith(sessionText(message("user") + "garbage\n"));
    writeSession(
      files,
      sessionPath(sessionIdOf(2)),
      header({ id: sessionIdOf(2) }) + message("user"),
    );
    writeSession(
      files,
      sessionPath(sessionIdOf(3)),
      sessionText(message("user"), { header: { id: sessionIdOf(3), version: 4 } }),
    );
    const big = `{"type":"model_usage","pad":"${"x".repeat(MAX_TAIL_BYTES)}"}\n`;
    writeSession(
      files,
      sessionPath(sessionIdOf(4)),
      sessionText(message("user") + big, { header: { id: sessionIdOf(4) } }),
    );
    const { health, sessions } = await ohMyPiAdapterFor(files).poll();
    expect(sessions.map((session) => session.status)).toEqual(["unknown", "unknown"]);
    expect(health.detail).toBe(
      `${READ_DETAIL} ${TOO_FAR_NOTE} ${UNREAD_NOTE} ${NOT_A_SESSION_NOTE} ${NEWER_FORMAT_NOTE}`,
    );
  });

  test("says when a setting of Oh My Pi's is passed over", async () => {
    const env = { PI_CODING_AGENT_SESSION_DIR: "sessions", PI_CODING_AGENT_DIR: "agent" };
    const { health } = await ohMyPiAdapterFor(filesWith(sessionText(message("user"))), {
      env,
    }).poll();
    expect(health.detail).toBe(`${READ_DETAIL} ${SESSION_DIR_NOTE} ${AGENT_DIR_NOTE}`);
    const missing = await ohMyPiAdapterFor(memoryFiles(), { env }).poll();
    expect(missing.health.detail).toContain(` ${SESSION_DIR_NOTE} ${AGENT_DIR_NOTE}`);
  });
});

describe("on Windows", () => {
  test("ps is never run, a session is finished or failed only by its exit, and anything else is unknown", async () => {
    const ps = standInPs([]);
    const files = filesWith(sessionText(message("user")));
    writeSession(
      files,
      sessionPath(sessionIdOf(2)),
      sessionText(sessionExit("normal", NOW - 2 * MINUTE), { header: { id: sessionIdOf(2) } }),
    );
    writeSession(
      files,
      sessionPath(sessionIdOf(3)),
      sessionText(toolStart("ask"), { header: { id: sessionIdOf(3) } }),
    );
    const result = await ohMyPiAdapterFor(files, { platform: "win32", ps }).poll();
    expect(ps.runs).toHaveLength(0);
    expect(new Map(result.sessions.map((session) => [session.id, session.status]))).toEqual(
      new Map([
        [`oh-my-pi:${SESSION_ID}`, "unknown"],
        [`oh-my-pi:${sessionIdOf(2)}`, "finished"],
        [`oh-my-pi:${sessionIdOf(3)}`, "unknown"],
      ]),
    );
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toBe(
      `Sessions are read from the files Oh My Pi keeps in ~/.omp/agent/sessions. ${LINUX_NOTES} ${WINDOWS_NOTE}`,
    );
    expect(result.health.watching?.[4]?.value).toBe("not run on Windows");
  });
});

describe("a time that cannot be right", () => {
  test("an exit stamped ahead of the clock finishes nothing by itself", async () => {
    const ahead = sessionText(
      message("user") + sessionExit("normal", NOW + CLOCK_SLACK_MS + MINUTE),
    );
    expect(await statusOf(ahead)).toMatchObject({ status: "unknown" });
  });

  test("a write a moment before ps was asked is not finished by it", async () => {
    const files = filesWith(sessionText(message("user")), NOW - WRITE_TIME_STEP_MS + 1);
    const { sessions } = await ohMyPiAdapterFor(files, { ps: standInPs([]) }).poll();
    expect(sessions[0]?.status).toBe("unknown");
  });

  test("a header's start is shown", async () => {
    const session = await statusOf(sessionText(message("user"), { header: { at: NOW - HOUR } }));
    expect(session?.startedAt).toBe(NOW - HOUR);
  });
});

describe("the writer, from ps, as the adapter asks dshWriter", () => {
  const WRITTEN = NOW - MINUTE;
  const BOOT = NOW - 24 * 60 * MINUTE;
  const answer = (starts: number[], backing = true): DshPrograms => ({
    ok: true,
    ownListed: true,
    programs: starts.map((start) => ({ start, desktop: backing })),
  });
  const writer = (
    programs: DshPrograms,
    input: {
      writtenAt?: number;
      answerAt?: number;
      clockSetBack?: boolean;
      platform?: NodeJS.Platform;
      bootAt?: number;
    } = {},
  ) =>
    dshWriter({
      platform: input.platform ?? "darwin",
      writtenAt: input.writtenAt ?? WRITTEN,
      bootAt: input.bootAt ?? BOOT,
      answer: programs,
      answerAt: input.answerAt ?? NOW,
      clockSetBack: input.clockSetBack,
      startFloor: -Infinity,
      lowAt: Infinity,
    });

  test("an omp that started at or before 60 seconds after the last write backs it", () => {
    expect(writer(answer([WRITTEN + MINUTE]))).toBe("backed");
    expect(writer(answer([WRITTEN + MINUTE + 1]))).toBe("gone");
    expect(writer(answer([WRITTEN - MINUTE], false))).toBe("maybe");
  });

  test("an answer asked less than 2 seconds after the last write cannot finish it, unless the clock was set back", () => {
    expect(writer(answer([]), { answerAt: WRITTEN + WRITE_TIME_STEP_MS })).toBe("gone");
    expect(writer(answer([]), { answerAt: WRITTEN + WRITE_TIME_STEP_MS - 1 })).toBe("maybe");
    expect(writer(answer([]), { answerAt: WRITTEN, clockSetBack: true })).toBe("gone");
  });

  test("a last write more than a minute before the computer started is gone, and Windows is never asked", () => {
    expect(writer({ ok: false }, { bootAt: WRITTEN + MINUTE + 1 })).toBe("gone");
    expect(writer(answer([]), { platform: "win32" })).toBe("maybe");
  });
});
