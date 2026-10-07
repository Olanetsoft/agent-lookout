import { describe, expect, test } from "vitest";

import {
  ANTIGRAVITY_CAPABILITIES,
  ANTIGRAVITY_HOME_ENV,
  BASIS,
  BASIS_UNMATCHED,
  BASIS_WITHOUT_PROCESSES,
  NEEDS_YOU_NOTE,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  UNCHECKED_NOTE,
  UNKNOWN_STEP_NOTE,
  UNMATCHED_NOTE,
} from "@collector/adapters/antigravity/index";
import {
  AGY_HOME,
  conversationId,
  databasePath,
  DAY,
  failedTurn,
  finishedTurn,
  HOME,
  MINUTE,
  NOW,
  SECOND,
  step,
  transcriptPath,
  workingTurn,
} from "@tests/fixtures/antigravity";
import {
  antigravityAdapterFor,
  handClock,
  memoryFiles,
  standInProcesses,
} from "@tests/support/adapters/antigravityAdapter";

const WORKING = conversationId("a1");
const IDLE = conversationId("b2");
const FAILED = conversationId("c3");
const OLD = conversationId("d4");

/** An agy folder with a working, an idle and a failed conversation, and one from two days ago. */
function setUp() {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const write = (id: string, lines: string[], mtimeMs: number) =>
    files.write(transcriptPath(AGY_HOME, id), lines.join(""), { mtimeMs });
  write(WORKING, workingTurn(0, NOW - 3 * MINUTE), NOW - 10 * SECOND);
  write(IDLE, finishedTurn(0, NOW - 20 * MINUTE), NOW - 19 * MINUTE);
  write(FAILED, failedTurn(0, NOW - 40 * MINUTE), NOW - 39 * MINUTE);
  write(OLD, finishedTurn(0, NOW - 2 * DAY), NOW - 2 * DAY);
  const processes = standInProcesses();
  const adapter = antigravityAdapterFor(files, processes, { now: clock.now });
  return { clock, files, processes, adapter, write };
}

const statuses = (sessions: { id: string; status: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id.split(":")[1], session.status]));

describe("with agy's folder there", () => {
  test("lists the conversations of the last day, finished when no agy program runs", async () => {
    const { adapter } = setUp();
    const result = await adapter.poll();
    expect(result.basis).toBe(BASIS);
    expect(result.health).toMatchObject({
      id: "antigravity-cli",
      label: "Antigravity CLI",
      state: "ok",
      detail: `Sessions are read from the transcripts the Antigravity CLI keeps in ~/.gemini/antigravity-cli/brain. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
      watching: [
        { label: "Conversations folder", value: "~/.gemini/antigravity-cli/brain" },
        { label: "Read", value: "every 2 seconds" },
        { label: "Command", value: "ps -A -o pid=,ppid=,lstart=,comm=" },
        { label: "Command run", value: "every 10 seconds at most" },
      ],
    });
    expect(statuses(result.sessions)).toEqual({
      [WORKING]: "finished",
      [IDLE]: "finished",
      [FAILED]: "failed",
    });
  });

  test("shows each as its last step says while an agy program may have it open", async () => {
    const { adapter, processes } = setUp();
    processes.set([{ startedAt: NOW - 60 * MINUTE }]);
    const { sessions } = await adapter.poll();
    expect(statuses(sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "idle",
      [FAILED]: "failed",
    });
    const working = sessions.find((session) => session.id.endsWith(WORKING));
    expect(working).toMatchObject({
      name: WORKING,
      surface: "terminal",
      statusSince: NOW - 3 * MINUTE,
      lastWriteAt: NOW - 10 * SECOND,
    });
    expect(sessions.some((session) => session.status === "needs-you")).toBe(false);
  });

  test("an agy program holds only what was written since it started, or the conversation it names", async () => {
    const { adapter, processes } = setUp();
    processes.set([
      { startedAt: NOW - 5 * MINUTE },
      { startedAt: NOW - MINUTE, conversation: IDLE },
    ]);
    expect(statuses((await adapter.poll()).sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "idle",
      [FAILED]: "failed",
    });
  });

  test("an old conversation an agy program names is listed, whatever its age", async () => {
    const { adapter, processes } = setUp();
    processes.set([
      { startedAt: NOW - 3 * MINUTE },
      { startedAt: NOW - MINUTE, conversation: OLD },
    ]);
    await adapter.poll();
    const { sessions } = await adapter.poll();
    expect(statuses(sessions)).toMatchObject({ [OLD]: "idle" });
  });

  test("while an agy program could have any conversation open, none is finished, and the poll is named apart", async () => {
    const { adapter, processes } = setUp();
    processes.set([{ startedAt: NOW }]);
    const result = await adapter.poll();
    expect(result.basis).toBe(BASIS_UNMATCHED);
    expect(result.health.detail).toContain(UNMATCHED_NOTE);
    expect(statuses(result.sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "idle",
      [FAILED]: "failed",
    });
  });

  test("when ps cannot say, none is finished, and the poll is named apart", async () => {
    const { adapter, processes } = setUp();
    processes.fail();
    const result = await adapter.poll();
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toContain(
      "ps could not be run to tell which conversations agy has open, so none is shown as finished.",
    );
    expect(statuses(result.sessions)).toMatchObject({ [IDLE]: "idle" });
  });

  test("on Windows, which has no ps, none is finished, and it says so", async () => {
    const { files, processes } = setUp();
    processes.fail();
    const adapter = antigravityAdapterFor(files, processes, { platform: "win32" });
    const result = await adapter.poll();
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toContain(
      "Windows has no ps to tell which conversations agy has open, so none is shown as finished.",
    );
    expect(result.health.watching).toContainEqual({
      label: "Command run",
      value: "not run on Windows",
    });
  });

  test("a step it does not know shows as unknown, and the note says why", async () => {
    const { adapter, write } = setUp();
    write(
      IDLE,
      [step({ index: 0, type: "A_STEP_FROM_A_LATER_AGY", at: NOW - MINUTE })],
      NOW - MINUTE,
    );
    const result = await adapter.poll();
    expect(statuses(result.sessions)).toMatchObject({ [IDLE]: "unknown" });
    expect(result.health.detail).toContain(UNKNOWN_STEP_NOTE);
  });

  test("asks ps at most every 10 seconds, and at once when a conversation appears that nothing could hold", async () => {
    const { adapter, clock, processes, write } = setUp();
    await adapter.poll();
    expect(processes.asked()).toBe(1);
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(processes.asked()).toBe(1);

    // A new conversation, written after the last answer, which had no agy program in it.
    const NEW = conversationId("e5");
    write(NEW, workingTurn(0, clock.now()), clock.now());
    processes.set([{ startedAt: clock.now() - SECOND }]);
    clock.advance(2 * SECOND);
    const { sessions } = await adapter.poll();
    expect(processes.asked()).toBe(2);
    expect(statuses(sessions)).toMatchObject({ [NEW]: "working" });

    clock.advance(PROCESS_CHECK_MS - 2 * SECOND);
    await adapter.poll();
    expect(processes.asked()).toBe(2);
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(processes.asked()).toBe(3);
  });

  test("a conversation written by an agy program that started since ps last ran is not finished before ps is asked again", async () => {
    const { adapter, clock, processes, write } = setUp();
    await adapter.poll();
    expect(processes.asked()).toBe(1);

    // An agy program starts just after ps found none, and writes a new conversation.
    const NEW = conversationId("e5");
    processes.set([{ startedAt: NOW }]);
    clock.advance(SECOND);
    write(NEW, finishedTurn(0, clock.now()), clock.now());
    // The next poll comes a little sooner than ps may be asked again.
    clock.advance(PROMPT_PROCESS_CHECK_MS - SECOND - 10);
    const soon = await adapter.poll();
    expect(processes.asked()).toBe(1);
    expect(statuses(soon.sessions)).toMatchObject({ [NEW]: "idle" });

    clock.advance(10);
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({ [NEW]: "idle" });
    expect(processes.asked()).toBe(2);

    // Once ps shows the program has ended, the conversation is finished.
    processes.set([]);
    clock.advance(PROCESS_CHECK_MS);
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({ [NEW]: "finished" });
  });

  test("only the transcript says an agy program may have a conversation open, while its database gives Quiet for", async () => {
    const { adapter, files, processes } = setUp();
    // agy writes a conversation's database at other times too, as a program exits.
    files.write(databasePath(AGY_HOME, IDLE), "SQLite format 3", { mtimeMs: NOW - MINUTE });
    processes.set([{ startedAt: NOW - 5 * MINUTE }]);
    const { sessions } = await adapter.poll();
    expect(statuses(sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "finished",
      [FAILED]: "failed",
    });
    expect(sessions.find((session) => session.id.endsWith(IDLE))?.lastWriteAt).toBe(NOW - MINUTE);
  });

  test("with no conversation from the last day, runs no ps and lists nothing", async () => {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    files.write(transcriptPath(AGY_HOME, OLD), finishedTurn(0, NOW - 2 * DAY).join(""), {
      mtimeMs: NOW - 2 * DAY,
    });
    const processes = standInProcesses();
    const adapter = antigravityAdapterFor(files, processes);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(processes.asked()).toBe(0);
    expect(files.count("openRegular")).toBe(0);
  });

  test("opens transcripts and nothing else: no database, no full transcript, no settings", async () => {
    const { adapter, files } = setUp();
    files.write(databasePath(AGY_HOME, WORKING), "SQLite format 3", { mtimeMs: NOW - 5 * SECOND });
    files.write(databasePath(AGY_HOME, WORKING, true), "", { mtimeMs: NOW - 5 * SECOND });
    files.write(
      `${AGY_HOME}/brain/${WORKING}/.system_generated/logs/transcript_full.jsonl`,
      "{}\n",
    );
    files.write(`${AGY_HOME}/conversation_summaries.db`, "SQLite format 3");
    files.write(`${HOME}/.gemini/settings.json`, "{}");
    const { sessions } = await adapter.poll();
    expect(files.opened().every((file) => file.endsWith("/transcript.jsonl"))).toBe(true);
    // The database's log says when agy last wrote, so it is how quiet the conversation is.
    expect(sessions.find((session) => session.id.endsWith(WORKING))?.lastWriteAt).toBe(
      NOW - 5 * SECOND,
    );
  });
});

describe("with no agy folder", () => {
  test("says the Antigravity CLI was not found, calmly, and looks again once a minute", async () => {
    const clock = handClock(NOW);
    const files = memoryFiles(clock.now);
    const processes = standInProcesses();
    const adapter = antigravityAdapterFor(files, processes, { now: clock.now });
    const first = await adapter.poll();
    expect(first).toEqual({
      health: expect.objectContaining({
        state: "unavailable",
        detail:
          "The Antigravity CLI was not found: there is no ~/.gemini/antigravity-cli folder. Agent Lookout looks again every minute.",
      }),
      sessions: [],
    });
    expect(first.health).not.toHaveProperty("advice");
    files.forget();
    clock.advance(RECHECK_MS - SECOND);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    clock.advance(SECOND);
    await adapter.poll();
    expect(files.count("stat")).toBe(1);
    expect(processes.asked()).toBe(0);
  });

  test("a folder with no brain folder yet is watched, with no sessions", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(AGY_HOME);
    const result = await antigravityAdapterFor(files, standInProcesses()).poll();
    expect(result.health).toMatchObject({
      state: "ok",
      detail: `The Antigravity CLI has not saved any conversations in ~/.gemini/antigravity-cli/brain yet. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
    });
    expect(result.sessions).toEqual([]);
  });

  test("a brain folder that cannot be listed is an error that says where it looked", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(`${AGY_HOME}/brain`);
    files.fail(`${AGY_HOME}/brain`);
    const result = await antigravityAdapterFor(files, standInProcesses()).poll();
    expect(result.health).toMatchObject({
      state: "error",
      detail:
        "Antigravity CLI conversations could not be read: the folder ~/.gemini/antigravity-cli/brain could not be listed.",
    });
  });
});

describe(ANTIGRAVITY_HOME_ENV, () => {
  test("names the folder to read, and one with nothing in it is an answer: watched, with no sessions", async () => {
    const files = memoryFiles(() => NOW);
    const processes = standInProcesses();
    const adapter = antigravityAdapterFor(files, processes, {
      env: { [ANTIGRAVITY_HOME_ENV]: "/Users/example/agy-empty" },
    });
    const result = await adapter.poll();
    expect(result.health).toMatchObject({
      state: "ok",
      detail: `${ANTIGRAVITY_HOME_ENV} is set to ~/agy-empty, which has no brain folder, so no Antigravity CLI sessions are listed. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
    });
    expect(files.count("stat")).toBe(0);
    expect(processes.asked()).toBe(0);
  });

  test("blank is not set", async () => {
    const files = memoryFiles(() => NOW);
    const adapter = antigravityAdapterFor(files, standInProcesses(), {
      env: { [ANTIGRAVITY_HOME_ENV]: "  " },
    });
    expect((await adapter.poll()).health.state).toBe("unavailable");
  });
});

test("carries its own declaration of what it can report", () => {
  const adapter = antigravityAdapterFor(
    memoryFiles(() => NOW),
    standInProcesses(),
  );
  expect(adapter.capabilities).toBe(ANTIGRAVITY_CAPABILITIES);
  expect(adapter.lookingIn).toBe(
    "Looking for Antigravity CLI sessions in ~/.gemini/antigravity-cli/brain.",
  );
});

test("never throws: anything unexpected is a sentence", async () => {
  const files = memoryFiles(() => NOW);
  const working = antigravityAdapterFor(files, {
    ...standInProcesses(),
    reader: {
      read: () => {
        throw new Error("ps broke");
      },
    },
  });
  files.write(transcriptPath(AGY_HOME, WORKING), workingTurn(0, NOW).join(""));
  const result = await working.poll();
  expect(result.health).toMatchObject({
    state: "error",
    detail: "Something unexpected went wrong while reading Antigravity CLI sessions.",
  });
});
