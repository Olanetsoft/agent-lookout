// The Mac app's updates, behind one small interface, `Updater`, which is all
// that the routes, the menu and `main.ts` know of them.
//
// The app is not signed with a Developer ID, and Squirrel, which
// electron-updater uses on a Mac, cannot install into an app that is not, so
// the app updates itself:
//
// 1. It reads the latest release's `latest-mac.yml` from GitHub
//    (`release/endpoints.ts`), at start and then about once a day while the
//    switch in Settings is on, or when the person asks. A release that is not
//    newer, or is a prerelease, is never offered (`release/version.ts`).
// 2. For a newer one, it downloads the zip for this kind of Mac into a folder
//    of its own (`install/updateFolders.ts`), checking its size and SHA-512
//    against the manifest as it is written (`release/releaseRequest.ts`),
//    unpacks it with ditto and checks that the bundle in it is this app at
//    that version (`install/bundleCheck.ts`). Only the zip is kept.
// 3. The zip can wait there for days, so its size and SHA-512 are checked again
//    at each check, and when the person presses Install and Restart. One that
//    is no longer whole is never installed: it is downloaded again, or the
//    newer one that is out is. One that is ready stays, and can be installed,
//    until a newer one has been downloaded and checked.
// 4. Only when the person presses Install and Restart does it unpack the zip
//    and start the helper that puts the new bundle in the running one's place
//    once the app has quit, and opens it (`install/installHelper.ts`), and then
//    it quits. It notes the version first, so the copy that opens next, the
//    new one or the old one put back, can say whether the install worked.
//
// Where the app cannot change its own bundle, it says so and offers the
// release page instead (`install/installLocation.ts`). A development run
// checks only when asked and never installs.
//
// When the app is signed, this can move to electron-updater: a second
// `createUpdater` that keeps the `Updater` interface and the status it gives.
//
// Nothing here imports Electron, so it is tested in plain Node, with a fake
// release on a server of the test's own and fake timers for the schedule.

import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";

import type { AppUpdateStatus, InstallRefusal, UpdatePhase } from "../../core/appUpdate.ts";
import { bundleFacts, runProgram, unpackApp, type RunProgram } from "./install/bundleCheck.ts";
import {
  HELPER_WAIT_MS,
  startDetached,
  startHelper,
  type StartDetached,
} from "./install/installHelper.ts";
import { installRefusal, type CanWrite } from "./install/installLocation.ts";
import { createUpdateFolders, type Removal } from "./install/updateFolders.ts";
import { isStillWhole } from "./release/downloadCheck.ts";
import { GITHUB_RELEASES, type ReleaseEndpoints } from "./release/endpoints.ts";
import {
  MAX_MANIFEST_BYTES,
  readManifest,
  zipFor,
  type MacArch,
  type ReleaseFile,
} from "./release/manifest.ts";
import {
  downloadFile,
  fetchText,
  type Fetched,
  type RequestFailure,
} from "./release/releaseRequest.ts";
import { isOffered } from "./release/version.ts";
import type { UpdateSettings, UpdateSettingsStore } from "./updateSettings.ts";

/** How long after the app starts it looks, so the check does not slow the start. */
export const FIRST_CHECK_DELAY_MS = 15_000;

/** How often the app looks by itself: once a day. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * How often it asks itself whether a day has passed. A timer of a whole day
 * would drift while the Mac sleeps, so a short one asks, and the time of the
 * last check decides.
 */
export const TICK_MS = 60 * 60 * 1000;

/** How long after a check or a download that had no answer the app tries again by itself. */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** How long the app waits to quit after Install and Restart, so the page hears the answer first. */
export const QUIT_DELAY_MS = 500;

/**
 * How long after Install and Restart an app that has not quit says the install
 * did not work: by then the helper has stopped waiting for it.
 */
export const INSTALL_GIVE_UP_MS = HELPER_WAIT_MS + 60_000;

export type InstallAnswer =
  { ok: true; status: AppUpdateStatus } | { ok: false; status: AppUpdateStatus };

export interface Updater {
  /** Where updates stand now. */
  status(): AppUpdateStatus;
  /** Looks for a newer version now, as the person asked, whether or not the switch is on. */
  check(): Promise<AppUpdateStatus>;
  /** The switch in Settings: whether the app looks by itself, about once a day. */
  setAutomatic(on: boolean): AppUpdateStatus;
  /** Installs the version that is ready, and restarts. Refused when none is ready or the app cannot be changed where it is. */
  install(): Promise<InstallAnswer>;
  /** Begins looking by itself, at start and then about once a day, while the switch is on. */
  start(): void;
  /** Stops looking, and removes what was downloaded unless it is being installed. */
  stop(): void;
}

export interface UpdaterOptions {
  /** This copy's version. */
  version: string;
  /** This Mac's kind, whose zip is downloaded. */
  arch: MacArch;
  /** Whether this is the packaged app. A development run checks only when asked and never installs. */
  packaged: boolean;
  /** The running app's bundle, or null when it is not in one. */
  bundle: string | null;
  /** Where the switch, the time of the last check and the last version told of are kept. */
  settings: UpdateSettingsStore;
  /** The app's own folder of user data, in which a download waits in a folder of its own. */
  dataDir: string;
  /** The system's temporary folder, where 0.2.31 and earlier made theirs. What they left is removed. */
  tempDir: string;
  /** What removes those folders: Electron's `original-fs`, which removes an `.asar` too. */
  removal: Removal;
  /**
   * Told when a check the app made by itself finds a version it has not told
   * of before and this Mac has an app in, with why it cannot be installed
   * where the app runs, or null when it is being downloaded.
   */
  onFound?: (version: string, refusal: InstallRefusal | null) => void;
  /** Quits the app, once the helper waits for it to. */
  quit: () => void;
  /** Where a check or a download that failed is written: the app's log. */
  warn?: (line: string) => void;
  /** Where releases are looked for. Defaults to the project's on GitHub. Tests pass their own. */
  endpoints?: ReleaseEndpoints;
  /**
   * What reads `latest-mac.yml` and downloads a zip. Defaults to the requests
   * in `release/releaseRequest.ts`. Unit tests pass ones that open no socket.
   */
  requests?: { fetchText: typeof fetchText; downloadFile: typeof downloadFile };
  /** Defaults to Node's `access` with `W_OK`. */
  canWrite?: CanWrite;
  /** Runs ditto and plutil. */
  run?: RunProgram;
  /** Starts the helper. Tests pass one that starts nothing. */
  startDetached?: StartDetached;
  pid?: number;
  now?: () => number;
  /** How long a request may wait for an answer or for more bytes. */
  requestTimeoutMs?: number;
}

const NOT_SAVED: Fault = { reason: "the download could not be saved" };

const canWriteHere: CanWrite = (target) => {
  try {
    accessSync(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

/** Why a request failed, as the end of a sentence the page can show. */
export function failureWords(failure: RequestFailure, status?: number): string {
  switch (failure) {
    case "not-found":
      return "the file is no longer in the release";
    case "refused":
      return "GitHub sent the request to an address the app does not go to";
    case "too-many-redirects":
      return "GitHub redirected the request too many times";
    case "too-large":
      return "the file was larger than the release says";
    case "timed-out":
      return "GitHub did not answer in time";
    case "too-slow":
      return "the download took longer than an hour";
    case "status":
      return status === undefined
        ? "GitHub's answer could not be understood"
        : `GitHub answered with status ${status}`;
    case "network":
      return "GitHub could not be reached";
    case "wrong-size":
      return "the download was not the size the release gives";
    case "wrong-hash":
      return "the download did not match the SHA-512 the release gives";
    case "not-saved":
      return "the download could not be saved";
  }
}

/** The failures of a download that had no answer, which is tried again as a check that had none is. */
const NO_ANSWER: readonly RequestFailure[] = ["network", "timed-out", "too-slow", "status"];

/** Why a version could not be downloaded, and whether there was no answer. */
interface Fault {
  reason: string;
  noAnswer?: boolean;
}

function reasonOf(answer: Extract<Fetched<unknown>, { ok: false }>): string {
  return failureWords(answer.failure, answer.status);
}

/** A version that is downloaded or being downloaded, and where. */
interface Download {
  version: string;
  notesUrl: string;
  /** What the release says of its zip. */
  zip: ReleaseFile;
  /** Bytes so far. */
  received: number;
  /** Stops it, and ditto when it is being unpacked. */
  stop: AbortController;
  /** The updater's folder for it, and the zip in that folder, once it is made. */
  folder: string;
  file: string;
}

/** A download, one ready, or an install under way, which a check leaves as it is. */
function underWay(phase: UpdatePhase): boolean {
  return phase.phase === "downloading" || phase.phase === "ready" || phase.phase === "installing";
}

export function createUpdater(options: UpdaterOptions): Updater {
  const endpoints = options.endpoints ?? GITHUB_RELEASES;
  const now = options.now ?? Date.now;
  const canWrite = options.canWrite ?? canWriteHere;
  const run = options.run ?? runProgram;
  const pid = options.pid ?? process.pid;
  const requests = options.requests ?? { fetchText, downloadFile };
  const request = {
    userAgent: `Agent-Lookout/${options.version}`,
    allow: endpoints.allow,
    timeoutMs: options.requestTimeoutMs,
  };

  let settings: UpdateSettings = options.settings.read();
  let phase: UpdatePhase = { phase: "idle" };
  let checking: Promise<AppUpdateStatus> | null = null;
  let lastAttemptAt: number | null = null;
  /** Whether the last download had no answer, or a check found the version that was ready lost, and none has had an answer since. */
  let unanswered = false;
  const folders = createUpdateFolders(options);
  /** The version being downloaded. */
  let coming: Download | null = null;
  /** The version downloaded and checked, which waits for Install and Restart. */
  let waiting: Download | null = null;
  /** The version that waited and was no longer whole, until one is ready again. */
  let lostVersion: string | null = null;
  /** The folder of the version the helper was started for, which it needs once the app has quit. */
  let handedOver: string | null = null;
  let ownIdentifier: string | null = null;
  let stopped = false;
  const timers: ReturnType<typeof setTimeout>[] = [];

  /** The phase now. A download that runs on its own changes it while a check waits for GitHub. */
  const current = (): UpdatePhase => phase;

  const save = (change: Partial<UpdateSettings>): void => {
    settings = { ...settings, ...change };
    options.settings.write(settings);
  };

  const status = (): AppUpdateStatus => ({
    version: options.version,
    automatic: settings.automatic,
    lastCheckedAt: settings.lastCheckedAt,
    releasesUrl: endpoints.releases,
    update: phase,
  });

  const refusalHere = (): InstallRefusal | null =>
    options.packaged ? installRefusal(options.bundle, canWrite) : "development";

  const failed = (
    step: "check" | "download" | "install",
    reason: string,
    version: string | null = null,
  ): UpdatePhase => {
    options.warn?.(
      step === "check"
        ? `The check for a newer version of Agent Lookout did not work: ${reason}.`
        : `Version ${version} of Agent Lookout could not be ${step === "install" ? "installed" : "downloaded"}: ${reason}.`,
    );
    return {
      phase: "failed",
      step,
      reason,
      version,
      notesUrl: version === null ? null : endpoints.notes(version),
    };
  };

  /** Says which version is ready, or else how far the one being downloaded has come. */
  const say = (): void => {
    if (waiting !== null) {
      phase = { phase: "ready", version: waiting.version, notesUrl: waiting.notesUrl };
      if (coming !== null) phase.newer = coming.version;
    } else if (coming !== null) {
      const { version, notesUrl, received, zip } = coming;
      phase = { phase: "downloading", version, notesUrl, received, total: zip.size };
      if (lostVersion !== null) phase.lost = lostVersion;
    }
  };

  /** Throws away the version that is ready, if there is one. */
  const dropReady = async (): Promise<void> => {
    const old = waiting;
    waiting = null;
    if (old !== null) await folders.remove(old.folder);
  };

  /** Stops a download under way, if there is one. Its own folder goes as it ends. */
  const cancel = (): void => {
    coming?.stop.abort();
    coming = null;
  };

  const discard = (): Promise<void> => {
    cancel();
    lostVersion = null;
    return dropReady();
  };

  /** Forgets the version that was ready, since its zip is gone or no longer whole. */
  const lose = ({ version }: Download): void => {
    options.warn?.(
      `Version ${version} of Agent Lookout can no longer be installed: its download is no longer whole.`,
    );
    lostVersion = version;
    void dropReady();
  };

  /**
   * This app's own bundle identifier, from its `Info.plist`. Kept once read,
   * and read again next time when it could not be, so one slow `plutil` does
   * not refuse every download until the app restarts.
   */
  const identifier = async (): Promise<string | null> => {
    if (ownIdentifier !== null || options.bundle === null) return ownIdentifier;
    ownIdentifier = (await bundleFacts(options.bundle, run))?.identifier ?? null;
    return ownIdentifier;
  };

  // The copy that opens after Install and Restart is the new version when the
  // install worked. When it is any other, the helper put this one back, and
  // says so until the person checks again.
  const installed = settings.installingVersion;
  if (installed !== null) {
    save({ installingVersion: null });
    if (installed !== options.version) {
      phase = failed(
        "install",
        "the new version could not be put in this copy's place and opened",
        installed,
      );
    }
  }

  /** Unpacks a download into its own folder, and checks that what is in it is this app at its version. */
  async function unpack({
    version,
    folder,
    file,
    stop,
  }: Download): Promise<{ app: string } | Fault> {
    const app = await mkdtemp(path.join(folder, "app-"))
      .then((into) => unpackApp(file, into, run, stop.signal))
      .catch(() => null);
    if (app === null) return { reason: "the download could not be unpacked" };
    const [facts, own] = await Promise.all([bundleFacts(app, run), identifier()]);
    if (facts === null || own === null || facts.identifier !== own) {
      return { reason: "the download is not this app" };
    }
    if (facts.version !== version) {
      return { reason: `the download is version ${facts.version}, not ${version}` };
    }
    return { app };
  }

  /** Downloads a version into a folder of its own and checks it. Gives why it could not be, or null. */
  async function fetchAndCheck(next: Download): Promise<Fault | null> {
    try {
      next.folder = folders.make();
    } catch {
      return NOT_SAVED;
    }
    next.file = path.join(next.folder, next.zip.name);
    const address = endpoints.download(next.version, next.zip.name);
    const fetched = await requests.downloadFile(address, next.file, next.zip, {
      ...request,
      signal: next.stop.signal,
      onProgress: (received) => {
        next.received = received;
        if (coming === next) say();
      },
    });
    if (!fetched.ok) {
      return { reason: reasonOf(fetched), noAnswer: NO_ANSWER.includes(fetched.failure) };
    }
    if (stopped || coming !== next) return null;
    const unpacked = await unpack(next);
    if ("reason" in unpacked) return unpacked;
    // It is unpacked again to be installed. Only the zip waits.
    await folders.remove(path.dirname(unpacked.app));
    return null;
  }

  async function download(version: string, notesUrl: string, zip: ReleaseFile): Promise<void> {
    if (stopped) return;
    const next: Download = {
      version,
      notesUrl,
      zip,
      received: 0,
      stop: new AbortController(),
      folder: "",
      file: "",
    };
    coming = next;
    // Said at once, so the answer to the check that found it says so.
    say();
    const fault = await fetchAndCheck(next).catch(() => NOT_SAVED);
    if (fault !== null || stopped || coming !== next) {
      if (next.folder !== "") await folders.remove(next.folder);
      if (fault === null || stopped || coming !== next) return;
      coming = null;
      if (fault.noAnswer === true) {
        unanswered = true;
        lastAttemptAt = now();
      }
      phase = failed("download", fault.reason, version);
      // The one that was ready before still is.
      say();
      return;
    }
    coming = null;
    const older = waiting;
    waiting = next;
    lostVersion = null;
    say();
    if (older !== null) await folders.remove(older.folder);
  }

  /** Forgets the version that is ready when its zip is gone or no longer whole. */
  async function checkReady(): Promise<void> {
    const ready = waiting;
    if (ready === null || (await isStillWhole(ready.file, ready.zip))) return;
    // Install and Restart was pressed meanwhile, and looks for itself, or a newer one is ready.
    if (stopped || waiting !== ready || current().phase === "installing") return;
    lose(ready);
    unanswered = true;
    phase = { phase: "idle" };
    say();
  }

  /** A check had an answer. */
  const answered = (): void => {
    unanswered = false;
    save({ lastCheckedAt: now() });
  };

  async function look(automatic: boolean): Promise<AppUpdateStatus> {
    if (phase.phase === "installing") return status();
    await checkReady();
    if (current().phase === "installing") return status();
    const before = phase;
    // An install that did not work stays said through the checks the app makes
    // by itself, until the person checks or a newer version is out.
    const held =
      automatic && before.phase === "failed" && before.step === "install" ? before : null;
    const leave = underWay(before) || held !== null;
    if (!leave) phase = { phase: "checking" };
    lastAttemptAt = now();
    const answer = await requests.fetchText(endpoints.manifest, {
      ...request,
      maxBytes: MAX_MANIFEST_BYTES,
    });
    if (!answer.ok) {
      if (answer.failure === "not-found") {
        // The latest release has no Mac app. That is an answer, not a failure.
        answered();
        if (!leave) phase = { phase: "no-release" };
      } else if (!leave) {
        phase = failed(
          "check",
          answer.failure === "too-large"
            ? "the release's update file is too large"
            : reasonOf(answer),
        );
      }
      return status();
    }

    const manifest = readManifest(answer.value);
    if (manifest === null) {
      if (!leave) phase = failed("check", "the release's update file could not be read");
      return status();
    }
    answered();

    const offered = manifest.version;
    if (!isOffered(offered, options.version)) {
      if (current().phase !== "installing") {
        await discard();
        phase = { phase: "up-to-date" };
      }
      return status();
    }

    // A download is left to finish, of another version too. The next check finds this one.
    if (coming !== null || current().phase === "installing") return status();
    if (waiting?.version === offered) return status();
    if (held !== null && held.version === offered) return status();

    const notesUrl = endpoints.notes(offered);
    const zip = zipFor(manifest, options.arch);
    if (zip === null) {
      // An answer, as no release is: there is nothing for this Mac to update to.
      if (!underWay(current())) phase = { phase: "not-for-this-mac" };
      return status();
    }
    const refusal = refusalHere();
    // Told of once for each version, and only when the app looked by itself.
    if (settings.notifiedVersion !== offered) {
      save({ notifiedVersion: offered });
      if (automatic) options.onFound?.(offered, refusal);
    }
    if (refusal !== null) {
      await discard();
      phase = { phase: "cannot-install", version: offered, notesUrl, refusal };
      return status();
    }
    // A version that is ready stays until a newer one is. One that was withdrawn since does not.
    if (waiting !== null && !isOffered(offered, waiting.version)) void dropReady();
    void download(offered, notesUrl, zip);
    return status();
  }

  const check = (automatic: boolean): Promise<AppUpdateStatus> => {
    checking ??= look(automatic).finally(() => {
      checking = null;
    });
    return checking;
  };

  /**
   * Whether a day has passed since the last check, or the download it found had
   * no answer or is no longer whole, and a while since the last check or
   * download that failed.
   */
  const due = (): boolean => {
    const at = now();
    const last = settings.lastCheckedAt;
    if (!unanswered && last !== null && at >= last && at - last < CHECK_EVERY_MS) return false;
    if (lastAttemptAt !== null && at >= lastAttemptAt && at - lastAttemptAt < RETRY_AFTER_MS) {
      return false;
    }
    return true;
  };

  /**
   * Removes what an earlier run left. While the app in this one's place is
   * another version, the helper has put it there under this copy, and the old
   * app it moved aside stays until that version has run.
   */
  const sweep = async (): Promise<void> => {
    if (options.bundle === null) return;
    const inPlace = await bundleFacts(options.bundle, run);
    if (!stopped && inPlace?.version === options.version) await folders.sweep();
  };

  const tick = (): void => {
    if (stopped || !settings.automatic || checking !== null || !due()) return;
    void check(true);
  };

  return {
    status,
    check: () => check(false),
    setAutomatic(on) {
      save({ automatic: on });
      return status();
    },
    async install() {
      const refused = (): InstallAnswer => ({ ok: false, status: status() });
      const ready = waiting;
      if (phase.phase !== "ready" || ready === null) return refused();
      const { version, notesUrl } = ready;
      const refusal = refusalHere();
      const bundle = options.bundle;
      if (refusal !== null || bundle === null) {
        phase = { phase: "cannot-install", version, notesUrl, refusal: refusal ?? "read-only" };
        await discard();
        return refused();
      }
      phase = { phase: "installing", version, notesUrl };
      const newer = coming;
      cancel();
      // It may have waited for days, so it is looked at again, whole.
      const whole = await isStillWhole(ready.file, ready.zip);
      if (stopped) return refused();
      if (!whole) {
        lose(ready);
        // The newer one takes its place, when there is one.
        const next = newer ?? ready;
        void download(next.version, next.notesUrl, next.zip);
        return refused();
      }
      const fail = async (reason: string): Promise<InstallAnswer> => {
        phase = failed("install", reason, version);
        await discard();
        return refused();
      };
      const unpacked = await unpack(ready);
      const aside = path.join(ready.folder, "previous", path.basename(bundle));
      const made = await mkdir(path.dirname(aside)).then(
        () => true,
        () => false,
      );
      if (stopped) {
        // What was unpacked after the folder was removed goes too.
        await folders.remove(ready.folder);
        return refused();
      }
      if ("reason" in unpacked) return fail(unpacked.reason);
      const plan = { pid, bundle, replacement: unpacked.app, aside };
      // Noted before the helper starts, so the copy that opens next knows.
      save({ installingVersion: version });
      handedOver = ready.folder;
      if (!made || !(await startHelper(plan, options.startDetached ?? startDetached))) {
        handedOver = null;
        save({ installingVersion: null });
        return fail("the helper that replaces the app could not be started");
      }
      timers.push(setTimeout(() => options.quit(), QUIT_DELAY_MS));
      // Quitting clears this. An app still running by then has outlasted the helper.
      timers.push(
        setTimeout(() => {
          if (phase.phase !== "installing") return;
          handedOver = null;
          save({ installingVersion: null });
          void fail("Agent Lookout did not quit in time to be replaced");
        }, INSTALL_GIVE_UP_MS),
      );
      return { ok: true, status: status() };
    },
    start() {
      if (!options.packaged || stopped) return;
      timers.push(
        setTimeout(() => {
          void sweep();
          tick();
        }, FIRST_CHECK_DELAY_MS),
      );
      timers.push(setInterval(tick, TICK_MS));
    },
    stop() {
      stopped = true;
      for (const timer of timers.splice(0)) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      // Nothing is written once they are stopped, ditto too, which would outlive the app.
      coming?.stop.abort();
      waiting?.stop.abort();
      // What is being installed stays for the helper. Anything else goes.
      folders.removeAll(handedOver);
    },
  };
}
