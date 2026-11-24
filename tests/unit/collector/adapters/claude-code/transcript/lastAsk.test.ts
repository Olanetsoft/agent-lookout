import { describe, expect, test } from "vitest";

import {
  ASKED_WITHIN_MS,
  askedInTail,
  describeToolUse,
  shortPath,
} from "@collector/adapters/claude-code/transcript/lastAsk";
import {
  otherLines,
  prompt,
  said,
  startedInBackground,
  taskNotification,
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
    // Of two, only the newest can be.
    const newest = toolUse(toolUseId(), "Bash", { command: "npm test" }, noId);
    expect(asked([toolUse(old, "Bash", { command: "ls" }, noId), newest])).toBe("Run: npm test");
  });

  test("of several tools one message asks for, only one left with no result is known to be waited on", () => {
    const first = toolUseId();
    const second = toolUseId();
    const third = toolUseId();
    const message = { messageId: "msg_batch" };
    const lines = [
      toolUse(first, "Read", { file_path: `${CWD}/a.ts` }, message),
      toolUse(second, "Bash", { command: "npm run lint" }, message),
      toolUse(third, "Bash", { command: "npm test" }, message),
    ];
    // Any of them can be running, and any be asked about.
    expect(asked(lines)).toBeUndefined();
    expect(asked([...lines, toolResult(first)])).toBeUndefined();
    expect(asked([...lines, toolResult(third)])).toBeUndefined();
    expect(asked([...lines, toolResult(first), toolResult(second)])).toBe("Run: npm test");
    expect(asked([...lines, toolResult(third), toolResult(first)])).toBe("Run: npm run lint");
    // Once every one has its result, none is waited on.
    expect(
      asked([...lines, toolResult(first), toolResult(second), toolResult(third)]),
    ).toBeUndefined();
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

describe("when something else may be asking", () => {
  const SINCE = 1_700_000_050_000;
  /** What a wait since then is for, from a whole transcript or only its end. */
  const waitingSince = (lines: readonly TranscriptLine[], whole = true) =>
    askedInTail(`${whole ? "" : "cut short\n"}${transcript(lines)}`, whole, CWD, {
      statusSince: SINCE,
      waitingReason: "permission",
    });
  const running = toolUse(toolUseId(), "Bash", { command: "npm test" });

  /** A session that started an agent, whose result says this, and then runs a command. */
  function afterAgent(result: unknown, name = "Agent", error = false) {
    const launch = toolUseId();
    const lines = [
      prompt("Look into it"),
      toolUse(launch, name, { description: "Look into it" }),
      toolResult(launch, { result, error }),
    ];
    return { launch, lines: [...lines, running] };
  }

  test("a background agent that may still run gives no text, whatever runs in the session", () => {
    expect(asked(afterAgent(startedInBackground("a0001")).lines)).toBeUndefined();
    expect(asked(afterAgent({ status: "async_launched" }, "Task").lines)).toBeUndefined();
    expect(asked(afterAgent({ status: "teammate_spawned" }).lines)).toBeUndefined();
    // Whatever tool started it, and however its result is written.
    expect(asked(afterAgent({ status: "async_launched" }, "Workflow").lines)).toBeUndefined();
    expect(asked(afterAgent({ isAsync: true }, "Workflow").lines)).toBeUndefined();
    expect(asked(afterAgent(undefined).lines)).toBeUndefined();
    // A launch whose own line is before the tail.
    expect(asked(afterAgent(startedInBackground("a0001")).lines.slice(2))).toBeUndefined();
  });

  test("an agent that has finished, or was refused, is not asking", () => {
    expect(asked(afterAgent({ status: "completed", agentId: "a0001" }).lines)).toBe(
      "Run: npm test",
    );
    expect(asked(afterAgent("The person refused it", "Agent", true).lines)).toBe("Run: npm test");
    // Nor is a command left running, which cannot ask.
    expect(asked(afterAgent({ backgroundTaskId: "b0001" }, "Bash").lines)).toBe("Run: npm test");
  });

  test("a background agent is over once Claude Code says it has ended, and not before", () => {
    const { launch, lines } = afterAgent(startedInBackground("a0001"));
    const then = (...more: TranscriptLine[]) => asked([...lines.slice(0, -1), ...more, running]);
    const told = (...fields: Record<string, string>[]) => then(...fields.map(taskNotification));
    for (const status of ["completed", "failed", "killed", "stopped"]) {
      expect(told({ "task-id": "a0001", status }), status).toBe("Run: npm test");
      expect(told({ "tool-use-id": launch, status }), status).toBe("Run: npm test");
    }
    expect(told({ "task-id": "a0002", status: "completed" })).toBeUndefined();
    expect(told({ "task-id": "a0001" })).toBeUndefined();
    expect(told({ "task-id": "a0001", status: "running" })).toBeUndefined();
    // What sums it up can hold anything.
    const summary = "The checks: <status>failed</status>";
    expect(told({ "task-id": "a0001", summary })).toBeUndefined();
    expect(told({ "task-id": "a0001", status: "completed", summary })).toBe("Run: npm test");
    // Another whose id only begins like it.
    expect(told({ "task-id": "a00019", status: "completed" })).toBeUndefined();
    // A task of another kind names its own.
    const workflow = afterAgent({ status: "async_launched", taskId: "w0001" }, "Workflow").lines;
    const over = taskNotification({ "task-id": "w0001", status: "completed" });
    expect(asked([...workflow.slice(0, -1), over, running])).toBe("Run: npm test");
    // A reply that quotes such a line is not one, nor is what a tool read, nor any other line.
    const note = taskNotification({ "task-id": "a0001", status: "completed" });
    const quoted = note.content as string;
    expect(then(said(quoted))).toBeUndefined();
    const read = toolUseId();
    const printed = toolResult(read, { result: { stdout: quoted } });
    expect(then(toolUse(read, "Read", { file_path: "notes.md" }), printed)).toBeUndefined();
    expect(
      then({ ...note, content: quoted.replace(/<.?task-notification>/g, "") }),
    ).toBeUndefined();
  });

  test("a line that tells of two agents says of each whether it has ended", () => {
    const launches = [toolUseId(), toolUseId()] as const;
    const started = launches.flatMap((id, at) => [
      toolUse(id, "Agent", { description: "Look into it" }),
      toolResult(id, { result: startedInBackground(`a000${at + 1}`) }),
    ]);
    const note = (id: string, status: string) =>
      taskNotification({ "task-id": id, status }).content as string;
    const told = (...notes: string[]) =>
      asked([...started, { type: "queue-operation", content: notes.join("\n") }, running]);
    expect(told(note("a0001", "completed"), note("a0002", "running"))).toBeUndefined();
    expect(told(note("a0001", "running"), note("a0002", "completed"))).toBeUndefined();
    expect(told(note("a0001", "completed"), note("a0002", "failed"))).toBe("Run: npm test");
  });

  test("one that was stopped, or whose output says it has ended, is over too", () => {
    const { lines } = afterAgent(startedInBackground("a0001"));
    const told = (name: string, result: unknown, error = false) => {
      const id = toolUseId();
      const asking = [toolUse(id, name, { task_id: "a0001" }), toolResult(id, { result, error })];
      return asked([...lines.slice(0, -1), ...asking, running]);
    };
    const stopped = { message: "Stopped", task_id: "a0001", task_type: "local_agent" };
    expect(told("TaskStop", stopped)).toBe("Run: npm test");
    expect(told("TaskStop", { ...stopped, task_id: "a0002" })).toBeUndefined();
    expect(told("TaskStop", "No task is running with that ID", true)).toBeUndefined();
    expect(told("TaskStop", stopped, true)).toBeUndefined();
    expect(told("SomeNewTool", stopped)).toBeUndefined();
    const output = (status: string) => ({ task: { task_id: "a0001", status } });
    expect(told("TaskOutput", output("completed"))).toBe("Run: npm test");
    expect(told("TaskOutput", output("running"))).toBeUndefined();
    expect(told("TaskOutput", { retrieval_status: "timeout" })).toBeUndefined();
  });

  test("one that was sent a message runs again, until it has ended again", () => {
    const { lines } = afterAgent(startedInBackground("a0001"));
    const over = taskNotification({ "task-id": "a0001", status: "completed" });
    const sent = (result: unknown, error = false) => {
      const id = toolUseId();
      return [
        toolUse(id, "SendMessage", { to: "a0001", message: "Go on" }),
        toolResult(id, { result, error }),
      ];
    };
    const ended = [...lines.slice(0, -1), over];
    const again = sent({ success: true, message: "Resumed" });
    expect(asked([...ended, ...again, running])).toBeUndefined();
    expect(asked([...ended, ...again, over, running])).toBe("Run: npm test");
    // A finished agent that ran in the session itself goes on in the background.
    const finished = afterAgent({ status: "completed", agentId: "a0001" }).lines.slice(0, -1);
    expect(asked([...finished, ...again, running])).toBeUndefined();
    // A message that reached no agent set none going.
    expect(asked([...ended, ...sent({ success: false }), running])).toBe("Run: npm test");
    expect(asked([...ended, ...sent("No such agent", true), running])).toBe("Run: npm test");
  });

  test("the session's own question is known all the same, in a wait on a question", () => {
    const question = toolUse(
      toolUseId(),
      "AskUserQuestion",
      { questions: [{ question: "Which port?" }] },
      { messageId: "msg_both" },
    );
    const beside = toolUse(toolUseId(), "Bash", { command: "ls" }, { messageId: "msg_both" });
    const lines = [...afterAgent(startedInBackground("a0001")).lines.slice(0, 3), question, beside];
    const waitingOnIt = (waitingReason: "question" | "permission") =>
      askedInTail(transcript(lines), true, CWD, { statusSince: SINCE, waitingReason });
    expect(waitingOnIt("question")).toBe("Which port?");
    expect(waitingOnIt("permission")).toBeUndefined();
  });

  test("a tool use written long before the wait is not what is asked, when an agent may be asking", () => {
    const ran = (at: number) => [
      toolUse(toolUseId(), "Bash", { command: "npm test" }, { at: SINCE + at }),
    ];
    expect(ASKED_WITHIN_MS).toBe(15_000);
    // One started before the tail, one that has finished, or one that ended in the background.
    const finished = afterAgent({ status: "completed", agentId: "a0001" }).lines.slice(0, -1);
    const over = taskNotification({ "task-id": "a0001", status: "completed" });
    const ended = [...afterAgent(startedInBackground("a0001")).lines.slice(0, -1), over];
    for (const said of [
      (at: number) => waitingSince(ran(at), false),
      (at: number) => waitingSince([...finished, ...ran(at)]),
      (at: number) => waitingSince([...ended, ...ran(at)]),
    ]) {
      expect(said(-200)).toBe("Run: npm test");
      expect(said(-15_000)).toBe("Run: npm test");
      expect(said(-15_001)).toBeUndefined();
    }
    // With the whole transcript and no agent in it, nothing else can be.
    expect(waitingSince(ran(-60_000))).toBe("Run: npm test");
  });

  test("nor is one written after the wait began", () => {
    const ran = (at: number) => [
      toolUse(toolUseId(), "Bash", { command: "npm test" }, { at: SINCE + at }),
    ];
    // The file and the line are written a moment apart.
    expect(waitingSince(ran(1_000))).toBe("Run: npm test");
    expect(waitingSince(ran(1_001))).toBeUndefined();
    // Though the session took a step just before the wait.
    const before = toolUseId();
    const done = [
      toolUse(before, "Read", { file_path: `${CWD}/a.ts` }, { at: SINCE - 900 }),
      toolResult(before, { at: SINCE - 800 }),
    ];
    expect(waitingSince([...done, ...ran(5_000)])).toBeUndefined();
    // With no time on either side, nothing says it is not.
    expect(waitingSince([running])).toBe("Run: npm test");
    expect(asked(ran(-60_000))).toBe("Run: npm test");
  });

  test("a step the session took just before the wait says it is the session's own", () => {
    const first = toolUseId();
    const message = { messageId: "msg_pair", at: SINCE - 60_000 };
    const pair = [
      toolUse(first, "Bash", { command: "npm run build" }, message),
      toolUse(toolUseId(), "Bash", { command: "npm test" }, message),
    ];
    // The second is asked about once the first is done.
    const ended = (at: number) =>
      waitingSince([...pair, toolResult(first, { at: SINCE + at })], false);
    expect(ended(-100)).toBe("Run: npm test");
    // A result after the wait began says nothing of it.
    expect(ended(5_000)).toBeUndefined();
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
