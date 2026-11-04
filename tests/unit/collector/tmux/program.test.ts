import { describe, expect, test } from "vitest";

import {
  createTmuxRunner,
  findTmuxBinary,
  tmuxInstalled,
  TMUX_LOCATIONS,
} from "@collector/tmux/program";

/** Pretends exactly these paths are runnable, and records every path asked about. */
function executables(...present: string[]) {
  const asked: string[] = [];
  return {
    asked,
    isExecutable: async (candidate: string) => {
      asked.push(candidate);
      return present.includes(candidate);
    },
  };
}

describe("findTmuxBinary", () => {
  test("PATH is searched in order, before the fixed locations", async () => {
    const fake = executables("/second/tmux", "/usr/local/bin/tmux");
    expect(
      await findTmuxBinary({ PATH: "/first:/second:/third" }, fake.isExecutable, "linux"),
    ).toBe("/second/tmux");
    expect(fake.asked).toEqual(["/first/tmux", "/second/tmux"]);
  });

  test("without a useful PATH, as in an app opened from the Finder, the fixed locations are tried", async () => {
    const fake = executables("/opt/homebrew/bin/tmux");
    expect(await findTmuxBinary({ PATH: "/usr/bin:/bin" }, fake.isExecutable, "linux")).toBe(
      "/opt/homebrew/bin/tmux",
    );
    expect(await findTmuxBinary({}, executables("/usr/local/bin/tmux").isExecutable)).toBe(
      "/usr/local/bin/tmux",
    );
  });

  test("a PATH entry that is empty or relative is never looked in", async () => {
    const fake = executables("tmux", "bin/tmux", "./tmux");
    expect(await findTmuxBinary({ PATH: ":.:bin:" }, fake.isExecutable, "linux")).toBeNull();
    expect(fake.asked).toEqual([...TMUX_LOCATIONS]);
  });

  test("with no tmux anywhere there is none", async () => {
    expect(await findTmuxBinary({ PATH: "/usr/bin" }, executables().isExecutable)).toBeNull();
  });
});

describe("createTmuxRunner", () => {
  test("with no tmux on the machine nothing is started, and that is an answer", async () => {
    const fake = executables();
    const run = createTmuxRunner({
      env: { PATH: "/opt/tools" },
      isExecutable: fake.isExecutable,
      platform: "linux",
    });

    expect(await run(["list-panes", "-a"])).toEqual({ ok: false, stderr: "" });
    expect(fake.asked).toEqual(["/opt/tools/tmux", ...TMUX_LOCATIONS]);
  });

  test.each(["off", "OFF", " off "])(
    "with AGENT_LOOKOUT_TMUX set to %j tmux is not even looked for",
    async (value) => {
      const fake = executables("/opt/homebrew/bin/tmux");
      const run = createTmuxRunner({
        env: { AGENT_LOOKOUT_TMUX: value, PATH: "/opt/homebrew/bin" },
        isExecutable: fake.isExecutable,
        platform: "darwin",
      });

      expect(await run(["list-panes", "-a"])).toEqual({ ok: false, stderr: "" });
      expect(fake.asked).toEqual([]);
    },
  );

  test("on Windows, which has no tmux, tmux is not even looked for", async () => {
    const fake = executables("C:\\Tools\\tmux.exe");
    const run = createTmuxRunner({
      env: { Path: "C:\\Tools" },
      isExecutable: fake.isExecutable,
      platform: "win32",
    });

    expect(await run(["list-panes", "-a"])).toEqual({ ok: false, stderr: "" });
    expect(fake.asked).toEqual([]);
  });
});

describe("tmuxInstalled", () => {
  test("says whether tmux is found on PATH or in a fixed location", async () => {
    const onPath = executables("/opt/tools/tmux");
    expect(
      await tmuxInstalled({
        env: { PATH: "/opt/tools" },
        isExecutable: onPath.isExecutable,
        platform: "linux",
      }),
    ).toBe(true);

    const fixed = executables("/opt/homebrew/bin/tmux");
    expect(
      await tmuxInstalled({
        env: { PATH: "/opt/tools" },
        isExecutable: fixed.isExecutable,
        platform: "darwin",
      }),
    ).toBe(true);
  });

  test("with no tmux on the machine it says so", async () => {
    const fake = executables();
    expect(
      await tmuxInstalled({
        env: { PATH: "/opt/tools" },
        isExecutable: fake.isExecutable,
        platform: "linux",
      }),
    ).toBe(false);
    expect(fake.asked).toEqual(["/opt/tools/tmux", ...TMUX_LOCATIONS]);
  });

  test.each(["off", "OFF", " off "])(
    "with AGENT_LOOKOUT_TMUX set to %j it says no, and tmux is not even looked for",
    async (value) => {
      const fake = executables("/opt/homebrew/bin/tmux");
      expect(
        await tmuxInstalled({
          env: { AGENT_LOOKOUT_TMUX: value, PATH: "/opt/homebrew/bin" },
          isExecutable: fake.isExecutable,
          platform: "darwin",
        }),
      ).toBe(false);
      expect(fake.asked).toEqual([]);
    },
  );

  test("with AGENT_LOOKOUT_TERMINAL_JUMP off it still says yes: that setting is for tabs alone", async () => {
    const fake = executables("/opt/homebrew/bin/tmux");
    expect(
      await tmuxInstalled({
        env: { AGENT_LOOKOUT_TERMINAL_JUMP: "off", PATH: "/opt/homebrew/bin" },
        isExecutable: fake.isExecutable,
        platform: "darwin",
      }),
    ).toBe(true);
  });

  test("on Windows, which has no tmux, it says no, and tmux is not even looked for", async () => {
    const fake = executables("C:\\Tools\\tmux.exe");
    expect(
      await tmuxInstalled({
        env: { Path: "C:\\Tools" },
        isExecutable: fake.isExecutable,
        platform: "win32",
      }),
    ).toBe(false);
    expect(fake.asked).toEqual([]);
  });
});
