import { describe, expect, test } from "vitest";

import { fxSessionsDirFor } from "@collector/adapters/fx/index";
import { fxFolderFor, sessionsFolder } from "@collector/adapters/fx/paths";
import { HOME } from "@tests/fixtures/fx/fx";
import { memoryFiles } from "@tests/support/adapters/fx/fxAdapter";
import { asWritten } from "@tests/support/paths";

/** fx's folder, with its path as the tests write it, on every system. */
function folder(env: NodeJS.ProcessEnv) {
  const found = fxFolderFor(env, HOME);
  return { ...found, folder: asWritten(found.folder) };
}

const sessionsDir = (env: NodeJS.ProcessEnv) => {
  const dir = fxSessionsDirFor(env, HOME);
  return dir === null ? null : asWritten(dir);
};

describe("fx's folder", () => {
  test("is ~/.fx when nothing names another", () => {
    expect(folder({})).toEqual({ from: "fx", folder: `${HOME}/.fx` });
    expect(sessionsDir({})).toBe(`${HOME}/.fx/sessions/v2`);
  });

  test("AGENT_LOOKOUT_FX_HOME wins over FX_HOME, trimmed and resolved", () => {
    expect(folder({ AGENT_LOOKOUT_FX_HOME: " /data/fx ", FX_HOME: "/elsewhere" })).toEqual({
      from: "agent-lookout",
      folder: "/data/fx",
    });
    // Agent Lookout's own setting is a path of Node's, so `..` in it is Node's.
    expect(folder({ AGENT_LOOKOUT_FX_HOME: "/data/a/../fx" })).toEqual({
      from: "agent-lookout",
      folder: "/data/fx",
    });
  });

  test("FX_HOME is taken as fx takes it, with any / at its end left off", () => {
    expect(folder({ FX_HOME: "/data/fx" })).toEqual({ from: "fx", folder: "/data/fx" });
    expect(folder({ FX_HOME: "/data/fx//" })).toEqual({ from: "fx", folder: "/data/fx" });
    expect(sessionsDir({ FX_HOME: "/data/fx/" })).toBe("/data/fx/sessions/v2");
  });

  test("an FX_HOME fx refuses, or that is empty, is passed over for ~/.fx", () => {
    for (const value of ["", "~/fx", "fx", "./fx", "/", "//", " /data/fx"]) {
      expect(folder({ FX_HOME: value }), JSON.stringify(value)).toEqual({
        from: "fx",
        folder: `${HOME}/.fx`,
      });
    }
    // fx refuses the home folder in HOME, with or without a / at its end.
    for (const home of ["/Users/someone", "/Users/someone/"]) {
      for (const value of ["/Users/someone", "/Users/someone/"]) {
        expect(folder({ FX_HOME: value, HOME: home }), `${value} ${home}`).toEqual({
          from: "fx",
          folder: `${HOME}/.fx`,
        });
      }
    }
    // With HOME unset, that is not checked.
    expect(folder({ FX_HOME: "/Users/someone" })).toEqual({ from: "fx", folder: "/Users/someone" });
  });

  test("an FX_HOME through . or .. is not followed", () => {
    for (const value of ["/data/../fx", "/data/./fx", "/data/fx/..", "/data/fx/./"]) {
      expect(folder({ FX_HOME: value }), value).toMatchObject({ from: "dotted" });
      expect(sessionsDir({ FX_HOME: value }), value).toBeNull();
    }
    // A name that only starts or ends with a dot is a name.
    expect(folder({ FX_HOME: "/data/.fx" })).toEqual({ from: "fx", folder: "/data/.fx" });
    expect(folder({ FX_HOME: "/data/fx.." })).toEqual({ from: "fx", folder: "/data/fx.." });
  });
});

describe("the folders on the way to v2", () => {
  test("are each looked at, from the folder that holds fx's", async () => {
    const files = memoryFiles();
    files.mkdir(`${HOME}/.fx/sessions/v2`);
    files.touch(`${HOME}/.fx/sessions/v2`, 42);
    expect(await sessionsFolder(`${HOME}/.fx`, files.io)).toMatchObject({
      kind: "directory",
      mtimeMs: 42,
    });
    expect(files.calls.map((call) => call.path)).toEqual([
      `${HOME}/.fx`,
      `${HOME}/.fx/sessions`,
      `${HOME}/.fx/sessions/v2`,
    ]);
  });

  test("a link or a file at any of them is not a real folder", async () => {
    for (const at of [`${HOME}/.fx`, `${HOME}/.fx/sessions`, `${HOME}/.fx/sessions/v2`]) {
      const files = memoryFiles();
      files.special(at);
      expect(await sessionsFolder(`${HOME}/.fx`, files.io), at).toBe("not-real");
    }
  });

  test("a folder that is not there rejects", async () => {
    await expect(sessionsFolder(`${HOME}/.fx`, memoryFiles().io)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
