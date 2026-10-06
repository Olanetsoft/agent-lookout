import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { createEventStore } from "@collector/eventStore";
import { nodeIo, type ReadOnlyIo } from "@collector/files/readOnlyIo";
import { createHistoryStore } from "@collector/historyStore";
import { createPoller } from "@collector/poller";
import type { Session } from "@core/sessions/session";
import { ids, pids, registryFile, registryFiles } from "@tests/fixtures/claudeCode";
import {
  prompt,
  toolUse,
  toolUseId,
  transcript,
  waitingToRun,
} from "@tests/fixtures/claudeTranscript";
import { adapterFor, BIN, watching } from "@tests/support/adapters/claudeCodeAdapter";
import { makeClaudeHome, tempDir } from "@tests/support/node/tempFiles";

// The Claude Code adapter reading what waiting sessions ask from real
// transcripts, in a Claude Code folder of the test's own.

/** Writes a transcript into `projects/<folder>` of a Claude Code folder. */
async function writeTranscript(home: string, folder: string, sessionId: string, content: string) {
  const dir = path.join(home, "projects", folder);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  await writeFile(file, content);
  return file;
}

/** A session that put two questions to the person. */
const askedTwice = transcript([
  prompt("Set up the database"),
  toolUse(toolUseId(), "AskUserQuestion", {
    questions: [
      { question: "Which database should we use?", header: "Database", options: [] },
      { question: "Should it run in a container?", header: "Container", options: [] },
    ],
  }),
]);

/** Every file the reader opens, lists or looks at, through the real file system. */
function watchedIo() {
  const touched: string[] = [];
  const io: ReadOnlyIo = {
    readdir: (dir) => (touched.push(dir), nodeIo.readdir(dir)),
    stat: (target) => (touched.push(target), nodeIo.stat(target)),
    lstat: (target) => (touched.push(target), nodeIo.lstat(target)),
    openRegular: (file) => (touched.push(file), nodeIo.openRegular(file)),
  };
  return { io, touched };
}

const byName = (sessions: readonly Session[], name: string) =>
  sessions.find((session) => session.name === name);

describe("what a waiting Claude Code session is asking", () => {
  test("is read from its transcript in the folder named for its own, or in any other folder", async () => {
    const home = await makeClaudeHome(registryFiles);
    // The permission session's transcript is where Claude Code names it for its folder.
    await writeTranscript(
      home,
      "-Users-example-code-demo-api",
      ids.permission,
      waitingToRun("npm test"),
    );
    // The question session's is in a folder of another name, as after a move.
    await writeTranscript(home, "-Users-example-code-somewhere-else", ids.question, askedTwice);
    // A session that is not waiting has a transcript that says it would run something.
    await writeTranscript(home, "-Users-example-code-demo", ids.busy, waitingToRun("rm -rf build"));

    const { health, sessions } = await adapterFor(home).poll();
    expect(health.watching).toEqual(
      watching(`${home}/sessions`, "every 2 seconds", "every 30 seconds"),
    );
    expect(byName(sessions, "demo-api")?.waitingText).toBe("Run: npm test");
    expect(byName(sessions, "demo-docs")?.waitingText).toBe(
      "Which database should we use? (+1 more)",
    );
    // Only a waiting session is read, and one with no transcript has no text.
    for (const name of ["demo-project", "demo-site", "nightly-report"]) {
      expect(byName(sessions, name), name).toBeDefined();
      expect(byName(sessions, name), name).not.toHaveProperty("waitingText");
    }
  });

  test("is read from the end of a transcript of many megabytes", async () => {
    const home = await makeClaudeHome(registryFiles);
    const early = transcript(
      Array.from({ length: 4_000 }, (_, index) =>
        prompt(`An early prompt, number ${index}, ${"padded ".repeat(100)}`),
      ),
    );
    expect(early.length).toBeGreaterThan(2 * 1024 * 1024);
    await writeTranscript(
      home,
      "-Users-example-code-demo-api",
      ids.permission,
      early + waitingToRun("npm run build"),
    );
    const { sessions } = await adapterFor(home).poll();
    expect(byName(sessions, "demo-api")?.waitingText).toBe("Run: npm run build");
  });

  test("is not read through a link, in the folder named for the session's or in any other", async () => {
    const home = await makeClaudeHome(registryFiles);
    const elsewhere = await tempDir();
    const real = path.join(elsewhere, "transcript.jsonl");
    await writeFile(real, waitingToRun("npm test"));
    const named = path.join(home, "projects", "-Users-example-code-demo-api");
    await mkdir(named, { recursive: true });
    await symlink(real, path.join(named, `${ids.permission}.jsonl`));
    const other = path.join(home, "projects", "-Users-example-code-other");
    await mkdir(other, { recursive: true });
    await symlink(real, path.join(other, `${ids.question}.jsonl`));

    const { sessions } = await adapterFor(home).poll();
    expect(byName(sessions, "demo-api")?.status).toBe("needs-you");
    expect(byName(sessions, "demo-api")).not.toHaveProperty("waitingText");
    expect(byName(sessions, "demo-docs")).not.toHaveProperty("waitingText");
  });

  test("goes when the wait ends", async () => {
    const home = await makeClaudeHome(registryFiles);
    await writeTranscript(
      home,
      "-Users-example-code-demo-api",
      ids.permission,
      waitingToRun("npm test"),
    );
    const adapter = adapterFor(home);
    expect(byName((await adapter.poll()).sessions, "demo-api")?.waitingText).toBe("Run: npm test");

    await writeFile(
      path.join(home, "sessions", `${pids.permission}.json`),
      registryFile({
        pid: pids.permission,
        sessionId: ids.permission,
        cwd: "/Users/example/code/demo-api",
        name: "demo-api",
        status: "busy",
      }),
    );
    const after = byName((await adapter.poll()).sessions, "demo-api");
    expect(after?.status).toBe("working");
    expect(after).not.toHaveProperty("waitingText");
  });

  test("is never read with AGENT_LOOKOUT_WAITING_TEXT=off, and the source says so", async () => {
    const home = await makeClaudeHome(registryFiles);
    await writeTranscript(
      home,
      "-Users-example-code-demo-api",
      ids.permission,
      waitingToRun("npm test"),
    );
    const { io, touched } = watchedIo();

    const off = adapterFor(home, {
      env: {
        AGENT_LOOKOUT_CLAUDE_HOME: home,
        AGENT_LOOKOUT_CLAUDE_BIN: BIN,
        AGENT_LOOKOUT_WAITING_TEXT: "off",
      },
      transcriptIo: io,
    });
    const { health, sessions } = await off.poll();
    expect(byName(sessions, "demo-api")?.status).toBe("needs-you");
    expect(sessions.some((session) => "waitingText" in session)).toBe(false);
    expect(touched).toEqual([]);
    expect(health.watching).toEqual(
      watching(`${home}/sessions`, "every 2 seconds", "every 30 seconds", undefined, "Off"),
    );

    // The same folder with the setting left alone is read, through the same files.
    const on = adapterFor(home, { transcriptIo: io });
    expect(byName((await on.poll()).sessions, "demo-api")?.waitingText).toBe("Run: npm test");
    expect(touched.length).toBeGreaterThan(0);
  });

  test("is in the snapshot while the wait goes on, and in no event recorded for it", async () => {
    // Session demo-site starts idle, and later waits.
    const home = await makeClaudeHome(registryFiles);
    await writeTranscript(
      home,
      "-Users-example-code-demo-site",
      ids.idle,
      waitingToRun("npm run deploy"),
    );
    const events = createEventStore();
    const history = createHistoryStore();
    const poller = createPoller({ adapters: [adapterFor(home)], events, history });
    await poller.pollOnce();

    await writeFile(
      path.join(home, "sessions", `${pids.idle}.json`),
      registryFile({
        pid: pids.idle,
        sessionId: ids.idle,
        cwd: "/Users/example/code/demo-site",
        name: "demo-site",
        status: "waiting",
        waitingFor: "permission prompt",
        statusUpdatedAt: 1_700_000_090_000,
      }),
    );
    const snapshot = await poller.pollOnce();
    expect(byName(snapshot.sessions, "demo-site")?.waitingText).toBe("Run: npm run deploy");

    const recorded = events.list();
    expect(recorded).toContainEqual(
      expect.objectContaining({
        sessionId: `claude-code:${ids.idle}`,
        kind: "status-changed",
        to: "needs-you",
      }),
    );
    expect(JSON.stringify(recorded)).not.toContain("npm run deploy");
    expect(JSON.stringify(history.list(Infinity, Date.now()))).not.toContain("npm run deploy");
  });
});
