import { INSTALL_REFUSAL_WORDS, type AppUpdateStatus } from "@core/appUpdate";
import { clockAt, sentenceStart } from "@dashboard/lib/format";

/**
 * What the Updates card in Settings says, in the Mac app: one line of state,
 * a line under it while a version is downloading or ready, which button the
 * row offers, the link to the version's release notes, and a note when the
 * version cannot be installed here or something did not work.
 *
 * A latest release with no Mac app in it, or none for this kind of Mac, is an
 * answer, not a failure, so it reads as one. Where the note links the
 * version's release page, the line under the state does not link it again.
 * Nothing here is warm: a new version is not a session that needs the person.
 */
export interface UpdateWords {
  state: string;
  /** Under the state: the download's progress, or that it is ready. */
  detail: string | null;
  /** Whether the row offers Install and Restart. */
  install: boolean;
  /** Whether Check for Updates… can be pressed now. */
  canCheck: boolean;
  /** The found version's release notes. */
  notesUrl: string | null;
  /** A note with a title, in the card's info callout. */
  note: { title: string; detail: string; link: string } | null;
}

const MEGABYTE = 1024 * 1024;

/** A size as the download shows it: "34 MB". */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / MEGABYTE)} MB`;
}

/** When the app last had an answer: "14:02", "14:02 on Oct 4", or "Not yet". */
export function lastCheckedWords(status: AppUpdateStatus, now: number): string {
  return status.lastCheckedAt === null ? "Not yet" : clockAt(status.lastCheckedAt, now);
}

export function updateWords(status: AppUpdateStatus): UpdateWords {
  const { update } = status;
  const quiet = { detail: null, install: false, canCheck: true, notesUrl: null, note: null };
  switch (update.phase) {
    case "idle":
      return {
        ...quiet,
        state: status.automatic
          ? "Agent Lookout checks about once a day."
          : "Agent Lookout checks only when you ask.",
      };
    case "checking":
      return { ...quiet, state: "Checking for updates…", canCheck: false };
    case "up-to-date":
      return { ...quiet, state: "You're up to date." };
    case "no-release":
      return { ...quiet, state: "The latest release has no Mac app yet." };
    case "not-for-this-mac":
      return { ...quiet, state: "The latest release has no app for this kind of Mac." };
    case "downloading":
      return {
        ...quiet,
        state: `Version ${update.version} is available.`,
        detail:
          update.total > 0
            ? `Downloading it: ${megabytes(update.received)} of ${megabytes(update.total)}.`
            : "Downloading it.",
        notesUrl: update.notesUrl,
      };
    case "ready":
      return {
        ...quiet,
        state: `Version ${update.version} is available.`,
        detail: "Downloaded and checked.",
        install: true,
        notesUrl: update.notesUrl,
      };
    case "installing":
      return {
        ...quiet,
        state: `Installing version ${update.version}…`,
        detail: "Agent Lookout quits and opens again as the new version.",
        canCheck: false,
        notesUrl: update.notesUrl,
      };
    case "cannot-install":
      return {
        ...quiet,
        state: `Version ${update.version} is available.`,
        note: {
          title: "Agent Lookout cannot update itself here",
          detail: INSTALL_REFUSAL_WORDS[update.refusal],
          link: update.notesUrl,
        },
      };
    case "failed":
      if (update.step === "check") {
        return {
          ...quiet,
          state: "The last check did not work.",
          note: {
            title: "Agent Lookout could not check for updates",
            detail: `${sentenceStart(update.reason)}. Check again in a while.`,
            link: status.releasesUrl,
          },
        };
      }
      return {
        ...quiet,
        state:
          update.version === null
            ? "A newer version is available."
            : `Version ${update.version} is available.`,
        note: {
          title: `${update.version === null ? "The new version" : `Version ${update.version}`} could not be ${
            update.step === "install" ? "installed" : "downloaded"
          }`,
          detail: `${sentenceStart(update.reason)}. Check again to try once more.`,
          link: update.notesUrl ?? status.releasesUrl,
        },
      };
  }
}
