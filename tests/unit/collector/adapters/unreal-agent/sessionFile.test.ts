import { describe, expect, test } from "vitest";

import {
  readLine,
  LINE_END_KEEP_BYTES,
  LINE_KEEP_BYTES,
} from "@collector/adapters/unreal-agent/lines";
import {
  createUnrealAgentSessionReader,
  FIRST_TAIL_BYTES,
  FULL_READ_MIN_INTERVAL_MS,
  HEAD_BYTES,
  type UnrealAgentSessionRead,
} from "@collector/adapters/unreal-agent/sessionFile";
import type { OpenFile, ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  applyUnrealAgentLine,
  startUnrealAgentReplay,
  unrealAgentPhase,
} from "@core/mapping/unreal-agent/unrealAgentReplay";
import {
  headerLine,
  MINUTE,
  NOW,
  PROJECT,
  SECOND,
  SESSION_ID,
  SessionLines,
  sessionPath,
  shellCall,
  shellOperation,
  shellState,
  STARTED_AT,
  uuidOf,
} from "@tests/fixtures/unreal-agent/unrealAgent";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

const MiB = 1024 * 1024;
const FILE = sessionPath();
const FILL = "@@FILL@@";
const AT = STARTED_AT + SECOND;

/** A file's bytes, with each filler mark in it made `size` bytes of text. */
function bytesOf(text: string, size = 0): Buffer {
  const parts = text.split(FILL);
  const filler = Buffer.alloc(size, 0x61);
  const out: Buffer[] = [];
  parts.forEach((part, index) => {
    if (index > 0) out.push(filler);
    out.push(Buffer.from(part));
  });
  return Buffer.concat(out);
}

/** The reader, the files, and a read of the file as a poll would make it. */
function setup(io?: (files: MemoryFiles) => ReadOnlyIo) {
  const files = memoryFiles(() => NOW);
  const reader = createUnrealAgentSessionReader(io ? io(files) : files.io, "darwin");
  const read = async (now = NOW, file = FILE) =>
    reader.read({ path: file, info: await files.io.lstat(file) }, now);
  return { files, reader, read };
}

function okFile(read: UnrealAgentSessionRead) {
  if (read.state !== "ok") throw new Error(`not read: ${read.state}`);
  return read.file;
}

const phaseOf = (read: UnrealAgentSessionRead) => unrealAgentPhase(okFile(read).replay);

const bytesRead = (files: MemoryFiles) => files.reads.reduce((sum, { length }) => sum + length, 0);

/** Whole reads: a read from the first item's start, which only a read of the whole file makes. */
function wholeReads(files: MemoryFiles, text: string) {
  const firstItem = Buffer.byteLength(text.slice(0, text.indexOf("\n") + 1));
  return files.reads.filter(({ position }) => position === firstItem).length;
}

/** A session that waits, with a reply of `FILL` early in it and two small turns after. */
function idleWithFill(): string {
  const lines = new SessionLines();
  lines.settings(AT).message(AT).turn(AT).reply(AT, { text: FILL });
  lines.message(AT).turn(AT).reply(AT);
  return lines.text();
}

describe("what is read", () => {
  test("of a small file, its first 1 KiB and the rest, once, and nothing when it has not changed", async () => {
    const { files, read } = setup();
    const text = idleWithFill().replace(FILL, "short");
    files.write(FILE, text);
    expect(phaseOf(await read())).toEqual({ phase: "waiting", reply: "complete" });
    expect(files.reads[0]).toMatchObject({ position: 0 });
    expect(files.reads[0]?.length).toBeLessThanOrEqual(HEAD_BYTES);
    files.forget();
    await read();
    expect(files.opened()).toEqual([]);
  });

  test("of a 20 MiB file that waits: its first 1 KiB, its last 8 MiB, then the whole file once", async () => {
    const { files, read } = setup();
    const text = idleWithFill();
    files.write(FILE, bytesOf(text, 20 * MiB));
    expect(phaseOf(await read())).toEqual({ phase: "waiting", reply: "complete" });
    const [head, ...rest] = files.reads;
    expect(head).toMatchObject({ position: 0, length: HEAD_BYTES });
    const size = bytesOf(text, 20 * MiB).byteLength;
    // The end first, then the whole file from its first item.
    const firstItem = Buffer.byteLength(text.slice(0, text.indexOf("\n") + 1));
    const whole = rest.findIndex(({ position }) => position === firstItem);
    const tail = rest.slice(0, whole);
    expect(tail[0]?.position).toBe(size - FIRST_TAIL_BYTES);
    expect(tail.reduce((sum, { length }) => sum + length, 0)).toBe(FIRST_TAIL_BYTES);
    expect(rest.slice(whole).reduce((sum, { length }) => sum + length, 0)).toBe(size - firstItem);
    expect(wholeReads(files, text)).toBe(1);
  });

  test("of a 20 MiB file whose command started 9 MiB back and still runs: busy, from the whole file", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT);
    shellCall(lines, AT, 1, { end: false });
    lines.heartbeat(AT).turn(AT).reply(AT, { text: FILL }).heartbeat(AT).turn(AT).reply(AT);
    files.write(FILE, bytesOf(lines.text(), 9 * MiB));
    expect(phaseOf(await read()).phase).toBe("busy");
    expect(wholeReads(files, lines.text())).toBe(1);
  });

  test("of a busy file read from its end, one whole read once a reply and the second status make it wait", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines
      .settings(AT)
      .message(AT)
      .turn(AT)
      .reply(AT, { text: FILL, calls: ["call_1"] });
    const op = uuidOf(5, 1);
    lines.created(AT, "call_1", [shellOperation(op, "ready")]);
    lines.operation(shellOperation(op, "awaiting"));
    files.write(FILE, bytesOf(lines.text(), 20 * MiB));
    expect(phaseOf(await read()).phase).toBe("busy");
    expect(wholeReads(files, lines.text())).toBe(0);
    const before = lines.text().length;
    const done = shellState({ operationId: op, ended: true });
    lines.operation(shellOperation(op, "completed", done));
    lines
      .completed(AT, "call_1", [shellOperation(op, "completed", done)])
      .turn(AT)
      .reply(AT);
    files.append(FILE, lines.text().slice(before), { mtimeMs: NOW + SECOND });
    files.forget();
    expect(phaseOf(await read())).toEqual({ phase: "waiting", reply: "complete" });
    expect(wholeReads(files, lines.text())).toBe(1);
  });

  test("of a 70 MiB file that waits, no more than its first 1 KiB and last 8 MiB: too long to read whole", async () => {
    const { files, read } = setup();
    files.write(FILE, bytesOf(idleWithFill(), 70 * MiB));
    const file = okFile(await read());
    expect(file.tooLong).toBe(true);
    expect(unrealAgentPhase(file.replay).phase).toBe("unsure");
    expect(bytesRead(files)).toBeLessThanOrEqual(FIRST_TAIL_BYTES + HEAD_BYTES);
  });

  test("of a busy 70 MiB file, its end, which decides it", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT).reply(AT, { text: FILL }).message(AT).turn(AT);
    files.write(FILE, bytesOf(lines.text(), 70 * MiB));
    const file = okFile(await read());
    expect(unrealAgentPhase(file.replay).phase).toBe("busy");
    expect(file.tooLong).toBe(false);
    expect(bytesRead(files)).toBeLessThanOrEqual(FIRST_TAIL_BYTES + HEAD_BYTES);
  });

  test("after the first read, only what was added, from the byte before it", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT).reply(AT);
    files.write(FILE, lines.text());
    await read();
    const before = Buffer.byteLength(lines.text());
    lines.message(AT).turn(AT);
    const added = Buffer.byteLength(lines.text()) - before;
    files.append(FILE, lines.text().slice(lines.text().length - added), { mtimeMs: NOW + SECOND });
    files.forget();
    expect(phaseOf(await read()).phase).toBe("busy");
    expect(files.reads).toEqual([
      { path: FILE, position: before - 1, length: 1 },
      { path: FILE, position: before, length: added },
    ]);
  });

  test("a file that grew by more than 64 MiB is read as for the first time", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT).reply(AT);
    files.write(FILE, lines.text());
    await read();
    const before = lines.text().length;
    lines.message(AT).turn(AT).reply(AT, { text: FILL }).message(AT).turn(AT);
    files.append(FILE, bytesOf(lines.text().slice(before), 65 * MiB), { mtimeMs: NOW + SECOND });
    files.forget();
    expect(phaseOf(await read()).phase).toBe("busy");
    expect(files.reads[0]).toMatchObject({ position: 0, length: HEAD_BYTES });
  });

  test("bytes after the last newline are left until the line ends", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT).reply(AT);
    const whole = lines.text();
    lines.message(AT);
    const torn = lines.text().slice(0, -20);
    files.write(FILE, torn);
    expect(phaseOf(await read())).toEqual({ phase: "waiting", reply: "complete" });
    files.rewrite(FILE, lines.text(), { mtimeMs: NOW + SECOND });
    expect(phaseOf(await read()).phase).toBe("busy");
    expect(whole.length).toBeLessThan(torn.length);
  });

  test("a first line that has not ended within 1 KiB is no session yet", async () => {
    const { files, read } = setup();
    files.write(FILE, headerLine().trimEnd());
    expect(await read()).toEqual({ state: "none" });
    files.rewrite(FILE, headerLine(), { mtimeMs: NOW + SECOND });
    expect(phaseOf(await read())).toEqual({ phase: "waiting", reply: null });
  });
});

describe("a file read afresh", () => {
  async function readAndChange(change: (files: MemoryFiles, lines: SessionLines) => void) {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT).reply(AT);
    files.write(FILE, lines.text());
    await read();
    files.forget();
    change(files, lines);
    const after = await read(NOW + SECOND);
    return { files, after };
  }

  // Only the read of the first line starts at the file's start.
  const freshly = (files: MemoryFiles) => files.reads.some(({ position }) => position === 0);

  test("when it shrank", async () => {
    const { files, after } = await readAndChange((f) => {
      const shorter = new SessionLines();
      shorter.settings(AT).message(AT);
      f.rewrite(FILE, shorter.text(), { mtimeMs: NOW + SECOND });
    });
    expect(freshly(files)).toBe(true);
    expect(phaseOf(after).phase).toBe("busy");
  });

  test("when it was rewritten at the same size", async () => {
    const { files, after } = await readAndChange((f, lines) => {
      const text = lines.text();
      const last = text.lastIndexOf('"Sequence":4');
      f.rewrite(FILE, `${text.slice(0, last)}"Sequence":5${text.slice(last + 12)}`, {
        mtimeMs: NOW + SECOND,
      });
    });
    expect(freshly(files)).toBe(true);
    // Read afresh, the gap is a line not read.
    expect(phaseOf(after).phase).toBe("unread");
  });

  test("when it is another file", async () => {
    const { files, after } = await readAndChange((f, lines) => {
      lines.message(AT);
      f.write(FILE, lines.text(), { mtimeMs: NOW + SECOND });
    });
    expect(freshly(files)).toBe(true);
    expect(phaseOf(after).phase).toBe("busy");
  });

  test("when it was rewritten in place and grew, with no newline before the added lines", async () => {
    const { files, after } = await readAndChange((f) => {
      // The same items, the last a longer line, then one more: the next item's number is the one expected.
      const longer = new SessionLines();
      longer
        .settings(AT)
        .message(AT)
        .turn(AT)
        .reply(AT, { responseId: "a-reply-id-longer-than-before" });
      longer.message(AT);
      f.rewrite(FILE, longer.text(), { mtimeMs: NOW + SECOND });
    });
    expect(freshly(files)).toBe(true);
    expect(phaseOf(after).phase).toBe("busy");
  });

  test("when the first item added is not the one after the last read", async () => {
    const { files, after } = await readAndChange((f, lines) => {
      const skipped = new SessionLines(SESSION_ID, STARTED_AT, { header: false, firstSequence: 9 });
      skipped.message(AT);
      f.append(FILE, skipped.text(), { mtimeMs: NOW + SECOND });
      expect(lines.next).toBe(5);
    });
    expect(freshly(files)).toBe(true);
    // Read afresh, the gap is a line not read.
    expect(phaseOf(after).phase).toBe("unread");
  });
});

describe("a read that fails", () => {
  /** The files, with each read after `failFrom` short, or throwing, while `failing` is on. */
  function flaky(mode: "short" | "throw") {
    const state = { failing: false, failFrom: 0 };
    let count = 0;
    const wrap = (files: MemoryFiles): ReadOnlyIo => ({
      ...files.io,
      async openRegular(file) {
        const open = await files.io.openRegular(file);
        const handle: OpenFile = {
          info: open.info,
          close: () => open.close(),
          async read(position, length) {
            count += 1;
            if (state.failing && count > state.failFrom) {
              if (mode === "throw") throw new Error("EIO");
              return (await open.read(position, length)).subarray(0, Math.max(0, length - 1));
            }
            return open.read(position, length);
          },
        };
        return handle;
      },
    });
    return { state, wrap, reset: () => (count = 0) };
  }

  for (const mode of ["short", "throw"] as const) {
    test(`leaves what was known as it was, when a piece comes back ${mode === "short" ? "short" : "with an error"}`, async () => {
      const bad = flaky(mode);
      const { files, read } = setup(bad.wrap);
      const lines = new SessionLines();
      lines.settings(AT).message(AT).turn(AT).reply(AT, { text: FILL });
      files.write(FILE, bytesOf(lines.text(), 3 * MiB));
      const first = okFile(await read());
      expect(unrealAgentPhase(first.replay)).toEqual({ phase: "waiting", reply: "complete" });
      const before = lines.text().length;
      lines.message(AT).turn(AT).reply(AT, { text: FILL }).message(AT);
      files.append(FILE, bytesOf(lines.text().slice(before), 2 * MiB), { mtimeMs: NOW + SECOND });
      bad.reset();
      // The byte before the added lines, then the first piece, come back whole, and the second does not.
      bad.state.failing = true;
      bad.state.failFrom = 2;
      const failed = okFile(await read());
      expect(failed.replay).toBe(first.replay);
      expect(unrealAgentPhase(failed.replay)).toEqual({ phase: "waiting", reply: "complete" });
      bad.state.failing = false;
      expect(phaseOf(await read()).phase).toBe("busy");
    });
  }
});

describe("the whole read's budget", () => {
  test("is once for each read afresh, not within 10 minutes of the last, and due once they pass", async () => {
    const { files, read } = setup();
    const text = idleWithFill();
    files.write(FILE, bytesOf(text, 20 * MiB));
    expect(phaseOf(await read(NOW)).phase).toBe("waiting");
    expect(wholeReads(files, text)).toBe(1);
    // Another file at the name a minute later: read afresh, but no whole read yet.
    files.forget();
    files.write(FILE, bytesOf(text, 20 * MiB), { mtimeMs: NOW + MINUTE });
    expect(phaseOf(await read(NOW + MINUTE)).phase).toBe("unsure");
    expect(wholeReads(files, text)).toBe(0);
    // Not yet due, though the file has not changed.
    files.forget();
    expect(phaseOf(await read(NOW + 5 * MINUTE)).phase).toBe("unsure");
    expect(files.opened()).toEqual([]);
    // Due once the 10 minutes have passed, though the file has not changed.
    expect(phaseOf(await read(NOW + FULL_READ_MIN_INTERVAL_MS)).phase).toBe("waiting");
    expect(wholeReads(files, text)).toBe(1);
  });

  test("a clock set back counts as due", async () => {
    const { files, read } = setup();
    const text = idleWithFill();
    files.write(FILE, bytesOf(text, 20 * MiB));
    await read(NOW);
    files.forget();
    files.write(FILE, bytesOf(text, 20 * MiB), { mtimeMs: NOW + MINUTE });
    expect(phaseOf(await read(NOW - 5 * MINUTE)).phase).toBe("waiting");
    expect(wholeReads(files, text)).toBe(1);
  });
});

describe("lines longer than what is kept", () => {
  /** A small generator of files, with replies of more than 1 MiB that failed or not. */
  function* filesOf(seed: number) {
    let state = seed;
    const next = (n: number) => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state % n;
    };
    for (let file = 0; file < 6; file += 1) {
      const lines = new SessionLines();
      lines.settings(AT).message(AT);
      for (let turn = 0; turn < 4; turn += 1) {
        lines.turn(AT);
        const failure = next(2) === 0 ? { Code: "server_error", Message: "x" } : null;
        lines.reply(AT, {
          text: next(2) === 0 ? FILL : "short",
          stop: failure ? "" : "complete",
          failure,
        });
        if (next(3) === 0) shellCall(lines, AT, turn + 1, { end: next(2) === 0 });
      }
      yield { text: lines.text(), size: (1 + next(3)) * MiB + next(1000) };
    }
  }

  test("are read alike from the end, whole and onward, as a replay of every line says", async () => {
    for (const { text, size } of filesOf(3)) {
      const bytes = bytesOf(text, size);
      const replay = startUnrealAgentReplay(true);
      let start = bytes.indexOf(0x0a) + 1;
      while (start < bytes.byteLength) {
        const end = bytes.indexOf(0x0a, start);
        const line = bytes.subarray(start, end);
        applyUnrealAgentLine(
          replay,
          readLine({
            head: line.subarray(0, LINE_KEEP_BYTES),
            end: line.subarray(Math.max(0, line.byteLength - LINE_END_KEEP_BYTES)),
            cut: line.byteLength > LINE_KEEP_BYTES,
          }),
        );
        start = end + 1;
      }
      const { files, read } = setup();
      files.write(FILE, bytes);
      expect(phaseOf(await read())).toEqual(unrealAgentPhase(replay));
      // Read in two parts.
      const other = setup();
      const cut = bytes.lastIndexOf(0x0a, Math.floor(bytes.byteLength / 2)) + 1;
      other.files.write(FILE, bytes.subarray(0, cut));
      await other.read();
      other.files.append(FILE, bytes.subarray(cut), { mtimeMs: NOW + SECOND });
      expect(phaseOf(await other.read(NOW + SECOND))).toEqual(unrealAgentPhase(replay));
    }
  });
});

describe("what is listed", () => {
  test("not a file whose first line names another session, or is of another format", async () => {
    const { files, read } = setup();
    files.write(FILE, headerLine(uuidOf(1, 2)));
    expect(await read()).toEqual({ state: "broken" });
    files.write(FILE, headerLine(SESSION_ID, STARTED_AT, 3));
    expect(await read()).toEqual({ state: "newer" });
    files.write(FILE, headerLine(SESSION_ID, STARTED_AT, 1));
    expect(await read()).toEqual({ state: "broken" });
  });

  test("keeps the decoded folder of the newest shell command, and no byte of any line", async () => {
    const { files, read } = setup();
    const lines = new SessionLines();
    lines.settings(AT).message(AT).turn(AT);
    shellCall(lines, AT, 1, { directory: "/Users/example/work/first" });
    lines.turn(AT);
    shellCall(lines, AT, 2);
    lines.turn(AT).reply(AT);
    files.write(FILE, lines.text());
    const file = okFile(await read());
    expect(file.folder).toBe(PROJECT);
    expect(file).toMatchObject({ id: SESSION_ID, createdAt: STARTED_AT, tooLong: false });
    const walk = (value: unknown): void => {
      expect(value instanceof Uint8Array).toBe(false);
      if (value instanceof Set) for (const item of value) walk(item);
      else if (typeof value === "object" && value !== null) Object.values(value).forEach(walk);
    };
    walk(file);
    // Added lines with no shell command leave the folder as it was.
    const before = lines.text().length;
    lines.message(AT);
    files.append(FILE, lines.text().slice(before), { mtimeMs: NOW + SECOND });
    expect(okFile(await read(NOW + SECOND)).folder).toBe(PROJECT);
  });

  test("forgets a file no longer listed", async () => {
    const { files, reader, read } = setup();
    files.write(FILE, headerLine());
    await read();
    reader.keepOnly(new Set());
    files.forget();
    await read();
    expect(files.opened()).toEqual([FILE]);
  });
});
