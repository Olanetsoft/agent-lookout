import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_WITHOUT_LEASES,
  LEGACY_NOTE,
  MISTRAL_VIBE_CAPABILITIES,
  NEEDS_YOU_NOTE,
  NEWER_STORE_NOTE,
  OLD_SESSION_LEASE_MS,
  RECHECK_MS,
  SCAN_MAX_MS,
  SCAN_MIN_MS,
  UNCHECKED_NOTE,
  vibeSessionDirFor,
  WITHOUT_LEASES_NOTE,
} from "@collector/adapters/mistral-vibe/index";
import { TAIL_LIMIT_BYTES } from "@collector/adapters/mistral-vibe/journal";
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
import { keepsAwake } from "@core/keep-awake/keepAwakeRule";
import { EMPTY_CHANGE_MEMORY, sessionChanges } from "@core/notices/sessionChanges";
import {
  CWD,
  DAY,
  GONE_PID,
  HOME,
  HOUR,
  LIVE_PID,
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  SECOND,
  SESSION_DIR,
  SUBAGENT_ID,
  callbackRegistered,
  callbackResolved,
  current,
  delta,
  journalPath,
  leaseFile,
  otherRecord,
  record,
  publicState,
  savedCallback,
  sessionId,
  storePath,
  usage,
  type StateFields,
} from "@tests/fixtures/mistralVibe";
import {
  handClock,
  healthy,
  MAC_PROCESS_CHECK,
  memoryFiles,
  releaseLease,
  standInPids,
  standInStarts,
  vibeAdapterFor,
  watching,
  writeLease,
  writeStore,
} from "@tests/support/adapters/mistralVibeAdapter";
import { asWritten } from "@tests/support/paths";

const A = sessionId("a1");
const B = sessionId("b1");
const C = sessionId("c1");

const running = (id: string, title = "demo-project refactor"): StateFields => ({
  id,
  status: "running",
  title,
  createdAt: NOW - HOUR,
  updatedAt: NOW - 5 * MINUTE,
  turn: { status: "in_progress", startedAt: NOW - 5 * MINUTE },
});

const idle = (id: string, title = "demo-project refactor"): StateFields => ({
  id,
  status: "idle",
  title,
  createdAt: NOW - HOUR,
  updatedAt: NOW - 2 * MINUTE,
  turn: { status: "completed", startedAt: NOW - 5 * MINUTE, completedAt: NOW - 2 * MINUTE },
});

const failed = (id: string): StateFields => ({
  id,
  status: "failed",
  title: "demo-project refactor",
  createdAt: NOW - HOUR,
  updatedAt: NOW - 3 * MINUTE,
  turn: { status: "failed", startedAt: NOW - 5 * MINUTE, completedAt: NOW - 3 * MINUTE },
});

/** A session folder with Vibe's two folders in it, as any machine that ran Vibe has. */
function vibeFiles(clock = () => NOW) {
  const files = memoryFiles(clock);
  files.mkdir(`${SESSION_DIR}/unified`);
  files.mkdir(`${SESSION_DIR}/active`);
  return files;
}

const statuses = (sessions: { id: string; status: string }[]) =>
  Object.fromEntries(sessions.map((session) => [session.id.split(":")[1], session.status]));

/** Makes a session's store look last written at `at`: its CURRENT and its journal segment. */
function makeOld(files: ReturnType<typeof memoryFiles>, id: string, at: number) {
  files.rewrite(`${SESSION_DIR}/${storePath(id)}/CURRENT`, current({ id }), { mtimeMs: at });
  files.rewrite(`${SESSION_DIR}/${journalPath(id)}`, "", { mtimeMs: at });
}

/** A lease a program that runs took at `at`, as Vibe writes one. */
function takeLease(files: ReturnType<typeof memoryFiles>, id: string, at: number) {
  files.write(`${SESSION_DIR}/active/${id}.lock`, "");
  files.write(`${SESSION_DIR}/active/${id}.lock.json`, leaseFile(id, LIVE_PID, at));
}

/** The calls made under one session's store. */
const underStore = (id: string) => (target: string) =>
  target.startsWith(`${SESSION_DIR}/${storePath(id)}/`) ||
  target === `${SESSION_DIR}/${storePath(id)}`;

describe("finding the session folder", () => {
  test("is VIBE_HOME's logs/session, then ~/.vibe's, unless Agent Lookout's own setting names one", () => {
    expect(vibeSessionDirFor({}, HOME)).toBe(vibeSessionDirFor({}, "/Users/example"));
    expect(vibeSessionDirFor({}, HOME)).toMatch(
      /[\\/]Users[\\/]example[\\/]\.vibe[\\/]logs[\\/]session$/,
    );
    expect(vibeSessionDirFor({ VIBE_HOME: "/opt/vibe" }, HOME)).toMatch(
      /[\\/]opt[\\/]vibe[\\/]logs[\\/]session$/,
    );
    expect(vibeSessionDirFor({ VIBE_HOME: "~/vibe-alt" }, HOME)).toMatch(
      /[\\/]Users[\\/]example[\\/]vibe-alt[\\/]logs[\\/]session$/,
    );
    expect(vibeSessionDirFor({ VIBE_HOME: "  " }, HOME)).toBe(vibeSessionDirFor({}, HOME));
    expect(
      vibeSessionDirFor(
        { VIBE_HOME: "/opt/vibe", AGENT_LOOKOUT_VIBE_SESSION_DIR: "/srv/vibe-sessions" },
        HOME,
      ),
    ).toMatch(/[\\/]srv[\\/]vibe-sessions$/);
  });
});

describe("when Vibe is not on this computer", () => {
  test("says so calmly, lists nothing, and looks again only once a minute", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    const first = await adapter.poll();
    expect(first.health).toEqual({
      id: "mistral-vibe",
      label: "Mistral Vibe",
      state: "unavailable",
      detail:
        "Mistral Vibe was not found: there is no ~/.vibe/logs/session folder. Agent Lookout looks again every minute.",
      watching: watching("~/.vibe/logs/session", "not found"),
      checkedAt: NOW,
    });
    expect(first.sessions).toEqual([]);
    expect(first.basis).toBeUndefined();
    const calls = files.calls.length;
    expect(calls).toBe(1);

    for (let step = 0; step < 10; step += 1) {
      clock.advance(2 * SECOND);
      expect((await adapter.poll()).health.state).toBe("unavailable");
    }
    expect(files.calls.length).toBe(calls);

    clock.set(NOW + RECHECK_MS);
    files.mkdir(`${SESSION_DIR}/unified`);
    expect((await adapter.poll()).health.state).toBe("ok");
  });

  test("names VIBE_HOME when that is where it looked", async () => {
    const adapter = vibeAdapterFor(memoryFiles(), standInPids(), {
      env: { VIBE_HOME: "/Users/example/vibe-alt" },
    });
    expect((await adapter.poll()).health.detail).toBe(
      "Mistral Vibe was not found: VIBE_HOME is set, and there is no ~/vibe-alt/logs/session folder. Agent Lookout looks again every minute.",
    );
  });

  test("a folder Agent Lookout's own setting names is an answer, not a missing Vibe", async () => {
    const files = memoryFiles();
    const adapter = vibeAdapterFor(files, standInPids(), {
      env: { AGENT_LOOKOUT_VIBE_SESSION_DIR: "/Volumes/empty/vibe" },
    });
    const { health, sessions, basis } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_VIBE_SESSION_DIR is set to ${path.resolve("/Volumes/empty/vibe")}, which is not there, so no Mistral Vibe sessions are listed. ${NEEDS_YOU_NOTE} ${UNCHECKED_NOTE}`,
    );
    expect(sessions).toEqual([]);
    expect(basis).toBe(BASIS);
    // It is looked at on every poll, since it was named.
    await adapter.poll();
    expect(files.count("stat")).toBe(2);
  });
});

describe("a session folder with nothing to show", () => {
  test("with no stores yet says Vibe has saved none", async () => {
    const files = memoryFiles();
    files.mkdir(SESSION_DIR);
    const { health, sessions, basis } = await vibeAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toContain(
      "Mistral Vibe has not saved any sessions in ~/.vibe/logs/session/unified yet.",
    );
    expect(health.detail).toContain(NEEDS_YOU_NOTE);
    expect(sessions).toEqual([]);
    // There is no folder of leases either, so nothing could be finished.
    expect(health.detail).toContain(WITHOUT_LEASES_NOTE);
    expect(basis).toBe(BASIS_WITHOUT_LEASES);
  });

  test("with stores and leases but no session in them is a healthy empty card", async () => {
    const result = await vibeAdapterFor(vibeFiles()).poll();
    expect(result.health).toMatchObject({
      state: "ok",
      detail: healthy(),
      watching: watching("~/.vibe/logs/session", "every 2 seconds"),
    });
    expect(result.sessions).toEqual([]);
    expect(result.basis).toBe(BASIS);
  });

  test("says when the older engine saved a session in the last day, which is not shown", async () => {
    const files = memoryFiles();
    files.write(`${SESSION_DIR}/session_20261001_090000_0a1b2c3d/meta.json`, PRIVATE_WORDS);
    files.touch(`${SESSION_DIR}/session_20261001_090000_0a1b2c3d`, NOW - HOUR);
    files.mkdir(`${SESSION_DIR}/active`);
    const { health, sessions } = await vibeAdapterFor(files).poll();
    expect(health.detail).toContain(LEGACY_NOTE);
    expect(sessions).toEqual([]);
    expect(files.opened()).toEqual([]);

    // One saved only before that is old news.
    files.touch(`${SESSION_DIR}/session_20261001_090000_0a1b2c3d`, NOW - 2 * DAY);
    const later = await vibeAdapterFor(files).poll();
    expect(later.health.detail).not.toContain(LEGACY_NOTE);
  });
});

describe("listing sessions", () => {
  test("a held session shows as working, idle or failed, with its name, folder and last write", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: running(A) });
    writeStore(files, { id: B, state: idle(B, "demo-project tests") });
    writeStore(files, { id: C, state: failed(C) });
    for (const id of [A, B, C]) writeLease(files, id);
    files.rewrite(`${SESSION_DIR}/${journalPath(A)}`, "", { mtimeMs: NOW - 20 * SECOND });

    const { health, sessions, basis } = await vibeAdapterFor(files).poll();
    expect(health.detail).toBe(healthy());
    expect(basis).toBe(BASIS);
    expect(statuses(sessions)).toEqual({ [A]: "working", [B]: "idle", [C]: "failed" });
    expect(sessions.find((session) => session.id === `mistral-vibe:${A}`)).toEqual({
      id: `mistral-vibe:${A}`,
      source: "mistral-vibe",
      surface: "unknown",
      name: "demo-project refactor",
      cwd: CWD,
      project: "demo",
      status: "working",
      startedAt: NOW - HOUR,
      statusSince: NOW - 5 * MINUTE,
      lastWriteAt: NOW - 20 * SECOND,
      links: {},
      stale: false,
    });
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("the journal's newest state wins over the generation's, which is stale while a turn runs", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      state: idle(A),
      journal: [
        otherRecord("command_reserved", 5),
        otherRecord("core_input", 6),
        delta(7, running(A)),
        otherRecord("action_intent", 8),
        delta(9),
      ],
    });
    writeLease(files, A);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({ status: "working", statusSince: NOW - 5 * MINUTE });
  });

  test("a rename Vibe journals with no save after it names the session at once", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      state: idle(A, "first title"),
      journal: [delta(5, idle(A, "demo-project renamed"), [])],
    });
    writeLease(files, A);
    expect((await vibeAdapterFor(files).poll()).sessions[0]?.name).toBe("demo-project renamed");
  });

  test("a session with no title yet takes its folder's name, never the first thing asked", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: { ...running(A), title: null } });
    writeLease(files, A);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.name).toBe("demo");
  });

  test("a state the journal holds that is not read leaves the session unknown, named as before", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      state: idle(A, "demo-project refactor"),
      journal: [
        delta(5, running(A)),
        record("projection_advanced", 6, { snapshot: publicState(idle(A)), watermark: 6 }),
      ],
    });
    writeLease(files, A);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({
      status: "unknown",
      statusSince: null,
      name: "demo-project refactor",
    });
  });

  test("after a save, the new generation's state and its empty segment are read", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A), journal: [delta(5, running(A))] });
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");

    // The turn ends and Vibe saves the session: a new generation names a new, empty segment.
    writeStore(files, { id: A, sequence: 6, state: idle(A, "demo-project done") });
    const after = await adapter.poll();
    expect(after.sessions[0]).toMatchObject({ status: "idle", name: "demo-project done" });
  });

  test("a session's id is the same from one poll to the next", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: running(A) });
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    const first = await adapter.poll();
    const second = await adapter.poll();
    expect(first.sessions.map((session) => session.id)).toEqual([`mistral-vibe:${A}`]);
    expect(second.sessions).toEqual(first.sessions);
  });

  test("subagents and sessions being deleted are left out, forks are listed", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, kind: "fork", state: running(A) });
    writeStore(files, { id: B, kind: "subagent", state: running(B) });
    writeStore(files, { id: C, lifecycle: "deleting_tree", state: running(C) });
    writeStore(files, { id: SUBAGENT_ID, kind: "subagent", state: running(SUBAGENT_ID) });
    for (const id of [A, B, C, SUBAGENT_ID]) writeLease(files, id);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions.map((session) => session.id)).toEqual([`mistral-vibe:${A}`]);
  });

  test("a lease with no store yet lists nothing until Vibe saves the session", async () => {
    const files = vibeFiles();
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions).toEqual([]);
    writeStore(files, { id: A, state: running(A) });
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["working"]);
  });

  test("the lease Vibe takes to clear old output is no session's", async () => {
    const files = vibeFiles();
    files.write(`${SESSION_DIR}/active/process-output-cleanup.lock`, "");
    files.write(
      `${SESSION_DIR}/active/process-output-cleanup.lock.json`,
      leaseFile("process-output-cleanup"),
    );
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(files.count(undefined, (target) => target.includes("process-output-cleanup"))).toBe(0);
  });

  test("a store a newer Vibe wrote is shown with no status, and the card says why", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, minor: 11, state: running(A) });
    writeLease(files, A);
    const { health, sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({ status: "unknown", name: "demo-project refactor" });
    expect(health.detail).toBe(healthy("~/.vibe/logs/session", NEWER_STORE_NOTE));
    expect(NEWER_STORE_NOTE).toContain("status and token counts are not shown");
  });
});

describe("open and closed", () => {
  test("a session no program holds is finished, and one whose program crashed is too", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    writeStore(files, { id: B, state: running(B) });
    writeLease(files, B, GONE_PID);
    const { sessions } = await vibeAdapterFor(files, standInPids([LIVE_PID])).poll();
    expect(statuses(sessions)).toEqual({ [A]: "finished", [B]: "finished" });
    expect(sessions.find((session) => session.id.endsWith(A))?.statusSince).toBe(NOW - 2 * MINUTE);
  });

  test("a lock whose pid is still being written is held", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: running(A) });
    files.write(`${SESSION_DIR}/active/${A}.lock`, "");
    const pids = standInPids([]);
    const { sessions } = await vibeAdapterFor(files, pids).poll();
    expect(sessions[0]?.status).toBe("working");
    expect(pids.asked).toEqual([]);
  });

  test("a session finishes when its program lets it go, and works again when one takes it back", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: running(A) });
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    releaseLease(files, A);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    writeLease(files, A);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("with no folder of leases to list, nothing is finished, and the poll is named apart", async () => {
    const files = memoryFiles();
    files.mkdir(`${SESSION_DIR}/unified`);
    writeStore(files, { id: A, state: idle(A) });
    const { health, sessions, basis } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("idle");
    expect(basis).toBe(BASIS_WITHOUT_LEASES);
    expect(health.detail).toBe(healthy("~/.vibe/logs/session", WITHOUT_LEASES_NOTE));

    files.mkdir(`${SESSION_DIR}/active`);
    files.fail(`${SESSION_DIR}/active`);
    expect((await vibeAdapterFor(files).poll()).basis).toBe(BASIS_WITHOUT_LEASES);
  });

  test("a lease Vibe has only just taken leaves a closed session finished, until it has held it a while", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    makeOld(files, A, NOW - 2 * HOUR);
    // Vibe takes the lease of every session with old process output while it clears it.
    takeLease(files, A, NOW - SECOND);
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    clock.advance(OLD_SESSION_LEASE_MS - 2 * SECOND);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    clock.advance(2 * SECOND);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "idle" });
  });

  test("a program that takes a closed session back and writes to it opens it at once", async () => {
    const clock = handClock();
    const files = vibeFiles(clock.now);
    writeStore(files, { id: A, state: idle(A) });
    makeOld(files, A, NOW - 2 * HOUR);
    takeLease(files, A, NOW - SECOND);
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    clock.advance(2 * SECOND);
    files.append(`${SESSION_DIR}/${journalPath(A)}`, delta(5, running(A)));
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });
  });

  test("a lease Vibe takes for a moment on a closed session tells nothing, wherever the polls fall", async () => {
    const clock = handClock();
    const files = vibeFiles(clock.now);
    writeStore(files, { id: A, state: idle(A) });
    makeOld(files, A, NOW - 2 * HOUR);
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });

    let memory = EMPTY_CHANGE_MEMORY;
    const seen: string[] = [];
    const told: string[] = [];
    // Agent Lookout starts while Vibe clears old output, and Vibe does so again a few seconds later.
    for (const taken of [true, false, true, false, true]) {
      if (taken) takeLease(files, A, clock.now());
      else releaseLease(files, A);
      const result = await adapter.poll();
      seen.push(statuses(result.sessions)[A] ?? "not listed");
      // As the poller puts it in the snapshot.
      const health = { ...result.health, basis: result.basis };
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [health],
        sessions: result.sessions,
      });
      memory = next.memory;
      told.push(...next.changes.map(({ event, session }) => `${session.name} ${event}`));
      clock.advance(2 * SECOND);
    }
    expect(seen).toEqual(["finished", "finished", "finished", "finished", "finished"]);
    expect(told).toEqual([]);
  });

  test("a lease whose time Vibe has not written yet tells nothing either, wherever the polls fall", async () => {
    const clock = handClock();
    const files = vibeFiles(clock.now);
    writeStore(files, { id: A, state: idle(A) });
    makeOld(files, A, NOW - 2 * HOUR);
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    const lock = `${SESSION_DIR}/active/${A}.lock`;
    const json = `${lock}.json`;

    let memory = EMPTY_CHANGE_MEMORY;
    const seen: string[] = [];
    const told: string[] = [];
    // Vibe makes the lock, empties its `.json`, then writes it. A poll can fall in either moment.
    const steps = [
      () => files.write(lock, ""),
      () => files.write(json, ""),
      () => takeLease(files, A, clock.now() - SECOND),
      // Let go and taken again between two polls.
      () => files.rewrite(json, ""),
      () => releaseLease(files, A),
      () => files.write(lock, ""),
      () => releaseLease(files, A),
    ];
    for (const step of steps) {
      step();
      const result = await adapter.poll();
      seen.push(statuses(result.sessions)[A] ?? "not listed");
      const health = { ...result.health, basis: result.basis };
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [health],
        sessions: result.sessions,
      });
      memory = next.memory;
      told.push(...next.changes.map(({ event, session }) => `${session.name} ${event}`));
      clock.advance(2 * SECOND);
    }
    expect(seen).toEqual(steps.map(() => "finished"));
    expect(told).toEqual([]);
  });

  test("a lease with no time to read counts from the poll that first found it", async () => {
    const clock = handClock();
    const files = vibeFiles(clock.now);
    writeStore(files, { id: A, state: idle(A) });
    writeStore(files, { id: B, state: idle(B) });
    makeOld(files, A, NOW - 2 * HOUR);
    makeOld(files, B, NOW - 2 * HOUR);
    files.write(`${SESSION_DIR}/active/${A}.lock`, "");
    files.write(`${SESSION_DIR}/active/${B}.lock`, "");
    files.write(`${SESSION_DIR}/active/${B}.lock.json`, '{"acquired_at":');
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished", [B]: "finished" });

    // Vibe writes to one of them, as a program that uses the session does at once.
    clock.advance(2 * SECOND);
    files.append(`${SESSION_DIR}/${journalPath(B)}`, delta(5, running(B)));
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished", [B]: "working" });

    // A lock left with no time, as by a program that crashed before writing it, looks held after 30 seconds.
    clock.advance(OLD_SESSION_LEASE_MS - 4 * SECOND);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished", [B]: "working" });
    clock.advance(2 * SECOND);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "idle", [B]: "working" });

    // B's program writes the lease's time, works a while, and lets go; Vibe takes it back between two polls.
    takeLease(files, B, NOW);
    expect(statuses((await adapter.poll()).sessions)[B]).toBe("working");
    clock.advance(OLD_SESSION_LEASE_MS);
    files.append(`${SESSION_DIR}/${journalPath(B)}`, delta(6, idle(B)));
    clock.advance(2 * SECOND);
    files.rewrite(`${SESSION_DIR}/active/${B}.lock.json`, "");
    expect(statuses((await adapter.poll()).sessions)[B]).toBe("finished");
  });

  test("a failed session stays failed once its program lets it go", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: failed(A) });
    expect((await vibeAdapterFor(files).poll()).sessions[0]?.status).toBe("failed");
  });
});

describe("which sessions are followed", () => {
  test("one no program holds is listed for a day after Vibe last wrote to it, and an older one's store is never opened", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    writeStore(files, { id: B, state: idle(B) });
    const journalOfB = `${SESSION_DIR}/${journalPath(B)}`;
    files.rewrite(`${SESSION_DIR}/${storePath(B)}/CURRENT`, current({ id: B }), {
      mtimeMs: NOW - DAY - HOUR,
    });
    files.rewrite(journalOfB, delta(5, running(B)), { mtimeMs: NOW - DAY - HOUR });
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    for (const at of [NOW, NOW + SCAN_MAX_MS]) {
      clock.set(at);
      files.forget();
      const { sessions } = await adapter.poll();
      expect(sessions.map((session) => session.id)).toEqual([`mistral-vibe:${A}`]);
      expect(files.opened().filter(underStore(B))).toEqual([]);
      expect(files.reads.filter((read) => read.path === journalOfB)).toEqual([]);
    }
    // The second poll was a look through the stores too.
    expect(files.count("readdir", (target) => target === `${SESSION_DIR}/unified`)).toBe(1);
  });

  test("one Vibe last wrote to in its journal, as it does a rename, is found by the look through the stores", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, current({ id: A }), {
      mtimeMs: NOW - 2 * DAY,
    });
    files.rewrite(
      `${SESSION_DIR}/${journalPath(A)}`,
      delta(5, idle(A, "demo-project renamed"), []),
      {
        mtimeMs: NOW - HOUR,
      },
    );
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions.map((session) => [session.status, session.name])).toEqual([
      ["finished", "demo-project renamed"],
    ]);
  });

  test("one whose newest save goes on in an older journal segment is found by its CURRENT", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, current({ id: A }), {
      mtimeMs: NOW - HOUR,
    });
    files.rewrite(`${SESSION_DIR}/${journalPath(A)}`, "", { mtimeMs: NOW - 2 * DAY });
    expect(statuses((await vibeAdapterFor(files).poll()).sessions)).toEqual({ [A]: "finished" });
  });

  test("a finished session leaves once a day has passed, and a held one stays however old", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    writeStore(files, { id: B, state: idle(B) });
    writeLease(files, B);
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    expect((await adapter.poll()).sessions).toHaveLength(2);
    clock.advance(DAY);
    const later = await adapter.poll();
    expect(later.sessions.map((session) => session.id)).toEqual([`mistral-vibe:${B}`]);
  });

  test("a lease a crashed Vibe left on a session older than a day lists nothing, and its store is never opened", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    makeOld(files, A, NOW - 3 * DAY);
    writeLease(files, A, GONE_PID);
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids([LIVE_PID]), { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(files.opened().filter(underStore(A))).toEqual([]);
    for (let poll = 0; poll < 3; poll += 1) {
      files.forget();
      clock.advance(2 * SECOND);
      expect((await adapter.poll()).sessions).toEqual([]);
      // Between looks through the stores, it is not even looked at.
      expect(files.count(undefined, underStore(A))).toBe(0);
    }
  });

  test("a session a crashed Vibe left leased leaves once a day has passed, and is then not looked at", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: running(A) });
    writeLease(files, A, GONE_PID);
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids([LIVE_PID]), { now: clock.now });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    clock.advance(DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
    files.forget();
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(files.count(undefined, underStore(A))).toBe(0);
  });

  test("a lease Vibe has only just taken lists no session older than a day, until it has held it a while", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A) });
    makeOld(files, A, NOW - 20 * DAY);
    // Vibe takes the lease of every old session that ran a process while it clears their output.
    takeLease(files, A, NOW - SECOND);
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);

    // Let go of at once: it never showed.
    releaseLease(files, A);
    clock.advance(2 * SECOND);
    expect((await adapter.poll()).sessions).toEqual([]);

    // Taken by a program that keeps it: once it has held it a while, the session is open.
    takeLease(files, A, clock.now());
    expect((await adapter.poll()).sessions).toEqual([]);
    // Until then, nothing of its store is opened.
    expect(files.opened().filter(underStore(A))).toEqual([]);
    clock.advance(OLD_SESSION_LEASE_MS);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "idle" });
  });

  test("a session no program holds, saved after the last look, is found at the next look through the stores", async () => {
    const files = vibeFiles();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    await adapter.poll();
    writeStore(files, { id: A, state: idle(A) });
    files.touch(`${SESSION_DIR}/unified`, NOW + 1);

    // Too soon after the last look, even though the folder changed.
    clock.advance(SCAN_MIN_MS - 2 * SECOND);
    expect((await adapter.poll()).sessions).toEqual([]);
    clock.set(NOW + SCAN_MIN_MS);
    expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["finished"]);
  });

  test("an older engine's session saved after the last look is seen at the next look, when the session folder changes", async () => {
    const files = vibeFiles();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    await adapter.poll();
    const legacy = `${SESSION_DIR}/session_20261001_115900_0a1b2c3d`;
    files.write(`${legacy}/meta.json`, PRIVATE_WORDS);
    files.touch(legacy, NOW);
    files.touch(SESSION_DIR, NOW + 1);

    // Too soon after the last look, even though the folder changed.
    clock.advance(SCAN_MIN_MS - 2 * SECOND);
    expect((await adapter.poll()).health.detail).not.toContain(LEGACY_NOTE);
    clock.set(NOW + SCAN_MIN_MS);
    expect(SCAN_MIN_MS).toBeLessThan(SCAN_MAX_MS);
    expect((await adapter.poll()).health.detail).toContain(LEGACY_NOTE);
  });

  test("the stores are looked through again however quiet the folder, every few minutes", async () => {
    const files = vibeFiles();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    await adapter.poll();
    writeStore(files, { id: A, state: idle(A), journal: [] });
    clock.advance(SCAN_MIN_MS);
    expect((await adapter.poll()).sessions).toEqual([]);
    clock.set(NOW + SCAN_MAX_MS);
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, current({ id: A }), {
      mtimeMs: NOW + SCAN_MAX_MS,
    });
    expect((await adapter.poll()).sessions).toHaveLength(1);
  });

  test("between looks, a session's store is checked with two lstats a poll and read only when it changed", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: running(A), journal: [delta(5, running(A))] });
    writeLease(files, A);
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    await adapter.poll();
    files.forget();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.opened()).toEqual([]);
    const root = `${SESSION_DIR}/${storePath(A)}`;
    expect(files.count("lstat", (target) => target.startsWith(root))).toBe(2);
  });
});

describe("when something goes wrong", () => {
  test("a stores folder that cannot be listed says so", async () => {
    const files = vibeFiles();
    files.fail(`${SESSION_DIR}/unified`);
    const { health, sessions } = await vibeAdapterFor(files).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "Mistral Vibe sessions could not be read: the folder ~/.vibe/logs/session/unified could not be looked at.",
    );
    expect(sessions).toEqual([]);
  });

  test("a stores folder that can be looked at but not listed says so", async () => {
    const files = vibeFiles();
    const stores = `${SESSION_DIR}/unified`;
    const io: ReadOnlyIo = {
      ...files.io,
      async readdir(dir) {
        if (asWritten(dir) === stores) {
          throw Object.assign(new Error(`EACCES: ${stores}`), { code: "EACCES" });
        }
        return files.io.readdir(dir);
      },
    };
    const { health, sessions } = await vibeAdapterFor(files, standInPids(), { io }).poll();
    expect(health.state).toBe("error");
    expect(health.detail).toBe(
      "Mistral Vibe sessions could not be read: the folder ~/.vibe/logs/session/unified could not be listed.",
    );
    expect(sessions).toEqual([]);
  });

  test("never throws, whatever the files do", async () => {
    for (const code of ["EACCES", "EIO", "ENOENT", "EMFILE"]) {
      const files = vibeFiles();
      writeStore(files, { id: A, state: running(A), journal: [delta(5, running(A))] });
      writeLease(files, A);
      const clock = handClock();
      const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
      await adapter.poll();
      files.failAll(code);
      const result = await adapter.poll();
      expect(result.sessions).toEqual([]);
      expect(["error", "unavailable"]).toContain(result.health.state);
      files.failAll(null);
      // A folder that seemed gone is looked for again a minute later.
      clock.advance(RECHECK_MS);
      expect((await adapter.poll()).sessions.map((session) => session.status)).toEqual(["working"]);
    }
  });

  test("a journal that cannot be read this time keeps what was read of it before", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A), journal: [delta(5, running(A))] });
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    await adapter.poll();
    files.fail(`${SESSION_DIR}/${journalPath(A)}`);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });
});

test("says what tells a lease's process from another program's, by what the system has", async () => {
  const factsOn = async (platform: NodeJS.Platform) => {
    const { health } = await vibeAdapterFor(vibeFiles(), standInPids(), { platform }).poll();
    return health.watching?.filter((fact) => fact.label.startsWith("Process check"));
  };
  expect(await factsOn("darwin")).toEqual(MAC_PROCESS_CHECK);
  for (const platform of ["linux", "win32"] as const) {
    expect(await factsOn(platform)).toEqual([
      { label: "Process check", value: "signal 0 alone, every 2 seconds" },
    ]);
  }
});

test("declares what it can report, the same on every poll", async () => {
  const adapter = vibeAdapterFor(vibeFiles());
  expect(adapter.capabilities).toBe(MISTRAL_VIBE_CAPABILITIES);
  expect(adapter.lookingIn).toBe("Looking for Mistral Vibe sessions in ~/.vibe/logs/session.");
  expect(MISTRAL_VIBE_CAPABILITIES["needs-you"].level).toBe("partly");
  expect(MISTRAL_VIBE_CAPABILITIES.tokens.level).toBe("yes");
});

describe("waiting for the person", () => {
  const ASKED = NOW - MINUTE;
  const APPROVAL = "approval-call-1";
  const QUESTION = "user-input-call-2";

  const approval = (sequence: number, createdAt = ASKED, id = APPROVAL) =>
    callbackRegistered(sequence, { id, createdAt });
  const question = (sequence: number, createdAt = ASKED, id = QUESTION) =>
    callbackRegistered(sequence, { id, kind: "user_input", createdAt });

  /** A session with a turn in flight and these lines after it, held by a program that runs. */
  function sessionWith(...lines: string[]) {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A), journal: [delta(5, running(A)), ...lines] });
    writeLease(files, A);
    return files;
  }

  const add = (files: ReturnType<typeof memoryFiles>, line: string, at = NOW + SECOND) =>
    files.append(`${SESSION_DIR}/${journalPath(A)}`, line, { mtimeMs: at });

  test("an approval shows as needing you for permission, from when Vibe asked", async () => {
    const { sessions } = await vibeAdapterFor(sessionWith(approval(6))).poll();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: ASKED,
    });
  });

  test("a question shows as needing you for an answer, from when Vibe asked", async () => {
    const { sessions } = await vibeAdapterFor(sessionWith(question(6))).poll();
    expect(sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: ASKED,
    });
  });

  test("a session idle when first read, which then starts a turn and asks, needs you", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      state: idle(A),
      journal: [delta(5, running(A)), delta(6, idle(A))],
    });
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("idle");
    add(
      files,
      delta(7, { ...running(A), turn: { status: "in_progress", startedAt: NOW - 2 * MINUTE } }),
    );
    add(files, approval(8), NOW + 2 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: ASKED,
    });
  });

  test("an ask in a lease's first 30 seconds shows at once", async () => {
    const files = vibeFiles();
    const state = { ...running(A), turn: { status: "in_progress", startedAt: NOW - 4 * SECOND } };
    writeStore(files, {
      id: A,
      state: idle(A),
      journal: [delta(5, state), approval(6, NOW - 2 * SECOND)],
    });
    takeLease(files, A, NOW - 5 * SECOND);
    expect((await vibeAdapterFor(files).poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: NOW - 2 * SECOND,
    });
  });

  test("a store Vibe 3.0.4 wrote, of minor 10, shows the same", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      minor: 10,
      state: idle(A),
      journal: [delta(5, running(A)), approval(6)],
    });
    writeLease(files, A);
    const { health, sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({ status: "needs-you", waitingReason: "permission" });
    expect(health.detail).toBe(healthy());
  });

  describe.each([
    ["an approval", approval, APPROVAL],
    ["a question", question, QUESTION],
  ])("%s", (_name, ask, id) => {
    const interrupted: StateFields = {
      ...idle(A),
      turn: { status: "interrupted", startedAt: NOW - 5 * MINUTE, completedAt: NOW },
    };

    test("answered: goes back to working, from when its turn began", async () => {
      const files = sessionWith(ask(6));
      const adapter = vibeAdapterFor(files);
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
      add(files, callbackResolved(7, id));
      const { sessions } = await adapter.poll();
      expect(sessions[0]).toMatchObject({ status: "working", statusSince: NOW - 5 * MINUTE });
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    });

    test("declined: the wait ends, and the turn goes on", async () => {
      const files = sessionWith(ask(6));
      const adapter = vibeAdapterFor(files);
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
      // Vibe records a denied approval as it does an approval, with the decision
      // in the result, and a question refused with an error as failed.
      const declined =
        id === APPROVAL
          ? callbackResolved(7, id, "resolved", { output: { decision: { type: "deny" } } })
          : callbackResolved(7, id, "failed", { error: { message: PRIVATE_WORDS } });
      add(files, declined);
      const { sessions } = await adapter.poll();
      expect(sessions[0]).toMatchObject({ status: "working", statusSince: NOW - 5 * MINUTE });
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    });

    test("stopped: Vibe closes the callback, then the turn", async () => {
      const files = sessionWith(ask(6));
      const adapter = vibeAdapterFor(files);
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
      add(
        files,
        callbackResolved(7, id, "failed", {
          code: "callback_closed",
          message: "Turn interrupted",
        }),
      );
      add(files, delta(8, interrupted), NOW + 2 * SECOND);
      const { sessions } = await adapter.poll();
      expect(sessions[0]).toMatchObject({ status: "idle", statusSince: NOW });
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    });

    test("stopped, with only the callback's record read so far: the wait is over already", async () => {
      const files = sessionWith(ask(6));
      const adapter = vibeAdapterFor(files);
      await adapter.poll();
      add(files, callbackResolved(7, id, "failed", { code: "callback_closed", message: "" }));
      expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    });
  });

  test("two open at once: the reason is the newest's, and the time stands until the last is settled", async () => {
    const files = sessionWith(approval(6, ASKED), question(7, ASKED + 3 * SECOND));
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: ASKED,
    });
    add(files, callbackResolved(8, APPROVAL));
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: ASKED,
    });
    add(files, callbackResolved(9, QUESTION), NOW + 2 * SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a new ask right after the last was answered is a new wait, from when Vibe asked", async () => {
    const files = sessionWith(approval(6, ASKED));
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.statusSince).toBe(ASKED);
    add(files, callbackResolved(7, APPROVAL));
    add(files, question(8, ASKED + 30 * SECOND), NOW + 2 * SECOND);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
      statusSince: ASKED + 30 * SECOND,
    });
  });

  test("the status time does not move while the wait stands, whatever Vibe writes", async () => {
    const files = sessionWith(approval(6));
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    const since: (number | null | undefined)[] = [];
    for (const line of [
      otherRecord("action_result", 7),
      delta(8, { ...running(A), title: "new" }),
    ]) {
      since.push((await adapter.poll()).sessions[0]?.statusSince);
      clock.advance(5 * SECOND);
      add(files, line, clock.now());
    }
    since.push((await adapter.poll()).sessions[0]?.statusSince);
    expect(since).toEqual([ASKED, ASKED, ASKED]);
  });

  test("a store too new to read shows no wait, and `ps` is not asked", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      minor: 11,
      state: idle(A),
      journal: [delta(5, running(A)), approval(6)],
    });
    writeLease(files, A);
    const ps = standInStarts();
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
    expect(ps.runs).toEqual([]);
  });

  test("a wait outlasts a save: Vibe carries it into the next generation, whose segment settles it", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      sequence: 9,
      state: running(A),
      callbacks: [savedCallback({ id: APPROVAL, createdAt: ASKED })],
    });
    writeLease(files, A);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: ASKED,
    });
    files.append(`${SESSION_DIR}/${journalPath(A, 9)}`, callbackResolved(10, APPROVAL), {
      mtimeMs: NOW + SECOND,
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
  });

  test("a wait a poll saw stands through a save, which tells nothing new", async () => {
    const files = sessionWith();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    let memory = EMPTY_CHANGE_MEMORY;
    const told: string[] = [];
    const pollOnce = async () => {
      const result = await adapter.poll();
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [{ ...result.health, basis: result.basis }],
        sessions: result.sessions,
      });
      memory = next.memory;
      told.push(...next.changes.map(({ event }) => event));
      clock.advance(2 * SECOND);
      return result.sessions[0];
    };
    await pollOnce();
    add(files, approval(6), clock.now());
    expect(await pollOnce()).toMatchObject({ status: "needs-you", statusSince: ASKED });
    files.rewrite(`${SESSION_DIR}/${journalPath(A)}`, "", { mtimeMs: clock.now() });
    writeStore(files, {
      id: A,
      sequence: 9,
      state: running(A),
      callbacks: [savedCallback({ id: APPROVAL, createdAt: ASKED })],
    });
    expect(await pollOnce()).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: ASKED,
    });
    files.append(`${SESSION_DIR}/${journalPath(A, 9)}`, callbackResolved(10, APPROVAL), {
      mtimeMs: clock.now(),
    });
    expect((await pollOnce())?.status).toBe("working");
    expect(told).toEqual(["needs-you"]);
  });

  test("a killed Vibe's wait does not show: the session is finished, and does not keep the Mac awake", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A), journal: [delta(5, running(A)), approval(6)] });
    writeLease(files, A, GONE_PID);
    const { sessions } = await vibeAdapterFor(files, standInPids([LIVE_PID])).poll();
    expect(sessions[0]?.status).toBe("finished");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
    expect(keepsAwake(sessions[0]!, NOW)).toBe(false);
  });

  test("a Vibe killed while the page watches: the wait ends with its process", async () => {
    const files = sessionWith(question(6));
    const pids = standInPids([LIVE_PID]);
    const adapter = vibeAdapterFor(files, pids);
    const { sessions: before } = await adapter.poll();
    expect(before[0]?.status).toBe("needs-you");
    expect(keepsAwake(before[0]!, NOW)).toBe(true);

    pids.set([]);
    const { sessions } = await adapter.poll();
    expect(sessions[0]?.status).toBe("finished");
    expect(keepsAwake(sessions[0]!, NOW)).toBe(false);
  });

  test("on a Mac, a wait in a lease whose process ID went to another program does not show", async () => {
    const files = sessionWith(question(6));
    // The lease was taken at 11:00 and the process with its ID started at 11:30.
    const ps = standInStarts({ [LIVE_PID]: "Thu Oct  1 11:30:00 2026" });
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(sessions[0]?.status).toBe("finished");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
    expect(keepsAwake(sessions[0]!, NOW)).toBe(false);
  });

  test.each(["linux", "win32"] as const)(
    "on %s `ps` is not asked, so a clock set forward leaves a wait standing, and a lease whose process ID went to another program too",
    async (platform) => {
      const files = sessionWith(question(6));
      // What Linux's `ps` prints for a Vibe that took this lease as it started,
      // at 11:00, once the clock is set 10 minutes on. Another program with the
      // process ID prints the same.
      const ps = standInStarts({ [LIVE_PID]: "Thu Oct  1 11:10:00 2026" });
      const { sessions } = await vibeAdapterFor(files, standInPids(), {
        platform,
        readProcessStarts: ps.read,
      }).poll();
      expect(sessions[0]).toMatchObject({ status: "needs-you", waitingReason: "question" });
      expect(keepsAwake(sessions[0]!, NOW)).toBe(true);
      expect(ps.runs).toEqual([]);
    },
  );

  test("`ps` is asked once about a lease another program has, which leaves the list as any finished session does", async () => {
    const files = sessionWith(question(6));
    const clock = handClock();
    const ps = standInStarts({ [LIVE_PID]: "Thu Oct  1 11:30:00 2026" });
    const adapter = vibeAdapterFor(files, standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    for (const later of [0, MINUTE, HOUR]) {
      clock.advance(later);
      const { sessions } = await adapter.poll();
      expect(sessions[0]?.status).toBe("finished");
      expect(sessions[0]).not.toHaveProperty("waitingReason");
    }
    expect(ps.runs).toEqual([[LIVE_PID]]);

    clock.advance(DAY);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(ps.runs).toEqual([[LIVE_PID]]);
  });

  test("a lease `ps` ruled out is asked about again once its process has ended, and a new lease is too", async () => {
    const files = sessionWith(question(6));
    const clock = handClock();
    const pids = standInPids();
    const ps = standInStarts({ [LIVE_PID]: "Thu Oct  1 11:30:00 2026" });
    const adapter = vibeAdapterFor(files, pids, { now: clock.now, readProcessStarts: ps.read });
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);

    pids.set([]);
    clock.advance(SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    pids.set([LIVE_PID]);
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    expect(ps.runs).toHaveLength(2);

    // A Vibe that took the session at 11:45, after the process with this ID began.
    takeLease(files, A, NOW - 15 * MINUTE);
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    expect(ps.runs).toHaveLength(3);
  });

  test("a wait stands when `ps` says its process was there first, and when it cannot say", async () => {
    const started = standInStarts({ [LIVE_PID]: "Thu Oct  1 10:45:00 2026" });
    for (const ps of [started, standInStarts()]) {
      const { sessions } = await vibeAdapterFor(sessionWith(question(6)), standInPids(), {
        readProcessStarts: ps.read,
      }).poll();
      expect(sessions[0]?.status).toBe("needs-you");
      expect(ps.runs).toEqual([[LIVE_PID]]);
    }
  });

  test("`ps` is asked about a session that waits at once and at most every 30 seconds, all that wait in one run, and not about one just written to", async () => {
    const files = sessionWith(approval(6));
    writeStore(files, { id: B, state: idle(B), journal: [delta(5, running(B)), question(6)] });
    writeLease(files, B);
    writeStore(files, { id: C, state: running(C) });
    writeLease(files, C);
    const clock = handClock();
    const ps = standInStarts();
    const adapter = vibeAdapterFor(files, standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    await adapter.poll();
    expect(ps.runs).toEqual([[LIVE_PID]]);
    clock.advance(10 * SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
    clock.advance(30 * SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);

    const quiet = vibeFiles();
    writeStore(quiet, { id: A, state: running(A) });
    writeLease(quiet, A);
    const none = standInStarts();
    await vibeAdapterFor(quiet, standInPids(), { readProcessStarts: none.read }).poll();
    expect(none.runs).toEqual([]);
  });

  test("`ps` is asked about each waiting session's process in one run, and not about one just written to", async () => {
    const OTHER_PID = 5151;
    const files = sessionWith(approval(6));
    writeStore(files, { id: B, state: idle(B), journal: [delta(5, running(B)), question(6)] });
    writeLease(files, B, OTHER_PID);
    writeStore(files, { id: C, state: running(C) });
    writeLease(files, C, OTHER_PID + 1);
    const ps = standInStarts();
    await vibeAdapterFor(files, standInPids([LIVE_PID, OTHER_PID, OTHER_PID + 1]), {
      readProcessStarts: ps.read,
    }).poll();
    expect(ps.runs).toEqual([[LIVE_PID, OTHER_PID]]);
  });

  test("a session that ends while it waits is finished, with no reason", async () => {
    const files = sessionWith(approval(6));
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    releaseLease(files, A);
    const { sessions } = await adapter.poll();
    expect(sessions[0]).toMatchObject({ status: "finished", statusSince: NOW - 5 * MINUTE });
    expect(sessions[0]).not.toHaveProperty("waitingReason");
    expect(keepsAwake(sessions[0]!, NOW)).toBe(false);
  });

  test("a question a killed Vibe left open is not waited on once a later program has the session", async () => {
    const files = vibeFiles();
    writeStore(files, {
      id: A,
      state: idle(A),
      journal: [delta(5, running(A)), question(6), otherRecord("action_result", 7)],
    });
    takeLease(files, A, NOW - 10 * SECOND);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("working");
  });

  test("a lease taken a moment ago, with nothing written since, shows no wait", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A), journal: [delta(5, running(A)), approval(6)] });
    makeOld(files, A, NOW - MINUTE);
    files.rewrite(
      `${SESSION_DIR}/${journalPath(A)}`,
      [delta(5, running(A)), approval(6)].join(""),
      { mtimeMs: NOW - MINUTE },
    );
    takeLease(files, A, NOW - 5 * SECOND);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("finished");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
  });

  test("a callback an earlier turn left open is no wait", async () => {
    const { sessions } = await vibeAdapterFor(
      sessionWith(approval(6, NOW - 6 * MINUTE), otherRecord("action_result", 7)),
    ).poll();
    expect(sessions[0]?.status).toBe("working");
  });

  test("a callback left open in a session with no turn in flight is no wait", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: idle(A), journal: [approval(5), delta(6, idle(A))] });
    writeLease(files, A);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("idle");
  });

  test("a kind of callback this version does not know leaves the session working", async () => {
    const line = callbackRegistered(6, { id: "tool-1", kind: "client_tool", createdAt: ASKED });
    const { sessions } = await vibeAdapterFor(sessionWith(line)).poll();
    expect(sessions[0]?.status).toBe("working");
  });

  test("a lease that does not say when it was taken shows no wait", async () => {
    const files = sessionWith(approval(6));
    files.rewrite(`${SESSION_DIR}/active/${A}.lock.json`, '{"process_id":4242}\n');
    expect((await vibeAdapterFor(files).poll()).sessions[0]?.status).toBe("working");
  });

  test("a lease that gives a time but no process claims no wait, and `ps` is not asked", async () => {
    const files = sessionWith(approval(6));
    files.rewrite(`${SESSION_DIR}/active/${A}.lock.json`, leaseFile(A, null));
    const ps = standInStarts();
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(sessions[0]?.status).toBe("working");
    expect(ps.runs).toEqual([]);
  });

  test("while the leases cannot be read, a wait is not claimed, and `ps` is not asked", async () => {
    const files = sessionWith(approval(6));
    files.fail(`${SESSION_DIR}/active`, "EACCES");
    const ps = standInStarts();
    const result = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(result.sessions[0]?.status).toBe("working");
    expect(result.basis).toBe(BASIS_WITHOUT_LEASES);
    expect(ps.runs).toEqual([]);
  });

  test("what was read of a wait stands for a poll that cannot read the journal", async () => {
    const files = sessionWith(approval(6));
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    add(files, otherRecord("action_result", 7));
    files.fail(`${SESSION_DIR}/${journalPath(A)}`, "EACCES");
    await adapter.poll();
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: ASKED,
    });
  });

  test("a long record and a broken line are passed through, and the wait still shows", async () => {
    const long = approval(6).replace(PRIVATE_WORDS, "x".repeat(2 * 1024 * 1024));
    const broken = '{"payload":{"callback_id":"cut-off\nnot a record at all\n';
    const { sessions } = await vibeAdapterFor(sessionWith(broken, long)).poll();
    expect(sessions[0]).toMatchObject({ status: "needs-you", statusSince: ASKED });
  });

  test("an approval's line too long to read to its start claims no wait, and no status either", async () => {
    const huge = approval(6).replace(PRIVATE_WORDS, "y".repeat(9 * 1024 * 1024));
    const { sessions } = await vibeAdapterFor(sessionWith(huge)).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(sessions[0]).not.toHaveProperty("waitingReason");
  });

  test("a subagent's wait is in its own store, which is not read: its session shows as working", async () => {
    const files = sessionWith();
    writeStore(files, {
      id: SUBAGENT_ID,
      kind: "subagent",
      state: idle(SUBAGENT_ID),
      journal: [delta(5, running(SUBAGENT_ID)), approval(6)],
    });
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(statuses(sessions)).toEqual({ [A]: "working" });
    expect(files.count(undefined, underStore(SUBAGENT_ID))).toBe(0);
  });

  test("nothing of what a callback says is kept: no tool, arguments, question or answer", async () => {
    const files = sessionWith(approval(6), question(7));
    const adapter = vibeAdapterFor(files);
    const asking = await adapter.poll();
    expect(asking.sessions[0]).not.toHaveProperty("waitingText");
    expect(asking.sessions[0]).not.toHaveProperty("waitingDetail");
    expect(JSON.stringify(asking)).not.toContain(PRIVATE_WORDS);
    expect(JSON.stringify(asking)).not.toContain("bash");
    expect(JSON.stringify(asking)).not.toContain(APPROVAL);

    add(files, callbackResolved(8, APPROVAL));
    add(files, callbackResolved(9, QUESTION), NOW + 2 * SECOND);
    expect(JSON.stringify(await adapter.poll())).not.toContain(PRIVATE_WORDS);
  });

  test("a wait's start and end are told as any session's are", async () => {
    const files = sessionWith();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    let memory = EMPTY_CHANGE_MEMORY;
    const told: string[] = [];
    const steps = [
      () => undefined,
      () => add(files, approval(6), clock.now()),
      () => add(files, callbackResolved(7, APPROVAL), clock.now()),
      () => add(files, question(8, NOW), clock.now()),
      () => releaseLease(files, A),
    ];
    for (const step of steps) {
      step();
      const result = await adapter.poll();
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [{ ...result.health, basis: result.basis }],
        sessions: result.sessions,
      });
      memory = next.memory;
      told.push(...next.changes.map(({ event }) => event));
      clock.advance(2 * SECOND);
    }
    expect(told).toEqual(["needs-you", "needs-you", "finished"]);
  });

  test("settling the older of two tells nothing: the wait goes on", async () => {
    const files = sessionWith();
    const clock = handClock();
    const adapter = vibeAdapterFor(files, standInPids(), { now: clock.now });
    let memory = EMPTY_CHANGE_MEMORY;
    const told: string[] = [];
    const steps = [
      () => undefined,
      () => {
        add(files, approval(6), clock.now());
        add(files, question(7, ASKED + SECOND), clock.now());
      },
      () => add(files, callbackResolved(8, APPROVAL), clock.now()),
    ];
    for (const step of steps) {
      step();
      const result = await adapter.poll();
      const next = sessionChanges(memory, {
        generatedAt: clock.now(),
        sources: [{ ...result.health, basis: result.basis }],
        sessions: result.sessions,
      });
      memory = next.memory;
      told.push(...next.changes.map(({ event }) => event));
      clock.advance(2 * SECOND);
    }
    expect(told).toEqual(["needs-you"]);
  });
});

describe("a lease whose process ID may have gone to another program", () => {
  /** What `ps` prints for a process that started before the leases below were taken, at 11:00. */
  const BEFORE_LEASE = "Thu Oct  1 10:45:00 2026";
  /** What it prints for one that started after. */
  const AFTER_LEASE = "Thu Oct  1 11:30:00 2026";
  const OTHER_PID = 5151;

  const add = (files: ReturnType<typeof memoryFiles>, line: string, at: number) =>
    files.append(`${SESSION_DIR}/${journalPath(A)}`, line, { mtimeMs: at });

  /** A folder whose files were last written two minutes ago, so that a lease in it is due a look. */
  const quietFiles = () => vibeFiles(() => NOW - 2 * MINUTE);

  /** A session Vibe last wrote to two minutes ago, under a lease taken at 11:00. */
  function quietSession(state: StateFields = running(A)) {
    const files = quietFiles();
    writeStore(files, { id: A, state });
    writeLease(files, A);
    return files;
  }

  test("a Vibe that runs stays open, and `ps` is asked once, however long it runs", async () => {
    const clock = handClock();
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE });
    const adapter = vibeAdapterFor(quietSession(), standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    for (const later of [0, SECOND, MINUTE, HOUR]) {
      clock.advance(later);
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });
    }
    expect(ps.runs).toEqual([[LIVE_PID]]);
  });

  test.each([
    ["working", running(A)],
    ["idle", idle(A)],
  ])(
    "on a Mac, a %s session whose lease's process ID went to another program shows as it does once its process is gone",
    async (_, state) => {
      const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
      const { sessions } = await vibeAdapterFor(quietSession(state), standInPids(), {
        readProcessStarts: ps.read,
      }).poll();
      const gone = await vibeAdapterFor(quietSession(state), standInPids([])).poll();
      expect(sessions[0]?.status).toBe("finished");
      expect(sessions).toEqual(gone.sessions);
    },
  );

  test("a failed session stays failed", async () => {
    const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
    const { sessions } = await vibeAdapterFor(quietSession(failed(A)), standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "failed" });
  });

  test("`ps` is asked once about a lease another program has, and the session goes on showing as finished", async () => {
    const clock = handClock();
    const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
    const adapter = vibeAdapterFor(quietSession(), standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    for (const later of [0, MINUTE, HOUR]) {
      clock.advance(later);
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    }
    expect(ps.runs).toEqual([[LIVE_PID]]);
  });

  test("a session shown as finished that a Vibe takes back is asked about again, and open", async () => {
    const files = quietSession();
    const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
    const adapter = vibeAdapterFor(files, standInPids(), { readProcessStarts: ps.read });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });

    // A Vibe that took the session at 11:45, after the process with this ID began.
    takeLease(files, A, NOW - 15 * MINUTE);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });
    expect(ps.runs).toEqual([[LIVE_PID], [LIVE_PID]]);
  });

  test.each(["linux", "win32"] as const)(
    "on %s `ps` is not asked, so a lease whose process ID went to another program unseen stays as it is",
    async (platform) => {
      const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
      const { sessions } = await vibeAdapterFor(quietSession(), standInPids(), {
        platform,
        readProcessStarts: ps.read,
      }).poll();
      expect(statuses(sessions)).toEqual({ [A]: "working" });
      expect(ps.runs).toEqual([]);
    },
  );

  test.each(["linux", "win32"] as const)(
    "on %s a lease whose process was found gone stays left behind, whoever is given its process ID, until a program takes the lease",
    async (platform) => {
      const files = quietSession();
      const pids = standInPids();
      const ps = standInStarts();
      const adapter = vibeAdapterFor(files, pids, { platform, readProcessStarts: ps.read });
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });

      pids.set([]);
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
      pids.set([LIVE_PID]);
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });

      takeLease(files, A, NOW - 10 * MINUTE);
      expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });
      expect(ps.runs).toEqual([]);
    },
  );

  test("on a Mac, `ps` decides a lease whose process was found gone, once its process ID is back", async () => {
    const clock = handClock();
    const pids = standInPids();
    const starts: Record<number, string> = { [LIVE_PID]: BEFORE_LEASE };
    const ps = standInStarts(starts);
    const adapter = vibeAdapterFor(quietSession(), pids, {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);

    pids.set([]);
    clock.advance(SECOND);
    await adapter.poll();
    pids.set([LIVE_PID]);
    starts[LIVE_PID] = AFTER_LEASE;
    clock.advance(SECOND);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    expect(ps.runs).toHaveLength(2);
  });

  const noAnswers = [
    ["says nothing of the process", () => new Map<number, string>()],
    ["prints what is not a time", () => new Map([[LIVE_PID, "not a time"]])],
    [
      "fails",
      () => {
        throw new Error("ps could not be run");
      },
    ],
  ] as const;

  test.each(noAnswers)(
    "a session stays as it is while `ps` %s, and `ps` is asked again after 30 seconds",
    async (_, answer) => {
      const clock = handClock();
      const runs: (readonly number[])[] = [];
      const adapter = vibeAdapterFor(quietSession(), standInPids(), {
        now: clock.now,
        readProcessStarts: async (pids) => {
          runs.push(pids);
          return answer();
        },
      });
      for (const [later, expected] of [
        [0, 1],
        [29 * SECOND, 1],
        [SECOND, 2],
        [SECOND, 2],
      ] as const) {
        clock.advance(later);
        expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });
        expect(runs).toHaveLength(expected);
      }
    },
  );

  test("a lease `ps` could not answer for is told once it can", async () => {
    const clock = handClock();
    const starts: Record<number, string> = {};
    const ps = standInStarts(starts);
    const adapter = vibeAdapterFor(quietSession(), standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "working" });
    starts[LIVE_PID] = AFTER_LEASE;
    clock.advance(30 * SECOND);
    expect(statuses((await adapter.poll()).sessions)).toEqual({ [A]: "finished" });
    clock.advance(HOUR);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);
  });

  test("a lease taken after its process started stays open, as an app server's does", async () => {
    const files = quietFiles();
    writeStore(files, { id: A, state: running(A) });
    takeLease(files, A, NOW - 15 * MINUTE);
    const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "working" });
    expect(ps.runs).toEqual([[LIVE_PID]]);
  });

  test.each([
    ["Thu Oct  1 11:01:00 2026", "working"],
    ["Thu Oct  1 11:01:01 2026", "finished"],
  ])("a process that started at %s, after a lease taken at 11:00, is %s", async (start, status) => {
    const ps = standInStarts({ [LIVE_PID]: start });
    const { sessions } = await vibeAdapterFor(quietSession(), standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: status });
  });

  test("several leases on one process are asked about in one run, each by when it was taken", async () => {
    const files = quietSession();
    writeStore(files, { id: B, state: running(B) });
    takeLease(files, B, NOW - 15 * MINUTE);
    writeStore(files, { id: C, state: idle(C) });
    takeLease(files, C, NOW - 10 * MINUTE);
    // Began at 11:30: it took two of them, and was given the ID of whatever took the first.
    const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "finished", [B]: "working", [C]: "idle" });
    expect(ps.runs).toEqual([[LIVE_PID]]);
  });

  test("leases on several processes are asked about in one run", async () => {
    const files = quietSession();
    writeStore(files, { id: B, state: running(B) });
    writeLease(files, B, OTHER_PID);
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE, [OTHER_PID]: AFTER_LEASE });
    const { sessions } = await vibeAdapterFor(files, standInPids([LIVE_PID, OTHER_PID]), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "working", [B]: "finished" });
    expect(ps.runs).toEqual([[LIVE_PID, OTHER_PID]]);
  });

  test("a session only a left-behind lease keeps is not listed, and is not asked about again", async () => {
    const files = vibeFiles(() => NOW - 2 * DAY);
    writeStore(files, { id: A, state: running(A) });
    takeLease(files, A, NOW - 3 * DAY);
    const ps = standInStarts({ [LIVE_PID]: "Tue Sep 29 12:00:00 2026" });
    const adapter = vibeAdapterFor(files, standInPids(), { readProcessStarts: ps.read });
    for (let poll = 0; poll < 4; poll += 1) {
      expect((await adapter.poll()).sessions).toEqual([]);
    }
    expect(ps.runs).toEqual([[LIVE_PID]]);
  });

  test("a Vibe that keeps a session it last wrote to days ago stays listed", async () => {
    const files = vibeFiles(() => NOW - 2 * DAY);
    writeStore(files, { id: A, state: running(A) });
    takeLease(files, A, NOW - HOUR);
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE });
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "working" });
  });

  test("with no lease, a process that is gone, or a lease that names no process or no time, `ps` is not run", async () => {
    const files = quietFiles();
    writeStore(files, { id: A, state: running(A) });
    writeStore(files, { id: B, state: running(B) });
    writeLease(files, B, GONE_PID);
    writeStore(files, { id: C, state: running(C) });
    files.write(`${SESSION_DIR}/active/${C}.lock`, "");
    const untimed = sessionId("d1");
    writeStore(files, { id: untimed, state: running(untimed) });
    files.write(`${SESSION_DIR}/active/${untimed}.lock`, "");
    files.write(
      `${SESSION_DIR}/active/${untimed}.lock.json`,
      JSON.stringify({ process_id: LIVE_PID }),
    );
    const clock = handClock();
    const ps = standInStarts({ [LIVE_PID]: AFTER_LEASE });
    const adapter = vibeAdapterFor(files, standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    await adapter.poll();
    clock.advance(OLD_SESSION_LEASE_MS);
    const { sessions } = await adapter.poll();
    expect(statuses(sessions)).toEqual({
      [A]: "finished",
      [B]: "finished",
      [C]: "working",
      [untimed]: "working",
    });
    expect(ps.runs).toEqual([]);
  });

  test("a lease taken in the last 30 seconds with nothing written since is not asked about", async () => {
    const files = quietFiles();
    writeStore(files, { id: A, state: running(A) });
    takeLease(files, A, NOW - 10 * SECOND);
    const ps = standInStarts();
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "finished" });
    expect(ps.runs).toEqual([]);
  });

  test("a save counts as a write, so a session just saved is not asked about", async () => {
    const files = quietSession();
    files.rewrite(`${SESSION_DIR}/${storePath(A)}/CURRENT`, current({ id: A }), {
      mtimeMs: NOW - 10 * SECOND,
    });
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE });
    const { sessions } = await vibeAdapterFor(files, standInPids(), {
      readProcessStarts: ps.read,
    }).poll();
    expect(statuses(sessions)).toEqual({ [A]: "working" });
    expect(ps.runs).toEqual([]);
  });

  test("a session Vibe keeps writing to costs no run, and one that goes quiet costs one", async () => {
    const clock = handClock();
    const files = vibeFiles(clock.now);
    writeStore(files, { id: A, state: idle(A), journal: [delta(5, running(A))] });
    writeLease(files, A);
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE });
    const adapter = vibeAdapterFor(files, standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    for (let sequence = 6; sequence < 12; sequence += 1) {
      await adapter.poll();
      clock.advance(MINUTE - SECOND);
      add(files, delta(sequence, running(A)), clock.now());
    }
    expect(ps.runs).toEqual([]);

    clock.advance(MINUTE - SECOND);
    await adapter.poll();
    expect(ps.runs).toEqual([]);
    clock.advance(SECOND);
    await adapter.poll();
    expect(ps.runs).toEqual([[LIVE_PID]]);

    add(files, delta(12, running(A)), clock.now());
    clock.advance(HOUR);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);
  });

  test("leases already looked at cost no run, and a new one costs one, about itself alone", async () => {
    const clock = handClock();
    const files = quietSession();
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE, [OTHER_PID]: BEFORE_LEASE });
    const adapter = vibeAdapterFor(files, standInPids([LIVE_PID, OTHER_PID]), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    await adapter.poll();
    clock.advance(HOUR);
    await adapter.poll();
    expect(ps.runs).toEqual([[LIVE_PID]]);

    writeStore(files, { id: B, state: running(B) });
    writeLease(files, B, OTHER_PID);
    clock.advance(SECOND);
    await adapter.poll();
    clock.advance(HOUR);
    await adapter.poll();
    expect(ps.runs).toEqual([[LIVE_PID], [OTHER_PID]]);
  });

  test("a session that starts to wait under a lease already looked at is asked about at once, then every 30 seconds", async () => {
    const clock = handClock();
    const files = quietSession();
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE });
    const adapter = vibeAdapterFor(files, standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    await adapter.poll();
    clock.advance(MINUTE);
    await adapter.poll();
    expect(ps.runs).toHaveLength(1);

    add(files, callbackRegistered(6, { id: "ask-1", createdAt: clock.now() }), clock.now());
    clock.advance(SECOND);
    expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
    expect(ps.runs).toHaveLength(2);
    clock.advance(10 * SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(2);
    clock.advance(20 * SECOND);
    await adapter.poll();
    expect(ps.runs).toHaveLength(3);
  });

  test("each new wait under a lease already looked at costs one run, however close together", async () => {
    const clock = handClock();
    const files = quietSession();
    const ps = standInStarts({ [LIVE_PID]: BEFORE_LEASE });
    const adapter = vibeAdapterFor(files, standInPids(), {
      now: clock.now,
      readProcessStarts: ps.read,
    });
    await adapter.poll();

    let sequence = 6;
    for (let wait = 0; wait < 5; wait += 1) {
      const id = `ask-${wait}`;
      add(files, callbackRegistered(sequence++, { id, createdAt: clock.now() }), clock.now());
      clock.advance(2 * SECOND);
      expect((await adapter.poll()).sessions[0]?.status).toBe("needs-you");
      add(files, callbackResolved(sequence++, id), clock.now());
      clock.advance(2 * SECOND);
      await adapter.poll();
    }
    // The first wait falls within 30 seconds of the first answer, so it adds no run.
    expect(ps.runs).toHaveLength(5);
  });
});

describe("the token counts of the newest reply", () => {
  const FIRST = { input: 12_000, cached: 9_000, output: 340 };
  const SECOND_REPLY = { input: 13_500, cached: 12_000, output: 96 };
  const firstUsage = usage(12_000, 340, 9_000);
  const secondUsage = usage(13_500, 96, 12_000);

  /** A session this test can add to, held by a program that runs. */
  function heldSession(state: StateFields, journal: string[] = []) {
    const files = vibeFiles();
    writeStore(files, { id: A, state, journal });
    writeLease(files, A);
    return files;
  }

  const add = (files: ReturnType<typeof memoryFiles>, line: string, sequence = 4) =>
    files.append(`${SESSION_DIR}/${journalPath(A, sequence)}`, line, { mtimeMs: NOW + SECOND });

  test("come from the generation while the journal sets no state", async () => {
    const files = heldSession({ ...idle(A), contextUsage: firstUsage });
    expect((await vibeAdapterFor(files).poll()).sessions[0]?.tokens).toEqual(FIRST);
  });

  test("come from the journal when it holds a newer state than the generation", async () => {
    const files = heldSession({ ...idle(A), contextUsage: firstUsage }, [
      delta(5, { ...running(A), contextUsage: secondUsage }),
    ]);
    expect((await vibeAdapterFor(files).poll()).sessions[0]?.tokens).toEqual(SECOND_REPLY);
  });

  test("follow each reply as it is added, on the poll that finds it", async () => {
    const files = heldSession(idle(A), [delta(5, running(A))]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).not.toHaveProperty("tokens");
    add(files, delta(6, { ...running(A), contextUsage: firstUsage }));
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    add(files, delta(7, { ...running(A), contextUsage: secondUsage }));
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(SECOND_REPLY);
  });

  test("stand through a record that changes no count, as a rename, and one that sets no state", async () => {
    const files = heldSession(idle(A), [delta(5, { ...idle(A), contextUsage: firstUsage })]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    add(files, delta(6, { ...idle(A, "a new title"), contextUsage: firstUsage }));
    add(files, otherRecord("action_intent", 7));
    add(files, delta(8));
    const { sessions } = await adapter.poll();
    expect(sessions[0]).toMatchObject({ name: "a new title", tokens: FIRST });
  });

  test("stand through a save, from the new generation until its segment sets a state", async () => {
    const files = heldSession(idle(A), [delta(5, { ...idle(A), contextUsage: firstUsage })]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    writeStore(files, { id: A, sequence: 9, state: { ...idle(A), contextUsage: firstUsage } });
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    add(files, delta(10, { ...running(A), contextUsage: secondUsage }), 9);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(SECOND_REPLY);
  });

  test("never go back to an older generation's after a save that holds none", async () => {
    const files = heldSession(idle(A), [delta(5, { ...idle(A), contextUsage: firstUsage })]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    writeStore(files, { id: A, sequence: 9, state: idle(A) });
    expect((await adapter.poll()).sessions[0]).not.toHaveProperty("tokens");
  });

  test("are none after a rewind in place, which leaves the usage but no turn, until the next turn", async () => {
    const rewound = { ...idle(A), turn: null, contextUsage: firstUsage };
    const files = heldSession(idle(A), [delta(5, { ...idle(A), contextUsage: firstUsage })]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);

    writeStore(files, { id: A, sequence: 9, state: rewound });
    const afterRewind = (await adapter.poll()).sessions[0];
    expect(afterRewind?.status).toBe("idle");
    expect(afterRewind).not.toHaveProperty("tokens");

    add(files, delta(10, { ...rewound, title: "a new title" }), 9);
    const renamed = (await adapter.poll()).sessions[0];
    expect(renamed?.name).toBe("a new title");
    expect(renamed).not.toHaveProperty("tokens");

    // The next turn's state has a turn and the old usage: the limit Known gaps gives.
    add(files, delta(11, { ...running(A), contextUsage: firstUsage }), 9);
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "working", tokens: FIRST });

    add(files, delta(12, { ...running(A), contextUsage: secondUsage }), 9);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(SECOND_REPLY);
  });

  test("stand while the session waits for you, and when the wait is settled", async () => {
    const asked = NOW - 30 * SECOND;
    const files = heldSession(idle(A), [
      delta(5, { ...running(A), contextUsage: firstUsage }),
      callbackRegistered(6, { id: "approval-call-1", createdAt: asked }),
    ]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      tokens: FIRST,
    });
    add(files, callbackResolved(7, "approval-call-1"));
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "working", tokens: FIRST });
  });

  test("stand once no program holds the session", async () => {
    const files = vibeFiles();
    writeStore(files, { id: A, state: { ...idle(A), contextUsage: firstUsage } });
    expect((await vibeAdapterFor(files).poll()).sessions[0]).toMatchObject({
      status: "finished",
      tokens: FIRST,
    });
  });

  test("end at a compaction, with no older reply's in their place, until the next reply reports", async () => {
    const files = heldSession(idle(A), [delta(5, { ...running(A), contextUsage: firstUsage })]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    add(files, delta(6, { ...running(A), contextUsage: usage(0, 0) }));
    expect((await adapter.poll()).sessions[0]).not.toHaveProperty("tokens");
    add(files, delta(7, { ...running(A), contextUsage: secondUsage }));
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(SECOND_REPLY);
  });

  test("are none, with no older reply's in their place, for counts that could not be right", async () => {
    const files = heldSession(idle(A), [delta(5, { ...running(A), contextUsage: firstUsage })]);
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    for (const [sequence, contextUsage] of [
      "many",
      { ...secondUsage, inputTokens: "13500" },
      { ...secondUsage, totalTokens: 1 },
      usage(Number.MAX_SAFE_INTEGER + 1, 96),
      usage(13_500, 96, 13_501),
    ].entries()) {
      add(files, delta(6 + sequence, { ...running(A), contextUsage }));
      const { sessions } = await adapter.poll();
      expect(sessions[0]?.status, JSON.stringify(contextUsage)).toBe("working");
      expect(sessions[0], JSON.stringify(contextUsage)).not.toHaveProperty("tokens");
    }
  });

  test("are none for a store newer than this adapter knows, and read at the newest it knows", async () => {
    const files = vibeFiles();
    const state = { ...idle(A), contextUsage: firstUsage };
    writeStore(files, { id: A, minor: 10, state });
    writeLease(files, A);
    writeStore(files, { id: B, minor: 11, state: { ...state, id: B } });
    writeLease(files, B);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions.map((session) => session.id)).toEqual([
      `mistral-vibe:${A}`,
      `mistral-vibe:${B}`,
    ]);
    expect(sessions[0]).toMatchObject({ status: "idle", tokens: FIRST });
    expect(sessions[1]?.status).toBe("unknown");
    expect(sessions[1]).not.toHaveProperty("tokens");
  });

  test("are none while the newest state cannot be told, though the generation has some", async () => {
    const files = heldSession({ ...idle(A), contextUsage: firstUsage });
    const adapter = vibeAdapterFor(files);
    expect((await adapter.poll()).sessions[0]?.tokens).toEqual(FIRST);
    add(files, record("projection_advanced", 5, { snapshot: publicState(idle(A)), watermark: 5 }));
    expect((await adapter.poll()).sessions[0]).not.toHaveProperty("tokens");
  });

  test("are none while the newest state is past what was read, though the generation has some", async () => {
    const filler = otherRecord("action_result", 9).replace(PRIVATE_WORDS, "x".repeat(64 * 1024));
    const lines = [delta(5, { ...running(A), contextUsage: secondUsage })];
    while (lines.join("").length < TAIL_LIMIT_BYTES + 512 * 1024) lines.push(filler);
    const files = heldSession({ ...idle(A), contextUsage: firstUsage }, lines);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(sessions[0]).not.toHaveProperty("tokens");
  });

  test("are none while a journal not yet read cannot be read, though the generation has some", async () => {
    const files = heldSession({ ...idle(A), contextUsage: firstUsage }, [delta(5, running(A))]);
    files.fail(`${SESSION_DIR}/${journalPath(A)}`);
    const { sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]?.status).toBe("unknown");
    expect(sessions[0]).not.toHaveProperty("tokens");
  });

  test("open no file that is not read for the status", async () => {
    const opened = async (state: StateFields) => {
      const files = heldSession(state, [delta(5, state)]);
      const { io } = files;
      const paths: string[] = [];
      const adapter = vibeAdapterFor(files, standInPids(), {
        io: { ...io, openRegular: (target) => (paths.push(target), io.openRegular(target)) },
      });
      await adapter.poll();
      return { paths, session: (await adapter.poll()).sessions[0] };
    };
    const withCounts = await opened({ ...idle(A), contextUsage: firstUsage });
    const without = await opened(idle(A));
    expect(withCounts.session?.tokens).toEqual(FIRST);
    expect(without.session).not.toHaveProperty("tokens");
    expect(withCounts.paths).toEqual(without.paths);
  });
});
