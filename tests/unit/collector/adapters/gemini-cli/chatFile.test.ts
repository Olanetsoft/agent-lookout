import { describe, expect, test } from "vitest";

import {
  contentShapeOf,
  createChatFileReader,
  LINE_LIMIT_BYTES,
  readHeaderLine,
  readLine,
  readLongLine,
} from "@collector/adapters/gemini-cli/chatFile";
import {
  at,
  chatFile,
  chatPath,
  contextLine,
  ENVIRONMENT_CONTEXT_ID,
  geminiLine,
  headerLine,
  ids,
  messageIdOf,
  MINUTE,
  noticeLine,
  NOW,
  patchLine,
  PRIVATE_WORDS,
  rewindLine,
  setLine,
  titleLine,
  toolCall,
  toolResultLine,
  updatedLine,
  userLine,
  workingSession,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { memoryFiles } from "@tests/support/adapters/geminiCliAdapter";

const FILE = chatPath("session-2026-10-01T11-50-00000000.jsonl");

/** An info message of about a kibibyte, to make a file long. */
const filler = (index: number) =>
  JSON.stringify({
    id: `info-${index}`,
    timestamp: at(NOW - 4 * MINUTE),
    type: "info",
    content: "A placeholder notice.".padEnd(1_000, "."),
  });
const otherIds = () => {
  let next = 0;
  return () => `other-${(next += 1)}`;
};

/** Reads the file as a poll would: a `lstat`, then the reader. */
async function readIt(
  files: ReturnType<typeof memoryFiles>,
  reader = createChatFileReader(files.io),
) {
  return reader.read(FILE, await files.io.lstat(FILE));
}

describe("the header", () => {
  test("is read from the first line, and only its named fields are kept", async () => {
    const files = memoryFiles();
    files.write(FILE, workingSession());
    const state = await readIt(files);
    expect(state.header).toEqual({
      sessionId: ids.working,
      kind: "main",
      startedAt: NOW - 10 * MINUTE,
      updatedAt: NOW - 10 * MINUTE,
    });
    expect(state.status).toEqual({ status: "working", since: NOW - MINUTE });
  });

  test("of an imported session, which holds its first prompt, keeps none of that prompt", () => {
    const line = headerLine({
      summary: "A placeholder title",
      firstUserMessage: `A placeholder first prompt. ${PRIVATE_WORDS}`,
      memoryScratchpad: { version: 1, workflowSummary: PRIVATE_WORDS },
      messageCount: 4,
      directories: [`/Users/example/${PRIVATE_WORDS}`],
    });
    const header = readHeaderLine(line);
    expect(header?.summary).toBe("A placeholder title");
    expect(JSON.stringify(header)).not.toContain(PRIVATE_WORDS);
  });

  test("is read when its line is longer than the first piece of the file looked at", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      chatFile([
        headerLine({ firstUserMessage: `${PRIVATE_WORDS} ${"x".repeat(200_000)}` }),
        userLine(messageIdOf("01"), NOW - MINUTE),
      ]),
    );
    const state = await readIt(files);
    expect(state.header?.sessionId).toBe(ids.working);
    expect(JSON.stringify(state)).not.toContain(PRIVATE_WORDS);
  });

  test.each([
    ["an empty file", ""],
    ["a first line that is a message", chatFile([userLine(messageIdOf("01"), NOW)])],
    ["a first line that does not parse", "{not json\n"],
    ["a session id Gemini CLI never gives", chatFile([headerLine({ sessionId: "../escape" })])],
    [
      "a header with no projectHash",
      chatFile([JSON.stringify({ sessionId: ids.working, startTime: at(NOW) })]),
    ],
    ["a first line not yet ended", headerLine()],
  ])("is not there in %s, and the file is not listed", async (_name, content) => {
    const files = memoryFiles();
    files.write(FILE, content);
    expect((await readIt(files)).header).toBeNull();
  });
});

describe("reading the lines", () => {
  test("only what was added since is read on later reads", async () => {
    const files = memoryFiles();
    files.write(FILE, workingSession());
    const reader = createChatFileReader(files.io);
    await readIt(files, reader);
    const size = (await files.io.lstat(FILE)).size;

    files.forget();
    files.append(FILE, chatFile([geminiLine(messageIdOf("02"), NOW), updatedLine(NOW)]));
    const state = await readIt(files, reader);
    expect(state.status).toEqual({ status: "idle", since: NOW });
    // One byte before the new lines, to see that they follow a line's end, and the new lines.
    expect(files.reads.map((read) => read.position)).toEqual([size - 1, size]);

    // Nothing changed, so nothing is opened.
    files.forget();
    await readIt(files, reader);
    expect(files.opened()).toEqual([]);
  });

  test("a line still being written is left until its end is there", async () => {
    const files = memoryFiles();
    files.write(FILE, workingSession());
    const reader = createChatFileReader(files.io);
    await readIt(files, reader);

    const reply = geminiLine(messageIdOf("02"), NOW);
    files.append(FILE, reply.slice(0, 40));
    expect((await readIt(files, reader)).status.status).toBe("working");
    files.append(FILE, `${reply.slice(40)}\n`);
    expect((await readIt(files, reader)).status).toEqual({ status: "idle", since: NOW });
  });

  test("a file replaced, or one that shrank, is read again from the start", async () => {
    const files = memoryFiles();
    files.write(FILE, workingSession());
    const reader = createChatFileReader(files.io);
    await readIt(files, reader);

    // A new file under the same name, as Gemini CLI's rewrite makes, longer and
    // with its lines ending where the old one's did: only its identity says it is new.
    files.forget();
    files.write(
      FILE,
      workingSession(ids.idle) + chatFile([geminiLine(messageIdOf("02"), NOW - 30_000)]),
    );
    const replaced = await readIt(files, reader);
    expect(replaced.header?.sessionId).toBe(ids.idle);
    expect(replaced.status).toEqual({ status: "idle", since: NOW - 30_000 });
    expect(files.reads.some((read) => read.position === 0)).toBe(true);

    // The same file, shorter.
    files.rewrite(FILE, chatFile([headerLine()]));
    expect((await readIt(files, reader)).status).toEqual({
      status: "idle",
      since: NOW - 10 * MINUTE,
    });
  });

  test("a file rewritten in place with more in it is read again from the start", async () => {
    const files = memoryFiles();
    const first = chatFile([headerLine(), userLine(messageIdOf("01"), NOW - MINUTE)]);
    files.write(FILE, first);
    const reader = createChatFileReader(files.io);
    await readIt(files, reader);
    // Where the last read ended is now inside the first line: the offset means nothing.
    files.rewrite(
      FILE,
      chatFile([
        headerLine({ sessionId: ids.idle, summary: "A placeholder title".padEnd(first.length) }),
        geminiLine("g1", NOW),
      ]),
    );
    const state = await readIt(files, reader);
    expect(state.header?.sessionId).toBe(ids.idle);
    expect(state.status).toEqual({ status: "idle", since: NOW });
  });

  test("lines that do not parse are passed over and counted, as Gemini CLI passes them over", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      chatFile([headerLine(), "{broken", userLine(messageIdOf("01"), NOW - MINUTE), "", "nope"]),
    );
    const state = await readIt(files);
    expect(state.skipped).toBe(2);
    expect(state.status).toEqual({ status: "working", since: NOW - MINUTE });
  });

  test("a line of a kind Gemini CLI 0.64.0 does not write makes the status unknown", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      chatFile([headerLine(), userLine(messageIdOf("01"), NOW - MINUTE), '{"$future":{}}']),
    );
    expect((await readIt(files)).status).toEqual({ status: "unknown", since: null });
  });

  test("the first read takes the end of a long file, and the line it begins inside is dropped", async () => {
    const files = memoryFiles();
    // A reply longer than the rest, so the end read begins inside it.
    const longReply = geminiLine(messageIdOf("90"), NOW - 5 * MINUTE, {
      content: `${PRIVATE_WORDS} ${"y".repeat(2 * 1024 * 1024)}`,
    });
    const notices = Array.from({ length: 7 * 1024 }, (_, index) => filler(index));
    files.write(
      FILE,
      chatFile([
        headerLine({ summary: "A placeholder title" }),
        longReply,
        ...notices,
        userLine(messageIdOf("01"), NOW - MINUTE),
      ]),
    );
    const size = (await files.io.lstat(FILE)).size;
    expect(size).toBeGreaterThan(LINE_LIMIT_BYTES);
    const state = await readIt(files);
    expect(state.header?.sessionId).toBe(ids.working);
    // The title comes from the header, read from the head.
    expect(state.summary).toBe("A placeholder title");
    expect(state.skipped).toBe(0);
    expect(state.status).toEqual({ status: "working", since: NOW - MINUTE });
    // Nothing between the head and the end was read.
    const positions = files.reads.map((read) => read.position);
    expect(
      positions.every((position) => position === 0 || position >= size - LINE_LIMIT_BYTES - 1),
    ).toBe(true);
  });

  test("a file read from part way through, whose end holds only notices, is unknown", async () => {
    const files = memoryFiles();
    const notices = Array.from({ length: 9 * 1024 }, (_, index) => filler(index));
    files.write(
      FILE,
      chatFile([headerLine(), userLine(messageIdOf("01"), NOW - 5 * MINUTE), ...notices]),
    );
    expect((await readIt(files)).status).toEqual({ status: "unknown", since: null });
  });
});

describe("a line longer than the limit", () => {
  const huge = "z".repeat(LINE_LIMIT_BYTES);

  test("a reply is told apart from its first bytes, and makes the status unknown", async () => {
    const files = memoryFiles();
    files.write(FILE, workingSession());
    const reader = createChatFileReader(files.io);
    await readIt(files, reader);
    files.append(FILE, `${geminiLine(messageIdOf("02"), NOW, { content: huge })}\n`);
    expect((await readIt(files, reader)).status).toEqual({ status: "unknown", since: null });
  });

  test("a user message written by the recorder is working, with no time it began", async () => {
    const files = memoryFiles();
    files.write(FILE, chatFile([headerLine(), geminiLine(messageIdOf("00"), NOW - 2 * MINUTE)]));
    const reader = createChatFileReader(files.io);
    await readIt(files, reader);
    files.append(FILE, `${userLine(messageIdOf("01"), NOW - MINUTE, huge)}\n`);
    expect((await readIt(files, reader)).status).toEqual({ status: "working", since: null });
  });

  test("one with its keys in another order, as an import writes, is unknown", () => {
    const line = JSON.stringify({ id: "m1", type: "user", content: huge, timestamp: at(NOW) });
    const record = readLongLine(line.slice(0, 512), otherIds());
    expect(record).toEqual({
      kind: "message",
      message: { id: "other-1", type: "other", at: null, content: null, toolCalls: null },
    });
    expect(readLongLine('{"$set":{"messages":[{"id":"m1"', otherIds())).toEqual({
      kind: "set",
      reattach: false,
      messages: [{ id: "other-1", type: "other", at: null, content: null, toolCalls: null }],
    });
  });
});

describe("what is kept of each line", () => {
  const lines = [
    headerLine({ firstUserMessage: PRIVATE_WORDS, summary: "A placeholder title" }),
    contextLine(NOW),
    userLine(messageIdOf("01"), NOW),
    geminiLine(messageIdOf("02"), NOW, {
      toolCalls: [toolCall("success", NOW), toolCall("error", NOW, "call-0002")],
    }),
    toolResultLine(messageIdOf("03"), NOW),
    noticeLine("info", messageIdOf("04"), NOW),
    noticeLine("warning", messageIdOf("05"), NOW),
    noticeLine("error", messageIdOf("06"), NOW),
    titleLine("A placeholder title"),
    setLine({ messages: [JSON.parse(userLine(messageIdOf("07"), NOW))] }),
    patchLine({
      id: messageIdOf("02"),
      content: [{ text: PRIVATE_WORDS }],
      toolCalls: [{ id: "call-0001", result: [{ text: PRIVATE_WORDS }] }],
      updates: [{ id: messageIdOf("01"), content: [{ text: PRIVATE_WORDS }] }],
      removeIds: [messageIdOf("04")],
      orderIds: [messageIdOf("01")],
    }),
    rewindLine(messageIdOf("02")),
  ];

  test("is never any text of a prompt, reply, thought, tool or scratchpad", () => {
    for (const line of lines) {
      expect(JSON.stringify(readLine(line, otherIds())), line.slice(0, 60)).not.toContain(
        PRIVATE_WORDS,
      );
    }
  });

  test("a reply keeps whether every call was cancelled and when the newest ended", () => {
    const record = readLine(
      geminiLine("g1", NOW, {
        content: "",
        toolCalls: [toolCall("cancelled", NOW - 1_000), toolCall("cancelled", NOW, "call-0002")],
      }),
      otherIds(),
    );
    expect(record).toEqual({
      kind: "message",
      message: {
        id: "g1",
        type: "gemini",
        at: NOW,
        content: {
          empty: true,
          functionCall: false,
          functionResponse: false,
          thoughtOnly: false,
          note: false,
        },
        toolCalls: { allCancelled: true, lastAt: NOW },
      },
    });
  });

  test("a $patch keeps its own change first, then its updates, removals and order", () => {
    expect(readLine(lines[10] as string, otherIds())).toEqual({
      kind: "patch",
      updates: [
        { id: messageIdOf("02"), content: expect.objectContaining({ note: false }) },
        { id: messageIdOf("01"), content: expect.objectContaining({ note: false }) },
      ],
      removeIds: [messageIdOf("04")],
      orderIds: [messageIdOf("01")],
    });
  });

  test("a $set keeps its time, its title and whether it takes the session up again", () => {
    expect(readLine(setLine({ sessionId: ids.working }), otherIds())).toEqual({
      kind: "set",
      reattach: true,
    });
    expect(readLine(updatedLine(NOW), otherIds())).toEqual({
      kind: "set",
      reattach: false,
      updatedAt: NOW,
    });
    expect(readLine(titleLine("A placeholder title"), otherIds())).toEqual({
      kind: "set",
      reattach: false,
      summary: "A placeholder title",
    });
  });
});

describe("the shape of a message's content", () => {
  test.each<[string, unknown, Partial<ReturnType<typeof contentShapeOf>>]>([
    ["a reply that was only calls for tools", "", { empty: true }],
    ["a reply with text", "Done.", {}],
    ["a call for a tool", [{ functionCall: { name: "x", args: {} } }], { functionCall: true }],
    ["a tool's result", [{ functionResponse: { name: "x" } }], { functionResponse: true }],
    [
      "Gemini CLI's note about a file a tool sent back",
      [{ text: "Binary content received.", thought: true }],
      { thoughtOnly: true },
    ],
    ["the session's context", [{ text: "  <session_context>\n…" }], { note: true }],
    ["a hook's context", "<hook_context>…</hook_context>", { note: true }],
    [
      "a shell command's output",
      [{ text: "I ran the following shell command:\n```sh\nls\n```" }],
      { note: true },
    ],
    ["folders added", [{ text: "- **Workspace Directories:**\n  - /x" }], { note: true }],
    [
      "leaving Plan Mode by hand",
      [{ text: "User has manually exited Plan Mode. Switching to Default." }],
      { note: true },
    ],
    ["a prompt that mentions a context tag later", "Explain <session_context>", {}],
  ])("%s", (_name, content, shape) => {
    expect(contentShapeOf(content)).toEqual({
      empty: false,
      functionCall: false,
      functionResponse: false,
      thoughtOnly: false,
      note: false,
      ...shape,
    });
  });

  test("the context message is known by its id too", () => {
    expect(readLine(contextLine(NOW), otherIds())).toMatchObject({
      message: { id: ENVIRONMENT_CONTEXT_ID, type: "user" },
    });
  });
});
