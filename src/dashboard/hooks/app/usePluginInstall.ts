import { useCallback, useEffect, useState } from "react";

import type { PluginInstallStatus } from "@core/answers/pluginInstall";
import {
  fetchPluginInstallStatus,
  PLUGIN_INSTALL_POLL_MS,
  requestPluginInstallTold,
} from "@dashboard/lib/answer/pluginInstall";

export interface PluginInstallOptions {
  /** Whether the page is in the Mac app's window. In a browser nothing is asked. */
  inApp: boolean;
  /** What reads the app's answer. For tests. */
  fetchStatus?: () => Promise<PluginInstallStatus | null>;
  /** What tells the app the note was dismissed. For tests. */
  markTold?: () => Promise<PluginInstallStatus | null>;
  /** How often to ask again while the install is under way. For tests. */
  pollMs?: number;
}

export interface PluginInstall {
  /** The app's answer, or null before it has given one, or when it gave none. */
  status: PluginInstallStatus | null;
  /** Hides the note at once, and tells the app it was said. */
  dismiss: () => void;
}

/**
 * Whether the note was dismissed on this page. The Overview is drawn anew at
 * each change of view, so a dismissal is kept here, for as long as the page
 * is open, and not only in the note: one the app did not hear stays hidden
 * until the app next opens, when the app says it again.
 */
let dismissedHere = false;

/** For tests: forget a dismissal made on this page. */
export function resetPluginInstallForTests(): void {
  dismissedHere = false;
}

/**
 * What came of the Mac app's one-time install of its Claude Code plugin, read
 * once when the Overview is drawn, and again every few seconds while it is
 * under way, until it ends. Only the app answers, so with `inApp` false, as in
 * a browser, it asks nothing, ever.
 */
export function usePluginInstall({
  inApp,
  fetchStatus = fetchPluginInstallStatus,
  markTold = requestPluginInstallTold,
  pollMs = PLUGIN_INSTALL_POLL_MS,
}: PluginInstallOptions): PluginInstall {
  const [status, setStatus] = useState<PluginInstallStatus | null>(null);
  const [dismissed, setDismissed] = useState(dismissedHere);

  useEffect(() => {
    if (!inApp) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      void fetchStatus().then((answer) => {
        if (!live) return;
        setStatus(answer);
        if (answer?.state === "running") timer = setTimeout(read, pollMs);
      });
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [inApp, fetchStatus, pollMs]);

  const dismiss = useCallback(() => {
    dismissedHere = true;
    setDismissed(true);
    // Hidden whatever the app answers. One that did not hear it says it again at the next launch.
    void markTold();
  }, [markTold]);

  return { status: dismissed ? null : status, dismiss };
}
