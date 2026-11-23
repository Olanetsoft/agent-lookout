import { expect, test } from "vitest";

import { createLineLog, TAIL_LIMIT_BYTES } from "@collector/adapters/kiro-cli/lineLog";
import { V2_READING, V3_READING } from "@collector/adapters/kiro-cli/rows";
import { mapKiroV3Status } from "@core/mapping/kiro-cli/kiroCliMapping";
import {
  NOW,
  v2Prompt,
  v2Reply,
  v2ToolUse,
  v3Assistant,
  v3Note,
  v3Pending,
  v3Resolved,
  v3TurnEnd,
  v3TurnStart,
  v3User,
} from "@tests/fixtures/kiro-cli/kiroCli";
import { memoryFiles } from "@tests/support/adapters/kiro-cli/kiroCliAdapter";

const FILE = "/Users/example/.kiro/sessions/0a1b2c3d4e5f6a7b/sess_x/messages.jsonl";

function v3Log() {
  const files = memoryFiles(() => NOW);
  const log = createLineLog(files.io, V3_READING);
  const read = async () => log.read(FILE, await files.io.lstat(FILE));
  const status = async () => mapKiroV3Status("open", await read()).status;
  return { files, log, read, status };
}

test("the first read goes back to the newest turn row, so what is before it does not count", async () => {
  const { files, status, read } = v3Log();
  files.write(FILE, `not a row\n${v3User()}${v3TurnStart(NOW - 5_000)}${v3Assistant()}`);
  expect(await status()).toBe("working");
  expect((await read()).turnAt).toBe(NOW - 5_000);
});

test("a line still being written is left for the next read, and taken once its newline is", async () => {
  const { files, status } = v3Log();
  const end = v3TurnEnd();
  files.write(FILE, `${v3TurnStart()}${end.slice(0, -1)}`);
  expect(await status()).toBe("working");
  files.append(FILE, "\n", { mtimeMs: NOW + 1 });
  expect(await status()).toBe("idle");
});

test("later reads take only the lines added, in file order", async () => {
  const { files, status } = v3Log();
  files.write(FILE, `${v3User()}${v3TurnStart()}`);
  expect(await status()).toBe("working");
  const size = (await files.io.lstat(FILE)).size;
  files.forget();
  files.append(FILE, `${v3Pending("call-1")}${v3Note()}`, { mtimeMs: NOW + 1 });
  expect(await status()).toBe("needs-you");
  // One byte before the end last read, to check the newline, and what was added.
  expect(files.reads.map((one) => one.position)).toEqual([size - 1]);
  files.append(FILE, v3Resolved("call-1"), { mtimeMs: NOW + 2 });
  expect(await status()).toBe("working");
  files.append(FILE, v3TurnEnd(), { mtimeMs: NOW + 3 });
  expect(await status()).toBe("idle");
});

test("a log that did not change is not opened again", async () => {
  const { files, status } = v3Log();
  files.write(FILE, v3TurnStart());
  await status();
  files.forget();
  expect(await status()).toBe("working");
  expect(files.opened()).toEqual([]);
});

test("a log that shrank, was replaced or was rewritten in place is read afresh from its end", async () => {
  for (const change of ["shrink", "replace", "rewrite"] as const) {
    const { files, status } = v3Log();
    const before = `${v3TurnStart()}${v3Pending("call-1")}`;
    files.write(FILE, before);
    expect(await status(), change).toBe("needs-you");
    const after = `${v3TurnStart()}${v3TurnEnd()}`;
    if (change === "shrink") files.rewrite(FILE, v3TurnStart(), { mtimeMs: NOW + 1 });
    if (change === "replace") files.write(FILE, after, { mtimeMs: NOW + 1 });
    if (change === "rewrite") {
      // Longer than before, with no newline where the last read ended.
      const longer = `x${after}${v3Pending("call-2")}${v3Note()}`;
      expect(longer.length).toBeGreaterThan(before.length);
      expect(longer[before.length - 1]).not.toBe("\n");
      files.rewrite(FILE, longer, { mtimeMs: NOW + 1 });
    }
    expect(await status(), change).toBe(change === "shrink" ? "working" : "idle");
  }
});

test("a log rewritten in place at the same size is read afresh", async () => {
  const { files, status } = v3Log();
  // A turn's start and its end, made the same length, each ending in a newline.
  const start = `${JSON.stringify({ id: "row-a", timestamp: "2026-10-01T11:50:00.000Z", payload: { type: "turn_start", executionId: "exec-1", note: "xxxxxxxxxxxx" } })}\n`;
  const end = `${JSON.stringify({ id: "row-b", timestamp: "2026-10-01T11:55:00.000Z", payload: { type: "turn_end", executionId: "exec-1", stopReason: "end_turn" } })}\n`;
  expect(start.length).toBe(end.length);
  files.write(FILE, start);
  expect(await status()).toBe("working");
  files.rewrite(FILE, end, { mtimeMs: NOW + 1 });
  expect(await status()).toBe("idle");
});

test("a log with no complete line reads as one with no turn row", async () => {
  const { files, read } = v3Log();
  files.write(FILE, '{"id":"row-1"');
  expect((await read()).lastTurn).toBeNull();
  files.write(FILE, "");
  expect((await read()).lastTurn).toBeNull();
});

test("a newest turn row past the 8 MiB read is not found, so the status is unknown", async () => {
  const { files, status } = v3Log();
  const note = v3Note();
  const notes = note.repeat(Math.ceil(TAIL_LIMIT_BYTES / note.length) + 1);
  files.write(FILE, `${v3TurnStart()}${notes}`);
  expect(await status()).toBe("unknown");
  // A turn row added after it is found by the next read.
  files.append(FILE, v3TurnEnd(), { mtimeMs: NOW + 1 });
  expect(await status()).toBe("idle");
});

test("a log that grew past 8 MiB since its lstat is read afresh from its end, never past the limit at once", async () => {
  const { files, log, read } = v3Log();
  files.write(FILE, v3TurnStart());
  await read();
  files.append(FILE, v3Note(), { mtimeMs: NOW + 1 });
  // The poll's lstat, taken before the log grew past the limit.
  const info = await files.io.lstat(FILE);
  const note = v3Note();
  files.append(
    FILE,
    `${note.repeat(Math.ceil(TAIL_LIMIT_BYTES / note.length) + 1)}${v3TurnEnd()}`,
    {
      mtimeMs: NOW + 2,
    },
  );
  files.forget();
  expect(mapKiroV3Status("open", await log.read(FILE, info)).status).toBe("idle");
  for (const one of files.reads) expect(one.length).toBeLessThanOrEqual(TAIL_LIMIT_BYTES);
});

test("a line split across the pieces read from the end is read whole", async () => {
  const { files, status } = v3Log();
  // A turn row of about a thousand bytes that straddles the 256 KiB piece read first.
  const filler = v3Note();
  const tail = filler.repeat(Math.floor((256 * 1024 - 500) / filler.length));
  const turn = v3TurnStart().replace("exec-1", "e".repeat(900));
  expect(tail.length).toBeLessThan(256 * 1024);
  expect(tail.length + turn.length).toBeGreaterThan(256 * 1024);
  files.write(FILE, `${v3User()}${turn}${tail}`);
  expect(await status()).toBe("working");
});

test("a V2 transcript is read back to its newest prompt, for its time", async () => {
  const files = memoryFiles(() => NOW);
  const log = createLineLog(files.io, V2_READING);
  const file = "/Users/example/.kiro/sessions/cli/one.jsonl";
  files.write(file, `${v2Prompt(NOW - 9_000)}${v2Reply()}${v2Prompt(NOW - 5_000)}${v2ToolUse()}`);
  expect(await log.read(file, await files.io.lstat(file))).toEqual({
    last: "tool-use",
    promptAt: NOW - 5_000,
  });
  files.append(file, v2Reply(), { mtimeMs: NOW + 1 });
  expect(await log.read(file, await files.io.lstat(file))).toEqual({
    last: "reply",
    promptAt: NOW - 5_000,
  });
});

test("keepOnly forgets the logs not named", async () => {
  const { files, log, read } = v3Log();
  files.write(FILE, v3TurnStart());
  await read();
  log.keepOnly(new Set());
  files.forget();
  await read();
  expect(files.opened()).toEqual([FILE]);
});
