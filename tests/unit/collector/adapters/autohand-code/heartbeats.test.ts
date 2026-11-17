import { describe, expect, test } from "vitest";

import {
  createHeartbeatReader,
  HEARTBEAT_FIRST_READ,
  HEARTBEAT_READ_LIMIT,
  heartbeatOf,
  MAX_HEARTBEAT_BYTES,
  MAX_HEARTBEAT_FILES,
} from "@collector/adapters/autohand-code/heartbeats";
import {
  CREATED_AT,
  HEARTBEATS_DIR,
  INSTANCE_ID,
  NOW,
  OTHER_PID,
  OTHER_SESSION_ID,
  PID,
  PROJECT,
  SECOND,
  SESSION_ID,
  heartbeat,
  heartbeatPath,
  heartbeatRecord,
  oldHeartbeat,
  presenceHeartbeat,
  written,
} from "@tests/fixtures/autohand-code/autohandCode";
import {
  memoryFiles,
  OTHER_UID,
  ownedFiles,
  removeHeartbeat,
  TEST_UID,
  writeHeartbeat,
  type MemoryFiles,
} from "@tests/support/adapters/autohand-code/autohandCodeAdapter";
import { asWritten } from "@tests/support/paths";

const whole = { whole: true, last: true };

describe("heartbeatOf", () => {
  test("finds the kept fields of the main writer's heartbeat, as bytes", () => {
    expect(
      heartbeatOf(Buffer.from(heartbeat({ phase: "waiting_input" })), whole, "darwin"),
    ).toEqual({
      state: "ok",
      heartbeat: {
        pid: PID,
        sessionId: SESSION_ID,
        updatedAt: NOW,
        startedAt: CREATED_AT,
        mode: "interactive",
        phase: "waiting_input",
        workspaceRoot: PROJECT,
      },
    });
    for (const phase of ["idle", "thinking", "editing", "running_command"]) {
      const read = heartbeatOf(Buffer.from(heartbeat({ phase })), whole, "darwin");
      expect(read.state === "ok" && read.heartbeat.phase, phase).toBe(phase);
    }
    for (const mode of ["command", "rpc"]) {
      const read = heartbeatOf(Buffer.from(heartbeat({ mode })), whole, "darwin");
      expect(read.state === "ok" && read.heartbeat.mode, mode).toBe(mode);
    }
  });

  test("reads the presence writer's, with the folder's real path, and Autohand Code 0.9.3's", () => {
    const presence = heartbeatOf(Buffer.from(presenceHeartbeat({ phase: "idle" })), whole, "linux");
    expect(presence).toMatchObject({
      state: "ok",
      heartbeat: {
        mode: "interactive",
        phase: "idle",
        workspaceRoot: "/private/Users/example/code/demo-project",
      },
    });
    expect(heartbeatOf(Buffer.from(oldHeartbeat()), whole, "linux")).toMatchObject({
      state: "ok",
      heartbeat: { pid: PID, phase: "thinking" },
    });
    const withCommunication = heartbeat({ communication: true });
    expect(heartbeatOf(Buffer.from(withCommunication), whole, "linux").state).toBe("ok");
  });

  test("looks at nothing after the stage of work for the other fields", () => {
    // A process ID and a status after `phase`, as an instruction could not hold
    // them but a changed writer could, are not taken.
    const text = written({
      version: 1,
      sessionId: SESSION_ID,
      updatedAt: new Date(NOW).toISOString(),
      activity: { phase: "idle" },
      pid: 1,
      mode: "rpc",
    });
    expect(heartbeatOf(Buffer.from(text), whole, "darwin")).toEqual({ state: "broken" });
    const before = written({
      version: 1,
      pid: PID,
      sessionId: SESSION_ID,
      activity: { phase: "idle" },
      mode: "rpc",
      workspaceRoot: PROJECT,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(heartbeatOf(Buffer.from(before), whole, "darwin")).toMatchObject({
      state: "ok",
      heartbeat: { pid: PID, mode: null, workspaceRoot: null, updatedAt: null },
    });
  });

  test("a stage it does not know, no activity, or text not written by Autohand Code's writer, gives no stage", () => {
    const unknown = heartbeatOf(Buffer.from(heartbeat({ phase: "dreaming" })), whole, "darwin");
    expect(unknown).toMatchObject({ state: "ok", heartbeat: { phase: null } });
    const none = heartbeatOf(Buffer.from(heartbeat({ phase: null })), whole, "darwin");
    expect(none).toMatchObject({ state: "ok", heartbeat: { phase: null, pid: PID } });
    const compact = `${JSON.stringify(heartbeatRecord())}\n`;
    expect(heartbeatOf(Buffer.from(compact), whole, "darwin")).toEqual({ state: "broken" });
  });

  test("another format is newer, and a file cut off as it was written is broken", () => {
    expect(heartbeatOf(Buffer.from(heartbeat({ version: 2 })), whole, "darwin")).toEqual({
      state: "newer",
    });
    const text = heartbeat();
    expect(heartbeatOf(Buffer.from(text.slice(0, -40)), whole, "darwin")).toEqual({
      state: "broken",
    });
    expect(heartbeatOf(Buffer.from(""), whole, "darwin")).toEqual({ state: "broken" });
    expect(heartbeatOf(Buffer.from(heartbeat({ pid: 0 })), whole, "darwin")).toEqual({
      state: "broken",
    });
    expect(
      heartbeatOf(Buffer.from(heartbeat({ sessionId: "has space" })), whole, "darwin"),
    ).toEqual({ state: "broken" });
  });

  test("asks for more of the file when its stage is not in what was read", () => {
    const text = Buffer.from(heartbeat());
    const at = text.indexOf('"phase"');
    expect(heartbeatOf(text.subarray(0, at), { whole: false, last: false }, "darwin")).toEqual({
      state: "more",
    });
    expect(heartbeatOf(text.subarray(0, at + 12), { whole: false, last: false }, "darwin")).toEqual(
      { state: "more" },
    );
    // Past the most read, it is read with no stage.
    expect(heartbeatOf(text.subarray(0, at), { whole: false, last: true }, "darwin")).toMatchObject(
      { state: "ok", heartbeat: { phase: null } },
    );
  });

  test("a time it cannot read is none, and a folder that is not a whole path is none", () => {
    const text = heartbeat().replace(new Date(NOW).toISOString(), "yesterday");
    expect(heartbeatOf(Buffer.from(text), whole, "darwin")).toMatchObject({
      state: "ok",
      heartbeat: { updatedAt: null },
    });
    const relative = heartbeatOf(
      Buffer.from(heartbeat({ workspaceRoot: "code/demo" })),
      whole,
      "darwin",
    );
    expect(relative).toMatchObject({ state: "ok", heartbeat: { workspaceRoot: null } });
  });
});

function reader(
  files: MemoryFiles,
  owned = ownedFiles(files),
  platform: NodeJS.Platform = "darwin",
) {
  return createHeartbeatReader({
    dir: HEARTBEATS_DIR,
    io: owned.io,
    platform,
    euid: platform === "win32" ? null : TEST_UID,
    sweepMs: 60 * SECOND,
  });
}

const alive = () => true;

describe("the heartbeats folder", () => {
  test("reads a heartbeat's first 4 KiB, and an unchanged one not again", async () => {
    const files = memoryFiles();
    writeHeartbeat(files, heartbeat());
    const heartbeats = reader(files);
    const first = await heartbeats.read(NOW, alive);
    expect(first.folder).toBe("listed");
    expect(first.found.map((one) => [one.name, one.heartbeat.pid, one.alive])).toEqual([
      [`${SESSION_ID}.json`, PID, true],
    ]);
    expect(files.reads).toEqual([
      { path: asWritten(heartbeatPath()), position: 0, length: Buffer.byteLength(heartbeat()) },
    ]);
    files.forget();
    await heartbeats.read(NOW + 2 * SECOND, alive);
    expect(files.opened()).toEqual([]);
    expect(files.count("readdir")).toBe(0);
  });

  test("reads on to at most 16 KiB of a long heartbeat, and never one over 128 KiB", async () => {
    const files = memoryFiles();
    // A long folder before the stage puts it past the first read.
    const long = heartbeat({ workspaceRoot: `/Users/example/${"d".repeat(6_000)}` });
    writeHeartbeat(files, long);
    const heartbeats = reader(files);
    expect((await heartbeats.read(NOW, alive)).found).toHaveLength(1);
    expect(files.reads.map(({ position, length }) => [position, length])).toEqual([
      [0, HEARTBEAT_FIRST_READ],
      [HEARTBEAT_FIRST_READ, Buffer.byteLength(long) - HEARTBEAT_FIRST_READ],
    ]);

    files.forget();
    const padded = `${heartbeat({ phase: null }).slice(0, -2)},\n  "padding": "${"p".repeat(100_000)}"\n}\n`;
    writeHeartbeat(files, padded);
    await heartbeats.read(NOW, alive);
    for (const { position, length } of files.reads) {
      expect(position + length).toBeLessThanOrEqual(HEARTBEAT_READ_LIMIT);
    }

    files.forget();
    writeHeartbeat(
      files,
      `${heartbeat().slice(0, -2)},\n  "p": "${"p".repeat(MAX_HEARTBEAT_BYTES)}"\n}\n`,
    );
    const tooLarge = await heartbeats.read(NOW, alive);
    expect(tooLarge.tooLarge).toBe(true);
    expect(tooLarge.found).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("opens no link, no file with a second name, and on macOS and Linux none of another user's or that others may read", async () => {
    const files = memoryFiles();
    const owned = ownedFiles(files);
    const heartbeats = reader(files, owned);
    writeHeartbeat(files, heartbeat());
    for (const mark of [{ nlink: 2 }, { uid: OTHER_UID }, { mode: 0o100644 }, { mode: 0o100640 }]) {
      owned.set(heartbeatPath(), mark);
      files.forget();
      expect((await heartbeats.read(NOW, alive)).found, JSON.stringify(mark)).toEqual([]);
      expect(files.opened()).toEqual([]);
      owned.clear(heartbeatPath());
    }
    files.special(heartbeatPath());
    files.forget();
    expect((await heartbeats.read(NOW, alive)).found).toEqual([]);
    expect(files.opened()).toEqual([]);
  });

  test("checks the open file too, so one swapped in after its lookup is not read", async () => {
    const files = memoryFiles();
    const base = ownedFiles(files);
    let opens = 0;
    const io = {
      ...base.io,
      async openRegular(file: string) {
        const open = await base.io.openRegular(file);
        opens += 1;
        return { ...open, info: { ...open.info, uid: OTHER_UID } };
      },
    };
    writeHeartbeat(files, heartbeat());
    const heartbeats = createHeartbeatReader({
      dir: HEARTBEATS_DIR,
      io,
      platform: "linux",
      euid: TEST_UID,
      sweepMs: 60 * SECOND,
    });
    expect((await heartbeats.read(NOW, alive)).found).toEqual([]);
    expect(opens).toBe(1);
  });

  test("on Windows the owner and permission bits are not asked, and a second name still is", async () => {
    const files = memoryFiles();
    const owned = ownedFiles(files);
    owned.set(heartbeatPath(), { uid: 0, mode: 0o100666 });
    owned.set(HEARTBEATS_DIR, { uid: 0 });
    writeHeartbeat(files, heartbeat());
    const heartbeats = reader(files, owned, "win32");
    expect((await heartbeats.read(NOW, alive)).found).toHaveLength(1);
    owned.set(heartbeatPath(), { nlink: 2 });
    writeHeartbeat(files, heartbeat({ updatedAt: NOW + SECOND }));
    expect((await heartbeats.read(NOW + 2 * SECOND, alive)).found).toEqual([]);
  });

  test("a folder of heartbeats of another user, or a link, cannot be listed", async () => {
    const files = memoryFiles();
    const owned = ownedFiles(files);
    writeHeartbeat(files, heartbeat());
    owned.set(HEARTBEATS_DIR, { uid: OTHER_UID });
    const heartbeats = reader(files, owned);
    expect(await heartbeats.read(NOW, alive)).toMatchObject({ folder: "unlistable", found: [] });
    expect(files.count("readdir")).toBe(0);
    owned.clear(HEARTBEATS_DIR);
    expect((await heartbeats.read(NOW + SECOND, alive)).folder).toBe("listed");
    const missing = reader(memoryFiles());
    expect((await missing.read(NOW, alive)).folder).toBe("missing");
  });

  test("never looks up a temporary file, a removed file or a lock folder", async () => {
    const files = memoryFiles();
    writeHeartbeat(files, heartbeat());
    for (const name of [
      `.${SESSION_ID}.json.4242.0b5d.tmp`,
      `.${SESSION_ID}.json.4242.0b5d.tombstone`,
    ]) {
      writeHeartbeat(files, heartbeat(), { name });
    }
    files.mkdir(`${HEARTBEATS_DIR}/${SESSION_ID}.json.lock`);
    files.write(`${HEARTBEATS_DIR}/${SESSION_ID}.json.lock/0b5d.owner`, "{}");
    const heartbeats = reader(files);
    await heartbeats.read(NOW, alive);
    const looked = files.calls
      .filter((call) => call.method !== "readdir")
      .map((call) => call.path.slice(HEARTBEATS_DIR.length + 1));
    expect(new Set(looked)).toEqual(new Set(["", `${SESSION_ID}.json`]));
  });

  test("leaves out a heartbeat whose name is not its session's, and says when one is of another format", async () => {
    const files = memoryFiles();
    writeHeartbeat(files, heartbeat({ sessionId: OTHER_SESSION_ID }));
    writeHeartbeat(files, heartbeat({ version: 2 }), { name: `${OTHER_SESSION_ID}.json` });
    const read = await reader(files).read(NOW, alive);
    expect(read.found).toEqual([]);
    expect(read.newer).toBe(true);
  });

  test("reads the 200 written most recently when there are more", async () => {
    const files = memoryFiles();
    for (let index = 0; index < 250; index += 1) {
      const id = `${String(index).padStart(4, "0")}-session`;
      writeHeartbeat(files, heartbeat({ sessionId: id }), {
        name: `${id}.json`,
        mtimeMs: NOW - index * SECOND,
      });
    }
    const read = await reader(files).read(NOW, alive);
    expect(read.found).toHaveLength(MAX_HEARTBEAT_FILES);
    expect(read.found.map((one) => one.heartbeat.sessionId)).not.toContain("0200-session");
    expect(read.found.map((one) => one.heartbeat.sessionId)).toContain("0199-session");
    expect(files.opened()).toHaveLength(MAX_HEARTBEAT_FILES);
  });

  test("a heartbeat cut off as it was written, or not read once, stands in from before, once", async () => {
    for (const failure of ["torn", "open"] as const) {
      const files = memoryFiles();
      writeHeartbeat(files, heartbeat({ phase: "waiting_input" }));
      const heartbeats = reader(files);
      expect((await heartbeats.read(NOW, alive)).found).toHaveLength(1);
      if (failure === "torn") {
        writeHeartbeat(files, heartbeat().slice(0, 50), { mtimeMs: NOW + SECOND });
      } else {
        writeHeartbeat(files, heartbeat(), { mtimeMs: NOW + SECOND });
        files.failOpen(heartbeatPath());
      }
      const standIn = await heartbeats.read(NOW + 2 * SECOND, alive);
      expect(
        standIn.found.map((one) => one.heartbeat.phase),
        failure,
      ).toEqual(["waiting_input"]);
      expect((await heartbeats.read(NOW + 4 * SECOND, alive)).found, failure).toEqual([]);
    }
  });

  test("a file found with its process gone stays so while it is unchanged, and is asked again once it changes", async () => {
    const files = memoryFiles();
    writeHeartbeat(files, heartbeat());
    const heartbeats = reader(files);
    const asked: number[] = [];
    let running = false;
    const ask = (pid: number) => (asked.push(pid), running);
    expect((await heartbeats.read(NOW, ask)).found.map((one) => one.alive)).toEqual([false]);
    // The ID is given to a new process: the file, unchanged, is still the dead one's.
    running = true;
    expect((await heartbeats.read(NOW + 2 * SECOND, ask)).found.map((one) => one.alive)).toEqual([
      false,
    ]);
    expect(asked).toEqual([PID]);
    writeHeartbeat(files, heartbeat({ updatedAt: NOW + 3 * SECOND }));
    expect((await heartbeats.read(NOW + 4 * SECOND, ask)).found.map((one) => one.alive)).toEqual([
      true,
    ]);
    expect(asked).toEqual([PID, PID]);
  });

  test("keeps what each of two processes sharing a file last wrote, while it is fresh, its process runs and the file is there", async () => {
    const files = memoryFiles();
    const heartbeats = reader(files);
    const running = new Set([PID, OTHER_PID]);
    const ask = (pid: number) => running.has(pid);
    writeHeartbeat(files, heartbeat({ pid: PID, phase: "waiting_input" }));
    await heartbeats.read(NOW, ask);
    writeHeartbeat(files, heartbeat({ pid: OTHER_PID, phase: "idle", updatedAt: NOW + SECOND }));
    const both = await heartbeats.read(NOW + 2 * SECOND, ask);
    expect(both.found.map((one) => [one.heartbeat.pid, one.heartbeat.phase])).toEqual([
      [OTHER_PID, "idle"],
      [PID, "waiting_input"],
    ]);

    // Not once the other's process has gone,
    running.delete(PID);
    const gone = await heartbeats.read(NOW + 3 * SECOND, ask);
    expect(gone.found.map((one) => one.heartbeat.pid)).toEqual([OTHER_PID]);
    running.add(PID);
    // nor once what it wrote is over 15 seconds old,
    const old = await heartbeats.read(NOW + 15 * SECOND + 1, ask);
    expect(old.found.map((one) => one.heartbeat.pid)).toEqual([OTHER_PID]);
    // nor once the file is gone.
    writeHeartbeat(
      files,
      heartbeat({ pid: PID, phase: "waiting_input", updatedAt: NOW + 16 * SECOND }),
    );
    await heartbeats.read(NOW + 16 * SECOND, ask);
    writeHeartbeat(files, heartbeat({ pid: OTHER_PID, updatedAt: NOW + 17 * SECOND }));
    expect((await heartbeats.read(NOW + 18 * SECOND, ask)).found).toHaveLength(2);
    removeHeartbeat(files);
    expect((await heartbeats.read(NOW + 19 * SECOND, ask)).found).toEqual([]);
    writeHeartbeat(files, heartbeat({ pid: OTHER_PID, updatedAt: NOW + 20 * SECOND }));
    const after = await heartbeats.read(NOW + 21 * SECOND, ask);
    expect(after.found.map((one) => one.heartbeat.pid)).toEqual([OTHER_PID]);
  });

  test("reads a heartbeat with an instance's ID in its name", async () => {
    const files = memoryFiles();
    writeHeartbeat(files, heartbeat({ communication: true }), {
      name: `${SESSION_ID}.${INSTANCE_ID}.json`,
    });
    const read = await reader(files).read(NOW, alive);
    expect(read.found.map((one) => one.name)).toEqual([`${SESSION_ID}.${INSTANCE_ID}.json`]);
  });
});
