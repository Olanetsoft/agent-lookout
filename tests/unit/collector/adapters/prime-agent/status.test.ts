import { expect, test } from "vitest";

import {
  BASIS,
  BASIS_WITHOUT_LEASES,
  createPrimeAgentStatus,
  WINDOWS_NOTE,
} from "@collector/adapters/prime-agent/status";
import {
  AGENT_DIR,
  checkpoint,
  DAY,
  HOME,
  journalOf,
  LEASE_TOKEN,
  lstartOf,
  MINUTE,
  NOW,
  ownerOf,
  ownerText,
  PID,
  PROCESS_STARTED_AT,
  SECOND,
  SESSION_ID,
  sessionIdOf,
  STARTED_AT,
  WORKERS_DIR,
} from "@tests/fixtures/prime-agent/primeAgent";
import {
  primeAgentFiles,
  standInAlive,
  standInPs,
  type PrimeAgentFiles,
} from "@tests/support/adapters/prime-agent/primeAgentAdapter";

function statusOn(files: PrimeAgentFiles, platform: NodeJS.Platform = "darwin", running = [PID]) {
  const ps = standInPs(
    new Map([[PID, { lstart: lstartOf(PROCESS_STARTED_AT), program: "prime-agent" }]]),
  );
  const source = createPrimeAgentStatus({
    agentDir: AGENT_DIR,
    homeDir: HOME,
    io: files.io,
    platform,
    now: () => NOW,
    isAlive: standInAlive(running).isAlive,
    uptimeMs: () => 30 * DAY,
    runPs: ps.run,
  });
  return { source, ps };
}

const sessions = [{ id: SESSION_ID, fileName: `${SESSION_ID}.jsonl`, writtenAt: NOW - MINUTE }];

test("a poll that lists nothing, or finds no folder, is read the usual way", () => {
  expect(statusOn(primeAgentFiles()).source.emptyBasis).toBe(BASIS);
  expect(statusOn(primeAgentFiles(), "win32").source.emptyBasis).toBe(BASIS);
});

test("the workers' folder is not looked at while no process that runs holds a listed session", async () => {
  const files = primeAgentFiles();
  files.write(ownerOf(1), ownerText(SESSION_ID));
  files.write(
    journalOf(),
    checkpoint({ busy: true, operation: "prompt_accepted", at: STARTED_AT + SECOND }),
  );
  const { source } = statusOn(files, "darwin", []);
  const answer = await source.read({ now: NOW, sessions });
  expect(answer.byId.get(SESSION_ID)).toEqual({ status: "finished", since: null });
  expect(files.count(undefined, (target) => target.startsWith(WORKERS_DIR))).toBe(0);
});

test("a lease it cannot read names the poll apart before a ps that failed does", async () => {
  const files = primeAgentFiles();
  files.write(ownerOf(1), ownerText(SESSION_ID));
  files.write(ownerOf(2), `{"token":"${LEASE_TOKEN}`);
  const { source, ps } = statusOn(files);
  ps.fail();
  const answer = await source.read({
    now: NOW,
    sessions: [
      ...sessions,
      { id: sessionIdOf(2), fileName: `${sessionIdOf(2)}.jsonl`, writtenAt: NOW },
    ],
  });
  expect(answer.basis).toBe(BASIS_WITHOUT_LEASES);
  expect(answer.detail).toBe(
    "A lease in ~/.prime/agent/session-leases could not be read, so a session no running prime-agent holds shows as unknown, not finished.",
  );
  expect(answer.byId.get(SESSION_ID)?.status).toBe("unknown");
  expect(answer.byId.get(sessionIdOf(2))?.status).toBe("unknown");
  expect(JSON.stringify([...answer.byId])).not.toContain(LEASE_TOKEN);
});

test("on Windows every poll says why a held lease is unknown", async () => {
  const files = primeAgentFiles();
  files.mkdir(AGENT_DIR);
  const missing = await statusOn(files, "win32").source.read({ now: NOW, sessions });
  expect(missing.detail).toBe(
    `~/.prime/agent/session-leases is missing or could not be listed, so each session shows as unknown. ${WINDOWS_NOTE}`,
  );
  files.write(ownerOf(1), ownerText(SESSION_ID));
  const held = await statusOn(files, "win32").source.read({ now: NOW, sessions });
  expect(held).toEqual({
    basis: BASIS,
    detail: WINDOWS_NOTE,
    byId: new Map([[SESSION_ID, { status: "unknown", since: null }]]),
  });
});
