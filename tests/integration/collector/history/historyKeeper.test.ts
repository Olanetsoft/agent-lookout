import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, onTestFinished, test } from "vitest";

import { createCollector } from "@collector/collector";
import { encodeRecord, historyFileName, dayOf } from "@collector/history/historyFormat";
import { createHistoryKeeper } from "@collector/history/historyKeeper";
import type { HistoryPoint, SessionEvent } from "@core/sessions/session";
import { ids, pids, registryFile, registryFiles } from "@tests/fixtures/claudeCode";
import { waitingToRun } from "@tests/fixtures/claudeTranscript";
import { adapterFor, fails } from "@tests/support/adapters/claudeCodeAdapter";
import { fakeSystemNotifier } from "@tests/support/channels/systemNotifier";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

const LIMITS = { events: 1_000, points: 10_800 };

/** One moment for the whole file, so no test sees a UTC day end halfway through. */
const NOW = Date.now();

function point(at: number, working = 1): HistoryPoint {
  return { at, needsYou: 0, working, idle: 0, total: working };
}

function event(at: number): SessionEvent {
  return {
    id: `status-files:demo@${at}:status-changed`,
    at,
    sessionId: "status-files:demo",
    sessionName: "demo-project",
    kind: "status-changed",
    from: "working",
    to: "needs-you",
    severity: "warning",
  };
}

/** A keeper on a real folder, writing only when told to. */
function keeperIn(dir: string, now: () => number = () => NOW, more = {}) {
  return createHistoryKeeper({
    dir,
    folder: dir,
    now,
    flushIntervalMs: 1_000_000_000,
    ...more,
  });
}

const modeOf = async (target: string) => (await stat(target)).mode & 0o777;

describe("on disk", () => {
  test("the folder is made with mode 700 and each file with mode 600", async () => {
    const dir = path.join(await tempDir(), "kept", "history");
    const keeper = keeperIn(dir);
    await keeper.restore(LIMITS);
    keeper.start();
    keeper.addPoint(point(NOW));
    await keeper.flush();
    keeper.stop();

    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(path.dirname(dir))).toBe(0o700);
    const names = await readdir(dir);
    expect(names).toEqual([historyFileName(dayOf(NOW))]);
    expect(await modeOf(path.join(dir, names[0] as string))).toBe(0o600);
  });

  test("what one run wrote, the next reads back: its events, its points and where it began", async () => {
    const dir = await tempDir();
    const start = NOW - 60_000;
    let now = start;
    const first = keeperIn(dir, () => now);
    await first.restore(LIMITS);
    first.start();
    now += 2_000;
    first.addPoint(point(now));
    first.addEvents([event(now)]);
    await first.flush();
    now += 2_000;
    // Added just before it stops, and written as it stops.
    first.addPoint(point(now, 2));
    first.stop();

    const second = keeperIn(dir, () => now + 30_000);
    const restored = await second.restore(LIMITS);
    expect(restored.events).toEqual([event(start + 2_000)]);
    expect(restored.points).toEqual([point(start + 2_000), point(start + 4_000, 2)]);
    expect(second.since()).toEqual({ at: start, by: "started" });
    expect(second.status()).toMatchObject({ where: "disk", folder: dir });
    expect(second.status().bytes).toBeGreaterThan(0);
  });

  test("a link named as a history file is not read, and not written through: the day goes on in its next file", async () => {
    const dir = await tempDir();
    const elsewhere = path.join(await tempDir(), "elsewhere.jsonl");
    const theirs = encodeRecord({ kind: "point", point: point(NOW - 1_000) });
    await writeFile(elsewhere, theirs);
    const today = historyFileName(dayOf(NOW));
    await symlink(elsewhere, path.join(dir, today));

    const keeper = keeperIn(dir);
    expect((await keeper.restore(LIMITS)).points).toEqual([]);
    keeper.start();
    keeper.addPoint(point(NOW));
    await keeper.flush();
    keeper.stop();

    expect(await readFile(elsewhere, "utf8")).toBe(theirs);
    const next = historyFileName(dayOf(NOW), 2);
    expect((await readFile(path.join(dir, next), "utf8")).split("\n")[0]).toMatch(/^\{"start":/);
  });

  test("a folder where a history file should be is passed over", async () => {
    const dir = await tempDir();
    const today = historyFileName(dayOf(NOW));
    await mkdir(path.join(dir, today));
    const keeper = keeperIn(dir);
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    keeper.stop();
    expect((await readdir(dir)).sort()).toEqual([today, historyFileName(dayOf(NOW), 2)].sort());
  });

  test("a file larger than a history file may grow is not read", async () => {
    const dir = await tempDir();
    const name = historyFileName(dayOf(NOW - 86_400_000));
    const line = encodeRecord({ kind: "point", point: point(NOW - 86_400_000) });
    await writeFile(
      path.join(dir, name),
      line.repeat(Math.ceil((2.2 * 1024 * 1024) / line.length)),
    );
    const keeper = keeperIn(dir);
    expect((await keeper.restore(LIMITS)).points).toEqual([]);
  });

  test("a corrupt line, and a last line cut short, are passed over", async () => {
    const dir = await tempDir();
    const at = NOW - 10_000;
    await writeFile(
      path.join(dir, historyFileName(dayOf(at))),
      `${encodeRecord({ kind: "start", at })}{"point":[\n${encodeRecord({
        kind: "point",
        point: point(at + 2_000),
      })}{"point":[${at + 4_000},0,1`,
    );
    const restored = await keeperIn(dir).restore(LIMITS);
    expect(restored.points).toEqual([point(at + 2_000)]);
  });

  test("the folder holds nothing but the history and, while a copy writes, its lock", async () => {
    const dir = await tempDir();
    const keeper = keeperIn(dir);
    await keeper.restore(LIMITS);
    keeper.start();
    await keeper.flush();
    expect((await readdir(dir)).sort()).toEqual(
      [historyFileName(dayOf(NOW)), "writer.lock"].sort(),
    );
    expect(await modeOf(path.join(dir, "writer.lock"))).toBe(0o600);
    keeper.stop();
    expect(await readdir(dir)).toEqual([historyFileName(dayOf(NOW))]);
  });
});

describe("more than one copy", () => {
  test("a copy that takes over goes on from the files as the other left them, under the size each may grow to", async () => {
    const dir = await tempDir();
    let now = NOW;
    const alive = new Set([1, 2]);
    const copy = (pid: number) =>
      keeperIn(dir, () => now, {
        pid,
        isAlive: (other: number) => alive.has(other),
        maxFileBytes: 1_000,
      });
    const first = copy(1);
    const second = copy(2);
    // Both read the folder as they start, before the first has written anything.
    await first.restore(LIMITS);
    await second.restore(LIMITS);
    first.start();
    second.start();
    for (let index = 0; index < 25; index += 1) {
      now += 2_000;
      first.addPoint(point(now));
    }
    await first.flush();
    first.stop();
    alive.delete(1);

    for (let index = 0; index < 25; index += 1) {
      now += 2_000;
      second.addPoint(point(now));
    }
    await second.flush();
    second.stop();

    const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      expect((await stat(path.join(dir, name))).size, name).toBeLessThanOrEqual(1_000);
    }
    const restored = await copy(3).restore(LIMITS);
    expect(restored.points).toHaveLength(50);
  });
});

describe("with a real collector", () => {
  test("a waiting Claude Code session's request, read from its transcript, never reaches the files", async () => {
    const dir = await tempDir();
    // demo-api is working, and its transcript says what it is about to run.
    const busy = registryFile({
      pid: pids.permission,
      sessionId: ids.permission,
      cwd: "/Users/example/code/demo-api",
      name: "demo-api",
      status: "busy",
    });
    const home = await makeClaudeHome({ ...registryFiles, [`${pids.permission}.json`]: busy });
    const transcripts = path.join(home, "projects", "-Users-example-code-demo-api");
    await mkdir(transcripts, { recursive: true });
    await writeFile(
      path.join(transcripts, `${ids.permission}.jsonl`),
      waitingToRun("./scripts/release.sh --prod"),
    );

    let now = NOW;
    const collector = createCollector({
      version: "9.9.9-test",
      adapters: [adapterFor(home, { run: fails("Not run in a test.") })],
      env: {
        AGENT_LOOKOUT_HISTORY_DIR: dir,
        AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
        AGENT_LOOKOUT_TMUX: "off",
        AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      },
      notifier: fakeSystemNotifier(),
      now: () => now,
      intervalMs: 1_000_000_000,
    });
    collector.start();
    onTestFinished(() => collector.stop());
    await collector.whenStarted();
    await collector.poller.pollOnce();

    // It starts waiting for permission to run it.
    await writeFile(
      path.join(home, "sessions", `${pids.permission}.json`),
      registryFiles[`${pids.permission}.json`] as string,
    );
    now += 2_000;
    const snapshot = await collector.poller.pollOnce();
    const demoApi = snapshot.sessions.find((session) => session.name === "demo-api");
    expect(demoApi?.status).toBe("needs-you");
    expect(demoApi?.waitingText).toBe("Run: ./scripts/release.sh --prod");
    now += 2_000;
    await collector.poller.pollOnce();
    await collector.history?.flush();
    collector.stop();

    const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
    const text = (
      await Promise.all(names.map((name) => readFile(path.join(dir, name), "utf8")))
    ).join("");
    expect(text).toContain('"sessionName":"demo-api"');
    expect(text).toContain('"to":"needs-you"');
    expect(text).not.toContain("waitingText");
    expect(text).not.toContain("release.sh");
    expect(text).not.toContain("Run:");
    expect(text).not.toContain("Run the tests");
    expect(text).not.toContain("/Users/example");
  });
});
