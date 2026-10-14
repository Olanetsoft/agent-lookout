import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import {
  createQwenCodeAdapter,
  type QwenCodeAdapterOptions,
} from "@collector/adapters/qwen-code/index";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  fixture,
  HOME,
  MINUTE,
  NEVER_OPENED,
  NOW,
  PLACEHOLDER,
  PRIVATE_TOKEN,
  PRIVATE_WORDS,
  PROJECT,
  PROJECT_FOLDER,
  promptLine,
  registeredAt,
  registryRecord,
  RUNNING_PIDS,
  sessionIdOf,
} from "@tests/fixtures/qwen-code/qwenCode";
import { handClock, healthy } from "@tests/support/adapters/qwenCodeAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

/** `tests/fixtures/qwen-code/home`, laid out as Qwen Code lays out its own folder. Never written in. */
const FIXTURE_HOME = fileURLToPath(new URL("../../../../fixtures/qwen-code/home", import.meta.url));

const CHATS = path.join("projects", PROJECT_FOLDER, "chats");

/** When the fixture's chat files were last written, set on each copy. */
const WRITTEN = {
  working: NOW - 28 * MINUTE,
  idle: NOW - 118 * MINUTE,
  headless: NOW - 19 * MINUTE,
  crashed: NOW - 170 * MINUTE,
} as const;

/**
 * A copy of the fixture folder that a test may change, with a `.env` beside
 * the others git keeps no copy of, and each chat file's modified time set.
 */
async function makeQwenHome(): Promise<string> {
  const home = await tempDir();
  await cp(FIXTURE_HOME, home, { recursive: true });
  await writeFile(path.join(home, ".env"), `QWEN_RUNTIME_DIR=/tmp/${PRIVATE_TOKEN}\n`);
  for (const [name, time] of Object.entries(WRITTEN)) {
    const { sessionId } = fixture[name as keyof typeof WRITTEN];
    await utimes(path.join(home, CHATS, `${sessionId}.jsonl`), time / 1000, time / 1000);
  }
  return home;
}

/** An adapter pointed at this folder, with the clock at the fixture's `NOW` and its processes stood in for. */
function adapterFor(home: string, options: QwenCodeAdapterOptions = {}) {
  return createQwenCodeAdapter({
    env: { AGENT_LOOKOUT_QWEN_HOME: home },
    homeDir: HOME,
    now: () => NOW,
    isAlive: (pid) => RUNNING_PIDS.has(pid),
    platform: "darwin",
    ...options,
  });
}

/** The real file system, with every call written down. */
function recordingIo() {
  const calls: { method: keyof ReadOnlyIo; path: string }[] = [];
  const io: ReadOnlyIo = {
    readdir: (target) => (calls.push({ method: "readdir", path: target }), nodeIo.readdir(target)),
    stat: (target) => (calls.push({ method: "stat", path: target }), nodeIo.stat(target)),
    lstat: (target) => (calls.push({ method: "lstat", path: target }), nodeIo.lstat(target)),
    openRegular: (target) => (
      calls.push({ method: "openRegular", path: target }),
      nodeIo.openRegular(target)
    ),
  };
  return { io, calls };
}

/**
 * Everything under a folder: each ordinary file's hash, size and modified
 * time, each link's target and each other thing's kind. Nothing but ordinary
 * files is opened, so a pipe cannot hold it up.
 */
async function snapshotOf(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const target = path.join(dir, name);
      const relative = path.relative(root, target);
      const info = await lstat(target);
      if (info.isDirectory()) {
        found[relative] = `folder ${info.mtimeMs}`;
        await walk(target);
      } else if (info.isSymbolicLink()) {
        found[relative] = `link to ${await readlink(target)}`;
      } else if (info.isFile()) {
        const hash = createHash("sha256")
          .update(await readFile(target))
          .digest("hex");
        found[relative] = `${hash} ${info.size} ${info.mtimeMs}`;
      } else {
        found[relative] = `other ${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return found;
}

describe("the Qwen Code adapter, on a folder laid out as Qwen Code lays it out", () => {
  test("lists each terminal session with its status, name and folder, and a crash's leftover as finished", async () => {
    const home = await makeQwenHome();
    const result = await adapterFor(home).poll();
    expect(result.health).toMatchObject({
      id: "qwen-code",
      state: "ok",
      detail: healthy(path.join(home, "sessions"), path.join(home, "projects")),
    });
    expect(result.basis).toBe("files");
    const common = { source: "qwen-code", surface: "terminal", links: {}, stale: false };
    expect(result.sessions).toEqual([
      {
        ...common,
        id: `qwen-code:${fixture.working.sessionId}`,
        name: "Fix the flaky test",
        cwd: PROJECT,
        project: "demo-project",
        status: "working",
        startedAt: Date.UTC(2026, 9, 1, 11, 31),
        statusSince: Date.UTC(2026, 9, 1, 11, 31),
        lastWriteAt: WRITTEN.working,
        pid: fixture.working.pid,
        alive: true,
      },
      {
        ...common,
        id: `qwen-code:${fixture.idle.sessionId}`,
        name: "Tidy the release notes",
        cwd: PROJECT,
        project: "demo-project",
        status: "idle",
        startedAt: Date.UTC(2026, 9, 1, 10, 1),
        statusSince: Date.UTC(2026, 9, 1, 10, 2, 0, 1),
        lastWriteAt: WRITTEN.idle,
        pid: fixture.idle.pid,
        alive: true,
      },
      {
        ...common,
        id: `qwen-code:${fixture.fresh.sessionId}`,
        name: "demo-api",
        cwd: "/Users/example/code/demo-api",
        project: "demo-api",
        status: "idle",
        startedAt: registeredAt.fresh,
        statusSince: registeredAt.fresh,
        pid: fixture.fresh.pid,
        alive: true,
      },
      {
        ...common,
        id: `qwen-code:${fixture.crashed.sessionId}`,
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "finished",
        startedAt: registeredAt.crashed,
        statusSince: WRITTEN.crashed,
        lastWriteAt: WRITTEN.crashed,
        pid: fixture.crashed.pid,
        alive: false,
      },
    ]);
  });

  test("opens only the records and the chat files of the sessions it lists, and lists only two folders", async () => {
    const home = await makeQwenHome();
    const { io, calls } = recordingIo();
    const clock = handClock();
    const adapter = adapterFor(home, { io, now: clock.now });
    await adapter.poll();

    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.sort()).toEqual(
      [
        path.join(home, "sessions", "41001.json"),
        path.join(home, "sessions", "41002-0a1b2c3d.json"),
        path.join(home, "sessions", "41004.json"),
        path.join(home, "sessions", "41005.json"),
        path.join(home, "sessions", "41006.json"),
        path.join(home, CHATS, `${fixture.working.sessionId}.jsonl`),
        path.join(home, CHATS, `${fixture.idle.sessionId}.jsonl`),
      ].sort(),
    );
    const listed = calls.filter((call) => call.method === "readdir").map((call) => call.path);
    // The new session has no chat file yet, so the chat folders are looked through once for it.
    expect(listed.sort()).toEqual([path.join(home, "projects"), path.join(home, "sessions")]);
    for (const never of [...NEVER_OPENED, ".env"]) {
      expect(
        calls.filter((call) => call.path === path.join(home, never)),
        never,
      ).toEqual([]);
    }
    // Only chat files are looked at: the files beside them never are.
    for (const call of calls.filter((each) => each.method === "lstat")) {
      expect(call.path, call.path).toMatch(/[\\/]chats[\\/][0-9a-f-]{36}\.jsonl$/);
    }

    // A poll where nothing changed opens only the records.
    calls.length = 0;
    clock.advance(2_000);
    await adapter.poll();
    const again = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(again.every((file) => file.startsWith(path.join(home, "sessions")))).toBe(true);
  });

  test("lets no token, prompt, reply, thought or tool output out", async () => {
    const home = await makeQwenHome();
    const result = await adapterFor(home).poll();
    const said = JSON.stringify(result);
    expect(said).not.toContain(PRIVATE_TOKEN);
    expect(said).not.toContain(PRIVATE_WORDS);
    expect(said).not.toContain(PLACEHOLDER);
    expect(said).not.toContain(".sock");
  });

  test("leaves every file as it found it, and creates nothing", async () => {
    const home = await makeQwenHome();
    const before = await snapshotOf(home);
    const clock = handClock();
    const adapter = adapterFor(home, { now: clock.now });
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    // A session that goes on, and one that closes.
    await appendFile(
      path.join(home, CHATS, `${fixture.working.sessionId}.jsonl`),
      promptLine(NOW + 5_000, { sessionId: fixture.working.sessionId }),
    );
    const live = new Set(RUNNING_PIDS);
    live.delete(fixture.idle.pid);
    const after = adapterFor(home, { now: clock.now, isAlive: (pid) => live.has(pid) });
    await after.poll();
    const changed = await snapshotOf(home);
    await after.poll();
    expect(await snapshotOf(home)).toEqual(changed);
    expect(Object.keys(changed).sort()).toEqual(Object.keys(before).sort());
  });

  test("never follows a link at a record's or a chat file's name, and a pipe does not hold up the poll", async () => {
    // Windows keeps no named pipes among files, so there is no pipe there.
    const pipes = process.platform !== "win32";
    const home = await makeQwenHome();
    // A record that leads to a credential file, and a chat file that leads out of the folder.
    await symlink(path.join(home, "oauth_creds.json"), path.join(home, "sessions", "41007.json"));
    await writeFile(
      path.join(home, "sessions", "41008.json"),
      registryRecord({ pid: 41008, sessionId: sessionIdOf(8), kind: "tui" }),
    );
    const outside = path.join(await tempDir(), "elsewhere.jsonl");
    await writeFile(outside, promptLine(NOW - MINUTE, { sessionId: sessionIdOf(8) }));
    await symlink(outside, path.join(home, CHATS, `${sessionIdOf(8)}.jsonl`));
    if (pipes) execFileSync("mkfifo", [path.join(home, "sessions", "41009.json")]);
    const before = await snapshotOf(home);

    const { io, calls } = recordingIo();
    const started = Date.now();
    const { sessions } = await adapterFor(home, {
      io,
      isAlive: (pid) => RUNNING_PIDS.has(pid) || pid === 41008,
    }).poll();
    expect(Date.now() - started).toBeLessThan(3_000);

    // The session is listed with no chat file: a link is not one.
    expect(sessions.find((session) => session.id === `qwen-code:${sessionIdOf(8)}`)).toMatchObject({
      status: "idle",
    });
    expect(sessions.map((session) => session.pid)).not.toContain(41007);
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened).not.toContain(path.join(home, CHATS, `${sessionIdOf(8)}.jsonl`));
    expect(opened).not.toContain(outside);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_TOKEN);
    expect(await snapshotOf(home)).toEqual(before);
  }, 10_000);

  test("a folder that is not there is watched and empty, and left so", async () => {
    const parent = await tempDir();
    const home = path.join(parent, "qwen");
    const result = await adapterFor(home).poll();
    expect(result.health.state).toBe("ok");
    expect(result.sessions).toEqual([]);
    expect(await readdir(parent)).toEqual([]);
    await mkdir(home);
    await adapterFor(home).poll();
    expect(await readdir(home)).toEqual([]);
  });
});
