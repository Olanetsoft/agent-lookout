// `latest-mac.yml`, the file electron-builder writes beside the app it builds
// and the release workflow attaches to each GitHub release: the version, and
// for each file of the release its name, its size and the base64 of its
// SHA-512.
//
//   version: 0.2.1
//   files:
//     - url: Agent-Lookout-0.2.1-mac-arm64.zip
//       sha512: <88 characters of base64>
//       size: 104857600
//   path: Agent-Lookout-0.2.1-mac-arm64.zip
//   sha512: <the same>
//   releaseDate: '2026-10-06T12:00:00.000Z'
//
// Only that much YAML is read: keys and plain or quoted values, and the list
// of files. Anything else in it is skipped, and a file whose name, size or
// hash is not what one can be is left out, so nothing in the text can choose a
// path, an address or a command. The text is held to a size before it is read.
//
// It imports nothing, so it is tested in plain Node.

import { parseVersion } from "./version.ts";

/** The most the file may hold. One for this app is well under a kilobyte. */
export const MAX_MANIFEST_BYTES = 64 * 1024;

/** The largest file the app will download. The app is about a hundred megabytes. */
export const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

/** One file of a release, as the manifest gives it. */
export interface ReleaseFile {
  /** The file's name in the release, such as `Agent-Lookout-0.2.1-mac-arm64.zip`. */
  name: string;
  /** Its SHA-512, in base64. */
  sha512: string;
  /** Its size in bytes. */
  size: number;
}

export interface ReleaseManifest {
  version: string;
  files: readonly ReleaseFile[];
}

/** The kinds of Mac the app is built for. */
export type MacArch = "arm64" | "x64";

/** A file's name in a release: letters, digits, dots, dashes and underscores, and no folder. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** A SHA-512 in base64: 64 bytes are 86 characters and two of padding. */
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/;

const KEY_AND_VALUE = /^([A-Za-z][A-Za-z0-9_]*):(?:\s+(.*))?$/;

/** A value as YAML writes a plain or quoted scalar, or null when it is quoted wrongly. */
function scalar(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) return null;
    const inner = value.slice(1, -1);
    // A quote inside is written twice. One alone would end the value early.
    if (inner.replace(/''/g, "").includes("'")) return null;
    return inner.replace(/''/g, "'");
  }
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  // A plain value ends where a comment begins.
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A file of the list, or null when one of its three parts is not what it can be. */
function fileOf(fields: Map<string, string>): ReleaseFile | null {
  const name = fields.get("url");
  const sha512 = fields.get("sha512");
  const size = fields.get("size");
  if (name === undefined || sha512 === undefined || size === undefined) return null;
  if (!FILE_NAME.test(name) || !SHA512_BASE64.test(sha512) || !/^[1-9]\d{0,11}$/.test(size)) {
    return null;
  }
  const bytes = Number(size);
  if (bytes > MAX_DOWNLOAD_BYTES) return null;
  return { name, sha512, size: bytes };
}

/**
 * The manifest in a `latest-mac.yml`, or null when the text is too long, has
 * no version that can be read, or is not the shape electron-builder writes.
 */
export function readManifest(text: string): ReleaseManifest | null {
  if (text.length > MAX_MANIFEST_BYTES) return null;
  let version: string | null = null;
  const files: ReleaseFile[] = [];
  let inFiles = false;
  let item: Map<string, string> | null = null;

  const endItem = () => {
    if (item === null) return;
    const file = fileOf(item);
    if (file !== null) files.push(file);
    item = null;
  };

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (line.includes("\t")) return null;
    const indent = indentOf(line);

    // An item of the list of files, at any depth under `files:`.
    if (inFiles && (trimmed === "-" || trimmed.startsWith("- "))) {
      endItem();
      item = new Map();
      const rest = trimmed.slice(1).trim();
      if (rest === "") continue;
      const field = KEY_AND_VALUE.exec(rest);
      const value = field ? scalar(field[2]) : null;
      if (field === null || value === null) return null;
      item.set(field[1] ?? "", value);
      continue;
    }

    if (indent > 0) {
      // A line inside an item of the list, or under a key that is skipped.
      if (!inFiles || item === null) continue;
      const field = KEY_AND_VALUE.exec(trimmed);
      if (field === null) continue;
      const value = scalar(field[2]);
      if (value === null) return null;
      item.set(field[1] ?? "", value);
      continue;
    }

    // A key of the file itself.
    endItem();
    inFiles = false;
    const field = KEY_AND_VALUE.exec(trimmed);
    if (field === null) return null;
    const [, key, raw] = field;
    if (key === "files") {
      if ((raw ?? "").trim() !== "") return null;
      inFiles = true;
    } else if (key === "version") {
      const value = scalar(raw);
      if (value === null) return null;
      version = value;
    }
  }
  endItem();

  if (version === null || parseVersion(version) === null) return null;
  return { version, files };
}

/**
 * The zip for this kind of Mac, as electron-builder names it from
 * `artifactName` in `electron-builder.ts`, or null when the release has none.
 */
export function zipFor(manifest: ReleaseManifest, arch: MacArch): ReleaseFile | null {
  return manifest.files.find((file) => file.name.endsWith(`-mac-${arch}.zip`)) ?? null;
}
