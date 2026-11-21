import { describe, expect, test } from "vitest";

import { DSH_TABLE_ARGS } from "@collector/adapters/deepseek-harness/processes";
import {
  BASIS,
  BASIS_WITHOUT_PROCESSES,
  LINK,
  MUSE_CODE_CAPABILITIES,
  NEWER_FORMAT,
  OTHER_SYSTEM,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  PS_FAILED,
  RECHECK_MS,
  STATUS_ANY,
  STATUS_BOOT,
  STATUS_ENDS,
  STATUS_FIRST_SECONDS,
  STATUS_GONE,
  STATUS_HELD,
  STATUS_READONLY,
  STATUS_REVIEWER,
  STATUS_TIMES,
  STATUS_UNKNOWN,
  STATUS_WAITS,
  STATUS_WRONG,
  TOO_FAR,
  UNCHECKED_BUILT,
  UNCHECKED_NOT,
  UNCHECKED_READERS,
  UNREAD,
  WINDOWS_FOLDER,
  WINDOWS_PS,
  XDG_RELATIVE,
} from "@collector/adapters/muse-code/index";
import { REACH_BYTES } from "@collector/adapters/muse-code/logReader";
import { SWEEP_MS } from "@collector/adapters/pi/sessionFiles";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { REVIEW_LIMIT_MS } from "@core/mapping/muse-code/museCodeMapping";
import { CLOCK_SLACK_MS, WRITE_TIME_STEP_MS } from "@core/time";
import {
  ACTION,
  asked,
  CWD,
  DATA_DIR,
  DAY,
  decided,
  HOME,
  HOUR,
  logPath,
  MINUTE,
  modelChanged,
  NOW,
  opening,
  PRIVATE_WORDS,
  PROMPT,
  renamed,
  replied,
  requested,
  reviewStarted,
  RUN,
  RUN_2,
  SECOND,
  SESSION_ID,
  sessionEnd,
  sessionFolder,
  sessionResumed,
  SESSIONS,
  settled,
  started,
  terminal,
  uuidAt,
} from "@tests/fixtures/muse-code/museCode";
import {
  appendLog,
  handClock,
  memoryFiles,
  MUSE_LINE,
  museCodeAdapterFor,
  OWN_PID,
  psLine,
  standInPs,
  withSessionsFolder,
  writeLog,
} from "@tests/support/adapters/muse-code/museCodeAdapter";

const FILE = logPath();
const OPENED = NOW - 10 * MINUTE;
const ALWAYS_MAC = [
  STATUS_ENDS,
  STATUS_TIMES,
  STATUS_GONE,
  STATUS_BOOT,
  STATUS_HELD,
  STATUS_WAITS,
  STATUS_REVIEWER,
  STATUS_FIRST_SECONDS,
  STATUS_ANY,
  STATUS_WRONG,
  STATUS_UNKNOWN,
  STATUS_READONLY,
  UNCHECKED_BUILT,
  UNCHECKED_READERS,
  UNCHECKED_NOT,
].join(" ");
const READ_DETAIL = `Sessions are read from the logs Muse Code keeps in ~/.local/share/muse/sessions. ${ALWAYS_MAC}`;
const MAC_RUN =
  "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no Muse Code program";

function watching(read: string, folder = "~/.local/share/muse/sessions", run = MAC_RUN) {
  return [
    { label: "Sessions folder", value: folder },
    { label: "Read", value: read },
    {
      label: "Files read",
      value:
        "session.jsonl of each session, as bytes: its first 64 KiB and its newest lines back to the newest turn's start, at most 8 MiB. Only its workspace folder and record IDs become text",
    },
    { label: "Process check", value: "ps -A -o pid=,lstart=,comm=" },
    { label: "Process check run", value: run },
  ];
}

/** A file system with one session's log, written a minute before `NOW` unless a test says otherwise. */
function filesWith(text: string, mtimeMs = NOW - MINUTE, file = FILE) {
  const files = memoryFiles();
  writeLog(files, file, text, mtimeMs);
  return files;
}

/** A session whose folder is three days old, its log written a minute before `NOW`: its opening, then `text` made for its ID. */
function oldSession(text: (id: string) => string) {
  const old = NOW - 3 * DAY;
  const id = uuidAt(old, 3);
  const file = logPath(id, old);
  const files = memoryFiles();
  writeLog(files, file, `${opening(old, RUN, { session: id })}${text(id)}`, NOW - MINUTE);
  return { files, file, id };
}

async function statusOf(
  text: string,
  options: Parameters<typeof museCodeAdapterFor>[1] = {},
  mtimeMs?: number,
) {
  const adapter = museCodeAdapterFor(filesWith(text, mtimeMs), options);
  return (await adapter.poll()).sessions[0];
}

describe("a Muse Code that is not there", () => {
  test("is not found, calmly, and looked for again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const ps = standInPs();
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect(adapter.lookingIn).toBe(
      "Looking for Muse Code sessions in ~/.local/share/muse/sessions.",
    );
    expect(adapter.capabilities).toBe(MUSE_CODE_CAPABILITIES);
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "muse-code",
      label: "Muse Code",
      state: "unavailable",
      detail:
        "Muse Code was not found: there is no ~/.local/share/muse/sessions folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    files.forget();
    clock.advance(RECHECK_MS - 1);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    clock.advance(1);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
    expect(ps.runs).toEqual([]);
  });

  test("a clock set back counts as time enough to look again", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = museCodeAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.set(NOW - HOUR);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
  });

  test("named by AGENT_LOOKOUT_MUSE_CODE_HOME, its missing folder is an answer, looked for on every poll", async () => {
    const files = memoryFiles();
    const adapter = museCodeAdapterFor(files, {
      env: { AGENT_LOOKOUT_MUSE_CODE_HOME: `${HOME}/muse-home` },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_MUSE_CODE_HOME is set, and there is no ~/muse-home/sessions folder, so no Muse Code sessions are listed. ${ALWAYS_MAC}`,
    );
    expect(sessions).toEqual([]);
    expect(basis).toBe(BASIS);
    files.forget();
    await adapter.poll();
    expect(files.count("lstat")).toBe(1);
  });

  test("an XDG_DATA_HOME that is not absolute is passed over, and said", async () => {
    const adapter = museCodeAdapterFor(memoryFiles(), { env: { XDG_DATA_HOME: "data" } });
    expect((await adapter.poll()).health.detail).toBe(
      `Muse Code was not found: there is no ~/.local/share/muse/sessions folder. Agent Lookout looks again every minute. ${XDG_RELATIVE}`,
    );
  });
});

describe("a sessions folder that cannot be read", () => {
  test("a link or a file at sessions/ is not followed, and is an error", async () => {
    for (const make of [
      (files: ReturnType<typeof memoryFiles>) => files.special(SESSIONS),
      (files: ReturnType<typeof memoryFiles>) => files.write(SESSIONS, "x"),
    ]) {
      const files = memoryFiles();
      make(files);
      const { health } = await museCodeAdapterFor(files).poll();
      expect(health).toMatchObject({
        state: "error",
        detail: `Muse Code sessions could not be read: ~/.local/share/muse/sessions is not a folder. ${LINK}`,
        watching: watching("cannot be read"),
      });
      expect(files.count("readdir")).toBe(0);
      expect(files.opened()).toEqual([]);
    }
  });

  test("a folder that cannot be listed is an error", async () => {
    const files = withSessionsFolder(memoryFiles());
    files.failAll("EACCES");
    const { health } = await museCodeAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail:
        "Muse Code sessions could not be read: the folder ~/.local/share/muse/sessions could not be listed.",
    });
  });
});

describe("a session's status, with a Muse Code that started before it was written", () => {
  test("working since its run opened, named after its workspace folder, with its last write", async () => {
    const files = filesWith(`${opening(OPENED)}${replied(RUN, NOW - MINUTE)}`);
    const { health, sessions, basis } = await museCodeAdapterFor(files).poll();
    expect(health).toEqual({
      id: "muse-code",
      label: "Muse Code",
      state: "ok",
      detail: READ_DETAIL,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(basis).toBe(BASIS);
    expect(sessions).toEqual([
      {
        id: `muse-code:${SESSION_ID}`,
        source: "muse-code",
        surface: "unknown",
        name: "demo-project",
        cwd: CWD,
        project: "demo-project",
        status: "working",
        startedAt: NOW - HOUR,
        statusSince: OPENED,
        links: {},
        stale: false,
        lastWriteAt: NOW - MINUTE,
      },
    ]);
  });

  test("idle since its run ended, needing you for a question, and failed", async () => {
    expect(await statusOf(`${opening(OPENED)}${terminal(RUN, NOW - 2 * MINUTE)}`)).toMatchObject({
      status: "idle",
      statusSince: NOW - 2 * MINUTE,
    });
    expect(
      await statusOf(`${opening(OPENED)}${asked(RUN, PROMPT, NOW - 3 * MINUTE)}`),
    ).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: NOW - 3 * MINUTE,
    });
    expect(
      await statusOf(`${opening(OPENED)}${terminal(RUN, NOW - 2 * MINUTE, "failed")}`),
    ).toMatchObject({
      status: "failed",
      statusSince: NOW - 2 * MINUTE,
    });
  });

  test("finished since Muse Code wrote that it let the session go, with no word from ps needed", async () => {
    const ps = standInPs([MUSE_LINE]);
    const adapter = museCodeAdapterFor(
      filesWith(
        `${opening(OPENED)}${terminal(RUN, NOW - 2 * MINUTE, "cancelled")}${sessionEnd(NOW - 90 * SECOND)}`,
      ),
      { ps },
    );
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: NOW - 90 * SECOND,
    });
    expect(ps.runs).toEqual([]);
  });

  test("a session with no run yet, and a log that is not whole yet, is not listed", async () => {
    const files = memoryFiles();
    writeLog(files, FILE, opening(OPENED).split("\n")[0] + "\n", NOW - MINUTE);
    writeLog(files, logPath(uuidAt(NOW, 2)), started(RUN, NOW).slice(0, 40), NOW - MINUTE);
    expect((await museCodeAdapterFor(files).poll()).sessions).toEqual([]);
  });

  test("an approval the reviewer holds shows as working, until 2 minutes pass with no word", async () => {
    const clock = handClock();
    const requestedAt = NOW - 30 * SECOND;
    const files = filesWith(
      `${opening(OPENED)}${requested(RUN, ACTION, requestedAt, "automated_reviewing")}${reviewStarted(RUN, ACTION, requestedAt + 20)}`,
      requestedAt + 20,
    );
    const adapter = museCodeAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    clock.set(requestedAt + REVIEW_LIMIT_MS);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: requestedAt + REVIEW_LIMIT_MS,
    });
  });

  test("a wait kept across polls keeps its time, and a clock set back gives no second notice", async () => {
    const clock = handClock();
    const requestedAt = NOW - 30 * SECOND;
    const files = filesWith(
      `${opening(OPENED)}${requested(RUN, ACTION, requestedAt, "automated_reviewing")}`,
      requestedAt,
    );
    const adapter = museCodeAdapterFor(files, { now: clock.now });
    clock.set(requestedAt + REVIEW_LIMIT_MS + 5 * SECOND);
    const first = (await adapter.poll()).sessions[0];
    expect(first).toMatchObject({
      status: "needs-you",
      statusSince: requestedAt + REVIEW_LIMIT_MS,
    });
    // Set back before the 2 minutes: the approval still waits, since the same time.
    clock.set(requestedAt + 10 * SECOND);
    const back = (await adapter.poll()).sessions[0];
    expect(back).toMatchObject({ status: "needs-you", statusSince: requestedAt + REVIEW_LIMIT_MS });
    // Decided, then working again.
    appendLog(
      files,
      FILE,
      decided(RUN, ACTION, requestedAt + 13 * SECOND),
      requestedAt + 13 * SECOND,
    );
    clock.set(requestedAt + 14 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a session that needs you stays listed however old its last write", async () => {
    const clock = handClock();
    const { files } = oldSession((id) => asked(RUN, PROMPT, NOW - 2 * MINUTE, { session: id }));
    const adapter = museCodeAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    clock.advance(2 * DAY);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    clock.advance(SECOND * 2);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
  });

  test("a session that needs you stays listed however old through a poll where ps cannot say, with its wait's time", async () => {
    const clock = handClock();
    const ps = standInPs([MUSE_LINE]);
    const { files } = oldSession((id) => asked(RUN, PROMPT, NOW - 2 * MINUTE, { session: id }));
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    clock.advance(2 * DAY);
    ps.own(false);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    ps.own(true);
    clock.advance(PROCESS_CHECK_MS + SWEEP_MS);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 2 * MINUTE,
    });
  });

  test("an approval that waited before a poll where ps cannot say still waits after it, through a clock set back", async () => {
    const clock = handClock();
    const ps = standInPs([MUSE_LINE]);
    const requestedAt = NOW - 30 * SECOND;
    const files = filesWith(
      `${opening(OPENED)}${requested(RUN, ACTION, requestedAt, "automated_reviewing")}`,
      requestedAt,
    );
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    clock.set(requestedAt + REVIEW_LIMIT_MS + 5 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    ps.own(false);
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    ps.own(true);
    // Set back before the 2 minutes: the approval still waits, since the same time.
    clock.set(requestedAt + 10 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: requestedAt + REVIEW_LIMIT_MS,
    });
  });

  test("a session leaves the list a day after its last write once a poll finds it waits no more, or if it never waited", async () => {
    const cases: { name: string; after: (id: string) => string; cannotSay?: boolean }[] = [
      {
        name: "answered, then idle",
        after: (id) =>
          `${settled(RUN, PROMPT, NOW + SECOND, { session: id })}${terminal(RUN, NOW + SECOND, "completed", { session: id })}`,
      },
      { name: "let go", after: (id) => sessionEnd(NOW + SECOND, "clean", { session: id }) },
      { name: "never waited", after: () => "", cannotSay: true },
    ];
    for (const { name, after, cannotSay } of cases) {
      const clock = handClock();
      const ps = standInPs([MUSE_LINE]);
      const { files, file, id } = oldSession((session) =>
        cannotSay
          ? replied(RUN, NOW - 2 * MINUTE, { session })
          : asked(RUN, PROMPT, NOW - 2 * MINUTE, { session }),
      );
      if (cannotSay) ps.own(false);
      const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
      expect((await adapter.poll()).sessions[0]?.status, name).toBe(
        cannotSay ? "unknown" : "needs-you",
      );
      if (!cannotSay) {
        appendLog(files, file, after(id), NOW + SECOND);
        clock.advance(2 * SECOND);
        expect((await adapter.poll()).sessions[0]?.status, name).not.toBe("needs-you");
      }
      clock.advance(2 * DAY);
      expect((await adapter.poll()).sessions, name).toEqual([]);
    }
  });

  test("a wait that ended lends its time to no later one", async () => {
    const clock = handClock();
    const files = filesWith(`${opening(OPENED)}${asked(RUN, PROMPT, NOW - 3 * MINUTE)}`);
    const adapter = museCodeAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 3 * MINUTE,
    });
    appendLog(files, FILE, sessionResumed(NOW + SECOND), NOW + SECOND);
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    // The same question is asked again.
    appendLog(files, FILE, asked(RUN, PROMPT, NOW + 3 * SECOND), NOW + 3 * SECOND);
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW + 3 * SECOND,
    });
  });

  test("a wait that ended while ps could not say lends its time to no later one", async () => {
    const clock = handClock();
    const ps = standInPs([MUSE_LINE]);
    const files = filesWith(`${opening(OPENED)}${asked(RUN, PROMPT, NOW - 3 * MINUTE)}`);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 3 * MINUTE,
    });
    // Resumed, on a poll where ps cannot say: the log shows the question closed.
    appendLog(files, FILE, sessionResumed(NOW + SECOND), NOW + SECOND);
    ps.own(false);
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    // The same question is asked again.
    ps.own(true);
    appendLog(files, FILE, asked(RUN, PROMPT, NOW + 12 * SECOND), NOW + 12 * SECOND);
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW + 12 * SECOND,
    });
    expect(ps.runs).toHaveLength(3);
  });

  test("an approval that ended while ps could not say lends its time to no later one", async () => {
    const clock = handClock();
    const ps = standInPs([MUSE_LINE]);
    const files = filesWith(
      `${opening(OPENED)}${requested(RUN, ACTION, NOW - 3 * MINUTE, "human_pending")}`,
    );
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW - 3 * MINUTE,
    });
    // Resumed, on a poll where ps cannot say: the log shows the approval closed.
    appendLog(files, FILE, sessionResumed(NOW + SECOND), NOW + SECOND);
    ps.own(false);
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    // Recovery requests the same approval again.
    ps.own(true);
    appendLog(
      files,
      FILE,
      requested(RUN, ACTION, NOW + 12 * SECOND, "human_pending"),
      NOW + 12 * SECOND,
    );
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: NOW + 12 * SECOND,
    });
    expect(ps.runs).toHaveLength(3);
  });

  test("a session resumed after a crash never shows the dead turn as working or waiting", async () => {
    const text = [
      opening(OPENED),
      asked(RUN, PROMPT, OPENED + MINUTE),
      requested(RUN, ACTION, OPENED + MINUTE, "human_pending"),
      sessionEnd(NOW - 2 * MINUTE, "crash_inferred"),
      sessionResumed(NOW - 2 * MINUTE + 5),
    ].join("");
    expect(await statusOf(text)).toMatchObject({
      status: "idle",
      statusSince: NOW - 2 * MINUTE + 5,
    });
    // A run that recovery takes up again is working again, as of its first record since.
    expect(await statusOf(`${text}${replied(RUN, NOW - MINUTE)}`)).toMatchObject({
      status: "working",
      statusSince: NOW - MINUTE,
    });
  });
});

describe("whether a Muse Code that could hold a session runs, by ps", () => {
  const writtenAt = NOW - MINUTE;
  const text = `${opening(OPENED)}${replied(RUN, writtenAt)}`;

  test("asks ps for each process's ID, start and program name alone, in UTC", async () => {
    const ps = standInPs([MUSE_LINE]);
    await museCodeAdapterFor(filesWith(text, writtenAt), { ps }).poll();
    expect(ps.runs).toEqual([{ args: DSH_TABLE_ARGS, options: { utc: true } }]);
  });

  test("finished, since its newest record, once no Muse Code started before it, or within a minute after, runs", async () => {
    const ps = standInPs([psLine(7001, writtenAt + 61 * SECOND, "muse")]);
    expect(await statusOf(text, { ps }, writtenAt)).toMatchObject({
      status: "finished",
      statusSince: writtenAt,
    });
    const within = standInPs([psLine(7001, writtenAt + 59 * SECOND, "muse")]);
    expect((await statusOf(text, { ps: within }, writtenAt))?.status).toBe("working");
  });

  test("any program named muse, muse.exe or starting muse- counts, and no other", async () => {
    for (const name of [
      "muse",
      "/opt/homebrew/bin/muse",
      "muse.exe",
      "muse-bin-1.4.24",
      "muse-aarch64-li",
    ]) {
      const ps = standInPs([psLine(7001, NOW - HOUR, name)]);
      expect((await statusOf(text, { ps }, writtenAt))?.status, name).toBe("working");
    }
    for (const name of ["muse-", "Muse", "tbh-linux-sandbox", "musescore", "node"]) {
      const ps = standInPs([psLine(7001, NOW - HOUR, name)]);
      expect((await statusOf(text, { ps }, writtenAt))?.status, name).toBe("finished");
    }
  });

  test("Agent Lookout's own process is never one, and a table that does not list it says nothing", async () => {
    const ps = standInPs([MUSE_LINE]);
    ps.own(false);
    expect((await statusOf(text, { ps }, writtenAt))?.status).toBe("unknown");
    const own = standInPs([psLine(OWN_PID, NOW - HOUR, "muse")]);
    expect((await statusOf(text, { ps: own }, writtenAt))?.status).toBe("finished");
  });

  test("a ps that cannot be run says nothing, and its card says so", async () => {
    const ps = standInPs();
    ps.fail();
    const { health, sessions, basis } = await museCodeAdapterFor(filesWith(text, writtenAt), {
      ps,
    }).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(health.detail).toBe(`${READ_DETAIL} ${PS_FAILED}`);
  });

  test("a session last written more than a minute before the computer started is finished, with no ps asked", async () => {
    const ps = standInPs([MUSE_LINE]);
    const bootAt = NOW - HOUR;
    const old = bootAt - 2 * MINUTE;
    const files = filesWith(`${opening(old - MINUTE)}${replied(RUN, old)}`, old);
    const adapter = museCodeAdapterFor(files, { ps, uptimeMs: () => NOW - bootAt });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: old,
    });
    expect(ps.runs).toEqual([]);
  });

  test("an answer asked less than 2 seconds after the time judged says nothing of a program started since", async () => {
    const clock = handClock();
    const ps = standInPs([]);
    const files = filesWith(`${opening(OPENED)}${replied(RUN, NOW - SECOND)}`, NOW - SECOND);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    clock.advance(SECOND + WRITE_TIME_STEP_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("an answer asked because the clock was set back allows nothing for a rounded write time, for logs unchanged since", async () => {
    const clock = handClock();
    const ps = standInPs([]);
    const files = filesWith(`${opening(OPENED)}${replied(RUN, NOW - SECOND)}`, NOW - SECOND);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    // Asked a second after the write: too soon to tell.
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    // Set back: asked again, and the log is as that poll found it.
    clock.set(NOW - SECOND / 2);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(ps.runs).toHaveLength(2);
    // Written since that answer was asked, perhaps after it: a rounded write time is allowed for again.
    appendLog(files, FILE, replied(RUN, NOW - SECOND / 2), NOW - SECOND / 2);
    clock.advance(SECOND / 10);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    expect(ps.runs).toHaveLength(2);
  });

  /** The stand-in files, with a write a test queues made on the next open, after that poll's `lstat`. */
  function appendingOnOpen(files: ReturnType<typeof memoryFiles>) {
    let next: (() => void) | null = null;
    const io: ReadOnlyIo = {
      ...files.io,
      async openRegular(given) {
        const add = next;
        next = null;
        add?.();
        return files.io.openRegular(given);
      },
    };
    return {
      io,
      beforeNextOpen: (add: () => void) => {
        next = add;
      },
    };
  }

  // A disk that keeps a write's time in steps of 2 seconds: every write is stamped STEP.
  const STEP = NOW - 2 * SECOND;
  const stepText = `${opening(OPENED)}${replied(RUN, STEP)}`;

  test("keeps allowing nothing for a log that changed between its lstat and its open on the poll that asked", async () => {
    const files = filesWith(stepText, STEP);
    const clock = handClock(STEP + SECOND / 2);
    const ps = standInPs([]);
    const opens = appendingOnOpen(files);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps, io: opens.io });
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    // Set back: asked again, and the log, written since, is written again after its lstat and before its open.
    appendLog(files, FILE, replied(RUN, STEP), STEP);
    opens.beforeNextOpen(() => appendLog(files, FILE, replied(RUN, STEP), STEP));
    clock.set(STEP + SECOND / 10);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    // Read as that poll read it, before ps was asked.
    clock.advance(1.8 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(ps.runs).toHaveLength(2);
  });

  test("allows for a rounded write time again for a log that changed between its lstat and its open since that answer", async () => {
    const files = filesWith(stepText, STEP);
    const clock = handClock(STEP + SECOND / 2);
    const ps = standInPs([]);
    const opens = appendingOnOpen(files);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps, io: opens.io });
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    // Set back: asked again, while the log, written since, cannot be opened.
    appendLog(files, FILE, replied(RUN, STEP), STEP);
    files.failOpen(FILE);
    clock.set(STEP + SECOND / 10);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    files.heal(FILE);
    // Less than 2 seconds later, a Muse Code started since adds a turn after this poll's lstat and before its open.
    opens.beforeNextOpen(() => appendLog(files, FILE, started(RUN_2, STEP + SECOND), STEP));
    ps.set([psLine(7002, STEP + SECOND, "muse")]);
    clock.advance(1.8 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    expect(ps.runs).toHaveLength(2);
  });

  test("allows for a rounded write time again for a log that changed since that answer and could not be opened", async () => {
    const files = filesWith(stepText, STEP);
    const clock = handClock(STEP + SECOND / 2);
    const ps = standInPs([]);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    clock.set(STEP + SECOND / 10);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    // A Muse Code started since adds a turn, and the log cannot be opened again on this poll.
    appendLog(files, FILE, started(RUN_2, STEP + SECOND), STEP);
    files.failOpen(FILE);
    ps.set([psLine(7002, STEP + SECOND, "muse")]);
    clock.advance(1.8 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
    expect(ps.runs).toHaveLength(2);
    files.heal(FILE);
  });

  test("asks again sooner, though not within 2 seconds, when a log is written after an answer that listed none", async () => {
    const clock = handClock();
    const ps = standInPs([]);
    const files = filesWith(text, writtenAt);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    appendLog(files, FILE, replied(RUN, NOW + SECOND), NOW + SECOND);
    clock.advance(PROMPT_PROCESS_CHECK_MS - 1);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    clock.advance(1);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);
    // The write may have been stamped up to 2 seconds before that answer, so one more.
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(ps.runs).toHaveLength(3);
    clock.advance(PROMPT_PROCESS_CHECK_MS);
    await adapter.poll();
    expect(ps.runs).toHaveLength(3);
    clock.advance(PROCESS_CHECK_MS);
    await adapter.poll();
    expect(ps.runs).toHaveLength(4);
  });

  test("a later rename or setting change neither brings a finished session back nor moves its time", async () => {
    const clock = handClock();
    const ps = standInPs([psLine(7001, NOW + 30 * SECOND, "muse")]);
    const files = filesWith(`${opening(OPENED)}${terminal(RUN, writtenAt)}`, writtenAt);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: writtenAt,
    });
    appendLog(
      files,
      FILE,
      `${renamed(NOW + 40 * SECOND)}${modelChanged(NOW + 41 * SECOND)}`,
      NOW + 41 * SECOND,
    );
    clock.set(NOW + 45 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: writtenAt,
    });
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: writtenAt,
    });
  });

  test("a log written since and not read again is judged by its last write, so the Muse Code that wrote it keeps it from finishing", async () => {
    const clock = handClock();
    const askedAt = NOW - 5 * MINUTE;
    const ps = standInPs([psLine(7001, askedAt - MINUTE, "muse")]);
    const files = filesWith(`${opening(OPENED)}${asked(RUN, PROMPT, askedAt)}`, askedAt);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps });
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    // That Muse Code exits, and one started since resumes the session, whose log cannot be opened again.
    ps.set([psLine(7002, NOW - 2 * MINUTE, "muse")]);
    appendLog(
      files,
      FILE,
      `${sessionResumed(NOW - MINUTE)}${started(RUN_2, NOW - MINUTE)}`,
      NOW - MINUTE,
    );
    files.failOpen(FILE);
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    files.heal(FILE);
    clock.advance(PROCESS_CHECK_MS);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a newest record whose time cannot be right keeps ps from finishing the session", async () => {
    const ps = standInPs([]);
    const ahead = NOW + CLOCK_SLACK_MS + MINUTE;
    expect(
      await statusOf(`${opening(OPENED)}${replied(RUN, ahead)}`, { ps }, writtenAt),
    ).toMatchObject({
      status: "unknown",
    });
  });

  test("on macOS, after the clock was set back, a write stamped before the latest time seen is not finished by a start", async () => {
    const clock = handClock();
    let mono = 0;
    const ps = standInPs([psLine(7001, NOW - 5 * SECOND, "muse")]);
    const files = filesWith(text, writtenAt);
    const adapter = museCodeAdapterFor(files, { now: clock.now, ps, monotonic: () => mono });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    // The clock is set back an hour; the log is written then, stamped before the latest time seen.
    clock.set(NOW - HOUR);
    mono += 2 * SECOND;
    appendLog(files, FILE, replied(RUN, NOW - HOUR + SECOND), NOW - HOUR + SECOND);
    clock.advance(PROCESS_CHECK_MS);
    mono += PROCESS_CHECK_MS;
    // The Muse Code started before the clock was set back looks started after the write, which finishes nothing.
    expect((await adapter.poll()).sessions[0]?.status).toBe("unknown");
  });
});

describe("what a poll found, said on the card", () => {
  test("a session whose newest turn began more than 8 MiB before its log's end", async () => {
    const filler = `{"payload_type":"session.name.changed","text":"${"x".repeat(REACH_BYTES)}"}\n`;
    const { health, sessions } = await museCodeAdapterFor(
      filesWith(`${opening(OPENED)}${filler}`),
    ).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(health.detail).toBe(`${READ_DETAIL} ${TOO_FAR}`);
  });

  test("a line that cannot be read, and one of a newer format", async () => {
    const broken = replied(RUN, NOW - MINUTE).replace('"stream":{', '"stream":{,');
    const unread = await museCodeAdapterFor(filesWith(`${opening(OPENED)}${broken}`)).poll();
    expect(unread.sessions[0]?.status).toBe("unknown");
    expect(unread.health.detail).toBe(`${READ_DETAIL} ${UNREAD}`);
    const newer = await museCodeAdapterFor(
      filesWith(`${opening(OPENED)}${replied(RUN, NOW - MINUTE, { schemaVersion: 2 })}`),
    ).poll();
    expect(newer.health.detail).toBe(`${READ_DETAIL} ${NEWER_FORMAT}`);
  });

  test("a link met in the sessions folder", async () => {
    const files = filesWith(`${opening(OPENED)}${replied(RUN, NOW - MINUTE)}`);
    files.special(sessionFolder(uuidAt(NOW, 7)));
    const { health, sessions } = await museCodeAdapterFor(files).poll();
    expect(sessions).toHaveLength(1);
    expect(health.detail).toBe(`${READ_DETAIL} ${LINK}`);
  });
});

describe("on Windows and other systems", () => {
  test("on Windows ps is not run, the folder is assumed, and only the log's own words finish or fail a session", async () => {
    const ps = standInPs([MUSE_LINE]);
    const files = filesWith(`${opening(OPENED)}${replied(RUN, NOW - MINUTE)}`);
    const adapter = museCodeAdapterFor(files, { platform: "win32", ps });
    const { health, sessions, basis } = await adapter.poll();
    expect(ps.runs).toEqual([]);
    expect(basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(sessions[0]?.status).toBe("unknown");
    expect(health.detail).toBe(
      `Sessions are read from the logs Muse Code keeps in ~/.local/share/muse/sessions. ${STATUS_ENDS} ${STATUS_TIMES} ${WINDOWS_FOLDER} ${WINDOWS_PS} ${STATUS_READONLY} ${UNCHECKED_BUILT} ${UNCHECKED_READERS} ${UNCHECKED_NOT}`,
    );
    expect(health.watching?.at(-1)).toEqual({
      label: "Process check run",
      value: "not run on Windows",
    });
    expect(
      await statusOf(`${opening(OPENED)}${terminal(RUN, NOW - MINUTE, "failed")}`, {
        platform: "win32",
      }),
    ).toMatchObject({ status: "failed" });
    expect(
      await statusOf(`${opening(OPENED)}${sessionEnd(NOW - MINUTE)}`, { platform: "win32" }),
    ).toMatchObject({ status: "finished" });
    expect(
      (
        await statusOf(`${opening(OPENED)}${asked(RUN, PROMPT, NOW - MINUTE)}`, {
          platform: "win32",
        })
      )?.status,
    ).toBe("unknown");
  });

  test("on Windows a folder a setting names is not said to be assumed", async () => {
    const adapter = museCodeAdapterFor(memoryFiles(), {
      platform: "win32",
      env: { XDG_DATA_HOME: "/data" },
    });
    const { health } = await adapter.poll();
    expect(health.detail).not.toContain(WINDOWS_FOLDER);
    const plain = await museCodeAdapterFor(memoryFiles(), { platform: "win32" }).poll();
    expect(plain.health.detail).toContain(WINDOWS_FOLDER);
  });

  test("on another system ps is not run either", async () => {
    const ps = standInPs([MUSE_LINE]);
    const { health } = await museCodeAdapterFor(filesWith(`${opening(OPENED)}`), {
      platform: "freebsd",
      ps,
    }).poll();
    expect(ps.runs).toEqual([]);
    expect(health.detail).toContain(OTHER_SYSTEM);
    expect(health.watching?.at(-1)).toEqual({
      label: "Process check run",
      value: "not run on this system",
    });
  });
});

test("each note on the card is 130 characters or fewer, a folder's path aside", () => {
  const notes = [
    STATUS_ENDS,
    STATUS_TIMES,
    STATUS_GONE,
    STATUS_BOOT,
    STATUS_HELD,
    STATUS_WAITS,
    STATUS_REVIEWER,
    STATUS_FIRST_SECONDS,
    STATUS_ANY,
    STATUS_WRONG,
    STATUS_UNKNOWN,
    STATUS_READONLY,
    UNCHECKED_BUILT,
    UNCHECKED_READERS,
    UNCHECKED_NOT,
    WINDOWS_PS,
    OTHER_SYSTEM,
    PS_FAILED,
    TOO_FAR,
    UNREAD,
    NEWER_FORMAT,
    XDG_RELATIVE,
    LINK,
    WINDOWS_FOLDER.replace("%USERPROFILE%\\.local\\share\\muse", ""),
  ];
  for (const note of notes) expect(note.length, note).toBeLessThanOrEqual(130);
});

describe("what is read, and what never is", () => {
  test("nothing of a prompt, a question, an answer, a command or a reply reaches a session or the card", async () => {
    const text = [
      opening(OPENED),
      asked(RUN, PROMPT, OPENED + 1),
      settled(RUN, PROMPT, OPENED + 2),
      requested(RUN, ACTION, OPENED + 3, "human_pending"),
      replied(RUN, OPENED + 4),
      renamed(OPENED + 5),
    ].join("");
    const result = await museCodeAdapterFor(filesWith(text)).poll();
    const said = JSON.stringify(result);
    for (const word of PRIVATE_WORDS) expect(said, word).not.toContain(word);
  });

  test("opens only session.jsonl, and never a lock, a database, a subagent's log or anything beside", async () => {
    const files = filesWith(`${opening(OPENED)}${replied(RUN, NOW - MINUTE)}`);
    const folder = sessionFolder();
    for (const beside of [
      ".session.lock",
      "goals.db",
      "subagent/0abc/session.jsonl",
      "approval-review/x.jsonl",
      "tool-outputs/x",
    ]) {
      files.write(`${folder}/${beside}`, "x");
    }
    files.write(`${DATA_DIR}/session-index.db`, "x");
    const adapter = museCodeAdapterFor(files);
    await adapter.poll();
    await adapter.poll();
    expect(new Set(files.opened())).toEqual(new Set([FILE]));
    expect(
      files.calls.filter(({ path }) =>
        /lock|\.db|subagent|approval-review|tool-outputs/.test(path),
      ),
    ).toEqual([]);
    expect(files.openHandles()).toBe(0);
  });

  test("a session started in another run's place since is read afresh", async () => {
    const files = filesWith(`${opening(OPENED)}${terminal(RUN, NOW - 2 * MINUTE)}`);
    const adapter = museCodeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    appendLog(files, FILE, started(RUN_2, NOW - MINUTE), NOW - MINUTE);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: NOW - MINUTE,
    });
  });
});
