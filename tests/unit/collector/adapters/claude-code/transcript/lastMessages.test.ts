import { describe, expect, test } from "vitest";

import {
  ANSWER_AGAIN_MS,
  createLastMessageReader,
  KEEP_MS,
  MAX_KEPT,
  READS_PER_SECOND,
} from "@collector/adapters/claude-code/transcript/lastMessages";
import { LOOK_AGAIN_MS } from "@collector/adapters/claude-code/transcript/waitingTexts";
import type { Session } from "@core/sessions/session";
import { MAX_MESSAGE_LENGTH } from "@core/text";
import { ids } from "@tests/fixtures/claudeCode";
import {
  prompt,
  said,
  saidInParts,
  thought,
  toolResult,
  toolUse,
  toolUseId,
  transcript,
} from "@tests/fixtures/claudeTranscript";
import { makeSession } from "@tests/fixtures/session";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const HOME = "/Users/example/.claude";
const CWD = "/Users/example/code/demo-api";
const FOLDER = `${HOME}/projects/-Users-example-code-demo-api`;
const FILE = `${FOLDER}/${ids.busy}.jsonl`;
const START = 1_700_000_100_000;

/** A Claude Code session working in the demo folder, as the adapter lists it. */
function working(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${ids.busy}`,
    name: "demo-api",
    cwd: CWD,
    project: "demo-api",
    status: "working",
    ...overrides,
  });
}

/** One more session of its own in the demo folder, numbered. */
function another(index: number): Session {
  const id = `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
  return working({ id: `claude-code:${id}`, name: `demo-${index}` });
}

const fileOf = (session: Session) => `${FOLDER}/${session.id.slice("claude-code:".length)}.jsonl`;

/** A reader over files in memory, with a clock moved by hand and drops run by the test. */
function setUp() {
  const clock = handClock(START);
  const files = memoryFiles(clock.now);
  const drops: { run: () => void; ms: number }[] = [];
  const reader = createLastMessageReader({
    claudeHome: HOME,
    io: files.io,
    now: clock.now,
    later: (run, ms) => drops.push({ run, ms }),
  });
  return { clock, files, reader, drops };
}

const id = `claude-code:${ids.busy}`;

test("keeps to the limits PRIVACY.md and docs/API.md give", () => {
  expect([KEEP_MS, MAX_KEPT, READS_PER_SECOND, ANSWER_AGAIN_MS]).toEqual([15_000, 8, 4, 1_000]);
});

describe("what a session last said", () => {
  test("is read only when it is asked for: the sessions of a poll touch no file", async () => {
    const { files, reader } = setUp();
    files.write(FILE, transcript([prompt("Tidy the docs"), said("I tidied them.")]));
    reader.keep([working()]);
    reader.keep([working()]);
    expect(files.calls).toEqual([]);
    expect(reader.size).toBe(0);

    await expect(reader.read(id)).resolves.toEqual({
      message: { text: "I tidied them.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);
  });

  test("is the newest reply's text alone, its parts joined, never its thinking or its tools", async () => {
    const { files, reader } = setUp();
    const use = toolUseId();
    files.write(
      FILE,
      transcript([
        prompt("Tidy the PRIVATE-PROMPT docs"),
        thought("PRIVATE-THOUGHT about the docs", { messageId: "msg_reply" }),
        ...saidInParts(["First part.", "Second part."], { messageId: "msg_reply" }),
        toolUse(use, "Bash", { command: "echo PRIVATE-TOOL" }, { messageId: "msg_reply" }),
        toolResult(use),
        prompt("Thanks, PRIVATE-PROMPT"),
      ]),
    );
    reader.keep([working()]);
    const answer = await reader.read(id);
    expect(answer).toEqual({ message: { text: "First part.\n\nSecond part.", cut: false } });
    expect(JSON.stringify(answer)).not.toContain("PRIVATE");
  });

  test("is made fit to show: control characters go, line breaks stay, and a long one keeps its end", async () => {
    const { files, reader } = setUp();
    const long = `${"An early line.\n".repeat(200)}The very end.`;
    files.write(FILE, transcript([said("One\r\ntwo\u0007\tthree‮")]));
    reader.keep([working()]);
    await expect(reader.read(id)).resolves.toEqual({
      message: { text: "One\ntwo   three", cut: false },
    });

    files.write(FILE, transcript([said(long)]));
    reader.forget();
    reader.keep([working()]);
    const answer = await reader.read(id);
    if (answer === null || answer === "busy" || answer.message === null) {
      throw new Error("A message was expected.");
    }
    expect(answer.message.cut).toBe(true);
    expect(answer.message.text.endsWith("The very end.")).toBe(true);
    expect(Array.from(answer.message.text).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  test("whose start lies before the end that is read is said to be cut, short as it is", async () => {
    const { files, reader } = setUp();
    files.write(
      FILE,
      transcript(
        saidInParts(["x".repeat(300 * 1024), "The end of it."], { messageId: "msg_long" }),
      ),
    );
    reader.keep([working()]);
    await expect(reader.read(id)).resolves.toEqual({
      message: { text: "The end of it.", cut: true },
    });
  });

  test("says why there is none: nothing yet, too far back, not found, or unreadable", async () => {
    const { clock, files, reader } = setUp();
    reader.keep([working()]);

    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "not-found" });

    clock.advance(LOOK_AGAIN_MS);
    files.write(FILE, transcript([prompt("Start the work")]));
    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "nothing-yet" });

    clock.advance(ANSWER_AGAIN_MS);
    files.write(
      FILE,
      transcript([
        said("An old reply."),
        ...Array.from({ length: 40 }, () => prompt("p".repeat(10 * 1024))),
      ]),
    );
    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "too-far-back" });

    clock.advance(ANSWER_AGAIN_MS);
    files.special(FILE);
    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "unreadable" });

    clock.advance(ANSWER_AGAIN_MS);
    files.write(FILE, transcript([said("Readable again.")]));
    files.fail(FILE, "EACCES");
    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "unreadable" });
  });

  test("is found again after a while once its transcript has gone, and never rejects", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, transcript([said("Here.")]));
    reader.keep([working()]);
    await reader.read(id);

    files.remove(FILE);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "not-found" });

    // Not looked for again until ten seconds have passed.
    const moved = `${HOME}/projects/-Users-example-code-moved/${ids.busy}.jsonl`;
    files.write(moved, transcript([said("Moved.")]));
    files.forget();
    clock.advance(LOOK_AGAIN_MS - 1);
    await expect(reader.read(id)).resolves.toEqual({ message: null, reason: "not-found" });
    expect(files.calls).toEqual([]);
    clock.advance(1);
    await expect(reader.read(id)).resolves.toEqual({ message: { text: "Moved.", cut: false } });

    files.failAll("EIO");
    clock.advance(LOOK_AGAIN_MS);
    await expect(reader.read(id)).resolves.toMatchObject({ message: null });
  });
});

describe("how often a transcript is read", () => {
  test("an answer is given again from memory for a second, and asks meanwhile share one read", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    reader.keep([working()]);

    const [first, second] = await Promise.all([reader.read(id), reader.read(id)]);
    expect(first).toEqual({ message: { text: "Done.", cut: false } });
    expect(second).toBe(first);
    expect(files.opened()).toEqual([FILE]);

    files.forget();
    clock.advance(ANSWER_AGAIN_MS - 1);
    await expect(reader.read(id)).resolves.toBe(first);
    expect(files.calls).toEqual([]);
  });

  test("an unchanged transcript is opened to compare and not read, and a changed one is read again", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    reader.keep([working()]);
    await reader.read(id);
    files.forget();

    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(id)).resolves.toEqual({ message: { text: "Done.", cut: false } });
    expect(files.opened()).toEqual([FILE]);
    expect(files.reads).toEqual([]);
    expect(files.count("readdir") + files.count("lstat")).toBe(0);

    clock.advance(ANSWER_AGAIN_MS);
    files.append(FILE, transcript([prompt("And the tests?"), said("They pass.")]));
    await expect(reader.read(id)).resolves.toEqual({
      message: { text: "They pass.", cut: false },
    });
    expect(files.reads).toHaveLength(1);
    expect(files.openHandles()).toBe(0);
  });

  test(`no more than ${READS_PER_SECOND} transcripts are read in a second, and above that the answer is busy`, async () => {
    const { clock, files, reader } = setUp();
    const sessions = Array.from({ length: READS_PER_SECOND + 1 }, (_, index) => another(index));
    for (const session of sessions) files.write(fileOf(session), transcript([said("Done.")]));
    reader.keep(sessions);

    const answers = await Promise.all(sessions.map((session) => reader.read(session.id)));
    expect(answers.filter((answer) => answer === "busy")).toHaveLength(1);
    expect(answers.at(-1)).toBe("busy");
    expect(files.count("openRegular")).toBe(READS_PER_SECOND);
    expect(files.opened()).not.toContain(fileOf(sessions.at(-1) as Session));

    // An answer kept is given at once, busy or not.
    await expect(reader.read(sessions[0]?.id ?? "")).resolves.toEqual({
      message: { text: "Done.", cut: false },
    });

    clock.advance(1_000);
    await expect(reader.read(sessions.at(-1)?.id ?? "")).resolves.toEqual({
      message: { text: "Done.", cut: false },
    });
  });
});

describe("what is kept", () => {
  test("only a session the last poll listed is read: any other id touches no file", async () => {
    const { files, reader } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    await expect(reader.read(id)).resolves.toBeNull();

    reader.keep([working({ status: "needs-you" })]);
    for (const other of [
      "claude-code:job-0001",
      `codex:${ids.question}`,
      `claude-code:../../${ids.question}`,
      ids.busy,
      `claude-code:${ids.question}`,
    ]) {
      await expect(reader.read(other)).resolves.toBeNull();
    }
    expect(files.calls).toEqual([]);
    expect(reader.size).toBe(0);

    await expect(reader.read(id)).resolves.toEqual({ message: { text: "Done.", cut: false } });
  });

  test("a listed session whose id names no transcript, such as a job known only by its job id, is not found, and touches no file", async () => {
    const { files, reader } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    const named = ["claude-code:job-0001", "claude-code:4242", `claude-code:../../${ids.busy}`];
    reader.keep([working(), ...named.map((other) => working({ id: other }))]);
    for (let ask = 0; ask <= READS_PER_SECOND; ask += 1) {
      for (const other of named) {
        await expect(reader.read(other), other).resolves.toEqual({
          message: null,
          reason: "not-found",
        });
      }
    }
    expect(files.calls).toEqual([]);
    expect(reader.size).toBe(0);

    // None of those asks counted toward the second's reads.
    await expect(reader.read(id)).resolves.toEqual({ message: { text: "Done.", cut: false } });
  });

  test("a session that leaves the list is dropped at once, and is not read again", async () => {
    const { files, reader } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    reader.keep([working()]);
    await reader.read(id);
    expect(reader.size).toBe(1);

    reader.keep([]);
    expect(reader.size).toBe(0);
    files.forget();
    await expect(reader.read(id)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("forget drops everything, and the sessions that may be read too", async () => {
    const { files, reader } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    reader.keep([working()]);
    await reader.read(id);
    reader.forget();
    expect(reader.size).toBe(0);
    await expect(reader.read(id)).resolves.toBeNull();
  });

  test(`what is not asked for again is dropped ${KEEP_MS / 1000} seconds after the last ask, poll or no poll`, async () => {
    const { clock, files, reader, drops } = setUp();
    files.write(FILE, transcript([said("Done.")]));
    reader.keep([working()]);
    await reader.read(id);
    expect(drops.map((drop) => drop.ms)).toEqual([KEEP_MS]);

    // Asked again five seconds on: its fifteen seconds start again.
    clock.advance(5_000);
    await reader.read(id);
    clock.advance(KEEP_MS - 5_000);
    drops.shift()?.run();
    expect(reader.size).toBe(1);
    expect(drops.map((drop) => drop.ms)).toEqual([5_000]);

    clock.advance(5_000);
    drops.shift()?.run();
    expect(reader.size).toBe(0);
    expect(drops).toEqual([]);

    // The poll drops it too, when it comes first.
    await reader.read(id);
    clock.advance(KEEP_MS);
    reader.keep([working()]);
    expect(reader.size).toBe(0);
  });

  test(`no more than ${MAX_KEPT} sessions are kept, and the one asked for least recently goes first`, async () => {
    const { clock, files, reader } = setUp();
    const sessions = Array.from({ length: MAX_KEPT + 1 }, (_, index) => another(index));
    for (const session of sessions) {
      files.write(fileOf(session), transcript([said(`Done ${session.name}.`)]));
    }
    reader.keep(sessions);
    for (const session of sessions.slice(0, MAX_KEPT)) {
      await reader.read(session.id);
      clock.advance(300);
    }
    // The first is asked for again, so the second is now the least recent.
    clock.advance(1_000);
    await reader.read(sessions[0]?.id ?? "");
    clock.advance(1_000);
    await reader.read(sessions.at(-1)?.id ?? "");
    expect(reader.size).toBe(MAX_KEPT);

    // The first is still kept, so its file is opened where it was found. The
    // second was dropped, so it is looked for afresh.
    files.forget();
    clock.advance(1_000);
    await reader.read(sessions[0]?.id ?? "");
    expect(files.count("lstat")).toBe(0);
    await reader.read(sessions[1]?.id ?? "");
    expect(files.count("lstat")).toBe(1);
  });
});
