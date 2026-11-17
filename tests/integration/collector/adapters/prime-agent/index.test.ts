import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import { createHolderCheck } from "@collector/adapters/prime-agent/holders";
import {
  createPrimeAgentAdapter,
  PRIME_AGENT_HOME_ENV,
  type PrimeAgentAdapterOptions,
} from "@collector/adapters/prime-agent/index";
import type { Lease } from "@collector/adapters/prime-agent/leases";
import { createCollector } from "@collector/collector";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import { readProcFile, startTicksOf, statFileOf } from "@collector/processes/linuxProcesses";
import { isProcessAlive } from "@collector/processes/pids";
import { processStartTime } from "@collector/processes/processStart";
import { runPs } from "@collector/processes/ps";
import {
  checkpoint,
  conversationLines,
  HASH,
  headerFields,
  iso,
  LEASE_TOKEN,
  leaseNameOf,
  line,
  lstartOf,
  nameLine,
  ownerText,
  PID,
  PRIVATE_WORDS,
  PROC_START_ID,
  PROJECT,
  SESSION_ID,
  START_TICKS,
  statLine,
  WORKER_ID,
  WORKER_SECRET,
  workerRecordText,
} from "@tests/fixtures/prime-agent/primeAgent";
import { NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Prime
// Agent v0.10.3 lays them out, and through the collector. The lease's process
// is a stand-in, so a status does not depend on what runs on the machine under
// test, but the files, their links and, below, `ps` and `/proc` are real.

/** Times a minute before now, since a real file is listed by when it was written. */
const AGO = Date.now() - 60_000;

interface Layout {
  /** The journal's lines, or null for no journal. */
  journal?: string | null;
  owner?: Parameters<typeof ownerText>[1];
}

/** An agent folder with one session, its lease, its worker's record and its journal. */
async function agentFolder({ journal, owner = {} }: Layout = {}) {
  const home = path.join(await realpath(await tempDir()), "agent");
  const sessions = path.join(home, "sessions");
  const lease = path.join(home, "session-leases", leaseNameOf(1));
  const workers = path.join(home, "daemon-workers", HASH);
  await mkdir(sessions, { recursive: true });
  await mkdir(lease, { recursive: true });
  await mkdir(workers, { recursive: true });
  await writeFile(
    path.join(sessions, `${SESSION_ID}.jsonl`),
    line(headerFields(SESSION_ID, { timestamp: iso(AGO) })) +
      nameLine("demo name") +
      conversationLines(),
  );
  await writeFile(
    path.join(lease, "owner.json"),
    ownerText(SESSION_ID, {
      createdAt: iso(AGO),
      processStartId: `ps:${lstartOf(AGO - 5_000)}`,
      ...owner,
    }),
  );
  await writeFile(path.join(workers, `${WORKER_ID}.json`), workerRecordText());
  const journalFile = path.join(workers, `${WORKER_ID}.recovery.jsonl`);
  if (journal !== null) {
    await writeFile(
      journalFile,
      journal ?? checkpoint({ busy: true, operation: "prompt_accepted", at: AGO + 1_000 }),
    );
  }
  return { home, sessions, lease, workers, journalFile };
}

/** The real file system, with each path asked about written down. */
function recordingIo() {
  const asked: string[] = [];
  const io: ReadOnlyIo = {
    readdir: (dir) => (asked.push(dir), nodeIo.readdir(dir)),
    stat: (target) => (asked.push(target), nodeIo.stat(target)),
    lstat: (target) => (asked.push(target), nodeIo.lstat(target)),
    openRegular: (file) => (asked.push(file), nodeIo.openRegular(file)),
  };
  return { io, asked };
}

/** Stand-ins for the lease's process: it runs, it is prime-agent, and it started as its lease says. */
function standIns(platform: NodeJS.Platform): PrimeAgentAdapterOptions {
  return {
    platform,
    isAlive: (pid) => pid === PID,
    uptimeMs: () => 30 * 24 * 60 * 60_000,
    runPs: async () => ({ ok: true, stdout: `${PID} ${lstartOf(AGO - 5_000)} prime-agent\n` }),
    readProcFile: async (file) => {
      if (file !== statFileOf(PID)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return statLine(PID, START_TICKS);
    },
  };
}

async function pollOnce(home: string, options: PrimeAgentAdapterOptions) {
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_ANSWER: "off",
    },
    adapters: [createPrimeAgentAdapter({ env: { [PRIME_AGENT_HOME_ENV]: home }, ...options })],
    intervalMs: 5_000,
    platform: options.platform,
  });
  onTestFinished(() => collector.stop());
  return collector.poller.pollOnce();
}

describe("a session through the collector", () => {
  test("on a Mac works from its journal, with its name, and none of what was said or kept secret", async () => {
    const { home } = await agentFolder();
    const snapshot = await pollOnce(home, standIns("darwin"));
    expect(snapshot.sessions).toEqual([
      expect.objectContaining({
        id: `prime-agent:${SESSION_ID}`,
        name: "demo name",
        cwd: PROJECT,
        status: "working",
      }),
    ]);
    expect(snapshot.sources.find(({ id }) => id === "prime-agent")).toMatchObject({
      state: "ok",
      label: "Prime Agent",
    });
    const said = JSON.stringify(snapshot);
    for (const words of [PRIVATE_WORDS, LEASE_TOKEN, WORKER_SECRET])
      expect(said).not.toContain(words);
  });

  test("on Linux works from its journal once /proc gives its process's start", async () => {
    const { home } = await agentFolder({ owner: { processStartId: PROC_START_ID } });
    const snapshot = await pollOnce(home, standIns("linux"));
    expect(snapshot.sessions[0]?.status).toBe("working");
  });

  test("on Windows is unknown while its lease is held, and its journal is never read", async () => {
    const { home, workers } = await agentFolder({
      owner: { processStartId: "win:133000000000000000" },
    });
    const { io, asked } = recordingIo();
    const snapshot = await pollOnce(home, { ...standIns("win32"), io });
    expect(snapshot.sessions[0]?.status).toBe("unknown");
    expect(asked.filter((target) => target.startsWith(path.dirname(workers)))).toEqual([]);
  });

  test("is finished once its lease is given up", async () => {
    const { home, lease } = await agentFolder();
    await rm(lease, { recursive: true });
    const snapshot = await pollOnce(home, standIns("darwin"));
    expect(snapshot.sessions[0]?.status).toBe("finished");
  });
});

describe.skipIf(process.platform === "win32")("real files", () => {
  // Windows makes a link only with a privilege a test may not have.
  test("a linked agent folder is followed", async () => {
    const { home } = await agentFolder();
    const linked = path.join(path.dirname(home), "linked-agent");
    await symlink(home, linked);
    const snapshot = await pollOnce(linked, standIns("darwin"));
    expect(snapshot.sessions).toEqual([expect.objectContaining({ status: "working" })]);
  });

  test("a linked sessions folder is followed", async () => {
    const { home, sessions } = await agentFolder();
    const linked = path.join(path.dirname(home), "linked-agent");
    await mkdir(linked);
    await symlink(sessions, path.join(linked, "sessions"));
    await symlink(path.join(home, "session-leases"), path.join(linked, "session-leases"));
    // The leases folder through a link is not followed, so the session is unknown.
    const snapshot = await pollOnce(linked, standIns("darwin"));
    expect(snapshot.sessions).toEqual([expect.objectContaining({ status: "unknown" })]);
  });

  test.each([
    ["the session file", "sessions", `${SESSION_ID}.jsonl`],
    ["session-leases", ".", "session-leases"],
    ["a lease's folder", "session-leases", leaseNameOf(1)],
    ["owner.json", `session-leases/${leaseNameOf(1)}`, "owner.json"],
    ["daemon-workers", ".", "daemon-workers"],
    ["a daemon's folder", "daemon-workers", HASH],
    ["the journal", `daemon-workers/${HASH}`, `${WORKER_ID}.recovery.jsonl`],
  ])("a link at %s is not followed", async (_name: string, folder: string, name: string) => {
    const { home } = await agentFolder();
    const target = path.join(home, folder, name);
    const moved = path.join(path.dirname(home), `moved-${name}`);
    await rename(target, moved);
    await symlink(moved, target);
    const { io, asked } = recordingIo();
    const snapshot = await pollOnce(home, { ...standIns("darwin"), io });
    const status = snapshot.sessions[0]?.status;
    if (name === `${SESSION_ID}.jsonl`) expect(snapshot.sessions).toEqual([]);
    else expect(status).toBe("unknown");
    expect(asked.filter((one) => one.startsWith(moved))).toEqual([]);
  });
});

/** Starts a stand-in named `prime-agent` under a folder of the test's own, and stops it when the test ends. */
async function startStandIn(): Promise<{ pid: number; program: string }> {
  const dir = await realpath(await tempDir());
  const program = path.join(dir, "bin", "prime-agent");
  await mkdir(path.dirname(program), { recursive: true });
  let args: string[];
  if (process.platform === "linux") {
    // A script `ps` names by its file, which waits until its input closes.
    await writeFile(program, "#!/bin/sh\nread -r line\n", { mode: 0o755 });
    args = [];
  } else {
    // This Node, through a link: macOS kills a copy of a system program started from elsewhere.
    await symlink(process.execPath, program);
    args = ["-e", "setTimeout(() => {}, 60_000)"];
  }
  const child = spawn(program, args, {
    stdio: [process.platform === "linux" ? "pipe" : "ignore", "ignore", "ignore"],
  });
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  onTestFinished(async () => {
    child.kill();
    await ended;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { pid: child.pid as number, program };
}

/** The real `ps`'s line for one pid, asked again for a moment, since a new process can lag. */
async function psLineOf(pid: number): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const answer = await runPs(["-o", "pid=,lstart=,comm=", "-p", String(pid)], { utc: true });
    const found = answer.stdout.split("\n").find((one) => one.trim().startsWith(`${pid} `));
    if (found && /prime-agent\s*$/.test(found)) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
}

const holderCheck = (platform: NodeJS.Platform) =>
  createHolderCheck({
    platform,
    isAlive: isProcessAlive,
    uptimeMs: () => 30 * 24 * 60 * 60_000,
    runPs,
    readProcFile,
    now: Date.now,
  });

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "the real ps",
  () => {
    test("prints a lease's process's start and the program's name, which is prime-agent", async () => {
      const { pid } = await startStandIn();
      const row = await psLineOf(pid);
      const match = /^\s*\d+\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})\s+(.+?)\s*$/.exec(row);
      expect(match?.[2]?.split("/").pop()).toBe("prime-agent");
      const started = processStartTime(match?.[1] ?? "");
      expect(started).not.toBeNull();
      const lease: Lease = { pid, createdAt: Date.now() - 1_000 };
      const answer = await holderCheck(process.platform).check([lease], Date.now());
      expect(answer.processes.get(lease)).toBe("runs");
    }, 10_000);
  },
);

describe.skipIf(process.platform !== "darwin")("the real ps on a Mac", () => {
  test("gives a start that compares as the same with one Prime Agent writes, and as another with one a minute off", async () => {
    const { pid } = await startStandIn();
    const row = await psLineOf(pid);
    const started = processStartTime(
      /^\s*\d+\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d{4})/.exec(row)?.[1] ?? "",
    ) as number;
    // Prime Agent writes `strftime("%c")` in the C locale and UTC, whose day is padded with a space.
    const same: Lease = {
      pid,
      createdAt: Date.now() - 1_000,
      processStartId: `ps:${lstartOf(started)}`,
    };
    const other: Lease = { ...same, processStartId: `ps:${lstartOf(started - 5 * 60_000)}` };
    const answer = await holderCheck("darwin").check([same, other], Date.now());
    expect(answer.processes.get(same)).toBe("runs");
    expect(answer.processes.get(other)).toBe("gone");
  }, 10_000);
});

describe.skipIf(process.platform !== "linux")("the real /proc on Linux", () => {
  test("gives a child's start as Prime Agent writes it, and tells another start apart", async () => {
    const { pid } = await startStandIn();
    const ticks = startTicksOf(await readProcFile(statFileOf(pid)));
    expect(ticks).toMatch(/^\d+$/);
    const same: Lease = { pid, createdAt: Date.now() - 1_000, processStartId: `proc:${ticks}` };
    const other: Lease = { ...same, processStartId: `proc:${Number(ticks) + 1}` };
    const answer = await holderCheck("linux").check([same, other], Date.now());
    expect(answer.processes.get(same)).toBe("runs");
    expect(answer.processes.get(other)).toBe("gone");
  }, 10_000);
});

describe("its modules", () => {
  test("reach the file system, sockets and programs only through what they are given", () => {
    const root = fileURLToPath(new URL("../../../../../src/", import.meta.url));
    const folders = ["collector/adapters/prime-agent", "core/mapping/prime-agent"];
    for (const folder of folders) {
      for (const name of readdirSync(path.join(root, folder))) {
        const text = readFileSync(path.join(root, folder, name), "utf8");
        expect(text, name).not.toMatch(/from "node:(fs|fs\/promises|net|child_process)"/);
      }
    }
  });
});
