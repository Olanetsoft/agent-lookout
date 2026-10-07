import { spawn } from "node:child_process";
import { symlink } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createAgyProcessReader } from "@collector/adapters/antigravity/agyProcesses";
import { conversationId } from "@tests/fixtures/antigravity";
import { tempDir } from "@tests/support/node/tempFiles";

// `ps` only reads, so the real one is asked. The agy it finds is a stand-in:
// this Node, started through a link named `agy`, which only waits.

const CONVERSATION = conversationId("a1");

/** Starts this Node under the name `agy`, with these arguments after its own, and stops it when the test ends. */
async function startStandInAgy(args: string[]): Promise<number> {
  const dir = await tempDir();
  const agy = path.join(dir, "agy");
  await symlink(process.execPath, agy);
  const child = spawn(agy, ["-e", "setTimeout(() => {}, 60_000)", "--", ...args], {
    stdio: "ignore",
  });
  onTestFinished(() => {
    child.kill();
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child.pid as number;
}

// Windows has no ps.
describe.skipIf(process.platform === "win32")("createAgyProcessReader, asking the real ps", () => {
  test("finds a running agy, when it started and the conversation it names", async () => {
    const before = Date.now();
    await startStandInAgy(["--conversation", CONVERSATION]);
    const reader = createAgyProcessReader();

    // The table can lag the start by a moment.
    let found;
    for (let attempt = 0; attempt < 20 && found === undefined; attempt += 1) {
      const list = await reader.read();
      expect(list.ok).toBe(true);
      if (list.ok) found = list.sessions.find((session) => session.conversation === CONVERSATION);
      if (found === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(found).toBeDefined();
    // `lstart` counts whole seconds, in UTC.
    expect(found?.startedAt).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000 - 1000);
    expect(found?.startedAt).toBeLessThanOrEqual(Date.now());
  }, 10_000);

  test("an agy that names no conversation is a session that names none", async () => {
    await startStandInAgy([]);
    const reader = createAgyProcessReader();
    let named = false;
    for (let attempt = 0; attempt < 20 && !named; attempt += 1) {
      const list = await reader.read();
      expect(list.ok).toBe(true);
      // The stand-in's command line goes on with `-e`, which is no command of agy's.
      named = list.ok && list.sessions.some((session) => session.conversation === undefined);
      if (!named) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(named).toBe(true);
  }, 10_000);
});

// Only Windows is without ps.
describe.skipIf(process.platform !== "win32")("createAgyProcessReader on Windows", () => {
  test("runs nothing, since there is no ps", async () => {
    expect(await createAgyProcessReader().read()).toEqual({ ok: false });
  });
});
