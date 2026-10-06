// `agent-lookout start`, and `agent-lookout` with no command: the standalone
// host that `npm start` runs, serving the built dashboard in `distDir`, on
// this machine only, until Ctrl+C. `--port` chooses the port, in place of
// `AGENT_LOOKOUT_PORT`, and `--open` opens the address in the browser once
// the server is listening.

import { urlFor } from "../../collector/hosts/server.ts";
import { runStandalone, type HostProcess, type Printer } from "../../collector/hosts/standalone.ts";
import type { StartOptions } from "../arguments.ts";
import { openInBrowser } from "./openBrowser.ts";

export interface StartCommandOptions extends StartOptions {
  /** The built dashboard: the folder that holds `index.html`. */
  distDir: string;
  env: NodeJS.ProcessEnv;
  print: Printer;
  process: HostProcess;
  /** Opens an address in the browser and resolves with whether it did. Defaults to the system's opener. */
  opener?: (url: string) => Promise<boolean>;
}

/**
 * Starts the server, and resolves with the address it listens on, or with null
 * when it stopped with a message, as `runStandalone` does. A browser that
 * cannot be opened is one line, and the server keeps running.
 */
export async function startCommand(options: StartCommandOptions): Promise<string | null> {
  const env =
    options.port === null
      ? options.env
      : { ...options.env, AGENT_LOOKOUT_PORT: String(options.port) };
  const address = await runStandalone({
    distDir: options.distDir,
    env,
    print: options.print,
    process: options.process,
    portSetting: "--port",
  });
  if (address === null) return null;

  const url = urlFor(address);
  if (options.open) {
    const opened = await (options.opener ?? openInBrowser)(url);
    if (!opened) options.print.error(`The browser could not be opened. Open ${url} in it.`);
  }
  return url;
}
