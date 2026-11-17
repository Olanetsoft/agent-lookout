import { spawn } from "node:child_process";
import { symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createUnrealProcessReader } from "@collector/adapters/unreal-agent/processes";
import { tempDir } from "@tests/support/node/tempFiles";

// `ps` only reads, so the real one is asked, for when each process started
// and the name it gives its program, and nothing else. The Unreal Agent it
// finds is a stand-in that only waits, started through a link named
// `unreal-agent-tui`: this Node on macOS, where `ps` names a program by the
// file it was started from, and `/bin/sh` on Linux, where it names it by the
// link's name, cut to 15 characters, `unreal-agent-tu`. Another Unreal Agent
// may run on the machine under test, so only that one start was found is
// sure. Windows has no `ps`.

/** Starts a program under the name `unreal-agent-tui`, and stops it when the test ends. */
async function startStandIn(): Promise<void> {
  const dir = await tempDir();
  const program = path.join(dir, "unreal-agent-tui");
  const linux = process.platform === "linux";
  await symlink(linux ? "/bin/sh" : process.execPath, program);
  const args = linux
    ? ["-c", "while :; do sleep 1; done", "unreal-agent-tui"]
    : ["-e", "setTimeout(() => {}, 60_000)"];
  const child = spawn(program, args, { stdio: "ignore" });
  onTestFinished(() => {
    child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

describe.skipIf(process.platform === "win32")("the real ps", () => {
  test("gives when a program named unreal-agent-tui started, to the second, in UTC", async () => {
    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const before = Math.floor(Date.now() / 1000) * 1000 - 1000;
    await startStandIn();
    const reader = createUnrealProcessReader({ platform });
    let found: number | undefined;
    // The table can lag the start by a moment.
    for (let attempt = 0; attempt < 20 && found === undefined; attempt += 1) {
      const answer = await reader.read();
      expect(answer.ok).toBe(true);
      if (answer.ok) found = answer.starts.find((start) => start >= before && start <= Date.now());
      if (found === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(found).toBeDefined();
  }, 10_000);
});
