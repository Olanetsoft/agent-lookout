import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  BASIS,
  KIRO_CLI_CAPABILITIES,
  kiroHomeFor,
  kiroSessionsDirFor,
  OPEN_NOTE,
  PARTIAL_NOTE,
  passedOverNoteFor,
  TOO_LARGE_NOTE,
  UNCHECKED_NOTE,
  V2_NOTE,
} from "@collector/adapters/kiro-cli/index";
import { asWritten } from "@tests/support/paths";
import { MAX_HEADER_BYTES } from "@collector/adapters/kiro-cli/headers";
import {
  BUCKET,
  CREATED_AT,
  DAY,
  HOME,
  KIRO_HOME,
  LOCKED_AT,
  MINUTE,
  NOW,
  PID,
  PRIVATE_WORDS,
  PROJECT,
  lockText,
  sessionsDir,
  uuidOf,
  v2Clear,
  v2Paths,
  v2Prompt,
  v2Reply,
  v2ToolUse,
  v3Assistant,
  v3IdOf,
  v3Paths,
  v3Pending,
  v3Resolved,
  v3TurnEnd,
  v3TurnStart,
  v3User,
} from "@tests/fixtures/kiro-cli/kiroCli";
import {
  handClock,
  healthy,
  kiroCliAdapterFor,
  LOCK,
  memoryFiles,
  startsOf,
  writeV2,
  writeV3,
} from "@tests/support/adapters/kiro-cli/kiroCliAdapter";
import {
  createAnnouncements,
  createOpenWaits,
  seeded,
  watchWaits,
} from "@tests/support/waits/openWaits";

const V3 = v3IdOf(1);
const V2 = uuidOf(2);

describe("Kiro's folder", () => {
  /** Kiro's folder as the tests write paths, so Windows' drive and `\\` meet them. */
  const homeFor = (...given: Parameters<typeof kiroHomeFor>) => {
    const found = kiroHomeFor(...given);
    return { ...found, home: asWritten(found.home) };
  };

  test("is ~/.kiro, or the folder AGENT_LOOKOUT_KIRO_HOME names, which wins", () => {
    expect(homeFor({}, HOME, "darwin")).toEqual({
      home: KIRO_HOME,
      named: false,
      fromKiroHome: false,
      passedOver: false,
    });
    expect(
      homeFor({ AGENT_LOOKOUT_KIRO_HOME: "/tmp/kiro", KIRO_HOME: "/opt/kiro" }, HOME, "darwin"),
    ).toMatchObject({
      home: "/tmp/kiro",
      named: true,
    });
    expect(asWritten(kiroSessionsDirFor({}, HOME, "darwin"))).toBe(`${KIRO_HOME}/sessions`);
  });

  test("is KIRO_HOME when Kiro takes it: an absolute path that is not a root, the home folder or above it", () => {
    for (const value of ["/opt/kiro-work", `${HOME}/kiro-work`, " /opt/kiro-work "]) {
      expect(homeFor({ KIRO_HOME: value }, HOME, "darwin"), value).toMatchObject({
        home: value.trim(),
        fromKiroHome: true,
        passedOver: false,
      });
    }
    for (const value of ["/", HOME, `${HOME}/`, "/Users", "kiro-work", "./kiro", "~/kiro"]) {
      expect(homeFor({ KIRO_HOME: value }, HOME, "darwin"), value).toEqual({
        home: KIRO_HOME,
        named: false,
        fromKiroHome: false,
        passedOver: true,
      });
    }
    // Empty is not set.
    expect(homeFor({ KIRO_HOME: "  " }, HOME, "darwin").passedOver).toBe(false);
  });

  test("follows Windows' rules on Windows, with no regard to case", () => {
    const home = "C:\\Users\\example";
    expect(kiroHomeFor({ KIRO_HOME: "D:\\kiro" }, home, "win32").fromKiroHome).toBe(true);
    for (const value of ["C:\\", "c:\\users\\EXAMPLE", "C:\\Users"]) {
      expect(kiroHomeFor({ KIRO_HOME: value }, home, "win32").passedOver, value).toBe(true);
    }
  });
});

describe("the Kiro CLI adapter", () => {
  test("says calmly when Kiro is not on this computer, and looks again only once a minute", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    const adapter = kiroCliAdapterFor(files, { now: clock.now });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("unavailable");
    expect(health.detail).toBe(
      "Kiro CLI was not found: there is no ~/.kiro folder. Agent Lookout looks again every minute.",
    );
    expect(sessions).toEqual([]);
    files.forget();
    clock.advance(30_000);
    await adapter.poll();
    expect(files.calls).toEqual([]);
    clock.advance(30_000);
    await adapter.poll();
    expect(files.calls.length).toBeGreaterThan(0);
  });

  test("names KIRO_HOME when Kiro's folder is missing there, and says when KIRO_HOME is passed over", async () => {
    const files = memoryFiles(() => NOW);
    const there = kiroCliAdapterFor(files, { env: { KIRO_HOME: "/opt/kiro-work" } });
    expect((await there.poll()).health.detail).toBe(
      `Kiro CLI was not found: KIRO_HOME is set, and there is no ${path.resolve("/opt/kiro-work")} folder. Agent Lookout looks again every minute.`,
    );
    const passedOver = "KIRO_HOME is set to a folder Kiro does not use, so ~/.kiro is read.";
    // On the Not found card, the card that cannot read the sessions folder, and the healthy card.
    const missing = kiroCliAdapterFor(files, { env: { KIRO_HOME: "kiro-work" } });
    expect((await missing.poll()).health).toMatchObject({
      state: "unavailable",
      detail: `Kiro CLI was not found: there is no ~/.kiro folder. Agent Lookout looks again every minute. ${passedOver}`,
    });
    files.special(sessionsDir());
    const unreadable = (await kiroCliAdapterFor(files, { env: { KIRO_HOME: "kiro-work" } }).poll())
      .health;
    expect(unreadable.state).toBe("error");
    expect(unreadable.detail).toContain(passedOver);
    files.remove(sessionsDir());
    files.mkdir(sessionsDir());
    const passed = kiroCliAdapterFor(files, { env: { KIRO_HOME: "kiro-work" } });
    expect((await passed.poll()).health.detail).toContain(passedOver);
  });

  test("keeps every note on its card to 130 characters", () => {
    for (const note of [
      V2_NOTE,
      OPEN_NOTE,
      UNCHECKED_NOTE,
      TOO_LARGE_NOTE,
      PARTIAL_NOTE,
      passedOverNoteFor("~/.kiro"),
    ]) {
      expect(note.length, note).toBeLessThanOrEqual(130);
    }
  });

  test("with a folder named for it that is missing, lists nothing and is not missing", async () => {
    const files = memoryFiles(() => NOW);
    const adapter = kiroCliAdapterFor(files, { env: { AGENT_LOOKOUT_KIRO_HOME: "/tmp/kiro" } });
    const { health, sessions } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(
      health.detail?.startsWith(
        `AGENT_LOOKOUT_KIRO_HOME is set, and there is no ${path.resolve("/tmp/kiro")} folder`,
      ),
      health.detail,
    ).toBe(true);
    expect(sessions).toEqual([]);
  });

  test("with Kiro's folder and no sessions folder, says it has saved none yet", async () => {
    const files = memoryFiles(() => NOW);
    files.mkdir(KIRO_HOME);
    const { health, sessions } = await kiroCliAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toMatch(/^Kiro CLI has not saved any sessions in ~\/\.kiro yet\./);
    expect(sessions).toEqual([]);
  });

  test("says so when the sessions folder is a link or cannot be listed", async () => {
    for (const change of ["link", "fail"] as const) {
      const files = memoryFiles(() => NOW);
      if (change === "link") files.special(sessionsDir());
      else {
        files.mkdir(sessionsDir());
        files.fail(sessionsDir());
      }
      const { health } = await kiroCliAdapterFor(files).poll();
      expect(health.state, change).toBe("error");
      expect(health.detail, change).toMatch(
        /^Kiro CLI sessions could not be read: ~\/\.kiro\/sessions/,
      );
    }
  });

  test("reads V3's store and V2's side by side, each session by its own ID", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3User() + v3TurnStart(NOW - 5 * MINUTE), lock: LOCK });
    writeV2(files, V2, { log: v2Prompt(NOW - 20 * MINUTE) + v2Reply(), lock: LOCK });
    const { health, sessions, basis } = await kiroCliAdapterFor(files).poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(healthy());
    expect(basis).toBe(BASIS);
    expect(sessions).toEqual([
      {
        id: `kiro-cli:${V3}`,
        source: "kiro-cli",
        surface: "unknown",
        name: "Tidy the demo tests",
        cwd: PROJECT,
        project: "demo-project",
        status: "working",
        startedAt: CREATED_AT,
        statusSince: NOW - 5 * MINUTE,
        lastWriteAt: NOW - MINUTE,
        pid: PID,
        alive: true,
        links: {},
        stale: false,
      },
      {
        id: `kiro-cli:${V2}`,
        source: "kiro-cli",
        surface: "unknown",
        // V2's title is the first prompt word for word, so the session takes its folder's name.
        name: "demo-project",
        cwd: PROJECT,
        project: "demo-project",
        status: "idle",
        startedAt: CREATED_AT,
        statusSince: NOW - MINUTE,
        lastWriteAt: NOW - MINUTE,
        pid: PID,
        alive: true,
        links: {},
        stale: false,
      },
    ]);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("shows a V3 session needing you from the moment Kiro asked, until it is answered", async () => {
    const files = memoryFiles(() => NOW);
    const paths = writeV3(files, V3, {
      log: v3TurnStart(NOW - 5 * MINUTE) + v3Pending("call-1", NOW - 2 * MINUTE),
      lock: LOCK,
    });
    const adapter = kiroCliAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      statusSince: NOW - 2 * MINUTE,
    });
    files.append(paths.log, v3Assistant(), { mtimeMs: NOW });
    expect((await adapter.poll()).sessions[0]).toMatchObject({ statusSince: NOW - 2 * MINUTE });
    files.append(paths.log, v3Resolved("call-1"), { mtimeMs: NOW + 1 });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: NOW - 5 * MINUTE,
    });
    files.append(paths.log, v3TurnEnd(NOW - 10_000), { mtimeMs: NOW + 2 });
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "idle",
      statusSince: NOW - 10_000,
    });
  });

  test("announces two approvals once, and keeps the first one's time until both are answered", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    const paths = writeV3(files, V3, { log: v3TurnStart(NOW - 5 * MINUTE), lock: LOCK });
    const adapter = kiroCliAdapterFor(files, { now: clock.now });
    const watch = watchWaits(adapter, clock.now);
    const poll = async (...rows: string[]) => {
      clock.advance(2_000);
      if (rows.length > 0) files.append(paths.log, rows.join(""), { mtimeMs: clock.now() });
      return watch();
    };
    const waits = (since: number, announced = 0) => ({
      status: "needs-you",
      since,
      started: announced,
      stopped: 0,
    });
    expect((await poll()).status).toBe("working");
    const a = v3Pending("call-A", NOW + 2_000);
    const b = v3Pending("call-B", NOW + 3_000);
    expect(await poll(a, b)).toEqual(waits(NOW + 2_000, 1));
    expect(await poll()).toEqual(waits(NOW + 2_000));
    expect(await poll(v3Resolved("call-A"))).toEqual(waits(NOW + 2_000));
    // Asked again while the other waits, and answered.
    expect(await poll(v3Pending("call-A", NOW + 9_000))).toEqual(waits(NOW + 2_000));
    expect(await poll(v3Resolved("call-A"))).toEqual(waits(NOW + 2_000));
    // A run begun now reads the same time from the log.
    const later = watchWaits(kiroCliAdapterFor(files, { now: clock.now }), clock.now);
    expect(await later()).toEqual(waits(NOW + 2_000));

    // Answered and asked again between two polls, with nothing else open: a new wait.
    expect(await poll(v3Resolved("call-B"), v3Pending("call-B", NOW + 13_000))).toEqual({
      status: "needs-you",
      since: NOW + 13_000,
      started: 1,
      stopped: 1,
    });
    expect((await poll(v3Resolved("call-B"))).status).toBe("working");
  });

  test("agrees with the model of open waits, through answers, calls asked again, turns, files that cannot be read and restarts", async () => {
    for (let seed = 1; seed <= 150; seed += 1) {
      const random = seeded(seed);
      const pick = <T>(of: readonly T[]) => of[Math.floor(random() * of.length)] as T;
      const files = memoryFiles(() => NOW);
      const clock = handClock(NOW);
      const paths = writeV3(files, V3, { log: v3TurnStart(NOW), lock: LOCK });
      const model = createOpenWaits();
      const announcements = createAnnouncements();
      let watch = watchWaits(kiroCliAdapterFor(files, { now: clock.now }), clock.now);
      for (let polled = 0; polled < 60; polled += 1) {
        for (let left = Math.floor(random() * 4); left > 0; left -= 1) {
          clock.advance(1 + Math.floor(random() * 900));
          const at = clock.now();
          const call = pick(["call-A", "call-B", "call-C"]);
          const step = random();
          if (step < 0.45) {
            files.append(paths.log, v3Pending(call, at), { mtimeMs: at });
            model.ask(call, at);
          } else if (step < 0.9) {
            files.append(paths.log, v3Resolved(call, at), { mtimeMs: at });
            model.answer(call);
          } else {
            files.append(paths.log, v3TurnEnd(at) + v3TurnStart(at), { mtimeMs: at });
            model.clear();
          }
        }
        clock.advance(2_000);
        const restarts = random() < 0.05;
        if (restarts) {
          watch = watchWaits(kiroCliAdapterFor(files, { now: clock.now }), clock.now);
          announcements.restart();
        }
        const unread = random() < 0.1 ? pick([paths.log, paths.header]) : null;
        if (unread !== null) files.fail(unread);
        const since = unread === null ? model.since() : null;
        const { status, ...shown } = await watch();
        expect(shown, `seed ${seed}, poll ${polled}`).toEqual({
          since,
          ...announcements.poll(since),
        });
        expect(status === "needs-you").toBe(since !== null);
        if (unread !== null) files.heal(unread);
      }
    }
  });

  test("shows a V2 session working from its newest prompt, never needing you, and idle once a reply has no tool", async () => {
    const files = memoryFiles(() => NOW);
    const paths = writeV2(files, V2, { log: v2Prompt(NOW - 3 * MINUTE) + v2ToolUse(), lock: LOCK });
    const adapter = kiroCliAdapterFor(files);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: NOW - 3 * MINUTE,
    });
    files.append(paths.log, v2Reply() + v2Clear(), { mtimeMs: NOW });
    expect((await adapter.poll()).sessions[0]).toMatchObject({ status: "idle", statusSince: NOW });
  });

  test("shows a session with no lock, or a lock whose process has ended, as finished whatever its log says", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart() });
    writeV2(files, V2, { log: v2Prompt(), lock: LOCK });
    const { sessions } = await kiroCliAdapterFor(files, { isAlive: () => false }).poll();
    expect(sessions.map((one) => [one.id, one.status, one.statusSince])).toEqual([
      [`kiro-cli:${V3}`, "finished", NOW - MINUTE],
      [`kiro-cli:${V2}`, "finished", NOW - MINUTE],
    ]);
    for (const one of sessions) {
      expect(one).not.toHaveProperty("pid");
      expect(one).not.toHaveProperty("alive");
    }
    // The log of a closed session is not opened.
    expect(files.opened().some((file) => file.endsWith(".jsonl"))).toBe(false);
  });

  test("finishes a session whose lock's pid was given to a program that started later, and keeps it so while that runs", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    const clock = handClock(NOW);
    let starts = startsOf({ [PID]: LOCKED_AT + 2 * MINUTE });
    const adapter = kiroCliAdapterFor(files, {
      now: clock.now,
      readProcessStarts: (pids) => starts(pids),
    });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
    // A later ps that cannot say does not open it again.
    starts = startsOf({});
    clock.advance(31_000);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("finishes a session whose lock was taken before the computer started", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    const adapter = kiroCliAdapterFor(files, { uptimeMs: () => 10 * MINUTE, platform: "linux" });
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("where a lock's process cannot be checked, reads the status from the log, with no pid", async () => {
    for (const options of [
      { platform: "linux" as const },
      { platform: "win32" as const },
      { readProcessStarts: startsOf({}) },
      { readProcessStarts: async () => Promise.reject(new Error("no ps")) },
    ]) {
      const files = memoryFiles(() => NOW);
      writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
      writeV2(files, V2, { log: v2Prompt(), lock: lockText(PID, "not a time") });
      const { sessions } = await kiroCliAdapterFor(files, options).poll();
      expect(
        sessions.map((one) => one.status),
        JSON.stringify(options),
      ).toEqual(["working", "working"]);
      for (const one of sessions) expect(one).not.toHaveProperty("pid");
    }
  });

  test("asks ps only on a Mac, only about live locks' processes, and only every 30 seconds", async () => {
    const asked: number[][] = [];
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    writeV2(files, V2, { log: v2Prompt(), lock: lockText(PID + 1) });
    const clock = handClock(NOW);
    const adapter = kiroCliAdapterFor(files, {
      now: clock.now,
      isAlive: (pid) => pid === PID,
      readProcessStarts: async (pids) => {
        asked.push([...pids]);
        return startsOf({ [PID]: LOCKED_AT })(pids);
      },
    });
    await adapter.poll();
    clock.advance(2_000);
    await adapter.poll();
    expect(asked).toEqual([[PID]]);
    clock.advance(30_000);
    await adapter.poll();
    expect(asked).toEqual([[PID], [PID]]);

    asked.length = 0;
    await kiroCliAdapterFor(files, {
      platform: "linux",
      readProcessStarts: async (pids) => {
        asked.push([...pids]);
        return new Map();
      },
    }).poll();
    expect(asked).toEqual([]);
  });

  test("reads the status from the log when a lock cannot be read", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart() + v3TurnEnd(), lock: "{" });
    const paths = v2Paths(V2);
    writeV2(files, V2, { log: v2Prompt() });
    files.special(paths.lock);
    const { sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions.map((one) => one.status)).toEqual(["idle", "working"]);
  });

  test("shows an open session as unknown, never idle, when its log is not an ordinary file or cannot be looked up", async () => {
    for (const change of ["link", "folder", "fail"] as const) {
      const files = memoryFiles(() => NOW);
      const v3 = writeV3(files, V3, { lock: LOCK });
      const v2 = writeV2(files, V2, { lock: LOCK });
      for (const log of [v3.log, v2.log]) {
        if (change === "link") files.special(log);
        if (change === "folder") files.mkdir(log);
        if (change === "fail") {
          files.write(log, "", { mtimeMs: NOW - MINUTE });
          files.fail(log);
        }
      }
      const { sessions } = await kiroCliAdapterFor(files).poll();
      expect(
        sessions.map((one) => [one.status, one.statusSince, one.lastWriteAt]),
        change,
      ).toEqual([
        ["unknown", null, undefined],
        ["unknown", null, undefined],
      ]);
      expect(files.opened(), change).not.toContain(v3.log);
      expect(files.opened(), change).not.toContain(v2.log);
    }
  });

  test("finishes a session whose lock a crash left behind once a read of it that failed works", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    const paths = writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    files.failOpen(paths.lock, "EIO");
    const adapter = kiroCliAdapterFor(files, { now: clock.now, isAlive: () => false });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    files.heal(paths.lock);
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]?.status).toBe("finished");
  });

  test("takes a folder at a V2 lock's name for no lock", async () => {
    const files = memoryFiles(() => NOW);
    writeV2(files, V2, { log: v2Prompt() });
    files.mkdir(v2Paths(V2).lock);
    expect((await kiroCliAdapterFor(files).poll()).sessions[0]?.status).toBe("finished");
  });

  test("names a session by its folder when it has no title, and never by what was typed", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3User(), lock: LOCK, header: { title: "(no title)" } });
    writeV2(files, V2, { log: v2Prompt(), lock: LOCK, header: { title: "   " } });
    const third = uuidOf(3);
    writeV2(files, third, { log: v2Prompt(), header: { title: undefined, cwd: "code/demo" } });
    const { sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions.map((one) => one.name)).toEqual([
      "demo-project",
      "demo-project",
      `kiro-cli:${third}`,
    ]);
    expect(JSON.stringify(sessions)).not.toContain(PRIVATE_WORDS);
  });

  test("is idle while open with no log yet, or a log with no turn row", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { lock: LOCK });
    writeV2(files, V2, { log: "", lock: LOCK });
    const { sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions.map((one) => [one.status, one.statusSince, one.lastWriteAt])).toEqual([
      ["idle", NOW - MINUTE, undefined],
      ["idle", NOW - MINUTE, NOW - MINUTE],
    ]);
  });

  test("lists a session forked by a rewind or a tangent, in either store", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, {
      log: v3TurnStart(),
      lock: LOCK,
      header: { createdReason: "rewind", parentSessionId: v3IdOf(9) },
    });
    writeV2(files, V2, {
      log: v2Prompt(),
      lock: LOCK,
      header: { parent_session_id: uuidOf(9), session_created_reason: "rewind" },
    });
    const third = uuidOf(3);
    writeV2(files, third, {
      log: v2Prompt(),
      lock: LOCK,
      header: { parent_session_id: uuidOf(9), session_created_reason: "tangent" },
    });
    const { sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions.map((one) => one.id)).toEqual([
      `kiro-cli:${V3}`,
      `kiro-cli:${V2}`,
      `kiro-cli:${third}`,
    ]);
  });

  test("leaves out a subagent's session, a session folder or header that is a link, and other names", async () => {
    const files = memoryFiles(() => NOW);
    writeV2(files, V2, { log: v2Prompt(), lock: LOCK, header: { parent_session_id: uuidOf(9) } });
    writeV3(files, v3IdOf(3), {
      log: v3TurnStart(),
      lock: LOCK,
      header: { createdReason: "subagent", parentSessionId: v3IdOf(9) },
    });
    files.special(v3Paths(v3IdOf(4)).folder);
    files.special(v3Paths(v3IdOf(5)).header);
    files.write(`${sessionsDir()}/cli/${uuidOf(6)}.history`, PRIVATE_WORDS);
    files.mkdir(`${sessionsDir()}/cli/${uuidOf(7)}`);
    files.write(`${sessionsDir()}/${BUCKET}/sess_not-a-uuid/session.json`, "{}");
    files.write(`${sessionsDir()}/${BUCKET}/${v3IdOf(8)}/sub-executions/one.jsonl`, v3TurnStart());
    files.special(`${sessionsDir()}/linked-bucket`);
    const { sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(files.opened().sort()).toEqual([v2Paths(V2).header, v3Paths(v3IdOf(3)).header].sort());
  });

  test("does not read a bucket named cli as V3's, and passes over a bucket it cannot list, saying so", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    files.write(`${sessionsDir()}/cli/${v3IdOf(2)}/session.json`, "{}");
    files.mkdir(`${sessionsDir()}/0f0f0f0f0f0f0f0f`);
    files.fail(`${sessionsDir()}/0f0f0f0f0f0f0f0f`);
    // The failing bucket is looked up with lstat too, which fails: it is passed over as no folder.
    const { health, sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions.map((one) => one.id)).toEqual([`kiro-cli:${V3}`]);
    expect(health.detail).not.toContain(PARTIAL_NOTE);

    files.heal(`${sessionsDir()}/0f0f0f0f0f0f0f0f`);
    const listing = files.io.readdir;
    files.io.readdir = async (dir) => {
      if (dir.endsWith("0f0f0f0f0f0f0f0f"))
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return listing(dir);
    };
    expect((await kiroCliAdapterFor(files).poll()).health.detail).toContain(PARTIAL_NOTE);
  });

  test("says when a header is over 4 MiB, and leaves its session out", async () => {
    const files = memoryFiles(() => NOW);
    writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    files.write(v3Paths(V3).header, " ".repeat(MAX_HEADER_BYTES + 1), { mtimeMs: NOW - MINUTE });
    const { health, sessions } = await kiroCliAdapterFor(files).poll();
    expect(sessions).toEqual([]);
    expect(health.detail).toContain(TOO_LARGE_NOTE);
  });

  test("keeps a finished session for a day after its last write, or after it was last seen open", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    let alive = true;
    writeV3(files, V3, { log: v3TurnStart(), lock: LOCK, writtenAt: NOW - 2 * DAY });
    const adapter = kiroCliAdapterFor(files, { now: clock.now, isAlive: () => alive });
    expect((await adapter.poll()).sessions[0]?.status).toBe("working");
    alive = false;
    clock.advance(2_000);
    expect((await adapter.poll()).sessions[0]).toMatchObject({
      status: "finished",
      statusSince: NOW,
    });
    clock.advance(DAY - 2_000);
    expect((await adapter.poll()).sessions).toEqual([]);
  });

  test("looks up an old session with no lock only for its lock until the sweep, and lists it at once when one appears", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    const v3 = writeV3(files, V3, { log: v3TurnEnd(), writtenAt: NOW - 2 * DAY });
    const v2 = writeV2(files, V2, { log: v2Reply(), writtenAt: NOW - 2 * DAY });
    const adapter = kiroCliAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);

    files.forget();
    clock.advance(2_000);
    expect((await adapter.poll()).sessions).toEqual([]);
    const looked = files.calls.filter((call) => call.method === "lstat").map((call) => call.path);
    expect(looked).not.toContain(v3.header);
    expect(looked).not.toContain(v2.header);
    expect(looked).toContain(v3.lock);
    expect(files.opened()).toEqual([]);

    files.write(v3.lock, LOCK);
    files.write(v2.lock, LOCK);
    clock.advance(2_000);
    expect((await adapter.poll()).sessions.map((one) => one.status)).toEqual(["idle", "idle"]);
  });

  test("between sweeps, opens no lock in a settled session's folder that a link has taken the place of", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    const v3 = writeV3(files, V3, { log: v3TurnEnd(), writtenAt: NOW - 2 * DAY });
    const adapter = kiroCliAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions).toEqual([]);
    // The folder is now a link, to a folder that holds a lock.
    files.write(v3.lock, LOCK);
    files.special(v3.folder);
    files.forget();
    clock.advance(2_000);
    expect((await adapter.poll()).sessions).toEqual([]);
    expect(files.calls.map((call) => call.path)).not.toContain(v3.lock);
  });

  test("finds an old session written again at the next sweep", async () => {
    const files = memoryFiles(() => NOW);
    const clock = handClock(NOW);
    const v3 = writeV3(files, V3, { log: v3TurnEnd(), writtenAt: NOW - 2 * DAY });
    const adapter = kiroCliAdapterFor(files, { now: clock.now });
    await adapter.poll();
    files.append(v3.log, v3TurnStart(), { mtimeMs: NOW + 10_000 });
    clock.advance(10_000);
    expect((await adapter.poll()).sessions).toEqual([]);
    clock.advance(MINUTE);
    expect((await adapter.poll()).sessions.map((one) => one.status)).toEqual(["finished"]);
  });

  test("reads a session's files, and a log only while it is open or not known to be closed, without writing", async () => {
    const files = memoryFiles(() => NOW);
    const v3 = writeV3(files, V3, { log: v3TurnStart(), lock: LOCK });
    await kiroCliAdapterFor(files).poll();
    expect(files.opened().sort()).toEqual([v3.header, v3.lock, v3.log].sort());
    expect(files.openHandles()).toBe(0);
  });

  test("declares what it can report", async () => {
    expect(kiroCliAdapterFor(memoryFiles()).capabilities).toBe(KIRO_CLI_CAPABILITIES);
    expect(KIRO_CLI_CAPABILITIES.failed.level).toBe("no");
  });
});
