// The Prime Agent adapter, cut off from this machine, for the tests that share
// it: the file system held in memory that the Codex tests use, with a folder's
// modified time moved whenever something is added to it or taken from it, as
// on a disk; stand-ins for signal 0, the computer's uptime, `ps` and `/proc`
// that write down what they were asked; and an adapter built from them with a
// clock the test moves by hand. Nothing here touches a real file or a real
// process.

import path from "node:path/posix";

import {
  createPrimeAgentAdapter,
  type PrimeAgentAdapterOptions,
} from "@collector/adapters/prime-agent/index";
import type { PsAnswer } from "@collector/processes/ps";
import { DAY, HOME, NOW } from "@tests/fixtures/prime-agent/primeAgent";
import { handClock, memoryFiles, type WriteOptions } from "@tests/support/adapters/codexAdapter";

export { handClock };

/**
 * The file system held in memory, in which writing, removing or making
 * something moves the modified time of the folder it is in to the clock's
 * time, and of each folder made for it, as a disk does. Adding to a file
 * leaves its folder's time alone, as on a disk.
 */
export function primeAgentFiles(clock: () => number = () => NOW) {
  const files = memoryFiles(clock);
  const known = new Set<string>();

  /** Moves the time of the folder `target` is in, and of each folder made to hold it. */
  function touchFor(target: string) {
    let dir = path.dirname(target);
    files.touch(dir, clock());
    while (!known.has(dir) && dir !== path.dirname(dir)) {
      known.add(dir);
      dir = path.dirname(dir);
      files.touch(dir, clock());
    }
  }

  return {
    ...files,
    write(target: string, content: string | Uint8Array, options: WriteOptions = {}) {
      files.write(target, content, options);
      touchFor(target);
    },
    special(target: string) {
      files.special(target);
      touchFor(target);
    },
    mkdir(target: string) {
      files.mkdir(target);
      touchFor(`${target}/x`);
      known.add(target);
    },
    remove(target: string) {
      files.remove(target);
      for (const dir of [...known])
        if (dir === target || dir.startsWith(`${target}/`)) known.delete(dir);
      files.touch(path.dirname(target), clock());
    },
  };
}

export type PrimeAgentFiles = ReturnType<typeof primeAgentFiles>;

/** A stand-in for signal 0: the pids that run, which the test changes, and each pid asked about. */
export function standInAlive(running: Iterable<number> = []) {
  const alive = new Set(running);
  const asked: number[] = [];
  return {
    alive,
    asked,
    isAlive(pid: number) {
      asked.push(pid);
      return alive.has(pid);
    },
  };
}

/** One process as the stand-in `ps` prints it. */
export interface PsProcess {
  lstart: string;
  program: string;
}

/**
 * A stand-in for `ps`, which prints the processes the test gives it that were
 * asked for, as `ps -o pid=,lstart=,comm= -p <pids>` does, and writes down
 * every run's arguments and options. It can be made to fail.
 */
export function standInPs(processes: Map<number, PsProcess> = new Map()) {
  const runs: { args: string[]; utc: boolean }[] = [];
  let failing = false;
  return {
    processes,
    runs,
    fail(next = true) {
      failing = next;
    },
    async run(args: readonly string[], options: { utc?: boolean } = {}): Promise<PsAnswer> {
      runs.push({ args: [...args], utc: options.utc === true });
      if (failing) return { ok: false, stdout: "" };
      const pids = (args[args.indexOf("-p") + 1] ?? "").split(",").map(Number);
      const lines = pids.flatMap((pid) => {
        const one = processes.get(pid);
        return one === undefined
          ? []
          : [`${String(pid).padStart(5)} ${one.lstart}     ${one.program}`];
      });
      // `ps` exits with an error when a pid asked for has gone.
      return { ok: lines.length === pids.length, stdout: lines.map((one) => `${one}\n`).join("") };
    },
  };
}

/** A stand-in for reading `/proc`, from the lines the test gives it, which writes down each file read. */
export function standInProc(files: Map<string, string> = new Map()) {
  const read: string[] = [];
  return {
    files,
    read,
    async readProcFile(file: string) {
      read.push(file);
      const text = files.get(file);
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
      return text;
    },
  };
}

/**
 * An adapter that reads only the stand-in files, on a Mac's rules, with no
 * process running and a `ps` and `/proc` that know none unless the test says
 * otherwise, and a computer that has been on for 30 days. With nothing in
 * `env` it looks in `~/.prime/agent`.
 */
export function primeAgentAdapterFor(
  files: PrimeAgentFiles,
  options: PrimeAgentAdapterOptions = {},
) {
  return createPrimeAgentAdapter({
    env: {},
    homeDir: HOME,
    now: () => NOW,
    io: files.io,
    platform: "darwin",
    isAlive: () => false,
    uptimeMs: () => 30 * DAY,
    runPs: standInPs().run,
    readProcFile: standInProc().readProcFile,
    ...options,
  });
}
