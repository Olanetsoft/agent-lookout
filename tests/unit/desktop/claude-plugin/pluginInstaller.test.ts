import { describe, expect, test, vi } from "vitest";

import type { RunCommand, RunResult } from "@collector/adapters/claude-code/feed";
import type { BinarySearch } from "@collector/adapters/claude-code/findBinary";
import {
  INSTALL_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MARKETPLACE_TIMEOUT_MS,
  createPluginInstaller,
  installRefusal,
  namesPlugin,
  type PluginInstallerOptions,
} from "@desktop/claude-plugin/pluginInstaller";
import type {
  PluginInstallReading,
  PluginInstallRecord,
  PluginInstallStore,
} from "@desktop/claude-plugin/pluginInstallSettings";

const NOW = 1_767_600_000_000;
const CLAUDE = "/Users/example/.local/bin/claude";
const LIST = ["plugin", "list"];
const ADD = ["plugin", "marketplace", "add", "Olanetsoft/agent-lookout"];
const INSTALL = ["plugin", "install", "agent-lookout@agent-lookout"];

/** A stand-in's list of installed plugins: each id on a line, with lines about it under it. */
const listing = (...ids: string[]) =>
  ids.length === 0
    ? "No plugins installed.\n"
    : `Installed plugins:\n\n${ids.map((id) => `  ❯ ${id}\n    Version: 1.0.0\n    Status: ✔ enabled\n`).join("\n")}`;

/** A store in memory, which can be made to fail as a file can. */
function memoryStore(start: PluginInstallReading = { kind: "none" }) {
  let reading = start;
  const written: PluginInstallRecord[] = [];
  let writable = true;
  const store: PluginInstallStore = {
    read: vi.fn(() => reading),
    write: vi.fn((record: PluginInstallRecord) => {
      if (!writable) return false;
      written.push(record);
      reading = { kind: "record", record };
      return true;
    }),
  };
  return {
    store,
    written,
    current: () => reading,
    failWrites: () => {
      writable = false;
    },
  };
}

interface Ran {
  file: string;
  args: readonly string[];
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
}

/**
 * A stand-in for `claude`: its `plugin list` names the plugin once `plugin
 * install` has run, or from the start with `installed`. Each command can be
 * made to fail.
 */
function standInClaude(
  options: {
    installed?: boolean;
    fail?: "list" | "marketplace" | "install" | "confirm";
    /** Install says it worked, and the list still does not name the plugin. */
    installDoesNothing?: boolean;
    others?: string[];
  } = {},
) {
  let installed = options.installed ?? false;
  let lists = 0;
  const ran: Ran[] = [];
  const failed: RunResult = { ok: false, problem: "stopped with exit code 1", exitCode: 1 };
  const run = vi.fn<RunCommand>(async (file, args, { timeoutMs, env }) => {
    ran.push({ file, args, timeoutMs, env });
    const command = args.join(" ");
    if (command === "plugin list") {
      lists += 1;
      if (options.fail === (lists === 1 ? "list" : "confirm")) return failed;
      const ids = [
        ...(options.others ?? []),
        ...(installed ? ["agent-lookout@agent-lookout"] : []),
      ];
      return { ok: true, stdout: listing(...ids) };
    }
    if (command === ADD.join(" ")) {
      return options.fail === "marketplace" ? failed : { ok: true, stdout: "" };
    }
    if (command === INSTALL.join(" ")) {
      if (options.fail === "install") return failed;
      if (!options.installDoesNothing) installed = true;
      return { ok: true, stdout: "" };
    }
    throw new Error(`Not a command the installer runs: ${command}`);
  });
  return { run, ran, commands: () => ran.map((one) => one.args.join(" ")) };
}

function installerWith(
  overrides: Partial<PluginInstallerOptions> & Pick<PluginInstallerOptions, "settings">,
) {
  const warn = vi.fn<(line: string) => void>();
  const findBinary = vi.fn<() => Promise<BinarySearch>>(async () => ({
    found: true,
    path: CLAUDE,
  }));
  const options: PluginInstallerOptions = {
    env: {},
    homeDir: "/Users/example",
    platform: "darwin",
    packaged: true,
    now: () => NOW,
    findBinary,
    warn,
    ...overrides,
  };
  return { installer: createPluginInstaller(options), warn, findBinary: options.findBinary! };
}

describe("namesPlugin", () => {
  test.each([
    ["a list with lines about each plugin under it", listing("agent-lookout@agent-lookout")],
    ["a bullet", "• agent-lookout@agent-lookout"],
    ["an arrow before it", "  ❯ agent-lookout@agent-lookout"],
    ["indentation", "        agent-lookout@agent-lookout"],
    [
      "colour around the id",
      "  \u001b[1m\u001b[36magent-lookout@agent-lookout\u001b[39m\u001b[22m",
    ],
    ["a word after it on the line", "agent-lookout@agent-lookout (disabled)"],
    ["Windows line ends", "Installed plugins:\r\n\r\n  agent-lookout@agent-lookout\r\n"],
    ["a status before it", "✘ disabled  agent-lookout@agent-lookout"],
    ["other plugins beside it", listing("formatter@tools", "agent-lookout@agent-lookout")],
  ])("finds the plugin named with %s", (_what, stdout) => {
    expect(namesPlugin(stdout)).toBe(true);
  });

  test.each([
    ["a fork's marketplace", "agent-lookout@agent-lookout-fork"],
    ["a longer plugin name", "my-agent-lookout@agent-lookout"],
    ["a path that ends in it", "/plugins/agent-lookout@agent-lookout"],
    ["the plugin's name alone", "agent-lookout"],
    ["another marketplace", "agent-lookout@other"],
    ["nothing installed", listing()],
    ["no output", ""],
  ])("does not take %s for the plugin", (_what, stdout) => {
    expect(namesPlugin(stdout)).toBe(false);
  });
});

describe("installRefusal", () => {
  const base = { env: {}, homeDir: "/Users/example", platform: "darwin" as const, packaged: true };

  test("a packaged app with the defaults may install", () => {
    expect(installRefusal(base)).toBeNull();
    expect(installRefusal({ ...base, env: { AGENT_LOOKOUT_PLUGIN_INSTALL: "on" } })).toBeNull();
    expect(installRefusal({ ...base, env: { AGENT_LOOKOUT_PLUGIN_INSTALL: "yes" } })).toBeNull();
  });

  test("a development run never does, whatever else is set", () => {
    expect(installRefusal({ ...base, packaged: false })).toEqual({
      why: "development",
      recorded: false,
    });
    expect(
      installRefusal({ ...base, packaged: false, env: { AGENT_LOOKOUT_PLUGIN_INSTALL: "off" } }),
    ).toEqual({ why: "development", recorded: false });
  });

  test.each(["off", " OFF ", "Off"])("%j is turned off, and that is remembered", (value) => {
    expect(installRefusal({ ...base, env: { AGENT_LOOKOUT_PLUGIN_INSTALL: value } })).toEqual({
      why: "turned-off",
      recorded: true,
    });
  });

  test.each<[string, NodeJS.ProcessEnv]>([
    ["answering is off", { AGENT_LOOKOUT_ANSWER: "off" }],
    ["claude is not run", { AGENT_LOOKOUT_CLAUDE_FEED: "off" }],
  ])("turned off where %s too, it is still remembered as turned off", (_what, env) => {
    expect(
      installRefusal({ ...base, env: { AGENT_LOOKOUT_PLUGIN_INSTALL: "off", ...env } }),
    ).toEqual({ why: "turned-off", recorded: true });
  });

  test.each<[string, Partial<typeof base> & { env?: NodeJS.ProcessEnv }]>([
    ["answering is off", { env: { AGENT_LOOKOUT_ANSWER: "off" } }],
    ["on Windows, where nothing is answered", { platform: "win32" as never }],
    [
      "a folder of Claude Code's own without a socket",
      { env: { AGENT_LOOKOUT_CLAUDE_HOME: "/x" } },
    ],
  ])("not where %s, and that is not remembered", (_what, change) => {
    expect(installRefusal({ ...base, ...change })).toEqual({
      why: "answering-off",
      recorded: false,
    });
  });

  test.each<[string, NodeJS.ProcessEnv]>([
    ["claude is not run", { AGENT_LOOKOUT_CLAUDE_FEED: "off" }],
    [
      "a folder of Claude Code's own is named without its binary",
      { AGENT_LOOKOUT_CLAUDE_HOME: "/x", AGENT_LOOKOUT_ANSWER_SOCKET: "/tmp/a.sock" },
    ],
  ])("not where %s, and that is not remembered", (_what, env) => {
    expect(installRefusal({ ...base, env })).toEqual({ why: "claude-not-run", recorded: false });
  });

  test("a folder of Claude Code's own, with its binary and a socket, may install", () => {
    expect(
      installRefusal({
        ...base,
        env: {
          AGENT_LOOKOUT_CLAUDE_HOME: "/x",
          AGENT_LOOKOUT_CLAUDE_BIN: CLAUDE,
          AGENT_LOOKOUT_ANSWER_SOCKET: "/tmp/a.sock",
        },
      }),
    ).toBeNull();
  });
});

describe("the one-time install", () => {
  test("with the plugin not installed, it lists, adds the marketplace, installs and lists again, each as claude agents is run", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    /** What the record said as each command started. */
    const recorded: PluginInstallReading[] = [];
    const run = vi.fn<RunCommand>(async (file, args, options) => {
      recorded.push(memory.current());
      return claude.run(file, args, options);
    });
    const { installer, warn } = installerWith({
      settings: memory.store,
      run,
      env: { PATH: "/usr/bin:/bin", AGENT_LOOKOUT_ANSWER_WAIT: "60" },
    });

    await installer.start();

    expect(claude.ran.map(({ args }) => args)).toEqual([LIST, ADD, INSTALL, LIST]);
    // The record said it tried before the first command ran.
    expect(recorded[0]).toEqual({
      kind: "record",
      record: { triedAt: NOW, outcome: "running", step: null, told: false },
    });
    expect(claude.ran.map(({ timeoutMs }) => timeoutMs)).toEqual([
      LIST_TIMEOUT_MS,
      MARKETPLACE_TIMEOUT_MS,
      INSTALL_TIMEOUT_MS,
      LIST_TIMEOUT_MS,
    ]);
    expect([LIST_TIMEOUT_MS, MARKETPLACE_TIMEOUT_MS, INSTALL_TIMEOUT_MS]).toEqual([
      30_000, 180_000, 120_000,
    ]);
    for (const { file, env } of claude.ran) {
      expect(file).toBe(CLAUDE);
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
      expect(env.DISABLE_AUTOUPDATER).toBe("1");
      expect(env.PATH).toBe("/usr/bin:/bin");
    }
    expect(memory.current()).toEqual({
      kind: "record",
      record: { triedAt: NOW, outcome: "installed", step: null, told: false },
    });
    expect(installer.status()).toEqual({ state: "installed" });
    expect(warn.mock.calls).toEqual([
      ["Agent Lookout installed its Claude Code plugin, agent-lookout@agent-lookout."],
    ]);
  });

  test("with the plugin there already, enabled or not, it runs only the list, installs nothing and says nothing", async () => {
    const memory = memoryStore();
    const claude = standInClaude({ installed: true });
    const { installer, warn } = installerWith({ settings: memory.store, run: claude.run });

    await installer.start();

    expect(claude.commands()).toEqual([LIST.join(" ")]);
    expect(memory.current()).toEqual({
      kind: "record",
      record: { triedAt: NOW, outcome: "already-installed", step: null, told: false },
    });
    expect(installer.status()).toEqual({ state: "idle" });
    expect(warn.mock.calls).toEqual([
      ["Agent Lookout found its Claude Code plugin installed already, so it installed nothing."],
    ]);
  });

  test.each([
    ["list", "check", [LIST], "claude plugin list stopped with exit code 1"],
    [
      "marketplace",
      "marketplace",
      [LIST, ADD],
      "claude plugin marketplace add Olanetsoft/agent-lookout stopped with exit code 1",
    ],
    [
      "install",
      "install",
      [LIST, ADD, INSTALL],
      "claude plugin install agent-lookout@agent-lookout stopped with exit code 1",
    ],
    [
      "confirm",
      "confirm",
      [LIST, ADD, INSTALL, LIST],
      "claude plugin list stopped with exit code 1",
    ],
  ] as const)(
    "when %s does not work, nothing after it runs, and it fails at %s",
    async (fail, step, commands, logged) => {
      const memory = memoryStore();
      const claude = standInClaude({ fail });
      const { installer, warn } = installerWith({ settings: memory.store, run: claude.run });

      await installer.start();

      expect(claude.ran.map(({ args }) => args)).toEqual(commands);
      expect(memory.current()).toEqual({
        kind: "record",
        record: { triedAt: NOW, outcome: "failed", step, told: false },
      });
      expect(installer.status()).toEqual({ state: "failed", step });
      expect(warn.mock.calls).toEqual([
        [`Agent Lookout could not install its Claude Code plugin: ${logged}.`],
      ]);
    },
  );

  test("an install that says it worked, while the list still does not name the plugin, is a failure at confirm", async () => {
    const memory = memoryStore();
    const claude = standInClaude({ installDoesNothing: true });
    const { installer, warn } = installerWith({ settings: memory.store, run: claude.run });

    await installer.start();

    expect(claude.ran.map(({ args }) => args)).toEqual([LIST, ADD, INSTALL, LIST]);
    expect(installer.status()).toEqual({ state: "failed", step: "confirm" });
    expect(warn.mock.calls).toEqual([
      [
        "Agent Lookout could not install its Claude Code plugin: claude plugin list did not name agent-lookout@agent-lookout after the install.",
      ],
    ]);
  });

  test("a command that throws ends it as a failure at its step, and start never rejects", async () => {
    const memory = memoryStore();
    const run = vi.fn<RunCommand>(async (_file, args) => {
      if (args.includes("marketplace")) throw new Error("out of file handles");
      return { ok: true, stdout: listing() };
    });
    const { installer } = installerWith({ settings: memory.store, run });

    await expect(installer.start()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    expect(installer.status()).toEqual({ state: "failed", step: "marketplace" });
  });

  test.each([
    ["installed", {}],
    ["already installed", { installed: true }],
    ["failed", { fail: "marketplace" as const }],
  ])(
    "once it has %s, no later launch runs anything or looks for Claude Code",
    async (_what, claudeOptions) => {
      const memory = memoryStore();
      await installerWith({
        settings: memory.store,
        run: standInClaude(claudeOptions).run,
      }).installer.start();

      // The person removed the plugin since: the list would no longer name it.
      const later = standInClaude();
      const { installer, findBinary, warn } = installerWith({
        settings: memory.store,
        run: later.run,
      });
      await installer.start();

      expect(later.run).not.toHaveBeenCalled();
      expect(findBinary).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test("a try the app quit during is said once as unfinished, and never run again", async () => {
    const memory = memoryStore({
      kind: "record",
      record: { triedAt: NOW - 60_000, outcome: "running", step: null, told: false },
    });
    const claude = standInClaude();
    const { installer, findBinary, warn } = installerWith({
      settings: memory.store,
      run: claude.run,
    });

    await installer.start();

    expect(claude.run).not.toHaveBeenCalled();
    expect(findBinary).not.toHaveBeenCalled();
    expect(memory.current()).toEqual({
      kind: "record",
      record: { triedAt: NOW - 60_000, outcome: "failed", step: "unfinished", told: false },
    });
    expect(installer.status()).toEqual({ state: "failed", step: "unfinished" });
    expect(warn.mock.calls).toEqual([
      [
        "Agent Lookout quit before it finished installing its Claude Code plugin, and does not try again.",
      ],
    ]);
  });

  test("a notice not dismissed at the last launch is said again", async () => {
    const memory = memoryStore({
      kind: "record",
      record: { triedAt: NOW, outcome: "installed", step: null, told: false },
    });
    const { installer } = installerWith({ settings: memory.store, run: standInClaude().run });
    await installer.start();
    expect(installer.status()).toEqual({ state: "installed" });
  });

  test("a record that cannot be read means nothing runs and nothing is written, with one line in the log", async () => {
    const memory = memoryStore({ kind: "unreadable" });
    const claude = standInClaude();
    const { installer, findBinary, warn } = installerWith({
      settings: memory.store,
      run: claude.run,
    });

    await installer.start();

    expect(claude.run).not.toHaveBeenCalled();
    expect(findBinary).not.toHaveBeenCalled();
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(installer.status()).toEqual({ state: "idle" });
    expect(warn.mock.calls).toEqual([
      [
        "The record of the Claude Code plugin's install, plugin-install-state.json, could not be read, so Agent Lookout installs nothing.",
      ],
    ]);
  });

  test("a record that cannot be written means nothing runs", async () => {
    const memory = memoryStore();
    memory.failWrites();
    const claude = standInClaude();
    const { installer, warn } = installerWith({ settings: memory.store, run: claude.run });

    await installer.start();

    expect(claude.run).not.toHaveBeenCalled();
    expect(installer.status()).toEqual({ state: "idle" });
    expect(warn).toHaveBeenCalledOnce();
  });

  test("a development run runs nothing, writes nothing and does not look for Claude Code", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    const { installer, findBinary, warn } = installerWith({
      settings: memory.store,
      run: claude.run,
      packaged: false,
    });

    await installer.start();

    expect(claude.run).not.toHaveBeenCalled();
    expect(findBinary).not.toHaveBeenCalled();
    expect(memory.store.read).not.toHaveBeenCalled();
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(installer.status()).toEqual({ state: "idle" });
  });

  test.each(["off", " OFF "])(
    "AGENT_LOOKOUT_PLUGIN_INSTALL=%j is remembered, and nothing runs then or later",
    async (value) => {
      const memory = memoryStore();
      const claude = standInClaude();
      const { installer, findBinary } = installerWith({
        settings: memory.store,
        run: claude.run,
        env: { AGENT_LOOKOUT_PLUGIN_INSTALL: value },
      });

      await installer.start();

      expect(claude.run).not.toHaveBeenCalled();
      expect(findBinary).not.toHaveBeenCalled();
      expect(memory.current()).toEqual({
        kind: "record",
        record: { triedAt: NOW, outcome: "turned-off", step: null, told: false },
      });
      expect(installer.status()).toEqual({ state: "idle" });

      // A later launch without the setting runs nothing either.
      const later = installerWith({ settings: memory.store, run: claude.run });
      await later.installer.start();
      expect(claude.run).not.toHaveBeenCalled();
      expect(later.findBinary).not.toHaveBeenCalled();
    },
  );

  test.each(["on", undefined])("AGENT_LOOKOUT_PLUGIN_INSTALL=%j leaves it on", async (value) => {
    const memory = memoryStore();
    const claude = standInClaude();
    const { installer } = installerWith({
      settings: memory.store,
      run: claude.run,
      env: value === undefined ? {} : { AGENT_LOOKOUT_PLUGIN_INSTALL: value },
    });
    await installer.start();
    expect(claude.run).toHaveBeenCalledTimes(4);
  });

  test.each<[string, Partial<PluginInstallerOptions>]>([
    ["answering is off", { env: { AGENT_LOOKOUT_ANSWER: "off" } }],
    ["on Windows", { platform: "win32" }],
    ["claude is not run", { env: { AGENT_LOOKOUT_CLAUDE_FEED: "off" } }],
    [
      "a folder of Claude Code's own is named alone",
      { env: { AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/claude-home" } },
    ],
    [
      "a folder of Claude Code's own is named with a socket and no binary",
      {
        env: {
          AGENT_LOOKOUT_CLAUDE_HOME: "/Users/example/claude-home",
          AGENT_LOOKOUT_ANSWER_SOCKET: "/tmp/agent-lookout-test.sock",
        },
      },
    ],
  ])(
    "when %s, nothing runs and nothing is written, so a later launch may",
    async (_what, change) => {
      const memory = memoryStore();
      const claude = standInClaude();
      const { installer, findBinary } = installerWith({
        settings: memory.store,
        run: claude.run,
        ...change,
      });

      await installer.start();

      expect(claude.run).not.toHaveBeenCalled();
      expect(findBinary).not.toHaveBeenCalled();
      expect(memory.store.write).not.toHaveBeenCalled();
      expect(installer.status()).toEqual({ state: "idle" });
    },
  );

  test("without Claude Code, nothing is written, so a launch that finds it tries then", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    const { installer } = installerWith({
      settings: memory.store,
      run: claude.run,
      findBinary: async () => ({ found: false, looked: "The claude command was not found" }),
    });

    await installer.start();

    expect(claude.run).not.toHaveBeenCalled();
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(installer.status()).toEqual({ state: "idle" });

    const later = installerWith({ settings: memory.store, run: claude.run });
    await later.installer.start();
    expect(claude.run).toHaveBeenCalledTimes(4);
  });

  test("it says it is under way from the moment it starts until it ends, and runs once however often it is started", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn<RunCommand>(async (file, args, options) => {
      if (claude.run.mock.calls.length === 0) await held;
      return claude.run(file, args, options);
    });
    const { installer } = installerWith({ settings: memory.store, run });

    const first = installer.start();
    expect(installer.status()).toEqual({ state: "running" });
    const second = installer.start();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(installer.status()).toEqual({ state: "running" });
    // Nothing is dismissed while it is under way.
    expect(installer.markTold()).toEqual({ state: "running" });

    release();
    await first;
    expect(installer.status()).toEqual({ state: "installed" });
    expect(claude.commands()).toEqual([
      LIST.join(" "),
      ADD.join(" "),
      INSTALL.join(" "),
      LIST.join(" "),
    ]);
  });

  test("stopped as the app quits while it looks for Claude Code, it writes nothing and runs nothing", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { installer, findBinary } = installerWith({
      settings: memory.store,
      run: claude.run,
      findBinary: vi.fn(async () => {
        await held;
        return { found: true, path: CLAUDE } as const;
      }),
    });

    const started = installer.start();
    await vi.waitFor(() => expect(findBinary).toHaveBeenCalledOnce());
    installer.stop();
    release();
    await started;

    expect(claude.run).not.toHaveBeenCalled();
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(installer.status()).toEqual({ state: "idle" });
  });

  test.each([
    ["the first list", "list", [LIST]],
    ["marketplace add", "marketplace", [LIST, ADD]],
    ["install", "install", [LIST, ADD, INSTALL]],
  ] as const)(
    "stopped as the app quits during %s, no later step starts, and the record still says it is under way",
    async (_what, word, commands) => {
      const memory = memoryStore();
      const claude = standInClaude();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = vi.fn<RunCommand>(async (file, args, options) => {
        if (args.includes(word) && claude.run.mock.calls.length === commands.length - 1) {
          await held;
        }
        return claude.run(file, args, options);
      });
      const { installer } = installerWith({ settings: memory.store, run });

      const started = installer.start();
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(commands.length));
      installer.stop();
      release();
      await started;

      expect(claude.ran.map(({ args }) => args)).toEqual(commands);
      expect(memory.current()).toEqual({
        kind: "record",
        record: { triedAt: NOW, outcome: "running", step: null, told: false },
      });
    },
  );

  test("a search for Claude Code that throws writes nothing, runs nothing and is no longer under way", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    const { installer, warn } = installerWith({
      settings: memory.store,
      run: claude.run,
      findBinary: async () => {
        throw new Error("x");
      },
    });

    await expect(installer.start()).resolves.toBeUndefined();

    expect(installer.status()).toEqual({ state: "idle" });
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(claude.run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  test("of what the list prints, nothing reaches the log", async () => {
    const memory = memoryStore();
    const claude = standInClaude({ others: ["secret-plugin@somewhere"], fail: "install" });
    const { installer, warn } = installerWith({ settings: memory.store, run: claude.run });

    await installer.start();

    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-plugin");
    expect(JSON.stringify(memory.written)).not.toContain("secret-plugin");
    expect(JSON.stringify(installer.status())).not.toContain("secret-plugin");
  });
});

describe("markTold", () => {
  test.each([
    ["installed", {}, { state: "installed" }],
    ["failed", { fail: "list" as const }, { state: "failed", step: "check" }],
  ])("once it has %s, remembers it was said, and says nothing more", async (_what, opts, said) => {
    const memory = memoryStore();
    const claude = standInClaude(opts);
    const { installer } = installerWith({ settings: memory.store, run: claude.run });
    await installer.start();
    expect(installer.status()).toEqual(said);
    const ran = claude.run.mock.calls.length;

    expect(installer.markTold()).toEqual({ state: "idle" });
    expect(installer.status()).toEqual({ state: "idle" });
    const current = memory.current();
    expect(current.kind === "record" && current.record.told).toBe(true);
    expect(claude.run).toHaveBeenCalledTimes(ran);

    // A later launch says nothing.
    const later = installerWith({ settings: memory.store, run: claude.run });
    await later.installer.start();
    expect(later.installer.status()).toEqual({ state: "idle" });
  });

  test("with nothing to say, writes nothing", async () => {
    const memory = memoryStore();
    const claude = standInClaude({ installed: true });
    const { installer } = installerWith({ settings: memory.store, run: claude.run });
    await installer.start();
    const writes = vi.mocked(memory.store.write).mock.calls.length;

    expect(installer.markTold()).toEqual({ state: "idle" });
    expect(memory.store.write).toHaveBeenCalledTimes(writes);
  });

  test("before it has started, writes nothing and runs nothing", () => {
    const memory = memoryStore();
    const claude = standInClaude();
    const { installer } = installerWith({ settings: memory.store, run: claude.run });
    expect(installer.markTold()).toEqual({ state: "idle" });
    expect(memory.store.write).not.toHaveBeenCalled();
    expect(claude.run).not.toHaveBeenCalled();
  });

  test("a told that could not be written is hidden for this run, and said again at the next launch", async () => {
    const memory = memoryStore();
    const claude = standInClaude();
    const { installer } = installerWith({ settings: memory.store, run: claude.run });
    await installer.start();
    memory.failWrites();

    expect(installer.markTold()).toEqual({ state: "idle" });
    const later = installerWith({ settings: memory.store, run: claude.run });
    await later.installer.start();
    expect(later.installer.status()).toEqual({ state: "installed" });
  });
});
