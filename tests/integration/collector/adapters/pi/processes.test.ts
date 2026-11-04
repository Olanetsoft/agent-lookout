import { spawn } from "node:child_process";

import { describe, expect, onTestFinished, test } from "vitest";

import { createPiProcessReader, PI_TABLE_ARGS, piInTable } from "@collector/adapters/pi/processes";
import { runPs } from "@collector/processes/ps";

// `ps` only reads, so the real one is asked, for the name each process gives its
// program and nothing else. Pi is a stand-in that only waits: this Node, which
// sets `process.title` as Pi does as it starts. So this checks what Pi's source
// leads to, not Pi: Pi was not run to write it. Windows has no `ps`.

/** A Node program that gives itself this title, and says so once it has. */
async function startTitled(title: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `process.title = ${JSON.stringify(title)}; console.log("ready"); setTimeout(() => {}, 60_000);`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  onTestFinished(async () => {
    child.kill();
    await ended;
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("the real ps", () => {
  test.each(["pi", "pi-rpc"])("sees a Node program titled %s", async (title) => {
    await startTitled(title);
    const table = await runPs(PI_TABLE_ARGS);
    expect(table.ok).toBe(true);
    expect(piInTable(table.stdout)).toBe(true);
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    expect(await createPiProcessReader({ platform }).read()).toEqual({ ok: true, running: true });
  });
});
