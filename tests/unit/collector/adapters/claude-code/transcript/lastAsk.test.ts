import { describe, expect, test } from "vitest";

import {
  askedInTail,
  describeToolUse,
  shortPath,
} from "@collector/adapters/claude-code/transcript/lastAsk";
import {
  otherLines,
  prompt,
  said,
  toolResult,
  toolUse,
  toolUseId,
  transcript,
  waitingToRun,
  type TranscriptLine,
} from "@tests/fixtures/claudeTranscript";

const CWD = "/Users/example/code/demo";

/** What a whole transcript of these lines says the session is asking. */
function asked(lines: readonly TranscriptLine[], cwd: string | null = CWD) {
  return askedInTail(transcript(lines), true, cwd);
}

/** What a session waiting on this one tool, after a prompt, is asking. */
function waitingOn(name: string, input: Record<string, unknown>, cwd: string | null = CWD) {
  return asked([prompt("Go on"), ...otherLines, toolUse(toolUseId(), name, input)], cwd);
}

describe("a session waiting for permission", () => {
  test("to run a command says Run and the command's first line", () => {
    expect(askedInTail(waitingToRun("npm test"), true, CWD)).toBe("Run: npm test");
    expect(waitingOn("Bash", { command: "\n  npm run build\nnpm test\n" })).toBe(
      "Run: npm run build",
    );
    expect(waitingOn("PowerShell", { command: "Get-ChildItem" })).toBe("Run: Get-ChildItem");
  });

  test("to change or read a file says what, and the file, inside its folder relative to it", () => {
    expect(waitingOn("Edit", { file_path: `${CWD}/src/app.ts`, old_string: "a" })).toBe(
      "Edit: src/app.ts",
    );
    expect(waitingOn("MultiEdit", { file_path: `${CWD}/src/app.ts`, edits: [] })).toBe(
      "Edit: src/app.ts",
    );
    expect(waitingOn("NotebookEdit", { notebook_path: `${CWD}/notes/plot.ipynb` })).toBe(
      "Edit: notes/plot.ipynb",
    );
    expect(waitingOn("Write", { file_path: `${CWD}/README.md`, content: "# Demo" })).toBe(
      "Write: README.md",
    );
    // Outside the folder, the whole path.
    expect(waitingOn("Read", { file_path: "/Users/example/.config/demo.toml" })).toBe(
      "Read: /Users/example/.config/demo.toml",
    );
    // With no folder known, the whole path too.
    expect(waitingOn("Write", { file_path: `${CWD}/README.md` }, null)).toBe(
      `Write: ${CWD}/README.md`,
    );
  });

  test("to fetch a page or search the web says which", () => {
    expect(waitingOn("WebFetch", { url: "https://example.com/docs", prompt: "Read" })).toBe(
      "Fetch: https://example.com/docs",
    );
    expect(waitingOn("WebSearch", { query: "vitest browser mode" })).toBe(
      "Search: vitest browser mode",
    );
  });

  test("on a plan asks for it to be approved", () => {
    expect(waitingOn("ExitPlanMode", { plan: "1. Do the thing" })).toBe("Approve the plan");
  });

  test("to use any other tool, an MCP server's included, names the tool", () => {
    expect(waitingOn("mcp__tracker__create_issue", { title: "Broken" })).toBe(
      "Use: mcp__tracker__create_issue",
    );
    expect(waitingOn("SomeNewTool", {})).toBe("Use: SomeNewTool");
  });

  test("a known tool without the input it takes says nothing, and invents nothing", () => {
    expect(waitingOn("Bash", {})).toBeUndefined();
    expect(waitingOn("Bash", { command: "   \n  " })).toBeUndefined();
    expect(waitingOn("Edit", { file_path: 42 })).toBeUndefined();
    expect(waitingOn("WebFetch", { url: "" })).toBeUndefined();
    expect(waitingOn("AskUserQuestion", { questions: [] })).toBeUndefined();
    expect(waitingOn("AskUserQuestion", { questions: [{ header: "Pick" }] })).toBeUndefined();
  });
});

describe("a session waiting on a question", () => {
  const question = (text: string) => ({
    question: text,
    header: "Choice",
    options: [{ label: "One", description: "The first" }],
    multiSelect: false,
  });

  test("gives the question", () => {
    expect(
      waitingOn("AskUserQuestion", { questions: [question("Which database should we use?")] }),
    ).toBe("Which database should we use?");
  });

  test("with several questions, gives the first and how many more", () => {
    expect(
      waitingOn("AskUserQuestion", {
        questions: [
          question("Which database should we use?"),
          question("Should the tests run in CI?"),
          question("Which port?"),
        ],
      }),
    ).toBe("Which database should we use? (+2 more)");
  });
});

describe("what is read past", () => {
  test("a subagent's lines are not the session's own", () => {
    const own = toolUseId();
    const subagent = toolUseId();
    // The session waits on its own command; its subagent's later tool use is not it.
    expect(
      asked([
        toolUse(own, "Bash", { command: "npm test" }),
        toolUse(subagent, "Read", { file_path: `${CWD}/a.ts` }, { sidechain: true }),
      ]),
    ).toBe("Run: npm test");
    // A subagent's result does not answer the session's own tool use.
    expect(
      asked([toolUse(own, "Bash", { command: "npm test" }), toolResult(own, { sidechain: true })]),
    ).toBe("Run: npm test");
    // And a subagent waiting alone is not the session waiting.
    expect(
      asked([toolUse(subagent, "Bash", { command: "rm -rf build" }, { sidechain: true })]),
    ).toBeUndefined();
  });

  test("a tool use that has its result is not waited on", () => {
    const id = toolUseId();
    expect(
      asked([toolUse(id, "Bash", { command: "npm test" }), toolResult(id), ...otherLines]),
    ).toBeUndefined();
  });

  test("an older tool use with no result is not waited on once the conversation has gone on", () => {
    const old = toolUseId();
    expect(asked([toolUse(old, "Bash", { command: "npm test" }), prompt("Stop")])).toBeUndefined();
    expect(
      asked([toolUse(old, "Bash", { command: "npm test" }), said("Stopped.", { messageId: "m2" })]),
    ).toBeUndefined();
  });

  test("lines with no message id: any later reply is the conversation going on", () => {
    const old = toolUseId();
    const noId = { messageId: null };
    expect(
      asked([toolUse(old, "Bash", { command: "ls" }, noId), said("Done.", noId)]),
    ).toBeUndefined();
    // Either side without one is enough.
    expect(
      asked([toolUse(old, "Bash", { command: "ls" }, noId), said("Done.", { messageId: "m2" })]),
    ).toBeUndefined();
    expect(
      asked([toolUse(old, "Bash", { command: "ls" }, { messageId: "m1" }), said("Done.", noId)]),
    ).toBeUndefined();
    // With nothing after it, it is still waited on.
    expect(asked([toolUse(old, "Bash", { command: "ls" }, noId)])).toBe("Run: ls");
  });

  test("of several tools one message asks for, the one waited on is the first with no result", () => {
    const first = toolUseId();
    const second = toolUseId();
    const third = toolUseId();
    const message = { messageId: "msg_batch" };
    expect(
      asked([
        toolUse(first, "Read", { file_path: `${CWD}/a.ts` }, message),
        toolUse(second, "Bash", { command: "npm run lint" }, message),
        toolUse(third, "Bash", { command: "npm test" }, message),
        toolResult(first),
      ]),
    ).toBe("Run: npm run lint");
  });

  test("of several tools one message asks for, an earlier one waits though the last has its result", () => {
    const first = toolUseId();
    const second = toolUseId();
    const message = { messageId: "msg_pair" };
    const lines = [
      toolUse(first, "Bash", { command: "npm test" }, message),
      toolUse(second, "Read", { file_path: `${CWD}/b.ts` }, message),
      toolResult(second),
    ];
    expect(asked(lines)).toBe("Run: npm test");
    // Once every one has its result, none is waited on.
    expect(asked([...lines, toolResult(first)])).toBeUndefined();
  });

  test("a line that does not parse is skipped, and the next one is read", () => {
    const tail = [
      "not json at all",
      '{"type": "assistant", "message": ',
      "[1, 2, 3]",
      "null",
      JSON.stringify({ type: "assistant", message: "not an object" }),
      JSON.stringify({ type: "assistant", message: { content: "words" } }),
      JSON.stringify({ type: "assistant", message: { content: [null, 7, { type: "tool_use" }] } }),
      JSON.stringify(toolUse(toolUseId(), "Bash", { command: "npm test" })),
      "",
    ].join("\n");
    expect(askedInTail(tail, true, CWD)).toBe("Run: npm test");
  });

  test("an empty transcript, and one with no tool use, say nothing", () => {
    expect(askedInTail("", true, CWD)).toBeUndefined();
    expect(askedInTail("\n\n", false, CWD)).toBeUndefined();
    expect(asked([prompt("Hello"), said("Hello. What shall we do?")])).toBeUndefined();
  });
});

describe("the tail of a long transcript", () => {
  test("its first line, cut short, is not read unless the tail is the whole file", () => {
    const line = JSON.stringify(toolUse(toolUseId(), "Bash", { command: "npm test" }));
    // A whole line at the very start of the file is read.
    expect(askedInTail(`${line}\n`, true, CWD)).toBe("Run: npm test");
    // The same line as the first of a tail could be the end of a longer one, so it is not.
    expect(askedInTail(`${line}\n`, false, CWD)).toBeUndefined();
    // The lines after it are read.
    const later = JSON.stringify(toolUse(toolUseId(), "Write", { file_path: `${CWD}/b.ts` }));
    expect(askedInTail(`${line.slice(40)}\n${later}\n`, false, CWD)).toBe("Write: b.ts");
  });

  test("a last line longer than the tail gives no text, not an older one", () => {
    const answered = toolUseId();
    const huge = toolUseId();
    const file = transcript([
      toolUse(answered, "Bash", { command: "npm test" }),
      toolResult(answered),
      toolUse(huge, "Write", { file_path: `${CWD}/big.txt`, content: "x".repeat(300_000) }),
    ]);
    // The tail holds part of the last line only.
    const tail = file.slice(file.length - 256 * 1024);
    expect(askedInTail(tail, false, CWD)).toBeUndefined();
  });
});

describe("the text", () => {
  test("is cleaned of control characters and of marks that reorder it, and made one line", () => {
    expect(waitingOn("Bash", { command: "echo \u001b[31mred\u0007 \u202eevil" })).toBe(
      "Run: echo [31mred evil",
    );
    expect(
      waitingOn("AskUserQuestion", { questions: [{ question: "Which\tone,\r\nthis?" }] }),
    ).toBe("Which one, this?");
  });

  test("is cut to 200 characters, with an ellipsis", () => {
    const text = waitingOn("Bash", { command: `echo ${"a".repeat(400)}` }) as string;
    expect(Array.from(text)).toHaveLength(200);
    expect(text.endsWith("…")).toBe(true);
    expect(text.startsWith("Run: echo aaa")).toBe(true);
  });
});

describe("describeToolUse", () => {
  test("takes the first question whatever else a question holds", () => {
    expect(describeToolUse("AskUserQuestion", { questions: [{ question: "Ready?" }] }, null)).toBe(
      "Ready?",
    );
  });

  test("names a tool it does not know by its name", () => {
    expect(describeToolUse("TodoWrite", { todos: [] }, CWD)).toBe("Use: TodoWrite");
  });

  test("says nothing for a tool that starts a subagent, which is not what is asked", () => {
    expect(describeToolUse("Task", { prompt: "Look into it" }, CWD)).toBeNull();
    expect(describeToolUse("Agent", { prompt: "Look into it" }, CWD)).toBeNull();
    // A subagent waiting on its own tool, under the session's Task, gives no text.
    const task = toolUseId();
    expect(
      asked([
        toolUse(task, "Task", { prompt: "Look into it" }),
        toolUse(toolUseId(), "Bash", { command: "rm -rf build" }, { sidechain: true }),
      ]),
    ).toBeUndefined();
  });
});

describe("shortPath", () => {
  test("a path inside the folder is relative to it, and any other is whole", () => {
    expect(shortPath(`${CWD}/src/app.ts`, CWD)).toBe("src/app.ts");
    expect(shortPath(`${CWD}/src/app.ts`, `${CWD}/`)).toBe("src/app.ts");
    expect(shortPath(`${CWD}-api/src/app.ts`, CWD)).toBe(`${CWD}-api/src/app.ts`);
    expect(shortPath(CWD, CWD)).toBe(CWD);
    expect(shortPath(`${CWD}/`, CWD)).toBe(`${CWD}/`);
    expect(shortPath("C:\\code\\demo\\src\\app.ts", "C:\\code\\demo")).toBe("src\\app.ts");
    expect(shortPath("/etc/hosts", null)).toBe("/etc/hosts");
    expect(shortPath("/etc/hosts", "/")).toBe("/etc/hosts");
  });
});
