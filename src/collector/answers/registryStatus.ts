import os from "node:os";
import path from "node:path";

import type { SessionsSnapshot } from "../../core/sessions/session.ts";
import { mapClaudeCodeWaitingFor } from "../../core/mapping/claudeCodeMapping.ts";
import { claudeHomeFor } from "../adapters/claude-code/index.ts";
import { parseRegistryEntry, readRegularFile } from "../adapters/claude-code/registry.ts";
import { GRACE_MS, OWN_WAIT_MS, type RegistryReading, type StatusReader } from "./heldAsks.ts";

/**
 * Whether a Claude Code session is still waiting for permission, and which
 * wait it is, from its registry file read again at this moment:
 * `<claude home>/sessions/<pid>.json`, the pid being the one the collector
 * lists the session with. Nothing the hook sent names the file. The file must
 * still be that session's, and opened as the adapter opens it: no link
 * followed, no pipe read, nothing large.
 *
 * Only a wait for permission counts as waiting: a session waiting for
 * anything else has moved on from the prompt the hook asked about. A wait is
 * told from the next by `statusUpdatedAt` and `waitingFor` together, so a
 * prompt answered in the session and followed by another between two reads
 * is not taken for the same wait.
 *
 * Two processes can have one session open, and the collector lists one of them
 * at a time. A request stays with the process it was confirmed in the wait of,
 * so it is not let go for what the other does. One that arrives before the
 * collector lists its process is confirmed in the other's wait, and is read in
 * its own once that is listed: a wait that began as the request arrived. Should
 * the other begin a new wait in that time, as with a second prompt of its own,
 * the request is taken for that one's, and shows on its row while it lasts.
 */
export interface RegistryStatusOptions {
  /** The collector's own latest list of sessions. */
  snapshot: () => SessionsSnapshot;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  readFile?: (file: string) => Promise<string>;
}

export function createRegistryStatus(options: RegistryStatusOptions): StatusReader {
  const homeDir = options.homeDir ?? os.homedir();
  const readFile = options.readFile ?? readRegularFile;
  const sessionsDir = path.join(claudeHomeFor(options.env, homeDir), "sessions");
  const unknown: RegistryReading = { status: "unknown" };

  async function readingOf(sessionId: string, pid: number): Promise<RegistryReading> {
    let content: string;
    try {
      content = await readFile(path.join(sessionsDir, `${pid}.json`));
    } catch {
      return unknown;
    }
    const entry = parseRegistryEntry(content);
    const ownId = sessionId.slice("claude-code:".length);
    if (entry === null || entry.pid !== pid || entry.sessionId !== ownId) return unknown;
    const forPermission =
      entry.status === "waiting" &&
      mapClaudeCodeWaitingFor(entry.waitingFor).waitingReason === "permission";
    if (!forPermission) return { status: "not-waiting" };
    return {
      status: "waiting",
      wait: `${entry.statusUpdatedAt ?? ""}|${entry.waitingFor ?? ""}`,
      ...(entry.statusUpdatedAt !== undefined && { since: entry.statusUpdatedAt }),
      pid,
    };
  }

  return {
    async statusOf(sessionId, request) {
      const session = options.snapshot().sessions.find((candidate) => candidate.id === sessionId);
      if (!session || session.source !== "claude-code" || session.alive === false) return unknown;
      const pid = session.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return unknown;
      const listed = await readingOf(sessionId, pid);
      if (request?.pid === undefined || request.pid === pid) return listed;
      const own = (since: number | null | undefined) =>
        since != null &&
        since >= request.arrivedAt - OWN_WAIT_MS &&
        since <= request.arrivedAt + GRACE_MS;
      if (listed.status === "waiting" && own(listed.since) && !own(request.since)) return listed;
      return readingOf(sessionId, request.pid);
    },
  };
}
