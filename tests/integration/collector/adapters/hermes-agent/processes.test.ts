import { spawn } from "node:child_process";
import { readlink } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import {
  createPidNamespaceReader,
  leaseHolderAlive,
  OWN_PID_NAMESPACE_LINK,
  parsePidNamespace,
} from "@collector/adapters/hermes-agent/processes";

// Agent Lookout's own pid namespace is read from the real /proc/self/ns/pid
// on Linux, and nothing is read elsewhere. Whether a lease's process exists is
// asked with the real signal 0, which sends the process nothing, of this
// test's own process and of one it started that has ended. No other process
// is asked after.

/** The pid of a process this test started, which has ended. */
async function endedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  return child.pid as number;
}

// Pid namespaces are Linux's alone, so each test checks what this system has.
const linux = process.platform === "linux";

describe("Agent Lookout's own pid namespace", () => {
  test("is the number /proc/self/ns/pid links to on Linux, and there is none to read elsewhere", async () => {
    const own = await createPidNamespaceReader().read();
    if (!linux) {
      expect(own).toEqual({ supported: false });
      return;
    }
    const link = await readlink(OWN_PID_NAMESPACE_LINK);
    expect(link).toMatch(/^pid:\[\d+\]$/);
    expect(own).toEqual({ supported: true, id: parsePidNamespace(link) });
    expect(typeof (own as { id: number | null }).id).toBe("number");
  });
});

describe("a lease's process", () => {
  test("is checked: alive while it runs, not once it has ended, and one in another namespace is not asked after", async () => {
    const own = await createPidNamespaceReader().read();
    if (!linux) {
      // With no namespace to compare, a lease is checked by its pid alone.
      expect(leaseHolderAlive({ pid: process.pid, pidns: null }, own)).toBe(true);
      expect(leaseHolderAlive({ pid: await endedPid(), pidns: null }, own)).toBe(false);
      return;
    }
    const id = (own as { id: number }).id;
    expect(leaseHolderAlive({ pid: process.pid, pidns: id }, own)).toBe(true);
    expect(leaseHolderAlive({ pid: await endedPid(), pidns: id }, own)).toBe(false);
    expect(leaseHolderAlive({ pid: await endedPid(), pidns: id + 1 }, own)).toBeNull();
    expect(leaseHolderAlive({ pid: await endedPid(), pidns: null }, own)).toBeNull();
  });
});
