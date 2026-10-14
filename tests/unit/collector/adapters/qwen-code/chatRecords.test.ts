import { describe, expect, test } from "vitest";

import {
  createChatReader,
  LINE_LIMIT_BYTES,
  oversizedRecordOf,
  parseQwenTime,
  recordOf,
  TAIL_LIMIT_BYTES,
} from "@collector/adapters/qwen-code/chatRecords";
import { mapQwenCodeStatus } from "@core/mapping/qwen-code/qwenCodeMapping";
import {
  assistantLine,
  at,
  chatFile,
  chatPath,
  compressionLine,
  lifecycleLine,
  apiResponseLine,
  NOW,
  PRIVATE_WORDS,
  promptLine,
  QWEN_DIR,
  sessionIdOf,
  snapshotLine,
  systemLine,
  titleLine,
  toolResultLine,
  userLine,
} from "@tests/fixtures/qwen-code/qwenCode";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/qwenCodeAdapter";

const FILE = chatPath(QWEN_DIR, sessionIdOf(1));
const MIB = 1024 * 1024;

const lineOf = (text: string) => text.replace(/\n$/, "");

async function readNow(files: MemoryFiles, reader = createChatReader(files.io)) {
  return reader.read(FILE, await files.io.lstat(FILE));
}

describe("parseQwenTime", () => {
  test("reads the times Qwen Code writes, and nothing else", () => {
    expect(parseQwenTime(at(NOW))).toBe(NOW);
    expect(parseQwenTime("2026-10-01T12:00:00Z")).toBe(NOW);
    for (const value of ["2026-10-01 12:00:00", "2026-10-01T12:00:00+01:00", "", NOW, null]) {
      expect(parseQwenTime(value)).toBeNull();
    }
  });
});

describe("recordOf", () => {
  test("keeps of each line its type, subtype, time and the few marks the status needs", () => {
    expect(recordOf(lineOf(promptLine(NOW)))).toEqual({ type: "user", at: NOW });
    expect(recordOf(lineOf(userLine(NOW, "notification", { deliveredTurn: true })))).toEqual({
      type: "user",
      subtype: "notification",
      at: NOW,
      deliveredTurn: true,
    });
    expect(recordOf(lineOf(userLine(NOW, "notification")))).toEqual({
      type: "user",
      subtype: "notification",
      at: NOW,
    });
    expect(recordOf(lineOf(assistantLine(NOW, { calls: 2 })))).toEqual({
      type: "assistant",
      at: NOW,
      message: true,
      calls: true,
    });
    expect(recordOf(lineOf(assistantLine(NOW)))).toEqual({
      type: "assistant",
      at: NOW,
      message: true,
    });
    expect(recordOf(lineOf(assistantLine(NOW, { noMessage: true })))).toEqual({
      type: "assistant",
      at: NOW,
    });
    expect(recordOf(lineOf(toolResultLine(NOW, "cancelled")))).toEqual({
      type: "tool_result",
      at: NOW,
      cancelled: true,
    });
    expect(recordOf(lineOf(toolResultLine(NOW, "error")))).toEqual({
      type: "tool_result",
      at: NOW,
    });
    expect(recordOf(lineOf(lifecycleLine(NOW, "ended", { outcome: "cancelled" })))).toEqual({
      type: "system",
      subtype: "ui_telemetry",
      at: NOW,
      lifecycle: { phase: "ended", outcome: "cancelled", subagent: false },
    });
    expect(recordOf(lineOf(lifecycleLine(NOW, "started", { subagentId: "explore-7f3c" })))).toEqual(
      {
        type: "system",
        subtype: "ui_telemetry",
        at: NOW,
        lifecycle: { phase: "started", subagent: true },
      },
    );
    expect(recordOf(lineOf(apiResponseLine(NOW)))).toEqual({
      type: "system",
      subtype: "ui_telemetry",
      at: NOW,
    });
    expect(recordOf(lineOf(titleLine(NOW, "  Fix the flaky test\u0007 ")))).toEqual({
      type: "system",
      subtype: "custom_title",
      at: NOW,
      title: "Fix the flaky test",
    });
    expect(
      recordOf(
        lineOf(systemLine(NOW, "session_execution_engine", { version: 1, engine: "managed" })),
      ),
    ).toEqual({
      type: "system",
      subtype: "session_execution_engine",
      at: NOW,
      managed: true,
    });
  });

  test("keeps no prompt, reply, thought, tool input or output, folder or branch", () => {
    const lines = [
      promptLine(NOW),
      userLine(NOW, "mid_turn_user_message"),
      userLine(NOW, "cron"),
      assistantLine(NOW, { calls: 1 }),
      toolResultLine(NOW),
      apiResponseLine(NOW),
      compressionLine(NOW, 1_000),
      snapshotLine(NOW),
      systemLine(NOW, "slash_command", { promptText: PRIVATE_WORDS, resultText: PRIVATE_WORDS }),
    ];
    for (const line of lines) {
      const kept = JSON.stringify(recordOf(lineOf(line)));
      expect(kept).not.toContain("placeholder");
      expect(kept).not.toContain("demo-project");
      expect(kept).not.toContain("main");
      expect(kept).not.toContain("demo-model");
    }
  });

  test("skips a line a subagent wrote, a line that is not a record and one with no type", () => {
    const sidechain = JSON.parse(lineOf(promptLine(NOW))) as Record<string, unknown>;
    expect(recordOf(JSON.stringify({ ...sidechain, isSidechain: true }))).toBeNull();
    expect(recordOf('{"type":"user","timestamp":"2026-10-01T12:00:00.000Z"')).toBeNull();
    expect(recordOf("[1,2]")).toBeNull();
    expect(recordOf('{"timestamp":"2026-10-01T12:00:00.000Z"}')).toBeNull();
    expect(recordOf('{"type":"Not A Type"}')).toBeNull();
  });

  test("a subtype it cannot read is still a subtype, so the line is no prompt", () => {
    const line = JSON.parse(lineOf(promptLine(NOW))) as Record<string, unknown>;
    expect(recordOf(JSON.stringify({ ...line, subtype: "Not-One" }))).toEqual({
      type: "user",
      subtype: "unreadable",
      at: NOW,
    });
  });
});

describe("oversizedRecordOf", () => {
  test("reads a long line's type, subtype and time from its start", () => {
    expect(oversizedRecordOf(compressionLine(NOW, 70_000).slice(0, 64 * 1024))).toEqual({
      type: "system",
      subtype: "chat_compression",
      at: NOW,
      oversized: true,
    });
    expect(oversizedRecordOf(assistantLine(NOW, { calls: 1 }))).toEqual({
      type: "assistant",
      at: NOW,
      oversized: true,
    });
  });

  test("looks for the subtype only before the payload, so text inside it is never taken for one", () => {
    const line = JSON.parse(lineOf(promptLine(NOW))) as Record<string, unknown>;
    const tricky = JSON.stringify({
      ...line,
      message: { role: "user", parts: [{ text: '","subtype":"cron","x":"' }] },
    });
    expect(oversizedRecordOf(tricky)).toEqual({ type: "user", at: NOW, oversized: true });
  });

  test("a start it cannot read is a line of no type it knows", () => {
    expect(oversizedRecordOf('{"note":"x"')).toEqual({
      type: "unreadable",
      at: null,
      oversized: true,
    });
  });
});

describe("createChatReader", () => {
  test("folds the whole of a small file and knows when it began", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      chatFile(
        promptLine(NOW - 60_000),
        assistantLine(NOW - 30_000),
        titleLine(NOW - 29_000, "Fix the flaky test"),
      ),
    );
    const state = await readNow(files);
    expect(state.firstAt).toBe(NOW - 60_000);
    expect(state.fold).toMatchObject({ whole: true, event: "reply", title: "Fix the flaky test" });
    expect(JSON.stringify(state)).not.toContain("placeholder");
    expect(files.openHandles()).toBe(0);
  });

  test("reads only what was appended, and nothing when nothing changed", async () => {
    const files = memoryFiles();
    const first = chatFile(promptLine(NOW - 60_000), lifecycleLine(NOW - 59_000, "started"));
    files.write(FILE, first);
    const reader = createChatReader(files.io);
    await readNow(files, reader);

    files.forget();
    expect((await readNow(files, reader)).fold.event).toBe("request");
    expect(files.opened()).toEqual([]);

    files.append(FILE, assistantLine(NOW - 30_000), { mtimeMs: NOW + 1 });
    files.forget();
    const state = await readNow(files, reader);
    expect(state.fold.event).toBe("reply");
    expect(state.firstAt).toBe(NOW - 60_000);
    // From the newline before the new line, to the end.
    expect(files.reads).toEqual([
      { path: FILE, position: first.length - 1, length: assistantLine(NOW - 30_000).length + 1 },
    ]);
  });

  test("holds a line until its newline is there", async () => {
    const files = memoryFiles();
    files.write(FILE, chatFile(promptLine(NOW - 60_000)));
    const reader = createChatReader(files.io);
    await readNow(files, reader);

    const reply = assistantLine(NOW - 30_000);
    files.append(FILE, reply.slice(0, 40), { mtimeMs: NOW + 1 });
    expect((await readNow(files, reader)).fold.event).toBe("prompt");
    files.append(FILE, reply.slice(40), { mtimeMs: NOW + 2 });
    expect((await readNow(files, reader)).fold.event).toBe("reply");
  });

  test("reads a file that shrank, or was replaced, again from its end", async () => {
    const files = memoryFiles();
    files.write(FILE, chatFile(promptLine(NOW - 60_000), assistantLine(NOW - 30_000)));
    const reader = createChatReader(files.io);
    expect((await readNow(files, reader)).fold.event).toBe("reply");

    // Cut back to its prompt, as a lease that trims a torn end would.
    files.rewrite(FILE, chatFile(promptLine(NOW - 60_000)), { mtimeMs: NOW + 1 });
    expect((await readNow(files, reader)).fold.event).toBe("prompt");

    // A new file under the same name.
    files.write(
      FILE,
      chatFile(promptLine(NOW - 10_000), assistantLine(NOW - 5_000, { calls: 1 })),
      {
        mtimeMs: NOW + 2,
      },
    );
    const state = await readNow(files, reader);
    expect(state.fold.event).toBe("calls");
    expect(state.firstAt).toBe(NOW - 10_000);
  });

  test("a file written over in place, of a size it grew to, is read again from its end", async () => {
    const files = memoryFiles();
    const first = chatFile(promptLine(NOW - 60_000));
    files.write(FILE, first);
    const reader = createChatReader(files.io);
    await readNow(files, reader);
    // The byte before where the last read ended is no longer a line's end.
    files.rewrite(FILE, `${"x".repeat(first.length + 5)}\n${assistantLine(NOW - 30_000)}`, {
      mtimeMs: NOW + 1,
    });
    const state = await readNow(files, reader);
    expect(state.fold.event).toBe("reply");
  });

  test("reads at most the last 8 MiB of a large file, and drops the line it cut into", async () => {
    const files = memoryFiles();
    const filler = compressionLine(NOW - 50_000, MIB);
    const lines = [
      promptLine(NOW - 60_000),
      ...Array.from({ length: 9 }, () => filler),
      assistantLine(NOW - 30_000),
    ];
    files.write(FILE, chatFile(...lines));
    const state = await readNow(files);
    const size = chatFile(...lines).length;
    expect(files.reads).toEqual([
      { path: FILE, position: size - TAIL_LIMIT_BYTES, length: TAIL_LIMIT_BYTES },
    ]);
    // The prompt is out of reach, so when the session began is not known from the file.
    expect(state.firstAt).toBeNull();
    expect(state.fold).toMatchObject({ whole: false, event: "reply" });
  });

  test("more than 8 MiB appended at once is read from the end, and when the file began is kept", async () => {
    const files = memoryFiles();
    files.write(FILE, chatFile(promptLine(NOW - 60_000)));
    const reader = createChatReader(files.io);
    await readNow(files, reader);
    const filler = compressionLine(NOW - 50_000, MIB);
    files.append(
      FILE,
      chatFile(...Array.from({ length: 9 }, () => filler), toolResultLine(NOW - 20_000)),
      {
        mtimeMs: NOW + 1,
      },
    );
    const state = await readNow(files, reader);
    expect(state.firstAt).toBe(NOW - 60_000);
    expect(state.fold).toMatchObject({ whole: false, event: "results" });
    expect(Math.max(...files.reads.map((range) => range.length))).toBeLessThanOrEqual(
      TAIL_LIMIT_BYTES,
    );
  });

  test("a line over 4 MiB is not parsed: its start says its type", async () => {
    const files = memoryFiles();
    const big = compressionLine(NOW - 20_000, LINE_LIMIT_BYTES + 10);
    files.write(FILE, chatFile(promptLine(NOW - 60_000), assistantLine(NOW - 30_000), big));
    // A compression says nothing of the status.
    const state = await readNow(files);
    expect(state.fold).toMatchObject({ event: "reply", eventAt: NOW - 30_000 });
    expect(mapQwenCodeStatus(state.fold, NOW - 90_000).status).toBe("idle");

    // A reply too long to read whole cannot say whether it calls a tool.
    const huge = JSON.parse(lineOf(assistantLine(NOW - 10_000))) as Record<string, unknown>;
    const padded = `${JSON.stringify({ ...huge, message: { role: "model", parts: [{ text: "x".repeat(LINE_LIMIT_BYTES) }] } })}\n`;
    files.append(FILE, padded, { mtimeMs: NOW + 1 });
    const reader = createChatReader(files.io);
    const after = await reader.read(FILE, await files.io.lstat(FILE));
    expect(mapQwenCodeStatus(after.fold, NOW - 90_000)).toEqual({ status: "unknown", since: null });
  });

  test("skips lines that are not records", async () => {
    const files = memoryFiles();
    files.write(
      FILE,
      chatFile(promptLine(NOW - 60_000), "{not json\n", "\n", "   \n", assistantLine(NOW - 30_000)),
    );
    expect((await readNow(files)).fold.event).toBe("reply");
  });

  test("keeps what it knew of a file it cannot read this time, and throws only when it knew nothing", async () => {
    const files = memoryFiles();
    files.write(FILE, chatFile(promptLine(NOW - 60_000)));
    const reader = createChatReader(files.io);
    const info = await files.io.lstat(FILE);
    files.fail(FILE);
    await expect(reader.read(FILE, info)).rejects.toThrow();
    files.heal(FILE);
    await reader.read(FILE, info);

    files.append(FILE, assistantLine(NOW - 30_000), { mtimeMs: NOW + 1 });
    const grown = await files.io.lstat(FILE);
    files.fail(FILE);
    expect((await reader.read(FILE, grown)).fold.event).toBe("prompt");
    files.heal(FILE);
    expect((await reader.read(FILE, grown)).fold.event).toBe("reply");
    expect(files.openHandles()).toBe(0);
  });

  test("forgets the files it is told to", async () => {
    const files = memoryFiles();
    files.write(FILE, chatFile(promptLine(NOW - 60_000)));
    const reader = createChatReader(files.io);
    await readNow(files, reader);
    reader.keepOnly(new Set());
    files.forget();
    await readNow(files, reader);
    expect(files.opened()).toEqual([FILE]);
  });
});
