import { describe, expect, onTestFinished, test, vi } from "vitest";

import {
  entryOf,
  historySteps,
  newestReply,
  replay,
  replyTextOf,
  type HistoryWindow,
} from "@collector/adapters/mistral-vibe/history/replies";
import {
  PRIVATE_WORDS,
  appendStep,
  callbackEntry,
  callbackRegistered,
  checkpointEntry,
  effectEntry,
  historyDelta,
  imageBlock,
  noticeEntry,
  otherRecord,
  publicState,
  reasoningEntry,
  record,
  relocatedRecord,
  removeStep,
  replaceStep,
  replyEntry,
  resourceBlock,
  sessionApiFacts,
  sessionId,
  setEntriesStep,
  textBlock,
  userEntry,
} from "@tests/fixtures/mistralVibe";

const A = sessionId("a1");

/** A history known to start empty, as a whole journal over a generation with no pieces. */
const EMPTY: HistoryWindow = { entries: [], before: false };

/** A history whose older entries are not known. */
const UNKNOWN: HistoryWindow = { entries: [], before: true };

/** What a whole journal of these lines says the session last said, over `base`. */
const foundIn = (lines: string[], base: HistoryWindow = EMPTY, fromStart = true) =>
  newestReply(replay(base, historySteps(lines.join(""), fromStart)));

/** The newest reply of a whole journal that appends these entries one record each. */
const replyAmong = (...entries: unknown[]) =>
  foundIn(entries.map((entry, n) => historyDelta(n + 5, [appendStep(entry)]))).text;

/** Everything a result says, as one string, to look for words that must never be in it. */
const said = (value: unknown) => JSON.stringify(value);

describe("the text of a Mistral Vibe reply", () => {
  test("is its text blocks joined with a blank line, without its image or resource blocks", () => {
    const text = replyTextOf(
      replyEntry("assistant-1", [
        textBlock("Here is the plan."),
        imageBlock(),
        textBlock("It has two steps."),
        resourceBlock(),
      ]),
    );
    expect(text).toBe("Here is the plan.\n\nIt has two steps.");
    expect(said(text)).not.toContain(PRIVATE_WORDS);
  });

  test("is none for a reply with only an image, only spaces, or no text blocks", () => {
    expect(replyTextOf(replyEntry("assistant-1", [imageBlock()]))).toBeNull();
    expect(replyTextOf(replyEntry("assistant-1", [textBlock("  \n\t ")]))).toBeNull();
    expect(replyTextOf(replyEntry("assistant-1", []))).toBeNull();
    expect(replyTextOf({ ...replyEntry("assistant-1", "Hi."), content: "Hi." })).toBeNull();
    expect(replyTextOf(replyEntry("assistant-1", [{ type: "text", text: 7 }]))).toBeNull();
  });

  test("is never that of thinking, a tool, a prompt, a question, a rewind's mark or a notice", () => {
    for (const entry of [
      reasoningEntry("reasoning-1-0"),
      effectEntry("effect-1"),
      userEntry("user-1"),
      callbackEntry("user-input-call-1"),
      checkpointEntry("checkpoint-rewind-user-1"),
      noticeEntry("notice-1"),
      { ...userEntry("system-1"), role: "system" },
    ]) {
      expect(replyTextOf(entry), String(entry.type)).toBeNull();
    }
  });

  test("passes over a draft Vibe discarded, unless an interrupt cut it short", () => {
    for (const cause of ["failure", "steer", "retry", "skipped", "a newer cause"]) {
      const draft = replyEntry("assistant-1", PRIVATE_WORDS, {
        outcome: { type: "discarded", cause },
      });
      expect(replyTextOf(draft), cause).toBeNull();
    }
    const interrupted = replyEntry("assistant-1", "Half an answer", {
      outcome: { type: "discarded", cause: "interrupt" },
    });
    expect(replyTextOf(interrupted)).toBe("Half an answer");
    // An outcome of no kind it knows, or none, leaves a completed reply as it is.
    expect(replyTextOf(replyEntry("assistant-1", "Kept.", { outcome: null }))).toBe("Kept.");
  });

  test("passes over a reply that is not completed", () => {
    for (const generationStatus of ["in_progress", "failed", ""]) {
      const entry = replyEntry("assistant-1", PRIVATE_WORDS, { generationStatus });
      expect(replyTextOf(entry), generationStatus).toBeNull();
    }
  });

  test("keeps only an entry's id and its reply's text", () => {
    expect(entryOf(replyEntry("assistant-1", "Done."))).toEqual({
      id: "assistant-1",
      reply: "Done.",
    });
    expect(entryOf(effectEntry("effect-1"))).toEqual({ id: "effect-1", reply: null });
    expect(entryOf({ type: "message" })).toEqual({ id: null, reply: null });
  });
});

describe("the newest reply in a session's history", () => {
  test("is the newest reply that stands, past the thinking, tools and notices after it", () => {
    expect(
      replyAmong(
        userEntry("user-1"),
        replyEntry("assistant-1", "An older reply."),
        userEntry("user-2"),
        reasoningEntry("reasoning-2-0"),
        replyEntry("assistant-2", "The newest reply."),
        effectEntry("effect-2"),
        callbackEntry("user-input-call-2"),
        noticeEntry("notice-2"),
      ),
    ).toBe("The newest reply.");
    expect(
      replyAmong(
        replyEntry("assistant-1", "The reply that stands."),
        replyEntry("assistant-2", PRIVATE_WORDS, {
          outcome: { type: "discarded", cause: "retry" },
        }),
        replyEntry("assistant-3", [imageBlock()]),
      ),
    ).toBe("The reply that stands.");
  });

  test("follows replace_entry: new text, a reply turned into a draft Vibe discarded, and an id it does not know", () => {
    const first = historyDelta(5, [
      appendStep(replyEntry("assistant-1", "First.")),
      appendStep(replyEntry("assistant-2", "Second.")),
    ]);
    expect(
      foundIn([
        first,
        historyDelta(6, [replaceStep("assistant-2", replyEntry("assistant-2", "Second, again."))]),
      ]).text,
    ).toBe("Second, again.");
    const discarded = replyEntry("assistant-2", PRIVATE_WORDS, {
      outcome: { type: "discarded", cause: "failure" },
    });
    expect(foundIn([first, historyDelta(6, [replaceStep("assistant-2", discarded)])]).text).toBe(
      "First.",
    );
    // An older entry's id: what is known stays as it was.
    expect(
      foundIn(
        [
          first,
          historyDelta(6, [replaceStep("assistant-0", replyEntry("assistant-0", PRIVATE_WORDS))]),
        ],
        UNKNOWN,
      ),
    ).toEqual({ text: "Second.", before: true });
  });

  test("follows remove_entry, and an id it does not know takes out nothing", () => {
    const lines = [
      historyDelta(5, [
        appendStep(replyEntry("assistant-1", "First.")),
        appendStep(replyEntry("assistant-2", "Second.")),
      ]),
    ];
    expect(foundIn([...lines, historyDelta(6, [removeStep("assistant-2")])]).text).toBe("First.");
    expect(foundIn([...lines, historyDelta(6, [removeStep("assistant-9")])]).text).toBe("Second.");
    expect(
      foundIn([...lines, historyDelta(6, [removeStep("assistant-2"), removeStep("assistant-1")])]),
    ).toEqual({ text: null, before: false });
  });

  test("takes set_history_entries as the whole history, whatever came before", () => {
    const lines = [
      historyDelta(5, [appendStep(replyEntry("assistant-1", PRIVATE_WORDS))]),
      historyDelta(6, [setEntriesStep([userEntry("user-1"), replyEntry("assistant-2", "Kept.")])]),
    ];
    expect(foundIn(lines, UNKNOWN)).toEqual({ text: "Kept.", before: false });
    expect(foundIn([...lines.slice(0, 1), historyDelta(6, [setEntriesStep([])])], UNKNOWN)).toEqual(
      { text: null, before: false },
    );
  });

  test("follows a rewrite of the history's end, its removes then its appends, in the new order", () => {
    const lines = [
      historyDelta(5, [
        appendStep(replyEntry("assistant-1", "Kept first.")),
        appendStep(replyEntry("assistant-2", PRIVATE_WORDS)),
        appendStep(effectEntry("effect-2")),
      ]),
      historyDelta(6, [
        removeStep("assistant-2"),
        removeStep("effect-2"),
        appendStep(replyEntry("assistant-3", "Inserted.")),
        appendStep(effectEntry("effect-2")),
      ]),
    ];
    const window = replay(EMPTY, historySteps(lines.join(""), true));
    expect(window.entries.map((entry) => entry.id)).toEqual([
      "assistant-1",
      "assistant-3",
      "effect-2",
    ]);
    expect(newestReply(window).text).toBe("Inserted.");
  });

  test("reads a reply on a line of Vibe 3.1's, and nothing of its Session API facts", () => {
    // What a tool was given, in words found nowhere else on the line.
    const toolArguments = "list the files in demo-project";
    const facts = sessionApiFacts({
      command: toolArguments,
      reply: replyEntry("assistant-9", toolArguments),
    });
    const line = historyDelta(5, [appendStep(replyEntry("assistant-1", "Done."))], {
      sessionApi: facts,
      state: { id: A, status: "idle" },
    });
    const parse = vi.spyOn(JSON, "parse");
    onTestFinished(() => parse.mockRestore());
    const found = foundIn([line]);
    expect(found).toEqual({ text: "Done.", before: false });
    expect(said(found)).not.toContain(PRIVATE_WORDS);
    expect(said(found)).not.toContain(toolArguments);
    // Only the delta is parsed: not the header, and not session_api, which can hold a tool's arguments.
    const parsed = parse.mock.calls.map(([text]) => text);
    expect(parsed).toEqual([line.slice(line.indexOf("["), line.indexOf(',"session_api"'))]);
    for (const text of parsed) {
      expect(text).not.toContain(toolArguments);
      expect(text).not.toContain("record_sha256");
    }
  });

  test("parses a session_relocated record whole, which holds no Session API facts, and keeps only its steps", () => {
    const line = relocatedRecord(6, [appendStep(replyEntry("assistant-1", "Moved."))]);
    const parse = vi.spyOn(JSON, "parse");
    onTestFinished(() => parse.mockRestore());
    expect(foundIn([line])).toEqual({ text: "Moved.", before: false });
    expect(parse.mock.calls.map(([text]) => text)).toEqual([line.slice(0, -1)]);
  });

  test("never takes a reply from a record that does not change the history, nor one quoted in a prompt", () => {
    const steps = { delta: [appendStep(replyEntry("assistant-9", PRIVATE_WORDS))], watermark: 1 };
    const lines = [
      historyDelta(5, [appendStep(replyEntry("assistant-1", "The real one."))]),
      callbackRegistered(6, { id: "approval-call-1", createdAt: 0 }),
      record("callback_registered", 7, steps),
      record("callback_resolved", 8, steps),
      record("core_input", 9, steps),
      record("action_result", 10, steps),
      otherRecord("action_intent", 11),
      historyDelta(12, [
        appendStep(userEntry("user-2", JSON.stringify(replyEntry("assistant-8", PRIVATE_WORDS)))),
      ]),
    ];
    const found = foundIn(lines);
    expect(found).toEqual({ text: "The real one.", before: false });
    expect(said(found)).not.toContain(PRIVATE_WORDS);
  });

  test("leaves a last line Vibe is still writing for the next read", () => {
    const whole = historyDelta(5, [appendStep(replyEntry("assistant-1", "Whole."))]);
    const writing = historyDelta(6, [appendStep(replyEntry("assistant-2", PRIVATE_WORDS))]).slice(
      0,
      -1,
    );
    expect(foundIn([whole, writing]).text).toBe("Whole.");
  });

  test("skips the first line of an end that does not reach the segment's start, and says what is older is not known", () => {
    const cut = historyDelta(5, [appendStep(replyEntry("assistant-1", PRIVATE_WORDS))]).slice(40);
    const whole = historyDelta(6, [appendStep(replyEntry("assistant-2", "Whole line."))]);
    expect(foundIn([cut, whole], UNKNOWN, false)).toEqual({ text: "Whole line.", before: true });
    expect(foundIn([cut], UNKNOWN, false)).toEqual({ text: null, before: true });
    expect(
      foundIn([cut, historyDelta(6, [appendStep(userEntry("user-2"))])], UNKNOWN, false),
    ).toEqual({ text: null, before: true });
    // An end that starts where a line does is not known to, so its first line is not read either.
    const first = historyDelta(5, [appendStep(replyEntry("assistant-1", PRIVATE_WORDS))]);
    expect(foundIn([first], UNKNOWN, false)).toEqual({ text: null, before: true });
    expect(foundIn([first], UNKNOWN, true)).toEqual({ text: PRIVATE_WORDS, before: true });
  });

  test("forgets what it knew at a whole state, a step or a record it does not know, or a line that does not parse", () => {
    const known = historyDelta(5, [appendStep(replyEntry("assistant-1", PRIVATE_WORDS))]);
    for (const [name, line] of [
      [
        "projection_advanced",
        record("projection_advanced", 6, { snapshot: publicState({ id: A }), watermark: 6 }),
      ],
      ["an unknown step", historyDelta(6, [{ op: "move_entry", id: "assistant-1" }])],
      ["an unknown record", record("history_compacted", 6, { delta: [] })],
      ["a line that does not parse", '{"payload":{"delta":[,"type":"projection_delta"}\n'],
      ["a delta that is no list", record("projection_delta", 6, { delta: {}, watermark: 6 })],
      [
        "a payload it does not know",
        record("projection_delta", 6, { delta: [], later: 1, watermark: 6 }),
      ],
    ] as const) {
      expect(foundIn([known, line]), name).toEqual({ text: null, before: true });
      // What comes after is still the end of the history.
      const after = historyDelta(7, [appendStep(replyEntry("assistant-2", "After."))]);
      expect(foundIn([known, line, after]), name).toEqual({ text: "After.", before: true });
    }
  });

  test("follows the steps of a session_relocated record", () => {
    const lines = [
      historyDelta(5, [appendStep(replyEntry("assistant-1", "Before the move."))]),
      relocatedRecord(6, [appendStep(checkpointEntry("checkpoint-move-1"))]),
    ];
    expect(foundIn(lines).text).toBe("Before the move.");
    expect(foundIn([...lines, relocatedRecord(7, [removeStep("assistant-1")])])).toEqual({
      text: null,
      before: false,
    });
  });

  test("leaves the history it starts from as it was", () => {
    const base: HistoryWindow = { entries: [{ id: "assistant-1", reply: "Old." }], before: false };
    replay(base, historySteps(historyDelta(5, [removeStep("assistant-1")]), true));
    expect(base.entries).toEqual([{ id: "assistant-1", reply: "Old." }]);
  });
});
