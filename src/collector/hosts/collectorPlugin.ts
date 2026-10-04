import type { Connect, Plugin } from "vite";

import { createCollector, type Collector } from "../collector.ts";
import { isApiPath } from "../handler.ts";
import { readAppVersion } from "../version.ts";

export interface CollectorPluginOptions {
  /**
   * Builds the collector to mount. Defaults to the real one, which reads this
   * machine's sessions. Tests pass one that does not.
   */
  createCollector?: () => Collector;
}

/**
 * Mounts the collector inside the Vite server, so `npm run dev` serves the
 * dashboard and answers `/api/*` from one process. `npm run preview` gets the
 * same treatment.
 *
 * Vite runs a few middlewares of its own before any plugin's: it rejects
 * malformed requests, checks the `Host` header against its allowed hosts and,
 * unless told otherwise, answers cross-origin requests with CORS headers. The
 * collector's handler comes after those and ahead of everything else in Vite.
 * It does its own `Host` and `Origin` checks and never relies on Vite's.
 *
 * The API promises to send no CORS headers, so this plugin turns Vite's CORS
 * middleware off for the dev and preview servers. Left on, Vite would answer a
 * preflight to `/api/*` from another local port with `Access-Control-Allow-*`
 * headers before the handler ever saw the request.
 *
 * `vite.config.ts` imports this by name and leaves it out of Vitest runs, so a
 * test never starts the poller or reads real sessions from this machine.
 */
export function collectorPlugin(options: CollectorPluginOptions = {}): Plugin {
  const create = options.createCollector ?? (() => createCollector({ version: readAppVersion() }));
  let latest: Collector | null = null;

  /**
   * Which collector belongs to which server, by the server's environments. Vite
   * restarts by building a new server before it closes the old one, with this
   * same plugin object in both. Without this record the old server's shutdown
   * would stop the new server's poller and leave the dashboard frozen.
   */
  const owners = new WeakMap<object, Collector>();

  function mount(middlewares: Connect.Server): Collector {
    // If this plugin object is mounted a second time, as when a server is
    // restarted with the same plugins, stop the earlier poller first so two
    // never run side by side.
    latest?.stop();

    const current = create();
    latest = current;
    current.start();

    middlewares.use((req, res, next) => {
      if (isApiPath(req.url)) current.handler(req, res);
      else next();
    });
    return current;
  }

  return {
    name: "agent-lookout:collector",
    apply: "serve",
    config() {
      return { server: { cors: false }, preview: { cors: false } };
    },
    configureServer(server) {
      const current = mount(server.middlewares);
      for (const environment of Object.values(server.environments)) {
        owners.set(environment, current);
      }
      server.httpServer?.once("close", () => current.stop());
    },
    configurePreviewServer(server) {
      const current = mount(server.middlewares);
      server.httpServer.once("close", () => current.stop());
    },
    // Called once for each environment of a dev server that is shutting down,
    // which covers a server in middleware mode, where there is no HTTP server
    // of Vite's own to watch. Only that server's collector is stopped.
    closeBundle() {
      owners.get(this.environment)?.stop();
    },
  };
}
