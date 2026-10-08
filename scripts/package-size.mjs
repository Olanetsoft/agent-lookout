// Prints how big the npm package is, and stops when it has grown past a
// limit, so that it does not grow back unnoticed. The CI job `package` and the
// release workflow's job of the same name run it on the tarball they packed,
// once it is installed into a folder of its own. To run it by hand:
//
//   npm pack --pack-destination /tmp
//   mkdir /tmp/try && cd /tmp/try && echo '{ "private": true }' > package.json
//   npm install /tmp/agent-lookout-*.tgz
//   node /path/to/agent-lookout/scripts/package-size.mjs /tmp/agent-lookout-*.tgz /tmp/try
//
// It measures three sizes, in bytes: the tarball as npm downloads it, the
// files in it once unpacked, and everything npm installed into the folder's
// node_modules, the package's dependencies included, as each file's length,
// so the number is the same on every file system. A link is counted as a
// link and not followed.
//
// It exits with 0 when every size is within its limit, 1 when one is not and
// 2 when it could not measure them.

import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * The limits, with headroom over the sizes once the MCP SDK and zod were
 * bundled and the .woff fonts left out: a tarball of 0.66 MB, 2.37 MB
 * unpacked, and 3.96 MB installed with nodemailer. Before, they were 0.63 MB,
 * 1.69 MB and 20.45 MB. Raise a limit only on purpose, and say why in the
 * pull request.
 *
 * Unpacked was raised from 3.00 MB to 3.25 MB once it reached 3.01 MB. Of
 * the 0.64 MB it grew from 2.37 MB, about half is the documents the package
 * ships, the guide, PRIVACY.md, the API, SECURITY.md and the CHANGELOG, and
 * the rest the dashboard and the command, as phone pushes, other machines,
 * the Antigravity CLI and permission rules came.
 */
const LIMITS = {
  tarball: 1_000_000,
  unpacked: 3_250_000,
  installed: 5_000_000,
};

/** Bytes as megabytes, as npm gives sizes. */
function megabytes(bytes) {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/** The total length of the files in a gzipped tar, and how many there are, from its headers. */
function unpacked(tarball) {
  const tar = gunzipSync(tarball);
  let bytes = 0;
  let files = 0;
  let at = 0;
  while (at + 512 <= tar.length) {
    const header = tar.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(
      header.subarray(124, 136).toString("latin1").replace(/\0/g, "").trim() || "0",
      8,
    );
    if (!Number.isFinite(size)) throw new Error("The tarball has a header that cannot be read.");
    // A regular file. Folders, links and the headers that hold long names are not files.
    const type = header[156];
    if (type === 0 || type === 0x30) {
      bytes += size;
      files += 1;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return { bytes, files };
}

/** The total length of the files under a folder, and how many there are. */
async function folderSize(folder) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      const inside = await folderSize(file);
      bytes += inside.bytes;
      files += inside.files;
    } else {
      bytes += (await lstat(file)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

/** The names of the packages installed directly in a node_modules folder. */
async function packagesIn(nodeModules) {
  const names = [];
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!entry.name.startsWith("@")) {
      names.push(entry.name);
      continue;
    }
    for (const inner of await readdir(path.join(nodeModules, entry.name), {
      withFileTypes: true,
    })) {
      if (inner.isDirectory()) names.push(`${entry.name}/${inner.name}`);
    }
  }
  return names.sort();
}

async function main() {
  const [tarballFile, installFolder] = process.argv.slice(2);
  if (!tarballFile || !installFolder) {
    console.error(
      "Give the tarball and the folder it is installed in: package-size.mjs <tarball> <folder>.",
    );
    return 2;
  }
  const tarball = await readFile(tarballFile);
  const inside = unpacked(tarball);
  const nodeModules = path.join(installFolder, "node_modules");
  const installed = await folderSize(nodeModules);
  const packages = await packagesIn(nodeModules);

  const sizes = [
    ["tarball", tarball.length, "the tarball npm downloads"],
    ["unpacked", inside.bytes, `the ${inside.files} files in it`],
    [
      "installed",
      installed.bytes,
      `node_modules, ${installed.files} files in ${packages.length} packages: ${packages.join(", ")}`,
    ],
  ];
  let over = 0;
  for (const [name, bytes, what] of sizes) {
    const limit = LIMITS[name];
    const within = bytes <= limit;
    if (!within) over += 1;
    console.log(
      `${within ? "ok  " : "OVER"}  ${name.padEnd(9)} ${megabytes(bytes).padStart(8)} of ${megabytes(limit)} (${bytes} bytes), ${what}`,
    );
  }
  if (over > 0) {
    console.log(
      "\nThe package has grown past its limits. Find what grew, or raise the limit in scripts/package-size.mjs and say why.",
    );
    return 1;
  }
  return 0;
}

let code = 2;
try {
  code = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
}
process.exit(code);
