import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { editorCommandFor, openFolder } from "@collector/editor/openFolder";
import type { RunEditor } from "@collector/editor/program";
import { tempDir } from "@tests/support/node/tempFiles";
import { EDITOR_FAILED, fakeEditor } from "@tests/support/node/terminal";

// Real folders, made in a folder of the test's own, and an editor's command
// that runs nothing. The paths are macOS's and Linux's, so this is not run on
// Windows, where no editor is ever asked.

/** A home folder that is none of the test's folders. */
const HOME = "/Users/example";

/** A folder named for a session, beside an editor's app, both in a folder of the test's own. */
async function setUp() {
  const root = await tempDir();
  const bundle = path.join(root, "Visual Studio Code.app");
  await mkdir(path.join(bundle, "Contents"), { recursive: true });
  const folder = path.join(root, "storefront");
  await mkdir(folder);
  return { root, editor: { app: "VS Code", bundle } as const, folder };
}

describe.skipIf(process.platform === "win32")("openFolder on real folders", () => {
  test("opens a folder that is a folder: the editor's own command, --new-window and the folder", async () => {
    const { editor, folder } = await setUp();
    const run = fakeEditor();

    expect(await openFolder(editor, folder, run.run, { homeDir: HOME })).toEqual({ ok: true });
    expect(run.ran).toEqual([
      [`${editor.bundle}/Contents/Resources/app/bin/code`, "--new-window", folder],
    ]);
    expect(editorCommandFor(editor, folder, HOME)?.args).toEqual(["--new-window", folder]);
  });

  test.each<[string, (place: Awaited<ReturnType<typeof setUp>>) => Promise<string>]>([
    [
      "is gone",
      async ({ folder }) => {
        await rm(folder, { recursive: true });
        return folder;
      },
    ],
    [
      "is now a file",
      async ({ folder }) => {
        await rm(folder, { recursive: true });
        await writeFile(folder, "");
        return folder;
      },
    ],
    [
      "is under a file",
      async ({ root }) => {
        await writeFile(path.join(root, "notes"), "");
        return path.join(root, "notes", "storefront");
      },
    ],
  ])("does not open a folder that %s, and runs nothing", async (_what, make) => {
    const place = await setUp();
    const folder = await make(place);
    const run = fakeEditor();

    expect(await openFolder(place.editor, folder, run.run, { homeDir: HOME })).toEqual({
      ok: false,
      reason: "folder-gone",
    });
    expect(run.ran).toEqual([]);
  });

  test.each([
    ["a folder", true],
    ["nothing", false],
  ])(
    "does not open a folder that is now a link to %s, says it is a link, and runs nothing",
    async (_what, leadsSomewhere) => {
      const { root, editor, folder } = await setUp();
      const elsewhere = path.join(root, "elsewhere");
      if (leadsSomewhere) await mkdir(elsewhere);
      await rm(folder, { recursive: true });
      await symlink(elsewhere, folder);
      const run = fakeEditor();

      expect(await openFolder(editor, folder, run.run, { homeDir: HOME })).toEqual({
        ok: false,
        reason: "folder-link",
      });
      expect(run.ran).toEqual([]);
    },
  );

  test("does not open a folder reached through a link that leads into an app", async () => {
    const { root, editor } = await setUp();
    const resources = path.join(root, "Other.app", "Contents", "Resources");
    await mkdir(resources, { recursive: true });
    const via = path.join(root, "via");
    await symlink(path.join(root, "Other.app", "Contents"), via);
    const run = fakeEditor();

    expect(
      await openFolder(editor, path.join(via, "Resources"), run.run, { homeDir: HOME }),
    ).toEqual({ ok: false, reason: "not-opened" });
    expect(run.ran).toEqual([]);
  });

  test("does not open a folder whose real place is the home folder", async () => {
    const { root, editor } = await setUp();
    const home = path.join(root, "home");
    await mkdir(home);
    const via = path.join(root, "via");
    await symlink(root, via);
    const run = fakeEditor();

    // The home folder with every link on its way followed, so only the
    // session's folder is reached through a link.
    const homeDir = await realpath(home);
    expect(await openFolder(editor, path.join(via, "home"), run.run, { homeDir })).toEqual({
      ok: false,
      reason: "not-opened",
    });
    expect(run.ran).toEqual([]);
  });

  test("does not open the home folder when the home folder is named through a link", async () => {
    const { root, editor } = await setUp();
    const home = path.join(root, "realhome");
    await mkdir(home);
    const linkedHome = path.join(root, "linkhome");
    await symlink(home, linkedHome);
    const run = fakeEditor();

    // `os.homedir()` gives `HOME` as it is set, links and all, and a session's
    // folder can be the real path, as a process's working folder is given
    // with every link followed.
    expect(
      await openFolder(editor, await realpath(home), run.run, { homeDir: linkedHome }),
    ).toEqual({ ok: false, reason: "not-opened" });
    expect(run.ran).toEqual([]);
  });

  test("a home folder whose links cannot be followed does not stop another folder opening", async () => {
    const { root, editor, folder } = await setUp();
    const run = fakeEditor();

    expect(
      await openFolder(editor, folder, run.run, { homeDir: path.join(root, "no-such-home") }),
    ).toEqual({ ok: true });
    expect(run.ran).toHaveLength(1);
  });

  test("a run of the command that fails is a failure", async () => {
    const { editor, folder } = await setUp();
    const run = fakeEditor(EDITOR_FAILED);

    expect(await openFolder(editor, folder, run.run, { homeDir: HOME })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(run.ran).toHaveLength(1);
  });

  test("a run the runner says timed out is a failure: openFolder adds no wait of its own", async () => {
    const { editor, folder } = await setUp();
    const timedOut: RunEditor = async () => ({ ok: false, timedOut: true });

    expect(await openFolder(editor, folder, timedOut, { homeDir: HOME })).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});
