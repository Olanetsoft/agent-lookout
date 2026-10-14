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
import type { ReadOnlyIo } from "@collector/files/readOnlyIo";
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
  current,
  delta,
  journalPath,
  leaseFile,
  otherRecord,
  record,
  publicState,
  sessionId,
  storePath,
  type StateFields,
} from "@tests/fixtures/mistralVibe";
import {
  handClock,
  healthy,
  memoryFiles,
  releaseLease,
  standInPids,
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
    writeStore(files, { id: A, minor: 9, state: running(A) });
    writeLease(files, A);
    const { health, sessions } = await vibeAdapterFor(files).poll();
    expect(sessions[0]).toMatchObject({ status: "unknown", name: "demo-project refactor" });
    expect(health.detail).toBe(healthy("~/.vibe/logs/session", NEWER_STORE_NOTE));
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

test("declares what it can report, the same on every poll", async () => {
  const adapter = vibeAdapterFor(vibeFiles());
  expect(adapter.capabilities).toBe(MISTRAL_VIBE_CAPABILITIES);
  expect(adapter.lookingIn).toBe("Looking for Mistral Vibe sessions in ~/.vibe/logs/session.");
  expect(MISTRAL_VIBE_CAPABILITIES["needs-you"].level).toBe("no");
  expect(MISTRAL_VIBE_CAPABILITIES.tokens.level).toBe("no");
});
