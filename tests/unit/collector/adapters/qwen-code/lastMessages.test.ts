import { describe, expect, test } from "vitest";

import {
  answerFrom,
  createQwenCodeLastMessages,
  lastSaidInChat,
} from "@collector/adapters/qwen-code/lastMessages";
import { TRANSCRIPT_TAIL_BYTES } from "@collector/files/transcriptTail";
import {
  ANSWER_AGAIN_MS,
  createTailLimits,
  READS_PER_SECOND,
} from "@collector/messages/tailReader";
import { MAX_MESSAGE_LENGTH } from "@core/text";
import {
  apiResponseLine,
  assistantLine,
  chatPath,
  compressionLine,
  lifecycleLine,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  promptLine,
  QWEN_DIR,
  SECOND,
  sessionIdOf,
  snapshotLine,
  systemLine,
  titleLine,
  toolResultLine,
  userLine,
} from "@tests/fixtures/qwen-code/qwenCode";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const T = NOW - 30 * MINUTE;
const at = (seconds: number) => T + seconds * SECOND;

/** The text a whole chat file gives, or null. */
const textOf = (...lines: string[]) => lastSaidInChat(lines.join(""), true);

/** Everything an answer says, as one string, to look for words that must never be in it. */
const said = (value: unknown) => JSON.stringify(value);

describe("what a Qwen Code session last said, from the end of its chat file", () => {
  test("is the text of the newest reply, never its thought", () => {
    const text = textOf(
      promptLine(at(0)),
      assistantLine(at(1), { says: "An older reply." }),
      promptLine(at(2)),
      assistantLine(at(3), { says: "The newest reply." }),
    );
    expect(text).toBe("The newest reply.");
    expect(text).not.toContain(PRIVATE_WORDS);
  });

  test("passes over a newer reply that only calls tools or only thinks, and their results, for the older reply", () => {
    expect(
      textOf(
        assistantLine(at(1), { says: "I will look first." }),
        assistantLine(at(2), { parts: [{ functionCall: { name: "read_file", args: {} } }] }),
        toolResultLine(at(3)),
        assistantLine(at(4), { parts: [{ text: PRIVATE_WORDS, thought: true }] }),
        assistantLine(at(5), { noMessage: true }),
      ),
    ).toBe("I will look first.");
  });

  test("takes the words of a reply that also calls a tool", () => {
    expect(textOf(assistantLine(at(1), { says: "Running the tests now.", calls: 2 }))).toBe(
      "Running the tests now.",
    );
  });

  test("joins a reply's text parts with nothing between them, and leaves out its thoughts among them", () => {
    expect(
      textOf(
        assistantLine(at(1), {
          parts: [
            { text: "First half, " },
            { text: PRIVATE_WORDS, thought: true },
            { text: "second half." },
            { functionCall: { name: "run_shell_command", args: { command: PRIVATE_WORDS } } },
          ],
        }),
      ),
    ).toBe("First half, second half.");
  });

  test("never takes a prompt, a tool's output, a title, telemetry or any other system line after the reply", () => {
    const text = textOf(
      assistantLine(at(1), { says: "Done." }),
      promptLine(at(2)),
      userLine(at(3), "notification", { deliveredTurn: true }),
      userLine(at(4), "mid_turn_user_message"),
      toolResultLine(at(5)),
      lifecycleLine(at(6), "started"),
      apiResponseLine(at(7)),
      titleLine(at(8), PRIVATE_WORDS),
      compressionLine(at(9), 200),
      snapshotLine(at(10)),
      systemLine(at(11), "turn_result", { text: PRIVATE_WORDS }),
    );
    expect(text).toBe("Done.");
  });

  test("never takes a line a subagent wrote into the file", () => {
    expect(
      textOf(
        assistantLine(at(1), { says: "The session's own reply." }),
        assistantLine(at(2), { says: PRIVATE_WORDS, sidechain: true }),
      ),
    ).toBe("The session's own reply.");
  });

  test("passes over a reply with a subtype, as the status does", () => {
    expect(
      textOf(
        assistantLine(at(1), { says: "Plain." }),
        assistantLine(at(2), { says: PRIVATE_WORDS, subtype: "summary" }),
      ),
    ).toBe("Plain.");
  });

  test("passes over parts that are not a list, and text that is empty, only spaces or not text", () => {
    for (const parts of [
      [{ text: "" }],
      [{ text: "   \n\t " }],
      [{ text: 42 }],
      [{ text: null }],
      ["A bare string."],
      [],
    ]) {
      expect(
        textOf(assistantLine(at(1), { says: "The older reply." }), assistantLine(at(2), { parts })),
        JSON.stringify(parts),
      ).toBe("The older reply.");
    }
    const notAList = assistantLine(at(2), { says: "x" }).replace(
      /"parts":\[[^\]]*\]/,
      '"parts":{"text":"An object."}',
    );
    expect(textOf(assistantLine(at(1), { says: "The older reply." }), notAList)).toBe(
      "The older reply.",
    );
  });

  test("never takes a reply's line quoted inside a prompt", () => {
    const quoted = assistantLine(at(9), { says: PRIVATE_WORDS }).trim();
    const prompt = promptLine(at(2)).replace(JSON.stringify(PRIVATE_WORDS), JSON.stringify(quoted));
    expect(prompt).toContain('\\"assistant\\"');
    expect(textOf(assistantLine(at(1), { says: "The real reply." }), prompt)).toBe(
      "The real reply.",
    );
  });

  test('goes by each line\'s own type, so a later prompt whose words are "assistant" is never taken for a reply', () => {
    const prompt = promptLine(at(2)).replace(JSON.stringify(PRIVATE_WORDS), '"assistant"');
    expect(prompt).toContain('"text":"assistant"');
    expect(textOf(assistantLine(at(1), { says: "The real reply." }), prompt)).toBe(
      "The real reply.",
    );
  });

  test("reads past a line that does not parse", () => {
    expect(
      textOf(
        assistantLine(at(1), { says: "Whole." }),
        '{"type":"assistant","message":{"parts":[{"text":"broken\n',
        'not json "assistant"\n',
      ),
    ).toBe("Whole.");
  });

  test("is nothing when no reply has been written yet, or none is in the end that was read", () => {
    expect(answerFrom(promptLine(at(0)), true)).toEqual({ message: null, reason: "nothing-yet" });
    expect(answerFrom("", true)).toEqual({ message: null, reason: "nothing-yet" });
    // The first line of a tail that is not the whole file is a part of a longer one, and is not read.
    const reply = assistantLine(at(1), { says: "Cut short." });
    expect(lastSaidInChat(reply, false)).toBeNull();
    expect(answerFrom(reply, false)).toEqual({ message: null, reason: "too-far-back" });
    expect(lastSaidInChat(reply, true)).toBe("Cut short.");
  });

  test("the newest reply is made fit to show, its end kept when it is long, and one with nothing to show is nothing", () => {
    expect(answerFrom(assistantLine(at(1), { says: "One.\r\nTwo.\tThree.\u0007" }), true)).toEqual({
      message: { text: "One.\nTwo.  Three.", cut: false },
    });
    const long = answerFrom(
      assistantLine(at(1), { says: `${"x".repeat(3_000)} The very end.` }),
      true,
    );
    if (long.message === null) throw new Error("A message was expected.");
    expect(long.message.cut).toBe(true);
    expect(long.message.text.endsWith("The very end.")).toBe(true);
    expect(Array.from(long.message.text).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    // Only marks that are taken out.
    expect(answerFrom(assistantLine(at(1), { says: "‎‮" }), true)).toEqual({
      message: null,
      reason: "nothing-yet",
    });
  });

  test("never carries token counts, though the reply's line has them", () => {
    const line = assistantLine(at(1), { says: "Counted." });
    expect(line).toContain("usageMetadata");
    const answer = answerFrom(line, true);
    expect(answer).toEqual({ message: { text: "Counted.", cut: false } });
    expect(answer).not.toHaveProperty("tokens");
  });
});

const ID = `qwen-code:${sessionIdOf(1)}`;
const FILE = chatPath(QWEN_DIR, sessionIdOf(1));

/** A reader over files in memory, with a clock moved by hand and drops run by the test. */
function setUp(limits = createTailLimits()) {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const drops: { run: () => void; ms: number }[] = [];
  const reader = createQwenCodeLastMessages({
    io: files.io,
    now: clock.now,
    limits,
    later: (run, ms) => drops.push({ run, ms }),
  });
  return { clock, files, reader, drops };
}

describe("the reader of Qwen Code last messages", () => {
  test("reads only when asked, and only the chat file given for the session", async () => {
    const { files, reader } = setUp();
    files.write(FILE, [promptLine(at(0)), assistantLine(at(1), { says: "Here it is." })].join(""));
    reader.keep(new Map([[ID, FILE]]));
    expect(files.calls).toEqual([]);

    const answer = await reader.read(ID);
    expect(answer).toEqual({ message: { text: "Here it is.", cut: false } });
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([FILE]);
  });

  test("answers an id it was not given with nothing, and a listed one with no chat file not found", async () => {
    const { files, reader } = setUp();
    files.write(FILE, assistantLine(at(1), { says: "Here." }));
    await expect(reader.read(ID)).resolves.toBeNull();
    reader.keep(new Map<string, string | null>([[ID, null]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
    await expect(reader.read(`qwen-code:${sessionIdOf(2)}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a chat file that has gone is not found", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, assistantLine(at(1), { says: "Here." }));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Here.", cut: false } });

    files.remove(FILE);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
  });

  test("a chat file that grew is read again for its newest reply", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, assistantLine(at(1), { says: "First." }));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "First.", cut: false } });

    files.append(FILE, `${promptLine(at(2))}${assistantLine(at(3), { says: "Second." })}`);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Second.", cut: false } });
  });

  test(`reads at most the last ${TRANSCRIPT_TAIL_BYTES / 1024} KB, so a reply further back, or longer than that, is too far back`, async () => {
    const { files, reader } = setUp();
    const result = toolResultLine(at(2));
    const results = result.repeat(Math.ceil(TRANSCRIPT_TAIL_BYTES / result.length) + 1);
    files.write(FILE, `${assistantLine(at(1), { says: "Far back." })}${results}`);
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "too-far-back" });
    expect(files.reads.map((read) => read.length)).toEqual([TRANSCRIPT_TAIL_BYTES]);

    // A reply whose own line is longer than the end that is read: none of it is shown.
    const long = setUp();
    long.files.write(
      FILE,
      `${promptLine(at(0))}${assistantLine(at(1), { says: `${PRIVATE_WORDS} ${"w".repeat(TRANSCRIPT_TAIL_BYTES)}` })}`,
    );
    long.reader.keep(new Map([[ID, FILE]]));
    await expect(long.reader.read(ID)).resolves.toEqual({ message: null, reason: "too-far-back" });
  });

  test("counts its reads against the limits it is given, which the other agents' readers share", async () => {
    const limits = createTailLimits();
    const { files, reader } = setUp(limits);
    const other = setUp(limits);
    const ids = Array.from(
      { length: READS_PER_SECOND + 1 },
      (_, n) => `qwen-code:${sessionIdOf(n + 1)}`,
    );
    const targets = new Map<string, string>();
    ids.forEach((id, n) => {
      const file = chatPath(QWEN_DIR, sessionIdOf(n + 1));
      files.write(file, assistantLine(at(1), { says: `Reply ${n + 1}.` }));
      other.files.write(file, assistantLine(at(1), { says: `Other ${n + 1}.` }));
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
