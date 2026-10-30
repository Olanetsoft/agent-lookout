import { describe, expect, test } from "vitest";

import {
  createPidNamespaceReader,
  leaseHolderAlive,
  OWN_PID_NAMESPACE_LINK,
  parsePidNamespace,
  type PidNamespace,
} from "@collector/adapters/hermes-agent/processes";
import { GATEWAY_PID, PID_NAMESPACE } from "@tests/fixtures/hermes-agent/hermesAgent";
import { standInProcesses } from "@tests/support/adapters/hermesAgentAdapter";

const MAC: PidNamespace = { supported: false };
const LINUX: PidNamespace = { supported: true, id: PID_NAMESPACE };
const LINUX_UNREAD: PidNamespace = { supported: true, id: null };

describe("parsePidNamespace", () => {
  test("reads the number in what /proc/self/ns/pid links to", () => {
    expect(OWN_PID_NAMESPACE_LINK).toBe("/proc/self/ns/pid");
    expect(parsePidNamespace("pid:[4026531836]")).toBe(4_026_531_836);
    expect(parsePidNamespace("pid:[1]")).toBe(1);
  });

  test("reads nothing from anything else", () => {
    for (const link of ["", "pid:[]", "pid:4026531836", "pid:[abc]", `pid:[${"9".repeat(16)}]`]) {
      expect(parsePidNamespace(link), link).toBeNull();
    }
  });
});

describe("createPidNamespaceReader", () => {
  /** A stand-in for readlink, which answers in turn, and the links it was asked for. */
  function standInReadLink(...answers: (string | Error)[]) {
    const asked: string[] = [];
    return {
      asked,
      async readLink(target: string) {
        asked.push(target);
        const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer as string;
      },
    };
  }

  test("reads nothing where there are no pid namespaces, as on macOS and Windows", async () => {
    for (const platform of ["darwin", "win32", "freebsd"] as const) {
      const link = standInReadLink("pid:[1]");
      const reader = createPidNamespaceReader({ platform, readLink: link.readLink });
      expect(await reader.read(), platform).toEqual({ supported: false });
      expect(link.asked, platform).toEqual([]);
    }
  });

  test("on Linux, reads its own namespace once and keeps it, since a process never moves to another", async () => {
    const link = standInReadLink("pid:[4026531836]", "pid:[99]");
    const reader = createPidNamespaceReader({ platform: "linux", readLink: link.readLink });
    expect(await reader.read()).toEqual(LINUX);
    expect(await reader.read()).toEqual(LINUX);
    expect(link.asked).toEqual(["/proc/self/ns/pid"]);
  });

  test("on Linux, a read that failed is not kept, and is tried again next time", async () => {
    const link = standInReadLink(new Error("EACCES"), "nonsense", "pid:[4026531836]");
    const reader = createPidNamespaceReader({ platform: "linux", readLink: link.readLink });
    expect(await reader.read()).toEqual(LINUX_UNREAD);
    expect(await reader.read()).toEqual(LINUX_UNREAD);
    expect(await reader.read()).toEqual(LINUX);
    expect(await reader.read()).toEqual(LINUX);
    expect(link.asked).toHaveLength(3);
  });
});

describe("leaseHolderAlive, by Hermes Agent's strict rule for leases", () => {
  test("where there are no pid namespaces, the pid is checked, stamped or not", () => {
    for (const pidns of [null, PID_NAMESPACE, 7]) {
      const processes = standInProcesses([GATEWAY_PID]);
      expect(
        leaseHolderAlive({ pid: GATEWAY_PID, pidns }, MAC, processes.isAlive),
        String(pidns),
      ).toBe(true);
      expect(leaseHolderAlive({ pid: GATEWAY_PID + 1, pidns }, MAC, processes.isAlive)).toBe(false);
      expect(processes.asked).toEqual([GATEWAY_PID, GATEWAY_PID + 1]);
    }
  });

  test("on Linux, the pid is checked when the holder names Agent Lookout's own namespace", () => {
    const processes = standInProcesses([GATEWAY_PID]);
    expect(
      leaseHolderAlive({ pid: GATEWAY_PID, pidns: PID_NAMESPACE }, LINUX, processes.isAlive),
    ).toBe(true);
    expect(
      leaseHolderAlive({ pid: GATEWAY_PID + 1, pidns: PID_NAMESPACE }, LINUX, processes.isAlive),
    ).toBe(false);
    expect(processes.asked).toEqual([GATEWAY_PID, GATEWAY_PID + 1]);
  });

  test("on Linux, a holder in another namespace, one that names none, or any while its own could not be read, trusts the lease's expiry, and no pid is asked about", () => {
    const processes = standInProcesses([GATEWAY_PID]);
    const cases: [{ pid: number; pidns: number | null }, PidNamespace][] = [
      [{ pid: GATEWAY_PID, pidns: PID_NAMESPACE + 1 }, LINUX],
      [{ pid: GATEWAY_PID, pidns: null }, LINUX],
      [{ pid: GATEWAY_PID, pidns: PID_NAMESPACE }, LINUX_UNREAD],
      [{ pid: GATEWAY_PID, pidns: null }, LINUX_UNREAD],
    ];
    for (const [holder, namespace] of cases) {
      expect(
        leaseHolderAlive(holder, namespace, processes.isAlive),
        JSON.stringify(holder),
      ).toBeNull();
    }
    expect(processes.asked).toEqual([]);
  });

  test("a holder that names no process, or one no process could have, is never asked about", () => {
    const processes = standInProcesses([0, -1, 1]);
    for (const pid of [null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        leaseHolderAlive({ pid: pid as number | null, pidns: null }, MAC, processes.isAlive),
        String(pid),
      ).toBeNull();
    }
    expect(processes.asked).toEqual([]);
  });

  test("a check that throws trusts the lease's expiry", () => {
    const throws = () => {
      throw new Error("A check that throws.");
    };
    expect(leaseHolderAlive({ pid: GATEWAY_PID, pidns: null }, MAC, throws)).toBeNull();
  });
});
