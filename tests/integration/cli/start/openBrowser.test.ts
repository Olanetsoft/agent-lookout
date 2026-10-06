import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { runProgram } from "@cli/start/openBrowser";
import { tempDir } from "@tests/support/node/tempFiles";

// The opener's runner against stand-in openers: small shell scripts in a
// temporary folder. No browser is ever opened.

/** Writes an executable shell script that stands in for `open` or `xdg-open`, and returns its path. */
async function standInOpener(script: string): Promise<{ file: string; dir: string }> {
  const dir = await tempDir();
  const file = path.join(dir, "opener");
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return { file, dir };
}

describe("runProgram, against stand-in openers", () => {
  test("has worked when the opener ends with 0", async () => {
    const { file } = await standInOpener("exit 0");
    expect(await runProgram(file, ["http://127.0.0.1:4777"])).toBe(true);
  });

  test("has failed when the opener ends with another code, or is not there", async () => {
    const { file, dir } = await standInOpener("exit 3");
    expect(await runProgram(file, ["http://127.0.0.1:4777"])).toBe(false);
    expect(await runProgram(path.join(dir, "missing"), ["http://127.0.0.1:4777"])).toBe(false);
  });

  test("has worked when the opener is still running, and leaves it running in a session of its own", async () => {
    // As xdg-open does when it runs the browser in the foreground: it ends
    // only when the browser quits.
    // It runs for 3 seconds, long enough to be checked on a busy machine.
    const { file, dir } = await standInOpener(
      'here=$(dirname "$0")\necho $$ > "$here/pid"\nsleep 3\necho ended > "$here/ended"',
    );
    const startedAt = Date.now();
    expect(await runProgram(file, ["http://127.0.0.1:4777"], 200)).toBe(true);
    // It was not waited for.
    expect(Date.now() - startedAt).toBeLessThan(2_500);

    await vi.waitFor(() => expect(existsSync(path.join(dir, "pid"))).toBe(true), {
      timeout: 2_500,
    });
    const pid = Number((await readFile(path.join(dir, "pid"), "utf8")).trim());
    // It leads a process group of its own, so Ctrl+C in this terminal does not reach it.
    const { stdout } = await promisify(execFile)("ps", ["-o", "pgid=", "-p", String(pid)]);
    expect(Number(stdout.trim())).toBe(pid);

    // It was not stopped: it ends on its own.
    await vi.waitFor(() => expect(existsSync(path.join(dir, "ended"))).toBe(true), {
      timeout: 10_000,
    });
  }, 20_000);
});
