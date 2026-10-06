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
// 2. For a newer one, it downloads the zip for this kind of Mac into a
//    temporary folder of its own, checking its size and SHA-512 against the
//    manifest as it is written (`release/releaseRequest.ts`), unpacks it with
//    ditto and checks that the bundle in it is this app at that version
//    (`install/bundleCheck.ts`).
// 3. Only when the person presses Install and Restart does it start the helper
//    that puts the new bundle in the running one's place once the app has
//    quit, and opens it (`install/installHelper.ts`), and then it quits. It
//    notes the version first, so the copy that opens next, the new one or the
//    old one put back, can say whether the install worked.
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

import { accessSync, constants, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

/** How long after a check that had no answer the app tries again by itself. */
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
  /** The folder the updater makes its own temporary folder in: the system's. */
  tempDir: string;
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

function reasonOf(answer: Extract<Fetched<unknown>, { ok: false }>): string {
  return failureWords(answer.failure, answer.status);
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
  /** The version being downloaded, or downloaded and ready. */
  let downloading: string | null = null;
  /** The updater's temporary folder for that version, and the bundle unpacked in it. */
  let staging: string | null = null;
  let readyApp: string | null = null;
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

  /** Removes the temporary folder of a download, if there is one. */
  const discard = async (): Promise<void> => {
    const dir = staging;
    staging = null;
    readyApp = null;
    downloading = null;
    if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {});
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
        "the new version could not be moved into this copy's place",
        installed,
      );
    }
  }

  async function download(version: string, zip: ReleaseFile): Promise<void> {
    // Said at once, so the answer to the check that found it says so.
    const previous = staging;
    staging = null;
    readyApp = null;
    downloading = version;
    const notesUrl = endpoints.notes(version);
    phase = { phase: "downloading", version, notesUrl, received: 0, total: zip.size };
    if (previous !== null) await rm(previous, { recursive: true, force: true }).catch(() => {});
    const fail = async (reason: string) => {
      if (downloading !== version) return;
      await discard();
      phase = failed("download", reason, version);
    };

    let dir: string;
    try {
      dir = await mkdtemp(path.join(options.tempDir, "agent-lookout-update-"));
    } catch {
      await fail("the download could not be saved");
      return;
    }
    if (stopped || downloading !== version) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    staging = dir;

    const file = path.join(dir, zip.name);
    const fetched = await requests.downloadFile(endpoints.download(version, zip.name), file, zip, {
      ...request,
      onProgress: (received, total) => {
        if (downloading === version && phase.phase === "downloading") {
          phase = { ...phase, received, total };
        }
      },
    });
    if (stopped || downloading !== version) return;
    if (!fetched.ok) {
      await fail(reasonOf(fetched));
      return;
    }

    const into = path.join(dir, "app");
    const app = await mkdir(into)
      .then(() => unpackApp(file, into, run))
      .catch(() => null);
    if (app === null) {
      await fail("the download could not be unpacked");
      return;
    }
    const [facts, own] = await Promise.all([bundleFacts(app, run), identifier()]);
    if (facts === null || own === null || facts.identifier !== own) {
      await fail("the download is not this app");
      return;
    }
    if (facts.version !== version) {
      await fail(`the download is version ${facts.version}, not ${version}`);
      return;
    }
    // The zip has been unpacked, and only the bundle is needed now.
    await rm(file, { force: true }).catch(() => {});
    if (stopped || downloading !== version) return;
    readyApp = app;
    phase = { phase: "ready", version, notesUrl };
  }

  async function look(automatic: boolean): Promise<AppUpdateStatus> {
    if (phase.phase === "installing") return status();
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
        save({ lastCheckedAt: now() });
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
    save({ lastCheckedAt: now() });

    const offered = manifest.version;
    if (!isOffered(offered, options.version)) {
      if (current().phase !== "installing") {
        await discard();
        phase = { phase: "up-to-date" };
      }
      return status();
    }

    if (downloading === offered && underWay(current())) return status();
    // A download of another version is left to finish. The next check finds this one.
    const going = current().phase;
    if (going === "downloading" || going === "installing") return status();
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
    void download(offered, zip).catch(() => {
      void discard();
      phase = failed("download", "the download could not be saved", offered);
    });
    return status();
  }

  const check = (automatic: boolean): Promise<AppUpdateStatus> => {
    checking ??= look(automatic).finally(() => {
      checking = null;
    });
    return checking;
  };

  /** Whether a day has passed since the last check, and a while since the last that failed. */
  const due = (): boolean => {
    const at = now();
    const last = settings.lastCheckedAt;
    if (last !== null && at >= last && at - last < CHECK_EVERY_MS) return false;
    if (lastAttemptAt !== null && at >= lastAttemptAt && at - lastAttemptAt < RETRY_AFTER_MS) {
      return false;
    }
    return true;
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
      if (phase.phase !== "ready" || readyApp === null || staging === null) {
        return { ok: false, status: status() };
      }
      const { version, notesUrl } = phase;
      const refusal = refusalHere();
      if (refusal !== null || options.bundle === null) {
        phase = { phase: "cannot-install", version, notesUrl, refusal: refusal ?? "read-only" };
        return { ok: false, status: status() };
      }
      const aside = path.join(staging, "previous", path.basename(options.bundle));
      const replacement = readyApp;
      const bundle = options.bundle;
      // Noted before the helper starts, so the copy that opens next knows.
      save({ installingVersion: version });
      const started = await mkdir(path.dirname(aside), { recursive: true })
        .then(() =>
          startHelper({ pid, bundle, replacement, aside }, options.startDetached ?? startDetached),
        )
        .catch(() => false);
      if (!started) {
        save({ installingVersion: null });
        phase = failed("install", "the helper that replaces the app could not be started", version);
        await discard();
        return { ok: false, status: status() };
      }
      phase = { phase: "installing", version, notesUrl };
      timers.push(setTimeout(() => options.quit(), QUIT_DELAY_MS));
      // Quitting clears this. An app still running by then has outlasted the helper.
      timers.push(
        setTimeout(() => {
          if (phase.phase !== "installing") return;
          save({ installingVersion: null });
          phase = failed("install", "Agent Lookout did not quit in time to be replaced", version);
          void discard();
        }, INSTALL_GIVE_UP_MS),
      );
      return { ok: true, status: status() };
    },
    start() {
      if (!options.packaged || stopped) return;
      timers.push(setTimeout(tick, FIRST_CHECK_DELAY_MS));
      timers.push(setInterval(tick, TICK_MS));
    },
    stop() {
      stopped = true;
      for (const timer of timers.splice(0)) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      // What is being installed stays for the helper. Anything else goes.
      if (phase.phase !== "installing" && staging !== null) {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {
          // Left in the system's temporary folder, which macOS clears.
        }
        staging = null;
      }
    },
  };
}
