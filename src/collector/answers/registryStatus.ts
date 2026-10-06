import os from "node:os";
import path from "node:path";

import type { SessionsSnapshot } from "../../core/sessions/session.ts";
import { mapClaudeCodeWaitingFor } from "../../core/mapping/claudeCodeMapping.ts";
import { CLAUDE_HOME_ENV } from "../adapters/claude-code/index.ts";
import { parseRegistryEntry, readRegularFile } from "../adapters/claude-code/registry.ts";
import type { RegistryReading, StatusReader } from "./heldAsks.ts";

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
  const home = options.env[CLAUDE_HOME_ENV]?.trim() || path.join(homeDir, ".claude");
  const sessionsDir = path.join(path.resolve(home), "sessions");

  return {
    async statusOf(sessionId): Promise<RegistryReading> {
      const unknown: RegistryReading = { status: "unknown" };
      const session = options.snapshot().sessions.find((candidate) => candidate.id === sessionId);
      if (!session || session.source !== "claude-code" || session.alive === false) return unknown;
      const pid = session.pid;
      if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1) return unknown;
      const ownId = sessionId.slice("claude-code:".length);
      let content: string;
      try {
        content = await readFile(path.join(sessionsDir, `${pid}.json`));
      } catch {
        return unknown;
      }
      const entry = parseRegistryEntry(content);
      if (entry === null || entry.pid !== pid || entry.sessionId !== ownId) return unknown;
      const forPermission =
        entry.status === "waiting" &&
        mapClaudeCodeWaitingFor(entry.waitingFor).waitingReason === "permission";
      if (!forPermission) return { status: "not-waiting" };
      return {
        status: "waiting",
        wait: `${entry.statusUpdatedAt ?? ""}|${entry.waitingFor ?? ""}`,
      };
    },
  };
}
