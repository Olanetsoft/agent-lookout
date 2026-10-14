import { spawn } from "node:child_process";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createOpencodeProcessReader,
  OPENCODE_TABLE_ARGS,
  opencodeInTable,
  type RunPs,
} from "@collector/adapters/opencode/processes";
import { runPs } from "@collector/processes/ps";
import { tempDir } from "@tests/support/node/tempFiles";

// `ps` only reads, so the real one is asked, for the name each process gives
// its program and nothing else. OpenCode is a stand-in that only waits: this
// Node, started through a link named `opencode` in a folder of the test's
// own. On macOS `ps` prints the full path a program was started by, so only
// the lines under that folder are looked at, since this machine may run
// OpenCode itself. On Linux it prints the name alone, which any OpenCode
// running here would share.

/** Starts the stand-in under a folder of the test's own, and stops it when the test ends. */
async function startStandIn(): Promise<{ dir: string; stop: () => Promise<void> }> {
  const dir = await realpath(await tempDir());
  const program = path.join(dir, "bin", "opencode");
  await mkdir(path.dirname(program), { recursive: true });
  await symlink(process.execPath, program);
  const child = spawn(program, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
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
  const reader = createOpencodeProcessReader({ run });
  let answer = await reader.read();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (answer.ok && answer.running === running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer = await reader.read();
  }
  return answer;
}

describe.skipIf(process.platform !== "darwin")(
  "OpenCode's program, in the real ps on macOS",
  () => {
    test("is found by its name while it runs, and not once it has ended", async () => {
      const { dir, stop } = await startStandIn();
      expect(await readUntil(psUnder(dir), true)).toEqual({ ok: true, running: true });
      // ps prints the full path the stand-in was started by.
      const table = await psUnder(dir)(OPENCODE_TABLE_ARGS);
      expect(table.stdout.trim()).toBe(path.join(dir, "bin", "opencode"));
      await stop();
      expect(await readUntil(psUnder(dir), false)).toEqual({ ok: true, running: false });
    }, 10_000);
  },
);

describe.skipIf(process.platform !== "linux")("OpenCode's program, in the real ps on Linux", () => {
  test("is found by its name alone while it runs", async () => {
    // An OpenCode running on this machine would be seen as well.
    const before = opencodeInTable((await runPs(OPENCODE_TABLE_ARGS)).stdout);
    const { stop } = await startStandIn();
    expect(await readUntil(runPs, true)).toEqual({ ok: true, running: true });
    const names = (await runPs(OPENCODE_TABLE_ARGS)).stdout.split("\n").map((line) => line.trim());
    expect(names).toContain("opencode");
    await stop();
    expect(await readUntil(runPs, before)).toEqual({ ok: true, running: before });
  }, 10_000);
});

describe.skipIf(process.platform === "darwin" || process.platform === "linux")(
  "OpenCode's program elsewhere",
  () => {
    test("is not looked for, so nothing is run", async () => {
      expect(await createOpencodeProcessReader().read()).toEqual({ ok: false });
    });
  },
);
