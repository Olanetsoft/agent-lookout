import { describe, expect, test } from "vitest";

import {
  createEventsReader,
  HEAD_BYTES,
  PIECE_BYTES,
  READ_CAP,
  type LogRef,
} from "@collector/adapters/copilot-cli/eventsReader";
import {
  eventsPath,
  NOW,
  other,
  permissionRequested,
  request,
  SESSION_ID,
  sessionStart,
  toolStart,
  turnStart,
  userMessage,
} from "@tests/fixtures/copilot-cli/copilotCli";
import {
  memoryFiles,
  type MemoryFiles,
} from "@tests/support/adapters/copilot-cli/copilotCliAdapter";

const T = NOW - 60_000;
const FILE = eventsPath();

async function refOf(files: MemoryFiles, file = FILE): Promise<LogRef> {
  return { path: file, id: SESSION_ID, info: await files.io.lstat(file) };
}

describe("a first read", () => {
  test("folds every whole line of a log up to 8 MiB, and holds a partial last line back", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(
      FILE,
      `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2).slice(0, 20)}`,
    );
    const log = await reader.read(await refOf(files));
    expect(log.current).toBe(true);
    expect(log.fold?.newest).toEqual({ sort: "user", at: T + 1 });
    expect(log.fold?.turn).toEqual({ state: "closed" });

    // The rest of the line comes, and it is read whole.
    files.append(FILE, turnStart("0", T + 2).slice(20));
    const next = await reader.read(await refOf(files));
    expect(next.fold?.turn).toEqual({ state: "open", id: "0", at: T + 2 });
  });

  test("a last line that is whole JSON but has no line break yet is not read until its line break comes", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(FILE, `${sessionStart(T)}${turnStart("0", T + 2).trimEnd()}`);
    expect((await reader.read(await refOf(files))).fold?.turn).toEqual({ state: "closed" });
    files.append(FILE, "\n");
    expect((await reader.read(await refOf(files))).fold?.turn).toEqual({
      state: "open",
      id: "0",
      at: T + 2,
    });
  });

  test("a log longer than 8 MiB is read from its first 64 KiB and its last 8 MiB, with the middle a gap", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    const filler = other("session.info", T);
    const middle = filler.repeat(Math.ceil((READ_CAP + HEAD_BYTES) / filler.length));
    // A request open in the middle is left out, and the tail's own lines are read.
    files.write(
      FILE,
      `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}${permissionRequested("r-1", T + 3)}${middle}${toolStart("c-9", "ask_user", T + 4)}`,
    );
    const log = await reader.read(await refOf(files));
    const fold = log.fold;
    expect(fold?.startedAt).toBe(T);
    expect(fold?.permissions.size).toBe(0);
    expect(fold?.turn).toEqual({ state: "unknown" });
    expect([...(fold?.questions.keys() ?? [])]).toEqual(["c-9"]);
    // At most 8 MiB of the end, the first 64 KiB, and the piece where the end's first line begins were read.
    const read = files.reads.reduce((sum, one) => sum + one.length, 0);
    expect(read).toBeLessThanOrEqual(READ_CAP + HEAD_BYTES + PIECE_BYTES + 1);
  });
});

describe("later reads", () => {
  test("only the lines added are read, and nothing is opened while the file is the same", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(FILE, sessionStart(T));
    await reader.read(await refOf(files));
    const before = files.reads.length;
    files.forget();
    await reader.read(await refOf(files));
    expect(files.opened()).toEqual([]);

    const start = (await files.io.lstat(FILE)).size;
    files.append(FILE, request(T + 10));
    const log = await reader.read(await refOf(files));
    expect(log.fold?.newest).toMatchObject({ sort: "turn-end", tools: false });
    expect(files.reads.every((one) => one.position >= start - 1)).toBe(true);
    expect(before).toBeGreaterThan(0);
  });

  test("a log replaced, shrunk or rewritten in place is read from its start again", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(FILE, `${sessionStart(T)}${userMessage(T + 1)}${turnStart("0", T + 2)}`);
    expect((await reader.read(await refOf(files))).fold?.turn.state).toBe("open");

    // Rotation puts a new file in its place, which starts again from a checkpoint.
    files.write(FILE, sessionStart(T));
    expect((await reader.read(await refOf(files))).fold?.turn.state).toBe("closed");

    // Grown again, then cut back in place: shorter, so read from the start.
    files.append(FILE, `${userMessage(T + 1)}${turnStart("0", T + 2)}`);
    expect((await reader.read(await refOf(files))).fold?.turn.state).toBe("open");
    files.rewrite(FILE, `${sessionStart(T)}${userMessage(T + 1)}`);
    expect((await reader.read(await refOf(files))).fold?.newest?.sort).toBe("user");

    // Rewritten in place to the same length or longer, with no line break where reading went on from.
    const same = `${sessionStart(T)}${userMessage(T + 1)}`;
    files.rewrite(FILE, `${same.slice(0, -1)}x${turnStart("0", T + 2)}`);
    const log = await reader.read(await refOf(files));
    // Read from its start: the line run together cannot be read, and the turn on it is not taken alone.
    expect(log.fold?.unsure).toBe(true);
    expect(log.fold?.turn.state).toBe("closed");
  });

  test("a file that cannot be opened keeps what it showed, and one never read shows nothing", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(FILE, sessionStart(T));
    const ref = await refOf(files);
    files.failOpen(FILE);
    expect(await reader.read(ref)).toEqual({
      fold: null,
      writtenAt: ref.info.mtimeMs,
      current: false,
    });
    files.heal(FILE);
    await reader.read(ref);
    files.append(FILE, userMessage(T + 1));
    files.failOpen(FILE);
    const kept = await reader.read(await refOf(files));
    expect(kept.current).toBe(false);
    expect(kept.fold?.newest?.sort).toBe("start");
    expect(files.openHandles()).toBe(0);
  });

  test("another file than the one lstat found is not read", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(FILE, sessionStart(T));
    const ref = await refOf(files);
    files.write(FILE, `${sessionStart(T)}${userMessage(T + 1)}`);
    expect((await reader.read(ref)).fold).toBeNull();
    expect((await reader.read(await refOf(files))).fold?.newest?.sort).toBe("user");
  });

  test("forgets a log it is told to", async () => {
    const files = memoryFiles();
    const reader = createEventsReader(files.io, "darwin");
    files.write(FILE, sessionStart(T));
    await reader.read(await refOf(files));
    expect(reader.kept).toBe(1);
    reader.keepOnly(new Set());
    expect(reader.kept).toBe(0);
  });
});
