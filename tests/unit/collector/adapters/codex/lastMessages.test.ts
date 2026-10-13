import { describe, expect, test } from "vitest";

import { createCodexLastMessages, lastSaidInRollout } from "@collector/adapters/codex/lastMessages";
import {
  ANSWER_AGAIN_MS,
  KEEP_MS,
  MAX_KEPT,
  READS_PER_SECOND,
} from "@collector/messages/tailReader";
import { MAX_MESSAGE_LENGTH } from "@core/text";
import {
  agentMessageLine,
  CODEX_HOME,
  itemLine,
  messageLine,
  metaLine,
  MINUTE,
  NOW,
  replyLine,
  rollout,
  rolloutPath,
  threadId,
  tokenCountLine,
  turnLine,
  usage,
} from "@tests/fixtures/codex";
import { handClock, memoryFiles } from "@tests/support/adapters/codexAdapter";

const T = NOW - 30 * MINUTE;
const at = (seconds: number) => T + seconds * 1_000;

/** A whole rollout, read from its start. */
const whole = (...lines: string[]) => lastSaidInRollout(rollout(...lines), true);

/** The lines of one finished turn, written as Codex 0.160.0 writes them. */
function turn(prompt: string, reply: string, start = 0): string[] {
  return [
    messageLine(at(start), prompt),
    turnLine(at(start), "task_started"),
    itemLine(at(start + 1), { type: "reasoning", summary: [], encrypted_content: "opaque" }),
    agentMessageLine(at(start + 2), reply),
    replyLine(at(start + 2), reply),
    tokenCountLine(at(start + 3), usage(52_480, 44_032, 1_206)),
    turnLine(at(start + 3), "task_complete", { last_agent_message: reply }),
  ];
}

describe("what a Codex session last said, from the end of its rollout", () => {
  test("is the newest reply's text alone: never the prompt, the reasoning, a tool's call or its output", () => {
    const said = whole(
      metaLine(T),
      messageLine(at(1), "Tidy the PRIVATE-PROMPT docs"),
      turnLine(at(1), "task_started"),
      itemLine(at(2), {
        type: "reasoning",
        summary: [{ type: "summary_text", text: "PRIVATE-REASONING" }],
      }),
      itemLine(at(3), {
        type: "function_call",
        name: "shell",
        arguments: '{"command":["PRIVATE-TOOL"]}',
        call_id: "call-0001",
      }),
      itemLine(at(4), {
        type: "function_call_output",
        call_id: "call-0001",
        output: "PRIVATE-OUTPUT",
      }),
      agentMessageLine(at(5), "I tidied the docs."),
      replyLine(at(5), "I tidied the docs."),
      tokenCountLine(at(6), usage(52_480, 44_032, 1_206)),
      turnLine(at(6), "task_complete", { last_agent_message: "I tidied the docs." }),
    );
    expect(said).toBe("I tidied the docs.");
  });

  test("takes the agent_message of the newest reply over its response_item, whichever was written first", () => {
    const event = agentMessageLine(at(5), "Plain words.");
    const item = replyLine(at(5), "Plain words, as the model wrote them.");
    expect(whole(metaLine(T), event, item)).toBe("Plain words.");
    expect(whole(metaLine(T), item, event)).toBe("Plain words.");
    // So with an older reply before it, whose two lines are in the same order.
    const older = [agentMessageLine(at(1), "An older reply."), replyLine(at(1), "An older reply.")];
    expect(whole(metaLine(T), ...older, event, item)).toBe("Plain words.");
    // And when the older reply's copies differ, as when Codex took markup out of its agent_message.
    const marked = [
      agentMessageLine(at(1), "An older reply."),
      replyLine(at(1), "An older reply.<cite>notes</cite>"),
    ];
    expect(whole(metaLine(T), ...marked, event, item)).toBe("Plain words.");
    expect(whole(metaLine(T), ...marked, item)).toBe("Plain words, as the model wrote them.");
  });

  test("is never an older reply's agent_message the same as its response_item when the newest reply's response_item was written first and its agent_message not yet", () => {
    const older = [replyLine(at(1), "An older reply."), agentMessageLine(at(1), "An older reply.")];
    const newest = replyLine(at(3), "The newest reply.");
    expect(whole(metaLine(T), ...older, newest)).toBe("The newest reply.");
    expect(whole(metaLine(T), ...older, tokenCountLine(at(2), usage(1_000, 0, 10)), newest)).toBe(
      "The newest reply.",
    );
    // Once its agent_message is written, that is taken.
    expect(whole(metaLine(T), ...older, newest, agentMessageLine(at(3), "The newest."))).toBe(
      "The newest.",
    );
  });

  test("joins the output_text parts of a response_item as Codex joins them when the tail has no agent_message, and takes nothing else of it", () => {
    const reply = JSON.stringify({
      timestamp: new Date(at(5)).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Part one, " },
          { type: "refusal", refusal: "PRIVATE-OTHER" },
          { type: "output_text", text: "part two." },
        ],
      },
    });
    expect(whole(metaLine(T), reply)).toBe("Part one, part two.");
    // A cut tail that starts inside the reply's agent_message takes its response_item.
    const cut = `${"x".repeat(64)}"}}\n${reply}\n`;
    expect(lastSaidInRollout(cut, false)).toBe("Part one, part two.");
  });

  test("is never an older reply's agent_message when the newest reply has only its response_item", () => {
    const said = whole(
      metaLine(T),
      ...turn("Start the work", "An older reply."),
      messageLine(at(10), "And the tests?"),
      turnLine(at(10), "task_started"),
      itemLine(at(11), {
        type: "function_call",
        name: "shell",
        arguments: "{}",
        call_id: "call-0002",
      }),
      itemLine(at(12), { type: "function_call_output", call_id: "call-0002", output: "ok" }),
      replyLine(at(13), "They pass."),
    );
    expect(said).toBe("They pass.");
  });

  test("is not hidden by a prompt typed after it, nor by the turn that prompt starts", () => {
    const said = whole(
      metaLine(T),
      ...turn("Start the work", "The work is done."),
      messageLine(at(20), "Now the next part"),
      JSON.stringify({
        timestamp: new Date(at(20)).toISOString(),
        type: "event_msg",
        payload: { type: "user_message", message: "Now the next part" },
      }),
      turnLine(at(20), "task_started"),
      itemLine(at(21), { type: "reasoning", summary: [] }),
    );
    expect(said).toBe("The work is done.");
  });

  test("takes task_complete's copy only when the newest reply is nowhere else in the tail", () => {
    const complete = turnLine(at(9), "task_complete", {
      last_agent_message: "From task_complete.",
    });
    // The reply's own lines are there: the copy is not taken.
    expect(whole(metaLine(T), agentMessageLine(at(8), "From the reply."), complete)).toBe(
      "From the reply.",
    );
    // The reply's lines lie before the end that was read: the copy is the one place it is.
    const cut = `${"x".repeat(64)}"}}\n${tokenCountLine(at(8), usage(1_000, 0, 10))}\n${complete}\n`;
    expect(lastSaidInRollout(cut, false)).toBe("From task_complete.");
    // The newest turn left no reply of its own in the file: an earlier turn's is older than its copy.
    expect(
      whole(
        metaLine(T),
        ...turn("Start the work", "An older reply."),
        messageLine(at(10), "Go on"),
        turnLine(at(10), "task_started"),
        itemLine(at(11), {
          type: "function_call",
          name: "shell",
          arguments: "{}",
          call_id: "call-0003",
        }),
        complete,
      ),
    ).toBe("From task_complete.");
    // So is an earlier turn's reply behind the end of that turn, stopped or finished, or behind a
    // prompt or the start of a turn.
    for (const earlierEnd of [
      turnLine(at(7), "task_complete", { last_agent_message: "An older reply." }),
      turnLine(at(7), "turn_complete", { last_agent_message: "An older reply." }),
      turnLine(at(7), "task_complete", { last_agent_message: null }),
      turnLine(at(7), "turn_aborted", { reason: "interrupted" }),
      messageLine(at(7), "Go on"),
      JSON.stringify({
        timestamp: new Date(at(7)).toISOString(),
        type: "event_msg",
        payload: { type: "user_message", message: "Go on" },
      }),
      turnLine(at(7), "task_started"),
      turnLine(at(7), "turn_started"),
    ]) {
      expect(
        whole(metaLine(T), agentMessageLine(at(6), "An older reply."), earlierEnd, complete),
      ).toBe("From task_complete.");
    }
  });

  test("a line quoted inside a prompt, a tool's output or a reply is never taken for one", () => {
    const quoted = agentMessageLine(at(1), "PRIVATE-QUOTED");
    const said = whole(
      metaLine(T),
      agentMessageLine(at(2), "The real reply."),
      messageLine(at(3), `Look at this line: ${quoted}`),
      itemLine(at(4), { type: "function_call_output", call_id: "call-0004", output: quoted }),
    );
    expect(said).toBe("The real reply.");
    // A reply that quotes such a line is that reply, as it was written.
    expect(whole(metaLine(T), agentMessageLine(at(5), `It wrote ${quoted}`))).toBe(
      `It wrote ${quoted}`,
    );
  });

  test("reads past a line that does not parse, or names its kinds in the wrong places", () => {
    const said = whole(
      metaLine(T),
      agentMessageLine(at(1), "Still here."),
      '{"timestamp":"2026-10-01T11:31:00.000Z","type":"event_msg","payload":{"type":"agent_message","mess',
      JSON.stringify({ type: "event_msg", payload: "agent_message" }),
      JSON.stringify({
        type: "turn_context",
        payload: { type: "agent_message", message: "PRIVATE" },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: 42 } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "   " } }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: "PRIVATE" },
      }),
    );
    expect(said).toBe("Still here.");
  });

  test("is nothing when no reply has been written yet, or none is in the end that was read", () => {
    expect(
      whole(metaLine(T), messageLine(at(1), "Start"), turnLine(at(1), "task_started")),
    ).toBeNull();
    expect(whole()).toBeNull();
    // The first line of a tail that is not the whole file is a part of a longer one, and is not read.
    expect(lastSaidInRollout(`${agentMessageLine(at(1), "Cut short.")}\n`, false)).toBeNull();
    expect(lastSaidInRollout(rollout(agentMessageLine(at(1), "Whole.")), true)).toBe("Whole.");
  });
});

const FILE = rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", threadId("c1"));
const OTHER = rolloutPath(CODEX_HOME, "2026-10-01T10-00-00", threadId("c1"), threadId("d1"));
const ID = `codex:${threadId("c1")}`;

/** A reader over files in memory, with a clock moved by hand and drops run by the test. */
function setUp() {
  const clock = handClock(NOW);
  const files = memoryFiles(clock.now);
  const drops: { run: () => void; ms: number }[] = [];
  const reader = createCodexLastMessages({
    io: files.io,
    now: clock.now,
    later: (run, ms) => drops.push({ run, ms }),
  });
  return { clock, files, reader, drops };
}

describe("the reader of Codex last messages", () => {
  test("keeps to the limits PRIVACY.md and docs/API.md give", () => {
    expect([KEEP_MS, MAX_KEPT, READS_PER_SECOND, ANSWER_AGAIN_MS]).toEqual([15_000, 8, 4, 1_000]);
  });

  test("reads only when asked, and only the file the last poll read the session from", async () => {
    const { files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), ...turn("Start", "Done.")));
    reader.keep(new Map([[ID, FILE]]));
    expect(files.calls).toEqual([]);

    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Done.", cut: false } });
    expect(files.opened()).toEqual([FILE]);
    expect(files.count("readdir") + files.count("lstat") + files.count("stat")).toBe(0);
  });

  test("answers an id the last poll did not list with nothing, and touches no file", async () => {
    const { files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), ...turn("Start", "Done.")));
    await expect(reader.read(ID)).resolves.toBeNull();
    reader.keep(new Map([[ID, FILE]]));
    for (const other of [
      `codex:${threadId("c2")}`,
      threadId("c1"),
      `claude-code:${threadId("c1")}`,
    ]) {
      await expect(reader.read(other)).resolves.toBeNull();
    }
    expect(files.calls).toEqual([]);
    expect(reader.size).toBe(0);
  });

  test("carries no token counts, which are on the session already", async () => {
    const { files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), ...turn("Start", "Done.")));
    reader.keep(new Map([[ID, FILE]]));
    const answer = await reader.read(ID);
    expect(answer).toEqual({ message: { text: "Done.", cut: false } });
    expect(answer).not.toHaveProperty("tokens");
  });

  test("makes the text fit to show, and keeps the end of a long one", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "One\r\ntwo\u0007\tthree‮")));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({
      message: { text: "One\ntwo   three", cut: false },
    });

    clock.advance(ANSWER_AGAIN_MS);
    files.append(
      FILE,
      rollout(agentMessageLine(at(2), `${"An early line.\n".repeat(200)}The very end.`)),
    );
    const answer = await reader.read(ID);
    if (answer === null || answer === "busy" || answer.message === null) {
      throw new Error("A message was expected.");
    }
    expect(answer.message.cut).toBe(true);
    expect(answer.message.text.endsWith("The very end.")).toBe(true);
    expect(Array.from(answer.message.text).length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  test("says why there is none: nothing yet, too far back, not found, or unreadable", async () => {
    const { clock, files, reader } = setUp();
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });

    clock.advance(ANSWER_AGAIN_MS);
    files.write(
      FILE,
      rollout(metaLine(T), messageLine(at(1), "Start"), turnLine(at(1), "task_started")),
    );
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "nothing-yet" });

    clock.advance(ANSWER_AGAIN_MS);
    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "‮⁦")));
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "nothing-yet" });

    clock.advance(ANSWER_AGAIN_MS);
    files.write(
      FILE,
      rollout(
        metaLine(T),
        agentMessageLine(at(1), "An old reply."),
        ...Array.from({ length: 40 }, (_, index) =>
          itemLine(at(2 + index), {
            type: "function_call_output",
            call_id: `call-${index}`,
            output: "o".repeat(10 * 1024),
          }),
        ),
      ),
    );
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "too-far-back" });

    clock.advance(ANSWER_AGAIN_MS);
    files.special(FILE);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "unreadable" });

    clock.advance(ANSWER_AGAIN_MS);
    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "Readable again.")));
    files.fail(FILE, "EACCES");
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "unreadable" });
  });

  test("a file that has gone is not found, and is opened again at the next ask after a second", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "Here.")));
    reader.keep(new Map([[ID, FILE]]));
    await reader.read(ID);

    files.remove(FILE);
    clock.advance(ANSWER_AGAIN_MS);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });

    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "Back.")));
    files.forget();
    clock.advance(ANSWER_AGAIN_MS - 1);
    await expect(reader.read(ID)).resolves.toEqual({ message: null, reason: "not-found" });
    expect(files.calls).toEqual([]);
    clock.advance(1);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Back.", cut: false } });
  });

  test("an unchanged file is opened to compare and not read, and a changed one is read again", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), ...turn("Start", "Done.")));
    reader.keep(new Map([[ID, FILE]]));
    const [first, second] = await Promise.all([reader.read(ID), reader.read(ID)]);
    expect(second).toBe(first);
    expect(files.opened()).toEqual([FILE]);

    files.forget();
    clock.advance(ANSWER_AGAIN_MS - 1);
    await expect(reader.read(ID)).resolves.toBe(first);
    expect(files.calls).toEqual([]);

    clock.advance(1);
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "Done.", cut: false } });
    expect(files.opened()).toEqual([FILE]);
    expect(files.reads).toEqual([]);

    clock.advance(ANSWER_AGAIN_MS);
    files.append(FILE, rollout(...turn("And the tests?", "They pass.", 30)));
    await expect(reader.read(ID)).resolves.toEqual({ message: { text: "They pass.", cut: false } });
    expect(files.reads).toHaveLength(1);
    expect(files.openHandles()).toBe(0);
  });

  test("a session the next poll reads from another file, as a reverted one, is read afresh from that one", async () => {
    const { clock, files, reader } = setUp();
    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "From the first file.")));
    files.write(OTHER, rollout(metaLine(T), agentMessageLine(at(1), "From the second file.")));
    reader.keep(new Map([[ID, FILE]]));
    await expect(reader.read(ID)).resolves.toMatchObject({
      message: { text: "From the first file." },
    });

    reader.keep(new Map([[ID, OTHER]]));
    expect(reader.size).toBe(0);
    clock.advance(ANSWER_AGAIN_MS);
    files.forget();
    await expect(reader.read(ID)).resolves.toMatchObject({
      message: { text: "From the second file." },
    });
    expect(files.opened()).toEqual([OTHER]);
  });

  test(`no more than ${READS_PER_SECOND} files are read in a second, and above that the answer is busy`, async () => {
    const { clock, files, reader } = setUp();
    const listed = new Map<string, string>();
    for (let index = 0; index <= READS_PER_SECOND; index += 1) {
      const thread = threadId(`e${index}`);
      const file = rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", thread);
      files.write(file, rollout(metaLine(T, { id: thread }), agentMessageLine(at(1), "Done.")));
      listed.set(`codex:${thread}`, file);
    }
    reader.keep(listed);
    const ids = [...listed.keys()];
    const answers = await Promise.all(ids.map((id) => reader.read(id)));
    expect(answers.filter((answer) => answer === "busy")).toHaveLength(1);
    expect(answers.at(-1)).toBe("busy");
    expect(files.count("openRegular")).toBe(READS_PER_SECOND);

    clock.advance(1_000);
    await expect(reader.read(ids.at(-1) ?? "")).resolves.toEqual({
      message: { text: "Done.", cut: false },
    });
  });

  test(`what is kept goes when the session leaves the list, and ${KEEP_MS / 1000} seconds after the last ask`, async () => {
    const { clock, files, reader, drops } = setUp();
    files.write(FILE, rollout(metaLine(T), agentMessageLine(at(1), "Done.")));
    reader.keep(new Map([[ID, FILE]]));
    await reader.read(ID);
    expect(reader.size).toBe(1);
    reader.keep(new Map());
    expect(reader.size).toBe(0);
    files.forget();
    await expect(reader.read(ID)).resolves.toBeNull();
    expect(files.calls).toEqual([]);

    reader.keep(new Map([[ID, FILE]]));
    await reader.read(ID);
    expect(drops.at(-1)?.ms).toBe(KEEP_MS);
    clock.advance(KEEP_MS);
    drops.at(-1)?.run();
    expect(reader.size).toBe(0);

    await reader.read(ID);
    reader.forget();
    expect(reader.size).toBe(0);
    await expect(reader.read(ID)).resolves.toBeNull();
  });
});
