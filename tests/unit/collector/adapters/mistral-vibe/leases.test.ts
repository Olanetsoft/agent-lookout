import { describe, expect, test } from "vitest";

import {
  createLeaseReader,
  LEASE_FILE_LIMIT_BYTES,
  readLeaseFile,
  sessionOfLeaseFile,
} from "@collector/adapters/mistral-vibe/leases";
import {
  HOUR,
  NOW,
  SESSION_DIR,
  SUBAGENT_ID,
  leaseFile,
  sessionId,
} from "@tests/fixtures/mistralVibe";
import { memoryFiles, writeLease } from "@tests/support/adapters/mistralVibeAdapter";

const ACTIVE = `${SESSION_DIR}/active`;
const A = sessionId("a1");
const B = sessionId("b1");

describe("the names in the folder of leases", () => {
  test("a session's lock and its .json name the session", () => {
    expect(sessionOfLeaseFile(`${A}.lock`)).toEqual({ id: A, json: false });
    expect(sessionOfLeaseFile(`${A}.lock.json`)).toEqual({ id: A, json: true });
  });

  test("Vibe's own files, a subagent's lease, the lease of no session and any other name are not a session's", () => {
    for (const name of [
      ".registry",
      ".watch-0123456789abcdef0123456789abcdef",
      `${SUBAGENT_ID}.lock`,
      `${SUBAGENT_ID}.lock.json`,
      "process-output-cleanup.lock",
      "process-output-cleanup.lock.json",
      ".lock",
      "-starts-with-a-dash.lock",
      "has space.lock",
      `${"a".repeat(129)}.lock`,
      `${A}.json`,
      `${A}.lock.tmp`,
      A,
    ]) {
      expect(sessionOfLeaseFile(name), name).toBeNull();
    }
  });
});

describe("a lease's .json", () => {
  test("names the pid that took it and when", () => {
    expect(readLeaseFile(leaseFile(A, 4242, NOW - HOUR))).toEqual({
      pid: 4242,
      acquiredAt: NOW - HOUR,
    });
  });

  test("an empty, torn or foreign file names no pid", () => {
    const whole = leaseFile(A, 4242);
    for (const text of ["", whole.slice(0, 20), "[]", "null", "not json"]) {
      expect(readLeaseFile(text).pid, JSON.stringify(text)).toBeNull();
    }
  });

  test("a pid that could not be one is no pid", () => {
    for (const pid of [true, false, 0, -1, 1.5, "12", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(readLeaseFile(leaseFile(A, pid)).pid, String(pid)).toBeNull();
    }
  });

  test("a time not written as Vibe writes one is not read", () => {
    const text = JSON.stringify({ acquired_at: "yesterday", process_id: 4242, session_id: A });
    expect(readLeaseFile(text)).toEqual({ pid: 4242, acquiredAt: null });
  });
});

describe("reading the folder of leases", () => {
  test("lists the sessions with a lock, each with the pid its .json names", async () => {
    const files = memoryFiles();
    writeLease(files, A, 4242);
    writeLease(files, B, 4343);
    const leases = await createLeaseReader(ACTIVE, files.io).read();
    expect(leases).toEqual({
      supported: true,
      held: new Map([
        [A, { pid: 4242, acquiredAt: NOW - HOUR }],
        [B, { pid: 4343, acquiredAt: NOW - HOUR }],
      ]),
    });
  });

  test("a lock with no .json yet, or an empty one, is held with no pid", async () => {
    const files = memoryFiles();
    files.write(`${ACTIVE}/${A}.lock`, "");
    files.write(`${ACTIVE}/${B}.lock`, "");
    files.write(`${ACTIVE}/${B}.lock.json`, "");
    const leases = await createLeaseReader(ACTIVE, files.io).read();
    expect(leases.supported && [...leases.held]).toEqual([
      [A, { pid: null, acquiredAt: null }],
      [B, { pid: null, acquiredAt: null }],
    ]);
  });

  test("a .json with no lock is one Vibe let go of, and is not read", async () => {
    const files = memoryFiles();
    files.write(`${ACTIVE}/${A}.lock.json`, leaseFile(A));
    const leases = await createLeaseReader(ACTIVE, files.io).read();
    expect(leases).toEqual({ supported: true, held: new Map() });
    expect(files.opened()).toEqual([]);
  });

  test("an oversized .json, or one that is not an ordinary file, is not read", async () => {
    const files = memoryFiles();
    files.write(`${ACTIVE}/${A}.lock`, "");
    files.write(`${ACTIVE}/${A}.lock.json`, `${leaseFile(A)}${" ".repeat(LEASE_FILE_LIMIT_BYTES)}`);
    files.write(`${ACTIVE}/${B}.lock`, "");
    files.special(`${ACTIVE}/${B}.lock.json`);
    const leases = await createLeaseReader(ACTIVE, files.io).read();
    expect(leases.supported && [...leases.held.values()].map((lease) => lease.pid)).toEqual([
      null,
      null,
    ]);
    expect(files.opened()).toEqual([]);
  });

  test("never opens a lock, the folder's own lock, or anything but a held lease's .json", async () => {
    const files = memoryFiles();
    writeLease(files, A);
    files.write(`${ACTIVE}/.registry`, "");
    files.write(`${ACTIVE}/.watch-0123456789abcdef0123456789abcdef`, "");
    writeLease(files, SUBAGENT_ID);
    files.write(`${ACTIVE}/process-output-cleanup.lock`, "");
    files.write(`${ACTIVE}/process-output-cleanup.lock.json`, leaseFile("process-output-cleanup"));
    const leases = await createLeaseReader(ACTIVE, files.io).read();
    expect(leases.supported && [...leases.held.keys()]).toEqual([A]);
    expect(files.opened()).toEqual([`${ACTIVE}/${A}.lock.json`]);
    // Nothing else in the folder is even looked at.
    const touched = files.calls
      .filter((call) => call.method !== "readdir")
      .map((call) => call.path);
    expect(touched).toEqual([`${ACTIVE}/${A}.lock.json`, `${ACTIVE}/${A}.lock.json`]);
  });

  test("reads a .json again only when it changed", async () => {
    const files = memoryFiles();
    writeLease(files, A, 4242);
    const reader = createLeaseReader(ACTIVE, files.io);
    await reader.read();
    await reader.read();
    expect(files.opened()).toHaveLength(1);

    // A new program takes the lease: Vibe writes the .json over.
    files.rewrite(`${ACTIVE}/${A}.lock.json`, leaseFile(A, 5151), { mtimeMs: NOW + 1_000 });
    const leases = await reader.read();
    expect(files.opened()).toHaveLength(2);
    expect(leases.supported && leases.held.get(A)?.pid).toBe(5151);
  });

  test("a torn .json is read again once Vibe finishes writing it", async () => {
    const files = memoryFiles();
    files.write(`${ACTIVE}/${A}.lock`, "");
    files.write(`${ACTIVE}/${A}.lock.json`, "", { mtimeMs: NOW });
    const reader = createLeaseReader(ACTIVE, files.io);
    const first = await reader.read();
    expect(first.supported && first.held.get(A)?.pid).toBeNull();
    files.rewrite(`${ACTIVE}/${A}.lock.json`, leaseFile(A, 4242), { mtimeMs: NOW + 5 });
    const second = await reader.read();
    expect(second.supported && second.held.get(A)?.pid).toBe(4242);
  });

  test("a folder that is missing, or cannot be listed, says so", async () => {
    const files = memoryFiles();
    expect(await createLeaseReader(ACTIVE, files.io).read()).toEqual({
      supported: false,
      missing: true,
    });
    files.mkdir(ACTIVE);
    files.fail(ACTIVE);
    expect(await createLeaseReader(ACTIVE, files.io).read()).toEqual({
      supported: false,
      missing: false,
    });
  });

  test("a .json that cannot be read this time names no pid, and its lock still holds", async () => {
    const files = memoryFiles();
    writeLease(files, A);
    files.fail(`${ACTIVE}/${A}.lock.json`);
    const leases = await createLeaseReader(ACTIVE, files.io).read();
    expect(leases.supported && leases.held.get(A)).toEqual({ pid: null, acquiredAt: null });
  });
});
