import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  ompFoldersFor,
  ompProfileOf,
  ompSessionsDirsFor,
  ompXdgProbe,
} from "@collector/adapters/oh-my-pi/folders";
import { HOME, SESSIONS } from "@tests/fixtures/oh-my-pi/ohMyPi";
import { asWritten } from "@tests/support/paths";

const XDG = "/Users/example/.local/share";

/** The sessions folder, flat or not, and what was passed over, as the tests write paths. */
function folderFor(
  env: NodeJS.ProcessEnv,
  options: { platform?: NodeJS.Platform; there?: boolean } = {},
) {
  const looked: string[] = [];
  const folders = ompFoldersFor(env, HOME, options.platform ?? "darwin", (dir) => {
    looked.push(asWritten(dir));
    return options.there ?? false;
  });
  return { ...folders, sessionsDir: asWritten(folders.sessionsDir), looked };
}

const dirOf = (env: NodeJS.ProcessEnv, options?: { platform?: NodeJS.Platform; there?: boolean }) =>
  folderFor(env, options).sessionsDir;

describe("the order of the rules", () => {
  test("by default, ~/.omp/agent/sessions, with project folders", () => {
    expect(folderFor({})).toEqual({
      sessionsDir: SESSIONS,
      flat: false,
      named: false,
      passedOver: [],
      looked: [],
    });
  });

  test("Agent Lookout's own setting wins over every other", () => {
    const env = {
      AGENT_LOOKOUT_OMP_HOME: " /tmp/omp-home ",
      PI_CODING_AGENT_SESSION_DIR: "/tmp/flat",
      OMP_PROFILE: "work",
      PI_CODING_AGENT_DIR: "/tmp/agent",
      XDG_DATA_HOME: XDG,
    };
    expect(folderFor(env, { there: true })).toMatchObject({
      sessionsDir: "/tmp/omp-home/sessions",
      flat: false,
      named: true,
      looked: [],
    });
  });

  test("PI_CODING_AGENT_SESSION_DIR, a whole path, holds the files themselves, for every profile", () => {
    const flat = { sessionsDir: "/tmp/flat", flat: true, named: false };
    expect(folderFor({ PI_CODING_AGENT_SESSION_DIR: "/tmp/flat" })).toMatchObject(flat);
    expect(
      folderFor({ PI_CODING_AGENT_SESSION_DIR: "/tmp/flat", OMP_PROFILE: "work" }),
    ).toMatchObject(flat);
    expect(
      folderFor({ PI_CODING_AGENT_SESSION_DIR: "/tmp/flat", XDG_DATA_HOME: XDG }, { there: true }),
    ).toMatchObject(flat);
  });

  test("a relative or ~ PI_CODING_AGENT_SESSION_DIR is passed over, and the rules go on", () => {
    for (const value of ["sessions", "~/sessions", "./x"]) {
      expect(folderFor({ PI_CODING_AGENT_SESSION_DIR: value })).toMatchObject({
        sessionsDir: SESSIONS,
        flat: false,
        passedOver: ["session-dir"],
      });
    }
    expect(folderFor({ PI_CODING_AGENT_SESSION_DIR: "" })).toMatchObject({ passedOver: [] });
  });

  test("a named profile has its own agent folder, and PI_CODING_AGENT_DIR is not read", () => {
    expect(dirOf({ OMP_PROFILE: "work" })).toBe(`${HOME}/.omp/profiles/work/agent/sessions`);
    expect(dirOf({ PI_PROFILE: "work" })).toBe(`${HOME}/.omp/profiles/work/agent/sessions`);
    expect(dirOf({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/tmp/agent" })).toBe(
      `${HOME}/.omp/profiles/work/agent/sessions`,
    );
  });

  test("PI_CODING_AGENT_DIR, a whole path, names the default profile's agent folder", () => {
    expect(folderFor({ PI_CODING_AGENT_DIR: "/tmp/agent" })).toMatchObject({
      sessionsDir: "/tmp/agent/sessions",
      flat: false,
    });
    expect(dirOf({ PI_CODING_AGENT_DIR: "/tmp/agent/" })).toBe("/tmp/agent/sessions");
  });

  test("a relative PI_CODING_AGENT_DIR is passed over, and the default is read", () => {
    expect(folderFor({ PI_CODING_AGENT_DIR: "agent" })).toMatchObject({
      sessionsDir: SESSIONS,
      passedOver: ["agent-dir"],
    });
    expect(folderFor({ PI_CODING_AGENT_DIR: "~/.omp/agent" })).toMatchObject({
      sessionsDir: SESSIONS,
      passedOver: ["agent-dir"],
    });
  });

  test("a PI_CODING_AGENT_DIR that is PI_PROFILE's own agent folder is a parent's, and not followed", () => {
    // Joined as Oh My Pi joins it, on this system's rules, as it compares the two as text.
    const env = {
      OMP_PROFILE: "",
      PI_PROFILE: "work",
      PI_CODING_AGENT_DIR: path.join(HOME, ".omp", "profiles", "work", "agent"),
    };
    expect(dirOf(env)).toBe(SESSIONS);
    expect(dirOf({ ...env, PI_CODING_AGENT_DIR: `${HOME}/.omp/profiles/other/agent` })).toBe(
      `${HOME}/.omp/profiles/other/agent/sessions`,
    );
  });

  test("a PI_CODING_AGENT_DIR that is KIMCHI_CODING_AGENT_DIR's folder is Kimchi's, set for the programs it starts, and not followed", () => {
    const env = { PI_CODING_AGENT_DIR: "/tmp/kimchi", KIMCHI_CODING_AGENT_DIR: "/tmp/kimchi/" };
    expect(folderFor(env)).toMatchObject({ passedOver: [] });
    expect(dirOf(env)).toBe(SESSIONS);
    expect(dirOf({ ...env, KIMCHI_CODING_AGENT_DIR: "/tmp/other" })).toBe("/tmp/kimchi/sessions");
  });

  test("a PI_CODING_AGENT_DIR that is ~/.omp/agent counts as the default, so XDG_DATA_HOME can move it", () => {
    const env = { PI_CODING_AGENT_DIR: `${HOME}/.omp/agent/`, XDG_DATA_HOME: XDG };
    expect(folderFor(env, { there: true })).toMatchObject({
      sessionsDir: `${XDG}/omp/sessions`,
      looked: [`${XDG}/omp`],
    });
    expect(dirOf(env, { there: false })).toBe(SESSIONS);
  });
});

describe("profiles", () => {
  test("OMP_PROFILE set, even to nothing, wins over PI_PROFILE", () => {
    expect(dirOf({ OMP_PROFILE: "", PI_PROFILE: "work" })).toBe(SESSIONS);
    expect(dirOf({ OMP_PROFILE: "home", PI_PROFILE: "work" })).toBe(
      `${HOME}/.omp/profiles/home/agent/sessions`,
    );
  });

  test("names are trimmed, and a blank, default or invalid one is the default profile", () => {
    expect(ompProfileOf("  work  ")).toBe("work");
    expect(ompProfileOf("a.b_c-1")).toBe("a.b_c-1");
    for (const name of [
      undefined,
      "",
      "   ",
      "default",
      "Work",
      "-x",
      ".",
      "..",
      "x.",
      "con",
      "LPT1.txt",
      "a/b",
      "x".repeat(65),
    ]) {
      expect(ompProfileOf(name)).toBeNull();
    }
    expect(dirOf({ OMP_PROFILE: "Not Valid" })).toBe(SESSIONS);
  });
});

describe("XDG_DATA_HOME", () => {
  test("moves the default folder on macOS and Linux once $XDG_DATA_HOME/omp is there", () => {
    for (const platform of ["darwin", "linux"] as const) {
      expect(folderFor({ XDG_DATA_HOME: XDG }, { platform, there: true })).toMatchObject({
        sessionsDir: `${XDG}/omp/sessions`,
        looked: [`${XDG}/omp`],
      });
      expect(dirOf({ XDG_DATA_HOME: XDG }, { platform, there: false })).toBe(SESSIONS);
    }
  });

  test("moves a named profile's once that profile's own folder there is", () => {
    expect(folderFor({ OMP_PROFILE: "work", XDG_DATA_HOME: XDG }, { there: true })).toMatchObject({
      sessionsDir: `${XDG}/omp/profiles/work/sessions`,
      looked: [`${XDG}/omp/profiles/work`],
    });
    expect(dirOf({ OMP_PROFILE: "work", XDG_DATA_HOME: XDG }, { there: false })).toBe(
      `${HOME}/.omp/profiles/work/agent/sessions`,
    );
  });

  test("never on Windows, never with another agent folder named, and never when relative", () => {
    expect(folderFor({ XDG_DATA_HOME: XDG }, { platform: "win32", there: true })).toMatchObject({
      sessionsDir: SESSIONS,
      looked: [],
    });
    expect(
      folderFor({ XDG_DATA_HOME: XDG, PI_CODING_AGENT_DIR: "/tmp/agent" }, { there: true }),
    ).toMatchObject({ sessionsDir: "/tmp/agent/sessions", looked: [] });
    expect(folderFor({ XDG_DATA_HOME: "share" }, { there: true })).toMatchObject({
      sessionsDir: SESSIONS,
      looked: [],
    });
    expect(ompXdgProbe({ XDG_DATA_HOME: "" }, HOME, "linux")).toBeNull();
  });
});

describe("PI_CONFIG_DIR", () => {
  test("renames .omp, under the home folder, even when it is a whole path", () => {
    expect(dirOf({ PI_CONFIG_DIR: ".pi-like" })).toBe(`${HOME}/.pi-like/agent/sessions`);
    expect(dirOf({ PI_CONFIG_DIR: "/abs/omp" })).toBe(`${HOME}/abs/omp/agent/sessions`);
    expect(dirOf({ PI_CONFIG_DIR: ".pi-like", PI_PROFILE: "work" })).toBe(
      `${HOME}/.pi-like/profiles/work/agent/sessions`,
    );
  });
});

describe("the folders for the fingerprint", () => {
  test("both that XDG_DATA_HOME can give, with no look at the disk", () => {
    expect(ompSessionsDirsFor({ XDG_DATA_HOME: XDG }, HOME, "linux").map(asWritten)).toEqual([
      SESSIONS,
      `${XDG}/omp/sessions`,
    ]);
    expect(ompSessionsDirsFor({}, HOME, "linux").map(asWritten)).toEqual([SESSIONS, SESSIONS]);
  });
});
