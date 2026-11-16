import { execFileSync } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { runEditor } from "@collector/editor/program";
import { tempDir } from "@tests/support/node/tempFiles";

// A stand-in for an editor's command, a POSIX sh script in a folder of the
// test's own, so no test here runs VS Code's own command or starts an editor.
// What is checked is how the runner starts a command and reads its answer.

/** A program written moments ago can take seconds to start the first time on a busy machine. */
const STARTING_MS = 20_000;

/**
 * A stand-in command that writes each argument on a line of its own, its
 * environment's names and what it read from stdin into the folder, then, when
 * it was given arguments, runs the rest of its script. It is started once
 * here, with none and no limit, so the first run a test makes is not its first.
 */
async function standInCommand(rest = "") {
  const folder = await tempDir();
  const program = path.join(folder, "code");
  const args = path.join(folder, "args");
  const env = path.join(folder, "env");
  const stdin = path.join(folder, "stdin");
  await writeFile(
    program,
    [
      "#!/bin/sh",
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${args}'`,
      `/usr/bin/env > '${env}'`,
      `/bin/cat > '${stdin}'`,
      `if [ "$#" -gt 0 ]; then`,
      rest || ":",
      "fi",
      "",
    ].join("\n"),
  );
  await chmod(program, 0o755);
  execFileSync(program, [], { input: "" });
  const lines = async (file: string) => (await readFile(file, "utf8")).split("\n").slice(0, -1);
  return {
    program,
    args: () => lines(args),
    names: async () => (await lines(env)).map((line) => line.slice(0, line.indexOf("="))),
    stdin: () => readFile(stdin, "utf8"),
  };
}

describe.skipIf(process.platform === "win32")("runEditor with a stand-in command", () => {
  test("hands each argument to the command as it is given, with no shell between", async () => {
    const command = await standInCommand();
    const folder = "/Users/example/code/a folder; echo $HOME `id` > x";
    const result = await runEditor(command.program, ["--new-window", folder], {
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: STARTING_MS,
    });

    expect(result).toEqual({ ok: true });
    expect(await command.args()).toEqual(["--new-window", folder]);
  });

  test("closes stdin, so a command that reads it is not held", async () => {
    const command = await standInCommand();
    const result = await runEditor(command.program, ["--new-window", "/Users/example/code/demo"], {
      env: { PATH: "/usr/bin:/bin" },
      timeoutMs: STARTING_MS,
    });

    // The stand-in reads stdin to its end before it ends.
    expect(result).toEqual({ ok: true });
    expect(await command.stdin()).toBe("");
  });

  test("gives the command the collector's environment without Agent Lookout's, the editor's and Electron's own, or Node's options", async () => {
    const command = await standInCommand();
    await runEditor(command.program, ["--new-window", "/Users/example/code/demo"], {
      env: {
        PATH: "/usr/bin:/bin",
        LANG: "en_GB.UTF-8",
        AGENT_LOOKOUT_SMTP_URL: "smtp://user:secret@mail.example",
        VSCODE_IPC_HOOK_CLI: "/tmp/vscode-ipc-example.sock",
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "--require /tmp/example.js",
        NODE_REPL_EXTERNAL_MODULE: "/tmp/example.js",
      },
      timeoutMs: STARTING_MS,
    });

    const names = await command.names();
    expect(names).toEqual(expect.arrayContaining(["PATH", "LANG"]));
    for (const name of names) {
      expect(name).not.toMatch(/^(AGENT_LOOKOUT_|VSCODE_|ELECTRON_|NODE_OPTIONS|NODE_REPL)/);
    }
  });

  test("a command that fails, or is not there, is a failure", async () => {
    const failing = await standInCommand("exit 3");
    expect(
      await runEditor(failing.program, ["--new-window", "/Users/example/code/demo"], {
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: STARTING_MS,
      }),
    ).toEqual({ ok: false, timedOut: false });

    const missing = path.join(
      await tempDir(),
      "Visual Studio Code.app/Contents/Resources/app/bin/code",
    );
    expect(
      await runEditor(missing, ["--new-window", "/Users/example/code/demo"], {
        env: { PATH: "/usr/bin:/bin" },
      }),
    ).toEqual({ ok: false, timedOut: false });
  });

  test("stops a command that takes longer than its time, and says so", async () => {
    const slow = await standInCommand("exec /bin/sleep 5");
    expect(
      await runEditor(slow.program, ["--new-window", "/Users/example/code/demo"], {
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 300,
      }),
    ).toEqual({ ok: false, timedOut: true });
  });
});
