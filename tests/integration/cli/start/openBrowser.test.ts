import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { runProgram } from "@cli/start/openBrowser";
import { tempDir, writeWindowsStub } from "@tests/support/node/tempFiles";

// The opener's runner against stand-in openers: small shell scripts in a
// temporary folder, and on Windows a stand-in program. No browser is ever opened.

/** Writes an executable shell script that stands in for `open` or `xdg-open`, and returns its path. */
async function standInOpener(script: string): Promise<{ file: string; dir: string }> {
  const dir = await tempDir();
  const file = path.join(dir, "opener");
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return { file, dir };
}

// A test of how the opener ends runs for up to 30 seconds, room for a busy
// machine to start it. It waits for the opener longer than that, so its result
// comes only from how the opener ended.
const ENDING_WAIT_MS = 60_000;

// The stand-in openers are POSIX sh scripts, and a process group is a POSIX
// thing, so Windows has its own checks below.
describe.skipIf(process.platform === "win32")("runProgram, against stand-in openers", () => {
  test("has worked when the opener ends with 0", async () => {
    const { file } = await standInOpener("exit 0");
    expect(await runProgram(file, ["http://127.0.0.1:4777"], ENDING_WAIT_MS)).toBe(true);
  }, 30_000);

  test("has failed when the opener ends with another code, or is not there", async () => {
    const { file, dir } = await standInOpener("exit 3");
    expect(await runProgram(file, ["http://127.0.0.1:4777"], ENDING_WAIT_MS)).toBe(false);
    expect(
      await runProgram(path.join(dir, "missing"), ["http://127.0.0.1:4777"], ENDING_WAIT_MS),
    ).toBe(false);
  }, 30_000);

  test("has worked when the opener is still running, and leaves it running in a session of its own", async () => {
    // As xdg-open does when it runs the browser in the foreground: it ends
    // only when the browser quits.
    // It runs until the test lets it go, so it is still there to be checked
    // however busy the machine is. It also ends once its folder is gone.
    const { file, dir } = await standInOpener(
      [
        'here=$(dirname "$0")',
        'echo $$ > "$here/pid"',
        'while [ -d "$here" ] && [ ! -e "$here/go" ]; do sleep 1; done',
        'echo ended > "$here/ended"',
      ].join("\n"),
    );
    const startedAt = Date.now();
    expect(await runProgram(file, ["http://127.0.0.1:4777"], 200)).toBe(true);
    // It was not waited for.
    expect(Date.now() - startedAt).toBeLessThan(2_500);

    // A busy machine can take seconds to start it.
    await vi.waitFor(() => expect(existsSync(path.join(dir, "pid"))).toBe(true), {
      timeout: 15_000,
    });
    const pid = Number((await readFile(path.join(dir, "pid"), "utf8")).trim());
    // It leads a process group of its own, so Ctrl+C in this terminal does not reach it.
    const { stdout } = await promisify(execFile)("ps", ["-o", "pgid=", "-p", String(pid)]);
    expect(Number(stdout.trim())).toBe(pid);

    // It was not stopped: it is let go 3 seconds on, and ends on its own.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await writeFile(path.join(dir, "go"), "");
    await vi.waitFor(() => expect(existsSync(path.join(dir, "ended"))).toBe(true), {
      timeout: 10_000,
    });
  }, 40_000);
});

describe.runIf(process.platform === "win32")(
  "runProgram on Windows, against a stand-in opener",
  () => {
    /** Runs the stand-in as the opener would be run, with what it needs in the environment it inherits. */
    async function runAs(body: string): Promise<boolean> {
      const opener = await writeWindowsStub(body, "rundll32.exe");
      vi.stubEnv("NODE_OPTIONS", opener.env.NODE_OPTIONS);
      try {
        return await runProgram(opener.file, [
          "url.dll,FileProtocolHandler",
          "http://127.0.0.1:4777",
        ]);
      } finally {
        vi.unstubAllEnvs();
      }
    }

    test("has worked when the opener ends with 0", async () => {
      expect(await runAs("process.exit(0);")).toBe(true);
    }, 20_000);

    test("has failed when the opener ends with another code", async () => {
      expect(await runAs("process.exit(3);")).toBe(false);
    }, 20_000);
  },
);
