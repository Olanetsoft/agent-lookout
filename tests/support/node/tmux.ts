// Two stand-ins for a person's tmux. `fakeTmux` runs nothing: it writes down
// each command and answers as tmux would. `privateTmux` is the real program on
// a server of the test's own, on its own socket, which is killed when the test
// finishes. No test asks, or changes, the tmux server a person is using.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";

import { onTestFinished } from "vitest";

import { runTmuxBinary, type RunTmux, type TmuxResult } from "@collector/tmux/program";

export interface FakeTmux {
  run: RunTmux;
  /** Every command it was asked to run, in order, as its arguments. */
  ran: string[][];
  /** The commands by name, in order: `list-panes`, `select-window` and so on. */
  names(): string[];
  /** What `list-panes` prints: one pane a line, in the format the collector asks for. */
  panes: string[];
  /** What `list-clients` prints: a session id and a client's name a line. */
  clients: string[];
  /** What `display-message` prints about a pane: its session's id, its window, itself and the name. */
  where: string;
  /** Set to what tmux would print, and every command fails with it. */
  down: string | null;
}

const ok = (stdout = ""): TmuxResult => ({ ok: true, stdout });

/** The name of the command in a list of arguments: the first that is not an option of tmux itself. */
export function commandOf(args: readonly string[]): string {
  return args.find((arg) => !arg.startsWith("-")) ?? "";
}

/**
 * A tmux that runs nothing. A command aimed at a pane fails, as tmux fails,
 * when no listed pane has that id.
 */
export function fakeTmux(start: Partial<Pick<FakeTmux, "panes" | "clients" | "where">> = {}) {
  const tmux: FakeTmux = {
    ran: [],
    names: () => tmux.ran.map(commandOf),
    panes: start.panes ?? [],
    clients: start.clients ?? [],
    where: start.where ?? "$0 0 0 checkout-flow",
    down: null,
    run: async (args) => {
      tmux.ran.push([...args]);
      if (tmux.down !== null) return { ok: false, stderr: tmux.down };
      const command = commandOf(args);
      if (command === "list-panes") return ok(tmux.panes.map((line) => `${line}\n`).join(""));
      if (command === "list-clients") return ok(tmux.clients.map((line) => `${line}\n`).join(""));

      const target = args[args.indexOf("-t") + 1] ?? "";
      const there = tmux.panes.some((line) => line.split(" ")[1] === target);
      if (!there) return { ok: false, stderr: `can't find pane: ${target}` };
      return command === "display-message" ? ok(`${tmux.where}\n`) : ok();
    },
  };
  return tmux;
}

export interface PrivateTmux {
  /** Runs the real tmux against this server and no other. */
  run: RunTmux;
  /** Runs it and gives back what it printed, or throws with what it said. */
  ask(...args: string[]): Promise<string>;
  /** Attaches a client to a session, as a terminal would be, without a terminal. */
  attach(session: string): Promise<void>;
}

/**
 * A tmux server of the test's own: the real binary, on a socket named for this
 * test, with no configuration file read. The server, every pane in it and every
 * client attached here are stopped when the test finishes, however it ends.
 */
export function privateTmux(binary: string): PrivateTmux {
  const socket = `agent-lookout-test-${randomBytes(6).toString("hex")}`;
  // Without these two, tmux would talk to the server this test happens to run inside.
  const env = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;

  const run: RunTmux = (args) =>
    runTmuxBinary(binary, ["-L", socket, "-f", "/dev/null", ...args], { env, timeoutMs: 5_000 });
  const ask = async (...args: string[]) => {
    const result = await run(args);
    if (!result.ok) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  const stops: (() => void)[] = [];

  onTestFinished(async () => {
    for (const stop of stops) stop();
    await run(["kill-server"]);
    // tmux leaves the socket's file behind. It is where tmux keeps every socket.
    const folder = path.join(env.TMUX_TMPDIR ?? "/tmp", `tmux-${process.getuid?.() ?? ""}`);
    await rm(path.join(folder, socket), { force: true });
  });

  return {
    run,
    ask,
    async attach(session) {
      // A control-mode client is a client like any other, and needs no terminal.
      // It stays attached for as long as its stdin stays open.
      const client = spawn(
        binary,
        ["-L", socket, "-f", "/dev/null", "-C", "attach-session", "-t", session],
        { env, stdio: ["pipe", "ignore", "ignore"] },
      );
      stops.push(() => client.kill("SIGKILL"));
      for (let tries = 0; tries < 50; tries += 1) {
        if ((await ask("list-clients", "-F", "#{client_name}")).trim() !== "") return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`No client attached to ${session}.`);
    },
  };
}
