import { describe, expect, test } from "vitest";

import {
  bundleOfProgram,
  EDITOR_BUNDLES,
  editorOfBundle,
  editorOfProcess,
  isPlainPath,
} from "@collector/editor/editorWindows";
import { EDITOR_APPS } from "@core/sessions/session";
import {
  inEditor,
  inTab,
  processTable,
  TERMINAL_PATH,
  VSCODE_BUNDLE,
  type ProcessRow,
} from "@tests/support/node/terminal";

const SESSION = 4242;

const HELPER = `${VSCODE_BUNDLE}/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`;

describe("isPlainPath", () => {
  test.each(["/", "/Users/example/code/storefront", "/Users/example/My Project é"])(
    "takes %s",
    (value) => {
      expect(isPlainPath(value)).toBe(true);
    },
  );

  test.each([
    "",
    "code/storefront",
    "~/code",
    "/a/../b",
    "/a/./b",
    "/a//b",
    "//a",
    "/a/b/",
    "/a\nb",
    "/a\tb",
    "/a\u0000b",
    "/a\u202eb",
    "/a\u2028b",
    `/${"a".repeat(1024)}`,
    42,
    null,
  ])("refuses %j", (value) => {
    expect(isPlainPath(value)).toBe(false);
  });
});

describe("bundleOfProgram", () => {
  test("takes the outermost app of a helper's path and of the app's own program", () => {
    expect(bundleOfProgram(HELPER)).toBe(VSCODE_BUNDLE);
    expect(bundleOfProgram(`${VSCODE_BUNDLE}/Contents/MacOS/Code`)).toBe(VSCODE_BUNDLE);
    expect(
      bundleOfProgram(
        "/Users/example/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Code",
      ),
    ).toBe("/Users/example/Applications/Visual Studio Code - Insiders.app");
  });

  test.each([
    "claude",
    "-zsh",
    "node",
    "Applications/Visual Studio Code.app/Contents/MacOS/Code",
    "/Users/example/my.app/bin/tool",
    "/Applications/../Applications/Visual Studio Code.app/Contents/MacOS/Code",
    `${VSCODE_BUNDLE}/Contents/MacOS/Code\n`,
    `/Applications/Visual Studio Code\u202e.app/Contents/MacOS/Code`,
    "/.app/Contents/x",
  ])("gives no bundle for %j", (program) => {
    expect(bundleOfProgram(program)).toBeNull();
  });
});

describe("editorOfBundle", () => {
  test("knows VS Code and VS Code Insiders by their app's folder, and no other app", () => {
    expect(editorOfBundle(VSCODE_BUNDLE)).toBe("VS Code");
    expect(editorOfBundle("/Applications/Visual Studio Code - Insiders.app")).toBe(
      "VS Code Insiders",
    );
    for (const other of [
      "/System/Applications/Utilities/Terminal.app",
      "/Applications/iTerm.app",
      "/Applications/Visual Studio Code 2.app",
      "/Applications/visual studio code.app",
      "/Applications/Cursor.app",
      "/Applications/constructor.app",
      "/Applications/__proto__",
    ]) {
      expect(editorOfBundle(other)).toBeNull();
    }
  });

  test("names the same editors the API lists, in the same order", () => {
    expect([...EDITOR_BUNDLES.values()]).toEqual([...EDITOR_APPS]);
  });
});

describe("editorOfProcess", () => {
  test("a session of the extension runs under VS Code, found through its extension host", () => {
    expect(editorOfProcess(SESSION, processTable(inEditor(VSCODE_BUNDLE, SESSION)))).toEqual({
      app: "VS Code",
      bundle: VSCODE_BUNDLE,
    });
  });

  test("a session whose own program is inside the bundle is found by its own program", () => {
    const rows: ProcessRow[] = [
      [800, 1, "??", `${VSCODE_BUNDLE}/Contents/MacOS/Code`],
      [SESSION, 800, "??", HELPER],
    ];
    expect(editorOfProcess(SESSION, processTable(rows))?.app).toBe("VS Code");
  });

  test("a session in VS Code's own terminal runs under it too", () => {
    const rows: ProcessRow[] = [
      [800, 1, "??", `${VSCODE_BUNDLE}/Contents/MacOS/Code`],
      [
        810,
        800,
        "??",
        `${VSCODE_BUNDLE}/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper`,
      ],
      [811, 810, "ttys005", "-zsh"],
      [SESSION, 811, "ttys005", "claude"],
    ];
    // The jump is not given for it: `toSession.ts` checks the session's surface.
    expect(editorOfProcess(SESSION, processTable(rows))?.app).toBe("VS Code");
  });

  test("the first app above the process decides", () => {
    expect(editorOfProcess(SESSION, processTable(inTab(TERMINAL_PATH, SESSION)))).toBeUndefined();
    expect(
      editorOfProcess(
        SESSION,
        processTable(inTab("/Applications/Warp.app/Contents/MacOS/stable", SESSION)),
      ),
    ).toBeUndefined();
    // Terminal between the session and a VS Code helper.
    const rows: ProcessRow[] = [
      [800, 1, "??", HELPER],
      [810, 800, "??", TERMINAL_PATH],
      [SESSION, 810, "ttys004", "claude"],
    ];
    expect(editorOfProcess(SESSION, processTable(rows))).toBeUndefined();
  });

  test("the walk stops at process 1, at a parent ps did not list, and at a loop", () => {
    expect(editorOfProcess(SESSION, processTable([[SESSION, 1, "??", "claude"]]))).toBeUndefined();
    expect(
      editorOfProcess(SESSION, processTable([[SESSION, 777, "??", "claude"]])),
    ).toBeUndefined();
    const loop: ProcessRow[] = [
      [SESSION, 778, "??", "claude"],
      [778, SESSION, "??", "node"],
    ];
    expect(editorOfProcess(SESSION, processTable(loop))).toBeUndefined();
    expect(editorOfProcess(SESSION, processTable([]))).toBeUndefined();
  });

  test("a program that does not name itself with a plain whole path is passed over", () => {
    const rows: ProcessRow[] = [
      [800, 1, "??", `${VSCODE_BUNDLE}/Contents/MacOS/Code`],
      [810, 800, "??", "Applications/Terminal.app/Contents/MacOS/Terminal"],
      [SESSION, 810, "??", "claude"],
    ];
    expect(editorOfProcess(SESSION, processTable(rows))?.bundle).toBe(VSCODE_BUNDLE);
  });
});
