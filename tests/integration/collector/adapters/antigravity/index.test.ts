import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
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

import { describe, expect, test } from "vitest";

import {
  createAntigravityAdapter,
  type AntigravityAdapterOptions,
} from "@collector/adapters/antigravity/index";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  conversationId,
  databasePath,
  DAY,
  failedTurn,
  finishedTurn,
  MINUTE,
  NOW,
  SECOND,
  transcriptPath,
  workingTurn,
} from "@tests/fixtures/antigravity";
import { standInProcesses } from "@tests/support/adapters/antigravityAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

const WORKING = conversationId("a1");
const IDLE = conversationId("b2");
const FAILED = conversationId("c3");
const OLD = conversationId("d4");

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

/** Everything under a folder: each ordinary file's hash, size and modified time, each link's target and each other thing's kind. */
async function snapshotOf(root: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const target = path.join(dir, name);
      const relative = path.relative(root, target);
      const info = await lstat(target);
      if (info.isDirectory()) {
        found[relative] = "folder";
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

/** Writes a file and sets its modified time. */
async function put(file: string, content: string, mtimeMs: number) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await utimes(file, mtimeMs / 1000, mtimeMs / 1000);
}

/** An agy folder laid out as agy 1.3.1 lays out its own, with the files beside the conversations it keeps. */
async function makeAgyHome(): Promise<string> {
  const home = await tempDir();
  await put(
    transcriptPath(home, WORKING),
    workingTurn(0, NOW - 3 * MINUTE).join(""),
    NOW - 10 * SECOND,
  );
  await put(databasePath(home, WORKING), "SQLite format 3\u0000", NOW - 20 * SECOND);
  await put(databasePath(home, WORKING, true), "", NOW - 5 * SECOND);
  await put(
    transcriptPath(home, IDLE),
    finishedTurn(0, NOW - 20 * MINUTE).join(""),
    NOW - 19 * MINUTE,
  );
  await put(
    transcriptPath(home, FAILED),
    failedTurn(0, NOW - 40 * MINUTE).join(""),
    NOW - 39 * MINUTE,
  );
  await put(transcriptPath(home, OLD), finishedTurn(0, NOW - 2 * DAY).join(""), NOW - 2 * DAY);
  // The files agy keeps beside its conversations, which are never opened.
  await put(
    path.join(home, "brain", WORKING, ".system_generated", "logs", "transcript_full.jsonl"),
    "{}\n",
    NOW,
  );
  await put(path.join(home, "conversation_summaries.db"), "SQLite format 3\u0000", NOW);
  await put(path.join(home, "cli.log"), "a log line\n", NOW);
  await put(path.join(home, "installation_id"), "demo\n", NOW);
  await mkdir(path.join(home, "crashes"), { recursive: true });
  return home;
}

function adapterFor(home: string, options: AntigravityAdapterOptions = {}) {
  return createAntigravityAdapter({
    env: { AGENT_LOOKOUT_ANTIGRAVITY_HOME: home },
    homeDir: "/Users/example",
    now: () => NOW,
    platform: "darwin",
    processes: standInProcesses([{ startedAt: NOW - 60 * MINUTE }]).reader,
    ...options,
  });
}

const statuses = (sessions: { id: string; status: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id.split(":")[1], session.status]));

describe("the Antigravity CLI adapter, on a folder laid out as agy lays it out", () => {
  test("lists each conversation of the last day by its last step", async () => {
    const home = await makeAgyHome();
    const result = await adapterFor(home).poll();
    expect(result.health).toMatchObject({ id: "antigravity-cli", state: "ok" });
    expect(result.basis).toBe("files");
    expect(statuses(result.sessions)).toEqual({
      [WORKING]: "working",
      [IDLE]: "idle",
      [FAILED]: "failed",
    });
    expect(result.sessions.find((session) => session.id.endsWith(WORKING))).toMatchObject({
      startedAt: NOW - 3 * MINUTE,
      statusSince: NOW - 3 * MINUTE,
      lastWriteAt: NOW - 5 * SECOND,
    });
  });

  test("leaves every file as it found it, and creates nothing: no database is opened, so none gains a side file", async () => {
    const home = await makeAgyHome();
    const before = await snapshotOf(home);
    let at = NOW;
    const adapter = adapterFor(home, { now: () => at });
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      at += 2 * SECOND;
    }
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("opens only transcripts, and only those of the last day", async () => {
    const home = await makeAgyHome();
    const { io, calls } = recordingIo();
    await adapterFor(home, { io }).poll();
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.sort()).toEqual(
      [WORKING, IDLE, FAILED]
        .map((id) => path.join(home, "brain", id, ".system_generated", "logs", "transcript.jsonl"))
        .sort(),
    );
    // The databases are only looked at, for when agy last wrote.
    expect(calls).toContainEqual({
      method: "lstat",
      path: path.join(home, "conversations", `${WORKING}.db-wal`),
    });
    for (const call of calls) {
      expect(call.path).not.toMatch(
        /transcript_full|conversation_summaries|cli\.log|installation_id/,
      );
    }
  });

  test("a transcript that is a link or a pipe is not read, and does not hold up the poll", async () => {
    // Windows keeps no named pipes among files, so there is no pipe there.
    const pipes = process.platform !== "win32";
    const home = await makeAgyHome();
    const outside = await tempDir();
    const elsewhere = path.join(outside, "transcript.jsonl");
    await writeFile(elsewhere, workingTurn(0, NOW - MINUTE).join(""));
    const linked = conversationId("e5");
    const piped = conversationId("f6");
    await mkdir(path.dirname(transcriptPath(home, linked)), { recursive: true });
    await symlink(elsewhere, transcriptPath(home, linked));
    if (pipes) {
      await mkdir(path.dirname(transcriptPath(home, piped)), { recursive: true });
      // Opening a pipe for reading waits for a writer. Nobody will ever write to this one.
      execFileSync("mkfifo", [transcriptPath(home, piped)]);
    }
    const { io, calls } = recordingIo();
    const started = Date.now();
    const { sessions } = await adapterFor(home, { io }).poll();
    expect(Date.now() - started).toBeLessThan(3_000);
    const listed = sessions.map((session) => session.id);
    expect(listed).not.toContain(`antigravity-cli:${linked}`);
    expect(listed).not.toContain(`antigravity-cli:${piped}`);
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened).not.toContain(path.normalize(transcriptPath(home, linked)));
    expect(opened).not.toContain(path.normalize(transcriptPath(home, piped)));
  }, 10_000);

  test("reads only what agy appends, and a compacted transcript afresh", async () => {
    const home = await makeAgyHome();
    let at = NOW;
    const adapter = adapterFor(home, { now: () => at });
    await adapter.poll();

    await appendFile(transcriptPath(home, IDLE), workingTurn(4, NOW + SECOND).join(""));
    at += 2 * SECOND;
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({ [IDLE]: "working" });

    await writeFile(transcriptPath(home, IDLE), finishedTurn(0, NOW + 3 * SECOND).join(""));
    at += 8 * SECOND;
    expect(statuses((await adapter.poll()).sessions)).toMatchObject({ [IDLE]: "idle" });
  });
});

describe("finding the Antigravity CLI's folder", () => {
  test("with no ~/.gemini/antigravity-cli, it is not found, and no ps is run", async () => {
    const userHome = await tempDir();
    const processes = standInProcesses();
    const result = await createAntigravityAdapter({
      env: {},
      homeDir: userHome,
      now: () => NOW,
      processes: processes.reader,
    }).poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail:
        "The Antigravity CLI was not found: there is no ~/.gemini/antigravity-cli folder. Agent Lookout looks again every minute.",
    });
    expect(processes.asked()).toBe(0);
  });

  test("~/.gemini/antigravity-cli is read when nothing names another folder", async () => {
    const userHome = await tempDir();
    const home = path.join(userHome, ".gemini", "antigravity-cli");
    await put(transcriptPath(home, IDLE), finishedTurn(0, NOW - MINUTE).join(""), NOW - MINUTE);
    const result = await createAntigravityAdapter({
      env: {},
      homeDir: userHome,
      now: () => NOW,
      processes: standInProcesses().reader,
    }).poll();
    expect(result.health.detail).toContain("~/.gemini/antigravity-cli/brain");
    expect(statuses(result.sessions)).toEqual({ [IDLE]: "finished" });
  });

  test("an AGENT_LOOKOUT_ANTIGRAVITY_HOME with nothing in it is watched and empty", async () => {
    const empty = await tempDir();
    const before = await snapshotOf(empty);
    const result = await adapterFor(empty).poll();
    expect(result.health.state).toBe("ok");
    expect(result.sessions).toEqual([]);
    expect(await snapshotOf(empty)).toEqual(before);
  });
});

describe("the Antigravity IDE's and Antigravity 2.0's folders, beside the CLI's", () => {
  const IDE_NOTE =
    "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide. Agent Lookout reads only the Antigravity CLI so far, not the IDE.";
  const APP_NOTE =
    "A folder of Antigravity 2.0, or of an older Antigravity IDE, is here, ~/.gemini/antigravity. Agent Lookout does not read it yet.";
  const BOTH_NOTE =
    "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide, and so is one of Antigravity 2.0, or of an older Antigravity IDE, ~/.gemini/antigravity. Agent Lookout reads only the Antigravity CLI so far, not either of them.";
  const NOT_FOUND =
    "The Antigravity CLI was not found: there is no ~/.gemini/antigravity-cli folder. Agent Lookout looks again every minute.";

  /** A home folder of the test's own, with these folders in its `.gemini`, and with the CLI's holding one conversation when `cli` is true. */
  async function homeWith(names: string[], cli = false): Promise<string> {
    const userHome = await tempDir();
    await mkdir(path.join(userHome, ".gemini"), { recursive: true });
    for (const name of names) await mkdir(path.join(userHome, ".gemini", name));
    if (cli) {
      await put(
        transcriptPath(path.join(userHome, ".gemini", "antigravity-cli"), IDLE),
        finishedTurn(0, NOW - MINUTE).join(""),
        NOW - MINUTE,
      );
    }
    return userHome;
  }

  /** The adapter with nothing naming another folder, on this home folder. */
  function adapterIn(userHome: string, options: AntigravityAdapterOptions = {}) {
    return createAntigravityAdapter({
      env: {},
      homeDir: userHome,
      now: () => NOW,
      platform: "darwin",
      processes: standInProcesses().reader,
      ...options,
    });
  }

  test("with neither there, nothing is said of them, whether the CLI is found or not", async () => {
    const without = await adapterIn(await homeWith([])).poll();
    expect(without.health.detail).toBe(NOT_FOUND);
    const found = await adapterIn(await homeWith([], true)).poll();
    expect(found.health.state).toBe("ok");
    expect(found.health.detail).not.toMatch(/Antigravity IDE|Antigravity 2\.0/);
  });

  test("with the IDE's folder alone and no CLI, the not-found text says it is there and not read", async () => {
    const result = await adapterIn(await homeWith(["antigravity-ide"])).poll();
    expect(result.health).toMatchObject({
      state: "unavailable",
      detail: `${NOT_FOUND} ${IDE_NOTE}`,
    });
  });

  test("with Antigravity 2.0's folder alone and the CLI found, its sessions are listed and the note comes last", async () => {
    const result = await adapterIn(await homeWith(["antigravity"], true)).poll();
    expect(result.health.state).toBe("ok");
    expect(result.health.detail?.endsWith(` ${APP_NOTE}`)).toBe(true);
    expect(statuses(result.sessions)).toEqual({ [IDLE]: "finished" });
  });

  test("with both there, both are named, and each is only looked at: nothing in them is opened, listed or changed", async () => {
    const userHome = await homeWith(["antigravity-ide", "antigravity"], true);
    const ide = path.join(userHome, ".gemini", "antigravity-ide");
    const app = path.join(userHome, ".gemini", "antigravity");
    await put(transcriptPath(ide, WORKING), workingTurn(0, NOW - MINUTE).join(""), NOW - SECOND);
    await put(path.join(app, "settings.json"), "{}", NOW);
    const before = await snapshotOf(path.join(userHome, ".gemini"));
    const { io, calls } = recordingIo();
    const result = await adapterIn(userHome, { io }).poll();
    expect(result.health.detail?.endsWith(` ${BOTH_NOTE}`)).toBe(true);
    expect(statuses(result.sessions)).toEqual({ [IDLE]: "finished" });
    const inEither = (target: string) =>
      [ide, app].some((folder) => target === folder || target.startsWith(folder + path.sep));
    expect(calls.filter((call) => inEither(call.path))).toEqual([
      { method: "lstat", path: ide },
      { method: "lstat", path: app },
    ]);
    expect(await snapshotOf(path.join(userHome, ".gemini"))).toEqual(before);
  });

  test("a link in either's place counts as there and is not followed, even one that leads nowhere", async () => {
    const userHome = await homeWith([]);
    const outside = await tempDir();
    await put(path.join(outside, "settings.json"), "{}", NOW);
    const ide = path.join(userHome, ".gemini", "antigravity-ide");
    const app = path.join(userHome, ".gemini", "antigravity");
    // A junction on Windows, which needs no special right there, and a link anywhere else.
    await symlink(outside, ide, "junction");
    await symlink(path.join(userHome, "nowhere"), app);
    const { io, calls } = recordingIo();
    const result = await adapterIn(userHome, { io }).poll();
    expect(result.health.detail).toBe(`${NOT_FOUND} ${BOTH_NOTE}`);
    expect(calls.filter((call) => call.path.startsWith(outside))).toEqual([]);
    expect(
      calls.filter((call) => call.path === ide || call.path.startsWith(ide + path.sep)),
    ).toEqual([{ method: "lstat", path: ide }]);
  });

  test("with AGENT_LOOKOUT_ANTIGRAVITY_HOME set, they are looked for beside that folder, never under the home folder", async () => {
    const userHome = await homeWith(["antigravity-ide", "antigravity"]);
    const elsewhere = await tempDir();
    const cli = path.join(elsewhere, "agy");
    const { io, calls } = recordingIo();
    const options = { homeDir: userHome, io };
    const none = await adapterFor(cli, options).poll();
    expect(none.health.state).toBe("ok");
    expect(none.health.detail).not.toMatch(/Antigravity IDE|Antigravity 2\.0/);

    await mkdir(path.join(elsewhere, "antigravity-ide"));
    const beside = await adapterFor(cli, options).poll();
    expect(beside.health.detail).toContain(
      `The Antigravity IDE's folder is here, ${path.join(elsewhere, "antigravity-ide")}. Agent Lookout reads only the Antigravity CLI so far, not the IDE.`,
    );
    expect(calls.filter((call) => call.path.startsWith(userHome))).toEqual([]);
  });
});
