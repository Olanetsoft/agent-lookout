import { describe, expect, test } from "vitest";

import {
  applyGeminiCliRecord,
  emptyGeminiCliReplay,
  ENVIRONMENT_CONTEXT_ID,
  mapGeminiCliStatus,
  MAX_KEPT_MESSAGES,
  replayGeminiCliRecords,
  type GeminiCliContent,
  type GeminiCliMessage,
  type GeminiCliRecord,
} from "@core/mapping/gemini-cli/geminiCliMapping";
import type { SessionStatus } from "@core/sessions/session";

const T = Date.UTC(2026, 9, 1, 11, 0, 0);

const SHAPE: GeminiCliContent = {
  empty: false,
  functionCall: false,
  functionResponse: false,
  thoughtOnly: false,
  note: false,
};

function message(
  id: string,
  type: GeminiCliMessage["type"],
  at: number,
  content: Partial<GeminiCliContent> | null = {},
  toolCalls: GeminiCliMessage["toolCalls"] = null,
): GeminiCliRecord {
  return {
    kind: "message",
    message: {
      id,
      type,
      at,
      content: content === null ? null : { ...SHAPE, ...content },
      toolCalls,
    },
  };
}

const header = (startedAt = T): GeminiCliRecord => ({
  kind: "header",
  startedAt,
  updatedAt: startedAt,
});
const context = (at = T + 100) => message(ENVIRONMENT_CONTEXT_ID, "user", at, { note: false });
const prompt = (id: string, at: number) => message(id, "user", at);
const toolResult = (id: string, at: number) => message(id, "user", at, { functionResponse: true });
const reply = (id: string, at: number) => message(id, "gemini", at);
const callsOnly = (id: string, at: number) => message(id, "gemini", at, { empty: true });
const batch = (id: string, at: number, allCancelled = false, lastAt = at + 5_000) =>
  message(id, "gemini", at, { empty: true }, { allCancelled, lastAt });
const notice = (type: "info" | "warning" | "error", id: string, at: number) =>
  message(id, type, at);
const updated = (at: number): GeminiCliRecord => ({ kind: "set", reattach: false, updatedAt: at });
const rewind = (id: string): GeminiCliRecord => ({ kind: "rewind", id });
const patch = (fields: Partial<Extract<GeminiCliRecord, { kind: "patch" }>>): GeminiCliRecord => ({
  kind: "patch",
  updates: [],
  removeIds: [],
  orderIds: null,
  ...fields,
});

const statusOf = (records: GeminiCliRecord[], fromStart = true) =>
  mapGeminiCliStatus(replayGeminiCliRecords(records, fromStart));

describe("mapGeminiCliStatus, by the newest message that says how the session stands", () => {
  // Every row of the table in geminiCliMapping.ts and docs/adapters/gemini-cli.md.
  test.each<[string, GeminiCliRecord[], SessionStatus, number | null]>([
    ["a new session, with only its context", [header(), context(), updated(T + 100)], "idle", T],
    [
      "a prompt",
      [header(), context(), prompt("p1", T + 60_000), updated(T + 60_000)],
      "working",
      T + 60_000,
    ],
    [
      "a reply that was only calls for tools: a tool waits or runs",
      [header(), prompt("p1", T + 60_000), callsOnly("g1", T + 70_000), updated(T + 70_000)],
      "working",
      T + 60_000,
    ],
    [
      "a reply that asks for a tool in its parts",
      [
        header(),
        prompt("p1", T + 60_000),
        message("g1", "gemini", T + 70_000, { functionCall: true }),
      ],
      "working",
      T + 60_000,
    ],
    [
      "a tool's result",
      [
        header(),
        prompt("p1", T + 60_000),
        batch("g1", T + 70_000),
        toolResult("r1", T + 80_000),
        updated(T + 80_000),
      ],
      "working",
      T + 60_000,
    ],
    [
      "the note Gemini CLI writes before it asks about a file a tool sent back",
      [
        header(),
        prompt("p1", T + 60_000),
        batch("g1", T + 70_000),
        toolResult("r1", T + 80_000),
        message("g2", "gemini", T + 80_001, { thoughtOnly: true }),
        notice("info", "i1", T + 80_002),
      ],
      "working",
      T + 60_000,
    ],
    [
      "a reply with text",
      [header(), prompt("p1", T + 60_000), reply("g1", T + 90_000), updated(T + 90_000)],
      "idle",
      T + 90_000,
    ],
    [
      "an error",
      [header(), prompt("p1", T + 60_000), notice("error", "e1", T + 90_000)],
      "idle",
      T + 90_000,
    ],
  ])("%s is %s", (_name, records, status, since) => {
    expect(statusOf(records)).toEqual({ status, since });
  });

  test("a batch of tool calls with nothing after it is unknown, with when it ended for the collector", () => {
    // As a tool that stops the agent leaves it, and as every batch is for a moment before its results.
    const records = [
      header(),
      prompt("p1", T + 60_000),
      batch("g1", T + 70_000),
      notice("info", "i1", T + 80_000),
    ];
    expect(statusOf(records)).toEqual({
      status: "unknown",
      since: null,
      batch: { endedAt: T + 75_000, workingSince: T + 60_000 },
    });
  });

  test.each<[string, GeminiCliRecord[]]>([
    [
      "a batch of tool calls whose every call was cancelled, with nothing after it",
      [header(), prompt("p1", T + 60_000), batch("g1", T + 70_000, true)],
    ],
    ["a type Gemini CLI 0.64.0 does not write", [header(), message("x1", "other", T + 60_000)]],
    [
      "a reply too long to read",
      [header(), prompt("p1", T + 60_000), message("g1", "gemini", T + 70_000, null)],
    ],
  ])("%s is unknown, with no time", (_name, records) => {
    expect(statusOf(records)).toEqual({ status: "unknown", since: null });
  });

  test("with nothing that says how it stands, a file read from part way through is unknown", () => {
    expect(statusOf([context()], false)).toEqual({ status: "unknown", since: null });
    expect(statusOf([context()], true)).toEqual({ status: "idle", since: null });
  });

  test("a prompt too long to read is working, with no time it began", () => {
    const records = [header(), prompt("p1", T + 60_000), message("p2", "user", T + 70_000, null)];
    expect(statusOf(records)).toEqual({ status: "working", since: null });
  });

  test("notes, info and warnings say nothing of how a session stands", () => {
    const records = [
      header(),
      prompt("p1", T + 60_000),
      reply("g1", T + 90_000),
      message("n1", "user", T + 100_000, { note: true }),
      notice("info", "i1", T + 110_000),
      notice("warning", "w1", T + 120_000),
      message(ENVIRONMENT_CONTEXT_ID, "user", T + 130_000),
    ];
    expect(statusOf(records)).toEqual({ status: "idle", since: T + 90_000 });
  });

  test("a tool's result after a batch whose every call was cancelled, as Esc leaves it, is idle", () => {
    const records = [
      header(),
      prompt("p1", T + 60_000),
      callsOnly("g1", T + 70_000),
      notice("info", "i1", T + 75_000),
      batch("g2", T + 76_000, true),
      toolResult("r1", T + 76_500),
      updated(T + 76_500),
    ];
    expect(statusOf(records)).toEqual({ status: "idle", since: T + 76_500 });
  });

  test("never says a session needs you, has finished or has failed", () => {
    const kinds: GeminiCliRecord[][] = [
      [prompt("p", T)],
      [toolResult("r", T)],
      [reply("g", T)],
      [callsOnly("g", T)],
      [batch("g", T)],
      [batch("g", T, true)],
      [notice("error", "e", T)],
      [notice("info", "i", T)],
      [message("x", "other", T)],
      [rewind("x")],
      [{ kind: "set", reattach: true }],
    ];
    const seen = new Set<SessionStatus>();
    for (const records of kinds) {
      for (const fromStart of [true, false]) {
        seen.add(statusOf([header(), ...records], fromStart).status);
      }
    }
    expect(seen).toEqual(new Set(["working", "idle", "unknown"]));
  });
});

describe("replaying a session file by Gemini CLI's own rules", () => {
  test("a line with an id already seen replaces that message where it stands", () => {
    const replay = replayGeminiCliRecords([
      prompt("p1", T),
      callsOnly("g1", T + 1_000),
      notice("info", "i1", T + 2_000),
      // The same reply, written again with its tool calls once they ended.
      batch("g1", T + 1_000),
    ]);
    expect([...replay.messages.keys()]).toEqual(["p1", "g1", "i1"]);
    expect(replay.messages.get("g1")?.toolCalls).not.toBeNull();
  });

  test("a rewind drops that message and every one after it, and is a rollback: idle since the next $set", () => {
    const replay = replayGeminiCliRecords([
      header(),
      reply("g0", T),
      prompt("p1", T + 60_000),
      updated(T + 60_000),
      rewind("p1"),
      updated(T + 61_000),
      updated(T + 62_000),
    ]);
    expect([...replay.messages.keys()]).toEqual(["g0"]);
    expect(mapGeminiCliStatus(replay)).toEqual({ status: "idle", since: T + 61_000 });
  });

  test("a rewind to an id it does not hold clears every message", () => {
    const replay = replayGeminiCliRecords([prompt("p1", T), reply("g1", T + 1_000), rewind("zz")]);
    expect(replay.messages.size).toBe(0);
    expect(mapGeminiCliStatus(replay).status).toBe("idle");
  });

  test("a rewind that drops only notes is no rollback", () => {
    const records = [prompt("p1", T), notice("info", "i1", T + 1_000), rewind("i1")];
    expect(statusOf(records)).toEqual({ status: "working", since: T });
  });

  test("a patch that removes only info or warnings is no rollback", () => {
    const records = [
      header(),
      notice("info", "i1", T + 10_000),
      notice("warning", "w1", T + 20_000),
      prompt("p1", T + 60_000),
      patch({ removeIds: ["i1", "w1"] }),
      updated(T + 60_001),
    ];
    expect(statusOf(records)).toEqual({ status: "working", since: T + 60_000 });
  });

  test("a patch that removes the newest prompt is a rollback", () => {
    const records = [
      header(),
      reply("g0", T),
      prompt("p1", T + 60_000),
      patch({ removeIds: ["p1"] }),
      updated(T + 61_000),
    ];
    expect(statusOf(records)).toEqual({ status: "idle", since: T + 61_000 });
  });

  test("the decline of a tool ends idle: the batch and its notice are taken back", () => {
    const records = [
      header(),
      prompt("p1", T + 60_000),
      updated(T + 60_000),
      callsOnly("g1", T + 70_000),
      updated(T + 70_000),
      batch("g1", T + 70_000, true),
      notice("info", "i1", T + 80_000),
      rewind("g1"),
      updated(T + 80_001),
    ];
    expect(statusOf(records)).toEqual({ status: "idle", since: T + 80_001 });
  });

  test("a prompt stopped while the model streams ends idle: the prompt is taken back", () => {
    const records = [
      header(),
      reply("g0", T),
      prompt("p1", T + 60_000),
      updated(T + 60_000),
      rewind("p1"),
      updated(T + 65_000),
    ];
    expect(statusOf(records)).toEqual({ status: "idle", since: T + 65_000 });
  });

  test("a request that fails ends idle: the prompt is taken back and the error kept", () => {
    const records = [
      header(),
      prompt("p1", T + 60_000),
      updated(T + 60_000),
      rewind("p1"),
      updated(T + 65_000),
      notice("error", "e1", T + 65_001),
      updated(T + 65_001),
    ];
    expect(statusOf(records)).toEqual({ status: "idle", since: T + 65_001 });
  });

  test("with context management, the patch sent with each prompt leaves it working", () => {
    const records = [
      header(),
      reply("g0", T),
      notice("info", "i1", T + 30_000),
      prompt("p1", T + 60_000),
      // Gemini CLI reorders what it sent and drops the notices the model never sees.
      patch({ removeIds: ["i1"], orderIds: ["g0", "p1"] }),
      updated(T + 60_001),
    ];
    expect(statusOf(records)).toEqual({ status: "working", since: T + 60_000 });
  });

  test("orderIds moves the messages it names to the end, in its order", () => {
    const replay = replayGeminiCliRecords([
      prompt("a", T),
      reply("b", T + 1),
      prompt("c", T + 2),
      reply("d", T + 3),
      patch({ orderIds: ["d", "b", "unknown", "d"] }),
    ]);
    expect([...replay.messages.keys()]).toEqual(["a", "c", "d", "b"]);
    expect(mapGeminiCliStatus(replay)).toEqual({ status: "idle", since: T + 1 });
  });

  test("a patch's change to a message's content is kept", () => {
    const replay = replayGeminiCliRecords([
      prompt("p1", T),
      reply("g1", T + 1),
      patch({
        updates: [{ id: "g1", content: { ...SHAPE, empty: true } }, { id: "nope" }],
        removeIds: [],
      }),
    ]);
    expect(replay.messages.get("g1")?.content?.empty).toBe(true);
    expect(mapGeminiCliStatus(replay)).toEqual({ status: "working", since: T });
  });

  describe("a $set of messages, as Gemini CLI 0.44 to 0.63 wrote one", () => {
    const of = (record: GeminiCliRecord) => (record as { message: GeminiCliMessage }).message;
    const setMessages = (records: GeminiCliRecord[], at: number): GeminiCliRecord => ({
      kind: "set",
      reattach: false,
      updatedAt: at,
      messages: records.map(of),
    });
    const began = [header(), setMessages([context()], T + 100)];

    test("with the context alone, at the start, is a new session: idle since it began", () => {
      expect(statusOf(began)).toEqual({ status: "idle", since: T });
    });

    test("that drops the newest prompt, as a stop does, is a rollback: idle since it", () => {
      const records = [
        ...began,
        prompt("p1", T + 60_000),
        reply("g1", T + 70_000),
        prompt("p2", T + 80_000),
        updated(T + 80_000),
        setMessages([context(), prompt("p1", T + 60_000), reply("g1", T + 70_000)], T + 85_000),
      ];
      expect(statusOf(records)).toEqual({ status: "idle", since: T + 85_000 });
    });

    test("that holds only what was there, after a re-attach, leaves it idle since then", () => {
      const held = [prompt("p1", T + 60_000), reply("g1", T + 70_000)];
      const records = [
        ...began,
        ...held,
        { kind: "set", reattach: true } as GeminiCliRecord,
        setMessages([context(), ...held], T + 3_600_000),
      ];
      expect(statusOf(records)).toEqual({ status: "idle", since: T + 3_600_000 });
      // Taken up after a run that ended on its prompt, too.
      const ended = [prompt("p1", T + 60_000)];
      const lastPrompt = [
        ...began,
        ...ended,
        { kind: "set", reattach: true } as GeminiCliRecord,
        setMessages([context(), ...ended], T + 3_600_000),
      ];
      expect(statusOf(lastPrompt)).toEqual({ status: "idle", since: T + 3_600_000 });
    });

    describe("taking up a round of tools, after a re-attach", () => {
      const reattach: GeminiCliRecord = { kind: "set", reattach: true };
      const round = [
        ...began,
        prompt("p1", T + 60_000),
        batch("g1", T + 70_000),
        toolResult("u1", T + 80_000),
        updated(T + 80_000),
      ];
      const at = T + 3 * 86_400_000;
      // Gemini CLI drops the tool's result, whose text is "", and writes the
      // batch's results again after the batch, as a new message made then.
      const taken = [context(), prompt("p1", T + 60_000), batch("g1", T + 70_000)];
      const copy = toolResult("g1_response", at);

      test("with the copy of its results newest, as a run stopped on the result leaves it, is idle since then", () => {
        const records = [...round, reattach, setMessages([...taken, copy], at)];
        expect(statusOf(records)).toEqual({ status: "idle", since: at });
      });

      test("with the copy between the batch and its reply, is idle since then", () => {
        const answer = reply("r1", T + 90_000);
        const records = [
          ...round,
          answer,
          updated(T + 90_000),
          reattach,
          setMessages([...taken, copy, answer], at),
        ];
        expect(statusOf(records)).toEqual({ status: "idle", since: at });
      });
    });

    test("read from part way through the file, a message not seen is not new: after a re-attach it is idle since then", () => {
      const at = T + 3 * 86_400_000;
      const records: GeminiCliRecord[] = [
        header(),
        updated(T + 90_000),
        { kind: "set", reattach: true },
        setMessages([context(), prompt("p1", T + 60_000), reply("r1", T + 90_000)], at),
      ];
      expect(statusOf(records, false)).toEqual({ status: "idle", since: at });
    });

    test("too long to read, after a re-attach, is unknown", () => {
      const records: GeminiCliRecord[] = [
        ...began,
        prompt("p1", T + 60_000),
        { kind: "set", reattach: true },
        { kind: "set", reattach: false, messages: [of(message("x1", "other", T + 3_600_000))] },
      ];
      expect(statusOf(records)).toEqual({ status: "unknown", since: null });
    });
  });

  test("a $set of messages replaces every message", () => {
    const replay = replayGeminiCliRecords([
      prompt("p1", T),
      {
        kind: "set",
        reattach: false,
        messages: [
          (prompt("q1", T + 1) as { message: GeminiCliMessage }).message,
          (reply("q2", T + 2) as { message: GeminiCliMessage }).message,
        ],
      },
    ]);
    expect([...replay.messages.keys()]).toEqual(["q1", "q2"]);
    expect(mapGeminiCliStatus(replay)).toEqual({ status: "idle", since: T + 2 });
  });

  describe("a program taking the session up again, a $set of sessionId", () => {
    const DAY = 86_400_000;
    const reattach: GeminiCliRecord = { kind: "set", reattach: true };
    /** A round of tools: the prompt, the batch and its result. */
    const round = [
      header(),
      context(),
      updated(T + 100),
      prompt("p1", T + 60_000),
      batch("g1", T + 70_000),
      toolResult("u1", T + 80_000),
      updated(T + 80_000),
    ];
    /**
     * What Gemini CLI writes as it takes the session's history up again: the
     * batch's results written again, a patch that drops what the model never
     * sees and puts the list in order, then the time.
     */
    const resumed = (at: number, removeIds: string[], orderIds: string[]) => [
      reattach,
      toolResult("g1_response", at),
      patch({ updates: [{ id: ENVIRONMENT_CONTEXT_ID, content: SHAPE }], removeIds, orderIds }),
      updated(at + 1),
    ];
    const order = [ENVIRONMENT_CONTEXT_ID, "p1", "g1", "g1_response", "u1"];

    test("is idle since the $set after it, though its last reply is two days old", () => {
      const replied = [...round, reply("r1", T + 90_000), updated(T + 90_000)];
      const at = T + 2 * DAY;
      expect(statusOf([...replied, ...resumed(at, [], [...order, "r1"])])).toEqual({
        status: "idle",
        since: at + 1,
      });
    });

    test("is idle, not working, though its last round of tools ended in an error", () => {
      const failed = [...round, notice("error", "e1", T + 90_000), updated(T + 90_000)];
      const at = T + 3 * DAY;
      expect(statusOf([...failed, ...resumed(at, ["e1"], order)])).toEqual({
        status: "idle",
        since: at + 1,
      });
    });

    test("with nothing else to write, it is idle since it is not known when", () => {
      const replied = [...round, reply("r1", T + 90_000), updated(T + 90_000)];
      expect(statusOf([...replied, reattach])).toEqual({ status: "idle", since: null });
    });

    test("a prompt after it is working again", () => {
      const at = T + 2 * DAY;
      const records = [...round, ...resumed(at, [], order), prompt("p2", at + 60_000)];
      expect(statusOf(records)).toEqual({ status: "working", since: at + 60_000 });
      // With nothing written between, too.
      expect(statusOf([...round, reattach, prompt("p2", at), updated(at)])).toEqual({
        status: "working",
        since: at,
      });
    });

    test("a rewind is idle since the $set after the copies Gemini CLI writes with it", () => {
      const records = [
        ...round,
        reply("r1", T + 90_000),
        prompt("p2", T + 100_000),
        updated(T + 100_000),
        rewind("p2"),
        toolResult("g1_response", T + 200_000),
        patch({
          removeIds: [ENVIRONMENT_CONTEXT_ID],
          orderIds: ["p1", "g1", "g1_response", "u1", "r1"],
        }),
        updated(T + 200_001),
      ];
      expect(statusOf(records)).toEqual({ status: "idle", since: T + 200_001 });
    });
  });

  test("keeps the title, the times last written and the start", () => {
    const replay = replayGeminiCliRecords([
      { kind: "header", startedAt: T, updatedAt: T, summary: "First title" },
      prompt("p1", T + 60_000),
      batch("g1", T + 70_000, false, T + 75_000),
      { kind: "set", reattach: false, summary: "A later title" },
      updated(T + 80_000),
    ]);
    expect(replay.startedAt).toBe(T);
    expect(replay.summary).toBe("A later title");
    expect(replay.updatedAt).toBe(T + 80_000);
    expect(replay.messageAt).toBe(T + 70_000);
    expect(replay.toolAt).toBe(T + 75_000);
  });

  test("keeps no more than the cap of messages, dropping the oldest", () => {
    const replay = emptyGeminiCliReplay(true);
    for (let index = 0; index <= MAX_KEPT_MESSAGES; index += 1) {
      applyGeminiCliRecord(replay, prompt(`m${index}`, T + index));
    }
    expect(replay.messages.size).toBe(MAX_KEPT_MESSAGES);
    expect(replay.messages.has("m0")).toBe(false);
    // A rewind to the dropped one clears the list, as Gemini CLI's reader does for an id it does not hold.
    applyGeminiCliRecord(replay, rewind("m0"));
    expect(replay.messages.size).toBe(0);
  });
});
