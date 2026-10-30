import { describe, expect, test } from "vitest";

import {
  answerFrom,
  createAntigravityLastMessages,
  lastSaidInTranscript,
} from "@collector/adapters/antigravity/shared/lastMessages";
import { TRANSCRIPT_TAIL_BYTES } from "@collector/files/transcriptTail";
import { ANSWER_AGAIN_MS, createTailLimits } from "@collector/messages/tailReader";
import { MAX_MESSAGE_LENGTH } from "@core/text";
import {
  AGY_HOME,
  conversationId,
  fullTranscriptPath,
  MINUTE,
  NEVER_SHOWN,
  NOW,
  PRIVATE_WORDS,
  replyStep,
  SECOND,
  step,
  textStep,
  transcriptPath,
} from "@tests/fixtures/antigravity";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const T = NOW - 30 * MINUTE;
const at = (seconds: number) => T + seconds * SECOND;

/** A whole transcript, read from its start. */
const whole = (...lines: string[]) => lastSaidInTranscript(lines.join(""), true);

/** The text a whole transcript gives, or null. */
const textOf = (...lines: string[]) => whole(...lines)?.text ?? null;

/** Everything an answer says, as one string, to look for words that must never be in it. */
const said = (value: unknown) => JSON.stringify(value);

describe("what an Antigravity session last said, from the end of its transcript", () => {
  test("is the content of the newest reply", () => {
    expect(
      whole(
        textStep(0, "USER_INPUT", at(0), "Tidy the docs."),
        replyStep({ index: 1, at: at(1), content: "An older reply." }),
        replyStep({ index: 2, at: at(2), content: "The newest reply." }),
      ),
    ).toEqual({ text: "The newest reply.", endCut: false });
  });

  test("takes a reply whose type is written in another case, as its type is read", () => {
    expect(
      textOf(
        replyStep({ index: 1, at: at(1), content: "An older reply." }),
        replyStep({
          index: 2,
          at: at(2),
          type: "cortex_step_type_planner_response",
          content: "Newer.",
        }),
      ),
    ).toBe("Newer.");
  });

  test("passes over a newer reply that only calls tools and has no content, for the older reply", () => {
    expect(
      textOf(
        replyStep({ index: 1, at: at(1), content: "I will look first." }),
        replyStep({ index: 2, at: at(2), tools: ["view_file"] }),
        textStep(3, "GENERIC", at(3), `Output: ${PRIVATE_WORDS}`),
        replyStep({ index: 4, at: at(4), tools: ["run_command"] }),
      ),
    ).toBe("I will look first.");
  });

  test("never takes a prompt, a tool's output or a system message after the reply", () => {
    const text = textOf(
      replyStep({ index: 1, at: at(1), content: "Done." }),
      textStep(2, "USER_INPUT", at(2), `Prompt: ${PRIVATE_WORDS}`),
      textStep(3, "GENERIC", at(3), `Output: ${PRIVATE_WORDS}`),
      textStep(4, "SYSTEM_MESSAGE", at(4), `System: ${PRIVATE_WORDS}`),
      step({ index: 5, type: "RUN_COMMAND", at: at(5) }),
    );
    expect(text).toBe("Done.");
  });

  test("never takes thinking, tool calls or media, and a reply with only those gives nothing", () => {
    const answer = answerFrom(
      replyStep({ index: 1, at: at(1), content: "Visible words.", tools: ["run_command"] }),
      true,
    );
    expect(answer).toEqual({ message: { text: "Visible words.", cut: false } });
    for (const words of Object.values(NEVER_SHOWN)) expect(said(answer)).not.toContain(words);

    expect(answerFrom(replyStep({ index: 1, at: at(1), tools: ["run_command"] }), true)).toEqual({
      message: null,
      reason: "nothing-yet",
    });
  });

  test("passes over content that is a list of parts, empty, only spaces, or not text", () => {
    for (const content of [
      [{ text: "In parts." }],
      "",
      "   \n\t ",
      42,
      null,
      { text: "An object." },
    ]) {
      expect(
        textOf(
          replyStep({ index: 1, at: at(1), content: "The older reply." }),
          replyStep({ index: 2, at: at(2), content }),
        ),
        JSON.stringify(content),
      ).toBe("The older reply.");
    }
  });

  test("passes over a reply agy cleared or marked invalid, and takes one that ended in an error or is done", () => {
    for (const status of ["CLEARED", "INVALID", "CORTEX_STEP_STATUS_CLEARED"]) {
      expect(
        textOf(
          replyStep({ index: 1, at: at(1), content: "Kept." }),
          replyStep({ index: 2, at: at(2), content: "Taken back.", status }),
        ),
        status,
      ).toBe("Kept.");
    }
    for (const status of ["ERROR", "DONE", "RUNNING"]) {
      expect(
        textOf(
          replyStep({ index: 1, at: at(1), content: "Older." }),
          replyStep({ index: 2, at: at(2), content: "Newer.", status }),
        ),
        status,
      ).toBe("Newer.");
    }
  });

  test("takes a reply whose type is written with agy's prefix", () => {
    expect(
      textOf(
        replyStep({
          index: 1,
          at: at(1),
          content: "Prefixed.",
          type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
        }),
      ),
    ).toBe("Prefixed.");
  });

  test("never takes a reply's line quoted inside a prompt", () => {
    const quoted = replyStep({ index: 9, at: at(9), content: PRIVATE_WORDS }).trim();
    expect(
      textOf(
        replyStep({ index: 1, at: at(1), content: "The real reply." }),
        textStep(2, "USER_INPUT", at(2), quoted),
      ),
    ).toBe("The real reply.");
  });

  test("reads past a line that does not parse", () => {
    expect(
      textOf(
        replyStep({ index: 1, at: at(1), content: "Whole." }),
        '{"type":"PLANNER_RESPONSE","content":"broken\n',
        "not json PLANNER_RESPONSE\n",
      ),
    ).toBe("Whole.");
  });

  test("is nothing when no reply has been written yet, or none is in the end that was read", () => {
    expect(answerFrom(textStep(0, "USER_INPUT", at(0), "Start"), true)).toEqual({
      message: null,
      reason: "nothing-yet",
    });
    expect(answerFrom("", true)).toEqual({ message: null, reason: "nothing-yet" });
    // The first line of a tail that is not the whole file is a part of a longer one, and is not read.
    const reply = replyStep({ index: 1, at: at(1), content: "Cut short." });
    expect(lastSaidInTranscript(reply, false)).toBeNull();
    expect(answerFrom(reply, false)).toEqual({ message: null, reason: "too-far-back" });
    expect(lastSaidInTranscript(reply, true)?.text).toBe("Cut short.");
  });

  test("a reply whose content the transcript cut is shown as its start, with its end said to be left out", () => {
    const content = `${"A".repeat(1_500)}\n${"B".repeat(450)}\n${"C".repeat(2_000)}`;
    const answer = answerFrom(
      replyStep({ index: 1, at: at(1), content, truncated: ["content"] }),
      true,
    );
    expect(answer).toEqual({
      message: { text: `${"A".repeat(1_500)}\n${"B".repeat(450)}`, cut: false, endCut: true },
    });

    // A short one that was cut is all shown, still with its end said to be left out.
    expect(
      answerFrom(
        replyStep({
          index: 1,
          at: at(1),
          content: "Short start.",
          truncated: ["thinking", "content"],
        }),
        true,
      ),
    ).toEqual({ message: { text: "Short start.", cut: false, endCut: true } });
  });

  test("a reply whose thinking alone was cut takes the usual way, and a long one keeps its end", () => {
    const content = `${"x".repeat(3_000)} The very end.`;
    const answer = answerFrom(
      replyStep({ index: 1, at: at(1), content, truncated: ["thinking"] }),
      true,
    );
    if (answer.message === null) throw new Error("A message was expected.");
    expect(answer.message.cut).toBe(true);
    expect(answer.message).not.toHaveProperty("endCut");
    expect(answer.message.text.endsWith("The very end.")).toBe(true);
    expect(Array.from(answer.message.text).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);

    // `truncated_fields` that is not a list says nothing.
    expect(
      answerFrom(replyStep({ index: 1, at: at(1), content: "Plain.", truncated: "content" }), true),
    ).toEqual({ message: { text: "Plain.", cut: false } });
  });

  test("truncated_fields of any shape but a list takes the usual way, so no end is said to be left out", () => {
    for (const truncated of [{ content: 4120 }, { content: true }, null, 1, true]) {
      expect(
        answerFrom(replyStep({ index: 1, at: at(1), content: "Whole.", truncated }), true),
        JSON.stringify(truncated),
      ).toEqual({ message: { text: "Whole.", cut: false } });
    }
    // A list that names `content` only in another case, or inside a longer name, says nothing of it.
    for (const truncated of [["Content"], ["content_parts"], [["content"]]]) {
      expect(
        answerFrom(replyStep({ index: 1, at: at(1), content: "Whole.", truncated }), true),
        JSON.stringify(truncated),
      ).toEqual({ message: { text: "Whole.", cut: false } });
    }
  });

  test("the newest reply is made fit to show, cut or not, and one with nothing to show is nothing", () => {
    expect(
      answerFrom(replyStep({ index: 1, at: at(1), content: "One.\r\nTwo.\tThree.\u0007" }), true),
    ).toEqual({ message: { text: "One.\nTwo.  Three.", cut: false } });
    expect(
      answerFrom(
        replyStep({ index: 1, at: at(1), content: "One.\r\nTwo.‮", truncated: ["content"] }),
        true,
      ),
    ).toEqual({ message: { text: "One.\nTwo.", cut: false, endCut: true } });
    // Only marks that are taken out: as Codex's reader answers it, not an older reply.
    for (const truncated of [undefined, ["content"]]) {
      const lines = [
        replyStep({ index: 1, at: at(1), content: "Older." }),
        replyStep({ index: 2, at: at(2), content: "‎‮", truncated }),
      ].join("");
      expect(answerFrom(lines, true), JSON.stringify(truncated)).toEqual({
        message: null,
        reason: "nothing-yet",
      });
      expect(answerFrom(`partial line\n${lines}`, false)).toEqual({
        message: null,
        reason: "too-far-back",
      });
    }
  });

  test("never carries token counts, even when the reply's line has them", () => {
    const answer = answerFrom(
      replyStep({
        index: 1,
        at: at(1),
        content: "Counted.",
        counts: { input_tokens: 1200, cache_read_tokens: 800, output_tokens: 64 },
      }),
      true,
    );
    expect(answer).toEqual({ message: { text: "Counted.", cut: false } });
    expect(answer).not.toHaveProperty("tokens");
  });
});

const ID = `antigravity-cli:${conversationId("a1")}`;
const FILE = transcriptPath(AGY_HOME, conversationId("a1"));
const FULL = fullTranscriptPath(AGY_HOME, conversationId("a1"));

/** A reader over files in memory, with a clock moved by hand and drops run by the test. */
function setUp(limits = createTailLimits()) {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const drops: { run: () => void; ms: number }[] = [];
  const reader = createAntigravityLastMessages({
    io: files.io,
    now: clock.now,
    limits,
    later: (run, ms) => drops.push({ run, ms }),
  });
  return { clock, files, reader, drops };
}

describe("the reader of Antigravity last messages", () => {
  test("reads only when asked, and only the transcript given for the session, never the whole one beside it", async () => {
    const { files, reader } = setUp();
    files.write(
      FILE,
      replyStep({ index: 1, at: at(1), content: "Kept part.", truncated: ["content"] }),
    );
    files.write(FULL, replyStep({ index: 1, at: at(1), content: `Kept part. ${PRIVATE_WORDS}` }));
    reader.keep(new Map([[ID, FILE]]));
    expect(files.calls).toEqual([]);

    const answer = await reader.read(ID);
    expect(answer).toEqual({ message: { text: "Kept part.", cut: false, endCut: true } });
    expect(said(answer)).not.toContain(PRIVATE_WORDS);
    expect(files.opened()).toEqual([FILE]);
  });

  test("answers an id it was not given with nothing, and a listed one with no transcript not found", async () => {
    const { files, reader } = setUp();
    files.write(FILE, replyStep({ index: 1, at: at(1), content: "Here." }));
    await expect(reader.read(ID)).resolves.toBeNull();
    reader.keep(new Map<string, string | null>([[ID, null]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
    await expect(reader.read(`antigravity-app:${conversationId("a1")}`)).resolves.toBeNull();
    expect(files.calls).toEqual([]);
  });

  test("a transcript that has gone is not found", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, replyStep({ index: 1, at: at(1), content: "Here." }));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Here.", cut: false } });

    files.remove(FILE);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
  });

  test("an unchanged transcript is opened to compare and not read, and one agy compacted since is read again", async () => {
    const { clock, files, reader } = setUp();
    files.write(
      FILE,
      [
        textStep(0, "USER_INPUT", at(0), "Start"),
        replyStep({ index: 1, at: at(1), content: "Before it was compacted." }),
        textStep(2, "GENERIC", at(2), "Output"),
      ].join(""),
    );
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({
      message: { text: "Before it was compacted.", cut: false },
    });

    files.forget();
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({
      message: { text: "Before it was compacted.", cut: false },
    });
    expect(files.opened()).toEqual([FILE]);
    expect(files.reads).toEqual([]);

    // Rewritten in place, shorter, as agy does when it compacts a conversation.
    clock.advance(ANSWER_AGAIN_MS);
    files.rewrite(FILE, replyStep({ index: 0, at: at(5), content: "After." }));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "After.", cut: false } });
    expect(files.reads).toHaveLength(1);
    expect(files.openHandles()).toBe(0);
  });

  test(`reads at most the last ${TRANSCRIPT_TAIL_BYTES / 1024} KB, so a reply further back, or longer than that, is too far back`, async () => {
    const { files, reader } = setUp();
    const output = textStep(2, "GENERIC", at(2), "o".repeat(1_000));
    const outputs = output.repeat(Math.ceil(TRANSCRIPT_TAIL_BYTES / output.length) + 1);
    files.write(FILE, `${replyStep({ index: 1, at: at(1), content: "Far back." })}${outputs}`);
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "too-far-back" });
    expect(files.reads.map((read) => read.length)).toEqual([TRANSCRIPT_TAIL_BYTES]);

    // A reply whose own line is longer than the end that is read: none of it is shown.
    const long = setUp();
    const content = `${PRIVATE_WORDS} ${"w".repeat(TRANSCRIPT_TAIL_BYTES)}`;
    long.files.write(
      FILE,
      `${textStep(0, "USER_INPUT", at(0), "Start")}${replyStep({ index: 1, at: at(1), content })}`,
    );
    long.reader.keep(new Map([[ID, FILE]]));
    const answer = await long.reader.read(ID);
    expect(answer).toEqual({ message: null, reason: "too-far-back" });
  });

  test("counts its reads against the limits it is given", async () => {
    const limits = createTailLimits();
    let asked = 0;
    const counted = {
      ...limits,
      mayRead(atMs: number) {
        asked += 1;
        return limits.mayRead(atMs);
      },
    };
    const { files, reader } = setUp(counted);
    files.write(FILE, replyStep({ index: 1, at: at(1), content: "Here." }));
    reader.keep(new Map([[ID, FILE]]));
    await reader.read(ID);
    expect(asked).toBe(1);
  });
});
