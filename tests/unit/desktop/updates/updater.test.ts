import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { ReleaseEndpoints } from "@desktop/updates/release/endpoints";
import type { Fetched } from "@desktop/updates/release/releaseRequest";
import {
  DEFAULT_UPDATE_SETTINGS,
  type UpdateSettings,
  type UpdateSettingsStore,
} from "@desktop/updates/updateSettings";
import {
  CHECK_EVERY_MS,
  createUpdater,
  FIRST_CHECK_DELAY_MS,
  RETRY_AFTER_MS,
  TICK_MS,
  type UpdaterOptions,
} from "@desktop/updates/updater";

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 9, 6, 9, 0, 0);

/** Releases at an address no request reaches: every request here is a stand-in. */
const ENDPOINTS: ReleaseEndpoints = {
  manifest: "https://releases.invalid/latest/latest-mac.yml",
  download: (version, name) => `https://releases.invalid/v${version}/${name}`,
  notes: (version) => `https://releases.invalid/tag/v${version}`,
  releases: "https://releases.invalid/",
  allow: () => true,
};

const manifestFor = (version: string, arch = "arm64") => `version: ${version}
files:
  - url: Agent-Lookout-${version}-mac-${arch}.zip
    sha512: ${createHash("sha512").update(version).digest("base64")}
    size: 1000
`;

function memorySettings(start: Partial<UpdateSettings> = {}) {
  let kept: UpdateSettings = { ...DEFAULT_UPDATE_SETTINGS, ...start };
  const store: UpdateSettingsStore = {
    read: () => kept,
    write: (settings) => {
      kept = settings;
    },
  };
  return { store, kept: () => kept };
}

/**
 * An updater whose requests are stand-ins, answering with the manifest of the
 * latest release, or a 404 when there is none. It runs from a disk image, so
 * a version it finds is never downloaded: these tests are about when it looks.
 */
function updater(
  latest: () => string | null,
  options: Partial<UpdaterOptions> = {},
  kept: Partial<UpdateSettings> = {},
) {
  const settings = memorySettings(kept);
  const fetchText = vi.fn(async (): Promise<Fetched<string>> => {
    const version = latest();
    return version === null
      ? { ok: false, failure: "not-found", status: 404 }
      : { ok: true, value: manifestFor(version) };
  });
  const downloadFile = vi.fn(async (): Promise<Fetched<void>> => ({
    ok: false,
    failure: "network",
  }));
  const onFound = vi.fn();
  const quit = vi.fn();
  const warn = vi.fn();
  const made = createUpdater({
    version: "0.2.0",
    arch: "arm64",
    packaged: true,
    bundle: "/Volumes/Agent Lookout 0.2.0/Agent Lookout.app",
    settings: settings.store,
    tempDir: "/nonexistent",
    endpoints: ENDPOINTS,
    requests: { fetchText, downloadFile },
    canWrite: () => true,
    onFound,
    quit,
    warn,
    ...options,
  });
  return { updater: made, fetchText, downloadFile, onFound, quit, warn, settings };
}

/** Moves the fake clock on to a time, running every timer due by then. */
async function advanceTo(at: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(at - Date.now());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("when the updater looks by itself", () => {
  test("first a short while after the app starts, then once a day", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0");
    updates.start();

    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1);
    expect(fetchText).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchText).toHaveBeenCalledOnce();
    expect(fetchText).toHaveBeenCalledWith(
      ENDPOINTS.manifest,
      expect.objectContaining({ userAgent: "Agent-Lookout/0.2.0" }),
    );
    expect(updates.status().update).toEqual({ phase: "up-to-date" });
    expect(updates.status().lastCheckedAt).toBe(START + FIRST_CHECK_DELAY_MS);

    // It asks itself each hour, and a day has not passed at the 24th.
    await advanceTo(START + 24 * HOUR);
    expect(fetchText).toHaveBeenCalledOnce();
    // The first hour after a day since the last check, it looks again.
    await advanceTo(START + 25 * HOUR - 1);
    expect(fetchText).toHaveBeenCalledOnce();
    await advanceTo(START + 25 * HOUR);
    expect(fetchText).toHaveBeenCalledTimes(2);
    // Then once a day.
    await advanceTo(START + 25 * HOUR + 3 * CHECK_EVERY_MS);
    expect(fetchText).toHaveBeenCalledTimes(5);
    updates.stop();
  });

  test("remembers the last check, so opening the app again does not look again that day", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0");
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(fetchText).toHaveBeenCalledOnce();
    updates.stop();

    // The app opens again three hours later, with the same file.
    const again = updater(() => "0.2.0");
    again.settings.store.write({
      ...DEFAULT_UPDATE_SETTINGS,
      lastCheckedAt: START + FIRST_CHECK_DELAY_MS,
    });
    const reopened = createUpdater({
      version: "0.2.0",
      arch: "arm64",
      packaged: true,
      bundle: null,
      settings: again.settings.store,
      tempDir: "/nonexistent",
      endpoints: ENDPOINTS,
      requests: { fetchText: again.fetchText, downloadFile: again.downloadFile },
      quit: vi.fn(),
    });
    await advanceTo(START + 3 * HOUR);
    reopened.start();
    // Not at its start, and not until a day has passed since the last check.
    await advanceTo(START + FIRST_CHECK_DELAY_MS + CHECK_EVERY_MS - 1);
    expect(again.fetchText).not.toHaveBeenCalled();
    await advanceTo(START + 3 * HOUR + CHECK_EVERY_MS);
    expect(again.fetchText).toHaveBeenCalledOnce();
    reopened.stop();
  });

  test("never while the switch is off, and again once it is on", async () => {
    const { updater: updates, fetchText, settings } = updater(() => "0.2.0");
    updates.setAutomatic(false);
    expect(settings.kept().automatic).toBe(false);
    updates.start();
    await vi.advanceTimersByTimeAsync(3 * CHECK_EVERY_MS);
    expect(fetchText).not.toHaveBeenCalled();

    expect(updates.setAutomatic(true).automatic).toBe(true);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(fetchText).toHaveBeenCalledOnce();
    updates.stop();
  });

  test("tries again some hours after a check that had no answer, not each hour", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0");
    fetchText.mockResolvedValueOnce({ ok: false, failure: "network" });
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updates.status().update).toMatchObject({
      phase: "failed",
      step: "check",
      reason: "GitHub could not be reached",
    });
    expect(updates.status().lastCheckedAt).toBeNull();

    // The hourly ticks before then leave it.
    await advanceTo(START + FIRST_CHECK_DELAY_MS + RETRY_AFTER_MS - 1);
    expect(fetchText).toHaveBeenCalledOnce();
    // The first tick after it looks again.
    await advanceTo(START + RETRY_AFTER_MS + TICK_MS);
    expect(fetchText).toHaveBeenCalledTimes(2);
    expect(updates.status().update).toEqual({ phase: "up-to-date" });
    updates.stop();
  });

  test("a development run never looks by itself", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0", { packaged: false });
    updates.start();
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS);
    expect(fetchText).not.toHaveBeenCalled();
    // Asked, it looks.
    await updates.check();
    expect(fetchText).toHaveBeenCalledOnce();
  });

  test("stops looking once stopped", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0");
    updates.start();
    updates.stop();
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS);
    expect(fetchText).not.toHaveBeenCalled();
  });
});

describe("what a check finds", () => {
  test("a latest release with no Mac app is an answer: no release yet, and the check counts", async () => {
    const { updater: updates } = updater(() => null);
    const status = await updates.check();
    expect(status.update).toEqual({ phase: "no-release" });
    expect(status.lastCheckedAt).toBe(START);
  });

  test("a newer release with no app for this kind of Mac is an answer, and tells of nothing", async () => {
    const {
      updater: updates,
      fetchText,
      downloadFile,
      onFound,
      warn,
      settings,
    } = updater(() => "0.2.1");
    fetchText.mockResolvedValue({ ok: true, value: manifestFor("0.2.1", "x64") });
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updates.status().update).toEqual({ phase: "not-for-this-mac" });
    expect(updates.status().lastCheckedAt).toBe(START + FIRST_CHECK_DELAY_MS);
    expect(downloadFile).not.toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();
    expect(settings.kept().notifiedVersion).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    updates.stop();
  });

  test("a check asked for while one is under way is the same check", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0");
    const [first, second] = await Promise.all([updates.check(), updates.check()]);
    expect(first).toEqual(second);
    expect(fetchText).toHaveBeenCalledOnce();
  });

  test("a prerelease is never offered", async () => {
    const { updater: updates } = updater(() => "0.3.0-beta.1");
    expect((await updates.check()).update).toEqual({ phase: "up-to-date" });
  });

  test("a newer version where the app cannot change itself is offered with why, and not downloaded", async () => {
    const { updater: updates, downloadFile } = updater(() => "0.2.1");
    expect((await updates.check()).update).toEqual({
      phase: "cannot-install",
      version: "0.2.1",
      notesUrl: "https://releases.invalid/tag/v0.2.1",
      refusal: "disk-image",
    });
    expect(downloadFile).not.toHaveBeenCalled();
    expect((await updates.install()).ok).toBe(false);
  });

  test("a development run offers a newer version and never installs it", async () => {
    const { updater: updates, downloadFile } = updater(() => "0.2.1", {
      packaged: false,
      bundle: "/Applications/Agent Lookout.app",
    });
    expect((await updates.check()).update).toMatchObject({
      phase: "cannot-install",
      refusal: "development",
    });
    expect(downloadFile).not.toHaveBeenCalled();
  });

  test("a manifest that cannot be read is a check that did not work", async () => {
    const { updater: updates, fetchText } = updater(() => "0.2.0");
    fetchText.mockResolvedValueOnce({ ok: true, value: "<html>Not a manifest</html>" });
    expect((await updates.check()).update).toMatchObject({
      phase: "failed",
      step: "check",
      reason: "the release's update file could not be read",
    });
  });

  test("tells of a version the daily check found once, and never of one the person asked for", async () => {
    let latest = "0.2.1";
    const { updater: updates, onFound, settings } = updater(() => latest);
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    // From a disk image, the notice says it cannot be installed there.
    expect(onFound).toHaveBeenCalledExactlyOnceWith("0.2.1", "disk-image");
    expect(settings.kept().notifiedVersion).toBe("0.2.1");

    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS);
    expect(onFound).toHaveBeenCalledOnce();

    latest = "0.2.2";
    await updates.check();
    expect(onFound).toHaveBeenCalledOnce();
    // Found by the person, so the daily check does not tell of it again.
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(onFound).toHaveBeenCalledOnce();
    updates.stop();
  });
});

describe("a version found where the app can change itself", () => {
  test("is told of as being downloaded", async () => {
    const { updater: updates, onFound } = updater(() => "0.2.1", {
      bundle: "/Applications/Agent Lookout.app",
    });
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(onFound).toHaveBeenCalledExactlyOnceWith("0.2.1", null);
    updates.stop();
  });
});

describe("the copy that opens after Install and Restart", () => {
  test("as the new version, says nothing of it and forgets it", () => {
    const { updater: updates, settings } = updater(
      () => "0.2.1",
      { version: "0.2.1", bundle: "/Applications/Agent Lookout.app" },
      { installingVersion: "0.2.1" },
    );
    expect(updates.status().update).toEqual({ phase: "idle" });
    expect(settings.kept().installingVersion).toBeNull();
  });

  test("as the old version, put back by the helper, says the install did not work", async () => {
    const {
      updater: updates,
      settings,
      warn,
    } = updater(
      () => "0.2.1",
      { bundle: "/Applications/Agent Lookout.app" },
      { installingVersion: "0.2.1" },
    );
    const failed = {
      phase: "failed",
      step: "install",
      reason: "the new version could not be moved into this copy's place",
      version: "0.2.1",
      notesUrl: "https://releases.invalid/tag/v0.2.1",
    };
    expect(updates.status().update).toEqual(failed);
    expect(settings.kept().installingVersion).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Version 0.2.1 of Agent Lookout could not be installed: the new version could not be moved into this copy's place.",
    );

    // The check it makes by itself leaves that said, and does not download it again.
    updates.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(updates.status().update).toEqual(failed);
    updates.stop();
  });

  test("moves on when the person checks, or a newer version is out", async () => {
    const asked = updater(() => "0.2.1", {}, { installingVersion: "0.2.1" });
    expect(asked.updater.status().update.phase).toBe("failed");
    expect((await asked.updater.check()).update).toMatchObject({
      phase: "cannot-install",
      version: "0.2.1",
    });

    const newer = updater(() => "0.2.2", {}, { installingVersion: "0.2.1" });
    newer.updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(newer.updater.status().update).toMatchObject({
      phase: "cannot-install",
      version: "0.2.2",
    });
    newer.updater.stop();
  });
});
