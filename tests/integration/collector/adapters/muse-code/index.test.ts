import { cp, lstat, mkdir, readdir, rename, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import type { DshPrograms } from "@collector/adapters/deepseek-harness/processes";
import { createMuseCodeAdapter, LINK } from "@collector/adapters/muse-code/index";
import { createCollector } from "@collector/collector";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  ACTION,
  asked,
  CWD,
  opening,
  PRIVATE_WORDS,
  PROMPT,
  replied,
  requested,
  RUN,
  sessionEnd,
  terminal,
  uuidAt,
} from "@tests/fixtures/muse-code/museCode";
import { asWritten } from "@tests/support/paths";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// The adapter end to end, on real files this test writes, laid out as Meta
// documents Muse Code's session logs, and through the collector, which runs
// the real `ps` on macOS and Linux. Whether a Muse Code runs on the machine
// under test is not known, so the test that goes through the real `ps` takes
// any status, and the others give the adapter a stand-in for it. Every time a
// file holds, and each file's modified time, is set from the clock when the
// test runs, so the real date does not matter. The day folders' names decide
// nothing here, as the first poll lists them all.

const DAY_PATH = path.join("2026", "11", "19");

/** A session's ID, made from the clock now. */
const idNow = (n: number) => uuidAt(Date.now() - 3_600_000, n);

/** A data folder, with each session's log by its ID. */
async function homeWith(logs: Record<string, string>) {
  const home = await tempDir();
  await mkdir(path.join(home, "sessions"), { recursive: true });
  for (const [id, text] of Object.entries(logs)) {
    const file = path.join(home, "sessions", DAY_PATH, id, "session.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    await writtenAgo(file, 60);
  }
  return home;
}

const logOf = (home: string, id: string) =>
  path.join(home, "sessions", DAY_PATH, id, "session.jsonl");

/** Every name in a folder and below it, with each one's size and modified time. */
async function tree(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const target = path.join(dir, name);
    const info = await lstat(target);
    found.push(`${name} ${info.size} ${info.mtimeMs}`);
    if (info.isDirectory()) found.push(...(await tree(target)).map((one) => `${name}/${one}`));
  }
  return found;
}

/** Sets a file's times to `secondsAgo` before now. */
async function writtenAgo(file: string, secondsAgo: number) {
  const at = new Date(Date.now() - secondsAgo * 1000);
  await utimes(file, at, at);
}

/** A stand-in for `ps` that lists a `muse` that started an hour ago, or none. */
function standInPs(running: boolean) {
  const programs = running ? [{ start: Date.now() - 3_600_000, desktop: true }] : [];
  const answer: DshPrograms = { ok: true, ownListed: true, programs };
  return { read: async () => answer };
}

const adapterFor = (home: string, running = true, io: ReadOnlyIo = nodeIo) =>
  createMuseCodeAdapter({
    env: { AGENT_LOOKOUT_MUSE_CODE_HOME: home },
    platform: "linux",
    processes: standInPs(running),
    io,
  });

/** A log whose records are timed from now. */
function logNow(id: string, rest: (at: number) => string = () => "") {
  const now = Date.now();
  return `${opening(now - 600_000, RUN, { session: id })}${rest(now)}`;
}

describe("the Muse Code adapter on real files", () => {
  test("reads each session's log, as working, needing you, idle, failed and finished", async () => {
    const ids = [1, 2, 3, 4, 5].map(idNow);
    const [working, waiting, idle, failed, finished] = ids as [
      string,
      string,
      string,
      string,
      string,
    ];
    const home = await homeWith({
      [working]: logNow(working, (now) => replied(RUN, now - 60_000, { session: working })),
      [waiting]: logNow(waiting, (now) => asked(RUN, PROMPT, now - 60_000, { session: waiting })),
      [idle]: logNow(idle, (now) => terminal(RUN, now - 60_000, "completed", { session: idle })),
      [failed]: logNow(failed, (now) => terminal(RUN, now - 60_000, "failed", { session: failed })),
      [finished]: logNow(
        finished,
        (now) =>
          `${terminal(RUN, now - 70_000, "cancelled", { session: finished })}${sessionEnd(now - 60_000, "clean", { session: finished })}`,
      ),
    });
    const { health, sessions } = await adapterFor(home).poll();
    expect(health.state).toBe("ok");
    const byId = new Map(sessions.map((session) => [session.id, session]));
    expect(byId.get(`muse-code:${working}`)).toMatchObject({
      status: "working",
      cwd: CWD,
      name: "demo-project",
    });
    expect(byId.get(`muse-code:${waiting}`)).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
    });
    expect(byId.get(`muse-code:${idle}`)?.status).toBe("idle");
    expect(byId.get(`muse-code:${failed}`)?.status).toBe("failed");
    expect(byId.get(`muse-code:${finished}`)?.status).toBe("finished");
    const said = JSON.stringify({ health, sessions });
    for (const word of PRIVATE_WORDS) expect(said, word).not.toContain(word);
  });

  test("with no Muse Code that started before the last write, a session is finished", async () => {
    const id = idNow(1);
    const home = await homeWith({
      [id]: logNow(id, (now) => replied(RUN, now - 60_000, { session: id })),
    });
    expect((await adapterFor(home, false).poll()).sessions[0]?.status).toBe("finished");
  });

  // Making a link on Windows needs a right a test cannot count on.
  test.skipIf(process.platform === "win32")(
    "never follows a link at sessions/, at a day folder, at a session folder or at a log",
    async () => {
      const id = idNow(1);
      const elsewhere = await homeWith({
        [id]: logNow(id, (now) => replied(RUN, now - 60_000, { session: id })),
      });

      const atSessions = await tempDir();
      await symlink(path.join(elsewhere, "sessions"), path.join(atSessions, "sessions"));
      expect((await adapterFor(atSessions).poll()).health).toMatchObject({
        state: "error",
        detail: expect.stringContaining(LINK),
      });

      const atDay = await tempDir();
      await mkdir(path.join(atDay, "sessions", "2026", "11"), { recursive: true });
      await symlink(
        path.join(elsewhere, "sessions", DAY_PATH),
        path.join(atDay, "sessions", DAY_PATH),
      );
      const day = await adapterFor(atDay).poll();
      expect(day.sessions).toEqual([]);
      expect(day.health.detail).toContain(LINK);

      const atFolder = await tempDir();
      await mkdir(path.join(atFolder, "sessions", DAY_PATH), { recursive: true });
      await symlink(
        path.join(elsewhere, "sessions", DAY_PATH, id),
        path.join(atFolder, "sessions", DAY_PATH, id),
      );
      expect((await adapterFor(atFolder).poll()).sessions).toEqual([]);

      const atLog = await tempDir();
      await mkdir(path.join(atLog, "sessions", DAY_PATH, id), { recursive: true });
      await symlink(logOf(elsewhere, id), logOf(atLog, id));
      const log = await adapterFor(atLog).poll();
      expect(log.sessions).toEqual([]);
      expect(log.health.detail).toContain(LINK);
    },
  );

  test.skipIf(process.platform === "win32").each([
    ["day", DAY_PATH],
    ["year", "2026"],
  ])(
    "never goes through a %s folder replaced by a link after a session that needed you was read",
    async (_, place) => {
      const id = idNow(1);
      const home = await homeWith({
        [id]: logNow(id, (now) =>
          requested(RUN, ACTION, now - 60_000, "human_pending", { session: id }),
        ),
      });
      const opened: string[] = [];
      const io: ReadOnlyIo = {
        ...nodeIo,
        openRegular: (file) => (opened.push(asWritten(file)), nodeIo.openRegular(file)),
      };
      const adapter = adapterFor(home, true, io);
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
      // The same folder, copied elsewhere, and a link to the copy in its place.
      const folder = path.join(home, "sessions", place);
      const away = await tempDir();
      const copy = path.join(away, "copy");
      await cp(folder, copy, { recursive: true });
      await rename(folder, path.join(away, "moved"));
      await symlink(copy, folder);
      opened.length = 0;
      const { sessions, health } = await adapter.poll();
      expect(sessions).toEqual([]);
      expect(health.detail).toContain(LINK);
      expect(opened).toEqual([]);
    },
  );

  test("reads nothing of a log put in place of the one its lstat found", async () => {
    const id = idNow(1);
    const home = await homeWith({
      [id]: logNow(id, (now) => replied(RUN, now - 60_000, { session: id })),
    });
    const file = logOf(home, id);
    let swapped = false;
    const io: ReadOnlyIo = {
      ...nodeIo,
      async lstat(target) {
        const info = await nodeIo.lstat(target);
        if (asWritten(target) !== asWritten(file) || swapped) return info;
        swapped = true;
        // A new file under the same name, after this lookup.
        await writeFile(
          `${file}.new`,
          logNow(id, (now) => asked(RUN, PROMPT, now, { session: id })),
        );
        await rename(`${file}.new`, file);
        return info;
      },
    };
    const adapter = adapterFor(home, true, io);
    expect((await adapter.poll()).sessions).toEqual([]);
    // The next poll's lookup finds the new file, and reads it.
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
  });

  test("through the collector, beside every other source, with the real ps, in any status", async () => {
    const id = idNow(1);
    const home = await homeWith({
      [id]: logNow(id, (now) => replied(RUN, now - 60_000, { session: id })),
    });
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
        AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME: await tempDir(),
        AGENT_LOOKOUT_DROID_HOME: await tempDir(),
        AGENT_LOOKOUT_GROK_HOME: await tempDir(),
        AGENT_LOOKOUT_OMP_HOME: await tempDir(),
        AGENT_LOOKOUT_MUSE_CODE_HOME: home,
        AGENT_LOOKOUT_STATUS_DIR: path.join(await tempDir(), "no-status-files-here"),
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_TERMINAL_JUMP: "off",
        AGENT_LOOKOUT_EDITOR_JUMP: "off",
        AGENT_LOOKOUT_ANSWER: "off",
        AGENT_LOOKOUT_STOP: "off",
      },
      intervalMs: 5_000,
    });
    onTestFinished(() => collector.stop());
    const snapshot = await collector.poller.pollOnce();
    const source = snapshot.sources.find((one) => one.id === "muse-code");
    expect(source?.state).toBe("ok");
    const session = snapshot.sessions.find((one) => one.id === `muse-code:${id}`);
    expect(session).toBeDefined();
    expect(["working", "finished", "unknown"]).toContain(session?.status);
  });

  test("changes nothing in the data folder, and opens nothing but the log", async () => {
    const id = idNow(1);
    const home = await homeWith({
      [id]: logNow(id, (now) => replied(RUN, now - 60_000, { session: id })),
    });
    const folder = path.dirname(logOf(home, id));
    await writeFile(path.join(folder, ".session.lock"), "pid=1");
    // One ID, made once, as the clock moves between two calls.
    const child = path.join(folder, "subagent", idNow(2));
    await mkdir(child, { recursive: true });
    await writeFile(path.join(child, "session.jsonl"), "x");
    await writeFile(path.join(home, "session-index.db"), "x");
    await mkdir(path.join(home, "sessions", ".msp-view-v1"), { recursive: true });
    const before = await tree(home);
    const looked: string[] = [];
    const io: ReadOnlyIo = {
      readdir: (dir) => (looked.push(`readdir ${asWritten(dir)}`), nodeIo.readdir(dir)),
      stat: (target) => (looked.push(`stat ${asWritten(target)}`), nodeIo.stat(target)),
      lstat: (target) => (looked.push(`lstat ${asWritten(target)}`), nodeIo.lstat(target)),
      openRegular: (file) => (looked.push(`open ${asWritten(file)}`), nodeIo.openRegular(file)),
    };
    const adapter = adapterFor(home, true, io);
    await adapter.poll();
    await adapter.poll();
    expect(await tree(home)).toEqual(before);
    expect(looked.filter((call) => call.startsWith("open "))).toEqual([
      `open ${asWritten(logOf(home, id))}`,
    ]);
    expect(looked.filter((call) => /lock|\.db|subagent|msp-view/.test(call))).toEqual([]);
  });
});
