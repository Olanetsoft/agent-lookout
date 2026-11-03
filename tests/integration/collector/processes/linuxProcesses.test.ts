import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  BOOT_ID_FILE,
  bootIdOf,
  createPidNamespaceRead,
  createStartTokenReader,
  PID_NAMESPACE_FILE,
  readProcFile,
  statFileOf,
} from "@collector/processes/linuxProcesses";

// Only Linux has /proc as Qwen Code reads it. Each test reads this process's
// own files and the boot id, and no other process's.
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
