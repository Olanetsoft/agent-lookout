// The updater end to end against a release of the test's own: a server on
// 127.0.0.1 that answers as GitHub does, with two redirects, a latest-mac.yml
// and a zip. It checks, downloads and verifies into a folder of its own, and
// installs only when asked. The app it would replace is a made-up bundle in
// the test's folder, and the helper is a stand-in that starts nothing, so no
// real app is ever touched and GitHub is never asked.
//
// On macOS the zip is a real one made with ditto, and unpacked with it. On
// another system, where there is no ditto, a stand-in unpacks the bundle the
// "zip" names, and everything else runs as it does on a Mac.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, onTestFinished, test, vi } from "vitest";

import { DITTO, runProgram, type RunProgram } from "@desktop/updates/install/bundleCheck";
import { HELPER_SCRIPT } from "@desktop/updates/install/installHelper";
import type { ReleaseEndpoints } from "@desktop/updates/release/endpoints";
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from "@desktop/updates/updateSettings";
import { createUpdater, FIRST_CHECK_DELAY_MS, INSTALL_GIVE_UP_MS } from "@desktop/updates/updater";
import { playHistory } from "@tests/support/desktop/updateHistory";
import { makeUpdateWorld } from "@tests/support/desktop/updateWorld";
import { listen } from "@tests/support/node/http";
import { tempDir } from "@tests/support/node/tempFiles";

const exec = promisify(execFile);
const onMac = process.platform === "darwin";

const APP_ID = "dev.agentlookout.app";
const ZIP_NAME = "Agent-Lookout-0.2.1-mac-arm64.zip";

const plist = (identifier: string, version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>${identifier}</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
  </dict>
</plist>
`;

async function makeBundle(dir: string, identifier: string, version: string): Promise<string> {
  const bundle = path.join(dir, "Agent Lookout.app");
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Info.plist"), plist(identifier, version));
  await writeFile(path.join(bundle, "Contents", "MacOS", "Agent Lookout"), "#!/bin/sh\n", {
    mode: 0o755,
  });
  return bundle;
}

/**
 * The zip of a release, of a bundle with this identifier and version. On a
 * Mac it is made with ditto. Elsewhere it is a few bytes that name the
 * bundle, which `standInDitto` unpacks.
 */
async function zipOf(work: string, identifier: string, version: string): Promise<Buffer> {
  if (!onMac) return Buffer.from(JSON.stringify({ identifier, version }));
  const source = path.join(work, `source-${identifier}-${version}`);
  const bundle = await makeBundle(source, identifier, version);
  const zip = path.join(work, `${identifier}-${version}.zip`);
  await exec("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, zip]);
  return readFile(zip);
}

/** Unpacks what `zipOf` writes on a system with no ditto. */
const standInDitto: RunProgram = async (file, args) => {
  if (file !== DITTO) return { ok: false };
  const [, , zip, into] = args;
  const { identifier, version } = JSON.parse(await readFile(zip!, "utf8")) as Record<
    string,
    string
  >;
  await makeBundle(into!, identifier!, version!);
  return { ok: true, stdout: "" };
};

/** Waits, also while the timers are fake ones. */
const realTimeout = globalThis.setTimeout;
const moment = (ms: number) => new Promise<void>((resolve) => realTimeout(resolve, ms));

/** A release of the test's own, laid out and redirected as GitHub's are. */
async function fakeRelease(zip: Buffer, size = zip.byteLength, hashOf = zip) {
  const asked: string[] = [];
  const manifest = `version: 0.2.1
files:
  - url: ${ZIP_NAME}
    sha512: ${createHash("sha512").update(hashOf).digest("base64")}
    size: ${size}
  - url: Agent-Lookout-0.2.1-mac-arm64.dmg
    sha512: ${createHash("sha512").update("a disk image").digest("base64")}
    size: 12
path: ${ZIP_NAME}
releaseDate: '2026-10-06T12:00:00.000Z'
`;
  const assetsPort = await listen(
    createServer((req, res) => {
      asked.push(`assets ${req.url}`);
      const body = req.url === "/asset/manifest" ? Buffer.from(manifest) : zip;
      res.writeHead(200, { "Content-Length": String(body.byteLength) });
      res.end(body);
    }),
  );
  const releasesPort = await listen(
    createServer((req, res) => {
      asked.push(`releases ${req.url}`);
      const to =
        req.url === "/releases/latest/download/latest-mac.yml"
          ? "/releases/download/v0.2.1/latest-mac.yml"
          : req.url === "/releases/download/v0.2.1/latest-mac.yml"
            ? `http://127.0.0.1:${assetsPort}/asset/manifest`
            : req.url === `/releases/download/v0.2.1/${ZIP_NAME}`
              ? `http://127.0.0.1:${assetsPort}/asset/zip`
              : null;
      res.writeHead(to === null ? 404 : 302, to === null ? {} : { Location: to });
      res.end();
    }),
  );
  const origin = `http://127.0.0.1:${releasesPort}`;
  const hosts = [`127.0.0.1:${releasesPort}`, `127.0.0.1:${assetsPort}`];
  const endpoints: ReleaseEndpoints = {
    manifest: `${origin}/releases/latest/download/latest-mac.yml`,
    download: (version, name) => `${origin}/releases/download/v${version}/${name}`,
    notes: (version) => `${origin}/releases/tag/v${version}`,
    releases: `${origin}/releases`,
    allow: (url) => url.protocol === "http:" && hosts.includes(url.host),
  };
  return { endpoints, asked };
}

interface FakeRelease {
  /** The bundle in the zip. */
  identifier?: string;
  version?: string;
  /** How many bytes the manifest's size of the zip is off by. */
  sizeOff?: number;
  hashOf?: Buffer;
  /** Called as each zip is unpacked, with how many have been. */
  unpacking?: (times: number) => void;
}

async function setUp(release: FakeRelease = {}) {
  const work = await tempDir();
  const zip = await zipOf(work, release.identifier ?? APP_ID, release.version ?? "0.2.1");
  const { endpoints, asked } = await fakeRelease(
    zip,
    zip.byteLength + (release.sizeOff ?? 0),
    release.hashOf,
  );
  // The running app: a made-up bundle in the test's own folder.
  const installed = await makeBundle(path.join(work, "Applications"), APP_ID, "0.2.0");
  const data = path.join(work, "data");
  const temp = path.join(work, "tmp");
  await mkdir(data);
  await mkdir(temp);
  let settings: UpdateSettings = DEFAULT_UPDATE_SETTINGS;
  const started: [string, readonly string[]][] = [];
  const quit = vi.fn();
  const warn = vi.fn();
  const unpack = onMac ? runProgram : standInDitto;
  let unpacked = 0;
  const run: RunProgram = async (file, args, stop) => {
    const answer = await unpack(file, args, stop);
    if (file === DITTO) release.unpacking?.((unpacked += 1));
    return answer;
  };
  const updater = createUpdater({
    version: "0.2.0",
    arch: "arm64",
    packaged: true,
    bundle: installed,
    settings: { read: () => settings, write: (next) => (settings = next) },
    dataDir: data,
    tempDir: temp,
    removal: { rm, rmSync },
    endpoints,
    run,
    startDetached: async (file, args) => {
      started.push([file, args]);
      return true;
    },
    quit,
    warn,
    pid: 4242,
  });
  onTestFinished(() => updater.stop());
  return { updater, installed, data, temp, started, quit, warn, asked, settings: () => settings };
}

type SetUp = Awaited<ReturnType<typeof setUp>>;

const isReady = (updater: SetUp["updater"]) =>
  vi.waitFor(() => expect(updater.status().update.phase).toBe("ready"), { timeout: 15_000 });

/** The one folder of the updater's, in the app's own folder of user data. */
async function folderIn(data: string): Promise<string> {
  // One it took the place of may still be on its way out.
  const only = await vi.waitFor(async () => {
    const names = await readdir(data);
    expect(names).toEqual([expect.stringMatching(/^agent-lookout-update-/)]);
    return names[0]!;
  });
  return path.join(data, only);
}

describe("the updater, against a release of the test's own", () => {
  // What is installed is a Mac app's bundle, by a Mac's paths, and the helper that
  // puts it in place is a POSIX sh script, so installing is checked on macOS and
  // Linux only.
  test.skipIf(process.platform === "win32")(
    "checks, downloads and verifies a newer version, and installs it only when asked",
    async () => {
      const { updater, installed, data, temp, started, quit, asked, settings } = await setUp();

      const checked = await updater.check();
      expect(checked.lastCheckedAt).not.toBeNull();
      expect(checked.update).toMatchObject({ phase: "downloading", version: "0.2.1" });
      await isReady(updater);
      expect(updater.status().update).toEqual({
        phase: "ready",
        version: "0.2.1",
        notesUrl: expect.stringMatching(/\/releases\/tag\/v0\.2\.1$/),
      });
      // GitHub's two redirects, for the manifest and then the zip for this Mac, and nothing else.
      expect(asked).toEqual([
        "releases /releases/latest/download/latest-mac.yml",
        "releases /releases/download/v0.2.1/latest-mac.yml",
        "assets /asset/manifest",
        `releases /releases/download/v0.2.1/${ZIP_NAME}`,
        "assets /asset/zip",
      ]);

      // The zip alone waits, in a folder of the updater's own that macOS never clears.
      const folder = await folderIn(data);
      expect(await readdir(folder)).toEqual([ZIP_NAME]);
      expect(await readdir(temp)).toEqual([]);

      // Nothing is installed until Install and Restart.
      expect(started).toEqual([]);
      expect(quit).not.toHaveBeenCalled();

      const answer = await updater.install();
      expect(answer.ok).toBe(true);
      expect(answer.status.update).toMatchObject({ phase: "installing", version: "0.2.1" });
      // Noted, so the copy that opens next knows whether it worked.
      expect(settings().installingVersion).toBe("0.2.1");
      // It is unpacked, and checked, only now.
      const unpacked = (await readdir(folder)).find((name) => name.startsWith("app-"));
      const replacement = path.join(folder, unpacked ?? "", "Agent Lookout.app");
      expect(await readFile(path.join(replacement, "Contents", "Info.plist"), "utf8")).toContain(
        "<string>0.2.1</string>",
      );
      expect(started).toEqual([
        [
          "/bin/sh",
          [
            "-c",
            HELPER_SCRIPT,
            "agent-lookout-update",
            "4242",
            installed,
            replacement,
            path.join(folder, "previous", "Agent Lookout.app"),
          ],
        ],
      ]);
      await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
      // The app's own bundle is left for the helper, which moves it once the app has quit.
      expect(await readFile(path.join(installed, "Contents", "Info.plist"), "utf8")).toContain(
        "<string>0.2.0</string>",
      );
      // Stopping, as quitting does, leaves the new version for the helper.
      updater.stop();
      expect(existsSync(replacement)).toBe(true);
    },
  );

  test.each([
    [
      "is shorter than the release says",
      { sizeOff: 1 },
      "the download was not the size the release gives",
    ],
    [
      "is longer than the release says",
      { sizeOff: -1 },
      "the file was larger than the release says",
    ],
    [
      "does not match its SHA-512",
      { hashOf: Buffer.from("other") },
      "the download did not match the SHA-512 the release gives",
    ],
    ["is another app", { identifier: "dev.example.other" }, "the download is not this app"],
    ["is another version", { version: "0.2.2" }, "the download is version 0.2.2, not 0.2.1"],
  ] as const)(
    "a download that %s is thrown away, and nothing is offered to install",
    async (_what, release, reason) => {
      const { updater, data, started, warn } = await setUp(release);
      await updater.check();
      await vi.waitFor(() => expect(updater.status().update.phase).toBe("failed"), {
        timeout: 15_000,
      });
      expect(updater.status().update).toEqual({
        phase: "failed",
        step: "download",
        reason,
        version: "0.2.1",
        notesUrl: expect.stringMatching(/\/releases\/tag\/v0\.2\.1$/),
      });
      expect(warn).toHaveBeenCalledWith(
        `Version 0.2.1 of Agent Lookout could not be downloaded: ${reason}.`,
      );
      expect(await readdir(data)).toEqual([]);
      expect((await updater.install()).ok).toBe(false);
      expect(started).toEqual([]);
    },
  );

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32")(
    "an app that has not quit once the helper stops waiting says why, and the version can still be installed",
    async () => {
      const { updater, data, started, settings } = await setUp();
      await updater.check();
      await isReady(updater);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        expect((await updater.install()).ok).toBe(true);
        // The quit asked for does not happen.
        await vi.advanceTimersByTimeAsync(INSTALL_GIVE_UP_MS - 1);
        expect(updater.status().update.phase).toBe("installing");
        await vi.advanceTimersByTimeAsync(1);
      } finally {
        vi.useRealTimers();
      }
      await isReady(updater);
      expect(updater.status().update).toEqual({
        phase: "ready",
        version: "0.2.1",
        notesUrl: expect.stringMatching(/\/releases\/tag\/v0\.2\.1$/),
        failed: "Agent Lookout did not quit in time to be replaced",
      });
      expect(settings().installingVersion).toBeNull();
      // What was unpacked is gone, so a helper that still waits has nothing to move in.
      expect(await readdir(await folderIn(data))).toEqual([ZIP_NAME]);
      expect((await updater.install()).ok).toBe(true);
      expect(started).toHaveLength(2);
    },
  );

  /** What can come of the zip while it waits. */
  const CLEARED: Record<string, (zip: string) => Promise<void>> = {
    gone: (zip) => rm(zip),
    "gone with its folder": (zip) => rm(path.dirname(zip), { recursive: true }),
    "cut short": (zip) => truncate(zip, 40),
    "the same size, with other bytes": async (zip) =>
      writeFile(zip, Buffer.alloc((await readFile(zip)).byteLength)),
  };

  test.each(Object.keys(CLEARED))(
    "a version whose download is %s by the time it is installed is downloaded again, not installed",
    async (what) => {
      const { updater, installed, data, started, quit, warn, settings } = await setUp();
      await updater.check();
      await isReady(updater);
      await CLEARED[what]!(path.join(await folderIn(data), ZIP_NAME));

      const answer = await updater.install();
      expect(answer.ok).toBe(false);
      expect(answer.status.update).toMatchObject({
        phase: "downloading",
        version: "0.2.1",
        lost: "0.2.1",
      });
      expect(warn).toHaveBeenCalledWith(
        "Version 0.2.1 of Agent Lookout can no longer be installed: its download is no longer whole.",
      );
      expect(started).toEqual([]);
      expect(quit).not.toHaveBeenCalled();
      expect(settings().installingVersion).toBeNull();
      expect(await readFile(path.join(installed, "Contents", "Info.plist"), "utf8")).toContain(
        "<string>0.2.0</string>",
      );

      // Downloaded again, it is whole.
      await isReady(updater);
      expect(await readdir(await folderIn(data))).toEqual([ZIP_NAME]);
    },
  );

  test.each(Object.keys(CLEARED))(
    "the next check notices a ready version whose download is %s, and downloads it again",
    async (what) => {
      const { updater, data, asked, warn } = await setUp();
      await updater.check();
      await isReady(updater);
      // One that is whole is left as it is.
      await updater.check();
      expect(updater.status().update.phase).toBe("ready");
      const zips = () => asked.filter((line) => line === "assets /asset/zip").length;
      expect(zips()).toBe(1);

      await CLEARED[what]!(path.join(await folderIn(data), ZIP_NAME));
      expect((await updater.check()).update).toMatchObject({ phase: "downloading", lost: "0.2.1" });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Version 0.2.1 of Agent Lookout can no longer be installed: its download is no longer whole.",
      );
      await isReady(updater);
      expect(zips()).toBe(2);
      expect(await readdir(await folderIn(data))).toEqual([ZIP_NAME]);
    },
  );

  test.each(["checked again", "unpacked"])(
    "quitting while the version is %s to be installed installs nothing, and leaves nothing",
    async (when) => {
      const made = await setUp({ unpacking: (times) => times === 2 && made.updater.stop() });
      const { updater, data, started, warn, settings } = made;
      await updater.check();
      await isReady(updater);

      const answer = updater.install();
      expect(updater.status().update.phase).toBe("installing");
      if (when === "checked again") updater.stop();
      expect((await answer).ok).toBe(false);
      expect(started).toEqual([]);
      expect(settings().installingVersion).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      expect(await readdir(data)).toEqual([]);
    },
  );

  test("quitting as a version that is gone is checked again to be installed says nothing", async () => {
    const { updater, data, warn } = await setUp();
    await updater.check();
    await isReady(updater);
    await rm(path.join(await folderIn(data), ZIP_NAME));
    const answer = updater.install();
    updater.stop();
    expect((await answer).ok).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(updater.status().update.phase).toBe("installing");
  });

  test("quitting without installing removes what was downloaded", async () => {
    const { updater, data } = await setUp();
    await updater.check();
    await isReady(updater);
    updater.stop();
    expect(await readdir(data)).toEqual([]);
  });

  /** Lays out a folder an earlier run left: with a file, or a bundle macOS has cleared. */
  async function leave(dir: string, name: string, file?: string) {
    const contents = path.join(dir, name, "previous", "Agent Lookout.app", "Contents");
    await mkdir(contents, { recursive: true });
    if (file !== undefined) await writeFile(path.join(contents, file), "x");
  }

  /** Starts the updater, with no check of its own due, and lets its first timer run. */
  async function startAndWait(updater: SetUp["updater"], then = () => {}) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      updater.start();
      vi.advanceTimersByTime(FIRST_CHECK_DELAY_MS);
      then();
    } finally {
      vi.useRealTimers();
    }
  }

  test("a while after it starts, removes what earlier runs left, and nothing else", async () => {
    const { updater, data, temp } = await setUp();
    updater.setAutomatic(false);
    // This version's, and those of 0.2.31 and earlier in the system's temporary folder.
    await leave(data, "agent-lookout-update-a1B2c3", "Info.plist");
    await leave(temp, "agent-lookout-update-d4E5f6", "Info.plist");
    await leave(temp, "agent-lookout-update-g7H8i9");
    await leave(temp, "another-app");
    await writeFile(path.join(data, "update-state.json"), "{}");
    await writeFile(path.join(temp, "agent-lookout-update-notes.txt"), "not a folder");
    // A download under way is this run's own.
    await updater.check();
    await isReady(updater);

    await startAndWait(updater);
    await vi.waitFor(async () => {
      expect((await readdir(temp)).sort()).toEqual([
        "agent-lookout-update-notes.txt",
        "another-app",
      ]);
      expect(await readdir(data)).toHaveLength(2);
    });
    expect(await readdir(data)).toContain("update-state.json");
    expect(updater.status().update.phase).toBe("ready");
  });

  test("leaves the old app where it is while the app in its place is one that has not run", async () => {
    const { updater, installed, data, temp } = await setUp();
    updater.setAutomatic(false);
    await leave(data, "agent-lookout-update-a1B2c3", "Info.plist");
    await leave(temp, "agent-lookout-update-d4E5f6", "Info.plist");
    await writeFile(path.join(installed, "Contents", "Info.plist"), plist(APP_ID, "0.2.1"));

    await startAndWait(updater);
    // Long enough for a removal to have begun.
    await moment(200);
    expect(await readdir(data)).toEqual(["agent-lookout-update-a1B2c3"]);
    expect(await readdir(temp)).toEqual(["agent-lookout-update-d4E5f6"]);
  });

  test("removes nothing of an earlier run once it has quit", async () => {
    const { updater, data } = await setUp();
    updater.setAutomatic(false);
    await leave(data, "agent-lookout-update-a1B2c3", "Info.plist");
    await startAndWait(updater, () => updater.stop());
    // Long enough for a removal to have begun.
    await moment(200);
    expect(await readdir(data)).toEqual(["agent-lookout-update-a1B2c3"]);
  });

  test("reads the app's own identifier again when it could not be read before", async () => {
    const { updater, installed } = await setUp();
    const plist = path.join(installed, "Contents", "Info.plist");
    const text = await readFile(plist, "utf8");
    await rm(plist);

    await updater.check();
    await vi.waitFor(() => expect(updater.status().update.phase).toBe("failed"), {
      timeout: 15_000,
    });
    expect(updater.status().update).toMatchObject({ reason: "the download is not this app" });

    await writeFile(plist, text);
    await updater.check();
    await isReady(updater);
  });
});

const HOUR = 60 * 60 * 1000;

describe("a version that is ready, and a newer one", () => {
  type World = Awaited<ReturnType<typeof makeUpdateWorld>>;
  const updateIn = (world: World) => world.updater.status().update;
  const isAt = (world: World, update: object) =>
    vi.waitFor(() => expect(updateIn(world)).toMatchObject(update), { timeout: 5_000 });

  /** A Mac on 0.2.0 with 0.2.1 ready, and 0.2.2 out since. */
  async function withOneReady(): Promise<World> {
    const world = await makeUpdateWorld();
    onTestFinished(() => world.updater.stop());
    world.latest = "0.2.1";
    await world.updater.check();
    await isAt(world, { phase: "ready", version: "0.2.1" });
    world.latest = "0.2.2";
    return world;
  }

  test.each(["network", "wrong-hash"] as const)(
    "the one that is ready stays when the newer one's download fails: %s",
    async (failure) => {
      const world = await withOneReady();
      world.downloads = failure;
      await world.updater.check();
      await vi.waitFor(() => expect(world.log).toHaveLength(1));
      expect(world.log[0]).toContain("Version 0.2.2 of Agent Lookout could not be downloaded");
      expect(updateIn(world)).toEqual({
        phase: "ready",
        version: "0.2.1",
        notesUrl: "https://releases.invalid/notes/0.2.1",
      });
      // Nothing is left of the one that failed, and the other is whole.
      expect(await world.folders()).toHaveLength(1);
      expect(path.basename((await world.zip())!)).toContain("0.2.1");

      world.downloads = "whole";
      await world.updater.check();
      await isAt(world, { phase: "ready", version: "0.2.2" });
      await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));
    },
  );

  test("it stays ready while the newer one is downloaded, which then takes its place", async () => {
    const world = await withOneReady();
    world.downloads = "hold";
    await world.updater.check();
    expect(updateIn(world)).toMatchObject({ phase: "ready", version: "0.2.1", newer: "0.2.2" });
    // A check meanwhile leaves both.
    await world.updater.check();
    expect(world.asked).toBe(2);

    world.heldDownloads[0]!.answer("whole");
    await isAt(world, { phase: "ready", version: "0.2.2" });
    expect(updateIn(world)).not.toHaveProperty("newer");
    await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));
    expect(path.basename((await world.zip())!)).toContain("0.2.2");
  });

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32")(
    "installing it while the newer one is downloaded installs it, and stops the download",
    async () => {
      const world = await withOneReady();
      world.downloads = "hold";
      await world.updater.check();
      const answer = await world.updater.install();
      expect(answer.status.update).toMatchObject({ phase: "installing", version: "0.2.1" });
      expect(world.heldDownloads).toEqual([]);
      await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));
      world.quit();
      expect(world.updater.status().version).toBe("0.2.1");
    },
  );

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32").each([
    ["it was withdrawn", "0.2.0"],
    ["a newer one is out", "0.2.2"],
  ])(
    "an answer that comes while it is being installed, that %s, changes nothing",
    async (_what, latest) => {
      const world = await withOneReady();
      world.checks = "hold";
      const checked = world.updater.check();
      await vi.waitFor(() => expect(world.heldChecks).toHaveLength(1));
      expect((await world.updater.install()).ok).toBe(true);
      world.latest = latest;
      world.heldChecks[0]!.answer("answer");
      expect((await checked).update).toMatchObject({ phase: "installing", version: "0.2.1" });
      expect(world.asked).toBe(1);
      expect(await world.folders()).toHaveLength(1);
      world.quit();
      expect(world.updater.status().version).toBe("0.2.1");
    },
  );

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32")(
    "installing it while the newer one is unpacked to be checked installs it, and drops the newer one",
    async () => {
      const world = await withOneReady();
      let answer: ReturnType<typeof world.updater.install> | undefined;
      world.unpacking = () => {
        answer ??= world.updater.install();
      };
      await world.updater.check();
      await vi.waitFor(() => expect(answer).toBeDefined());
      expect((await answer!).status.update).toMatchObject({
        phase: "installing",
        version: "0.2.1",
      });
      // The newer one's folder goes once it has been unpacked.
      await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));
      await moment(20);
      expect(updateIn(world)).toMatchObject({ phase: "installing", version: "0.2.1" });
      world.quit();
      expect(world.updater.status().version).toBe("0.2.1");
    },
  );

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32")(
    "a newer one that has come as the ready one is installed is not unpacked",
    async () => {
      const world = await withOneReady();
      world.downloads = "hold";
      await world.updater.check();
      let unpacked = 0;
      world.unpacking = () => {
        unpacked += 1;
      };
      await vi.waitFor(() => expect(world.heldDownloads).toHaveLength(1));
      world.heldDownloads[0]!.answer("whole");
      expect((await world.updater.install()).ok).toBe(true);
      await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));
      await moment(20);
      // The one that is installed was.
      expect(unpacked).toBe(1);
    },
  );

  /** What can keep an install from beginning, once. */
  const IN_THE_WAY: Record<string, (world: World) => Promise<() => void>> = {
    "the download could not be unpacked": async (world) => {
      world.unpacking = () => {
        throw new Error("no space is left");
      };
      return () => {
        world.unpacking = () => {};
      };
    },
    "the helper that replaces the app could not be started": async (world) => {
      world.helperStarts = false;
      return () => {
        world.helperStarts = true;
      };
    },
    // Nowhere to put the old app.
    "the helper that replaces the app could not be started: no folder": async (world) => {
      await writeFile(path.join(path.dirname((await world.zip())!), "previous"), "in the way");
      return () => {};
    },
  };

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32").each(Object.keys(IN_THE_WAY))(
    "an install that does not begin leaves it ready, with why, and the newer one is downloaded all the same: %s",
    async (what) => {
      const world = await withOneReady();
      world.downloads = "hold";
      await world.updater.check();
      await vi.waitFor(() => expect(world.heldDownloads).toHaveLength(1));
      const goes = await IN_THE_WAY[what]!(world);
      const [reason] = what.split(":");

      const answer = await world.updater.install();
      expect(answer.ok).toBe(false);
      expect(answer.status.update).toEqual({
        phase: "ready",
        version: "0.2.1",
        notesUrl: "https://releases.invalid/notes/0.2.1",
        newer: "0.2.2",
        failed: reason,
      });
      expect(world.log).toEqual([
        `Version 0.2.1 of Agent Lookout could not be installed: ${reason}.`,
      ]);
      expect(world.helper).toBeNull();
      expect(world.settings.installingVersion).toBeNull();
      // Its zip alone waits, beside what there is of the newer one.
      const folder = path.dirname((await world.zip())!);
      await vi.waitFor(async () => expect(await world.folders()).toHaveLength(2));
      const waits = (await world.folders()).map((name) => path.join(world.data, name));
      const zips = await Promise.all(waits.map((name) => readdir(name)));
      expect(zips.flat()).toEqual([path.basename((await world.zip())!)]);
      expect(waits).toContain(folder);

      // What was in the way goes, and the person presses it again.
      goes();
      expect((await world.updater.install()).status.update).toEqual({
        phase: "installing",
        version: "0.2.1",
        notesUrl: "https://releases.invalid/notes/0.2.1",
      });
      world.quit();
      expect(world.updater.status().version).toBe("0.2.1");
    },
  );

  // Installing is checked on macOS and Linux only, as above.
  test.skipIf(process.platform === "win32").each([
    ["the helper did not start", "the helper that replaces the app could not be started"],
    ["the app did not quit in time", "Agent Lookout did not quit in time to be replaced"],
  ])("quitting once %s leaves nothing for the helper", async (_what, reason) => {
    const world = await withOneReady();
    world.helperStarts = reason.startsWith("Agent Lookout");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await world.updater.install();
      vi.advanceTimersByTime(INSTALL_GIVE_UP_MS);
    } finally {
      vi.useRealTimers();
    }
    await isAt(world, { phase: "ready", version: "0.2.1", failed: reason });
    expect(world.settings.installingVersion).toBeNull();
    world.updater.stop();
    expect(await world.folders()).toEqual([]);
  });

  test("an install that does not begin stays said through checks, until a newer one is ready", async () => {
    const world = await withOneReady();
    world.latest = "0.2.1";
    world.unpacking = () => {
      throw new Error("no space is left");
    };
    await world.updater.install();
    world.unpacking = () => {};
    const pass = await hoursOf(world);
    await pass(48);
    await world.updater.check();
    expect(updateIn(world)).toMatchObject({
      phase: "ready",
      version: "0.2.1",
      failed: "the download could not be unpacked",
    });
    expect(world.asked).toBe(1);
    world.latest = "0.2.2";
    await world.updater.check();
    await isAt(world, { phase: "ready", version: "0.2.2" });
    expect(updateIn(world)).not.toHaveProperty("failed");
  });

  test("quitting as a version that came is checked leaves nothing, also of what is written after", async () => {
    const world = await makeUpdateWorld();
    world.latest = "0.2.1";
    const unpacking = new Promise<void>((resolve) => {
      world.unpacking = () => {
        world.updater.stop();
        resolve();
      };
    });
    await world.updater.check();
    await unpacking;
    await moment(20);
    await vi.waitFor(async () => expect(await world.folders()).toEqual([]));
    expect(updateIn(world).phase).toBe("downloading");
    expect(world.log).toEqual([]);
  });

  test("a check that finds it can no longer be installed where the app is removes it", async () => {
    const world = await withOneReady();
    world.writable = false;
    expect((await world.updater.check()).update).toMatchObject({
      phase: "cannot-install",
      version: "0.2.2",
      refusal: "read-only",
    });
    expect(await world.folders()).toEqual([]);
    world.writable = true;
    expect((await world.updater.install()).ok).toBe(false);
    expect(world.helper).toBeNull();
  });

  test("quitting while it is unpacked leaves nothing, also of what is written after", async () => {
    const world = await withOneReady();
    world.unpacking = () => world.updater.stop();
    expect((await world.updater.install()).ok).toBe(false);
    expect(world.helper).toBeNull();
    expect(world.settings.installingVersion).toBeNull();
    expect(await world.folders()).toEqual([]);
    expect(world.log).toEqual([]);
  });

  // ditto is a program of its own, which would go on writing once the app has quit.
  test.each(["to be installed", "as it was downloaded"])(
    "quitting while a version is unpacked %s stops that, before its folder is removed",
    async (why) => {
      const world = await makeUpdateWorld();
      world.latest = "0.2.1";
      if (why === "to be installed") {
        await world.updater.check();
        await isAt(world, { phase: "ready", version: "0.2.1" });
      }
      let stopped: AbortSignal | undefined;
      const unpacking = new Promise<void>((resolve) => {
        world.unpacking = (stop) => {
          stopped = stop;
          resolve();
          // It is still unpacking when the app quits.
          return new Promise(() => {});
        };
      });
      void (why === "to be installed" ? world.updater.install() : world.updater.check());
      await unpacking;
      expect(stopped?.aborted).toBe(false);
      let whole: boolean | undefined;
      stopped?.addEventListener("abort", () => {
        whole = existsSync(world.data) && readdirSync(world.data).length === 1;
      });
      world.updater.stop();
      expect(stopped?.aborted).toBe(true);
      expect(whole).toBe(true);
      expect(await world.folders()).toEqual([]);
    },
  );

  test("quitting as a check reads the one that is ready asks nothing", async () => {
    const world = await withOneReady();
    const checked = world.updater.check();
    world.updater.stop();
    await checked;
    expect(world.looked).toBe(1);
  });

  test("an answer that comes once the app has quit downloads nothing", async () => {
    const world = await withOneReady();
    world.checks = "hold";
    const checked = world.updater.check();
    await vi.waitFor(() => expect(world.heldChecks).toHaveLength(1));
    world.updater.stop();
    world.heldChecks[0]!.answer("answer");
    await checked;
    expect(world.asked).toBe(1);
    expect(await world.folders()).toEqual([]);
  });

  /** The zip of a version that is downloaded, as it is unpacked to be checked. */
  async function zipOfVersion(world: World, version: string): Promise<string> {
    for (const folder of await world.folders()) {
      const names = await readdir(path.join(world.data, folder));
      const zip = names.find((name) => name.includes(`-${version}-`));
      if (zip !== undefined) return path.join(world.data, folder, zip);
    }
    throw new Error(`${version} is not being downloaded.`);
  }

  test.each(["gone", "cut short"])(
    "it stays when the newer one's download is %s by the time it has been checked",
    async (what) => {
      const world = await withOneReady();
      world.unpacking = async () => {
        const zip = await zipOfVersion(world, "0.2.2");
        await (what === "gone" ? rm(zip) : truncate(zip, 20));
      };
      await world.updater.check();
      await vi.waitFor(() =>
        expect(world.log).toEqual([
          "Version 0.2.2 of Agent Lookout could not be downloaded: the download could not be saved.",
        ]),
      );
      expect(updateIn(world)).toMatchObject({ phase: "ready", version: "0.2.1" });
      expect(await world.folders()).toHaveLength(1);
      expect(path.basename((await world.zip())!)).toContain("0.2.1");
    },
  );

  // Both timers of an install are due as a Mac that slept just then wakes, and
  // a window closes only after they have run. Installing is checked on macOS and Linux only.
  test.skipIf(process.platform === "win32")(
    "a Mac that sleeps just after Install and Restart installs it as it wakes",
    async () => {
      const world = await withOneReady();
      let timers: (() => void)[] = [];
      vi.stubGlobal("setTimeout", (then: () => void) => timers.push(then));
      onTestFinished(() => void vi.unstubAllGlobals());
      expect((await world.updater.install()).ok).toBe(true);
      const due = timers;
      timers = [];
      for (const then of due) then();
      vi.unstubAllGlobals();
      expect(updateIn(world)).toMatchObject({ phase: "installing", version: "0.2.1" });
      expect(world.settings.installingVersion).toBe("0.2.1");
      // It gives up all the same once the app has not quit.
      expect(timers).toHaveLength(1);
      world.quit();
      expect(world.updater.status().version).toBe("0.2.1");
    },
  );

  test("installing it once it is no longer whole, and withdrawn, downloads the version out by then", async () => {
    const world = await withOneReady();
    await rm((await world.zip())!);
    world.downloads = "hold";
    const answer = await world.updater.install();
    expect(answer.ok).toBe(false);
    expect(answer.status.update).toMatchObject({
      phase: "downloading",
      version: "0.2.2",
      lost: "0.2.1",
    });
    expect(world.looked).toBe(2);
  });

  test("installing it once it is no longer whole, with no answer, says so, and looks again after six hours", async () => {
    const world = await withOneReady();
    const pass = await hoursOf(world);
    await rm((await world.zip())!);
    world.checks = "fail";
    expect((await world.updater.install()).status.update).toMatchObject({
      phase: "failed",
      step: "check",
    });
    expect(world.asked).toBe(1);
    world.checks = "answer";
    await pass(5);
    expect(world.asked).toBe(1);
    await pass(1);
    await isAt(world, { phase: "ready", version: "0.2.2" });
  });

  test.each(["fail", "answer"] as const)(
    "installing it once it is no longer whole, as a check waits for GitHub, goes by that check: %s",
    async (how) => {
      const world = await withOneReady();
      world.checks = "hold";
      world.downloads = "hold";
      const checked = world.updater.check();
      await vi.waitFor(() => expect(world.heldChecks).toHaveLength(1));
      await rm((await world.zip())!);
      const answer = world.updater.install();
      await vi.waitFor(() => expect(updateIn(world)).toEqual({ phase: "checking" }));
      world.heldChecks[0]!.answer(how);
      await checked;
      expect((await answer).status.update).toMatchObject(
        how === "fail"
          ? { phase: "failed", step: "check" }
          : { phase: "downloading", version: "0.2.2", lost: "0.2.1" },
      );
      expect(world.looked).toBe(2);
    },
  );

  test("installing it once it is no longer whole downloads the newer one instead", async () => {
    const world = await withOneReady();
    world.downloads = "hold";
    await world.updater.check();
    await rm((await world.zip())!);
    expect((await world.updater.install()).ok).toBe(false);
    expect(updateIn(world)).toMatchObject({
      phase: "downloading",
      version: "0.2.2",
      lost: "0.2.1",
    });
    await vi.waitFor(() => expect(world.heldDownloads).toHaveLength(1));
    world.heldDownloads[0]!.answer("whole");
    await isAt(world, { phase: "ready", version: "0.2.2" });
    // Once one is ready again, nothing more is said of the one that was lost.
    world.latest = "0.2.1";
    expect((await world.updater.check()).update).toMatchObject({ phase: "downloading" });
    expect(updateIn(world)).not.toHaveProperty("lost");
  });

  test("one found lost by a check as it is installed is lost once, and downloaded again once", async () => {
    const world = await withOneReady();
    world.latest = "0.2.1";
    await rm((await world.zip())!);
    const checked = world.updater.check();
    expect((await world.updater.install()).ok).toBe(false);
    await checked;
    await isAt(world, { phase: "ready", version: "0.2.1" });
    expect(world.log).toHaveLength(1);
    expect(world.asked).toBe(2);
  });

  test("it goes when it is no longer whole, and the newer one is still downloaded", async () => {
    const world = await withOneReady();
    world.downloads = "hold";
    await world.updater.check();
    await rm((await world.zip())!);
    expect((await world.updater.check()).update).toMatchObject({
      phase: "downloading",
      version: "0.2.2",
      lost: "0.2.1",
    });
    expect(world.asked).toBe(2);
  });

  test("one that is lost while GitHub cannot be reached is not offered, and is said to be lost once it is downloaded again", async () => {
    const world = await withOneReady();
    world.latest = "0.2.1";
    await rm((await world.zip())!);
    world.checks = "fail";
    expect((await world.updater.check()).update).toMatchObject({ phase: "failed", step: "check" });
    expect(world.log[0]).toBe(
      "Version 0.2.1 of Agent Lookout can no longer be installed: its download is no longer whole.",
    );
    expect((await world.updater.install()).ok).toBe(false);

    world.checks = "answer";
    world.downloads = "network";
    await world.updater.check();
    await isAt(world, { phase: "failed", step: "download" });
    // Also when that download has failed before.
    world.downloads = "hold";
    expect((await world.updater.check()).update).toMatchObject({
      phase: "downloading",
      version: "0.2.1",
      lost: "0.2.1",
    });
  });

  test("nothing is said of a lost one that is no longer out", async () => {
    const world = await withOneReady();
    world.latest = "0.2.0";
    await rm((await world.zip())!);
    expect((await world.updater.check()).update).toEqual({ phase: "up-to-date" });
    world.latest = "0.2.2";
    world.downloads = "hold";
    expect((await world.updater.check()).update).toMatchObject({ phase: "downloading" });
    expect(updateIn(world)).not.toHaveProperty("lost");
  });

  test("one that was withdrawn is not kept for an older one", async () => {
    const world = await withOneReady();
    await world.updater.check();
    await isAt(world, { phase: "ready", version: "0.2.2" });
    world.latest = "0.2.1";
    world.downloads = "hold";
    expect((await world.updater.check()).update).toMatchObject({
      phase: "downloading",
      version: "0.2.1",
    });
    // Withdrawn too, its download stops, and nothing is left of either.
    world.latest = "0.2.0";
    expect((await world.updater.check()).update).toEqual({ phase: "up-to-date" });
    expect(world.heldDownloads).toEqual([]);
    await vi.waitFor(async () => expect(await world.folders()).toEqual([]));
  });

  test("a newer one withdrawn while it is downloaded does not take its place", async () => {
    const world = await withOneReady();
    world.downloads = "hold";
    await world.updater.check();
    await vi.waitFor(() => expect(world.heldDownloads).toHaveLength(1));
    world.latest = "0.2.1";
    const answer = await world.updater.check();
    expect(answer.update).toEqual({
      phase: "ready",
      version: "0.2.1",
      notesUrl: "https://releases.invalid/notes/0.2.1",
    });
    expect(world.heldDownloads).toEqual([]);
    await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));
    expect(path.basename((await world.zip())!)).toContain("0.2.1");
    expect(world.asked).toBe(2);
    expect(world.log).toEqual([]);
  });

  test("one withdrawn while it is downloaded stops, and the latest is downloaded at once", async () => {
    const world = await makeUpdateWorld();
    onTestFinished(() => world.updater.stop());
    world.latest = "0.2.3";
    world.downloads = "hold";
    await world.updater.check();
    await vi.waitFor(() => expect(world.heldDownloads).toHaveLength(1));
    world.downloads = "whole";
    world.latest = "0.2.2";
    expect((await world.updater.check()).update).toMatchObject({
      phase: "downloading",
      version: "0.2.2",
    });
    expect(world.heldDownloads).toEqual([]);
    await isAt(world, { phase: "ready", version: "0.2.2" });
    await vi.waitFor(async () => expect(await world.folders()).toHaveLength(1));

    // A newer one that comes out while another is downloaded leaves that to finish.
    world.downloads = "hold";
    world.latest = "0.2.4";
    await world.updater.check();
    world.latest = "0.2.5";
    expect((await world.updater.check()).update).toMatchObject({
      phase: "ready",
      version: "0.2.2",
      newer: "0.2.4",
    });
    expect(world.heldDownloads).toHaveLength(1);
  });

  /** Starts the app's own checks, and moves its clock on by hours. */
  async function hoursOf(world: World) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    world.updater.start();
    return async (hours: number) => {
      for (let hour = 0; hour < hours; hour += 1) {
        world.now += HOUR;
        vi.advanceTimersByTime(HOUR);
        await moment(5);
        // What it found is downloaded, or has failed, before the next hour.
        await vi.waitFor(() =>
          expect(["checking", "downloading"]).not.toContain(updateIn(world).phase),
        );
      }
    };
  }

  test("the check the app makes by itself each day notices one that is lost", async () => {
    const world = await withOneReady();
    world.latest = "0.2.1";
    const pass = await hoursOf(world);
    await rm((await world.zip())!);
    await pass(23);
    expect(world.asked).toBe(1);
    await pass(1);
    await vi.waitFor(() => expect(world.asked).toBe(2));
    await isAt(world, { phase: "ready", version: "0.2.1" });
    expect(world.log).toHaveLength(1);
  });

  test("a check with no answer that finds one lost is made again after six hours, not the next day", async () => {
    const world = await withOneReady();
    world.latest = "0.2.1";
    const pass = await hoursOf(world);
    await pass(1);
    await rm((await world.zip())!);
    world.checks = "fail";
    await world.updater.check();
    world.checks = "answer";
    const looked = world.looked;
    await pass(5);
    expect(world.looked).toBe(looked);
    await pass(1);
    await isAt(world, { phase: "ready", version: "0.2.1" });
    // It had an answer, so the next is a day later.
    const found = world.looked;
    await pass(23);
    expect(world.looked).toBe(found);
  });

  test.each(["network", "timed-out", "too-slow", "status"] as const)(
    "a download that had no answer, as %s, is tried again after six hours, once",
    async (failure) => {
      const world = await makeUpdateWorld();
      onTestFinished(() => world.updater.stop());
      world.latest = "0.2.1";
      world.downloads = failure;
      await world.updater.check();
      await isAt(world, { phase: "failed", step: "download", version: "0.2.1" });
      const pass = await hoursOf(world);
      await pass(5);
      expect(world.asked).toBe(1);
      await pass(1);
      await vi.waitFor(() => expect(world.asked).toBe(2));
      // After that, once a day.
      await pass(23);
      expect(world.asked).toBe(2);
      await pass(1);
      await vi.waitFor(() => expect(world.asked).toBe(3));
      await pass(48);
      expect(world.asked).toBe(5);
      // The person, and a newer version, are not kept waiting.
      await world.updater.check();
      expect(world.asked).toBe(6);
      await isAt(world, { phase: "failed", version: "0.2.1" });
      world.latest = "0.2.2";
      await world.updater.check();
      await isAt(world, { phase: "failed", version: "0.2.2" });
      await pass(6);
      await vi.waitFor(() => expect(world.asked).toBe(8));
    },
  );

  test("a download that had no answer is tried again after a check that had none, and once more when it has come since", async () => {
    const world = await makeUpdateWorld();
    onTestFinished(() => world.updater.stop());
    world.latest = "0.2.1";
    world.downloads = "network";
    await world.updater.check();
    await isAt(world, { phase: "failed", step: "download" });
    const pass = await hoursOf(world);
    world.checks = "fail";
    await pass(6);
    expect(world.asked).toBe(1);
    world.checks = "answer";
    world.downloads = "whole";
    await pass(6);
    await isAt(world, { phase: "ready", version: "0.2.1" });
    // Downloaded, the next look is a day later.
    const looked = world.looked;
    await pass(23);
    expect(world.looked).toBe(looked);
    // Lost, it is downloaded again, and what it says of no answer is said afresh.
    await rm((await world.zip())!);
    world.downloads = "network";
    await world.updater.check();
    await isAt(world, { phase: "failed", step: "download" });
    expect(world.asked).toBe(3);
    await pass(6);
    await vi.waitFor(() => expect(world.asked).toBe(4));
  });

  test.each([
    ...(["wrong-hash", "wrong-size", "too-large", "not-found", "not-saved"] as const),
    ...(["refused", "too-many-redirects"] as const),
  ])("a download that failed as %s is tried again a day later, not sooner", async (failure) => {
    const world = await makeUpdateWorld();
    onTestFinished(() => world.updater.stop());
    world.latest = "0.2.1";
    world.downloads = failure;
    await world.updater.check();
    await isAt(world, { phase: "failed", step: "download", version: "0.2.1" });
    const pass = await hoursOf(world);
    await pass(23);
    expect(world.asked).toBe(1);
    await pass(1);
    await vi.waitFor(() => expect(world.asked).toBe(2));
  });
});

// What is installed is a Mac app's bundle, by a Mac's paths, as above.
test.skipIf(process.platform === "win32")(
  "whatever comes when, the app can be opened, and the state shown is the one things are in",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const met = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) await playHistory(seed, met);
    // The histories are ones that try it.
    for (const state of [
      ...["ready", "downloading", "installing", "failed", "up-to-date", "cannot-install"],
      ...["a newer one coming", "a newer one ready", "installed", "put back"],
      "ready after a failure",
    ]) {
      expect([...met]).toContain(state);
    }
  },
  60_000,
);
