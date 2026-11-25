// What the notification says that is shown when the daily check finds a
// version. It imports nothing from Electron, so it is tested in plain Node.

import type { InstallRefusal } from "../../core/appUpdate.ts";

/**
 * The notification shown once for each version the daily check finds: it is
 * being downloaded, or, where it cannot be installed, Settings says why.
 */
export function foundNotice(
  version: string,
  refusal: InstallRefusal | null,
): { title: string; body: string } {
  return {
    title: `Agent Lookout ${version} is available`,
    body:
      refusal === null
        ? "Agent Lookout is downloading it. Settings will offer Install and Restart."
        : "Open Settings to see how to install it.",
  };
}
