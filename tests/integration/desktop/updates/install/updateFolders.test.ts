import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { describe, expect, test, vi } from "vitest";

import { createUpdateFolders, type Removal } from "@desktop/updates/install/updateFolders";
import { tempDir } from "@tests/support/node/tempFiles";

async function setUp(removal: Removal) {
  const work = await tempDir();
  const dataDir = path.join(work, "data");
  const older = path.join(work, "tmp");
  await mkdir(dataDir);
  await mkdir(older);
  return { dataDir, older, folders: createUpdateFolders({ dataDir, tempDir: older, removal }) };
}

describe("the folders of an update", () => {
  test("are made in the app's own folder, and only what is handed in removes one", async () => {
    const removal = { rm: vi.fn(async () => {}), rmSync: vi.fn() };
    const { dataDir, older, folders } = await setUp(removal);
    const first = folders.make();
    const second = folders.make();
    expect(path.dirname(first)).toBe(dataDir);
    const left = path.join(dataDir, "agent-lookout-update-a1B2c3");
    const leftBefore = path.join(older, "agent-lookout-update-d4E5f6");
    await mkdir(left);
    await mkdir(leftBefore);
    const all = { recursive: true, force: true };

    await folders.sweep();
    expect(removal.rm.mock.calls).toEqual([
      [left, all],
      [leftBefore, all],
    ]);
    removal.rm.mockClear();
    await folders.remove(first);
    expect(removal.rm.mock.calls).toEqual([[first, all]]);
    expect(removal.rmSync).not.toHaveBeenCalled();
    folders.removeAll(null);
    expect(removal.rmSync.mock.calls).toEqual([[second, all]]);
  });

  test("one that could not be removed is removed as the app quits, and never the one given", async () => {
    const removal = { rm: vi.fn(rm), rmSync };
    const { dataDir, folders } = await setUp(removal);
    const stuck = folders.make();
    const handedOver = folders.make();
    removal.rm.mockRejectedValueOnce(new Error("ENOTEMPTY"));
    await folders.remove(stuck);
    expect(await readdir(dataDir)).toHaveLength(2);
    folders.removeAll(handedOver);
    expect(await readdir(dataDir)).toEqual([path.basename(handedOver)]);
  });
});

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
// Electron's own setting for where it is, or where its package puts it.
const dist =
  process.env.ELECTRON_OVERRIDE_DIST_PATH ?? path.join(root, "node_modules", "electron", "dist");
const electron = path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");

/** An asar archive with one file in it, as Electron packs the app's. */
function asarBytes(): Buffer {
  const json = JSON.stringify({ files: { "main.cjs": { size: 4, offset: "0" } } });
  const padded = json.padEnd(Math.ceil(json.length / 4) * 4, "\0");
  const header = Buffer.alloc(16);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(padded.length + 8, 4);
  header.writeUInt32LE(padded.length + 4, 8);
  header.writeUInt32LE(json.length, 12);
  return Buffer.concat([header, Buffer.from(padded), Buffer.from("app;")]);
}

// Electron's package downloads its program only when something runs it, so on CI it is not there.
test.skipIf(!existsSync(electron))(
  "in Electron, nothing of a discarded app is left behind or held open, its app.asar neither",
  async () => {
    const work = await tempDir();
    const dataDir = path.join(work, "data");
    await mkdir(dataDir);
    const asar = path.join(work, "asar.bin");
    await writeFile(asar, asarBytes());
    const script = path.join(work, "script.mjs");
    await build({
      stdin: {
        contents: `
          import { createUpdateFolders } from "./src/desktop/updates/install/updateFolders.ts";
          import { copyFileSync, mkdirSync, promises, readdirSync, rmSync } from "original-fs";
          import path from "node:path";
          const [dataDir, asar] = process.argv.slice(2);
          const removal = { rm: promises.rm, rmSync };
          const folders = createUpdateFolders({ dataDir, tempDir: dataDir + "/none", removal });
          const fill = (folder) => {
            const resources = path.join(folder, "Agent Lookout.app", "Contents", "Resources");
            mkdirSync(resources, { recursive: true });
            copyFileSync(asar, path.join(resources, "app.asar"));
          };
          const removed = folders.make();
          const atQuit = folders.make();
          const swept = path.join(dataDir, "agent-lookout-update-a1B2c3");
          for (const folder of [removed, atQuit, swept]) fill(folder);
          const open = () => readdirSync("/dev/fd").length;
          const before = open();
          await folders.remove(removed);
          await folders.sweep();
          folders.removeAll(null);
          console.log(JSON.stringify({ left: readdirSync(dataDir), open: open() - before }));
        `,
        resolveDir: root,
        loader: "ts",
      },
      outfile: script,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["original-fs"],
    });
    const { stdout } = await promisify(execFile)(electron, [script, dataDir, asar], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(JSON.parse(stdout)).toEqual({ left: [], open: 0 });
  },
);
