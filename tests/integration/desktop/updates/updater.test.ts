// The updater end to end against a release of the test's own: a server on
// 127.0.0.1 that answers as GitHub does, with two redirects, a latest-mac.yml
// and a zip. It checks, downloads and verifies into a temporary folder, and
// installs only when asked. The app it would replace is a made-up bundle in
// the test's folder, and the helper is a stand-in that starts nothing, so no
// real app is ever touched and GitHub is never asked.
//
// On macOS the zip is a real one made with ditto, and unpacked with it. On
// another system, where there is no ditto, a stand-in unpacks the bundle the
// "zip" names, and everything else runs as it does on a Mac.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { DITTO, type RunProgram } from "@desktop/updates/install/bundleCheck";
import { HELPER_SCRIPT } from "@desktop/updates/install/installHelper";
import type { ReleaseEndpoints } from "@desktop/updates/release/endpoints";
import { DEFAULT_UPDATE_SETTINGS, type UpdateSettings } from "@desktop/updates/updateSettings";
import { createUpdater, INSTALL_GIVE_UP_MS } from "@desktop/updates/updater";
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
  const temp = path.join(work, "tmp");
  await mkdir(temp);
  let settings: UpdateSettings = DEFAULT_UPDATE_SETTINGS;
  const started: [string, readonly string[]][] = [];
  const quit = vi.fn();
  const warn = vi.fn();
  const updater = createUpdater({
    version: "0.2.0",
    arch: "arm64",
    packaged: true,
    bundle: installed,
    settings: { read: () => settings, write: (next) => (settings = next) },
    tempDir: temp,
    endpoints,
    run: onMac ? undefined : standInDitto,
    startDetached: async (file, args) => {
      started.push([file, args]);
      return true;
    },
    quit,
    warn,
    pid: 4242,
  });
  return { updater, installed, temp, started, quit, warn, asked, settings: () => settings };
}

describe("the updater, against a release of the test's own", () => {
  test("checks, downloads and verifies a newer version, and installs it only when asked", async () => {
    const { updater, installed, temp, started, quit, asked, settings } = await setUp();

    const checked = await updater.check();
    expect(checked.lastCheckedAt).not.toBeNull();
    expect(checked.update).toMatchObject({ phase: "downloading", version: "0.2.1" });
    await vi.waitFor(() => expect(updater.status().update.phase).toBe("ready"), {
      timeout: 15_000,
    });
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

    // It is unpacked in the updater's own folder, and the zip is gone.
    const [staging] = await readdir(temp);
    expect(staging).toMatch(/^agent-lookout-update-/);
    const folder = path.join(temp, staging!);
    expect(await readdir(folder)).toEqual(["app"]);
    const replacement = path.join(folder, "app", "Agent Lookout.app");
    expect(await readFile(path.join(replacement, "Contents", "Info.plist"), "utf8")).toContain(
      "<string>0.2.1</string>",
    );

    // Nothing is installed until Install and Restart.
    expect(started).toEqual([]);
    expect(quit).not.toHaveBeenCalled();

    const answer = await updater.install();
    expect(answer.ok).toBe(true);
    expect(answer.status.update).toMatchObject({ phase: "installing", version: "0.2.1" });
    // Noted, so the copy that opens next knows whether it worked.
    expect(settings().installingVersion).toBe("0.2.1");
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
  });

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
      const { updater, temp, started, warn } = await setUp(release);
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
      expect(await readdir(temp)).toEqual([]);
      expect((await updater.install()).ok).toBe(false);
      expect(started).toEqual([]);
    },
  );

  test("an app that has not quit once the helper stops waiting says the install did not work", async () => {
    const { updater, temp, settings } = await setUp();
    await updater.check();
    await vi.waitFor(() => expect(updater.status().update.phase).toBe("ready"), {
      timeout: 15_000,
    });

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
    expect(updater.status().update).toEqual({
      phase: "failed",
      step: "install",
      reason: "Agent Lookout did not quit in time to be replaced",
      version: "0.2.1",
      notesUrl: expect.stringMatching(/\/releases\/tag\/v0\.2\.1$/),
    });
    expect(settings().installingVersion).toBeNull();
    await vi.waitFor(async () => expect(await readdir(temp)).toEqual([]));
    updater.stop();
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
    await vi.waitFor(() => expect(updater.status().update.phase).toBe("ready"), {
      timeout: 15_000,
    });
    updater.stop();
  });
});
