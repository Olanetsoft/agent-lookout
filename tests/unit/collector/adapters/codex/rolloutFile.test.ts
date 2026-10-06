import { describe, expect, test } from "vitest";

import type { FileInfo } from "@collector/files/readOnlyIo";
import {
  createRolloutReader,
  HEAD_LIMIT_BYTES,
  parseCodexTime,
  readMetaLine,
  readTurnLine,
  TAIL_LIMIT_BYTES,
} from "@collector/adapters/codex/rolloutFile";
import {
  at,
  CODEX_HOME,
  eventLine,
  ids,
  messageLine,
  metaLine,
  MINUTE,
  NOW,
  rollout,
  rolloutPath,
  turnLine,
} from "@tests/fixtures/codex";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

const FILE = rolloutPath(CODEX_HOME, "2026-10-01T09-00-00", ids.working);
const START = NOW - 60 * MINUTE;

/** What the adapter's own lstat would say of the file right now. */
async function infoOf(files: MemoryFiles, file = FILE): Promise<FileInfo> {
  return files.io.lstat(file);
}

/** Reads the file as one poll would. */
async function readNow(reader: ReturnType<typeof createRolloutReader>, files: MemoryFiles) {
  return reader.read(FILE, await infoOf(files));
}

describe("parseCodexTime", () => {
  test("reads the times Codex writes, in UTC", () => {
    expect(parseCodexTime("2026-10-01T12:00:00.000Z")).toBe(NOW);
    expect(parseCodexTime("2026-10-01T12:00:00Z")).toBe(NOW);
    expect(parseCodexTime("2026-10-01T12:00:00.123456789Z")).toBe(NOW + 123);
  });

  test.each([
    "2026-10-01T12:00:00.000+01:00",
    "2026-10-01T12:00:00.000",
    "2026-10-01 12:00:00Z",
    "2026-10-01",
    "2026-13-45T12:00:00.000Z",
    "yesterday",
    "",
    1_790_000_000_000,
    null,
    undefined,
  ])("%j is not read as a time", (value) => {
    expect(parseCodexTime(value)).toBeNull();
  });
});

describe("readMetaLine", () => {
  test("keeps the id, the start time, the folder, where the session came from and the Codex that made it, and nothing else", () => {
    const meta = readMetaLine(
      metaLine(START, {
        id: ids.working,
        cwd: "/Users/example/code/demo",
        source: { custom: "chatgpt", detail: { nested: true } },
        thread_source: "user",
        parent_thread_id: ids.idle,
      }),
    );
    expect(meta).toEqual({
      id: ids.working,
      timestamp: at(START),
      cwd: "/Users/example/code/demo",
      // Only string values survive in a source object; anything larger becomes `true`.
      source: { custom: "chatgpt", detail: true },
      threadSource: "user",
      parentThreadId: ids.idle,
      originator: "codex_cli_rs",
      cliVersion: "0.160.0",
    });
    // The instructions, tools, git details and account ids are not kept, even by another name.
    const kept = JSON.stringify(meta);
    for (const dropped of [
      "Placeholder instructions",
      "demo_tool",
      "example.com",
      "user-example",
      "account-example",
      "openai",
    ]) {
      expect(kept).not.toContain(dropped);
    }
  });

  test("fields that are missing, empty or of the wrong type are left out", () => {
    expect(
      readMetaLine(
        metaLine(START, {
          id: 7,
          cwd: "",
          source: ["cli"],
          timestamp: null,
          thread_source: {},
          originator: ["Codex Desktop"],
          cli_version: 160,
        }),
      ),
    ).toEqual({});
  });

  test("an originator or version too long to be one is not kept", () => {
    const meta = readMetaLine(
      metaLine(START, { originator: "x".repeat(65), cli_version: `0.160.0-${"y".repeat(60)}` }),
    );
    expect(meta).not.toHaveProperty("originator");
    expect(meta).not.toHaveProperty("cliVersion");
    expect(readMetaLine(metaLine(START, { originator: "Codex Desktop" }))?.originator).toBe(
      "Codex Desktop",
    );
  });

  test.each([
    ["a turn line", turnLine(START, "task_started")],
    ["a message that quotes the word", messageLine(START, 'the "session_meta" line')],
    [
      "a line that uses the word as a key",
      JSON.stringify({ timestamp: at(START), type: "response_item", payload: { session_meta: 1 } }),
    ],
    [
      "a session_meta with no payload",
      JSON.stringify({ timestamp: at(START), type: "session_meta" }),
    ],
    ["a cut-off session_meta", metaLine(START).slice(0, 80)],
    ["not JSON", 'not json "session_meta"'],
  ])("%s is not a session_meta line", (_what, line) => {
    expect(readMetaLine(line)).toBeNull();
  });
});

describe("readTurnLine", () => {
  test("gives a turn line's type and time", () => {
    expect(readTurnLine(turnLine(NOW, "task_started"))).toEqual({
      turn: "task_started",
      at: NOW,
      imported: false,
    });
    expect(readTurnLine(turnLine(NOW, "turn_aborted", { reason: "interrupted" }))).toEqual({
      turn: "turn_aborted",
      at: NOW,
      imported: false,
    });
    // A turn type it does not know is still a turn line: the mapping makes it unknown.
    expect(readTurnLine(turnLine(NOW, "turn_waiting"))?.turn).toBe("turn_waiting");
  });

  test("a turn line with a time that cannot be read has no time", () => {
    const line = JSON.stringify({
      timestamp: "soon",
      type: "event_msg",
      payload: { type: "task_complete" },
    });
    expect(readTurnLine(line)).toEqual({ turn: "task_complete", at: null, imported: false });
  });

  test("says when the turn was imported from another agent, by the turn id Codex gives such turns", () => {
    expect(
      readTurnLine(turnLine(NOW, "task_complete", { turn_id: "external-import-turn-3" })),
    ).toEqual({ turn: "task_complete", at: NOW, imported: true });
    expect(
      readTurnLine(
        turnLine(NOW, "task_started", { turn_id: "019a0000-0000-7000-8000-000000000001" }),
      )?.imported,
    ).toBe(false);
    expect(readTurnLine(turnLine(NOW, "task_started", { turn_id: undefined }))?.imported).toBe(
      false,
    );
  });

  test.each([
    ["another event", eventLine(NOW, "token_count")],
    ["a message that mentions a turn", messageLine(NOW, '{"type":"task_started"} and "event_msg"')],
    [
      "a turn type outside an event",
      JSON.stringify({
        timestamp: at(NOW),
        type: "response_item",
        payload: { type: "task_started" },
      }),
    ],
    ["a cut-off turn line", turnLine(NOW, "task_started").slice(0, -2)],
    ["a session_meta line", metaLine(NOW)],
  ])("%s is not a turn line", (_what, line) => {
    expect(readTurnLine(line)).toBeNull();
  });
});

describe("createRolloutReader", () => {
  test("reads the session_meta line, the last turn line and the time of the last line", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      rollout(
        metaLine(START),
        messageLine(START + 5_000),
        turnLine(START + 5_000, "task_started"),
        turnLine(START + 2 * MINUTE, "task_complete"),
        messageLine(START + 30 * MINUTE),
        turnLine(START + 30 * MINUTE, "task_started"),
        messageLine(START + 31 * MINUTE, "A reply.", "assistant"),
      ),
    );
    const state = await readNow(createRolloutReader(files.io), files);
    expect(state).toEqual({
      meta: {
        id: ids.working,
        timestamp: at(START),
        cwd: "/Users/example/code/demo",
        source: "cli",
        originator: "codex_cli_rs",
        cliVersion: "0.160.0",
      },
      lastTurn: "task_started",
      lastTurnAt: START + 30 * MINUTE,
      lastTurnImported: false,
      lastLineAt: START + 31 * MINUTE,
    });
    expect(files.openHandles()).toBe(0);
  });

  test("the session_meta line may come after other lines, including one that uses its name", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      rollout(
        JSON.stringify({
          timestamp: at(START),
          type: "response_item",
          payload: { session_meta: 1 },
        }),
        messageLine(START, 'about "session_meta"'),
        metaLine(START, { cwd: "/Users/example/code/demo-late" }),
        turnLine(START + 1_000, "task_complete"),
      ),
    );
    const state = await readNow(createRolloutReader(files.io), files);
    expect(state.meta?.cwd).toBe("/Users/example/code/demo-late");
    expect(state.lastTurn).toBe("task_complete");
  });

  test("a file with only its session_meta line has no turn yet", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START)));
    expect(await readNow(createRolloutReader(files.io), files)).toMatchObject({
      lastTurn: null,
      lastTurnAt: null,
      lastLineAt: START,
    });
  });

  test("an empty file has nothing, and a session_meta line still being written is not read", async () => {
    const files = memoryFiles();
    files.write(FILE, "");
    const reader = createRolloutReader(files.io);
    expect(await readNow(reader, files)).toEqual({
      meta: null,
      lastTurn: null,
      lastTurnAt: null,
      lastTurnImported: false,
      lastLineAt: null,
    });

    const meta = metaLine(START);
    files.write(FILE, meta.slice(0, 200));
    expect((await readNow(reader, files)).meta).toBeNull();

    // Once its line is ended it is read.
    files.append(FILE, `${meta.slice(200)}\n`);
    expect((await readNow(reader, files)).meta?.id).toBe(ids.working);
  });

  test("malformed lines are skipped, and a cut-off turn line does not count", async () => {
    const files = memoryFiles();
    const cut = turnLine(START + 20 * MINUTE, "task_started").slice(0, -2);
    files.write(
      FILE,
      rollout(
        "this line is not JSON",
        metaLine(START),
        "{",
        turnLine(START + MINUTE, "task_started"),
        turnLine(START + 10 * MINUTE, "task_complete"),
        "[1, 2",
        cut,
      ),
    );
    const state = await readNow(createRolloutReader(files.io), files);
    expect(state.meta?.id).toBe(ids.working);
    expect(state.lastTurn).toBe("task_complete");
    expect(state.lastTurnAt).toBe(START + 10 * MINUTE);
  });

  test("a session_meta line between 256 KiB and 2 MiB long is found", async () => {
    const files = memoryFiles();
    const big = metaLine(START, { base_instructions: { text: "x".repeat(1024 * 1024) } });
    files.write(FILE, rollout(big, turnLine(START + 1_000, "task_complete")));
    const state = await readNow(createRolloutReader(files.io), files);
    expect(state.meta?.id).toBe(ids.working);
    expect(state.meta).not.toHaveProperty("base_instructions");
    expect(state.lastTurn).toBe("task_complete");
  });

  test("a session_meta line longer than 2 MiB is given up on, after reading no more than 2 MiB of the head", async () => {
    const files = memoryFiles();
    const huge = metaLine(START, { base_instructions: { text: "x".repeat(HEAD_LIMIT_BYTES) } });
    files.write(FILE, rollout(huge, turnLine(START + 1_000, "task_complete")));
    const state = await readNow(createRolloutReader(files.io), files);
    expect(state.meta).toBeNull();
    const headReads = files.reads.filter((read) => read.position === 0);
    expect(Math.max(...headReads.map((read) => read.length))).toBe(HEAD_LIMIT_BYTES);
  });

  test("a turn line further than 8 MiB from the end is not looked for, and the turn is not known", async () => {
    const files = memoryFiles();
    const filler = messageLine(START + 2 * MINUTE, "y".repeat(64 * 1024));
    const lines = [metaLine(START), turnLine(START + MINUTE, "task_complete")];
    let size = lines.join("\n").length;
    while (size < TAIL_LIMIT_BYTES + 64 * 1024) {
      lines.push(filler);
      size += filler.length + 1;
    }
    files.write(FILE, rollout(...lines));
    const state = await readNow(createRolloutReader(files.io), files);

    expect(state.meta?.id).toBe(ids.working);
    expect(state.lastTurn).toBeUndefined();
    expect(state.lastTurnAt).toBeNull();
    expect(state.lastLineAt).toBe(START + 2 * MINUTE);
    const tailRead = files.reads.filter((read) => read.position > 0);
    expect(tailRead.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("a turn line just inside 8 MiB of the end is found", async () => {
    const files = memoryFiles();
    const filler = messageLine(START + 2 * MINUTE, "y".repeat(64 * 1024));
    const lines = [metaLine(START), turnLine(START + MINUTE, "task_complete")];
    let size = 0;
    while (size + filler.length + 1 < TAIL_LIMIT_BYTES - 64 * 1024) {
      lines.push(filler);
      size += filler.length + 1;
    }
    files.write(FILE, rollout(...lines));
    expect((await readNow(createRolloutReader(files.io), files)).lastTurn).toBe("task_complete");
  });

  test("on later reads only the lines added since are read, and a turn that ends moves the state on", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START), turnLine(START + MINUTE, "task_started")));
    const reader = createRolloutReader(files.io);
    expect((await readNow(reader, files)).lastTurn).toBe("task_started");
    const sizeBefore = (await infoOf(files)).size;
    files.forget();

    files.append(
      FILE,
      rollout(messageLine(START + 2 * MINUTE), turnLine(START + 3 * MINUTE, "task_complete")),
    );
    const state = await readNow(reader, files);
    expect(state).toMatchObject({
      lastTurn: "task_complete",
      lastTurnAt: START + 3 * MINUTE,
      lastLineAt: START + 3 * MINUTE,
    });
    expect(state.meta?.id).toBe(ids.working);
    // One read, starting at the newline before the new lines.
    expect(files.reads).toEqual([
      { path: FILE, position: sizeBefore - 1, length: (await infoOf(files)).size - sizeBefore + 1 },
    ]);
  });

  test("nothing is opened when the file has not changed", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START), turnLine(START + MINUTE, "task_started")));
    const reader = createRolloutReader(files.io);
    const first = await readNow(reader, files);
    files.forget();
    expect(await readNow(reader, files)).toEqual(first);
    expect(files.opened()).toEqual([]);
  });

  test("a line still being written is left until it is finished", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START), turnLine(START + MINUTE, "task_started")));
    const reader = createRolloutReader(files.io);
    await readNow(reader, files);

    const done = turnLine(START + 5 * MINUTE, "task_complete");
    files.append(FILE, done.slice(0, 40));
    expect((await readNow(reader, files)).lastTurn).toBe("task_started");

    files.forget();
    files.append(FILE, `${done.slice(40)}\n`);
    expect(await readNow(reader, files)).toMatchObject({
      lastTurn: "task_complete",
      lastTurnAt: START + 5 * MINUTE,
    });
    // The finished line is read from where it began, not by reading the file again.
    expect(files.reads.some((read) => read.position === 0)).toBe(false);
  });

  test("an imported session is known by its last turn, until Codex runs a turn of its own in it", async () => {
    const files = memoryFiles();
    const imported = (n: number) => ({ turn_id: `external-import-turn-${n}` });
    files.write(
      FILE,
      rollout(
        metaLine(START, { originator: "Codex Desktop", source: "vscode" }),
        turnLine(START, "task_started", imported(1)),
        messageLine(START),
        turnLine(START, "task_complete", imported(1)),
        turnLine(START, "task_started", imported(2)),
        messageLine(START),
        eventLine(START, "agent_message"),
        eventLine(START, "token_count"),
        turnLine(START, "task_complete", imported(2)),
      ),
    );
    const reader = createRolloutReader(files.io);
    expect(await readNow(reader, files)).toMatchObject({
      lastTurn: "task_complete",
      lastTurnImported: true,
    });

    files.forget();
    files.append(FILE, rollout(turnLine(START + MINUTE, "task_started")));
    expect(await readNow(reader, files)).toMatchObject({
      lastTurn: "task_started",
      lastTurnAt: START + MINUTE,
      lastTurnImported: false,
    });
    // Read onward from where the last read stopped.
    expect(files.reads.some((read) => read.position === 0)).toBe(false);
  });

  test("a partial last line on the first read is left too, then read once it is finished", async () => {
    const files = memoryFiles();
    const done = turnLine(START + 5 * MINUTE, "task_complete");
    files.write(
      FILE,
      `${rollout(metaLine(START), turnLine(START + MINUTE, "task_started"))}${done.slice(0, 40)}`,
    );
    const reader = createRolloutReader(files.io);
    expect((await readNow(reader, files)).lastTurn).toBe("task_started");

    files.append(FILE, `${done.slice(40)}\n`);
    expect((await readNow(reader, files)).lastTurn).toBe("task_complete");
  });

  // The old and new folder names are the same length, so a new file that starts
  // with the new name is byte for byte as long as the old one up to its end.
  const before = rollout(
    metaLine(START, { cwd: "/Users/example/code/demo-old" }),
    turnLine(START + MINUTE, "task_started"),
  );
  const sameStart = rollout(
    metaLine(START, { cwd: "/Users/example/code/demo-new" }),
    turnLine(START + MINUTE, "task_started"),
  );

  // Each case changes one thing only, so each check in the reader is needed by one case.
  test.each([
    [
      "shrank",
      (files: MemoryFiles) =>
        files.rewrite(FILE, rollout(metaLine(START, { cwd: "/Users/example/code/demo-new" })), {
          mtimeMs: NOW,
        }),
    ],
    [
      "was rewritten in place to the same size, with a new time",
      (files: MemoryFiles) => files.rewrite(FILE, sameStart, { mtimeMs: NOW + 1 }),
    ],
    [
      "was replaced by another file whose lines carry on from the same place",
      (files: MemoryFiles) =>
        files.write(FILE, `${sameStart}${rollout(turnLine(START + 2 * MINUTE, "task_complete"))}`, {
          mtimeMs: NOW,
        }),
    ],
    [
      "grew, but not by adding lines after the old ones",
      (files: MemoryFiles) =>
        files.rewrite(
          FILE,
          `${sameStart.slice(0, -1)}x\n${rollout(turnLine(START + 3 * MINUTE, "task_complete"))}`,
          { mtimeMs: NOW },
        ),
    ],
  ])("a file that %s is read again from the start", async (_what, change) => {
    expect(sameStart).toHaveLength(before.length);
    const files = memoryFiles();
    files.write(FILE, before, { mtimeMs: NOW });
    const reader = createRolloutReader(files.io);
    expect((await readNow(reader, files)).meta?.cwd).toBe("/Users/example/code/demo-old");
    files.forget();

    change(files);
    const state = await readNow(reader, files);
    expect(state.meta?.cwd).toBe("/Users/example/code/demo-new");
    expect(files.reads.some((read) => read.position === 0)).toBe(true);
  });

  test("more than 8 MiB added at once is read afresh, within the limits", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START), turnLine(START + MINUTE, "task_started")));
    const reader = createRolloutReader(files.io);
    await readNow(reader, files);

    const filler = messageLine(START + 2 * MINUTE, "z".repeat(64 * 1024));
    const added = [turnLine(START + 2 * MINUTE, "task_complete")];
    for (let size = 0; size < TAIL_LIMIT_BYTES + 64 * 1024; size += filler.length + 1)
      added.push(filler);
    files.append(FILE, rollout(...added));
    files.forget();

    const state = await readNow(reader, files);
    expect(state.meta?.id).toBe(ids.working);
    // The turn line is now beyond the tail limit, so it is not known.
    expect(state.lastTurn).toBeUndefined();
    expect(files.reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThanOrEqual(
      HEAD_LIMIT_BYTES + TAIL_LIMIT_BYTES,
    );
  });

  test("keepOnly forgets the other files, so they are read from the start next time", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START), turnLine(START + MINUTE, "task_started")));
    const reader = createRolloutReader(files.io);
    await readNow(reader, files);

    reader.keepOnly(new Set([FILE]));
    files.forget();
    await readNow(reader, files);
    expect(files.opened()).toEqual([]);

    reader.keepOnly(new Set());
    await readNow(reader, files);
    expect(files.opened()).toEqual([FILE]);
    expect(files.reads.some((read) => read.position === 0)).toBe(true);
  });

  test("a file that cannot be opened throws, and is closed again whatever happens", async () => {
    const files = memoryFiles();
    files.write(FILE, rollout(metaLine(START)));
    const reader = createRolloutReader(files.io);
    const info = await infoOf(files);
    files.fail(FILE, "EACCES");
    await expect(reader.read(FILE, info)).rejects.toMatchObject({ code: "EACCES" });

    files.heal(FILE);
    files.special(FILE);
    await expect(reader.read(FILE, info)).rejects.toThrow();
    expect(files.openHandles()).toBe(0);
  });

  test("message text is never kept", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      rollout(
        metaLine(START),
        messageLine(START + 1_000, "a private prompt"),
        turnLine(START + 1_000, "task_started"),
        messageLine(START + 2_000, "a private reply", "assistant"),
      ),
    );
    const state = await readNow(createRolloutReader(files.io), files);
    expect(JSON.stringify(state)).not.toContain("private");
  });
});
