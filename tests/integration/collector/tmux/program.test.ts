import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createTmuxRunner, findTmuxBinary, runTmuxBinary } from "@collector/tmux/program";
import { tempDir } from "@tests/support/node/tempFiles";

/** A stand-in program named `tmux`, in a folder of its own. Returns the folder. */
async function stubTmux(script: string): Promise<string> {
  const dir = path.join(await tempDir(), "bin");
  await mkdir(dir);
  const file = path.join(dir, "tmux");
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return dir;
}

describe("runTmuxBinary", () => {
  test("hands each argument over as it is, with no shell to read it", async () => {
    const dir = await stubTmux('for arg in "$@"; do printf "[%s]\\n" "$arg"; done');
    const result = await runTmuxBinary(
      path.join(dir, "tmux"),
      ["select-pane", "-t", "%7; touch /tmp/never", "$(echo no)", "a b"],
      { env: {} },
    );

    expect(result).toEqual({
      ok: true,
      stdout: "[select-pane]\n[-t]\n[%7; touch /tmp/never]\n[$(echo no)]\n[a b]\n",
    });
  });

  test("a failure comes back with what the program said, and does not reject", async () => {
    const dir = await stubTmux('echo "can\'t find pane: %7" >&2; exit 1');
    const result = await runTmuxBinary(path.join(dir, "tmux"), ["select-pane", "-t", "%7"], {
      env: {},
    });

    expect(result).toEqual({ ok: false, stderr: "can't find pane: %7" });
  });

  test("a program that waits for input is given none", async () => {
    const dir = await stubTmux("cat; echo done");
    const result = await runTmuxBinary(path.join(dir, "tmux"), [], { env: {}, timeoutMs: 5_000 });

    expect(result).toEqual({ ok: true, stdout: "done\n" });
  });

  test("a program that hangs is given up on when its time is up", async () => {
    const dir = await stubTmux("exec sleep 30");
    const started = Date.now();
    const result = await runTmuxBinary(path.join(dir, "tmux"), [], { env: {}, timeoutMs: 200 });

    expect(result).toEqual({ ok: false, stderr: "" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a program that is not there is a failure, not an exception", async () => {
    const missing = path.join(await tempDir(), "tmux");
    expect(await runTmuxBinary(missing, ["list-panes"], { env: {} })).toEqual({
      ok: false,
      stderr: "",
    });
  });
});

describe("createTmuxRunner", () => {
  test("runs the tmux on PATH, with the collector's environment", async () => {
    const dir = await stubTmux('echo "$1 from $AGENT_LOOKOUT_TEST_MARK"');
    // Found on PATH, which comes before the fixed locations.
    expect(await findTmuxBinary({ PATH: dir })).toBe(path.join(dir, "tmux"));

    const run = createTmuxRunner({ env: { PATH: dir, AGENT_LOOKOUT_TEST_MARK: "the collector" } });
    expect(await run(["list-panes"])).toEqual({
      ok: true,
      stdout: "list-panes from the collector\n",
    });
  });

  test("with AGENT_LOOKOUT_TMUX off, a tmux that is there is not started", async () => {
    const mark = path.join(await tempDir(), "ran");
    const dir = await stubTmux(`touch "${mark}"`);
    const run = createTmuxRunner({ env: { PATH: dir, AGENT_LOOKOUT_TMUX: "off" } });

    expect(await run(["list-panes"])).toEqual({ ok: false, stderr: "" });
    expect(existsSync(mark)).toBe(false);
  });
});
