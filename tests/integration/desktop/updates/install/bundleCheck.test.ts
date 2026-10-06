import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import {
  bundleFacts,
  DITTO,
  unpackApp,
  type RunProgram,
} from "@desktop/updates/install/bundleCheck";
import { tempDir } from "@tests/support/node/tempFiles";

const run = promisify(execFile);

const INFO_PLIST = (identifier: string, version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>${identifier}</string>
    <key>CFBundleShortVersionString</key>
    <string>${version}</string>
  </dict>
</plist>
`;

/** A made-up app bundle: a folder with an Info.plist and one file. */
async function makeBundle(dir: string, name: string, identifier: string, version: string) {
  const bundle = path.join(dir, name);
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(path.join(bundle, "Contents", "Info.plist"), INFO_PLIST(identifier, version));
  await writeFile(path.join(bundle, "Contents", "MacOS", "demo"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  return bundle;
}

describe("bundleFacts", () => {
  test("reads an XML Info.plist", async () => {
    const bundle = await makeBundle(await tempDir(), "Demo.app", "dev.example.demo", "0.2.1");
    expect(await bundleFacts(bundle)).toEqual({ identifier: "dev.example.demo", version: "0.2.1" });
  });

  test("gives nothing for a folder that is not a bundle", async () => {
    expect(await bundleFacts(await tempDir())).toBeNull();
  });

  test.runIf(process.platform === "darwin")(
    "reads a binary Info.plist through plutil",
    async () => {
      const bundle = await makeBundle(await tempDir(), "Demo.app", "dev.example.demo", "0.2.1");
      await run("/usr/bin/plutil", [
        "-convert",
        "binary1",
        path.join(bundle, "Contents", "Info.plist"),
      ]);
      expect(await bundleFacts(bundle)).toEqual({
        identifier: "dev.example.demo",
        version: "0.2.1",
      });
    },
  );
});

/**
 * Lays out what a zip of each kind would unpack to, with a link where the
 * bundle, its Contents or its Info.plist should be, each pointing at a real
 * bundle elsewhere in the test's folder.
 */
const LINKED = {
  "the bundle itself": async (into: string, other: string) => {
    await symlink(other, path.join(into, "Demo.app"));
  },
  "its Contents folder": async (into: string, other: string) => {
    await mkdir(path.join(into, "Demo.app"));
    await symlink(path.join(other, "Contents"), path.join(into, "Demo.app", "Contents"));
  },
  "its Info.plist": async (into: string, other: string) => {
    await mkdir(path.join(into, "Demo.app", "Contents"), { recursive: true });
    await symlink(
      path.join(other, "Contents", "Info.plist"),
      path.join(into, "Demo.app", "Contents", "Info.plist"),
    );
  },
} as const;

describe("unpackApp, with a link in the bundle", () => {
  test.each(Object.keys(LINKED) as (keyof typeof LINKED)[])(
    "refuses a link as %s",
    async (where) => {
      const work = await tempDir();
      const other = await makeBundle(work, "Other.app", "dev.example.demo", "0.2.1");
      const into = path.join(work, "into");
      await mkdir(into);
      // A stand-in for ditto, which unpacks a link as a link.
      const unpack: RunProgram = async (file, args) => {
        if (file !== DITTO || args[3] !== into) return { ok: false };
        await LINKED[where](into, other);
        return { ok: true, stdout: "" };
      };
      expect(await unpackApp(path.join(work, "linked.zip"), into, unpack)).toBeNull();
    },
  );
});

describe.runIf(process.platform === "darwin")("unpackApp, with the real ditto", () => {
  test("unpacks a zip made as electron-builder makes one, with the app at its top", async () => {
    const work = await tempDir();
    const bundle = await makeBundle(work, "Demo.app", "dev.example.demo", "0.2.1");
    const zip = path.join(work, "Demo-0.2.1-mac-arm64.zip");
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, zip]);
    const into = path.join(work, "into");
    await mkdir(into);

    const app = await unpackApp(zip, into);
    expect(app).toBe(path.join(into, "Demo.app"));
    expect(await bundleFacts(app!)).toEqual({ identifier: "dev.example.demo", version: "0.2.1" });
  });

  test("refuses a zip with more than the one app in it", async () => {
    const work = await tempDir();
    const source = path.join(work, "source");
    await makeBundle(source, "Demo.app", "dev.example.demo", "0.2.1");
    await writeFile(path.join(source, "extra.txt"), "not an app");
    const zip = path.join(work, "two.zip");
    await run("/usr/bin/ditto", ["-c", "-k", source, zip]);
    const into = path.join(work, "into");
    await mkdir(into);
    expect(await unpackApp(zip, into)).toBeNull();
  });

  test("refuses a zip whose app is a link to another app", async () => {
    const work = await tempDir();
    const other = await makeBundle(work, "Other.app", "dev.example.demo", "0.2.1");
    const source = path.join(work, "source");
    await mkdir(source);
    await symlink(other, path.join(source, "Demo.app"));
    const zip = path.join(work, "link.zip");
    // ditto keeps the link a link, in the zip and when it unpacks it.
    await run("/usr/bin/ditto", ["-c", "-k", source, zip]);
    const into = path.join(work, "into");
    await mkdir(into);
    expect(await unpackApp(zip, into)).toBeNull();
  });

  test("refuses a file that is not a zip", async () => {
    const work = await tempDir();
    const zip = path.join(work, "not.zip");
    await writeFile(zip, "these bytes are not a zip");
    const into = path.join(work, "into");
    await mkdir(into);
    expect(await unpackApp(zip, into)).toBeNull();
  });
});
