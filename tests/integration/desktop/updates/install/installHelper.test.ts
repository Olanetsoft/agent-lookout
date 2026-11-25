// The helper's own script, run by the real `/bin/sh` with the real `mv`, on
// made-up bundles in a folder of the test's own. Only `/usr/bin/open` in it is
// another program, one that runs the bundle's own, so no app is opened. The
// process it waits for is one of the test's own.

import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { HELPER_SCRIPT, HELPER_SHELL } from "@desktop/updates/install/installHelper";
import { tempDir } from "@tests/support/node/tempFiles";

/** A made-up bundle whose program says its version. */
async function makeBundle(dir: string, version: string): Promise<string> {
  const bundle = path.join(dir, "Agent Lookout.app");
  await mkdir(path.join(bundle, "Contents", "MacOS"), { recursive: true });
  await mkdir(path.join(bundle, "Contents", "Resources"));
  await writeFile(path.join(bundle, "Contents", "Info.plist"), version);
  await writeFile(
    path.join(bundle, "Contents", "MacOS", "Agent Lookout"),
    `#!/bin/sh\necho "${version}"\n`,
    { mode: 0o755 },
  );
  return bundle;
}

async function setUp() {
  const work = await tempDir();
  const folder = path.join(work, "agent-lookout-update-a1B2c3");
  const app = await makeBundle(path.join(work, "Applications"), "old");
  const replacement = await makeBundle(path.join(folder, "app-d4E5f6"), "new");
  const aside = path.join(folder, "previous", "Agent Lookout.app");
  await mkdir(path.dirname(aside));
  const opened = path.join(work, "opened.txt");
  await writeFile(opened, "");
  const open = path.join(work, "open");

  /** Runs the script as the app does, once a process of the test's own has ended, and gives its exit code. */
  const run = async (opener: string): Promise<number | null> => {
    await writeFile(open, `#!/bin/sh\n${opener}\n`, { mode: 0o755 });
    await chmod(open, 0o755);
    const running = spawn("/bin/sleep", ["0.3"], { stdio: "ignore" });
    const script = HELPER_SCRIPT.replaceAll("/usr/bin/open", `'${open}'`);
    const args = [
      "-c",
      script,
      "agent-lookout-update",
      String(running.pid),
      app,
      replacement,
      aside,
    ];
    const helper = spawn(HELPER_SHELL, args, { stdio: "ignore" });
    return new Promise((resolve) => helper.once("exit", (code) => resolve(code)));
  };
  /** Opens a bundle as macOS would: its program runs, or it cannot be opened. */
  const OPEN = `"$1"/Contents/MacOS/"Agent Lookout" >> '${opened}' 2>/dev/null`;
  /** Says that whatever it is given was opened. */
  const OPEN_ANY = `echo "$1" >> '${opened}'`;
  return {
    folder,
    app,
    replacement,
    aside,
    OPEN,
    OPEN_ANY,
    run,
    opened: async () => (await readFile(opened, "utf8")).trim().split("\n"),
  };
}

const versionOf = (bundle: string) =>
  readFile(path.join(bundle, "Contents", "Info.plist"), "utf8").catch(() => null);

// The script is POSIX sh, which Windows has none of.
describe.skipIf(process.platform === "win32")("the helper's script", () => {
  test("puts the new version in the old one's place and opens it, and keeps the old one", async () => {
    const { app, replacement, aside, OPEN, run, opened } = await setUp();
    expect(await run(OPEN)).toBe(0);
    expect(await versionOf(app)).toBe("new");
    expect(await versionOf(aside)).toBe("old");
    expect(await versionOf(replacement)).toBeNull();
    expect(await opened()).toEqual(["new"]);
  });

  const CLEARED: Record<string, (replacement: string) => Promise<void>> = {
    "has no program": (replacement) =>
      rm(path.join(replacement, "Contents", "MacOS", "Agent Lookout")),
    "has a program that cannot be run": (replacement) =>
      chmod(path.join(replacement, "Contents", "MacOS", "Agent Lookout"), 0o644),
    "has no Info.plist": (replacement) => rm(path.join(replacement, "Contents", "Info.plist")),
    "has only folders left": async (replacement) => {
      await rm(path.join(replacement, "Contents", "MacOS", "Agent Lookout"));
      await rm(path.join(replacement, "Contents", "Info.plist"));
    },
    "is gone": (replacement) => rm(replacement, { recursive: true }),
  };

  // The open here never fails, so nothing it says puts back what was moved.
  test.each(Object.keys(CLEARED))("moves nothing for a new version that %s", async (what) => {
    const { app, replacement, aside, OPEN_ANY, run, opened } = await setUp();
    await CLEARED[what]!(replacement);
    /** Changes when anything is moved in or out of the folder the app is in, also when it is put back. */
    const moved = async () => (await stat(path.dirname(app), { bigint: true })).mtimeNs;
    const before = await moved();
    expect(await run(OPEN_ANY)).toBe(1);
    expect(await moved()).toBe(before);
    expect(await versionOf(app)).toBe("old");
    expect(await versionOf(aside)).toBeNull();
    expect(await opened()).toEqual([app]);
  });

  test("puts the old version back, and opens it, when the new one cannot be opened", async () => {
    const { app, replacement, aside, OPEN, run, opened } = await setUp();
    await writeFile(
      path.join(replacement, "Contents", "MacOS", "Agent Lookout"),
      "#!/bin/sh\nexit 1\n",
    );
    expect(await run(OPEN)).toBe(1);
    expect(await versionOf(app)).toBe("old");
    // Nothing is put inside it, as mv does with a folder that is there already.
    expect(await readdir(app)).toEqual(["Contents"]);
    expect(await versionOf(replacement)).toBe("new");
    expect(await versionOf(aside)).toBeNull();
    expect(await opened()).toEqual(["old"]);
  });

  test("an open that fails once is tried once more before the old version is put back", async () => {
    const { folder, app, OPEN, run, opened } = await setUp();
    const tried = path.join(folder, "tried");
    expect(await run(`if [ ! -e '${tried}' ]; then : > '${tried}'; exit 1; fi\n${OPEN}`)).toBe(0);
    expect(await versionOf(app)).toBe("new");
    expect(await opened()).toEqual(["new"]);
  });

  // As root, a folder that cannot be written can be.
  test.skipIf(process.getuid?.() === 0)(
    "puts the old version back when the new one cannot be moved in",
    async () => {
      const { app, replacement, aside, OPEN, run, opened } = await setUp();
      await chmod(path.dirname(replacement), 0o555);
      expect(await run(OPEN)).toBe(1);
      await chmod(path.dirname(replacement), 0o755);
      expect(await versionOf(app)).toBe("old");
      expect(await readdir(app)).toEqual(["Contents"]);
      expect(await versionOf(aside)).toBeNull();
      expect(await opened()).toEqual(["old"]);
    },
  );

  // As root, a folder that cannot be written can be.
  test.skipIf(process.getuid?.() === 0)(
    "puts the old version back, and opens it, when the new one cannot be opened or moved back",
    async () => {
      const { app, replacement, aside, OPEN, run, opened } = await setUp();
      await writeFile(
        path.join(replacement, "Contents", "MacOS", "Agent Lookout"),
        "#!/bin/sh\nexit 1\n",
      );
      const folder = path.dirname(replacement);
      expect(await run(`/bin/chmod 555 '${folder}'\n${OPEN}`)).toBe(1);
      await chmod(folder, 0o755);
      expect(await versionOf(app)).toBe("old");
      expect(await readdir(app)).toEqual(["Contents"]);
      expect(await opened()).toEqual(["old"]);
      // Nothing stays beside the app: the new one is where the old one waited, and goes with it.
      expect(await readdir(path.dirname(app))).toEqual(["Agent Lookout.app"]);
      expect(await versionOf(aside)).toBe("new");
    },
  );

  // As root, a folder that cannot be written can be.
  test.skipIf(process.getuid?.() === 0).each([
    ["the old one cannot be moved back", "aside"],
    ["it can neither be moved back nor make way", "app"],
  ] as const)(
    "leaves a new version that cannot be opened, with nothing put inside it, when %s",
    async (_what, shutToo) => {
      const { app, replacement, aside, run } = await setUp();
      const folders = [replacement, { app, aside }[shutToo]].map((of) => path.dirname(of));
      const shut = folders.map((folder) => `/bin/chmod 555 '${folder}'`).join("\n");
      expect(await run(`${shut}\nexit 1`)).toBe(1);
      for (const folder of folders) await chmod(folder, 0o755);
      expect(await readdir(path.dirname(app))).toEqual(["Agent Lookout.app"]);
      expect(await readdir(app)).toEqual(["Contents"]);
      expect(await versionOf(app)).toBe("new");
      expect(await versionOf(aside)).toBe("old");
    },
  );

  test("opens the old version again when it cannot be moved aside", async () => {
    const { app, replacement, aside, OPEN, run, opened } = await setUp();
    await rm(path.dirname(aside), { recursive: true });
    expect(await run(OPEN)).toBe(1);
    expect(await versionOf(app)).toBe("old");
    expect(await versionOf(replacement)).toBe("new");
    expect(await opened()).toEqual(["old"]);
  });
});
