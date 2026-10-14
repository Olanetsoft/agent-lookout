import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { describe, expect, onTestFinished, test } from "vitest";

import {
  createMistralVibeAdapter,
  type MistralVibeAdapterOptions,
} from "@collector/adapters/mistral-vibe/index";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  delta,
  document,
  HOME,
  HOUR,
  leaseFile,
  MINUTE,
  NOW,
  otherRecord,
  PRIVATE_WORDS,
  sessionId,
  storeFiles,
  SUBAGENT_ID,
  journalPath,
  type StateFields,
} from "@tests/fixtures/mistralVibe";
import { tempDir } from "@tests/support/node/tempFiles";

// The Mistral Vibe adapter on a real folder laid out as Vibe 2.26.1's source
// lays out its own, with real leases: one held by this test's own process,
// one left behind by a process that has ended. Every file is written from the
// invented fixtures.

const WORKING = sessionId("a1");
const LEFT_BEHIND = sessionId("b1");
const CLOSED = sessionId("c1");
const FORK = sessionId("d1");

const running = (id: string, title: string): StateFields => ({
  id,
  status: "running",
  title,
  createdAt: NOW - HOUR,
  updatedAt: NOW - 5 * MINUTE,
  turn: { status: "in_progress", startedAt: NOW - 5 * MINUTE },
});

const idle = (id: string, title: string): StateFields => ({
  id,
  status: "idle",
  title,
  createdAt: NOW - HOUR,
  updatedAt: NOW - 2 * MINUTE,
  turn: { status: "completed", startedAt: NOW - 5 * MINUTE, completedAt: NOW - 2 * MINUTE },
});

/** A pid no process has any more. */
const endedPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

/** Writes files by their path relative to a folder. */
async function writeAll(dir: string, files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(dir, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

/**
 * A session folder as Vibe leaves one: a working session this process holds,
 * one whose program crashed, one closed, a fork, a subagent, the lease Vibe
 * takes to clear old output, Vibe's own files in the folder of leases and of
 * stores, and an older engine's session folder.
 */
async function makeSessionDir(): Promise<string> {
  const dir = await tempDir();
  const ended = endedPid();
  await writeAll(dir, {
    ...storeFiles({
      id: WORKING,
      state: idle(WORKING, "demo-project refactor"),
      journal: [
        otherRecord("command_reserved", 5),
        otherRecord("core_input", 6),
        delta(7, running(WORKING, "demo-project refactor")),
        otherRecord("action_intent", 8),
      ],
    }),
    ...storeFiles({ id: LEFT_BEHIND, state: running(LEFT_BEHIND, "demo-project tests") }),
    ...storeFiles({ id: CLOSED, state: idle(CLOSED, "demo-project notes") }),
    ...storeFiles({ id: FORK, kind: "fork", state: idle(FORK, "demo-project fork") }),
    ...storeFiles({ id: SUBAGENT_ID, kind: "subagent", state: running(SUBAGENT_ID, "helper") }),
    [`active/${WORKING}.lock`]: "",
    [`active/${WORKING}.lock.json`]: leaseFile(WORKING, process.pid),
    [`active/${LEFT_BEHIND}.lock`]: "",
    [`active/${LEFT_BEHIND}.lock.json`]: leaseFile(LEFT_BEHIND, ended),
    [`active/${FORK}.lock`]: "",
    [`active/${FORK}.lock.json`]: leaseFile(FORK, process.pid),
    [`active/${SUBAGENT_ID}.lock`]: "",
    [`active/${SUBAGENT_ID}.lock.json`]: leaseFile(SUBAGENT_ID, process.pid),
    "active/process-output-cleanup.lock": "",
    "active/process-output-cleanup.lock.json": leaseFile("process-output-cleanup", process.pid),
    "active/.registry": "",
    "active/.watch-0123456789abcdef0123456789abcdef": "",
    "unified/.session-index.json": document({ sessions: [PRIVATE_WORDS] }),
    "session_20261001_090000_0a1b2c3d/meta.json": document({ title: PRIVATE_WORDS }),
    "session_20261001_090000_0a1b2c3d/messages.jsonl": `${document({ content: PRIVATE_WORDS })}`,
    ".session_index.json": document({ sessions: [PRIVATE_WORDS] }),
  });
  return dir;
}

/** An adapter pointed at this session folder, on the real clock: the files are written now. */
function adapterFor(dir: string, options: MistralVibeAdapterOptions = {}) {
  return createMistralVibeAdapter({
    env: { AGENT_LOOKOUT_VIBE_SESSION_DIR: dir },
    homeDir: HOME,
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
 * Everything under a folder: each ordinary file's hash, size, modified time
 * and identity, each link's target and each other thing's kind.
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
        found[relative] = `${hash} ${info.size} ${info.mtimeMs} ${info.ino}`;
      } else {
        found[relative] = `other ${info.mtimeMs}`;
      }
    }
  }
  await walk(root);
  return found;
}

const statusById = (sessions: { id: string; status: string; name: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id, [session.status, session.name]]));

describe("the Mistral Vibe adapter, on a folder laid out as Vibe lays it out", () => {
  test("lists each session with its status and name, leaves out the subagent, and shows the fork", async () => {
    const dir = await makeSessionDir();
    const result = await adapterFor(dir).poll();
    expect(result.health.state).toBe("ok");
    expect(result.basis).toBe("files");
    expect(statusById(result.sessions)).toEqual({
      [`mistral-vibe:${WORKING}`]: ["working", "demo-project refactor"],
      [`mistral-vibe:${LEFT_BEHIND}`]: ["finished", "demo-project tests"],
      [`mistral-vibe:${CLOSED}`]: ["finished", "demo-project notes"],
      [`mistral-vibe:${FORK}`]: ["idle", "demo-project fork"],
    });
    for (const session of result.sessions) {
      expect(session.cwd).toBe("/Users/example/code/demo");
      expect(session.lastWriteAt).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
  });

  test("leaves every file as it found it, and creates nothing", async () => {
    const dir = await makeSessionDir();
    const before = await snapshotOf(dir);
    const adapter = adapterFor(dir);
    for (let poll = 0; poll < 3; poll += 1) await adapter.poll();
    expect(await snapshotOf(dir)).toEqual(before);
  });

  test("opens only what it reads, and never a lock, the folder's own lock, or the conversation", async () => {
    const dir = await makeSessionDir();
    const { io, calls } = recordingIo();
    const adapter = adapterFor(dir, { io });
    await adapter.poll();

    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    const allowed =
      /[\\/]active[\\/][^\\/]+\.lock\.json$|[\\/]unified[\\/][^\\/]+[\\/](CURRENT|generations[\\/]\d{16}[\\/](manifest|projection-state|runtime-state)\.json|journal[\\/]\d{16}\.jsonl)$/;
    expect(opened.length).toBeGreaterThan(0);
    for (const file of opened) expect(allowed.test(file), file).toBe(true);

    // In the folder of leases, a lock is only listed, and Vibe's own files are not touched.
    const active = path.join(dir, "active");
    const inActive = calls.filter((call) => call.path.startsWith(`${active}${path.sep}`));
    for (const call of inActive) expect(call.path.endsWith(".lock.json"), call.path).toBe(true);
    for (const never of [
      ".registry",
      ".watch-",
      "process-output-cleanup",
      SUBAGENT_ID,
      "checkpoint.json",
      "chunks",
      "meta.json",
      "messages.jsonl",
      "session-index",
      ".session_index",
    ]) {
      expect(
        calls.filter((call) => call.path.includes(never)),
        never,
      ).toEqual([]);
    }

    // A poll where nothing changed opens nothing.
    calls.length = 0;
    await adapter.poll();
    expect(calls.filter((call) => call.method === "openRegular")).toEqual([]);
  });

  test("follows the journal as Vibe appends to it", async () => {
    const dir = await makeSessionDir();
    const adapter = adapterFor(dir);
    const status = async () =>
      (await adapter.poll()).sessions.find((session) => session.id === `mistral-vibe:${WORKING}`);
    expect((await status())?.status).toBe("working");

    const segment = path.join(dir, ...journalPath(WORKING).split("/"));
    const next = delta(9, idle(WORKING, "demo-project refactor done"));
    // Half a line first, as a write still going on leaves it.
    await appendFile(segment, next.slice(0, 50));
    expect((await status())?.status).toBe("working");
    await appendFile(segment, next.slice(50));
    expect(await status()).toMatchObject({ status: "idle", name: "demo-project refactor done" });
  });

  test("a session's store that is a link is not read, even while its lease is held", async () => {
    const dir = await makeSessionDir();
    const elsewhere = await tempDir();
    const LINKED = sessionId("e1");
    await writeAll(
      elsewhere,
      storeFiles({ id: LINKED, state: running(LINKED, "demo-project linked") }),
    );
    const link = path.join(dir, "unified", LINKED);
    await symlink(path.join(elsewhere, "unified", LINKED), link);
    await writeAll(dir, {
      [`active/${LINKED}.lock`]: "",
      [`active/${LINKED}.lock.json`]: leaseFile(LINKED, process.pid),
    });

    const { io, calls } = recordingIo();
    const { sessions } = await adapterFor(dir, { io }).poll();
    expect(sessions.map((session) => session.id)).not.toContain(`mistral-vibe:${LINKED}`);
    expect(sessions.map((session) => session.id)).toContain(`mistral-vibe:${WORKING}`);
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(
      opened.filter((file) => file.startsWith(`${link}${path.sep}`) || file.startsWith(elsewhere)),
    ).toEqual([]);
  });

  test("a unified/ that is a link is not read, even while a session's lease is held", async () => {
    const dir = await tempDir();
    const elsewhere = await tempDir();
    await writeAll(elsewhere, {
      ...storeFiles({ id: WORKING, state: running(WORKING, "demo-project refactor") }),
      ...storeFiles({ id: CLOSED, state: idle(CLOSED, "demo-project notes") }),
    });
    await symlink(path.join(elsewhere, "unified"), path.join(dir, "unified"));
    await writeAll(dir, {
      [`active/${WORKING}.lock`]: "",
      [`active/${WORKING}.lock.json`]: leaseFile(WORKING, process.pid),
    });

    const { io, calls } = recordingIo();
    const adapter = adapterFor(dir, { io });
    for (let poll = 0; poll < 2; poll += 1) {
      const { health, sessions } = await adapter.poll();
      expect(health.state).toBe("ok");
      expect(sessions).toEqual([]);
    }
    const link = path.join(dir, "unified");
    expect(
      calls.filter(
        (call) => call.path.startsWith(`${link}${path.sep}`) || call.path.startsWith(elsewhere),
      ),
    ).toEqual([]);
  });

  test("says Vibe was not found when there is no session folder, and names none it made", async () => {
    const dir = await tempDir();
    const adapter = createMistralVibeAdapter({ env: { VIBE_HOME: dir }, homeDir: HOME });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(sessions).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});

/** Whether a program runs here. */
function runs(program: string): boolean {
  try {
    execFileSync(program, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// A file lock as Vibe takes one is a POSIX flock, taken here through Python as
// Vibe takes it. Windows locks a lease another way, with no command to take it.
describe.skipIf(process.platform === "win32" || !runs("python3"))(
  "while a Vibe program holds a session's lock",
  () => {
    test("the adapter reads the session as held, without touching the lock", async () => {
      const dir = await makeSessionDir();
      const lock = path.join(dir, "active", `${WORKING}.lock`);
      const holder = spawn(
        "python3",
        [
          "-c",
          [
            "import fcntl, sys",
            "f = open(sys.argv[1], 'a+b')",
            "fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)",
            "print('LOCKED', flush=True)",
            "sys.stdin.readline()",
          ].join("\n"),
          lock,
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      );
      const exited = new Promise((resolve) => holder.once("exit", resolve));
      onTestFinished(async () => {
        holder.stdin.end();
        await exited;
      });
      const lines = readline.createInterface({ input: holder.stdout })[Symbol.asyncIterator]();
      expect((await lines.next()).value).toBe("LOCKED");

      const { io, calls } = recordingIo();
      const { sessions } = await adapterFor(dir, { io }).poll();
      expect(sessions.find((session) => session.id === `mistral-vibe:${WORKING}`)?.status).toBe(
        "working",
      );
      expect(calls.filter((call) => call.path === lock)).toEqual([]);
    });
  },
);
