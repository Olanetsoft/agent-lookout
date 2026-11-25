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
//    is no longer whole is never installed: the latest release is looked at
//    again, and what it offers is downloaded. One that is ready stays, and can
//    be installed, until a newer one has been downloaded and checked, it is
//    withdrawn, or the app is found to be where it cannot change itself.
// 4. Only when the person presses Install and Restart does it unpack the zip
//    and start the helper that puts the new bundle in the running one's place
//    once the app has quit, and opens it (`install/installHelper.ts`), and then
//    it quits. It notes the version first, so the copy that opens next, the
//    new one or the old one put back, can say whether the install worked. When
//    it comes to none of that, the version is still ready, and it says why.
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
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
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

/**
 * How long after a check that had no answer the app tries again by itself, and,
 * once for a version until the person checks, after a download that had none.
 */
export const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;

/** How long the app waits to quit after Install and Restart, so the page hears the answer first. */
export const QUIT_DELAY_MS = 500;

/**
 * How long after Install and Restart an app that has not quit says the install
 * did not work: by then the helper has stopped waiting for it, unless the Mac
 * slept, which counts here and not there. A helper that waits still then finds
 * nothing to move, and opens the old app once that quits.
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
  /** Installs the version that is ready, and restarts. Refused, with a status that says why, when it is not installed. */
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

/** The failures of a download that had no answer, which is tried again sooner, once. */
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
  /** Why it was not installed when that was last asked. */
  failed?: string;
}

/** A download, one ready, or an install under way, which a check leaves as it is. */
function underWay(phase: UpdatePhase): boolean {
  return phase.phase === "downloading" || phase.phase === "ready" || phase.phase === "installing";
}

/** Whether a check had no answer, or one that says nothing of a version for this Mac. */
function foundNothing(phase: UpdatePhase): boolean {
  return (
    phase.phase === "no-release" ||
    phase.phase === "not-for-this-mac" ||
    (phase.phase === "failed" && phase.step === "check")
  );
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
  /** Whether the person asked for the check under way, and whether it waits for GitHub. */
  let asked = false;
  let looking = false;
  /** Whether the last check had no answer, or the download it began had none, which is tried again sooner. */
  let unanswered = false;
  /** The version whose download had no answer, which has had its sooner try, until the person checks. */
  let unansweredVersion: string | null = null;
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
      reason:
        lostVersion === null
          ? reason
          : `version ${lostVersion}, downloaded before, is no longer whole, and ${reason}`,
      version,
      notesUrl: version === null ? null : endpoints.notes(version),
    };
  };

  /** Says which version is ready, or else how far the one being downloaded has come. */
  const say = (): void => {
    if (waiting !== null) {
      phase = { phase: "ready", version: waiting.version, notesUrl: waiting.notesUrl };
      if (coming !== null) phase.newer = coming.version;
      if (waiting.failed !== undefined) phase.failed = waiting.failed;
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
  // install worked, or a newer one put in by hand. When it is an older one, the
  // install did not work, and it says so until the person checks again.
  const installed = settings.installingVersion;
  if (installed !== null) {
    save({ installingVersion: null });
    if (isOffered(installed, options.version)) {
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

  /** Removes all of a download but its zip, which can be unpacked again. */
  async function keepZip({ folder, zip }: Download): Promise<void> {
    const names = await readdir(folder).catch(() => []);
    for (const name of names) {
      if (name !== zip.name) await folders.remove(path.join(folder, name));
    }
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
    // It is unpacked again to be installed. Only the zip waits, if it is there still.
    await keepZip(next);
    return (await isStillWhole(next.file, next.zip)) ? null : NOT_SAVED;
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
      if (fault.noAnswer === true && unansweredVersion !== version) {
        unansweredVersion = version;
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
    unansweredVersion = null;
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
    phase = { phase: "idle" };
    say();
  }

  /** A check had an answer. */
  const answered = (): void => {
    unanswered = false;
    save({ lastCheckedAt: now() });
  };

  /** The version the card says could not be installed, if any. */
  const notInstalled = (): string | null =>
    phase.phase === "failed" && phase.step === "install" ? phase.version : null;

  async function look(): Promise<AppUpdateStatus> {
    if (phase.phase === "installing") return status();
    await checkReady();
    if (stopped || current().phase === "installing") return status();
    // An install that did not work stays said through the checks the app makes
    // by itself, until the person checks or a newer version is out.
    if (!underWay(phase) && (asked || notInstalled() === null)) phase = { phase: "checking" };
    lastAttemptAt = now();
    unanswered = true;
    looking = true;
    const answer = await requests.fetchText(endpoints.manifest, {
      ...request,
      maxBytes: MAX_MANIFEST_BYTES,
    });
    looking = false;
    if (!answer.ok) {
      if (answer.failure === "not-found") {
        // The latest release has no Mac app. That is an answer, not a failure.
        answered();
        if (current().phase === "checking") phase = { phase: "no-release" };
      } else if (current().phase === "checking") {
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
      if (current().phase === "checking") {
        phase = failed("check", "the release's update file could not be read");
      }
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

    if (current().phase === "installing") return status();
    // A version withdrawn while it is downloaded is not downloaded to its end.
    if (coming !== null && isOffered(coming.version, offered)) {
      cancel();
      phase = { phase: "idle" };
      say();
    }
    // Another download is left to finish. The next check finds this version.
    if (coming !== null) return status();
    if (waiting?.version === offered) return status();
    if (notInstalled() === offered) return status();

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
      if (!asked) options.onFound?.(offered, refusal);
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
    if (!automatic) {
      asked = true;
      // A download it finds has a sooner try of its own.
      unansweredVersion = null;
      // What the check under way left said makes way for the person's.
      if (looking && phase.phase === "failed") phase = { phase: "checking" };
    }
    checking ??= look().finally(() => {
      checking = null;
      asked = false;
    });
    return checking;
  };

  /**
   * Whether a day has passed since the last check, or it or the download it
   * began had no answer, and a while since the last check or such a download.
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
        // Another version may be out by now, and this one gone from its address.
        phase = { phase: "checking" };
        await check(false);
        // The download this stopped begins again, unless the check found another.
        if (newer !== null && foundNothing(current())) {
          void download(newer.version, newer.notesUrl, newer.zip);
        }
        return refused();
      }
      const fail = async (reason: string): Promise<InstallAnswer> => {
        // Its zip is whole, so it is still ready. What was unpacked of it goes.
        await keepZip(ready);
        ready.failed = reason;
        phase = failed("install", reason, version);
        say();
        if (newer !== null) void download(newer.version, newer.notesUrl, newer.zip);
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
      const giveUp = (): void => {
        handedOver = null;
        save({ installingVersion: null });
        void fail("Agent Lookout did not quit in time to be replaced");
      };
      timers.push(
        setTimeout(() => {
          options.quit();
          // Quitting clears this one. It is set only now, so a Mac that slept
          // does not wake with both due, and give up while the app quits.
          if (!stopped) timers.push(setTimeout(giveUp, INSTALL_GIVE_UP_MS - QUIT_DELAY_MS));
        }, QUIT_DELAY_MS),
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
