import { execFile } from "node:child_process";

import { EDITOR_JUMP_TIMEOUT_MS } from "../../core/api.ts";
import { childEnvironment } from "../processes/childEnvironment.ts";

// What brings an editor's window forward is the editor's own command, run the
// one way the collector runs it for Jump.

/** The variable that, set to `off`, stops Agent Lookout looking for or asking an editor. */
export const EDITOR_JUMP_ENV = "AGENT_LOOKOUT_EDITOR_JUMP";

/** Whether `AGENT_LOOKOUT_EDITOR_JUMP` is `off` in this environment. */
export function editorJumpOff(env: NodeJS.ProcessEnv): boolean {
  return env[EDITOR_JUMP_ENV]?.trim().toLowerCase() === "off";
}

/** Far more than the command prints, and a ceiling on what is read. */
const MAX_OUTPUT_BYTES = 64 * 1024;

export type EditorResult =
  | { ok: true }
  | {
      ok: false;
      /** True when it was stopped for taking longer than its time. */
      timedOut: boolean;
    };

/**
 * Runs an editor's command, the program named, with these arguments. It never
 * rejects: a failure is an answer.
 */
export type RunEditor = (program: string, args: readonly string[]) => Promise<EditorResult>;

/** The answer when nothing was started: not macOS, turned off, or it could not be started. */
export const NOT_RUN: EditorResult = { ok: false, timedOut: false };

/**
 * The editor's own variables, `VSCODE_*`, and Electron's, `ELECTRON_*`. Inside
 * one of VS Code's own terminals they tell its command to send what it is
 * given to that window, or to run as Node. Matched without regard to case.
 */
const EDITOR_OWN = /^(VSCODE_|ELECTRON_)/i;

/** Node's own options, which VS Code's command would pass on to the editor. */
const NODE_OWN = new Set(["NODE_OPTIONS", "NODE_REPL_EXTERNAL_MODULE"]);

/**
 * The environment an editor's command is given: the collector's own, without
 * Agent Lookout's own settings, without the editor's and Electron's own
 * variables, and without `NODE_OPTIONS` and `NODE_REPL_EXTERNAL_MODULE`, so the
 * command acts as it does when run from a terminal outside the editor, and
 * nothing of Agent Lookout's own Node or Electron reaches the editor.
 */
export function editorEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const given: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(childEnvironment(env))) {
    if (!EDITOR_OWN.test(name) && !NODE_OWN.has(name.toUpperCase())) given[name] = value;
  }
  return given;
}

/**
 * Starts an editor's command directly, by its full path, with no shell of the
 * collector's between, stdin closed, the environment `editorEnvironment` gives
 * and a timeout, by default the one an editor's jump has. The arguments reach
 * it as they are given, one by one. What it prints is not read.
 */
export function runEditor(
  program: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<EditorResult> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        program,
        [...args],
        {
          env: editorEnvironment(options.env),
          timeout: options.timeoutMs ?? EDITOR_JUMP_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          windowsHide: true,
        },
        (error) => {
          if (!error) {
            resolve({ ok: true });
            return;
          }
          resolve({ ok: false, timedOut: (error as { killed?: boolean }).killed === true });
        },
      );
      child.stdin?.end();
    } catch {
      resolve(NOT_RUN);
    }
  });
}

/**
 * What the collector brings an editor's window forward with: the editor's own
 * command on macOS, given the collector's environment, and nothing anywhere
 * else or while `AGENT_LOOKOUT_EDITOR_JUMP` is `off`.
 */
export function createEditorRunner(options: {
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): RunEditor {
  const platform = options.platform ?? process.platform;
  const off = editorJumpOff(options.env) || platform !== "darwin";
  return async (program, args) => (off ? NOT_RUN : runEditor(program, args, { env: options.env }));
}
