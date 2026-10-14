// The Claude Code plugin the Mac app installs once, the first time it opens:
// the commands it runs, as `claude` arguments, and what its page and its main
// process say to each other about it. The page shows the same commands, so
// what it shows is what was run.
//
// The app answers these routes under its own scheme, `agent-lookout://app/`,
// beside its routes for updates. The standalone server and the dev server
// never do: there, the GET is the collector's 404 and the POST its 405.

/** The plugin's id in Claude Code, `<plugin>@<marketplace>`. */
export const PLUGIN_ID = "agent-lookout@agent-lookout";

/** The marketplace the plugin comes from: this repository on GitHub. */
export const PLUGIN_MARKETPLACE = "Olanetsoft/agent-lookout";

/** Lists the plugins Claude Code has installed. The app keeps only whether one line names `PLUGIN_ID`. */
export const PLUGIN_LIST_ARGS = ["plugin", "list"] as const;

/** Adds the marketplace to Claude Code. */
export const MARKETPLACE_ADD_ARGS = ["plugin", "marketplace", "add", PLUGIN_MARKETPLACE] as const;

/** Installs the plugin from it. */
export const PLUGIN_INSTALL_ARGS = ["plugin", "install", PLUGIN_ID] as const;

/** Removes the plugin. Shown to the person, and never run. */
export const PLUGIN_UNINSTALL_ARGS = ["plugin", "uninstall", PLUGIN_ID] as const;

/** A command as a person types it in a terminal: `claude plugin install agent-lookout@agent-lookout`. */
export function commandLine(args: readonly string[]): string {
  return ["claude", ...args].join(" ");
}

/** `GET`: what came of the install, a `PluginInstallStatus`. */
export const APP_PLUGIN_INSTALL_PATH = "/api/app/claude-plugin";

/** `POST`, with the body `{}`: the Overview said what came of it, so it is not said again. */
export const APP_PLUGIN_INSTALL_TOLD_PATH = "/api/app/claude-plugin/told";

/**
 * What `ACTION_HEADER` says on the POST. A page at another origin cannot send
 * a header of this kind without asking first, and is never told yes.
 */
export const APP_PLUGIN_INSTALL_TOLD_ACTION = "plugin-install-told";

/** Whether an address belongs to the plugin install's routes. */
export function isPluginInstallPath(pathname: string): boolean {
  return pathname === APP_PLUGIN_INSTALL_PATH || pathname.startsWith(`${APP_PLUGIN_INSTALL_PATH}/`);
}

/**
 * Where an install that did not work stopped:
 *
 * check        `claude plugin list` did not work, so nothing was changed
 * marketplace  `claude plugin marketplace add` did not work
 * install      `claude plugin install` did not work
 * confirm      both worked, and `claude plugin list` then did not name the plugin,
 *              or could not be run
 * unfinished   the app quit before the install finished
 */
export type PluginInstallStep = "check" | "marketplace" | "install" | "confirm" | "unfinished";

/** Every step, in the order they are named above. */
export const PLUGIN_INSTALL_STEPS: readonly PluginInstallStep[] = [
  "check",
  "marketplace",
  "install",
  "confirm",
  "unfinished",
];

/** Whether a value is one of the steps. */
export function isPluginInstallStep(value: unknown): value is PluginInstallStep {
  return typeof value === "string" && (PLUGIN_INSTALL_STEPS as readonly string[]).includes(value);
}

/**
 * `GET /api/app/claude-plugin`, and the answer to the POST:
 *
 * idle       nothing to say: not tried, nothing to do, found installed
 *            already, turned off, or already said
 * running    the install is under way now
 * installed  it installed the plugin, and `claude plugin list` names it, and
 *            the Overview has not said so yet
 * failed     it could not, at `step`, and the Overview has not said so yet
 */
export type PluginInstallStatus =
  | { state: "idle" }
  | { state: "running" }
  | { state: "installed" }
  | { state: "failed"; step: PluginInstallStep };
