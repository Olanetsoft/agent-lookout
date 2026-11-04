import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BOOT_ID_FILE,
  bootIdOf,
  createPidNamespaceRead,
  createStartTokenReader,
  MAX_PROC_FILE_BYTES,
  PID_NAMESPACE_FILE,
  readProcFile,
  statFileOf,
} from "@collector/processes/linuxProcesses";
import { tempDir } from "@tests/support/node/tempFiles";

// Only Linux has /proc as Qwen Code reads it. Between them the tests read this
// process's own files, the boot id and the stat of a child that has exited, and
// no other process's.
describe.skipIf(process.platform !== "linux")("against the real /proc", () => {
  test("this process's token is the boot id and a start, and is the same twice", async () => {
    const read = createStartTokenReader();
    const first = await read([process.pid]);
    const second = await read([process.pid]);

    const bootId = bootIdOf(readFileSync(BOOT_ID_FILE, "utf8"));
    expect(bootId).not.toBeNull();
    expect(first.get(process.pid)).toMatch(new RegExp(`^${bootId}:\\d+$`));
    expect(second.get(process.pid)).toBe(first.get(process.pid));
  });

  test("a process that has exited has no token", async () => {
    const finished = spawnSync(process.execPath, ["-e", ""]);
    expect(finished.status).toBe(0);
    expect((await createStartTokenReader()([finished.pid])).has(finished.pid)).toBe(false);
  });

  test("reads a whole stat line, which ends in a newline", async () => {
    const line = await readProcFile(statFileOf(process.pid));
    expect(line.startsWith(`${process.pid} (`)).toBe(true);
    expect(line.endsWith("\n")).toBe(true);
  });

  test("this process's pid namespace is the inode Qwen Code reads for its own", async () => {
    expect(await createPidNamespaceRead()()).toBe(statSync(PID_NAMESPACE_FILE).ino);
  });
});

// A plain file reader, so this runs on every system, in files of the test's own.
describe("readProcFile", () => {
  test("gives a short file whole, and no more than 4 KiB of a long one", async () => {
    expect(MAX_PROC_FILE_BYTES).toBe(4096);
    const folder = await tempDir();
    const short = path.join(folder, "short");
    const long = path.join(folder, "long");
    await writeFile(short, "abc\n");
    await writeFile(long, "x".repeat(3 * MAX_PROC_FILE_BYTES));

    expect(await readProcFile(short)).toBe("abc\n");
    expect(await readProcFile(long)).toHaveLength(MAX_PROC_FILE_BYTES);
  });
});
