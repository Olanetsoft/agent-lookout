// What the app says about updates outside its window: the dialog that
// Check for Updates… in the app menu shows when the window is closed, and the
// notification shown when the daily check finds a version.
//
// The words are Settings' own, so the two never say different things. It
// imports nothing from Electron, so it is tested in plain Node.

import {
  INSTALL_REFUSAL_WORDS,
  type AppUpdateStatus,
  type InstallRefusal,
} from "../../core/appUpdate.ts";

/** What pressing a button of the dialog does. */
export type DialogChoice = "install" | "settings" | "release" | "close";

export interface UpdateDialog {
  message: string;
  detail: string;
  /** The buttons, the default first, each with what it does. */
  buttons: readonly { label: string; choice: DialogChoice }[];
  /** What Open Release Page opens: the version's own release, or the list of releases. */
  releaseUrl: string;
}

const OK = { label: "OK", choice: "close" } as const;

/** The dialog for the outcome of a check. */
export function updateDialog(status: AppUpdateStatus): UpdateDialog {
  const releaseUrl =
    "notesUrl" in status.update && status.update.notesUrl !== null
      ? status.update.notesUrl
      : status.releasesUrl;
  return { ...wordsFor(status), releaseUrl };
}

function wordsFor(status: AppUpdateStatus): Omit<UpdateDialog, "releaseUrl"> {
  const { update, version } = status;
  switch (update.phase) {
    case "up-to-date":
      return {
        message: "You're up to date",
        detail: `Agent Lookout ${version} is the newest version.`,
        buttons: [OK],
      };
    case "no-release":
      return {
        message: "The latest release has no Mac app yet",
        detail: `There is nothing to update to. This copy is version ${version}.`,
        buttons: [OK],
      };
    case "not-for-this-mac":
      return {
        message: "The latest release has no app for this kind of Mac",
        detail: `There is nothing to update to. This copy is version ${version}.`,
        buttons: [OK],
      };
    case "downloading":
      return {
        message: `Version ${update.version} is available`,
        detail:
          "Agent Lookout is downloading it now. Settings offers Install and Restart once it has been downloaded and checked.",
        buttons: [{ label: "Open Settings", choice: "settings" }, OK],
      };
    case "ready":
      return {
        message: `Version ${update.version} is available`,
        detail: `It has been downloaded and checked. Agent Lookout quits, puts version ${update.version} in its place and opens it again.`,
        buttons: [
          { label: "Install and Restart", choice: "install" },
          { label: "Later", choice: "close" },
        ],
      };
    case "installing":
      return {
        message: `Installing version ${update.version}`,
        detail: "Agent Lookout quits and opens again as the new version.",
        buttons: [OK],
      };
    case "cannot-install":
      return {
        message: `Version ${update.version} is available`,
        detail: `${INSTALL_REFUSAL_WORDS[update.refusal]} Or download it from its release page.`,
        buttons: [{ label: "Open Release Page", choice: "release" }, OK],
      };
    case "failed":
      return {
        message:
          update.step === "check"
            ? "Agent Lookout could not check for updates"
            : `Version ${update.version} could not be ${update.step === "install" ? "installed" : "downloaded"}`,
        detail: `${update.reason.charAt(0).toUpperCase()}${update.reason.slice(1)}. ${
          update.step === "check"
            ? "Check again later."
            : "Try again later, or download it from the release page."
        }`,
        buttons: [{ label: "Open Release Page", choice: "release" }, OK],
      };
    case "idle":
    case "checking":
      return {
        message: "Checking for updates",
        detail: "Settings shows the answer once GitHub has given it.",
        buttons: [{ label: "Open Settings", choice: "settings" }, OK],
      };
  }
}

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
