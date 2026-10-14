import type { MouseEvent } from "react";

import {
  commandLine,
  MARKETPLACE_ADD_ARGS,
  PLUGIN_INSTALL_ARGS,
  PLUGIN_UNINSTALL_ARGS,
  type PluginInstallStatus,
  type PluginInstallStep,
} from "@core/answers/pluginInstall";
import { Button } from "@dashboard/components/ui/controls/Button";
import { Command } from "@dashboard/components/ui/facts/Command";
import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { usePluginInstall } from "@dashboard/hooks/app/usePluginInstall";
import { inAppWindow } from "@dashboard/lib/shell/appWindow";

interface PluginNoticeProps {
  /** Whether the page is in the Mac app's window. Tests say which it is. */
  inApp?: boolean;
  /** What reads the app's answer. Defaults to asking the app. For tests. */
  fetchStatus?: () => Promise<PluginInstallStatus | null>;
  /** What tells the app the note was dismissed. Defaults to telling the app. For tests. */
  markTold?: () => Promise<PluginInstallStatus | null>;
  /** How often to ask again while the install is under way. For tests. */
  pollMs?: number;
}

/** The first sentence of the note when the install did not work, by where it stopped. */
function failedWords(step: PluginInstallStep): string {
  switch (step) {
    case "check":
      return "It could not tell whether the plugin is installed, so it changed nothing.";
    case "unfinished":
      return "The app quit before the install finished.";
    case "marketplace":
    case "install":
      return "Claude Code did not install it.";
    // The list after the install did not name the plugin, or did not run.
    case "confirm":
      return "It could not confirm that Claude Code installed it.";
  }
}

/**
 * Its focus goes to the view once it is dismissed, so the keyboard stays where
 * the eye is and is not dropped to the top of the page.
 */
function keepFocusInView(event: MouseEvent<HTMLElement>): void {
  event.currentTarget.closest<HTMLElement>("main")?.focus({ preventScroll: true });
}

/** A row under the words, as tall as its button. */
const ROW = "mt-3 flex min-h-button flex-wrap items-center gap-2";

/**
 * What the Overview says, once, in the Mac app only, of the app's one-time
 * install of its Claude Code plugin: that it installed it, and how to remove
 * it, or plainly that it could not, with the two commands that install it by
 * hand. Every command is the one the app runs, from `core/answers/pluginInstall.ts`.
 * It is there each time the Overview is drawn until Dismiss is pressed, and
 * never again after that.
 *
 * While the install is under way, or when there is nothing to say, nothing is
 * drawn. It is an info note, as quiet as every other: nothing in it is warm,
 * since the plugin is not a session that needs the person. It may appear after
 * the page has loaded, so it is a status a screen reader is told of.
 *
 * In a browser it is never drawn, and the app is never asked: only the Mac
 * app installs the plugin.
 */
export function PluginNotice({
  inApp = inAppWindow(),
  fetchStatus,
  markTold,
  pollMs,
}: PluginNoticeProps = {}) {
  const { status, dismiss } = usePluginInstall({ inApp, fetchStatus, markTold, pollMs });
  if (!inApp || status === null) return null;
  if (status.state !== "installed" && status.state !== "failed") return null;

  const onDismiss = (event: MouseEvent<HTMLElement>) => {
    keepFocusInView(event);
    dismiss();
  };
  const row = (
    <div className={ROW}>
      <Button size='sm' onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );

  return (
    <div data-slot='plugin-notice' data-state={status.state}>
      {status.state === "installed" ? (
        <Callout title='Agent Lookout installed its Claude Code plugin'>
          <p>
            Allow and Deny on Claude Code&apos;s permission prompts now work from here. A new Claude
            Code session picks it up. To remove it, run this in a terminal:
          </p>
          <div className='mt-2 flex flex-col gap-2'>
            <Command>{commandLine(PLUGIN_UNINSTALL_ARGS)}</Command>
          </div>
          {row}
        </Callout>
      ) : (
        <Callout title='Agent Lookout could not install its Claude Code plugin'>
          <p>
            {failedWords(status.step)} To answer Claude Code&apos;s permission prompts from here,
            run these two commands in a terminal:
          </p>
          <div className='mt-2 flex flex-col gap-2'>
            <Command>{commandLine(MARKETPLACE_ADD_ARGS)}</Command>
            <Command>{commandLine(PLUGIN_INSTALL_ARGS)}</Command>
          </div>
          {row}
        </Callout>
      )}
    </div>
  );
}
