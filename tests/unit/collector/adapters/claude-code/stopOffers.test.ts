import path from "node:path";

import { describe, expect, test } from "vitest";

import { withStopOffers } from "@collector/adapters/claude-code/stopOffers";
import type { FeedEntry } from "@collector/adapters/claude-code/feed";
import { parseRegistryEntry, type RegistryEntry } from "@collector/adapters/claude-code/registry";
import { sessionFromRegistry } from "@collector/adapters/claude-code/toSession";
import { createStopTargets } from "@collector/actions/stopTargets";
import { ids, pids, registryFile } from "@tests/fixtures/claudeCode";

const SESSIONS_DIR = "/Users/example/.claude/sessions";
const NOW = 1_700_000_100_000;
const context = { now: NOW, isAlive: () => true };

function entry(overrides: Record<string, unknown> = {}): RegistryEntry {
  return parseRegistryEntry(registryFile(overrides)) as RegistryEntry;
}

/** The poll's sessions from these entries, offered Stop as the adapter offers it. */
function offers(entries: RegistryEntry[], answer: FeedEntry[] | null = null, background = true) {
  const sessions = entries.map((one) => sessionFromRegistry(one, context));
  return withStopOffers(sessions, entries, answer, { sessionsDir: SESSIONS_DIR, background });
}

describe("which sessions can be stopped", () => {
  test("a session in a terminal is stopped by a signal to its process, and the page is told only that", () => {
    const { sessions, targets } = offers([entry({ entrypoint: "cli" })]);

    expect(sessions[0]?.stop).toEqual({ how: "signal" });
    expect(targets.get(`claude-code:${ids.busy}`)).toEqual({
      how: "signal",
      sessionId: ids.busy,
      pid: pids.busy,
      procStart: "Tue Nov 14 22:13:20 2023",
      registryFile: path.join(SESSIONS_DIR, `${pids.busy}.json`),
    });
    // Nothing a command could be made of goes to the page.
    expect(JSON.stringify(sessions)).not.toContain("Nov 14");
    expect(JSON.stringify(sessions[0]?.stop)).not.toContain(String(pids.busy));
  });

  test("a session in VS Code is stopped the same way", () => {
    const { sessions } = offers([entry({ entrypoint: "claude-vscode" })]);
    expect(sessions[0]?.stop).toEqual({ how: "signal" });
  });

  test.each([
    ["in the desktop app", { entrypoint: "claude-desktop" }],
    ["in an app that is not known", { entrypoint: undefined }],
    ["of no kind", { kind: undefined }],
    ["of a helper's kind", { kind: "daemon" }],
    ["with no start time recorded", { procStart: undefined }],
  ])("a session %s has no Stop", (_what, overrides) => {
    const { sessions, targets } = offers([entry({ entrypoint: "cli", ...overrides })]);
    expect(sessions[0]).not.toHaveProperty("stop");
    expect(targets.size).toBe(0);
  });

  test.each([
    ["finished", "done"],
    ["failed", "failed"],
  ])("a background job that has %s has nothing left to stop", (status, state) => {
    const one = entry({ entrypoint: "cli", kind: "bg", status: "idle", state });
    const { sessions, targets } = offers([one], [{ sessionId: ids.busy, id: "7c5dcf5d" }]);
    expect(sessions[0]?.status).toBe(status);
    expect(sessions[0]).not.toHaveProperty("stop");
    expect(targets.size).toBe(0);
  });

  test("a session whose process has gone has no Stop", () => {
    const one = entry({ entrypoint: "cli" });
    const session = sessionFromRegistry(one, { now: NOW, isAlive: () => false });
    const { sessions } = withStopOffers([session], [one], null, {
      sessionsDir: SESSIONS_DIR,
      background: true,
    });
    expect(sessions[0]).not.toHaveProperty("stop");
  });

  test("a background job is stopped by its job's id, from the command's answer", () => {
    const job = entry({
      pid: 5001,
      sessionId: ids.background,
      kind: "bg",
      entrypoint: "sdk-cli",
      status: "busy",
    });
    const answer: FeedEntry[] = [{ sessionId: ids.background, id: "7c5dcf5d", kind: "background" }];
    const { sessions, targets } = offers([job], answer);

    expect(sessions[0]?.stop).toEqual({ how: "background" });
    expect(targets.get(`claude-code:${ids.background}`)).toMatchObject({
      how: "background",
      jobId: "7c5dcf5d",
      pid: 5001,
    });
  });

  test("a background job is found by its process when the answer names no session", () => {
    const job = entry({ pid: 5001, sessionId: ids.background, kind: "bg", entrypoint: "sdk-cli" });
    const { targets } = offers([job], [{ pid: 5001, id: "7c5dcf5d" }]);
    expect(targets.get(`claude-code:${ids.background}`)).toMatchObject({ jobId: "7c5dcf5d" });
  });

  test.each<[string, FeedEntry[] | null, boolean]>([
    ["with no answer from the command", null, true],
    ["when the answer does not list it", [{ sessionId: ids.idle, id: "7c5dcf5d" }], true],
    ["when its id is of another shape", [{ sessionId: ids.background, id: "--all" }], true],
    ["while the command may not be run", [{ sessionId: ids.background, id: "7c5dcf5d" }], false],
  ])("a background job has no Stop %s", (_what, answer, background) => {
    const job = entry({ pid: 5001, sessionId: ids.background, kind: "bg", entrypoint: "sdk-cli" });
    const { sessions, targets } = offers([job], answer, background);
    expect(sessions[0]).not.toHaveProperty("stop");
    expect(targets.size).toBe(0);
  });

  test("a background job in the desktop app has no Stop", () => {
    const job = entry({ sessionId: ids.background, kind: "bg", entrypoint: "claude-desktop" });
    const { sessions } = offers([job], [{ sessionId: ids.background, id: "7c5dcf5d" }]);
    expect(sessions[0]).not.toHaveProperty("stop");
  });

  test("a session from another source, or whose registry file is another process's, has no Stop", () => {
    const one = entry({ entrypoint: "cli" });
    const session = sessionFromRegistry(one, context);
    const { sessions } = withStopOffers(
      [
        { ...session, source: "codex", id: `codex:${ids.busy}` },
        { ...session, pid: pids.busy + 1 },
      ],
      [one],
      null,
      { sessionsDir: SESSIONS_DIR, background: true },
    );
    expect(sessions.map((candidate) => candidate.stop)).toEqual([undefined, undefined]);
  });
});

describe("the targets the routes read", () => {
  test("each poll's replace the last's, and a session no longer offered has none", () => {
    const stops = createStopTargets();
    stops.set(offers([entry({ entrypoint: "cli" })]).targets);
    expect(stops.targetOf(`claude-code:${ids.busy}`)).toMatchObject({ how: "signal" });

    stops.set(offers([entry({ entrypoint: "claude-desktop" })]).targets);
    expect(stops.targetOf(`claude-code:${ids.busy}`)).toBeUndefined();
  });
});
