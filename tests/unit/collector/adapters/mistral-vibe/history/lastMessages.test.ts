import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  answerFrom,
  createMistralVibeLastMessages,
  type VibeReplyTarget,
} from "@collector/adapters/mistral-vibe/history/lastMessages";
import { TRANSCRIPT_TAIL_BYTES } from "@collector/files/transcriptTail";
import {
  ANSWER_AGAIN_MS,
  createTailLimits,
  KEEP_MS,
  READS_PER_SECOND,
} from "@collector/messages/tailReader";
import { MAX_MESSAGE_LENGTH } from "@core/text";
import {
  NOW,
  PRIVATE_WORDS,
  SESSION_DIR,
  appendStep,
  canonical,
  digest,
  effectEntry,
  generationName,
  historyChunk,
  historyDelta,
  journalPath,
  reasoningEntry,
  removeStep,
  replaceStep,
  replyEntry,
  sessionApiFacts,
  sessionId,
  storePath,
  userEntry,
  type HistoryChunk,
} from "@tests/fixtures/mistralVibe";
import { handClock, memoryFiles, writeStore } from "@tests/support/adapters/mistralVibeAdapter";

const A = sessionId("a1");
const ID = `mistral-vibe:${A}`;
const STORE = `${SESSION_DIR}/${storePath(A)}`;
const CHUNKS = `${STORE}/chunks`;
const JOURNAL = `${SESSION_DIR}/${journalPath(A)}`;
const pieceFile = (piece: HistoryChunk) => `${CHUNKS}/${piece.name}.json`;

/** Everything an answer says, as one string, to look for words that must never be in it. */
const said = (value: unknown) => JSON.stringify(value);

/** A tool's output of about `bytes` bytes, in a history entry of its own. */
const bulky = (id: string, bytes: number) => ({
  ...effectEntry(id),
  state: { status: "succeeded", outputText: `${PRIVATE_WORDS} ${"x".repeat(bytes)}` },
});

/** Where a session's history is, as a poll would give it for the store `writeStore` wrote. */
function targetOf(
  pieces: HistoryChunk[] | null,
  options: { older?: boolean; sequence?: number } = {},
): VibeReplyTarget {
  const sequence = options.sequence ?? 4;
  return {
    journal: `${SESSION_DIR}/${journalPath(A, sequence)}`,
    generation: generationName(sequence),
    chunksDir: CHUNKS,
    history:
      pieces === null
        ? null
        : { newest: pieces.map((piece) => piece.name), older: options.older ?? false },
  };
}

/** A reader over files in memory, with a clock moved by hand and drops run by the test. */
function setUp(limits = createTailLimits()) {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const drops: { run: () => void; ms: number }[] = [];
  const reader = createMistralVibeLastMessages({
    io: files.io,
    now: clock.now,
    limits,
    later: (run, ms) => drops.push({ run, ms }),
  });
  return { clock, files, reader, drops };
}

/** A reader over one session's store, with these pieces of history and journal lines. */
async function askFor(pieces: HistoryChunk[], journal: string[] = [], older = false) {
  const set = setUp();
  writeStore(set.files, { id: A, historyChunks: pieces, journal });
  set.reader.keep(new Map([[ID, targetOf(pieces, { older })]]));
  const answer = await set.reader.read(ID);
  return { ...set, answer };
}

/** A piece named for the SHA-256 of `array`, as Vibe names one, whatever `array` holds. */
const hashed = (array: string): HistoryChunk => ({
  name: createHash("sha256").update(array).digest("hex"),
  body: `${array}\n`,
});

/** How many bytes were read, in all. */
const bytesRead = (files: ReturnType<typeof memoryFiles>) =>
  files.reads.reduce((sum, read) => sum + read.length, 0);

describe("the answer a Mistral Vibe history gives", () => {
  test("is the reply made fit to show, its end kept when it is long", () => {
    expect(answerFrom({ text: "Done.\r\n\r\n\r\nNext.", before: false })).toEqual({
      message: { text: "Done.\n\nNext.", cut: false },
    });
    const long = answerFrom({ text: "y".repeat(MAX_MESSAGE_LENGTH + 10), before: false });
    expect(long).toEqual({ message: { text: "y".repeat(MAX_MESSAGE_LENGTH), cut: true } });
    expect(long).not.toHaveProperty("tokens");
  });

  test("with no reply, is nothing yet when the whole history was read, and too far back when it was not", () => {
    expect(answerFrom({ text: null, before: false })).toEqual({
      message: null,
      reason: "nothing-yet",
    });
    expect(answerFrom({ text: null, before: true })).toEqual({
      message: null,
      reason: "too-far-back",
    });
  });
});

describe("the reader of Mistral Vibe last messages", () => {
  test("reads the journal first, and opens no piece of the history while it holds a reply", async () => {
    const piece = historyChunk([replyEntry("assistant-1", "In a piece.")]);
    const { answer, files } = await askFor(
      [piece],
      [historyDelta(5, [appendStep(replyEntry("assistant-2", "In the journal."))])],
    );
    expect(answer).toEqual({ message: { text: "In the journal.", cut: false } });
    expect(files.opened()).toEqual([JOURNAL]);
  });

  test("reads nothing until it is asked, and only for a session it was given", async () => {
    const { files, reader } = setUp();
    const piece = historyChunk([replyEntry("assistant-1", "Here.")]);
    writeStore(files, { id: A, historyChunks: [piece] });
    await expect(reader.read(ID)).resolves.toBeNull();
    reader.keep(new Map([[ID, targetOf([piece])]]));
    expect(files.calls).toEqual([]);
    await expect(reader.read(`mistral-vibe:${sessionId("b1")}`)).resolves.toBeNull();

    // A session whose journal could not be named: nothing is looked for.
    reader.keep(new Map([[ID, null]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
    expect(files.calls).toEqual([]);
  });

  test("with an empty journal, as after a turn ends, gives the newest reply in the pieces, from the newest back", async () => {
    const older = historyChunk([userEntry("user-1"), replyEntry("assistant-1", "The answer.")]);
    const newer = historyChunk([
      userEntry("user-2"),
      reasoningEntry("reasoning-2-0"),
      effectEntry("effect-2"),
    ]);
    const { answer, files } = await askFor([older, newer]);
    expect(answer).toEqual({ message: { text: "The answer.", cut: false } });
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([JOURNAL, pieceFile(newer), pieceFile(older)]);

    // The newest piece holds a reply: no older one is opened.
    const one = await askFor([older, historyChunk([replyEntry("assistant-2", "Newest.")])]);
    expect(one.answer).toEqual({ message: { text: "Newest.", cut: false } });
    expect(one.files.opened()).not.toContain(pieceFile(older));
  });

  test("applies the journal's steps over the pieces, so a reply taken out or replaced there does not stand", async () => {
    const piece = historyChunk([
      replyEntry("assistant-1", "First."),
      userEntry("user-2"),
      replyEntry("assistant-2", PRIVATE_WORDS),
    ]);
    const removed = await askFor([piece], [historyDelta(5, [removeStep("assistant-2")])]);
    expect(removed.answer).toEqual({ message: { text: "First.", cut: false } });

    const replaced = await askFor(
      [piece],
      [historyDelta(5, [replaceStep("assistant-2", replyEntry("assistant-2", "Second, again."))])],
    );
    expect(replaced.answer).toEqual({ message: { text: "Second, again.", cut: false } });

    const discarded = await askFor(
      [piece],
      [
        historyDelta(5, [
          replaceStep(
            "assistant-2",
            replyEntry("assistant-2", PRIVATE_WORDS, {
              outcome: { type: "discarded", cause: "steer" },
            }),
          ),
        ]),
      ],
    );
    expect(discarded.answer).toEqual({ message: { text: "First.", cut: false } });
  });

  test("reads a reply from a journal line of Vibe 3.1's, past its Session API facts", async () => {
    const { answer } = await askFor(
      [historyChunk([])],
      [
        historyDelta(5, [appendStep(replyEntry("assistant-1", "Done."))], {
          sessionApi: sessionApiFacts(),
          state: { id: A, status: "idle" },
        }),
      ],
    );
    expect(answer).toEqual({ message: { text: "Done.", cut: false } });
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
  });

  test("is nothing yet when the whole history holds no reply, or is empty", async () => {
    const pieces = [historyChunk([userEntry("user-1")]), historyChunk([effectEntry("effect-1")])];
    const none = await askFor(pieces);
    expect(none.answer).toEqual({ message: null, reason: "nothing-yet" });

    const empty = await askFor([], [historyDelta(5, [appendStep(userEntry("user-1"))])]);
    expect(empty.answer).toEqual({ message: null, reason: "nothing-yet" });
    expect(empty.files.opened()).toEqual([JOURNAL]);
    expect(empty.files.count("lstat")).toBe(0);
  });

  test("is too far back when older pieces than those named hold the reply, or the manifest names none", async () => {
    const kept = await askFor([historyChunk([userEntry("user-9")])], [], true);
    expect(kept.answer).toEqual({ message: null, reason: "too-far-back" });

    const { files, reader } = setUp();
    writeStore(files, {
      id: A,
      historyChunks: [historyChunk([replyEntry("assistant-1", "Here.")])],
    });
    reader.keep(new Map([[ID, targetOf(null)]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "too-far-back" });
    expect(files.opened()).toEqual([JOURNAL]);
  });

  test(`reads at most ${TRANSCRIPT_TAIL_BYTES / 1024} KB of the journal and the pieces together`, async () => {
    // 100 KB of the journal leaves room for two pieces of 70 KB, and not a third.
    const journal = [historyDelta(5, [appendStep(bulky("effect-5", 100 * 1024))])];
    const reply = historyChunk([
      replyEntry("assistant-1", "Far back."),
      bulky("effect-1", 70 * 1024),
    ]);
    const middle = historyChunk([bulky("effect-2", 70 * 1024)]);
    const newest = historyChunk([bulky("effect-3", 70 * 1024)]);
    const far = await askFor([reply, middle, newest], journal);
    expect(far.answer).toEqual({ message: null, reason: "too-far-back" });
    expect(bytesRead(far.files)).toBeLessThanOrEqual(TRANSCRIPT_TAIL_BYTES);
    expect(far.files.reads.map((read) => read.path)).toEqual([
      JOURNAL,
      pieceFile(newest),
      pieceFile(middle),
    ]);

    // With the journal empty, all three fit.
    const near = await askFor([reply, middle, newest]);
    expect(near.answer).toEqual({ message: { text: "Far back.", cut: false } });
    expect(bytesRead(near.files)).toBeLessThanOrEqual(TRANSCRIPT_TAIL_BYTES);

    // A journal longer than that is read from its end alone, and no piece is opened.
    const long = await askFor(
      [historyChunk([replyEntry("assistant-1", PRIVATE_WORDS)])],
      [historyDelta(5, [appendStep(bulky("effect-5", TRANSCRIPT_TAIL_BYTES))])],
    );
    expect(long.answer).toEqual({ message: null, reason: "too-far-back" });
    expect(long.files.opened()).toEqual([JOURNAL]);
    expect(bytesRead(long.files)).toBe(TRANSCRIPT_TAIL_BYTES);
  });

  test("a piece that is not the one its name says is unreadable, and none of it is shown", async () => {
    const reply = [replyEntry("assistant-1", PRIVATE_WORDS)];
    const good = historyChunk(reply);
    for (const [name, piece] of [
      [
        "other bytes",
        { name: good.name, body: `${canonical([replyEntry("assistant-1", "Other.")])}\n` },
      ],
      ["no newline at its end", { name: good.name, body: `${good.body.slice(0, -1)} ` }],
      ["not an array", hashed(canonical({ entries: reply }))],
      ["not JSON", hashed(`[${PRIVATE_WORDS}]`)],
    ] as const) {
      const { answer } = await askFor([piece]);
      expect(answer, name).toEqual({ message: null, reason: "unreadable" });
      expect(said(answer)).not.toContain(PRIVATE_WORDS);
    }
  });

  test("opens only the pieces the manifest names, in the store's own chunks/, and none through a link", async () => {
    const piece = historyChunk([replyEntry("assistant-1", "Named.")]);
    const { answer, files } = await askFor([piece]);
    expect(answer).toEqual({ message: { text: "Named.", cut: false } });
    // Not the checkpoint's piece beside it, the conversation, the sidecar or anything else.
    expect(files.opened()).toEqual([JOURNAL, pieceFile(piece)]);
    expect(files.opened()).not.toContain(`${CHUNKS}/${digest(3)}.json`);

    const linked = setUp();
    writeStore(linked.files, { id: A, historyChunks: [piece] });
    linked.files.special(pieceFile(piece));
    linked.reader.keep(new Map([[ID, targetOf([piece])]]));
    await expect(linked.reader.read(ID)).resolves.toEqual({ message: null, reason: "unreadable" });

    const folder = setUp();
    writeStore(folder.files, { id: A, journal: [] });
    folder.files.special(CHUNKS);
    folder.reader.keep(new Map([[ID, targetOf([piece])]]));
    await expect(folder.reader.read(ID)).resolves.toEqual({ message: null, reason: "unreadable" });
    expect(folder.files.opened()).toEqual([JOURNAL]);
  });

  test("a journal or a piece that has gone is not found", async () => {
    const piece = historyChunk([replyEntry("assistant-1", "Here.")]);
    const { clock, files, reader } = await askFor([piece]);
    files.remove(pieceFile(piece));
    // The journal changed too, so it is read again.
    files.append(JOURNAL, historyDelta(5, [appendStep(userEntry("user-2"))]));
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });

    files.remove(JOURNAL);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
  });

  test("does not read an unchanged journal again, nor its pieces, which never change", async () => {
    const piece = historyChunk([replyEntry("assistant-1", "Here.")]);
    const { clock, files, reader } = await askFor([piece]);
    files.forget();
    // Asked again within the second: the answer is given again, and nothing is looked at.
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Here.", cut: false } });
    expect(files.calls).toEqual([]);

    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Here.", cut: false } });
    expect(files.opened()).toEqual([JOURNAL]);
    expect(files.reads).toEqual([]);

    files.append(JOURNAL, historyDelta(5, [appendStep(replyEntry("assistant-2", "Newer."))]));
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Newer.", cut: false } });
  });

  test("counts one read for each ask against the limits the other agents' readers share", async () => {
    const limits = createTailLimits();
    const { files, reader } = setUp(limits);
    const other = setUp(limits);
    const ids = Array.from({ length: READS_PER_SECOND }, (_, n) => sessionId(`d${n}`));
    const targets = new Map<string, VibeReplyTarget>();
    for (const id of ids) {
      const piece = historyChunk([replyEntry("assistant-1", `Reply of ${id}.`)]);
      writeStore(files, { id, historyChunks: [piece] });
      writeStore(other.files, { id, historyChunks: [piece] });
      targets.set(`mistral-vibe:${id}`, {
        journal: `${SESSION_DIR}/${journalPath(id)}`,
        generation: generationName(4),
        chunksDir: `${SESSION_DIR}/${storePath(id)}/chunks`,
        history: { newest: [piece.name], older: false },
      });
    }
    reader.keep(targets);
    other.reader.keep(targets);
    const [first = "", ...rest] = [...targets.keys()];
    // The other reader takes one of the second's reads, so this one has one fewer, though each reads two files.
    await expect(other.reader.read(first)).resolves.toEqual({
      message: { text: `Reply of ${ids[0]}.`, cut: false },
    });
    const answers = [];
    for (const id of [first, ...rest]) answers.push(await reader.read(id));
    expect(answers.slice(0, -1).every((answer) => answer !== "busy")).toBe(true);
    expect(answers.at(-1)).toBe("busy");
  });

  test("drops what it kept 15 seconds after the last ask, or when a poll names a new generation", async () => {
    const piece = historyChunk([replyEntry("assistant-1", "Here.")]);
    const { clock, drops, reader } = await askFor([piece]);
    expect(reader.size).toBe(1);
    clock.advance(KEEP_MS);
    for (const drop of drops.splice(0)) drop.run();
    expect(reader.size).toBe(0);

    await reader.read(ID);
    expect(reader.size).toBe(1);
    reader.keep(new Map([[ID, targetOf([piece], { sequence: 9 })]]));
    expect(reader.size).toBe(0);
    reader.keep(new Map());
    await expect(reader.read(ID)).resolves.toBeNull();
  });
});
