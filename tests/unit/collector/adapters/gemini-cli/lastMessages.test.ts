import { describe, expect, test } from "vitest";

import {
  answerFrom,
  createGeminiCliLastMessages,
  lastSaidInSessionFile,
  replyTextOf,
} from "@collector/adapters/gemini-cli/lastMessages";
import { geminiCliSessionId } from "@collector/adapters/gemini-cli/toSession";
import { TRANSCRIPT_TAIL_BYTES } from "@collector/files/transcriptTail";
import {
  ANSWER_AGAIN_MS,
  createTailLimits,
  READS_PER_SECOND,
} from "@collector/messages/tailReader";
import { MAX_MESSAGE_LENGTH } from "@core/text";
import {
  chatFile,
  chatName,
  chatPath,
  contextLine,
  ENVIRONMENT_CONTEXT_ID,
  geminiLine,
  headerLine,
  historyCopyLine,
  messageIdOf,
  MINUTE,
  noticeLine,
  NOW,
  patchLine,
  PRIVATE_WORDS,
  rewindLine,
  SECOND,
  sessionIdOf,
  setLine,
  setMessagesLine,
  SLUG,
  titleLine,
  toolCall,
  toolResultLine,
  updatedLine,
  userLine,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { handClock, memoryFiles } from "@tests/support/adapters/geminiCliAdapter";

const T = NOW - 30 * MINUTE;
const at = (seconds: number) => T + seconds * SECOND;

/** Message ids, in the order their messages are written below. */
const [P1, R1, P2, R2, P3, R3, X1] = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map(
  messageIdOf,
) as [string, string, string, string, string, string, string];

/** A reply of the model that says this, with thoughts of its own that must never be taken. */
const reply = (id: string, seconds: number, content: unknown) =>
  geminiLine(id, at(seconds), { content });

/** A prompt. */
const prompt = (id: string, seconds: number) => userLine(id, at(seconds));

/** The text a whole session file of these lines gives, or null. */
const textOf = (...lines: string[]) => lastSaidInSessionFile(chatFile(lines), true);

/** The text the end of a longer file gives, whose first piece is the end of a line before it. */
const endOf = (...lines: string[]) =>
  lastSaidInSessionFile(
    chatFile([`"the end of a longer line ${PRIVATE_WORDS}"}`, ...lines]),
    false,
  );

/** Everything an answer says, as one string, to look for words that must never be in it. */
const said = (value: unknown) => JSON.stringify(value);

/** A session's first lines, as Gemini CLI writes them: its header and its context. */
const opening = () => [headerLine({ startTime: at(0) }), contextLine(at(0)), updatedLine(at(0))];

describe("what a Gemini CLI session last said, from the end of its session file", () => {
  test("is the text of the newest reply, never its thoughts", () => {
    const text = textOf(
      ...opening(),
      prompt(P1, 1),
      reply(R1, 2, "An older reply."),
      updatedLine(at(2)),
      prompt(P2, 3),
      reply(R2, 4, "The newest reply."),
      updatedLine(at(4)),
    );
    expect(text).toBe("The newest reply.");
    expect(reply(R2, 4, "x")).toContain(PRIVATE_WORDS);
    expect(text).not.toContain(PRIVATE_WORDS);
  });

  test("passes over a newer reply that only calls tools or only thinks, and the tools' results and notices after it, for the older reply", () => {
    expect(
      textOf(
        ...opening(),
        prompt(P1, 1),
        reply(R1, 2, "I will look first."),
        // Gemini CLI writes a reply that only calls tools as "", then again with its calls once they end.
        reply(R2, 3, ""),
        geminiLine(R2, at(4), { content: "", toolCalls: [toolCall("success", at(4))] }),
        toolResultLine(P3, at(5)),
        // Its own note that a tool sent back a file, a thought alone.
        reply(R3, 6, [{ text: PRIVATE_WORDS, thought: true }]),
        noticeLine("info", X1, at(7)),
        noticeLine("warning", messageIdOf("b1"), at(8)),
        noticeLine("error", messageIdOf("b2"), at(9)),
        titleLine(PRIVATE_WORDS),
        setLine({ sessionId: sessionIdOf("01") }),
        updatedLine(at(9)),
      ),
    ).toBe("I will look first.");
  });

  test("takes the words of a reply that also calls a tool", () => {
    expect(
      textOf(
        prompt(P1, 1),
        geminiLine(R1, at(2), {
          content: "Running the tests now.",
          toolCalls: [toolCall("success", at(3))],
        }),
      ),
    ).toBe("Running the tests now.");
  });

  test("never takes a prompt, the session's context, a tool's result or a notice, though each is newer", () => {
    expect(textOf(reply(R1, 1, "Done."), prompt(P1, 2))).toBe("Done.");
    expect(textOf(prompt(P1, 1), noticeLine("error", X1, at(2)))).toBeNull();
    expect(textOf(...opening(), toolResultLine(P1, at(1)), historyCopyLine(R1, at(2)))).toBeNull();
  });

  test("joins a reply's text parts with nothing between them, and leaves out its thoughts, calls and results among them", () => {
    expect(
      replyTextOf([
        { text: `**Placeholder** ${PRIVATE_WORDS}`, thought: true },
        { text: "First half, " },
        { text: PRIVATE_WORDS, thought: "yes" },
        "second ",
        { text: "half.", thought: false },
        { functionCall: { name: "run_shell_command", args: { command: PRIVATE_WORDS } } },
        { text: PRIVATE_WORDS, functionCall: { name: "read_file", args: {} } },
        { text: PRIVATE_WORDS, functionResponse: { name: "read_file", response: {} } },
      ]),
    ).toBe("First half, second half.");
    // One part on its own, as Gemini CLI takes a content that is not a list.
    expect(replyTextOf({ text: "On its own." })).toBe("On its own.");
    expect(replyTextOf("A string.")).toBe("A string.");
  });

  test("passes over content that is empty, only spaces or not text", () => {
    for (const content of [
      "",
      "   \n\t ",
      [],
      [{ text: "" }],
      [{ text: 42 }],
      [{ text: null }],
      [["A list in a list."]],
      [42, null],
      null,
      42,
      { inlineData: { mimeType: "image/png", data: "AAAA" } },
    ]) {
      expect(
        textOf(reply(R1, 1, "The older reply."), reply(R2, 2, content)),
        JSON.stringify(content),
      ).toBe("The older reply.");
    }
    // A reply with no content at all.
    const none = JSON.stringify({
      id: R2,
      timestamp: new Date(at(2)).toISOString(),
      type: "gemini",
    });
    expect(textOf(reply(R1, 1, "The older reply."), none)).toBe("The older reply.");
  });

  test("never takes a reply's line quoted inside a prompt", () => {
    const quoted = reply(R2, 9, PRIVATE_WORDS);
    const line = userLine(P2, at(2), quoted);
    expect(line).toContain('\\"type\\":\\"gemini\\"');
    expect(textOf(reply(R1, 1, "The real reply."), line)).toBe("The real reply.");
  });

  test('goes by each line\'s own type, so a prompt whose words or parts say "gemini" is never taken for a reply', () => {
    const words = userLine(P2, at(2), "gemini");
    const parts = JSON.stringify({
      id: P3,
      timestamp: new Date(at(3)).toISOString(),
      type: "user",
      content: [{ type: "gemini", text: PRIVATE_WORDS }],
    });
    expect(textOf(reply(R1, 1, "The real reply."), words, parts)).toBe("The real reply.");
  });

  test("reads past a line that does not parse, and a line of a kind Gemini CLI does not write, as Gemini CLI does", () => {
    expect(
      textOf(
        reply(R1, 1, "Whole."),
        `{"id":"${R2}","type":"gemini","content":"broken`,
        "not json",
        "[1,2,3]",
        "42",
        JSON.stringify({ type: "gemini", content: PRIVATE_WORDS }),
        JSON.stringify({ $rewindTo: 5 }),
        "",
      ),
    ).toBe("Whole.");
  });

  test("a line with a $patch is never a message, whatever else it holds", () => {
    const patchWithReply = JSON.stringify({
      $patch: {},
      id: R2,
      type: "gemini",
      content: PRIVATE_WORDS,
    });
    const nullPatch = JSON.stringify({
      $patch: null,
      id: R2,
      type: "gemini",
      content: PRIVATE_WORDS,
    });
    expect(textOf(reply(R1, 1, "The real reply."), patchWithReply, nullPatch)).toBe(
      "The real reply.",
    );
  });

  test("a line with the id of a message in the list replaces it where it stands", () => {
    // A reply written again, as Gemini CLI writes one with its tool calls.
    expect(
      textOf(
        reply(R1, 1, "First words."),
        geminiLine(R1, at(2), {
          content: "First words, then the call.",
          toolCalls: [toolCall("success", at(2))],
        }),
      ),
    ).toBe("First words, then the call.");
    // A reply written again where it stood, behind a newer one.
    expect(textOf(reply(R1, 1, "Old."), reply(R2, 2, "Newest."), reply(R1, 3, "Old again."))).toBe(
      "Newest.",
    );
    // A reply's id written again as a prompt is no reply.
    expect(textOf(reply(R1, 1, "Older."), reply(R2, 2, PRIVATE_WORDS), prompt(R2, 3))).toBe(
      "Older.",
    );
  });
});

describe("a reply Gemini CLI took back", () => {
  test("a $rewindTo to a prompt, as /rewind writes, drops the prompt and every reply after it", () => {
    expect(
      textOf(
        ...opening(),
        prompt(P1, 1),
        reply(R1, 2, "Before the rewind."),
        prompt(P2, 3),
        reply(R2, 4, PRIVATE_WORDS),
        prompt(P3, 5),
        reply(R3, 6, PRIVATE_WORDS),
        rewindLine(P2),
        updatedLine(at(7)),
      ),
    ).toBe("Before the rewind.");
  });

  test("a $rewindTo to the reply itself, as a declined tool writes, drops it", () => {
    expect(
      textOf(
        prompt(P1, 1),
        reply(R1, 2, "The reply that stands."),
        prompt(P2, 3),
        geminiLine(R2, at(4), {
          content: PRIVATE_WORDS,
          toolCalls: [toolCall("cancelled", at(4))],
        }),
        rewindLine(R2),
      ),
    ).toBe("The reply that stands.");
  });

  test("a $rewindTo to an id no message has drops every message, so the whole file has said nothing", () => {
    const lines = [...opening(), prompt(P1, 1), reply(R1, 2, PRIVATE_WORDS), rewindLine(X1)];
    expect(textOf(...lines)).toBeNull();
    expect(answerFrom(chatFile(lines), true)).toEqual({ message: null, reason: "nothing-yet" });
  });

  test("a reply after the rewind is the newest", () => {
    expect(
      textOf(
        prompt(P1, 1),
        reply(R1, 2, PRIVATE_WORDS),
        rewindLine(P1),
        prompt(P2, 3),
        reply(R2, 4, "After the rewind."),
      ),
    ).toBe("After the rewind.");
  });

  test("a $patch that removes the newest reply, as a stopped or failed request writes, leaves the one before", () => {
    expect(
      textOf(
        prompt(P1, 1),
        reply(R1, 2, "The one before."),
        prompt(P2, 3),
        reply(R2, 4, PRIVATE_WORDS),
        noticeLine("info", X1, at(5)),
        patchLine({ removeIds: [P2, R2, X1] }),
        updatedLine(at(6)),
      ),
    ).toBe("The one before.");
  });

  test("a $patch replaces a reply's content, at its top, then in updates, and a content with no text passes it over", () => {
    // Gemini CLI writes a reply's content again as its parts when it takes a session up again.
    expect(
      textOf(
        reply(R1, 1, "Older."),
        reply(R2, 2, "Plain text."),
        patchLine({
          updates: [
            {
              id: R2,
              content: [
                { text: PRIVATE_WORDS, thought: true },
                { text: "Plain text, as parts." },
                { functionCall: { name: "read_file", args: {} } },
              ],
            },
          ],
        }),
      ),
    ).toBe("Plain text, as parts.");
    expect(
      textOf(
        reply(R1, 1, "Older."),
        reply(R2, 2, PRIVATE_WORDS),
        patchLine({ id: R2, content: "Top." }),
      ),
    ).toBe("Top.");
    // The top first, then updates.
    expect(
      textOf(
        reply(R1, 1, "Older."),
        reply(R2, 2, PRIVATE_WORDS),
        patchLine({ id: R2, content: PRIVATE_WORDS, updates: [{ id: R2, content: "Updated." }] }),
      ),
    ).toBe("Updated.");
    for (const content of ["", null, [{ text: PRIVATE_WORDS, thought: true }]]) {
      expect(
        textOf(
          reply(R1, 1, "Older."),
          reply(R2, 2, PRIVATE_WORDS),
          patchLine({ updates: [{ id: R2, content }] }),
        ),
        JSON.stringify(content),
      ).toBe("Older.");
    }
    // A change of a tool's result alone leaves the content as it was.
    expect(
      textOf(
        reply(R1, 1, "Kept."),
        patchLine({
          updates: [{ id: R1, toolCalls: [{ id: "call-0001", result: PRIVATE_WORDS }] }],
        }),
      ),
    ).toBe("Kept.");
  });

  test("a $patch that gives a prompt text makes no reply of it", () => {
    expect(
      textOf(
        reply(R1, 1, "The reply."),
        prompt(P2, 2),
        patchLine({ updates: [{ id: P2, content: "x" }] }),
      ),
    ).toBe("The reply.");
  });

  test("a $patch removes before it orders, and orders by the first place each id is named", () => {
    expect(
      textOf(
        reply(R1, 1, "First."),
        reply(R2, 2, "Second."),
        reply(R3, 3, PRIVATE_WORDS),
        patchLine({ removeIds: [R3], orderIds: [R2, R3, R1, R2] }),
      ),
    ).toBe("First.");
    // An id named that no message has is passed over.
    expect(
      textOf(reply(R1, 1, "First."), reply(R2, 2, "Second."), patchLine({ orderIds: [R2, X1] })),
    ).toBe("Second.");
    // A message the order does not name stays before those it does.
    expect(
      textOf(reply(R1, 1, "Named."), reply(R2, 2, "Not named."), patchLine({ orderIds: [R1] })),
    ).toBe("Named.");
  });

  test("a $set of messages, as Gemini CLI 0.44 to 0.63 wrote it, replaces the list, and any other $set leaves it", () => {
    expect(
      textOf(
        reply(R1, 1, PRIVATE_WORDS),
        setMessagesLine([prompt(P2, 2), reply(R2, 3, "From the set.")], at(3)),
      ),
    ).toBe("From the set.");
    expect(textOf(reply(R1, 1, PRIVATE_WORDS), setMessagesLine([prompt(P2, 2)], at(3)))).toBeNull();
    expect(
      textOf(
        reply(R1, 1, "Still there."),
        setLine({ messages: "not a list" }),
        setLine({ summary: PRIVATE_WORDS }),
        setLine({ sessionId: sessionIdOf("01"), lastUpdated: new Date(at(2)).toISOString() }),
        JSON.stringify({ $set: [] }),
      ),
    ).toBe("Still there.");
  });

  test("a header with messages adds them, as Gemini CLI's reader does", () => {
    expect(
      textOf(
        reply(R1, 1, PRIVATE_WORDS),
        headerLine({ messages: [JSON.parse(reply(R2, 2, "From a header.")) as unknown] }),
      ),
    ).toBe("From a header.");
    // It adds them to the list, where a $set of messages would replace it.
    expect(
      textOf(
        reply(R1, 1, "Kept."),
        headerLine({ messages: [JSON.parse(prompt(P2, 2)) as unknown] }),
      ),
    ).toBe("Kept.");
  });
});

describe("the end of a longer file, which can begin after the line a rewind or a patch names", () => {
  test("the first piece is the end of a line before it, and is not read", () => {
    const tail = `${reply(R1, 1, "Cut short.")}\n`;
    expect(lastSaidInSessionFile(tail, false)).toBeNull();
    expect(answerFrom(tail, false)).toEqual({ message: null, reason: "too-far-back" });
    expect(lastSaidInSessionFile(tail, true)).toBe("Cut short.");
  });

  test("the newest reply in it is the last message, as in a whole file", () => {
    expect(endOf(prompt(P1, 1), reply(R1, 2, "Newest."), prompt(P2, 3), updatedLine(at(3)))).toBe(
      "Newest.",
    );
  });

  test("a $rewindTo to a prompt the end holds leaves the reply before it, and none when the end holds none", () => {
    expect(
      endOf(reply(R1, 1, "Before."), prompt(P2, 2), reply(R2, 3, PRIVATE_WORDS), rewindLine(P2)),
    ).toBe("Before.");
    const lines = [prompt(P2, 2), reply(R2, 3, PRIVATE_WORDS), rewindLine(P2)];
    expect(endOf(...lines)).toBeNull();
    expect(answerFrom(chatFile(["x", ...lines]), false)).toEqual({
      message: null,
      reason: "too-far-back",
    });
  });

  test("a $rewindTo to a message from before the end drops every reply the end holds", () => {
    expect(
      endOf(
        reply(R1, 1, PRIVATE_WORDS),
        prompt(P2, 2),
        reply(R2, 3, PRIVATE_WORDS),
        rewindLine(X1),
      ),
    ).toBeNull();
    // A reply written after it is the newest.
    expect(endOf(reply(R1, 1, PRIVATE_WORDS), rewindLine(X1), reply(R2, 2, "After."))).toBe(
      "After.",
    );
  });

  test("a $patch that removes or changes messages from before the end leaves the replies the end holds", () => {
    expect(
      endOf(
        reply(R1, 1, "Stands."),
        patchLine({ updates: [{ id: X1, content: PRIVATE_WORDS }], removeIds: [X1, P1] }),
      ),
    ).toBe("Stands.");
  });

  test("taken up again, a reply the order puts last is the newest", () => {
    // Gemini CLI writes the batch's results again, then orders the whole history, most of it before the end.
    const before = ["c1", "c2", "c3"].map(messageIdOf);
    expect(
      endOf(
        setLine({ sessionId: sessionIdOf("01") }),
        prompt(P1, 1),
        geminiLine(R1, at(2), { content: "", toolCalls: [toolCall("success", at(2))] }),
        historyCopyLine(R1, at(3)),
        reply(R2, 4, "The last reply."),
        patchLine({
          updates: [{ id: ENVIRONMENT_CONTEXT_ID, content: [{ text: "<session_context>" }] }],
          orderIds: [ENVIRONMENT_CONTEXT_ID, ...before, P1, R1, `${R1}_response`, R2],
        }),
        updatedLine(at(5)),
      ),
    ).toBe("The last reply.");
  });

  test("a message from before the end that the order puts after the newest reply hides it, as it may be newer", () => {
    expect(
      endOf(reply(R1, 1, PRIVATE_WORDS), patchLine({ orderIds: [R1, X1] }), updatedLine(at(2))),
    ).toBeNull();
    // A reply written after it is the newest.
    expect(
      endOf(reply(R1, 1, PRIVATE_WORDS), patchLine({ orderIds: [R1, X1] }), reply(R2, 2, "After.")),
    ).toBe("After.");
  });

  test("a $rewindTo to a message the order moved from before the end drops every reply the end holds", () => {
    expect(
      endOf(reply(R1, 1, PRIVATE_WORDS), patchLine({ orderIds: [X1, R1] }), rewindLine(X1)),
    ).toBeNull();
  });

  test("a line of the id of a message the order moved from before the end leaves only that line's message known", () => {
    // If the moved message was there, its line stands where the order put it, before the
    // reply. If not, the line comes last. So what the end held before it is not known.
    expect(
      endOf(
        reply(R1, 1, PRIVATE_WORDS),
        patchLine({ orderIds: [X1, R1] }),
        reply(X1, 2, "The moved message, written again."),
      ),
    ).toBe("The moved message, written again.");
    expect(
      endOf(reply(R1, 1, PRIVATE_WORDS), patchLine({ orderIds: [X1, R1] }), prompt(X1, 2)),
    ).toBeNull();
    // A $rewindTo then to a message the end held drops the line's message too, as it may come after it.
    expect(
      endOf(
        prompt(P1, 1),
        reply(R1, 2, PRIVATE_WORDS),
        patchLine({ orderIds: [P1, X1, R1] }),
        reply(X1, 3, PRIVATE_WORDS),
        rewindLine(R1),
      ),
    ).toBeNull();
  });

  test("a $set of messages makes the list whole again, so a reply in it is the newest", () => {
    expect(
      endOf(
        patchLine({ orderIds: [X1] }),
        rewindLine(X1),
        setMessagesLine([prompt(P1, 1), reply(R1, 2, "From the set.")], at(2)),
      ),
    ).toBe("From the set.");
  });
});

describe("the answer", () => {
  test("is nothing when no reply has been written yet, or none is in the end that was read", () => {
    expect(answerFrom(chatFile(opening()), true)).toEqual({ message: null, reason: "nothing-yet" });
    expect(answerFrom("", true)).toEqual({ message: null, reason: "nothing-yet" });
    expect(answerFrom(chatFile(["x", prompt(P1, 1)]), false)).toEqual({
      message: null,
      reason: "too-far-back",
    });
  });

  test("the newest reply is made fit to show, its end kept when it is long, and one with nothing to show is nothing", () => {
    expect(answerFrom(chatFile([reply(R1, 1, "One.\r\nTwo.\tThree.\u0007")]), true)).toEqual({
      message: { text: "One.\nTwo.  Three.", cut: false },
    });
    const long = answerFrom(chatFile([reply(R1, 1, `${"x".repeat(3_000)} The very end.`)]), true);
    if (long.message === null) throw new Error("A message was expected.");
    expect(long.message.cut).toBe(true);
    expect(long.message.text.endsWith("The very end.")).toBe(true);
    expect(Array.from(long.message.text).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    // Only marks that are taken out.
    expect(answerFrom(chatFile([reply(R1, 1, "‎‮")]), true)).toEqual({
      message: null,
      reason: "nothing-yet",
    });
  });

  test("never carries token counts, though the reply's line has them", () => {
    const line = reply(R1, 1, "Counted.");
    expect(line).toContain('"tokens"');
    const answer = answerFrom(chatFile([line]), true);
    expect(answer).toEqual({ message: { text: "Counted.", cut: false } });
    expect(answer).not.toHaveProperty("tokens");
  });
});

const ID = geminiCliSessionId(SLUG, sessionIdOf("01"));
const FILE = chatPath(chatName(T, sessionIdOf("01")));

/** A reader over files in memory, with a clock moved by hand and drops run by the test. */
function setUp(limits = createTailLimits()) {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const drops: { run: () => void; ms: number }[] = [];
  const reader = createGeminiCliLastMessages({
    io: files.io,
    now: clock.now,
    limits,
    later: (run, ms) => drops.push({ run, ms }),
  });
  return { clock, files, reader, drops };
}

describe("the reader of Gemini CLI last messages", () => {
  test("reads only when asked, and only the file given for the session", async () => {
    const { files, reader } = setUp();
    files.write(FILE, chatFile([...opening(), prompt(P1, 1), reply(R1, 2, "Here it is.")]));
    reader.keep(new Map([[ID, FILE]]));
    expect(files.calls).toEqual([]);

    const answer = await reader.read(ID);
    expect(answer).toEqual({ message: { text: "Here it is.", cut: false } });
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([FILE]);
  });

  test("answers an id it was not given with nothing, and a listed one with no file not found", async () => {
    const { files, reader } = setUp();
    files.write(FILE, chatFile([reply(R1, 1, "Here.")]));
    await expect(reader.read(ID)).resolves.toBeNull();
    reader.keep(new Map<string, string | null>([[ID, null]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
    await expect(reader.read(geminiCliSessionId(SLUG, sessionIdOf("02")))).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a file that has gone is not found", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, chatFile([reply(R1, 1, "Here.")]));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Here.", cut: false } });

    files.remove(FILE);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
  });

  test("a file that grew is read again, for its newest reply, or the one before once that is taken back", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, chatFile([prompt(P1, 1), reply(R1, 2, "First.")]));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "First.", cut: false } });

    files.append(FILE, chatFile([prompt(P2, 3), reply(R2, 4, "Second.")]));
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Second.", cut: false } });

    files.append(FILE, chatFile([rewindLine(P2), updatedLine(at(5))]));
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "First.", cut: false } });
  });

  test(`reads at most the last ${TRANSCRIPT_TAIL_BYTES / 1024} KB, so a reply further back, or longer than that, is too far back`, async () => {
    const { files, reader } = setUp();
    const result = toolResultLine(P2, at(2));
    const results = chatFile(
      Array.from({ length: Math.ceil(TRANSCRIPT_TAIL_BYTES / result.length) + 1 }, () => result),
    );
    files.write(FILE, `${chatFile([...opening(), reply(R1, 1, "Far back.")])}${results}`);
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "too-far-back" });
    expect(files.reads.map((read) => read.length)).toEqual([TRANSCRIPT_TAIL_BYTES]);

    // A reply whose own line is longer than the end that is read: none of it is shown.
    const long = setUp();
    long.files.write(
      FILE,
      chatFile([
        ...opening(),
        prompt(P1, 1),
        reply(R1, 2, `${PRIVATE_WORDS} ${"w".repeat(TRANSCRIPT_TAIL_BYTES)}`),
      ]),
    );
    long.reader.keep(new Map([[ID, FILE]]));
    const answer = await long.reader.read(ID);
    expect(answer).toEqual({ message: null, reason: "too-far-back" });
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
  });

  test(`reads the newest reply from the last ${TRANSCRIPT_TAIL_BYTES / 1024} KB of a file longer than that`, async () => {
    expect(answerFrom(chatFile(["x", reply(R1, 1, "Near the end.")]), false)).toEqual({
      message: { text: "Near the end.", cut: false },
    });
    const { files, reader } = setUp();
    const result = toolResultLine(P2, at(2));
    const results = chatFile(
      Array.from({ length: Math.ceil(TRANSCRIPT_TAIL_BYTES / result.length) + 1 }, () => result),
    );
    files.write(
      FILE,
      `${chatFile([...opening(), prompt(P1, 1), reply(R1, 1, PRIVATE_WORDS)])}${results}${chatFile([reply(R2, 3, "Near the end."), updatedLine(at(3))])}`,
    );
    reader.keep(new Map([[ID, FILE]]));
    const answer = await reader.read(ID);
    expect(answer).toEqual({ message: { text: "Near the end.", cut: false } });
    expect(files.reads.map((read) => read.length)).toEqual([TRANSCRIPT_TAIL_BYTES]);
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
  });

  test("counts its reads against the limits it is given, which the other agents' readers share", async () => {
    const limits = createTailLimits();
    const { files, reader } = setUp(limits);
    const other = setUp(limits);
    const ids = Array.from({ length: READS_PER_SECOND + 1 }, (_, n) =>
      geminiCliSessionId(SLUG, sessionIdOf(`1${n}`)),
    );
    const targets = new Map<string, string>();
    ids.forEach((id, n) => {
      // Each began a minute after the one before, as their ids begin alike.
      const file = chatPath(chatName(T + n * MINUTE, sessionIdOf(`1${n}`)));
      files.write(file, chatFile([reply(R1, 1, `Reply ${n + 1}.`)]));
      other.files.write(file, chatFile([reply(R1, 1, `Other ${n + 1}.`)]));
      targets.set(id, file);
    });
    reader.keep(targets);
    other.reader.keep(targets);

    // The other reader takes one of the second's reads, so this one has one fewer.
    await expect(other.reader.read(ids[0] ?? "")).resolves.toEqual({
      message: { text: "Other 1.", cut: false },
    });
    const answers = [];
    for (const id of ids.slice(0, READS_PER_SECOND)) answers.push(await reader.read(id));
    expect(answers.slice(0, -1).every((answer) => answer !== "busy")).toBe(true);
    expect(answers.at(-1)).toBe("busy");
  });
});
