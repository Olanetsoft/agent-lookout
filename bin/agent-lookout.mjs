#!/usr/bin/env node
// The `agent-lookout` command. `npm link` in this folder puts it on the PATH,
// and `npm run --silent status` runs it from here. The command is TypeScript in
// `src/cli/`, loaded through tsx as `npm start` loads the server, so it says
// what the dashboard says in the same words.
//
// Exit code 1 means a session needs you, so nothing else may end with it.
// Whatever goes wrong here, such as tsx missing while `npm ci` runs, is one
// line on stderr and exit code 2.

// A reader that went away, such as `| head` or a prompt, is no reason to change the answer.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

try {
  const { register } = await import("tsx/esm/api");
  register();
  const { runCommand } = await import("../src/cli/agentLookout.ts");
  process.exitCode = await runCommand({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  });
} catch (error) {
  const why = error instanceof Error ? error.message.split("\n")[0] : String(error);
  process.stderr.write(`agent-lookout could not run: ${why}\n`);
  process.exitCode = 2;
}
