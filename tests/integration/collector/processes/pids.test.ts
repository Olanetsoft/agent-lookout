import { spawnSync } from "node:child_process";

import { describe, expect, test } from "vitest";

import { isProcessAlive } from "@collector/processes/pids";

describe("isProcessAlive", () => {
  test("this process is alive", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("a process that has exited is not", () => {
    const finished = spawnSync(process.execPath, ["-e", ""]);
    expect(finished.status).toBe(0);
    expect(isProcessAlive(finished.pid)).toBe(false);
  });

  test("a process that exists but belongs to someone else still counts as alive", () => {
    // pid 1 is the system's first process. Signalling it is refused for an
    // ordinary user, which is different from it not existing.
    expect(isProcessAlive(1)).toBe(true);
  });
});
