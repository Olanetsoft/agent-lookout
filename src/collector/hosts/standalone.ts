// The standalone host: the built dashboard and `/api/*` from one Node process,
// on this machine only. `serve.ts` runs it for `npm start`.
//
// Everything it would otherwise take from the process it runs in is passed in:
// the folder of built files, the environment, where messages go, and the
// process to hang the stop signals on and to end. Tests run it against a
// temporary folder, without a build and without starting another process.

import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { createCollector } from "../collector.ts";
import { readAppVersion } from "../version.ts";
import {
  createAppServer,
  listenOnLoopback,
  resolveBindHost,
  resolvePort,
  urlFor,
} from "./server.ts";

/** Where the messages for the person go. `npm start` passes `console`. */
export interface Printer {
  log(line: string): void;
  error(line: string): void;
}

/** What the host needs from the process it runs in. `npm start` passes `process`. */
export interface HostProcess {
  /** Listens once for a signal that asks the server to stop. */
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  /** Ends the process with this exit code. */
  exit(code: number): void;
}

export interface StandaloneOptions {
  /** The built dashboard: the folder that holds `index.html`, normally `dist/`. */
  distDir: string;
  /**
   * Where the settings are read: `AGENT_LOOKOUT_HOST`, `AGENT_LOOKOUT_PORT`,
   * each adapter's own and the email settings.
   */
  env: NodeJS.ProcessEnv;
  print: Printer;
  process: HostProcess;
}

/**
 * Starts the standalone server and stops it on SIGINT or SIGTERM, ending the
 * process with 0 once it has closed.
 *
 * A problem the person can act on, such as a refused address, a taken port or a
 * missing build, is printed as a sentence and ends the process with 1.
 *
 * Resolves with the address it listens on, or with null when it stopped with a
 * message. A real process has ended by then; one passed in by a test may not.
 */
export async function runStandalone(options: StandaloneOptions): Promise<AddressInfo | null> {
  const { distDir, env, print, process: host } = options;

  const stopWith = (message: string): null => {
    print.error(message);
    host.exit(1);
    return null;
  };

  // What the person asked for is checked first, so a mistyped address or port
  // is reported as that and not hidden behind another message.
  let bindHost: string;
  let port: number;
  try {
    bindHost = resolveBindHost(env);
    port = resolvePort(env);
  } catch (error) {
    return stopWith((error as Error).message);
  }

  if (!existsSync(path.join(distDir, "index.html"))) {
    return stopWith(
      "The dashboard has not been built yet. Run `npm run build`, then `npm start` again.",
    );
  }

  const collector = createCollector({
    version: readAppVersion(),
    env,
    warn: (line) => print.error(line),
  });
  const server = createAppServer({ distDir, api: collector.handler });

  let address: AddressInfo;
  try {
    address = await listenOnLoopback(server, bindHost, port);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      return stopWith(
        `Port ${port} is already in use. Stop the other program, or choose another port with AGENT_LOOKOUT_PORT.`,
      );
    }
    if (code === "EACCES") {
      return stopWith(
        `This user may not listen on port ${port}. Choose another port with AGENT_LOOKOUT_PORT.`,
      );
    }
    return stopWith((error as Error).message);
  }

  collector.start();
  print.log(`Agent Lookout is running at ${urlFor(address)}`);
  print.log("It listens on this machine only. Press Ctrl+C to stop.");

  const shutDown = () => {
    collector.stop();
    server.close(() => host.exit(0));
    // Open browser tabs keep their connections alive. Do not wait for them.
    server.closeAllConnections();
  };
  host.once("SIGINT", shutDown);
  host.once("SIGTERM", shutDown);

  return address;
}
