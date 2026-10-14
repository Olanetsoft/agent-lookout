import { createHash } from "node:crypto";
import { appendFile, cp, lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { createGeminiCliAdapter } from "@collector/adapters/gemini-cli/index";
import { geminiCliSessionId } from "@collector/adapters/gemini-cli/toSession";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import {
  geminiLine,
  HOME,
  ids,
  messageIdOf,
  NOW,
  PRIVATE_WORDS,
  PROJECT,
  updatedLine,
} from "@tests/fixtures/gemini-cli/geminiCli";
import { handClock } from "@tests/support/adapters/geminiCliAdapter";
import { tempDir } from "@tests/support/node/tempFiles";

/** The fixture folder laid out as Gemini CLI lays out its own. Tests read it, and change only a copy. */
const FIXTURE_HOME = fileURLToPath(
  new URL("../../../../fixtures/gemini-cli/home", import.meta.url),
);

/** A copy of the fixture folder, with a `.env` beside it: git keeps no such file in the fixture. */
async function copyOfHome(): Promise<string> {
  const home = await tempDir();
  await cp(FIXTURE_HOME, home, { recursive: true });
  await writeFile(path.join(home, ".env"), "placeholder: must never be opened\n");
  return home;
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
 * Everything under a folder: each ordinary file's hash, size and modified time,
 * each link's target and each other thing's kind.
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

function adapterFor(home: string, io: ReadOnlyIo = nodeIo, now = () => NOW) {
  return createGeminiCliAdapter({
    env: { AGENT_LOOKOUT_GEMINI_CLI_HOME: home },
    homeDir: HOME,
    now,
    io,
  });
}

describe("the Gemini CLI adapter, on a folder laid out as Gemini CLI lays it out", () => {
  test("lists the working and the idle session, with their names and folder, and nothing private", async () => {
    const home = await copyOfHome();
    const result = await adapterFor(home).poll();
    expect(result.health).toMatchObject({ id: "gemini-cli", state: "ok" });
    const sessions = [...result.sessions].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(sessions).toEqual([
      expect.objectContaining({
        id: geminiCliSessionId("demo-project", ids.working),
        name: "demo-project",
        cwd: PROJECT,
        status: "working",
      }),
      expect.objectContaining({
        id: geminiCliSessionId("demo-project", ids.idle),
        name: "Tidy the demo readme",
        cwd: PROJECT,
        status: "idle",
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_WORDS);
  });

  test("opens only each project's .project_root and session files, and lists only tmp/ and chats/", async () => {
    const home = await copyOfHome();
    const { io, calls } = recordingIo();
    const clock = handClock(NOW);
    const adapter = adapterFor(home, io, clock.now);
    await adapter.poll();

    const project = path.join(home, "tmp", "demo-project");
    const chats = path.join(project, "chats");
    const opened = calls.filter((call) => call.method === "openRegular").map((call) => call.path);
    expect(opened.sort()).toEqual(
      [
        path.join(project, ".project_root"),
        path.join(chats, "session-2026-10-01T11-30-00000000.jsonl"),
        path.join(chats, "session-2026-10-01T11-50-00000000.jsonl"),
      ].sort(),
    );
    const listed = calls.filter((call) => call.method === "readdir").map((call) => call.path);
    expect(listed.sort()).toEqual([path.join(home, "tmp"), chats].sort());

    // Looked at, and never opened: the session file of the format before 0.39.
    const older = path.join(chats, "session-2026-09-20T08-00-00000000.json");
    expect(calls.filter((call) => call.path === older)).toEqual([{ method: "lstat", path: older }]);
    // Gemini CLI's own folders are looked at for a .project_root alone, and passed over.
    for (const own of ["bin", "background-processes"]) {
      const dir = path.join(home, "tmp", own);
      expect(
        calls.filter((call) => call.path.startsWith(dir)),
        own,
      ).toEqual([
        { method: "lstat", path: dir },
        { method: "lstat", path: path.join(dir, ".project_root") },
      ]);
    }
    for (const never of [
      ".env",
      "oauth_creds.json",
      "google_accounts.json",
      "settings.json",
      "installation_id",
      "mcp-oauth-tokens.json",
      "a2a-oauth-tokens.json",
      "gemini-credentials.json",
      "trustedFolders.json",
      "projects.json",
      `${path.sep}history`,
      "logs.json",
      "shell_history",
      "checkpoint",
      "tool-outputs",
      `${path.sep}logs${path.sep}`,
      `${path.sep}memory`,
      ".tmp-123",
      // The subagent's folder of the working session.
      path.join(chats, ids.working),
      "antigravity",
    ]) {
      expect(
        calls.filter((call) => call.path.includes(never)),
        never,
      ).toEqual([]);
    }

    // A poll where nothing changed opens nothing.
    calls.length = 0;
    clock.advance(2_000);
    await adapter.poll();
    expect(calls.filter((call) => call.method === "openRegular")).toEqual([]);
  });

  test("leaves every file as it found it, and creates nothing", async () => {
    const home = await copyOfHome();
    const before = await snapshotOf(home);
    const clock = handClock(NOW);
    const adapter = adapterFor(home, nodeIo, clock.now);
    for (let poll = 0; poll < 3; poll += 1) {
      await adapter.poll();
      clock.advance(2_000);
    }
    expect(await snapshotOf(home)).toEqual(before);
  });

  test("reads what Gemini CLI adds to a session file as it is added", async () => {
    const home = await copyOfHome();
    const clock = handClock(NOW);
    const adapter = adapterFor(home, nodeIo, clock.now);
    const working = () => geminiCliSessionId("demo-project", ids.working);
    const first = await adapter.poll();
    expect(first.sessions.find((session) => session.id === working())?.status).toBe("working");

    const file = path.join(
      home,
      "tmp",
      "demo-project",
      "chats",
      "session-2026-10-01T11-50-00000000.jsonl",
    );
    await appendFile(file, `${geminiLine(messageIdOf("02"), NOW)}\n${updatedLine(NOW)}\n`);
    clock.advance(2_000);
    const next = await adapter.poll();
    expect(next.sessions.find((session) => session.id === working())).toMatchObject({
      status: "idle",
      statusSince: NOW,
    });
  });
});
