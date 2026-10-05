import { describe, expect, test } from "vitest";

import type { AdapterResult } from "@collector/adapters/adapter";
import {
  BASIS,
  createStatusFileAdapter,
  STATUS_DIR_ENV,
  type StatusFileAdapterOptions,
} from "@collector/adapters/status-files/index";
import { MAX_FILE_BYTES, MAX_FILES } from "@collector/adapters/status-files/statusFile";
import {
  DAY,
  HOME,
  HOUR,
  MINUTE,
  NOW,
  SECOND,
  STATUS_DIR,
  statusFile,
} from "@tests/fixtures/statusFiles";
import { memoryFiles, type MemoryFiles } from "@tests/support/adapters/codexAdapter";

const FOLDER_SHOWN = "~/.agent-lookout/sessions";
const BASE = `Each file ending in .json in ${FOLDER_SHOWN} is one session, written by the agent it belongs to.`;
const SKIPPED_RULE =
  "A status file is an ordinary file of 16 KB or less that holds a JSON object with an agent and a status, and only the 200 written most recently are read.";

/**
 * The adapter over files held in memory, with a clock the test moves and a set
 * of the processes that are alive. Nothing here reads a real file.
 */
function setUp(options: Partial<StatusFileAdapterOptions> = {}) {
  const clock = { now: NOW };
  const files = memoryFiles(() => clock.now);
  const alive = new Set<number>();
  const adapter = createStatusFileAdapter({
    env: {},
    homeDir: HOME,
    now: () => clock.now,
    io: files.io,
    isAlive: (pid) => alive.has(pid),
    ...options,
  });
  /** Moves the clock on and polls. */
  const poll = async (afterMs = 2 * SECOND): Promise<AdapterResult> => {
    clock.now += afterMs;
    return adapter.poll();
  };
  return { clock, files, alive, adapter, poll, first: () => adapter.poll() };
}

/** Writes a file in the folder. */
function put(files: MemoryFiles, name: string, content: string, mtimeMs?: number) {
  files.write(`${STATUS_DIR}/${name}`, content, { mtimeMs });
}

function facts(read: number, skipped: number) {
  return [
    { label: "Folder", value: FOLDER_SHOWN },
    { label: "Read", value: "every 2 seconds" },
    { label: "Files read", value: String(read) },
    { label: "Files skipped", value: String(skipped) },
  ];
}

describe("the source's health", () => {
  test("before the first poll it says where it looks", () => {
    const { adapter } = setUp();
    expect(adapter).toMatchObject({
      id: "status-files",
      label: "Status files",
      lookingIn: `Looking for status files in ${FOLDER_SHOWN}.`,
    });
  });

  test("with no folder it is not set up, says in one sentence how to start, and reads nothing else", async () => {
    const { files, first } = setUp();
    const result = await first();

    expect(result).toEqual({
      health: {
        id: "status-files",
        label: "Status files",
        state: "not-set-up",
        detail: `To show any other agent here, make the folder ${FOLDER_SHOWN} and have the agent write a small JSON file in it for each session, as "Your own agents" in docs/GUIDE.md describes.`,
        watching: [
          { label: "Folder", value: FOLDER_SHOWN },
          { label: "Read", value: "not found" },
        ],
        checkedAt: NOW,
      },
      sessions: [],
      // Read, and holding nothing, so what appears in it later is new.
      basis: BASIS,
    });
    expect(files.calls).toEqual([{ method: "readdir", path: STATUS_DIR }]);
  });

  test("the folder is looked for on every poll, so one made later is read at once", async () => {
    const { files, first, poll } = setUp();
    await first();
    await poll();
    put(files, "night-shift.json", statusFile());
    const result = await poll();

    expect(result.health.state).toBe("ok");
    expect(result.sessions).toHaveLength(1);
    expect(files.count("readdir")).toBe(3);
  });

  test(`${STATUS_DIR_ENV} names another folder, shown in full when it is not under the home folder`, async () => {
    const { files, first } = setUp({ env: { [STATUS_DIR_ENV]: " /srv/agents/status " } });
    files.mkdir("/srv/agents/status");
    const result = await first();

    expect(result.health.state).toBe("ok");
    expect(result.health.watching?.[0]).toEqual({ label: "Folder", value: "/srv/agents/status" });
    expect(files.calls).toEqual([{ method: "readdir", path: "/srv/agents/status" }]);
  });

  test("a folder that cannot be listed is not working", async () => {
    const { files, first } = setUp();
    files.mkdir(STATUS_DIR);
    files.fail(STATUS_DIR, "EACCES");
    const result = await first();

    expect(result).toEqual({
      health: {
        id: "status-files",
        label: "Status files",
        state: "error",
        detail: `Status files could not be read: the folder ${FOLDER_SHOWN} could not be listed.`,
        watching: [
          { label: "Folder", value: FOLDER_SHOWN },
          { label: "Read", value: "cannot be read" },
        ],
        advice: "Check that your user account can open the folder.",
        checkedAt: NOW,
      },
      sessions: [],
    });
  });

  test("an empty folder is watched, with nothing read and nothing skipped", async () => {
    const { files, first } = setUp();
    files.mkdir(STATUS_DIR);

    expect(await first()).toEqual({
      health: {
        id: "status-files",
        label: "Status files",
        state: "ok",
        detail: BASE,
        watching: facts(0, 0),
        checkedAt: NOW,
      },
      sessions: [],
      basis: BASIS,
    });
  });

  test("says how often it reads, from the poller's interval", async () => {
    const { files, first } = setUp({ pollIntervalMs: 1_000 });
    files.mkdir(STATUS_DIR);
    expect((await first()).health.watching?.[1]).toEqual({ label: "Read", value: "every second" });
  });

  test("a poll that goes wrong in a way nobody expected is an error, never a throw", async () => {
    const { files, first } = setUp({
      isAlive: () => {
        throw new Error("broken");
      },
    });
    put(files, "night-shift.json", statusFile({ pid: 4242 }));

    expect(await first()).toEqual({
      health: {
        id: "status-files",
        label: "Status files",
        state: "error",
        detail: "Something unexpected went wrong while reading status files.",
        watching: [
          { label: "Folder", value: FOLDER_SHOWN },
          { label: "Read", value: "every 2 seconds" },
        ],
        checkedAt: NOW,
      },
      sessions: [],
    });
  });

  test("a listing that fails without saying why is an error too", async () => {
    const { files, first } = setUp();
    files.mkdir(STATUS_DIR);
    files.fail(STATUS_DIR, "EIO");
    expect((await first()).health.state).toBe("error");
  });
});

describe("what is read and what is skipped", () => {
  test("only files ending in .json directly in the folder, and no hidden ones, which are not counted", async () => {
    const { files, first } = setUp();
    put(files, "night-shift.json", statusFile());
    put(files, ".night-shift.json", statusFile({ name: "hidden" }));
    put(files, "notes.txt", "not a status file");
    put(files, "night-shift.json.tmp", statusFile({ name: "temporary" }));
    files.write(`${STATUS_DIR}/older/old.json`, statusFile({ name: "nested" }));
    const result = await first();

    expect(result.sessions.map((session) => session.name)).toEqual(["checkout-flow"]);
    expect(result.health.watching).toEqual(facts(1, 0));
    expect(files.opened()).toEqual([`${STATUS_DIR}/night-shift.json`]);
  });

  test("a folder, a link or a pipe named .json is skipped and counted, and never read", async () => {
    const { files, first } = setUp();
    put(files, "night-shift.json", statusFile());
    files.special(`${STATUS_DIR}/elsewhere.json`);
    files.mkdir(`${STATUS_DIR}/folder.json`);
    const result = await first();

    expect(result.sessions).toHaveLength(1);
    expect(result.health.watching).toEqual(facts(1, 2));
    expect(result.health.detail).toBe(
      `${BASE} 2 files were skipped, among them elsewhere.json, which is not an ordinary file. ${SKIPPED_RULE}`,
    );
    expect(files.reads.map((read) => read.path)).toEqual([`${STATUS_DIR}/night-shift.json`]);
  });

  test("a file over 16 KB is skipped and counted without a byte of it read", async () => {
    const { files, first } = setUp();
    put(files, "large.json", statusFile({ name: "x".repeat(MAX_FILE_BYTES) }));
    put(files, "night-shift.json", statusFile());
    const result = await first();

    expect(result.sessions.map((session) => session.id)).toEqual(["status-files:night-shift.json"]);
    expect(result.health.watching).toEqual(facts(1, 1));
    expect(result.health.detail).toBe(
      `${BASE} 1 file was skipped: large.json, which is over 16 KB. ${SKIPPED_RULE}`,
    );
    expect(files.reads.some((read) => read.path.endsWith("large.json"))).toBe(false);
    expect(files.openHandles()).toBe(0);
  });

  test("a file of exactly 16 KB is read", async () => {
    const { files, first } = setUp();
    const padding = MAX_FILE_BYTES - statusFile({ note: "" }).length;
    put(files, "night-shift.json", statusFile({ note: " ".repeat(padding) }));
    expect((await first()).sessions).toHaveLength(1);
  });

  test("a file that is not a status file is skipped and counted, and the others are read", async () => {
    const { files, first } = setUp();
    put(files, "a.json", "not json");
    put(files, "b.json", statusFile({ agent: undefined }));
    put(files, "c.json", statusFile({ status: undefined }));
    put(files, "d.json", statusFile({ name: "docs-site" }));
    const result = await first();

    expect(result.sessions.map((session) => session.name)).toEqual(["docs-site"]);
    expect(result.health.watching).toEqual(facts(1, 3));
    // The first by name is named, so the person knows which file to look at.
    expect(result.health.detail).toBe(
      `${BASE} 3 files were skipped, among them a.json, which is not JSON with an agent and a status. ${SKIPPED_RULE}`,
    );
  });

  test("a skipped file's name is shown as plain text, cleaned as a session's name is", async () => {
    const { files, first } = setUp();
    put(files, "broken\u202enosj.json", "{");
    expect((await first()).health.detail).toBe(
      `${BASE} 1 file was skipped: broken nosj.json, which is not JSON with an agent and a status. ${SKIPPED_RULE}`,
    );
  });

  test(`no more than ${MAX_FILES} files are opened, by name when they were written at once, and the rest are counted as skipped`, async () => {
    const { files, first } = setUp();
    for (let index = 0; index < MAX_FILES + 5; index += 1) {
      put(
        files,
        `agent-${String(index).padStart(3, "0")}.json`,
        statusFile({ name: `s-${index}` }),
      );
    }
    const result = await first();

    expect(result.sessions).toHaveLength(MAX_FILES);
    expect(files.count("openRegular")).toBe(MAX_FILES);
    expect(files.opened().at(-1)).toBe(`${STATUS_DIR}/agent-199.json`);
    expect(result.health.watching).toEqual(facts(MAX_FILES, 5));
    expect(result.health.detail).toContain("5 files were skipped.");
  });

  test(`over ${MAX_FILES} files, the ones written most recently are read, so files left behind never push a new session out`, async () => {
    const { files, alive, first } = setUp();
    // An agent that writes finished and leaves the file, as it may, for days.
    for (let index = 0; index < MAX_FILES; index += 1) {
      put(
        files,
        `night-shift-run-${String(index).padStart(4, "0")}.json`,
        statusFile({ status: "finished", since: NOW - 2 * DAY }),
        NOW - 2 * DAY + index * SECOND,
      );
    }
    alive.add(4242);
    put(
      files,
      "night-shift-run-0200.json",
      statusFile({ name: "billing-webhooks", status: "waiting", reason: "permission", pid: 4242 }),
    );
    put(files, "a-agent.json", statusFile({ name: "docs-site" }), NOW - MINUTE);
    const result = await first();

    expect(result.sessions.map((session) => [session.name, session.status])).toEqual([
      ["docs-site", "working"],
      ["billing-webhooks", "needs-you"],
    ]);
    expect(files.count("openRegular")).toBe(MAX_FILES);
    // The two written longest ago are the ones not read, and no link is followed to find out.
    expect(files.opened()).not.toContain(`${STATUS_DIR}/night-shift-run-0000.json`);
    expect(files.opened()).not.toContain(`${STATUS_DIR}/night-shift-run-0001.json`);
    expect(files.count("lstat")).toBe(MAX_FILES + 2);
    expect(files.count("stat")).toBe(0);
    expect(result.health.watching).toEqual(facts(MAX_FILES, 2));
    expect(result.health.detail).toBe(
      `${BASE} 198 finished or failed sessions ended more than a day ago and are not shown. 2 files were skipped. ${SKIPPED_RULE}`,
    );
  });

  test(`at ${MAX_FILES} files or fewer, nothing is looked at but the files themselves`, async () => {
    const { files, first } = setUp();
    for (let index = 0; index < MAX_FILES; index += 1) {
      put(files, `agent-${String(index).padStart(3, "0")}.json`, statusFile());
    }
    await first();
    expect(files.count("lstat")).toBe(0);
    expect(files.count("openRegular")).toBe(MAX_FILES);
  });

  test("every file it opens is closed", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile());
    put(files, "b.json", "{");
    put(files, "c.json", statusFile({ name: "x".repeat(MAX_FILE_BYTES) }));
    await first();
    expect(files.openHandles()).toBe(0);
  });

  test("a file that goes between the listing and the read is neither read nor skipped", async () => {
    const { files, first } = setUp();
    files.mkdir(STATUS_DIR);
    files.fail(`${STATUS_DIR}/gone.json`, "ENOENT");
    put(files, "gone.json", statusFile());
    const result = await first();

    expect(result.sessions).toEqual([]);
    expect(result.health.watching).toEqual(facts(0, 0));
  });

  test("a file that cannot be opened is skipped and counted", async () => {
    const { files, first } = setUp();
    put(files, "locked.json", statusFile());
    files.fail(`${STATUS_DIR}/locked.json`, "EACCES");
    const result = await first();
    expect(result.health.watching).toEqual(facts(0, 1));
    expect(result.health.detail).toBe(
      `${BASE} 1 file was skipped: locked.json, which could not be opened. ${SKIPPED_RULE}`,
    );
  });
});

describe("its sessions", () => {
  test("a file is a session of its own agent, and a waiting one needs you", async () => {
    const { files, first } = setUp();
    put(files, "night-shift.json", statusFile({ status: "waiting", reason: "permission" }));
    put(
      files,
      "my-agent.json",
      statusFile({ agent: "my-agent", name: "docs-site", status: "idle" }),
    );
    const result = await first();

    expect(
      result.sessions.map((session) => [session.id, session.agent, session.name, session.status]),
    ).toEqual([
      ["status-files:my-agent.json", "my-agent", "docs-site", "idle"],
      ["status-files:night-shift.json", "Night Shift", "checkout-flow", "needs-you"],
    ]);
    expect(result.sessions[1]?.waitingReason).toBe("permission");
  });

  test("a session whose process has gone is dropped, and the sentence says why", async () => {
    const { files, alive, first } = setUp();
    alive.add(100);
    put(files, "a.json", statusFile({ name: "api-rate-limits", pid: 100 }));
    put(files, "b.json", statusFile({ name: "search-indexing", pid: 200, status: "waiting" }));
    put(files, "c.json", statusFile({ name: "docs-site", pid: 300, status: "idle" }));
    const result = await first();

    expect(result.sessions.map((session) => [session.name, session.alive])).toEqual([
      ["api-rate-limits", true],
    ]);
    expect(result.health.watching).toEqual(facts(3, 0));
    expect(result.health.detail).toBe(
      `${BASE} 2 files name a process that has ended, so their sessions are not shown.`,
    );
  });

  test("one that finished or failed is expected to have no process, and stays", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile({ name: "infra-terraform", pid: 300, status: "finished" }));
    put(files, "b.json", statusFile({ name: "email-templates", pid: 301, status: "failed" }));
    const result = await first();

    expect(result.sessions.map((session) => [session.name, session.status, session.alive])).toEqual(
      [
        ["infra-terraform", "finished", false],
        ["email-templates", "failed", false],
      ],
    );
    expect(result.health.detail).toBe(BASE);
  });

  test("a finished or failed session is hidden after a day even while its process runs, as an agent that serves many sessions keeps it running", async () => {
    const { files, alive, first } = setUp();
    alive.add(4242);
    put(
      files,
      "task-1.json",
      statusFile({ name: "old-run", status: "finished", since: NOW - 2 * DAY, pid: 4242 }),
      NOW - 2 * DAY,
    );
    put(
      files,
      "task-2.json",
      statusFile({ name: "old-failure", status: "failed", pid: 4242 }),
      NOW - 2 * DAY,
    );
    put(
      files,
      "task-3.json",
      statusFile({ name: "recent-run", status: "finished", since: NOW - HOUR, pid: 4242 }),
    );
    const result = await first();

    expect(result.sessions.map((session) => [session.name, session.alive])).toEqual([
      ["recent-run", true],
    ]);
    expect(result.health.detail).toBe(
      `${BASE} 2 finished or failed sessions ended more than a day ago and are not shown.`,
    );
  });

  test("a session with no pid is never dropped for want of one", async () => {
    const { files, first } = setUp();
    put(files, "night-shift.json", statusFile());
    expect((await first()).sessions[0]).not.toHaveProperty("alive");
  });

  test("a finished or failed session is shown for a day after its status time, or its file's last write", async () => {
    const { files, first } = setUp();
    put(
      files,
      "a.json",
      statusFile({ name: "recent", status: "finished", since: NOW - 23 * HOUR }),
    );
    put(files, "b.json", statusFile({ name: "old", status: "failed", since: NOW - DAY }));
    put(files, "c.json", statusFile({ name: "written-recently", status: "finished" }), NOW - HOUR);
    put(
      files,
      "d.json",
      statusFile({ name: "written-long-ago", status: "finished" }),
      NOW - 2 * DAY,
    );
    const result = await first();

    expect(result.sessions.map((session) => session.name).sort()).toEqual([
      "recent",
      "written-recently",
    ]);
    expect(result.health.detail).toBe(
      `${BASE} 2 finished or failed sessions ended more than a day ago and are not shown.`,
    );
  });

  test("a session that is still working is never dropped for its age", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile({ since: NOW - 3 * DAY }), NOW - 3 * DAY);
    expect((await first()).sessions).toHaveLength(1);
  });

  test("an idle session is stale after a day idle", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile({ status: "idle", since: NOW - DAY }));
    put(files, "b.json", statusFile({ status: "idle", since: NOW - HOUR, name: "docs-site" }));
    const result = await first();
    expect(result.sessions.map((session) => [session.name, session.stale])).toEqual([
      ["checkout-flow", true],
      ["docs-site", false],
    ]);
  });
});

describe("when a status began", () => {
  test("is the file's since, as epoch milliseconds or ISO 8601", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile({ since: NOW - 5 * MINUTE }));
    put(
      files,
      "b.json",
      statusFile({ name: "docs-site", since: new Date(NOW - MINUTE).toISOString() }),
    );
    const result = await first();
    expect(result.sessions.map((session) => [session.name, session.statusSince])).toEqual([
      ["checkout-flow", NOW - 5 * MINUTE],
      ["docs-site", NOW - MINUTE],
    ]);
  });

  test("is not known for a session already in the folder at the first read that gives no since, or one that cannot be right", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile({ name: "no-since" }));
    put(files, "b.json", statusFile({ name: "in-1970", since: 0 }));
    put(files, "c.json", statusFile({ name: "seconds-not-ms", since: Math.floor(NOW / 1000) }));
    put(files, "d.json", statusFile({ name: "tomorrow", since: NOW + DAY }));
    const result = await first();
    expect(result.sessions.map((session) => session.statusSince)).toEqual([null, null, null, null]);
  });

  test("without since, is when the status was first seen, and holds while it stands", async () => {
    const { files, first, poll, clock } = setUp();
    put(files, "a.json", statusFile());
    await first();

    const file = `${STATUS_DIR}/a.json`;
    files.rewrite(file, statusFile({ status: "waiting" }));
    const waitingAt = clock.now + 2 * SECOND;
    expect((await poll()).sessions[0]).toMatchObject({
      status: "needs-you",
      statusSince: waitingAt,
    });

    // Written again and again while it waits, its time does not move.
    files.rewrite(file, statusFile({ status: "waiting", reason: "question" }));
    expect((await poll()).sessions[0]).toMatchObject({ statusSince: waitingAt });
    files.rewrite(file, statusFile({ status: "waiting", reason: "question" }));
    expect((await poll(30 * SECOND)).sessions[0]).toMatchObject({ statusSince: waitingAt });

    files.rewrite(file, statusFile({ status: "working" }));
    expect((await poll()).sessions[0]).toMatchObject({
      status: "working",
      statusSince: clock.now,
    });
  });

  test("without since, a file that appears after the first read began when it was first seen", async () => {
    const { files, first, poll, clock } = setUp();
    await first();
    put(files, "night-shift.json", statusFile());
    expect((await poll()).sessions[0]?.statusSince).toBe(clock.now);
  });

  test("a since that cannot be right is passed over for the time it was first seen", async () => {
    const { files, first, poll, clock } = setUp();
    files.mkdir(STATUS_DIR);
    await first();
    put(files, "night-shift.json", statusFile({ since: NOW + DAY }));
    expect((await poll()).sessions[0]?.statusSince).toBe(clock.now);
  });

  test("a session that went away and came back began again", async () => {
    const { files, first, poll, clock } = setUp();
    put(files, "a.json", statusFile({ status: "waiting" }));
    await first();
    files.remove(`${STATUS_DIR}/a.json`);
    expect((await poll()).sessions).toEqual([]);
    put(files, "a.json", statusFile({ status: "waiting" }));
    expect((await poll()).sessions[0]?.statusSince).toBe(clock.now);
  });
});

describe("when the agent last wrote", () => {
  test("is the file's modified time, and moves each time the agent writes it, whatever it says", async () => {
    const { files, first, poll, clock } = setUp();
    put(files, "a.json", statusFile(), NOW - 7 * MINUTE + 0.5);
    expect((await first()).sessions[0]?.lastWriteAt).toBe(NOW - 7 * MINUTE);

    // Nothing written: it stays, poll after poll.
    expect((await poll(5 * MINUTE)).sessions[0]?.lastWriteAt).toBe(NOW - 7 * MINUTE);
    // Written again with the same words, as an agent that touches its file does.
    files.rewrite(`${STATUS_DIR}/a.json`, statusFile());
    const session = (await poll()).sessions[0];
    expect(session?.lastWriteAt).toBe(clock.now - 2 * SECOND);
    expect(session?.status).toBe("working");
  });

  test("is not known when the time could not be right, or is before the since the file holds", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile({ name: "ahead" }), NOW + 2 * MINUTE);
    put(files, "b.json", statusFile({ name: "in-2019" }), Date.UTC(2019, 0, 1));
    put(files, "c.json", statusFile({ name: "copied", since: NOW - MINUTE }), NOW - 3 * MINUTE);
    put(
      files,
      "d.json",
      statusFile({ name: "after-since", since: NOW - 3 * MINUTE }),
      NOW - MINUTE,
    );
    const result = await first();
    expect(result.sessions.map((session) => [session.name, session.lastWriteAt])).toEqual([
      ["ahead", undefined],
      ["in-2019", undefined],
      ["copied", undefined],
      ["after-since", NOW - MINUTE],
    ]);
    // Each still has its status: a time that is not known changes nothing else.
    expect(result.sessions.map((session) => session.status)).toEqual([
      "working",
      "working",
      "working",
      "working",
    ]);
  });

  test("a file caught half written keeps the time it was last read whole", async () => {
    const { files, first, poll } = setUp();
    put(files, "a.json", statusFile(), NOW - 6 * MINUTE);
    await first();
    files.rewrite(`${STATUS_DIR}/a.json`, statusFile().slice(0, 20));
    expect((await poll()).sessions[0]?.lastWriteAt).toBe(NOW - 6 * MINUTE);
  });
});

describe("a file caught half written", () => {
  test("keeps what it said a poll ago, for that one poll, and is then skipped", async () => {
    const { files, first, poll } = setUp();
    put(files, "a.json", statusFile({ status: "waiting" }));
    const before = (await first()).sessions;

    const whole = statusFile({ status: "idle" });
    files.rewrite(`${STATUS_DIR}/a.json`, whole.slice(0, 20));
    const caught = await poll();
    expect(caught.sessions).toEqual(before);
    expect(caught.health.watching).toEqual(facts(1, 0));

    const still = await poll();
    expect(still.sessions).toEqual([]);
    expect(still.health.watching).toEqual(facts(0, 1));

    files.rewrite(`${STATUS_DIR}/a.json`, whole);
    expect((await poll()).sessions[0]?.status).toBe("idle");
  });

  test("that was never read whole is skipped", async () => {
    const { files, first } = setUp();
    put(files, "a.json", statusFile().slice(0, 10));
    const result = await first();
    expect(result.sessions).toEqual([]);
    expect(result.health.watching).toEqual(facts(0, 1));
  });
});
