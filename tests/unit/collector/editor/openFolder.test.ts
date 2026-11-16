import { describe, expect, test, vi } from "vitest";

import {
  EDITOR_COMMAND,
  editorCommandFor,
  homeFolders,
  isFolderPath,
  NEW_WINDOW,
  openFolder,
  settledWithin,
} from "@collector/editor/openFolder";
import { fakeEditor, VSCODE_BUNDLE } from "@tests/support/node/terminal";

// Every folder here is refused by its text, so nothing is looked at on disk:
// the tests on real folders are in tests/integration.

const HOME = "/Users/example";
const VS_CODE = { app: "VS Code", bundle: VSCODE_BUNDLE } as const;

describe("isFolderPath", () => {
  test.each(["/Users/example/code/storefront", "/Users/example/My Project é", "/Users/examples"])(
    "takes %s as a folder to open",
    (folder) => {
      expect(isFolderPath(folder, HOME)).toBe(true);
    },
  );

  test.each([
    "",
    "/",
    HOME,
    "/users/EXAMPLE",
    "code/storefront",
    "~/code",
    "/a/../b",
    "/a/./b",
    "/a//b",
    "/a/b/",
    "/a\nb",
    "/a\tb",
    "/a\u0000b",
    "/a\u202eb",
    "/a\u2029b",
    "/Applications/Calculator.app",
    "/Applications/Calculator.app/Contents/Resources",
    "/Users/example/Thing.APP/src",
    `/${"a".repeat(1024)}`,
    42,
    null,
  ])("refuses %j as a folder to open", (folder) => {
    expect(isFolderPath(folder, HOME)).toBe(false);
  });

  test("refuses the home folder by each of its names, in any case", () => {
    const homes = [HOME, "/Volumes/Data/example"];
    expect(isFolderPath("/Volumes/Data/example", ...homes)).toBe(false);
    expect(isFolderPath("/volumes/data/EXAMPLE", ...homes)).toBe(false);
    expect(isFolderPath(HOME, ...homes)).toBe(false);
    expect(isFolderPath("/Volumes/Data/example/code", ...homes)).toBe(true);
  });
});

describe("homeFolders", () => {
  test("gives the name and the real path when its links lead elsewhere", async () => {
    expect(await homeFolders(HOME, async () => "/Volumes/Data/example")).toEqual([
      HOME,
      "/Volumes/Data/example",
    ]);
  });

  test("gives the name once when it has no link to follow", async () => {
    expect(await homeFolders(HOME, async (home) => home)).toEqual([HOME]);
  });

  test("gives the name alone when its links cannot be followed, and never rejects", async () => {
    const refused = async () => {
      throw Object.assign(new Error("not there"), { code: "ENOENT" });
    };
    expect(await homeFolders(HOME, refused)).toEqual([HOME]);
  });
});

describe("editorCommandFor", () => {
  test("gives the editor's own command, --new-window and the folder, and nothing else", () => {
    expect(EDITOR_COMMAND).toBe("Contents/Resources/app/bin/code");
    expect(NEW_WINDOW).toBe("--new-window");
    expect(editorCommandFor(VS_CODE, "/Users/example/code/storefront", HOME)).toEqual({
      program: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      args: ["--new-window", "/Users/example/code/storefront"],
    });
    expect(
      editorCommandFor(
        { app: "VS Code Insiders", bundle: "/Applications/Visual Studio Code - Insiders.app" },
        "/Users/example/code/storefront",
        HOME,
      )?.program,
    ).toBe("/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code");
  });

  test.each([
    ["a bundle that is another editor's", { app: "VS Code Insiders", bundle: VSCODE_BUNDLE }],
    ["a bundle that is not an editor", { app: "VS Code", bundle: "/Applications/Calculator.app" }],
    ["a relative bundle", { app: "VS Code", bundle: "Applications/Visual Studio Code.app" }],
    [
      "a bundle with a part that leads back",
      { app: "VS Code", bundle: "/Applications/../Visual Studio Code.app" },
    ],
  ] as const)("builds no command for %s", (_what, editor) => {
    expect(editorCommandFor(editor, "/Users/example/code/storefront", HOME)).toBeNull();
  });

  test("builds no command for a folder that is refused", () => {
    expect(editorCommandFor(VS_CODE, "/Applications/Calculator.app", HOME)).toBeNull();
    expect(editorCommandFor(VS_CODE, HOME, HOME)).toBeNull();
  });
});

describe("openFolder", () => {
  test("a folder refused by its text is not opened, and nothing is run", async () => {
    const editor = fakeEditor();
    for (const folder of ["/Applications/Calculator.app", "/", HOME, "code/demo"]) {
      expect(await openFolder(VS_CODE, folder, editor.run, { homeDir: HOME })).toEqual({
        ok: false,
        reason: "not-opened",
      });
    }
    expect(editor.ran).toEqual([]);
  });

  test("a bundle that is not the editor it says is a failure, and nothing is run", async () => {
    const editor = fakeEditor();
    const outcome = await openFolder(
      { app: "VS Code", bundle: "/Applications/Calculator.app" },
      "/Users/example/code/storefront",
      editor.run,
      { homeDir: HOME },
    );
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(editor.ran).toEqual([]);
  });
});

describe("settledWithin", () => {
  test("gives what the work came to when it ends in time", async () => {
    expect(await settledWithin(Promise.resolve("there"), 500, "unreadable")).toBe("there");
  });

  test("gives the late answer once the time has passed, for work that never ends", async () => {
    vi.useFakeTimers();
    try {
      const answer = settledWithin(new Promise<string>(() => {}), 500, "unreadable");
      await vi.advanceTimersByTimeAsync(499);
      let said: string | null = null;
      void answer.then((value) => (said = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(said).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(await answer).toBe("unreadable");
    } finally {
      vi.useRealTimers();
    }
  });
});
