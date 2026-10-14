import { ACTION_HEADER } from "@core/api";
import {
  APP_PLUGIN_INSTALL_PATH,
  APP_PLUGIN_INSTALL_TOLD_ACTION,
  APP_PLUGIN_INSTALL_TOLD_PATH,
  isPluginInstallStep,
  type PluginInstallStatus,
} from "@core/answers/pluginInstall";
import { apiRequest } from "@dashboard/lib/api/apiHost";

/**
 * The page's side of the Mac app's one-time install of its Claude Code
 * plugin: what came of it, and that the Overview said so. Only the Mac app
 * answers these addresses, so only a page in the app's window asks them: the
 * Overview's note does so only there. Like every other request, each goes
 * through `apiRequest`, on the page's own origin.
 */

/** A read or a press is not left waiting on an app that has stopped answering. */
export const PLUGIN_INSTALL_TIMEOUT_MS = 4_000;

/** How often the Overview asks again while the install is under way. */
export const PLUGIN_INSTALL_POLL_MS = 2_000;

/** Reads the app's answer, or null when it is not one. */
export function readPluginInstallStatus(value: unknown): PluginInstallStatus | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { state, step } = value as { state?: unknown; step?: unknown };
  if (state === "idle" || state === "running" || state === "installed") return { state };
  if (state === "failed" && isPluginInstallStep(step)) return { state, step };
  return null;
}

/** Asks the app what came of the install. Null when it did not answer, or answered with something else. */
export async function fetchPluginInstallStatus(): Promise<PluginInstallStatus | null> {
  try {
    const response = await apiRequest(APP_PLUGIN_INSTALL_PATH, {
      signal: AbortSignal.timeout(PLUGIN_INSTALL_TIMEOUT_MS),
    });
    return response.ok ? readPluginInstallStatus(await response.json()) : null;
  } catch {
    return null;
  }
}

/** Tells the app the Overview's note was dismissed, so it is not said again. Resolves with the app's answer, or null. */
export async function requestPluginInstallTold(): Promise<PluginInstallStatus | null> {
  try {
    const response = await apiRequest(APP_PLUGIN_INSTALL_TOLD_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ACTION_HEADER]: APP_PLUGIN_INSTALL_TOLD_ACTION,
      },
      body: "{}",
      signal: AbortSignal.timeout(PLUGIN_INSTALL_TIMEOUT_MS),
    });
    return response.ok ? readPluginInstallStatus(await response.json()) : null;
  } catch {
    return null;
  }
}
