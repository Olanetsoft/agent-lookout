import { describe, expect, test, vi } from "vitest";

import {
  createWireReader,
  openInteractions,
  WIRE_TAIL_BYTES,
} from "@collector/adapters/kimi-code/wireFile";
import {
  BUCKET,
  KIMI_HOME,
  LOCKED_AT,
  NOW,
  PRIVATE_WORDS,
  sessionFolder,
  sessionIdOf,
  wireAnswered,
  wireAsked,
  wireFile,
  wirePrompt,
  wireStart,
} from "@tests/fixtures/kimi-code/kimiCode";
import { memoryFiles, oneChangeEach } from "@tests/support/adapters/kimi-code/kimiCodeAdapter";

const ID = sessionIdOf(1);
const PLACE = { id: ID, bucket: BUCKET };
const AT = LOCKED_AT + 1000;

const open = (text: string) => openInteractions(Buffer.from(text));

describe("openInteractions", () => {
  test("an approval or a question with no answer is open, with its id, kind and time alone", () => {
    expect(
      open(wireStart() + wirePrompt() + wireAsked("a", "approval", AT) + wirePrompt(AT + 1)),
    ).toEqual([{ id: "a", kind: "approval", at: AT }]);
    expect(open(wireStart() + wireAsked("q", "question", AT))).toEqual([
      { id: "q", kind: "question", at: AT },
    ]);
  });

  test("keeps nothing of what was asked or answered", () => {
    const text = open(wireStart() + wireAsked("a", "approval", AT));
    expect(JSON.stringify(text)).not.toContain(PRIVATE_WORDS);
    expect(JSON.stringify(text)).not.toContain("demo-tool");
  });

  test("an answer closes the one it names, and only that", () => {
    const text =
      wireStart() +
      wireAsked("a", "approval", AT) +
      wireAsked("q", "question", AT + 1) +
      wireAnswered("a", AT + 2);
    expect(open(text)).toEqual([{ id: "q", kind: "question", at: AT + 1 }]);
  });

  test("a client's own tool waits for no person", () => {
    expect(open(wireStart() + wireAsked("t", "user_tool", AT))).toEqual([]);
    expect(open(wireStart() + wireAsked("t", "something-new", AT))).toEqual([]);
  });

  test("a line of another interaction type opens nothing", () => {
    const other = wireAsked("a", "approval", AT, { type: "interaction.cancelled" });
    expect(open(wireStart() + other)).toEqual([]);
  });

  test("a line with a bad id or time is not taken", () => {
    for (const changes of [{ id: 5 }, { id: "" }, { id: "x y" }, { id: "x".repeat(129) }]) {
      expect(open(wireStart() + wireAsked("a", "approval", AT, changes))).toEqual([]);
    }
    for (const time of ["soon", null, 1.5]) {
      expect(open(wireStart() + wireAsked("a", "approval", AT, { time }))).toEqual([]);
    }
  });

  test("a line of JSON that is broken is skipped, and so is a line that is no record", () => {
    const broken = `{"type":"interaction.request","id":"b"\n[1]\n`;
    expect(open(wireStart() + broken + wireAsked("a", "approval", AT))).toHaveLength(1);
  });

  test("a line still being written is left for the next read", () => {
    const line = wireAsked("a", "approval", AT);
    expect(open(wireStart() + line.slice(0, -5))).toEqual([]);
    expect(open(wireStart() + line.slice(0, -1))).toEqual([]);
    expect(open(wireStart() + line)).toHaveLength(1);
  });

  test("text that looks like such a line inside a prompt is not one", () => {
    const quoted = wirePrompt().replace(
      PRIVATE_WORDS,
      `{"type":"interaction.request","id":"x","kind":"approval","time":${AT}}`,
    );
    expect(open(wireStart() + quoted)).toEqual([]);
  });

  test("turns only an interaction's line into text", () => {
    const asked = wireAsked("a", "approval", AT);
    const data = Buffer.from(wireStart() + wirePrompt() + asked + wirePrompt());
    const decode = vi.spyOn(Buffer.prototype, "toString");
    openInteractions(data);
    const calls = decode.mock.calls.map(([, start, end]) => [start, end]);
    decode.mockRestore();
    const from = data.indexOf(asked);
    expect(calls).toEqual([[from, from + asked.length - 1]]);
  });
});

describe("createWireReader", () => {
  const setUp = (text = wireStart()) => {
    const files = memoryFiles(() => NOW);
    files.write(wireFile(ID), text);
    return { files, wires: createWireReader(KIMI_HOME, files.io) };
  };
  const look = (files: ReturnType<typeof memoryFiles>) => files.io.lstat(wireFile(ID));

  test("reads a file only when it changes", async () => {
    const { files, wires } = setUp(wireStart() + wireAsked("a", "approval", AT));
    expect(await wires.read(PLACE, await look(files))).toHaveLength(1);
    await wires.read(PLACE, await look(files));
    expect(files.opened()).toHaveLength(1);

    files.append(wireFile(ID), wireAnswered("a", AT + 1), { mtimeMs: NOW + 1 });
    expect(await wires.read(PLACE, await look(files))).toEqual([]);
    expect(files.opened()).toHaveLength(2);
  });

  test.each(oneChangeEach(wireStart(), NOW))(
    "reads a file again when only its %s changes",
    async (_what, change) => {
      const { files, wires } = setUp();
      await wires.read(PLACE, await look(files));
      change(files, wireFile(ID));
      files.forget();
      await wires.read(PLACE, await look(files));
      expect(files.opened()).toEqual([wireFile(ID)]);
    },
  );

  test("reads at most the file's end, however long the file", async () => {
    const padding = wirePrompt().repeat(Math.ceil((WIRE_TAIL_BYTES * 2) / wirePrompt().length));
    const { files, wires } = setUp(wireStart() + padding + wireAsked("a", "approval", AT));
    expect(await wires.read(PLACE, await look(files))).toHaveLength(1);
    expect(files.reads).toHaveLength(1);
    expect(files.reads[0]?.length).toBe(WIRE_TAIL_BYTES);
    expect(files.reads[0]?.position).toBeGreaterThan(0);
  });

  test("a wait further back than the read, or an answer to it alone, opens nothing", async () => {
    const padding = wirePrompt().repeat(Math.ceil((WIRE_TAIL_BYTES * 2) / wirePrompt().length));
    const { files, wires } = setUp(
      wireStart() + wireAsked("a", "approval", AT) + padding + wireAnswered("a", AT + 1),
    );
    expect(await wires.read(PLACE, await look(files))).toEqual([]);
  });

  test("a line longer than the read is not read, and shows no wait", async () => {
    const long = wireAsked("a", "approval", AT, {
      request: { detail: "x".repeat(WIRE_TAIL_BYTES + 10) },
    });
    const { files, wires } = setUp(wireStart() + long);
    expect(await wires.read(PLACE, await look(files))).toEqual([]);
  });

  test("a file rewritten in a shorter form is read again", async () => {
    const { files, wires } = setUp(wireStart() + wireAsked("a", "approval", AT));
    await wires.read(PLACE, await look(files));
    files.write(wireFile(ID), wireStart());
    expect(await wires.read(PLACE, await look(files))).toEqual([]);
  });

  test("a read that fails leaves what was read before, and is tried again", async () => {
    const { files, wires } = setUp(wireStart() + wireAsked("a", "approval", AT));
    await wires.read(PLACE, await look(files));
    files.append(wireFile(ID), wireAnswered("a", AT + 1), { mtimeMs: NOW + 1 });
    files.failOpen(wireFile(ID));
    expect(await wires.read(PLACE, await look(files))).toHaveLength(1);
    files.heal(wireFile(ID));
    expect(await wires.read(PLACE, await look(files))).toEqual([]);
  });

  test("a read that fails with nothing read before shows no wait", async () => {
    const { files, wires } = setUp(wireStart() + wireAsked("a", "approval", AT));
    files.failOpen(wireFile(ID));
    expect(await wires.read(PLACE, await look(files))).toEqual([]);
  });

  test("a link in place of the file, or of a folder on the way to it, is not opened", async () => {
    const { files, wires } = setUp();
    files.remove(wireFile(ID));
    files.special(wireFile(ID));
    expect(await wires.read(PLACE, await look(files))).toEqual([]);

    const linked = memoryFiles(() => NOW);
    linked.special(`${sessionFolder(ID)}/agents`);
    const through = createWireReader(KIMI_HOME, linked.io);
    expect(await through.read(PLACE, { kind: "file", size: 2, mtimeMs: NOW, ino: 1 })).toEqual([]);
    expect(linked.opened()).toEqual([]);
  });

  test("forgets every session it is told to", async () => {
    const { files, wires } = setUp();
    await wires.read(PLACE, await look(files));
    wires.keepOnly(new Set());
    await wires.read(PLACE, await look(files));
    expect(files.opened()).toHaveLength(2);
  });
});
