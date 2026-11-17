import { spawn } from "node:child_process";

import { describe, expect, onTestFinished, test } from "vitest";

import { createFxProcessReader } from "@collector/adapters/fx/processes";

// `ps` only reads, so the real one is asked, for each process's ID and the
// name it gives its program, and nothing else. fx is a stand-in that only
// waits: this Node, which sets `process.title` to `fx`, so `ps` shows that
// name on macOS and Linux. So this checks what fx's program name leads to,
// not fx. Windows has no `ps`.
describe.skipIf(process.platform === "win32")("the real ps", () => {
  test("lists a program named fx by its ID, and not one named otherwise", async () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const reader = createFxProcessReader({ platform });
    const pids: Record<string, number> = {};
    for (const title of ["fx", "fx-helper"]) {
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
      pids[title] = child.pid!;
    }
    const answer = await reader.read();
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.pids).toContain(pids.fx);
    expect(answer.pids).not.toContain(pids["fx-helper"]);
  });
});
