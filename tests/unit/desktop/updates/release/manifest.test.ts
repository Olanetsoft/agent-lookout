import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  MAX_DOWNLOAD_BYTES,
  MAX_MANIFEST_BYTES,
  readManifest,
  zipFor,
} from "@desktop/updates/release/manifest";

/** A SHA-512 in base64, as electron-builder writes one, of some made-up bytes. */
const sha = (text: string) => createHash("sha512").update(text).digest("base64");

const ARM_ZIP = sha("arm64 zip");
const X64_ZIP = sha("x64 zip");
const ARM_DMG = sha("arm64 dmg");

/** A `latest-mac.yml` laid out as electron-builder writes one, for an invented version. */
const MANIFEST = `version: 0.2.1
files:
  - url: Agent-Lookout-0.2.1-mac-x64.zip
    sha512: ${X64_ZIP}
    size: 104857600
  - url: Agent-Lookout-0.2.1-mac-arm64.zip
    sha512: ${ARM_ZIP}
    size: 99614720
  - url: Agent-Lookout-0.2.1-mac-arm64.dmg
    sha512: ${ARM_DMG}
    size: 101711872
    blockMapSize: 107520
path: Agent-Lookout-0.2.1-mac-x64.zip
sha512: ${X64_ZIP}
releaseDate: '2026-10-06T12:00:00.000Z'
`;

describe("readManifest", () => {
  test("reads the version and each file's name, hash and size", () => {
    expect(readManifest(MANIFEST)).toEqual({
      version: "0.2.1",
      files: [
        { name: "Agent-Lookout-0.2.1-mac-x64.zip", sha512: X64_ZIP, size: 104857600 },
        { name: "Agent-Lookout-0.2.1-mac-arm64.zip", sha512: ARM_ZIP, size: 99614720 },
        { name: "Agent-Lookout-0.2.1-mac-arm64.dmg", sha512: ARM_DMG, size: 101711872 },
      ],
    });
  });

  test("reads a list written without its indent, quoted values, comments and Windows line ends", () => {
    const text = [
      "# written by hand",
      "version: '0.2.1'",
      "files:",
      `- url: "Agent-Lookout-0.2.1-mac-arm64.zip"`,
      `  sha512: '${ARM_ZIP}'`,
      "  size: 99614720 # bytes",
      "releaseDate: '2026-10-06T12:00:00.000Z'",
    ].join("\r\n");
    expect(readManifest(text)?.files).toEqual([
      { name: "Agent-Lookout-0.2.1-mac-arm64.zip", sha512: ARM_ZIP, size: 99614720 },
    ]);
  });

  test("skips release notes and other keys it has no use for", () => {
    const text = `version: 0.2.1
releaseNotes: |-
  Fixed: a thing.
  version: 9.9.9
releaseName: Something
files:
  - url: Agent-Lookout-0.2.1-mac-arm64.zip
    sha512: ${ARM_ZIP}
    size: 99614720
`;
    const manifest = readManifest(text);
    expect(manifest?.version).toBe("0.2.1");
    expect(manifest?.files).toHaveLength(1);
  });

  test.each([
    ["a folder", "../Agent-Lookout.zip"],
    ["a path", "dir/Agent-Lookout-0.2.1-mac-arm64.zip"],
    ["an address", "https://example.com/Agent-Lookout-0.2.1-mac-arm64.zip"],
    ["a space", "Agent Lookout.zip"],
    ["a leading dot", ".hidden.zip"],
  ])("leaves out a file whose name is %s", (_what, name) => {
    const text = `version: 0.2.1
files:
  - url: ${name}
    sha512: ${ARM_ZIP}
    size: 10
`;
    expect(readManifest(text)?.files).toEqual([]);
  });

  test.each([
    ["no hash", "size: 10"],
    ["a short hash", `sha512: ${ARM_ZIP.slice(4)}\n    size: 10`],
    ["a hex hash", `sha512: ${"ab".repeat(64)}\n    size: 10`],
    ["no size", `sha512: ${ARM_ZIP}`],
    ["a size of nothing", `sha512: ${ARM_ZIP}\n    size: 0`],
    ["a size in words", `sha512: ${ARM_ZIP}\n    size: big`],
    ["a size past the limit", `sha512: ${ARM_ZIP}\n    size: ${MAX_DOWNLOAD_BYTES + 1}`],
  ])("leaves out a file with %s", (_what, fields) => {
    const text = `version: 0.2.1
files:
  - url: Agent-Lookout-0.2.1-mac-arm64.zip
    ${fields}
`;
    expect(readManifest(text)?.files).toEqual([]);
  });

  test.each([
    ["no version", `files:\n  - url: a.zip\n`],
    ["a version that is not one", "version: latest\n"],
    ["a tag for a version", "version: v0.2.1\n"],
    ["a quote left open", "version: '0.2.1\n"],
    ["a quote inside a quoted value", "version: 'a'b'\n"],
    ["a tab", "version:\t0.2.1\n"],
    ["a line that is not a key", "version: 0.2.1\nnot yaml at all\n"],
    ["files with a value", "version: 0.2.1\nfiles: none\n"],
    ["JSON", '{"version": "0.2.1"}'],
    ["nothing", ""],
  ])("refuses a file with %s", (_what, text) => {
    expect(readManifest(text)).toBeNull();
  });

  test("refuses a file longer than the limit before reading it", () => {
    expect(readManifest(`version: 0.2.1\n# ${"x".repeat(MAX_MANIFEST_BYTES)}\n`)).toBeNull();
  });
});

describe("zipFor", () => {
  test("picks the zip for each kind of Mac, never a disk image", () => {
    const manifest = readManifest(MANIFEST)!;
    expect(zipFor(manifest, "arm64")?.name).toBe("Agent-Lookout-0.2.1-mac-arm64.zip");
    expect(zipFor(manifest, "x64")?.name).toBe("Agent-Lookout-0.2.1-mac-x64.zip");
  });

  test("gives nothing when the release has no zip for this kind of Mac", () => {
    const manifest = readManifest(MANIFEST)!;
    const intelOnly = { ...manifest, files: manifest.files.filter((f) => f.name.includes("x64")) };
    expect(zipFor(intelOnly, "arm64")).toBeNull();
  });
});
