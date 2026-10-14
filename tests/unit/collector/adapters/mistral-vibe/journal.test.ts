import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createJournalReader,
  readJournalLine,
  recordTypeOf,
  TAIL_LIMIT_BYTES,
  type Newest,
} from "@collector/adapters/mistral-vibe/journal";
import {
  delta,
  NOW,
  MINUTE,
  otherRecord,
  PRIVATE_WORDS,
  publicState,
  record,
  sessionId,
  type StateFields,
} from "@tests/fixtures/mistralVibe";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/mistralVibeAdapter";

const ID = sessionId("a1");
const FILE = `/Users/example/.vibe/logs/session/unified/${ID}/journal/0000000000000005.jsonl`;

const running: StateFields = {
  id: ID,
  status: "running",
  title: "demo-project refactor",
  turn: { status: "in_progress", startedAt: NOW - MINUTE },
};
const idle: StateFields = {
  id: ID,
  status: "idle",
  title: "demo-project refactor",
  turn: { status: "completed", startedAt: NOW - MINUTE, completedAt: NOW - 10_000 },
};

const line = (text: string) => Buffer.from(text.replace(/\n$/, ""));

/** The status a read found, or the kind of answer when it found none. */
function statusOf(newest: Newest): string {
  return newest.kind === "state" ? `state:${newest.envelope.statusType}` : newest.kind;
}

async function readNow(files: MemoryFiles, reader = createJournalReader(files.io)) {
  return reader.read(FILE, await files.io.lstat(FILE));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("one line of a journal", () => {
  test("its type is read from its end", () => {
    expect(recordTypeOf(line(delta(5, running)))).toBe("projection_delta");
    expect(recordTypeOf(line(otherRecord("action_intent", 6)))).toBe("action_intent");
    expect(recordTypeOf(line('{"payload":{}}'))).toBeNull();
  });

  test("a projection_delta that sets the state gives what is kept of it", () => {
    expect(readJournalLine(line(delta(5, running)))).toEqual({
      kind: "state",
      envelope: {
        title: "demo-project refactor",
        statusType: "running",
        createdAt: NOW - 60 * MINUTE,
        updatedAt: NOW - 60 * MINUTE,
        turnStatus: "in_progress",
        turnStartedAt: NOW - MINUTE,
        turnCompletedAt: null,
      },
    });
  });

  test("a projection_delta that only adds entries, and any other record, sets no state", () => {
    expect(readJournalLine(line(delta(5)))).toBeNull();
    for (const type of ["command_reserved", "core_input", "action_intent", "action_result"]) {
      expect(readJournalLine(line(otherRecord(type, 5))), type).toBeNull();
    }
    expect(readJournalLine(line(otherRecord("a_type_vibe_adds_later", 5)))).toBeNull();
  });

  test("a whole state an older build wrote, projection_advanced, is a state not read", () => {
    const advanced = record("projection_advanced", 5, {
      snapshot: publicState(running),
      watermark: 5,
    });
    expect(readJournalLine(line(advanced))).toEqual({ kind: "unread" });
  });

  test("a state that cannot be parsed, or is not one, is a state not read", () => {
    const broken = delta(5, running).replace('"session":{', '"session":{oops');
    expect(readJournalLine(line(broken))).toEqual({ kind: "unread" });
    const other = record("projection_delta", 5, {
      delta: [{ op: "set_envelope", state: { format: "harness.public-session-state/v2" } }],
      watermark: 5,
    });
    expect(readJournalLine(line(other))).toEqual({ kind: "unread" });
  });

  test("keys and values a newer Vibe adds are left where they are", () => {
    const newer = delta(5, {
      ...idle,
      turn: { ...idle.turn!, stopReason: "a_reason_vibe_adds_later" },
      extra: { newField: { nested: [1, 2, 3] } },
    });
    expect(readJournalLine(line(newer))).toMatchObject({
      kind: "state",
      envelope: { statusType: "idle", turnStatus: "completed", turnCompletedAt: NOW - 10_000 },
    });
  });

  test("the entries before the state are never parsed, even when they are not JSON at all", () => {
    const text = delta(5, running, [{ id: "entry-5", text: "ENTRY-ONLY" }]).replace(
      '{"id":"entry-5","text":"ENTRY-ONLY"}',
      `{not json ${PRIVATE_WORDS} ENTRY-ONLY`,
    );
    const parse = vi.spyOn(JSON, "parse");
    expect(statusOf(readJournalLine(line(text))!)).toBe("state:running");
    for (const [argument] of parse.mock.calls) {
      expect(String(argument)).not.toContain("ENTRY-ONLY");
    }
  });

  test("what the person asked, errors and the queue are not kept", () => {
    const failed = delta(5, {
      id: ID,
      status: "failed",
      turn: { status: "failed", startedAt: NOW - MINUTE, completedAt: NOW - 30_000 },
    });
    expect(JSON.stringify(readJournalLine(line(failed)))).not.toContain(PRIVATE_WORDS);
  });
});

describe("reading a segment", () => {
  test("the newest state wins, and records after it that set none leave it as it is", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      [delta(5, running), otherRecord("action_intent", 6), delta(7, idle), delta(8)].join(""),
    );
    expect(statusOf(await readNow(files))).toBe("state:idle");
  });

  test("an empty segment, or one that sets no state, has none: the generation's state is the newest", async () => {
    const files = memoryFiles();
    files.write(FILE, "");
    expect(await readNow(files)).toEqual({ kind: "none" });
    files.write(FILE, [otherRecord("core_input", 5), delta(6)].join(""));
    expect(await readNow(files)).toEqual({ kind: "none" });
  });

  test("a whole state from an older build after the newest delta makes the state not read", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      [
        delta(5, running),
        record("projection_advanced", 6, { snapshot: publicState(idle), watermark: 6 }),
      ].join(""),
    );
    expect(await readNow(files)).toEqual({ kind: "unread" });
  });

  test("after the first read, only what was added is read", async () => {
    const files = memoryFiles();
    files.write(FILE, delta(5, running));
    const reader = createJournalReader(files.io);
    expect(statusOf(await readNow(files, reader))).toBe("state:running");
    const before = (await files.io.lstat(FILE)).size;

    files.forget();
    files.append(FILE, [otherRecord("action_result", 6), delta(7, idle)].join(""), {
      mtimeMs: NOW + 1,
    });
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");
    expect(files.reads.length).toBeGreaterThan(0);
    for (const read of files.reads) expect(read.position).toBeGreaterThanOrEqual(before - 1);

    // Nothing changed: nothing is opened.
    files.forget();
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");
    expect(files.opened()).toEqual([]);
  });

  test("a last line still being written is left for the next read", async () => {
    const files = memoryFiles();
    files.write(FILE, delta(5, running));
    const reader = createJournalReader(files.io);
    await readNow(files, reader);

    const next = delta(6, idle);
    const half = Math.floor(next.length / 2);
    files.append(FILE, next.slice(0, half), { mtimeMs: NOW + 1 });
    expect(statusOf(await readNow(files, reader))).toBe("state:running");
    files.append(FILE, next.slice(half), { mtimeMs: NOW + 2 });
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");
  });

  test("a first read of an unfinished segment leaves its last line too", async () => {
    const files = memoryFiles();
    const next = delta(6, idle);
    files.write(FILE, `${delta(5, running)}${next.slice(0, 40)}`);
    const reader = createJournalReader(files.io);
    expect(statusOf(await readNow(files, reader))).toBe("state:running");
    files.append(FILE, next.slice(40), { mtimeMs: NOW + 1 });
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");
  });

  test("starts over when the segment shrinks, is replaced, or is rewritten in place", async () => {
    const files = memoryFiles();
    files.write(FILE, [delta(5, running), delta(6, running)].join(""));
    const reader = createJournalReader(files.io);
    await readNow(files, reader);

    // Vibe cut off a torn line, and wrote a new state over it.
    files.rewrite(FILE, delta(5, idle), { mtimeMs: NOW + 1 });
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");

    // Another file under the same name.
    files.write(FILE, delta(5, running), { mtimeMs: NOW + 2 });
    expect(statusOf(await readNow(files, reader))).toBe("state:running");
  });

  test("starts over when the segment is rewritten in place, longer, with no line ending where the last read did", async () => {
    const files = memoryFiles();
    const first = delta(5, running);
    files.write(FILE, first);
    const reader = createJournalReader(files.io);
    expect(statusOf(await readNow(files, reader))).toBe("state:running");

    // The same file, now holding a shorter line that sets the state and, across
    // the old end, a longer one that sets none.
    const rewritten = `${delta(5, idle, [])}${otherRecord("action_result", 6)}`;
    expect(Buffer.byteLength(delta(5, idle, []))).toBeLessThan(Buffer.byteLength(first) - 1);
    expect(Buffer.byteLength(rewritten)).toBeGreaterThan(Buffer.byteLength(first));
    expect(rewritten[Buffer.byteLength(first) - 1]).not.toBe("\n");
    files.rewrite(FILE, rewritten, { mtimeMs: NOW + 1 });
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");
  });

  test("the first read looks through no more than the tail of a long segment", async () => {
    const files = memoryFiles();
    const filler = otherRecord("action_result", 9).replace(PRIVATE_WORDS, "x".repeat(64 * 1024));
    const lines = [delta(5, running)];
    while (lines.join("").length < TAIL_LIMIT_BYTES + 512 * 1024) lines.push(filler);
    files.write(FILE, lines.join(""));
    expect(await readNow(files)).toEqual({ kind: "beyond" });
    const read = files.reads.reduce((sum, each) => sum + each.length, 0);
    expect(read).toBeLessThanOrEqual(TAIL_LIMIT_BYTES);

    // The newest state near the end is found without reading back to the start.
    files.forget();
    files.write(FILE, `${lines.join("")}${delta(99, idle)}`);
    expect(statusOf(await readNow(files))).toBe("state:idle");
    expect(files.reads.reduce((sum, each) => sum + each.length, 0)).toBeLessThan(TAIL_LIMIT_BYTES);
  });

  test("a line longer than the tail, whose start is never read, still gives its state", async () => {
    const files = memoryFiles();
    const huge = delta(6, idle, [{ id: "entry-6", text: "y".repeat(9 * 1024 * 1024) }]);
    files.write(FILE, `${delta(5, running)}${huge}`);
    expect(statusOf(await readNow(files))).toBe("state:idle");
    expect(files.reads.reduce((sum, each) => sum + each.length, 0)).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("a line longer than the tail that sets no state there is not known", async () => {
    const files = memoryFiles();
    const huge = delta(6, undefined, [{ id: "entry-6", text: "y".repeat(9 * 1024 * 1024) }]);
    files.write(FILE, `${delta(5, running)}${huge}`);
    expect(await readNow(files)).toEqual({ kind: "beyond" });
  });

  test("more than the tail added at once is read afresh from the end", async () => {
    const files = memoryFiles();
    files.write(FILE, delta(5, running));
    const reader = createJournalReader(files.io);
    await readNow(files, reader);
    const huge = delta(6, idle, [{ id: "entry-6", text: "z".repeat(TAIL_LIMIT_BYTES) }]);
    files.forget();
    files.append(FILE, huge, { mtimeMs: NOW + 1 });
    expect(statusOf(await readNow(files, reader))).toBe("state:idle");
    expect(files.reads.reduce((sum, each) => sum + each.length, 0)).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("reads no more than the tail at once when more was added after the look than the look saw", async () => {
    const files = memoryFiles();
    files.write(FILE, delta(5, running));
    const reader = createJournalReader(files.io);
    await readNow(files, reader);

    // The look sees one short line added, and Vibe adds a long one before the open.
    files.append(FILE, otherRecord("action_result", 6), { mtimeMs: NOW + 1 });
    const looked = await files.io.lstat(FILE);
    const huge = delta(7, idle, [{ id: "entry-7", text: "z".repeat(TAIL_LIMIT_BYTES) }]);
    files.append(FILE, huge, { mtimeMs: NOW + 2 });
    files.forget();
    expect(statusOf(await reader.read(FILE, looked))).toBe("state:idle");
    for (const read of files.reads) expect(read.length).toBeLessThanOrEqual(TAIL_LIMIT_BYTES);
    expect(files.reads.reduce((sum, each) => sum + each.length, 0)).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("every file it opens, it closes", async () => {
    const files = memoryFiles();
    files.write(FILE, delta(5, running));
    const reader = createJournalReader(files.io);
    await readNow(files, reader);
    files.append(FILE, delta(6, idle), { mtimeMs: NOW + 1 });
    await readNow(files, reader);
    expect(files.openHandles()).toBe(0);
  });
});
