import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendFile, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createDeepseekHarnessAdapter,
  type DeepseekHarnessAdapterOptions,
} from "@collector/adapters/deepseek-harness/index";
import { createCollector } from "@collector/collector";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import type { PsAnswer } from "@collector/processes/ps";
import {
  batch,
  CHILD_ID,
  childHeaderLine,
  endedTurn,
  headerLine,
  line,
  PRIVATE_WORDS,
  PROJECT_FOLDER,
  SESSION_ID,
  sessionIdOf,
} from "@tests/fixtures/deepseek-harness/deepseekHarness";
import { psLine, ZSTD } from "@tests/support/adapters/deepseek-harness/deepseekHarnessAdapter";
import {
  compressedLog,
  frame,
  HAS_ZSTD,
  NO_ZSTD_REASON,
} from "@tests/support/adapters/deepseek-harness/frames";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as
// DeepSeek Harness dsh-v0.2.2-rc.3 lays them out, beside the files of its
// home that are never read, and through the collector. Each log's time is
// set a few minutes back, the program reader is a stand-in whose table shows
// a node that started before every session, and the computer's start is set
// a month back, so what a status is never depends on whether DeepSeek
// Harness runs on the machine under test, nor on when that machine started,
// nor on what the real clock does between two lines.

const ID = `deepseek-harness:${SESSION_ID}`;
const OWN = process.pid;

/** A `ps` that shows Agent Lookout and a node that started an hour ago, whatever runs here. */
const nodeRuns = async (): Promise<PsAnswer> => ({
  ok: true,
  stdout: `${psLine(OWN, Date.now() - 7_200_000, "node")}\n${psLine(1, Date.now() - 3_600_000, "node")}\n`,
});

/** A DeepSeek Harness home holding these logs, by ID, as uncompressed or compressed, with its other files beside them. */
async function homeWith(
  logs: Record<string, string | Uint8Array>,
  options: { at?: number; compressed?: boolean } = {},
) {
  const home = await tempDir();
  for (const [name, text] of [
    [".credentials.yaml", PRIVATE_WORDS[4]],
    [".env", PRIVATE_WORDS[4]],
    ["cordis.patch.yml", PRIVATE_WORDS[4]],
    [".anonymous-user-id", PRIVATE_WORDS[4]],
  ]) {
    await writeFile(path.join(home, name as string), text as string);
  }
  for (const folder of ["profiles/desktop", "storages/session_projcache/sessions", "attachments"]) {
    await mkdir(path.join(home, folder), { recursive: true });
    await writeFile(path.join(home, folder, "x"), PRIVATE_WORDS[3]);
  }
  const at = new Date(options.at ?? Date.now() - 3 * 60_000);
  for (const [id, text] of Object.entries(logs)) {
    const folder = path.join(home, "sessions", PROJECT_FOLDER, id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "session.lock"), "");
    await writeFile(path.join(folder, "session.v4.jsonl.zstd.0a1b2c3d4e5f.tmp"), PRIVATE_WORDS[0]);
    const file = path.join(
      folder,
      typeof text === "string" && options.compressed !== true
        ? "session.v4.jsonl"
        : "session.v4.jsonl.zstd",
    );
    await writeFile(file, text);
    await utimes(file, at, at);
  }
  return home;
}

/** An io that writes down every path it is asked about, and how many files are open at once. */
function recording() {
  const asked: string[] = [];
  let open = 0;
  let most = 0;
  const io: ReadOnlyIo = {
    readdir: (dir) => (asked.push(dir), nodeIo.readdir(dir)),
    stat: (target) => (asked.push(target), nodeIo.stat(target)),
    lstat: (target) => (asked.push(target), nodeIo.lstat(target)),
    async openRegular(file) {
      asked.push(file);
      const handle = await nodeIo.openRegular(file);
      open += 1;
      most = Math.max(most, open);
      return {
        ...handle,
        close: async () => {
          open -= 1;
          await handle.close();
        },
      };
    },
  };
  return { io, asked, most: () => most };
}

const adapterFor = (home: string, options: DeepseekHarnessAdapterOptions = {}) =>
  createDeepseekHarnessAdapter({
    env: { AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: home },
    runPs: nodeRuns,
    // A computer on for 30 days, so the boot rule never finishes these sessions, whenever this machine started.
    uptimeMs: () => 30 * 24 * 60 * 60_000,
    platform:
      process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux",
    ...options,
  });

/** Every file under a folder, with its bytes, size, time and identity. */
function snapshotOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const target = path.join(at, name);
      const info = lstatSync(target);
      if (info.isDirectory()) walk(target);
      else
        out[target] =
          `${info.size}:${info.mtimeMs}:${info.ino}:${readFileSync(target).toString("base64")}`;
    }
  };
  walk(dir);
  return out;
}

describe("sessions on real files", () => {
  test("are read from the logs alone, read-only, and nothing private leaves them", async () => {
    const home = await homeWith({
      [SESSION_ID]:
        headerLine() +
        batch(
          line.turnStart(0, Date.now() - 4 * 60_000),
          line.userMessage(1, Date.now() - 4 * 60_000),
          line.title(2, Date.now() - 4 * 60_000, PRIVATE_WORDS[8], "fallback"),
          line.title(3, Date.now() - 4 * 60_000, "Fix the build", "provider"),
          line.toolCall(4, Date.now() - 4 * 60_000, "call_1", "ask_user_question"),
        ),
      [CHILD_ID]: childHeaderLine() + batch(...endedTurn(0, Date.now() - 4 * 60_000)),
    });
    const before = snapshotOf(home);
    const { io, asked, most } = recording();
    const adapter = adapterFor(home, { io });
    let last = await adapter.poll();
    for (let n = 0; n < 9; n++) last = await adapter.poll();
    expect(last.health.state).toBe("ok");
    expect(last.sessions.map((one) => [one.id, one.name, one.status, one.waitingReason])).toEqual([
      [ID, "Fix the build", "needs-you", "question"],
    ]);
    for (const word of PRIVATE_WORDS) expect(JSON.stringify(last), word).not.toContain(word);
    // Nothing was written, moved or touched.
    expect(snapshotOf(home)).toEqual(before);
    // Nothing outside its sessions folder, and no lock or temporary file, is looked at.
    const sessions = path.join(home, "sessions");
    for (const target of asked) {
      expect(target === sessions || target.startsWith(`${sessions}${path.sep}`), target).toBe(true);
      expect(target, target).not.toMatch(/session\.lock|\.tmp$/);
    }
    // One log open at a time.
    expect(most()).toBe(1);
  });

  test.skipIf(!HAS_ZSTD)(
    `compressed logs are read, and what is added to them (${NO_ZSTD_REASON} otherwise)`,
    async () => {
      const start = Date.now() - 4 * 60_000;
      const home = await homeWith(
        {
          [SESSION_ID]: compressedLog(
            headerLine(),
            batch(line.turnStart(0, start)),
            batch(line.title(1, start, "Fix the build", "user")),
          ),
        },
        { compressed: true },
      );
      const adapter = adapterFor(home, { zstd: ZSTD });
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        name: "Fix the build",
        status: "working",
      });
      const file = path.join(home, "sessions", PROJECT_FOLDER, SESSION_ID, "session.v4.jsonl.zstd");
      await appendFile(file, frame(batch(line.turnEnd(2, start + 1_000, "completed"))));
      const at = new Date(Date.now() - 2 * 60_000);
      await utimes(file, at, at);
      expect((await adapter.poll()).sessions[0]).toMatchObject({
        status: "idle",
        statusSince: start + 1_000,
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link at the sessions folder is followed, and one below it never",
    async () => {
      const real = await homeWith({
        [SESSION_ID]: headerLine() + batch(...endedTurn(0, Date.now() - 4 * 60_000)),
      });
      const linked = await tempDir();
      await symlink(path.join(real, "sessions"), path.join(linked, "sessions"));
      expect((await adapterFor(linked).poll()).sessions.map((one) => one.id)).toEqual([ID]);

      const other = await homeWith({
        [sessionIdOf(9)]:
          headerLine({ id: sessionIdOf(9) }) + batch(...endedTurn(0, Date.now() - 4 * 60_000)),
      });
      const below = await homeWith({});
      const sessions = path.join(below, "sessions");
      await mkdir(sessions, { recursive: true });
      // A project folder, a session folder and a log, each a link to a real one.
      await symlink(
        path.join(other, "sessions", PROJECT_FOLDER),
        path.join(sessions, "--linked-project--"),
      );
      await mkdir(path.join(sessions, PROJECT_FOLDER), { recursive: true });
      await symlink(
        path.join(other, "sessions", PROJECT_FOLDER, sessionIdOf(9)),
        path.join(sessions, PROJECT_FOLDER, "session-linked"),
      );
      await mkdir(path.join(sessions, PROJECT_FOLDER, SESSION_ID), { recursive: true });
      await symlink(
        path.join(other, "sessions", PROJECT_FOLDER, sessionIdOf(9), "session.v4.jsonl"),
        path.join(sessions, PROJECT_FOLDER, SESSION_ID, "session.v4.jsonl"),
      );
      const result = await adapterFor(below).poll();
      expect(result.health.state).toBe("ok");
      expect(result.sessions).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link put at a session folder's name since it was listed is not gone into",
    async () => {
      const home = await homeWith({
        [SESSION_ID]: headerLine() + batch(...endedTurn(0, Date.now() - 4 * 60_000)),
      });
      const other = await homeWith({
        [sessionIdOf(9)]:
          headerLine({ id: sessionIdOf(9) }) + batch(...endedTurn(0, Date.now() - 4 * 60_000)),
      });
      const { io, asked } = recording();
      const adapter = adapterFor(home, { io });
      expect((await adapter.poll()).sessions.map((one) => one.id)).toEqual([ID]);
      const folder = path.join(home, "sessions", PROJECT_FOLDER, SESSION_ID);
      await rm(folder, { recursive: true });
      await symlink(path.join(other, "sessions", PROJECT_FOLDER, sessionIdOf(9)), folder);
      asked.length = 0;
      const result = await adapter.poll();
      expect(result.health.state).toBe("ok");
      expect(result.sessions).toEqual([]);
      for (const target of asked) {
        expect(target.startsWith(`${folder}${path.sep}`), target).toBe(false);
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "a link put at a session folder's name after its log was looked up is not read through",
    async () => {
      const start = Date.now() - 4 * 60_000;
      const home = await homeWith({
        [SESSION_ID]:
          headerLine() +
          batch(line.title(0, start, "Fix the build", "provider"), ...endedTurn(1, start)),
      });
      const other = await homeWith({
        [sessionIdOf(9)]:
          headerLine({ id: sessionIdOf(9) }) +
          batch(
            line.title(0, start, "Write the docs", "provider"),
            line.turnStart(1, start),
            line.turnEnd(2, start + 1_000, "error"),
          ),
      });
      const folder = path.join(home, "sessions", PROJECT_FOLDER, SESSION_ID);
      const file = path.join(folder, "session.v4.jsonl");
      let swap = false;
      // The folder becomes a link to another session's folder just before its log is opened.
      const io: ReadOnlyIo = {
        ...nodeIo,
        async openRegular(target) {
          if (swap && target === file) {
            swap = false;
            await rm(folder, { recursive: true });
            await symlink(path.join(other, "sessions", PROJECT_FOLDER, sessionIdOf(9)), folder);
          }
          return nodeIo.openRegular(target);
        },
      };
      const adapter = adapterFor(home, { io });
      const shown = (result: Awaited<ReturnType<typeof adapter.poll>>) =>
        result.sessions.map((one) => [one.id, one.name, one.status]);
      expect(shown(await adapter.poll())).toEqual([[ID, "Fix the build", "idle"]]);
      await appendFile(file, batch(line.turnStart(5, start + 2_000)));
      const at = new Date(Date.now() - 2 * 60_000);
      await utimes(file, at, at);
      swap = true;
      expect(shown(await adapter.poll())).toEqual([[ID, "Fix the build", "idle"]]);
      expect(swap).toBe(false);
    },
  );

  test("a subagent's log is not shown, and a log older than a day is left out", async () => {
    const home = await homeWith({
      [SESSION_ID]: headerLine() + batch(...endedTurn(0, Date.now() - 4 * 60_000)),
      [CHILD_ID]: childHeaderLine() + batch(line.turnStart(0, Date.now() - 4 * 60_000)),
    });
    const old = path.join(home, "sessions", PROJECT_FOLDER, sessionIdOf(7));
    await mkdir(old, { recursive: true });
    await writeFile(path.join(old, "session.v4.jsonl"), headerLine({ id: sessionIdOf(7) }));
    const long = new Date(Date.now() - 2 * 24 * 3_600_000);
    await utimes(path.join(old, "session.v4.jsonl"), long, long);
    const { sessions } = await adapterFor(home).poll();
    expect(sessions.map((one) => [one.id, one.status])).toEqual([[ID, "working"]]);
    expect(statSync(path.join(old, "session.v4.jsonl")).size).toBeGreaterThan(0);
  });
});

/** A collector that reads that home and an empty folder for every other agent, polled once. */
async function pollOnce(home: string, platform: NodeJS.Platform) {
  const collector = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: await makeClaudeHome(),
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_ANTIGRAVITY_HOME: await tempDir(),
      AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME: await tempDir(),
      AGENT_LOOKOUT_VIBE_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_GEMINI_CLI_HOME: await tempDir(),
      AGENT_LOOKOUT_OPENCODE_HOME: await tempDir(),
      AGENT_LOOKOUT_QWEN_HOME: await tempDir(),
      AGENT_LOOKOUT_HERMES_HOME: await tempDir(),
      AGENT_LOOKOUT_CLINE_HOME: await tempDir(),
      AGENT_LOOKOUT_GOOSE_HOME: await tempDir(),
      AGENT_LOOKOUT_PI_HOME: await tempDir(),
      AGENT_LOOKOUT_KIMI_CODE_HOME: await tempDir(),
      AGENT_LOOKOUT_CONTINUE_HOME: await tempDir(),
      AGENT_LOOKOUT_CRUSH_HOME: await tempDir(),
      AGENT_LOOKOUT_KILO_HOME: await tempDir(),
      AGENT_LOOKOUT_MIMO_CODE_HOME: await tempDir(),
      AGENT_LOOKOUT_KIMCHI_HOME: await tempDir(),
      AGENT_LOOKOUT_PRIME_AGENT_HOME: await tempDir(),
      AGENT_LOOKOUT_FX_HOME: await tempDir(),
      AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR: await tempDir(),
      AGENT_LOOKOUT_AUTOHAND_HOME: await tempDir(),
      AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: home,
      AGENT_LOOKOUT_DROID_HOME: await tempDir(),
      AGENT_LOOKOUT_GROK_HOME: await tempDir(),
      AGENT_LOOKOUT_MUSE_CODE_HOME: await tempDir(),
      AGENT_LOOKOUT_COPILOT_HOME: await tempDir(),
      AGENT_LOOKOUT_KIRO_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_EDITOR_JUMP: "off",
      AGENT_LOOKOUT_ANSWER: "off",
      AGENT_LOOKOUT_STOP: "off",
    },
    intervalMs: 5_000,
    platform,
  });
  onTestFinished(() => collector.stop());
  return collector.poller.pollOnce();
}

describe("through the collector", () => {
  test.each(["darwin", "linux", "win32"] as const)(
    "on %s, a session that failed, and one closed mid-turn, show so whatever runs, and nothing private is sent",
    async (platform) => {
      const at = Date.now() - 4 * 60_000;
      const home = await homeWith({
        [SESSION_ID]: headerLine() + batch(...endedTurn(0, at, "error")),
        [sessionIdOf(5)]:
          headerLine({ id: sessionIdOf(5) }) +
          batch(line.turnStart(0, at), line.aborted(1, at + 1, "disposed")),
      });
      const snapshot = await pollOnce(home, platform);
      expect(snapshot.sources.find((one) => one.id === "deepseek-harness")?.state).toBe("ok");
      const sessions = snapshot.sessions.filter((one) => one.source === "deepseek-harness");
      expect(sessions.map((one) => [one.id, one.status]).sort()).toEqual(
        [
          [ID, "failed"],
          [`deepseek-harness:${sessionIdOf(5)}`, "finished"],
        ].sort(),
      );
      for (const word of PRIVATE_WORDS) expect(JSON.stringify(snapshot), word).not.toContain(word);
    },
  );
});

describe("its modules", () => {
  const root = fileURLToPath(new URL("../../../../../src/", import.meta.url));
  const folders = ["collector/adapters/deepseek-harness", "core/mapping/deepseek-harness"];
  const sources = () =>
    folders.flatMap((folder) =>
      readdirSync(path.join(root, folder)).map((name) => ({
        name,
        text: readFileSync(path.join(root, folder, name), "utf8"),
      })),
    );

  test("reach the file system, sockets and programs only through what they are given, and send no signal", () => {
    for (const { name, text } of sources()) {
      expect(text, name).not.toMatch(
        /from "node:(fs|fs\/promises|net|child_process|string_decoder)"/,
      );
      // node:zlib only whole, so a Node.js without Zstandard still loads it.
      expect(text, name).not.toMatch(/import\s*\{[^}]*\}\s*from "node:zlib"/);
      expect(text, name).not.toMatch(/process\.kill|\.kill\(/);
    }
  });

  test("turn bytes into text only with toString", () => {
    for (const { name, text } of sources()) {
      expect(text, name).not.toMatch(
        /\.(ascii|ucs2|hex|base64|latin1|utf8)Slice\(|fromCharCode|toLocaleString|TextDecoder|string_decoder/,
      );
    }
  });

  test("keep no byte of a log between polls", () => {
    const reader = readFileSync(
      path.join(root, "collector/adapters/deepseek-harness/logReader.ts"),
      "utf8",
    );
    const cached = /interface Cached \{([\s\S]*?)\n\}/.exec(reader)?.[1] ?? "";
    expect(cached).not.toBe("");
    expect(cached).not.toMatch(/Buffer|Uint8Array/);
    const log = /export interface DeepseekHarnessLog \{([\s\S]*?)\n\}/.exec(reader)?.[1] ?? "";
    expect(log).not.toMatch(/Buffer|Uint8Array/);
  });
});
