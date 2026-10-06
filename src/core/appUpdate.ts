// What the Mac app's page and its main process say to each other about
// updates: the routes that only the app answers, and what it says about them.
//
// The app answers these under its own scheme, `agent-lookout://app/`, beside
// the collector's `/api/*`. The standalone server and the dev server never do:
// there, every one of these addresses is the collector's 404.

/** `GET`: the status of updates, an `AppUpdateStatus`. */
export const APP_UPDATE_PATH = "/api/app/update";

/** `POST`, with the body `{}`: checks GitHub for a newer version now. */
export const APP_UPDATE_CHECK_PATH = "/api/app/update/check";

/** `POST`, with the body `{}`: installs the version that is ready, and restarts. */
export const APP_UPDATE_INSTALL_PATH = "/api/app/update/install";

/** `POST`, with the body `{"automatic": true}` or `false`: the switch in Settings. */
export const APP_UPDATE_SETTING_PATH = "/api/app/update/setting";

/** Whether an address belongs to the routes only the Mac app answers. */
export function isAppApiPath(pathname: string): boolean {
  return pathname === "/api/app" || pathname.startsWith("/api/app/");
}

/**
 * What `ACTION_HEADER` says on each of the three POSTs. A page at another
 * origin cannot send a header of this kind without asking first, and is never
 * told yes.
 */
export const APP_UPDATE_ACTIONS = {
  check: "check-for-updates",
  install: "install-update",
  setting: "update-setting",
} as const;

/** The body of `POST /api/app/update/setting`, and nothing else. */
export interface AppUpdateSettingRequest {
  automatic: boolean;
}

/**
 * Why a newer version cannot be installed where this copy of the app runs:
 *
 * translocated  macOS runs it from a copy it made, read-only, because it was
 *               opened where it was downloaded
 * disk-image    it runs from under `/Volumes/`: the disk image it came in, or
 *               another disk
 * read-only     it runs from a folder it cannot change
 * development   it is a development run, `npm run dev:desktop`, not the app
 */
export type InstallRefusal = "translocated" | "disk-image" | "read-only" | "development";

/**
 * Where updates stand:
 *
 * idle            nothing checked since the app started
 * checking        a check is under way
 * up-to-date      the latest release is this version, or older
 * no-release      the latest release has no Mac app, so there is nothing to offer
 * not-for-this-mac
 *                 the latest release is newer, and has no app for this kind
 *                 of Mac, so there is nothing to offer here either
 * downloading     a newer version was found and is being downloaded and checked
 * ready           it is downloaded, checked and waits for Install and Restart
 * installing      Install and Restart was pressed, and the app is quitting
 * cannot-install  a newer version was found, and cannot be installed from here
 * failed          the check, the download or the start of the install did not
 *                 work, with why in words
 */
export type UpdatePhase =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "up-to-date" }
  | { phase: "no-release" }
  | { phase: "not-for-this-mac" }
  | {
      phase: "downloading";
      version: string;
      notesUrl: string;
      /** Bytes so far, and the size the release gives. */
      received: number;
      total: number;
    }
  | { phase: "ready"; version: string; notesUrl: string }
  | { phase: "installing"; version: string; notesUrl: string }
  | { phase: "cannot-install"; version: string; notesUrl: string; refusal: InstallRefusal }
  | {
      phase: "failed";
      step: "check" | "download" | "install";
      /** What went wrong, as the end of a sentence: "GitHub did not answer in time". */
      reason: string;
      /** The version that was found, when the download or the install is what failed. */
      version: string | null;
      notesUrl: string | null;
    };

/** `GET /api/app/update`, and the answer to each of the three POSTs. */
export interface AppUpdateStatus {
  /** The version of this copy of the app. */
  version: string;
  /** Whether the app checks by itself, about once a day. On until the person turns it off. */
  automatic: boolean;
  /** When a check last had an answer from GitHub, or null when none has. */
  lastCheckedAt: number | null;
  /** The page of the project's releases, where a version can be downloaded by hand. */
  releasesUrl: string;
  update: UpdatePhase;
}

/** The 409 of `POST /api/app/update/install`, when no version is ready to install here. */
export interface AppUpdateInstallRefused {
  error: string;
  status: AppUpdateStatus;
}

/**
 * Why a newer version cannot be installed where this copy runs, and what to
 * do, in the words Settings and the app's own dialog both use.
 */
export const INSTALL_REFUSAL_WORDS: Record<InstallRefusal, string> = {
  translocated:
    "macOS runs this copy from a read-only place, because it was opened where it was downloaded. Move Agent Lookout to the Applications folder, open it from there, and check again.",
  "disk-image":
    "This copy runs from its disk image or another disk. Drag Agent Lookout to the Applications folder, open it from there, and check again.",
  "read-only":
    "This copy is in a folder it cannot change. Move Agent Lookout to the Applications folder, open it from there, and check again.",
  development: "This is a development run, which never installs an update.",
};

/**
 * The address of the Settings view with its Updates card in sight, which the
 * app menu's Check for Updates… and the app's notification of a new version
 * open.
 */
export const UPDATES_HASH = "#settings/updates";
