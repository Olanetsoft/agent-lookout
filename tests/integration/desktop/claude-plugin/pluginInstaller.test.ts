import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { isProcessAlive } from "@collector/processes/pids";
import { createPluginInstaller } from "@desktop/claude-plugin/pluginInstaller";
import {
  pluginInstallFile,
  PLUGIN_INSTALL_FILE,
} from "@desktop/claude-plugin/pluginInstallSettings";
import { tempDir, writeStub } from "@tests/support/node/tempFiles";

const NOW = 1_767_600_000_000;

/**
 * Nothing is read in this home folder: the stand-in is named by
 * `AGENT_LOOKOUT_CLAUDE_BIN`, the only place then looked, and the path of the
 * answer socket under it is only measured.
 */
const HOME = "/Users/example";

/**
 * A stand-in `claude`, a POSIX sh script, that writes down in a folder of its
 * own what it was given: its arguments, whether stdin had anything for it,
 * how many of Agent Lookout's own settings reached it, and the two settings
 * every `claude` run gets. Its `plugin list` names the plugin once its
 * `plugin install` has run.
 */
const STAND_IN = `printf '%s\\n' "$*" >> "$STUB_DIR/args.log"
if IFS= read -r line; then echo got >> "$STUB_DIR/stdin.log"; else echo none >> "$STUB_DIR/stdin.log"; fi
env | grep -c '^AGENT_LOOKOUT_' >> "$STUB_DIR/own.log"
echo "\${DISABLE_AUTOUPDATER:-unset} \${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-unset}" >> "$STUB_DIR/env.log"
case "$*" in
  "plugin list")
    echo "Installed plugins:"
    echo "  formatter@tools"
    if [ -f "$STUB_DIR/installed" ]; then echo "  agent-lookout@agent-lookout"; fi
    ;;
  "plugin marketplace add Olanetsoft/agent-lookout") ;;
  "plugin install agent-lookout@agent-lookout") : > "$STUB_DIR/installed" ;;
  *) exit 2 ;;
esac`;

const lines = async (file: string) =>
  (await readFile(file, "utf8").catch(() => "")).split("\n").filter((line) => line !== "");

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("The condition never became true.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// The stand-in is a POSIX sh script, which Windows cannot run, and the
// installer installs nothing on Windows anyway.
describe.skipIf(process.platform === "win32")(
  "the one-time install, against a stand-in claude",
  () => {
    test("runs the four commands in order, directly, with stdin closed and none of Agent Lookout's settings, and never again", async () => {
      const stubDir = await tempDir();
      const stub = await writeStub(STAND_IN);
      const userData = await tempDir();
      const env = {
        PATH: "/usr/bin:/bin",
        STUB_DIR: stubDir,
        AGENT_LOOKOUT_CLAUDE_BIN: stub,
        AGENT_LOOKOUT_SMTP_URL: "smtp://user:secret@mail.example:587",
      };
      const logged: string[] = [];
      const installer = createPluginInstaller({
        env,
        homeDir: HOME,
        platform: process.platform,
        packaged: true,
        settings: pluginInstallFile(userData),
        now: () => NOW,
        warn: (line) => logged.push(line),
      });

      await installer.start();

      expect(await lines(path.join(stubDir, "args.log"))).toEqual([
        "plugin list",
        "plugin marketplace add Olanetsoft/agent-lookout",
        "plugin install agent-lookout@agent-lookout",
        "plugin list",
      ]);
      expect(await lines(path.join(stubDir, "stdin.log"))).toEqual(Array(4).fill("none"));
      expect(await lines(path.join(stubDir, "own.log"))).toEqual(Array(4).fill("0"));
      expect(await lines(path.join(stubDir, "env.log"))).toEqual(Array(4).fill("1 1"));
      expect(JSON.parse(await readFile(path.join(userData, PLUGIN_INSTALL_FILE), "utf8"))).toEqual({
        triedAt: NOW,
        outcome: "installed",
        step: null,
        told: false,
      });
      expect(installer.status()).toEqual({ state: "installed" });
      expect(logged).toEqual([
        "Agent Lookout installed its Claude Code plugin, agent-lookout@agent-lookout.",
      ]);
      // The other plugin in the list reached nothing.
      expect(logged.join()).not.toContain("formatter");

      // The next launch, on the same folder, runs nothing.
      const again = createPluginInstaller({
        env,
        homeDir: HOME,
        platform: process.platform,
        packaged: true,
        settings: pluginInstallFile(userData),
      });
      await again.start();
      expect(await lines(path.join(stubDir, "args.log"))).toHaveLength(4);
      expect(again.status()).toEqual({ state: "installed" });
    });

    test("a claude that does not answer in time is stopped, and the install fails at the check", async () => {
      const stubDir = await tempDir();
      const pidFile = path.join(stubDir, "pid");
      const stub = await writeStub(`echo $$ > '${pidFile}'\nexec sleep 30`);
      const userData = await tempDir();
      const installer = createPluginInstaller({
        env: { PATH: "/usr/bin:/bin", AGENT_LOOKOUT_CLAUDE_BIN: stub },
        homeDir: HOME,
        platform: process.platform,
        packaged: true,
        settings: pluginInstallFile(userData),
        now: () => NOW,
        timeoutsMs: { list: 1_000 },
      });

      const started = Date.now();
      await installer.start();

      // Far short of the 30 seconds the program wanted.
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(installer.status()).toEqual({ state: "failed", step: "check" });
      expect(JSON.parse(await readFile(path.join(userData, PLUGIN_INSTALL_FILE), "utf8"))).toEqual({
        triedAt: NOW,
        outcome: "failed",
        step: "check",
        told: false,
      });
      // On a busy machine the signal to stop can land before the script has
      // written its pid, and then there is no process left to check.
      const pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
      if (pid > 0) await waitUntil(() => !isProcessAlive(pid));
    });
  },
);
