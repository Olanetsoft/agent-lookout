// The Agent Lookout plugin's hook, run as Claude Code runs it: its own script,
// `plugins/agent-lookout/hooks/ask-agent-lookout.sh`, with a permission
// request of the test's own on stdin, sent to the test's own socket. No Claude
// Code is run, and the hook reaches no socket but the one the test names. Each
// run is ended when its test finishes.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { onTestFinished } from "vitest";

const SCRIPT = fileURLToPath(
  new URL("../../../plugins/agent-lookout/hooks/ask-agent-lookout.sh", import.meta.url),
);

/** What the hook printed for Claude Code, and how it exited. */
export interface HookRun {
  code: number | null;
  stdout: string;
}

/** Runs the hook for a request of `sessionId`'s, and resolves once it exits. */
export function runPermissionHook(
  socketPath: string,
  request: { sessionId: string; toolName: string; toolInput: unknown },
): Promise<HookRun> {
  const child = spawn("/bin/sh", [SCRIPT], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: "/nonexistent-home",
      AGENT_LOOKOUT_ANSWER_SOCKET: socketPath,
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  const done = new Promise<HookRun>((resolve) =>
    child.once("exit", (code) => resolve({ code, stdout })),
  );
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  // With no socket the script leaves before it reads its input, as it should,
  // so writing that input can find the pipe already closed.
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") throw error;
  });
  child.stdin.end(
    JSON.stringify({
      session_id: request.sessionId,
      transcript_path: "/Users/example/.claude/projects/demo/x.jsonl",
      cwd: "/Users/example/code/demo",
      hook_event_name: "PermissionRequest",
      tool_name: request.toolName,
      tool_input: request.toolInput,
    }),
  );
  return done;
}
