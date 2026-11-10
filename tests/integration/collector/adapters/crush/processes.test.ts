import { spawn } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createCrushProcessReader,
  CRUSH_TABLE_ARGS,
  crushInTable,
} from "@collector/adapters/crush/processes";
import type { RunPs } from "@collector/adapters/opencode/processes";
import { runPs } from "@collector/processes/ps";
import { tempDir } from "@tests/support/node/tempFiles";

// `ps` only reads, so the real one is asked, for the name each process gives
// its program and nothing else. Crush is a stand-in that only waits, named
// `crush`, in a folder of the test's own. On macOS it is this Node, started
// through a link: macOS kills a copy of a system program such as `sleep`
// started from elsewhere. On Linux it is a two-line `sh` script, which `ps`
// names by its file, as it does any script, and which waits until its input
// closes. Node won't do there, as Node 24 names its own main thread, which on
// Linux is the name `ps` prints, and nor will a copy of the system's `sleep`
// where, as on Ubuntu 26.04, it is one program for all the core tools that acts
// by the name it was started under. On macOS `ps` prints the full path a
// program was started by, so only the lines under that folder are looked at,
// since this machine may run Crush itself. On Linux it prints the name alone,
// which any Crush running here would share.

/** Starts the stand-in under a folder of the test's own, and stops it when the test ends. */
async function startStandIn(): Promise<{ dir: string; stop: () => Promise<void> }> {
  const dir = await realpath(await tempDir());
  const program = path.join(dir, "bin", "crush");
  await mkdir(path.dirname(program), { recursive: true });
  let args: string[];
  if (process.platform === "linux") {
    await writeFile(program, "#!/bin/sh\nread -r line\n", { mode: 0o755 });
    args = [];
  } else {
    await symlink(process.execPath, program);
    args = ["-e", "setTimeout(() => {}, 60_000)"];
  }
  const child = spawn(program, args, {
    stdio: [process.platform === "linux" ? "pipe" : "ignore", "ignore", "ignore"],
  });
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    child.kill();
    await ended;
  };
  onTestFinished(stop);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return { dir, stop };
}

/** The real `ps`, with only the lines of programs under this folder kept. */
function psUnder(dir: string): RunPs {
  return async (args) => {
    const table = await runPs(args);
    const lines = table.stdout.split("\n").filter((line) => line.trim().startsWith(`${dir}/`));
    return { ok: table.ok, stdout: lines.map((line) => `${line}\n`).join("") };
  };
}

/** What the reader says from this `ps`, asked again for a moment until it says this, since the table can lag. */
async function readUntil(run: RunPs, running: boolean) {
  const reader = createCrushProcessReader({ run });
  let answer = await reader.read();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (answer.ok && answer.running === running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer = await reader.read();
  }
  return answer;
}

describe.skipIf(process.platform !== "darwin")("Crush's program, in the real ps on macOS", () => {
  test("is found by its name while it runs, and not once it has ended", async () => {
    const { dir, stop } = await startStandIn();
    expect(await readUntil(psUnder(dir), true)).toEqual({ ok: true, running: true });
    // ps prints the full path the stand-in was started by.
    const table = await psUnder(dir)(CRUSH_TABLE_ARGS);
    expect(table.stdout.trim()).toBe(path.join(dir, "bin", "crush"));
    await stop();
    expect(await readUntil(psUnder(dir), false)).toEqual({ ok: true, running: false });
  }, 10_000);
});

describe.skipIf(process.platform !== "linux")("Crush's program, in the real ps on Linux", () => {
  test("is found by its name alone while it runs", async () => {
    // A Crush running on this machine would be seen as well.
    const before = crushInTable((await runPs(CRUSH_TABLE_ARGS)).stdout);
    const { stop } = await startStandIn();
    expect(await readUntil(runPs, true)).toEqual({ ok: true, running: true });
    const names = (await runPs(CRUSH_TABLE_ARGS)).stdout.split("\n").map((line) => line.trim());
    expect(names).toContain("crush");
    await stop();
    expect(await readUntil(runPs, before)).toEqual({ ok: true, running: before });
  }, 10_000);
});

describe.skipIf(process.platform === "darwin" || process.platform === "linux")(
  "Crush's program elsewhere",
  () => {
    test("is not looked for, so nothing is run", async () => {
      expect(await createCrushProcessReader().read()).toEqual({ ok: false });
    });
  },
);
