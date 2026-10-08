import { describe, expect, test } from "vitest";

import { lastSaidInTail } from "@collector/adapters/claude-code/transcript/lastSaid";
import {
  otherLines,
  prompt,
  said,
  saidInParts,
  thought,
  toolResult,
  toolUse,
  toolUseId,
  transcript,
  type TranscriptLine,
} from "@tests/fixtures/claudeTranscript";

/** What a whole transcript of these lines says the session last said. */
function lastSaid(lines: readonly TranscriptLine[]) {
  return lastSaidInTail(transcript(lines), true);
}

/** A word put in every line whose words must never be taken. */
const PRIVATE = "PRIVATE";

/** A user line holding the result of a tool use, with these words as its output. */
function toolOutput(id: string, output: string): TranscriptLine {
  return {
    type: "user",
    isSidechain: false,
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: id, content: [{ type: "text", text: output }] },
      ],
    },
  };
}

/** An assistant line of words that Claude Code marks as its own note. */
function metaReply(text: string, messageId: string): TranscriptLine {
  return {
    type: "assistant",
    isSidechain: false,
    isMeta: true,
    message: { id: messageId, role: "assistant", content: [{ type: "text", text }] },
  };
}

/**
 * Every kind of line whose words are not what the session said, each holding
 * the PRIVATE word: prompts, Claude Code's notes and summaries, thinking, a
 * tool's input and its output, and a subagent's reply.
 */
function linesNeverTaken(messageId: string): TranscriptLine[] {
  const id = toolUseId();
  return [
    prompt(`${PRIVATE} prompt typed as text`),
    {
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ type: "text", text: `${PRIVATE} prompt in blocks` }] },
    },
    {
      type: "user",
      isSidechain: false,
      isMeta: true,
      message: { role: "user", content: `${PRIVATE} note of Claude Code's own` },
    },
    {
      type: "user",
      isSidechain: false,
      isCompactSummary: true,
      message: { role: "user", content: [{ type: "text", text: `${PRIVATE} compacted summary` }] },
    },
    thought(`${PRIVATE} thinking`, { messageId }),
    thought(`${PRIVATE} redacted thinking`, { messageId, redacted: true }),
    toolUse(id, "Bash", { command: `echo ${PRIVATE}`, description: PRIVATE }, { messageId }),
    toolOutput(id, `${PRIVATE} tool output`),
    toolResult(id, { sidechain: true }),
    said(`${PRIVATE} subagent reply`, { messageId, sidechain: true }),
    metaReply(`${PRIVATE} meta reply`, messageId),
    { type: "system", isSidechain: false, content: `${PRIVATE} system note` },
    {
      type: "system",
      isSidechain: false,
      message: { content: [{ type: "text", text: `${PRIVATE} system blocks` }] },
    },
    { type: "attachment", isSidechain: false, attachment: { type: "text", content: PRIVATE } },
    { type: "last-prompt", lastPrompt: `${PRIVATE} last prompt` },
    { type: "summary", summary: `${PRIVATE} summary` },
  ];
}

describe("what a session last said", () => {
  test("is the newest words it said, not older ones", () => {
    const id = toolUseId();
    expect(
      lastSaid([
        prompt("Run the tests"),
        said("I will run them now.", { messageId: "msg_1" }),
        toolUse(id, "Bash", { command: "npm test" }, { messageId: "msg_1" }),
        toolResult(id),
        ...otherLines,
        said("All 12 tests pass.", { messageId: "msg_2" }),
      ]),
    ).toEqual({ text: "All 12 tests pass." });
  });

  test("joins the parts of one message in the order they were written, with a blank line between", () => {
    expect(
      lastSaid([
        prompt("Plan it"),
        ...saidInParts(["First, the plan.", "Then the steps."], { messageId: "msg_1" }),
      ]),
    ).toEqual({ text: "First, the plan.\n\nThen the steps." });
    // Its thinking and its tool uses sit between the parts and are not taken.
    expect(
      lastSaid([
        said("An older message.", { messageId: "msg_0" }),
        thought("Weighing it up", { messageId: "msg_1" }),
        said("Part one.", { messageId: "msg_1" }),
        toolUse(toolUseId(), "Read", { file_path: "README.md" }, { messageId: "msg_1" }),
        said("Part two.", { messageId: "msg_1" }),
      ]),
    ).toEqual({ text: "Part one.\n\nPart two." });
    // So do Claude Code's own lines and a subagent's, which are read past.
    expect(
      lastSaid([
        said("Part one.", { messageId: "msg_1" }),
        ...otherLines,
        said("Words of a subagent.", { messageId: "msg_subagent", sidechain: true }),
        toolResult(toolUseId(), { sidechain: true }),
        said("Part two.", { messageId: "msg_1" }),
      ]),
    ).toEqual({ text: "Part one.\n\nPart two." });
  });

  test("joins the words of one line that holds several blocks", () => {
    expect(
      lastSaid([
        {
          type: "assistant",
          isSidechain: false,
          message: {
            id: "msg_1",
            role: "assistant",
            content: [
              { type: "text", text: "One." },
              { type: "thinking", thinking: "Not this." },
              { type: "text", text: "Two." },
            ],
          },
        },
      ]),
    ).toEqual({ text: "One.\n\nTwo." });
  });

  test("never joins two messages: it stops at a user line or another message's line", () => {
    expect(
      lastSaid([
        said("Earlier.", { messageId: "msg_1" }),
        toolResult(toolUseId()),
        said("Later.", { messageId: "msg_1" }),
      ]),
    ).toEqual({ text: "Later." });
    expect(
      lastSaid([
        said("Before.", { messageId: "msg_1" }),
        prompt("Go on"),
        said("After.", { messageId: "msg_1" }),
      ]),
    ).toEqual({ text: "After." });
    expect(
      lastSaid([
        said("One.", { messageId: "msg_1" }),
        toolUse(toolUseId(), "Bash", { command: "ls" }, { messageId: "msg_2" }),
        said("Two.", { messageId: "msg_1" }),
      ]),
    ).toEqual({ text: "Two." });
  });

  test("a line with no message id is a message on its own", () => {
    const noId = { messageId: null };
    expect(lastSaid([said("One.", noId), said("Two.", noId)])).toEqual({ text: "Two." });
    expect(lastSaid([said("One.", { messageId: "msg_1" }), said("Two.", noId)])).toEqual({
      text: "Two.",
    });
    expect(lastSaid([said("One.", noId), said("Two.", { messageId: "msg_1" })])).toEqual({
      text: "Two.",
    });
  });

  test("a reply the person has typed a prompt after is still the last thing said", () => {
    expect(lastSaid([said("Done. The build passes."), prompt("Now deploy it")])).toEqual({
      text: "Done. The build passes.",
    });
  });

  test("a newer message with no words in it does not hide the words before it", () => {
    expect(
      lastSaid([
        said("I will check the logs.", { messageId: "msg_1" }),
        thought("Which file?", { messageId: "msg_2" }),
        toolUse(toolUseId(), "Bash", { command: "tail app.log" }, { messageId: "msg_2" }),
      ]),
    ).toEqual({ text: "I will check the logs." });
  });
});

describe("what is never taken", () => {
  test("words in thinking, tool input and output, prompts, isMeta, subagent and Claude Code's own lines", () => {
    const answer = lastSaid([
      ...linesNeverTaken("msg_1"),
      said("The reply.", { messageId: "msg_1" }),
      ...linesNeverTaken("msg_1"),
      ...linesNeverTaken("msg_2"),
    ]);
    expect(answer).toEqual({ text: "The reply." });
    expect(JSON.stringify(answer)).not.toContain(PRIVATE);
  });

  test("so a transcript of only those lines has said nothing yet", () => {
    expect(lastSaid([...linesNeverTaken("msg_1"), ...linesNeverTaken("msg_2")])).toEqual({
      text: null,
      reason: "nothing-yet",
    });
  });
});

describe("what is read past", () => {
  test("a line that does not parse is skipped, and the next one is read", () => {
    const tail = [
      "not json at all",
      '{"type": "assistant", "message": ',
      "[1, 2, 3]",
      "null",
      '"words"',
      JSON.stringify(said("Read this.")),
      "{broken",
      "",
    ].join("\n");
    expect(lastSaidInTail(tail, true)).toEqual({ text: "Read this." });
  });

  test("a field of the wrong kind is no field", () => {
    const wrong: TranscriptLine[] = [
      { type: "assistant", message: "not an object" },
      { type: "assistant", message: { content: "a string, not blocks" } },
      { type: "assistant", message: { content: { type: "text", text: "not a list" } } },
      { type: "assistant", message: { content: [null, 7, "text", ["text"]] } },
      { type: "assistant", message: { content: [{ type: "text", text: 42 }] } },
      { type: "assistant", message: { content: [{ type: "text", text: " \n " }] } },
      { type: "assistant", message: { content: [{ type: "Text", text: "Not a text block." }] } },
      { type: ["assistant"], message: { content: [{ type: "text", text: "Not a type." }] } },
      { type: "assistant", isSidechain: true, message: { content: "a subagent's words" } },
    ];
    expect(lastSaid([said("The real reply."), ...wrong])).toEqual({ text: "The real reply." });
    expect(lastSaid(wrong)).toEqual({ text: null, reason: "nothing-yet" });
  });

  test("a message id that is not text is no id, so lines with it are not joined", () => {
    const withId = (id: unknown, text: string): TranscriptLine => ({
      type: "assistant",
      isSidechain: false,
      message: { id, role: "assistant", content: [{ type: "text", text }] },
    });
    expect(lastSaid([withId(42, "One."), withId(42, "Two.")])).toEqual({ text: "Two." });
    expect(lastSaid([withId("", "One."), withId("", "Two.")])).toEqual({ text: "Two." });
  });
});

describe("when nothing is said", () => {
  test("the whole transcript with no reply in it has said nothing yet", () => {
    const id = toolUseId();
    expect(lastSaidInTail("", true)).toEqual({ text: null, reason: "nothing-yet" });
    expect(lastSaid([prompt("Hello")])).toEqual({ text: null, reason: "nothing-yet" });
    expect(
      lastSaid([
        prompt("Run the tests"),
        thought("They are in tests/"),
        toolUse(id, "Bash", { command: "npm test" }),
        toolResult(id),
        ...otherLines,
      ]),
    ).toEqual({ text: null, reason: "nothing-yet" });
  });

  test("only the end of a transcript, with no reply in it, says the reply is further back", () => {
    const id = toolUseId();
    const tail = transcript([
      prompt("Go on"),
      toolUse(id, "Bash", { command: "ls" }),
      toolResult(id),
    ]);
    expect(lastSaidInTail(`cut short"}\n${tail}`, false)).toEqual({
      text: null,
      reason: "too-far-back",
    });
    expect(lastSaidInTail("", false)).toEqual({ text: null, reason: "too-far-back" });
  });
});

describe("the tail of a long transcript", () => {
  test("its first line, cut short, is not read unless the tail is the whole file", () => {
    const line = JSON.stringify(said("The first line."));
    // A whole line at the very start of the file is read.
    expect(lastSaidInTail(`${line}\n`, true)).toEqual({ text: "The first line." });
    // The same line as the first of a tail could be the end of a longer one, so it is not.
    expect(lastSaidInTail(`${line}\n`, false)).toEqual({ text: null, reason: "too-far-back" });
    // The lines after it are read. As the cut line may be a part of the same
    // message, the start of the message may be further back.
    const later = JSON.stringify(said("A later line."));
    expect(lastSaidInTail(`${line.slice(30)}\n${later}\n`, false)).toEqual({
      text: "A later line.",
      startCut: true,
    });
  });

  test("a message that runs back past the start of the tail says its start may be left out", () => {
    const file = transcript([
      prompt("Write it all out"),
      said("x".repeat(300_000), { messageId: "msg_1" }),
      said("Part two.", { messageId: "msg_1" }),
    ]);
    // The first part is cut short at the start of the tail, so it is not read.
    const tail = file.slice(file.length - 256 * 1024);
    expect(lastSaidInTail(tail, false)).toEqual({ text: "Part two.", startCut: true });
    // Read whole, the message is all there.
    expect(lastSaidInTail(file, true)).toEqual({ text: `${"x".repeat(300_000)}\n\nPart two.` });
  });

  test("a message that starts after a user line or another message's line in the tail is whole", () => {
    const message = [
      said("Part one.", { messageId: "msg_1" }),
      ...otherLines,
      said("Part two.", { messageId: "msg_1" }),
    ];
    const whole = { text: "Part one.\n\nPart two." };
    for (const before of [prompt("Go on"), said("Older.", { messageId: "msg_0" })]) {
      const tail = `cut short"}\n${transcript([before, ...message])}`;
      expect(lastSaidInTail(tail, false)).toEqual(whole);
    }
    // With nothing before it in the tail, its start may be further back.
    expect(lastSaidInTail(`cut short"}\n${transcript(message)}`, false)).toEqual({
      ...whole,
      startCut: true,
    });
    // A line with no message id is a message on its own, so it is whole.
    expect(
      lastSaidInTail(`cut short"}\n${transcript([said("Alone.", { messageId: null })])}`, false),
    ).toEqual({
      text: "Alone.",
    });
  });

  test("a last reply longer than the tail gives no text, not an older one", () => {
    const file = transcript([
      said("An older reply.", { messageId: "msg_1" }),
      prompt("Write it all out"),
      said("x".repeat(300_000), { messageId: "msg_2" }),
    ]);
    // The tail holds part of the last line only.
    const tail = file.slice(file.length - 256 * 1024);
    expect(lastSaidInTail(tail, false)).toEqual({ text: null, reason: "too-far-back" });
  });
});
