import { describe, expect, test } from "vitest";

import {
  BASIS,
  BASIS_CLOSED,
  BASIS_WITHOUT_PROCESSES,
  DOTTED_DETAIL,
  FILES_ONLY_NOTE,
  FX_CAPABILITIES,
  NEWER_FORMAT_NOTE,
  OTHER_SYSTEM_DETAIL,
  PROCESS_CHECK_MS,
  PROMPT_PROCESS_CHECK_MS,
  RECHECK_MS,
  STATUS_NOTE,
  SWEEP_MS,
  UNCHECKED_NOTE,
  UNKNOWN_END_NOTE,
  WINDOWS_DETAIL,
} from "@collector/adapters/fx/index";
import { KNOWN_WAYS } from "@collector/remotes/remoteSessions";
import type { AdapterResult } from "@collector/adapters/adapter";
import {
  CHILD_ID,
  DAY,
  frame,
  HOUR,
  fxLog,
  INDEX_LINE,
  logPath,
  MINUTE,
  NOW,
  OTHER_ID,
  PRIVATE_WORDS,
  SECOND,
  SESSION_ID,
  STARTED_AT,
  V2,
  WORKSPACE,
} from "@tests/fixtures/fx/fx";
import {
  FX_PID,
  fxAdapterFor,
  handClock,
  memoryFiles,
  standInFxProcesses,
  writeSession,
} from "@tests/support/adapters/fx/fxAdapter";

const ALWAYS = `${STATUS_NOTE} ${FILES_ONLY_NOTE} ${UNCHECKED_NOTE}`;
const HEALTHY = `Sessions are read from the log fx keeps for each in ~/.fx/sessions/v2. ${ALWAYS}`;

function watching(
  read: string,
  processCheckRun = "every 10 seconds at most, every 2 seconds at most while sessions are written and ps shows no fx",
) {
  return [
    { label: "Sessions folder", value: "~/.fx/sessions/v2" },
    { label: "Read", value: read },
    { label: "Process check", value: "ps -A -o pid=,comm=" },
    { label: "Process check run", value: processCheckRun },
  ];
}

/** Files with one session's log, written at `mtimeMs`. */
function withLog(text: string, mtimeMs = NOW - 10 * SECOND, id = SESSION_ID) {
  const files = memoryFiles();
  writeSession(files, id, text, { mtimeMs });
  return files;
}

const statusOf = (result: AdapterResult, id = SESSION_ID) =>
  result.sessions.find((session) => session.id === `fx:${id}`)?.status;

describe("where it looks", () => {
  test("in ~/.fx/sessions/v2, saying so while it looks", () => {
    const adapter = fxAdapterFor(memoryFiles());
    expect(adapter.lookingIn).toBe("Looking for fx sessions in ~/.fx/sessions/v2.");
    expect(adapter.capabilities).toBe(FX_CAPABILITIES);
    expect(adapter.id).toBe("fx");
    expect(adapter.label).toBe("fx");
  });

  test("in the folder FX_HOME names, as fx takes it", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().turnStarted().text(), { dir: "/data/fx/sessions/v2" });
    const result = await fxAdapterFor(files, { env: { FX_HOME: "/data/fx/" } }).poll();
    expect(result.sessions.map((session) => session.id)).toEqual([`fx:${SESSION_ID}`]);
  });

  test("nowhere when FX_HOME names it through . or .., with nothing looked at and no ps", async () => {
    const files = memoryFiles();
    const processes = standInFxProcesses();
    const result = await fxAdapterFor(files, { env: { FX_HOME: "/data/../fx" }, processes }).poll();
    expect(result.health).toMatchObject({ state: "unavailable", detail: DOTTED_DETAIL });
    expect(result.sessions).toEqual([]);
    expect(files.count()).toBe(0);
    expect(processes.asked.count).toBe(0);
  });
});

describe("an fx that is not there", () => {
  test("is not found, calmly, its folder looked for again only once a minute, and no ps is run", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const processes = standInFxProcesses();
    const adapter = fxAdapterFor(files, { now: clock.now, processes });
    const { health, sessions } = await adapter.poll();
    expect(health).toEqual({
      id: "fx",
      label: "fx",
      state: "unavailable",
      detail:
        "fx was not found: there is no ~/.fx/sessions/v2 folder. Agent Lookout looks again every minute.",
      watching: watching("not found"),
      checkedAt: NOW,
    });
    expect(sessions).toEqual([]);
    const looks = files.count();
    clock.advance(RECHECK_MS - SECOND);
    await adapter.poll();
    expect(files.count()).toBe(looks);
    clock.advance(SECOND);
    await adapter.poll();
    expect(files.count()).toBeGreaterThan(looks);
    expect(processes.asked.count).toBe(0);
  });

  test("named by AGENT_LOOKOUT_FX_HOME with no sessions folder in it, that is an answer, looked at on every poll", async () => {
    const files = memoryFiles();
    const clock = handClock();
    const adapter = fxAdapterFor(files, {
      env: { AGENT_LOOKOUT_FX_HOME: "/tmp/empty-fx" },
      now: clock.now,
    });
    const { health } = await adapter.poll();
    expect(health.state).toBe("ok");
    expect(health.detail).toBe(
      `AGENT_LOOKOUT_FX_HOME is set, and there is no /tmp/empty-fx/sessions/v2 folder, so no fx sessions are listed. ${ALWAYS}`.replace(
        "/tmp/empty-fx/sessions/v2",
        (health.watching?.[0]?.value as string) ?? "",
      ),
    );
    const looks = files.count();
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(files.count()).toBeGreaterThan(looks);
  });

  test("a folder that cannot be looked at is an error", async () => {
    const files = memoryFiles();
    files.fail(`/Users/example/.fx`, "EACCES");
    const { health } = await fxAdapterFor(files).poll();
    expect(health).toMatchObject({
      state: "error",
      detail: "fx sessions could not be read: ~/.fx/sessions/v2 could not be looked at.",
    });
  });
});

describe("links", () => {
  test("a link at .fx, sessions or v2 is not followed, nothing is read, and it is looked at again a minute later", async () => {
    for (const at of ["/Users/example/.fx", "/Users/example/.fx/sessions", V2]) {
      const files = memoryFiles();
      files.special(at);
      const clock = handClock();
      const processes = standInFxProcesses();
      const adapter = fxAdapterFor(files, { now: clock.now, processes });
      const { health, sessions } = await adapter.poll();
      expect(health.state, at).toBe("unavailable");
      expect(health.detail, at).toContain("is a link or not a folder");
      expect(sessions).toEqual([]);
      expect(files.count("readdir"), at).toBe(0);
      expect(files.opened(), at).toEqual([]);
      const looks = files.count();
      clock.advance(RECHECK_MS - SECOND);
      await adapter.poll();
      expect(files.count(), at).toBe(looks);
      expect(processes.asked.count).toBe(0);
    }
  });

  test("a link at a session's folder or at its log is passed over, and the folder is looked at before every open", async () => {
    const files = withLog(fxLog().turnStarted().text());
    files.special(`${V2}/${OTHER_ID}`);
    files.mkdir(`${V2}/linkedLog001`);
    files.special(`${V2}/linkedLog001/log.jsonl`);
    files.touch(V2, 99);
    const clock = handClock();
    const adapter = fxAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([
      `fx:${SESSION_ID}`,
    ]);
    expect(files.opened()).toEqual([logPath(SESSION_ID)]);

    // Written again, the log is opened again, each time after its folder is looked at.
    files.append(logPath(SESSION_ID), fxLog().turnStarted().item().since(2), { mtimeMs: NOW });
    files.forget();
    clock.advance(2 * SECOND);
    await adapter.poll();
    const order = files.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf(`lstat ${V2}/${SESSION_ID}`)).toBeLessThan(
      order.indexOf(`openRegular ${logPath(SESSION_ID)}`),
    );
    expect(order.indexOf(`openRegular ${logPath(SESSION_ID)}`)).toBeGreaterThan(-1);
  });
});

describe("other systems", () => {
  test("on Windows and any other system nothing is looked at and ps is never run", async () => {
    for (const [platform, detail, read, run] of [
      ["win32", WINDOWS_DETAIL, "not on Windows", "not run on Windows"],
      ["freebsd", OTHER_SYSTEM_DETAIL, "not on this system", "not run on this system"],
    ] as const) {
      const files = withLog(fxLog().turnStarted().text());
      files.forget();
      const processes = standInFxProcesses();
      const { health, sessions } = await fxAdapterFor(files, { platform, processes }).poll();
      expect(health.state, platform).toBe("unavailable");
      expect(health.detail, platform).toBe(detail);
      expect(health.watching?.slice(1), platform).toEqual(watching(read, run).slice(1));
      expect(sessions).toEqual([]);
      expect(files.count(), platform).toBe(0);
      expect(processes.asked.count, platform).toBe(0);
    }
  });

  test("on Linux it reads as on a Mac", async () => {
    const files = withLog(fxLog().turnStarted().item().text());
    expect(statusOf(await fxAdapterFor(files, { platform: "linux" }).poll())).toBe("working");
  });
});

describe("a session", () => {
  test("whose turn is open while an fx runs is working, named after its folder", async () => {
    const files = withLog(
      fxLog()
        .turnStarted(NOW - 20 * SECOND)
        .item(NOW - 10 * SECOND)
        .text(),
    );
    const result = await fxAdapterFor(files).poll();
    expect(result.health).toEqual({
      id: "fx",
      label: "fx",
      state: "ok",
      detail: HEALTHY,
      watching: watching("every 2 seconds"),
      checkedAt: NOW,
    });
    expect(result.basis).toBe(BASIS);
    expect(result.sessions).toEqual([
      {
        id: `fx:${SESSION_ID}`,
        source: "fx",
        surface: "unknown",
        name: "demo-project",
        cwd: WORKSPACE,
        project: "demo-project",
        status: "working",
        startedAt: STARTED_AT,
        statusSince: null,
        links: {},
        stale: false,
        lastWriteAt: NOW - 10 * SECOND,
      },
    ]);
  });

  test("with no fx program running, every session is finished, but a failed or unknown one", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().turnStarted().item().text(), {
      mtimeMs: NOW - 10 * SECOND,
    });
    writeSession(
      files,
      OTHER_ID,
      fxLog({ id: OTHER_ID }).turnStarted().turnInterrupted("failed").text(),
    );
    writeSession(
      files,
      CHILD_ID,
      fxLog({ id: CHILD_ID }).turnStarted().raw("future_kind", "").text(),
    );
    const processes = standInFxProcesses({ ok: true, pids: [], unparsed: 0 });
    const result = await fxAdapterFor(files, { processes }).poll();
    expect(statusOf(result)).toBe("finished");
    expect(result.sessions.find((s) => s.id === `fx:${SESSION_ID}`)?.statusSince).toBe(
      NOW - 10 * SECOND,
    );
    expect(statusOf(result, OTHER_ID)).toBe("failed");
    expect(statusOf(result, CHILD_ID)).toBe("unknown");
    expect(result.basis).toBe(BASIS_CLOSED);
    expect(result.health.detail).toBe(
      `${HEALTHY} No fx program runs, so each session shows as finished, unless it failed or cannot be read. ${UNKNOWN_END_NOTE}`,
    );
  });

  test("when ps cannot say, an open, ended or new session is unknown, and a failed one stays failed", async () => {
    const files = memoryFiles();
    writeSession(files, SESSION_ID, fxLog().turnStarted().item().text());
    writeSession(
      files,
      OTHER_ID,
      fxLog({ id: OTHER_ID }).turnStarted().turnInterrupted("failed").closed().text(),
    );
    writeSession(files, CHILD_ID, fxLog({ id: CHILD_ID }).text());
    const result = await fxAdapterFor(files, {
      processes: standInFxProcesses({ ok: false }),
    }).poll();
    expect(statusOf(result)).toBe("unknown");
    expect(statusOf(result, OTHER_ID)).toBe("failed");
    expect(statusOf(result, CHILD_ID)).toBe("unknown");
    expect(result.basis).toBe(BASIS_WITHOUT_PROCESSES);
    expect(result.health.detail).toBe(
      `${HEALTHY} ps could not be run to tell whether fx runs, so no session is shown as working or finished.`,
    );
  });

  test("between turns, or before its first, it is unknown while an fx runs and finished once none does", async () => {
    for (const log of [
      fxLog().turnStarted().turnCommitted(),
      fxLog().turnStarted().turnCommitted().closed(),
      fxLog(),
    ]) {
      expect(statusOf(await fxAdapterFor(withLog(log.text())).poll())).toBe("unknown");
      const none = standInFxProcesses({ ok: true, pids: [], unparsed: 0 });
      expect(statusOf(await fxAdapterFor(withLog(log.text()), { processes: none }).poll())).toBe(
        "finished",
      );
    }
  });

  test("a failed turn holds with fx, without, when ps fails and with closed after it, at its line's time", async () => {
    const answers = [
      { ok: true as const, pids: [FX_PID], unparsed: 0 },
      { ok: true as const, pids: [], unparsed: 0 },
      { ok: false as const },
    ];
    for (const answer of answers) {
      for (const log of [
        fxLog()
          .turnStarted()
          .turnInterrupted("failed", NOW - 30 * SECOND),
        fxLog()
          .turnStarted()
          .turnInterrupted("failed", NOW - 30 * SECOND)
          .closed(NOW - 20 * SECOND),
      ]) {
        const result = await fxAdapterFor(withLog(log.text()), {
          processes: standInFxProcesses(answer),
        }).poll();
        expect(result.sessions[0]).toMatchObject({
          status: "failed",
          statusSince: NOW - 30 * SECOND,
        });
      }
    }
    const early = fxLog()
      .turnStarted()
      .turnInterrupted("failed", STARTED_AT - 3 * SECOND);
    expect((await fxAdapterFor(withLog(early.text())).poll()).sessions[0]).toMatchObject({
      status: "failed",
      statusSince: null,
    });
  });

  test("a cancel, a close or a crash is not a failure", async () => {
    for (const reason of ["cancel", "closed", "crash"] as const) {
      const log = fxLog().turnStarted().turnInterrupted(reason);
      expect(statusOf(await fxAdapterFor(withLog(log.text())).poll()), reason).toBe("unknown");
      const none = standInFxProcesses({ ok: true, pids: [], unparsed: 0 });
      expect(
        statusOf(await fxAdapterFor(withLog(log.text()), { processes: none }).poll()),
        reason,
      ).toBe("finished");
    }
  });

  test("its last write is the log's, left out when it is before the session's start", async () => {
    const result = await fxAdapterFor(
      withLog(fxLog().turnStarted().item().text(), NOW - 5 * SECOND),
    ).poll();
    expect(result.sessions[0]?.lastWriteAt).toBe(NOW - 5 * SECOND);
    const before = await fxAdapterFor(
      withLog(fxLog().turnStarted().item().text(), STARTED_AT - 3 * SECOND),
    ).poll();
    expect(before.sessions[0]).not.toHaveProperty("lastWriteAt");
  });

  test("a header inside an item's data is not a line of its own", async () => {
    const fake = '{"v":1,"seq":99,"ts":1,"kind":"turn_committed","turn":1,"crc":"00000000"}';
    const log = fxLog().turnStarted().item(undefined, `{"args":${fake}}`);
    expect(statusOf(await fxAdapterFor(withLog(log.text())).poll())).toBe("working");
  });

  test("a log that ends in a way it does not know is unknown, and the card says so", async () => {
    for (const log of [
      fxLog().turnStarted().turnCommitted().raw("future_kind", ""),
      fxLog().turnStarted().turnCommitted().raw("turn_started", ',"turn":2', NOW, 2),
      fxLog().turnStarted().item().closed(),
    ]) {
      const result = await fxAdapterFor(withLog(log.text())).poll();
      expect(statusOf(result)).toBe("unknown");
      expect(result.health.detail).toBe(`${HEALTHY} ${UNKNOWN_END_NOTE}`);
    }
  });

  test("a bad last line is passed over, then cut and written again as a crash: unknown while fx runs, not working", async () => {
    const log = fxLog()
      .turnStarted()
      .item(NOW - MINUTE);
    const crash = frame(
      { seq: log.seq + 1, ts: NOW, kind: "turn_interrupted" },
      ',"turn":1,"reason":"crash"',
    );
    const files = withLog(
      log.text() + crash.replace(/"crc":"[0-9a-f]{8}"/, '"crc":"00000000"'),
      NOW - MINUTE,
    );
    const clock = handClock();
    const adapter = fxAdapterFor(files, { now: clock.now });
    expect(statusOf(await adapter.poll())).toBe("working");
    files.rewrite(logPath(SESSION_ID), log.text() + crash, { mtimeMs: NOW + SECOND });
    clock.advance(2 * SECOND);
    expect(statusOf(await adapter.poll())).toBe("unknown");
  });
});

describe("whether an open turn's writer runs", () => {
  /** The adapter, polled at each time with each answer of `ps`, after the log was last written at `M`. */
  async function polls(answers: [number, number[]][], platform: NodeJS.Platform = "darwin") {
    const M = NOW;
    const files = withLog(fxLog().turnStarted().item().text(), M);
    const clock = handClock(M);
    const processes = standInFxProcesses();
    const adapter = fxAdapterFor(files, { now: clock.now, processes, platform });
    let last: AdapterResult | null = null;
    for (const [at, pids] of answers) {
      clock.set(M + at);
      processes.running(...pids);
      last = await adapter.poll();
    }
    return statusOf(last!);
  }

  for (const platform of ["darwin", "linux"] as const) {
    test(`on ${platform}, an fx missing from an answer after the last write did not make it`, async () => {
      expect(
        await polls(
          [
            [5 * SECOND, []],
            [15 * SECOND, [200]],
          ],
          platform,
        ),
      ).toBe("finished");
    });

    test(`on ${platform}, an fx that may have made it keeps the turn working`, async () => {
      expect(
        await polls(
          [
            [-5 * SECOND, [100]],
            [15 * SECOND, [100]],
          ],
          platform,
        ),
      ).toBe("working");
      expect(
        await polls(
          [
            [-10 * SECOND, [100]],
            [5 * SECOND, [100]],
            [15 * SECOND, [100, 200]],
          ],
          platform,
        ),
      ).toBe("working");
      expect(await polls([[5 * SECOND, [200]]], platform)).toBe("working");
      expect(
        await polls(
          [
            [-5 * SECOND, []],
            [5 * SECOND, [200]],
          ],
          platform,
        ),
      ).toBe("working");
    });
  }

  test("an fx missing only from an answer less than 2 seconds after the write may have made it", async () => {
    expect(
      await polls([
        [400, []],
        [10_400, [200]],
      ]),
    ).toBe("working");
    expect(
      await polls([
        [2_100, []],
        [12_100, [200]],
      ]),
    ).toBe("finished");
  });

  test("a line naming fx with no ID keeps the turn from finishing", async () => {
    const files = withLog(fxLog().turnStarted().item().text(), NOW);
    const clock = handClock(NOW + 5 * SECOND);
    const processes = standInFxProcesses({ ok: true, pids: [], unparsed: 0 });
    const adapter = fxAdapterFor(files, { now: clock.now, processes });
    await adapter.poll();
    processes.set({ ok: true, pids: [200], unparsed: 1 });
    clock.set(NOW + 15 * SECOND);
    expect(statusOf(await adapter.poll())).toBe("working");
  });

  test("an answer whose time runs back keeps the turn working, not finished", async () => {
    expect(
      await polls([
        [25 * SECOND, []],
        [15 * SECOND, [200]],
      ]),
    ).toBe("working");
  });

  test("an fx running from the first answer keeps a turn working for 30 quiet minutes, then unknown", async () => {
    expect(await polls([[30 * MINUTE - SECOND, [FX_PID]]])).toBe("working");
    expect(await polls([[30 * MINUTE, [FX_PID]]])).toBe("unknown");
    expect(await polls([[-61 * SECOND, [FX_PID]]])).toBe("unknown");
  });

  test("another program named fx, there all along, keeps a cut-off turn working for 30 minutes, then unknown", async () => {
    expect(
      await polls([
        [-MINUTE, [77]],
        [10 * MINUTE, [77]],
        [29 * MINUTE, [77]],
      ]),
    ).toBe("working");
    expect(
      await polls([
        [-MINUTE, [77]],
        [10 * MINUTE, [77]],
        [31 * MINUTE, [77]],
      ]),
    ).toBe("unknown");
    // One that starts after an answer later than the last write cannot keep it.
    expect(
      await polls([
        [5 * SECOND, []],
        [15 * SECOND, [77]],
      ]),
    ).toBe("finished");
  });
});

describe("the first line", () => {
  test("of another folder, another seq or kind, with a field fx 0.0.17 does not write, or too long, is not listed", async () => {
    for (const text of [
      fxLog({ id: OTHER_ID }).turnStarted().text(),
      fxLog({ seq: 2 }).turnStarted().text(),
      fxLog({ kind: "turn_started" }).text(),
      `${"x".repeat(17 * 1024)}\n`,
    ]) {
      const result = await fxAdapterFor(withLog(text)).poll();
      expect(result.sessions).toEqual([]);
      expect(result.health.detail).toBe(HEALTHY);
    }
  });

  test("of a newer fx is not listed, and the card says so", async () => {
    for (const log of [fxLog({ v: 2 }), fxLog({ extra: ',"pid":1' })]) {
      const result = await fxAdapterFor(withLog(log.text())).poll();
      expect(result.sessions).toEqual([]);
      expect(result.health.detail).toBe(`${HEALTHY} ${NEWER_FORMAT_NOTE}`);
    }
  });

  test("with a folder that has a control character or is not absolute gives no folder, and the id for a name", async () => {
    for (const workspace of ["/Users/example/demo\u001bproject", "demo-project"]) {
      const result = await fxAdapterFor(withLog(fxLog({ workspace }).turnStarted().text())).poll();
      expect(result.sessions[0]).toMatchObject({
        cwd: null,
        project: null,
        name: `fx:${SESSION_ID}`,
      });
    }
  });
});

describe("forks", () => {
  test("a failed turn copied from the source is not the fork's", async () => {
    const log = fxLog({ forkedFrom: { id: OTHER_ID, seq: 3 }, ts: NOW - MINUTE })
      .turnStarted(STARTED_AT)
      .turnInterrupted("failed");
    const result = await fxAdapterFor(withLog(log.text())).poll();
    expect(statusOf(result)).toBe("unknown");
  });

  test("a fork of a source older than a day is listed, as its first line is new", async () => {
    const log = fxLog({ forkedFrom: { id: OTHER_ID, seq: 3 }, ts: NOW - MINUTE })
      .turnStarted(NOW - 3 * DAY)
      .turnCommitted();
    const result = await fxAdapterFor(withLog(log.text())).poll();
    expect(result.sessions.map((session) => session.id)).toEqual([`fx:${SESSION_ID}`]);
  });
});

describe("which sessions are listed", () => {
  test("not a log written more than a day ago, nor one whose newest time is, as a converted session's", async () => {
    const old = fxLog({ ts: NOW - 3 * DAY })
      .turnStarted()
      .turnCommitted();
    expect((await fxAdapterFor(withLog(old.text(), NOW - DAY - 1)).poll()).sessions).toEqual([]);
    // Converted now from an older session: its lines keep that session's times.
    expect((await fxAdapterFor(withLog(old.text(), NOW)).poll()).sessions).toEqual([]);
    const fresh = fxLog({ ts: NOW - 3 * DAY })
      .turnStarted(NOW - HOUR)
      .turnCommitted();
    expect((await fxAdapterFor(withLog(fresh.text(), NOW)).poll()).sessions).toHaveLength(1);
  });

  test("a subagent's session is never listed, its first 16 KiB read once, and not again after a sweep", async () => {
    const files = withLog(fxLog().turnStarted().item().text());
    const child = fxLog({ id: CHILD_ID, role: "child", host: "child", parent: SESSION_ID })
      .turnStarted()
      .item();
    writeSession(files, CHILD_ID, child.text(), { mtimeMs: NOW - SECOND });
    const imported = fxLog({
      id: OTHER_ID,
      role: "child",
      host: "app",
      parent: SESSION_ID,
    }).turnStarted();
    writeSession(files, OTHER_ID, imported.text(), { mtimeMs: NOW - SECOND });
    const clock = handClock();
    const adapter = fxAdapterFor(files, { now: clock.now });
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([
      `fx:${SESSION_ID}`,
    ]);
    const childReads = files.reads.filter((read) => read.path === logPath(CHILD_ID));
    expect(childReads).toEqual([
      { path: logPath(CHILD_ID), position: 0, length: expect.any(Number) },
    ]);
    expect(childReads[0]!.length).toBeLessThanOrEqual(16 * 1024);

    files.append(logPath(CHILD_ID), child.item().since(3), { mtimeMs: NOW + SECOND });
    files.forget();
    clock.advance(SWEEP_MS + SECOND);
    expect((await adapter.poll()).sessions.map((session) => session.id)).toEqual([
      `fx:${SESSION_ID}`,
    ]);
    expect(files.opened()).not.toContain(logPath(CHILD_ID));
    expect(files.opened()).not.toContain(logPath(OTHER_ID));
  });

  test("only each session's log is opened: never fx's index, a lock, blobs or the older store's files", async () => {
    const files = withLog(fxLog().turnStarted().item().title().text());
    files.write(`${V2}/index.jsonl`, INDEX_LINE);
    files.write(`${V2}/index.lock`, "");
    files.write(`${V2}/${SESSION_ID}/lock`, "");
    files.write(`${V2}/${SESSION_ID}/blobs/${"a".repeat(64)}`, PRIVATE_WORDS);
    files.write(`/Users/example/.fx/sessions/${OTHER_ID}/session.json`, PRIVATE_WORDS);
    files.write(`/Users/example/.fx/history.jsonl`, PRIVATE_WORDS);
    files.write(`/Users/example/.fx/settings.json`, PRIVATE_WORDS);
    files.write(`/Users/example/.fx/auth.json`, PRIVATE_WORDS);
    files.touch(V2, 7);
    const result = await fxAdapterFor(files).poll();
    expect(result.sessions.map((session) => session.id)).toEqual([`fx:${SESSION_ID}`]);
    expect(files.opened()).toEqual([logPath(SESSION_ID)]);
    expect(
      files.calls.filter((call) => call.method === "readdir").map((call) => call.path),
    ).toEqual([V2]);
  });

  test("no title, prompt or other words of a log reach a session or the card", async () => {
    const log = fxLog()
      .set("prefs", JSON.stringify({ model: PRIVATE_WORDS }))
      .turnStarted()
      .item()
      .childSpawned()
      .childFinished()
      .compacted()
      .snapshot()
      .turnCommitted()
      .title()
      .set("title", JSON.stringify(`${PRIVATE_WORDS} (fork)`));
    const files = withLog(log.text());
    files.write(`${V2}/index.jsonl`, INDEX_LINE);
    const result = await fxAdapterFor(files).poll();
    expect(result.sessions[0]?.name).toBe("demo-project");
    expect(JSON.stringify(result)).not.toContain("placeholder");
  });
});

describe("ps", () => {
  test("is asked only while a session is listed, at most every 10 seconds", async () => {
    const files = memoryFiles();
    files.mkdir(V2);
    const clock = handClock();
    const processes = standInFxProcesses();
    const adapter = fxAdapterFor(files, { now: clock.now, processes });
    expect((await adapter.poll()).basis).toBe(BASIS);
    expect(processes.asked.count).toBe(0);

    writeSession(files, SESSION_ID, fxLog().turnStarted().item().text());
    clock.advance(2 * SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(PROCESS_CHECK_MS - 3 * SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(3 * SECOND);
    await adapter.poll();
    expect(processes.asked.count).toBe(2);
  });

  test("is asked again after 2 seconds when a log is written after it showed no fx, and a clock set back counts as due", async () => {
    const files = withLog(fxLog().turnStarted().item().text(), NOW - MINUTE);
    const clock = handClock();
    const processes = standInFxProcesses({ ok: true, pids: [], unparsed: 0 });
    const adapter = fxAdapterFor(files, { now: clock.now, processes });
    expect(statusOf(await adapter.poll())).toBe("finished");
    expect(processes.asked.count).toBe(1);

    processes.running(FX_PID);
    clock.advance(SECOND);
    files.append(logPath(SESSION_ID), fxLog().turnStarted().item().item().since(3), {
      mtimeMs: NOW + SECOND,
    });
    await adapter.poll();
    expect(processes.asked.count).toBe(1);
    clock.advance(PROMPT_PROCESS_CHECK_MS - SECOND);
    expect(statusOf(await adapter.poll())).toBe("working");
    expect(processes.asked.count).toBe(2);

    clock.advance(-MINUTE);
    await adapter.poll();
    expect(processes.asked.count).toBe(3);
  });

  test("is asked again when a log's kept time is a moment before an answer that showed no fx", async () => {
    const files = withLog(fxLog().turnStarted().item().text(), NOW - MINUTE);
    const clock = handClock(NOW + 400);
    const processes = standInFxProcesses({ ok: true, pids: [], unparsed: 0 });
    const adapter = fxAdapterFor(files, { now: clock.now, processes });
    expect(statusOf(await adapter.poll())).toBe("finished");
    // fx starts and writes at NOW + 900 ms, which a disk keeping whole seconds keeps as NOW.
    processes.running(FX_PID);
    files.append(logPath(SESSION_ID), fxLog().turnStarted().item().item().since(3), {
      mtimeMs: NOW,
    });
    clock.set(NOW + 2_400);
    expect(statusOf(await adapter.poll())).toBe("working");
    expect(processes.asked.count).toBe(2);
    clock.set(NOW + 12_400);
    expect(statusOf(await adapter.poll())).toBe("working");
  });

  test("the ways it reads are the ones another machine's are taken under", () => {
    expect(KNOWN_WAYS.get("fx")).toEqual([BASIS, BASIS_CLOSED, BASIS_WITHOUT_PROCESSES]);
  });
});

describe("the declaration", () => {
  test("says nothing shows as idle or needing you, and no Jump, tokens, Stop or Answer", () => {
    expect(FX_CAPABILITIES["working-and-idle"].level).toBe("partly");
    expect(FX_CAPABILITIES["needs-you"].level).toBe("no");
    expect(FX_CAPABILITIES.finished.level).toBe("partly");
    expect(FX_CAPABILITIES.failed.level).toBe("partly");
    expect(FX_CAPABILITIES.names.level).toBe("partly");
    expect(FX_CAPABILITIES["quiet-for"].level).toBe("partly");
    for (const no of ["jump", "tokens", "stop", "answer"] as const) {
      expect(FX_CAPABILITIES[no].level, no).toBe("no");
    }
  });

  test("a session never needs you, whatever its log says", async () => {
    const files = memoryFiles();
    const logs: [string, ReturnType<typeof fxLog>][] = [
      [
        SESSION_ID,
        fxLog()
          .turnStarted()
          .item(undefined, JSON.stringify({ question: PRIVATE_WORDS }), "tool_call"),
      ],
      [OTHER_ID, fxLog({ id: OTHER_ID }).turnStarted().turnCommitted()],
    ];
    for (const [id, log] of logs) writeSession(files, id, log.text());
    const result = await fxAdapterFor(files).poll();
    for (const session of result.sessions) {
      expect(session.status).not.toBe("needs-you");
      expect(session.status).not.toBe("idle");
    }
  });
});
