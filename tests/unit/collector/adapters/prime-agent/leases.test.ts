import { describe, expect, test } from "vitest";

import {
  createLeaseReader,
  MAX_OWNER_BYTES,
  parseOwner,
} from "@collector/adapters/prime-agent/leases";
import {
  AGENT_DIR,
  iso,
  LEASE_TOKEN,
  LEASES_DIR,
  leaseNameOf,
  leaseOf,
  ownerOf,
  ownerText,
  PID,
  PRIVATE_FOLDER,
  PROC_START_ID,
  PS_START_ID,
  SESSION_ID,
  sessionIdOf,
  STARTED_AT,
  WORKER_ID,
} from "@tests/fixtures/prime-agent/primeAgent";
import { primeAgentFiles } from "@tests/support/adapters/prime-agent/primeAgentAdapter";

const NOW = STARTED_AT + 60_000;

describe("an owner.json", () => {
  test("keeps the pid, when it was taken, its process's start and its worker, by the name of the session's file", () => {
    expect(parseOwner(ownerText(SESSION_ID))).toStrictEqual({
      fileName: `${SESSION_ID}.jsonl`,
      lease: {
        pid: PID,
        createdAt: STARTED_AT,
        processStartId: PS_START_ID,
        activeSessionId: WORKER_ID,
      },
    });
  });

  test("drops the token and the folders of the session's path with the parsed file", () => {
    const parsed = JSON.stringify(parseOwner(ownerText(SESSION_ID)));
    expect(parsed).not.toContain(LEASE_TOKEN);
    expect(parsed).not.toContain(PRIVATE_FOLDER);
  });

  test("keeps a start or a worker only in the shapes Prime Agent writes them", () => {
    const lease = (fields: Parameters<typeof ownerText>[1]) => {
      const parsed = parseOwner(ownerText(SESSION_ID, fields));
      if (!("lease" in parsed)) throw new Error(parsed.reason);
      return parsed.lease;
    };
    expect(lease({ processStartId: PROC_START_ID }).processStartId).toBe(PROC_START_ID);
    expect(lease({ processStartId: "win:133000000000000000" }).processStartId).toBe(
      "win:133000000000000000",
    );
    expect(lease({ processStartId: "proc:12a" })).not.toHaveProperty("processStartId");
    expect(lease({ processStartId: `ps:${"x".repeat(65)}` })).not.toHaveProperty("processStartId");
    expect(lease({ processStartId: undefined })).not.toHaveProperty("processStartId");
    expect(lease({ activeSessionId: "../journal" })).not.toHaveProperty("activeSessionId");
    expect(lease({ activeSessionId: undefined })).not.toHaveProperty("activeSessionId");
    // A Windows path names the file the same way.
    expect(
      parseOwner(
        ownerText(SESSION_ID, {
          sessionPath: `C:\\Users\\example\\.prime\\agent\\sessions\\${SESSION_ID}.jsonl`,
        }),
      ),
    ).toMatchObject({ fileName: `${SESSION_ID}.jsonl` });
  });

  test("keeps a file's name that is not a session's ID, as one given to --resume", () => {
    for (const name of ["demo-project.jsonl", "scratch notes.jsonl", "notes.txt"]) {
      expect(
        parseOwner(ownerText(SESSION_ID, { sessionPath: `/Users/example/code/demo/${name}` })),
      ).toMatchObject({ fileName: name });
    }
  });

  test("with a field Prime Agent never writes that way cannot be told whose it is", () => {
    expect(parseOwner(ownerText(SESSION_ID, { version: 2 }))).toEqual({
      reason: "another version",
    });
    for (const fields of [
      { pid: 0 },
      { pid: "4242" },
      { createdAt: "yesterday" },
      { sessionPath: 7 },
      { sessionPath: undefined },
    ]) {
      expect(parseOwner(ownerText(SESSION_ID, fields)), JSON.stringify(fields)).toEqual({
        reason: "bad fields",
      });
    }
  });

  test("that is not JSON gives a fixed reason, and no byte of the file", () => {
    const broken = `{"token":"${LEASE_TOKEN}\u0000`;
    const parsed = parseOwner(broken);
    expect(parsed).toEqual({ reason: "bad JSON" });
    expect(JSON.stringify(parsed)).not.toContain(LEASE_TOKEN);
  });
});

describe("the leases folder", () => {
  test("gives each lease by its session, and nothing of the others but whose they are not", async () => {
    const files = primeAgentFiles();
    files.write(ownerOf(1), ownerText(SESSION_ID));
    files.write(ownerOf(2), ownerText(sessionIdOf(2), { pid: PID + 1 }));
    files.mkdir(`${LEASES_DIR}/${leaseNameOf(3).replace(".lock", ".lock.guard")}`);
    files.mkdir(`${LEASES_DIR}/${leaseNameOf(4).replace(".lock", ".lock.candidate-1-ab")}`);
    files.write(
      `${LEASES_DIR}/${leaseNameOf(5).replace(".lock", ".lock.stale-1-ab")}/owner.json`,
      "x",
    );
    const read = await createLeaseReader(AGENT_DIR, files.io).read(NOW);
    expect(read).toStrictEqual({
      state: "listed",
      byFile: new Map([
        [
          `${SESSION_ID}.jsonl`,
          [
            {
              pid: PID,
              createdAt: STARTED_AT,
              processStartId: PS_START_ID,
              activeSessionId: WORKER_ID,
            },
          ],
        ],
        [
          `${sessionIdOf(2)}.jsonl`,
          [
            {
              pid: PID + 1,
              createdAt: STARTED_AT,
              processStartId: PS_START_ID,
              activeSessionId: WORKER_ID,
            },
          ],
        ],
      ]),
      stray: [],
    });
    expect(files.opened()).toEqual([ownerOf(1), ownerOf(2)]);
  });

  test("names a lease it cannot read as one it cannot tell, with its folder's time", async () => {
    const files = primeAgentFiles(() => STARTED_AT);
    files.mkdir(leaseOf(1));
    files.special(leaseOf(2));
    files.write(ownerOf(3), "x".repeat(MAX_OWNER_BYTES + 1));
    files.write(ownerOf(4), `{"token":"${LEASE_TOKEN}`);
    files.special(ownerOf(5));
    const read = await createLeaseReader(AGENT_DIR, files.io).read(NOW);
    expect(read.state === "listed" && read.stray).toEqual([
      { name: leaseNameOf(1), reason: "no owner.json", folderMtimeMs: STARTED_AT },
      { name: leaseNameOf(2), reason: "not a folder", folderMtimeMs: STARTED_AT },
      { name: leaseNameOf(3), reason: "too large", folderMtimeMs: STARTED_AT },
      { name: leaseNameOf(4), reason: "bad JSON", folderMtimeMs: STARTED_AT },
      { name: leaseNameOf(5), reason: "not a file", folderMtimeMs: STARTED_AT },
    ]);
    // A link is never followed: neither the folder's nor the file's is opened.
    expect(files.opened()).toEqual([ownerOf(4)]);
    expect(JSON.stringify(read)).not.toContain(LEASE_TOKEN);
  });

  test("is missing, or cannot be listed, as a link or anything but a folder", async () => {
    const files = primeAgentFiles();
    files.mkdir(AGENT_DIR);
    expect(await createLeaseReader(AGENT_DIR, files.io).read(NOW)).toEqual({ state: "missing" });
    files.special(LEASES_DIR);
    expect(await createLeaseReader(AGENT_DIR, files.io).read(NOW)).toEqual({ state: "unlistable" });
    expect(files.count("readdir")).toBe(0);
  });

  test("opens an owner.json again only when it changed, and forgets a lease that went", async () => {
    const files = primeAgentFiles();
    const reader = createLeaseReader(AGENT_DIR, files.io);
    files.write(ownerOf(1), ownerText(SESSION_ID));
    await reader.read(NOW);
    files.forget();
    await reader.read(NOW + 2_000);
    expect(files.opened()).toEqual([]);
    files.write(ownerOf(1), ownerText(SESSION_ID, { createdAt: iso(STARTED_AT + 1_000) }));
    const changed = await reader.read(NOW + 4_000);
    expect(
      changed.state === "listed" && changed.byFile.get(`${SESSION_ID}.jsonl`)?.[0]?.createdAt,
    ).toBe(STARTED_AT + 1_000);
    files.remove(leaseOf(1));
    const gone = await reader.read(NOW + 6_000);
    expect(gone.state === "listed" && gone.byFile.size).toBe(0);
  });

  test("lists the folder again only when its time moves, and once a minute", async () => {
    const files = primeAgentFiles();
    const reader = createLeaseReader(AGENT_DIR, files.io);
    files.write(ownerOf(1), ownerText(SESSION_ID));
    await reader.read(NOW);
    await reader.read(NOW + 2_000);
    expect(files.count("readdir", (target) => target === LEASES_DIR)).toBe(1);
    files.touch(LEASES_DIR, NOW + 3_000);
    await reader.read(NOW + 4_000);
    await reader.read(NOW + 64_000);
    expect(files.count("readdir", (target) => target === LEASES_DIR)).toBe(3);
  });
});
