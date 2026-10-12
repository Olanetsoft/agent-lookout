import { spawn } from "node:child_process";
import { mkdir, realpath, symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createHubProcessReader,
  HUB_IN_APP,
  HUB_TABLE_ARGS,
  hubInTable,
} from "@collector/adapters/antigravity/app/hubProcess";
import { runPs } from "@collector/processes/ps";
import { tempDir } from "@tests/support/node/tempFiles";

// `ps` only reads, so the real one is asked, for the name each process gives
// its program and nothing else. The hub it looks for is a stand-in that only
// waits: this Node, started through a link where the app's hub would be in a
// home folder of the test's own, `~/Applications/Antigravity.app/Contents/Resources/bin/language_server`.
// Only the lines under that folder are looked at, since this machine may run
// the app itself.

/** Starts the stand-in hub under a folder of the test's own, and stops it when the test ends. */
async function startStandInHub(): Promise<{ home: string; stop: () => Promise<void> }> {
  const home = await realpath(await tempDir());
  const hub = `${home}/Applications${HUB_IN_APP}`;
  await mkdir(path.dirname(hub), { recursive: true });
  await symlink(process.execPath, hub);
  const child = spawn(hub, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
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
  return { home, stop };
}

/** The real `ps`, with only the lines of programs under this folder kept. */
async function psUnder(home: string, args: readonly string[]) {
  const table = await runPs(args);
  const lines = table.stdout.split("\n").filter((line) => line.trim().startsWith(`${home}/`));
  return { ok: table.ok, stdout: lines.map((line) => `${line}\n`).join("") };
}

/** What the reader says from the real `ps`, asked again for a moment until it says this, since the table can lag. */
async function readUntil(home: string, running: boolean) {
  const reader = createHubProcessReader({ run: (args) => psUnder(home, args) });
  let answer = await reader.read();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (answer.ok && answer.running === running) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer = await reader.read();
  }
  return answer;
}

// The hub's place is known only on macOS.
describe.skipIf(process.platform !== "darwin")("the app's hub, in the real ps", () => {
  test("is found at its place while it runs, and not once it has ended", async () => {
    const { home, stop } = await startStandInHub();
    expect(await readUntil(home, true)).toEqual({ ok: true, running: true });
    // ps prints the full path the stand-in was started by, as it does the app's own hub.
    expect(hubInTable((await psUnder(home, HUB_TABLE_ARGS)).stdout)).toBe(true);
    await stop();
    expect(await readUntil(home, false)).toEqual({ ok: true, running: false });
  }, 10_000);
});

describe.skipIf(process.platform === "darwin")("the app's hub on Linux and Windows", () => {
  test("is not looked for, so nothing is run", async () => {
    expect(await createHubProcessReader().read()).toEqual({ ok: false });
  });
});
