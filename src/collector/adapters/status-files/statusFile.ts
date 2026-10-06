import { clean, cut, MAX_NAME_LENGTH } from "../../../core/text.ts";
import { validPid } from "../../processes/pids.ts";

/**
 * One status file: a small JSON object that any program writes to say what one
 * of its sessions is doing. The format is Agent Lookout's own, and
 * docs/GUIDE.md describes it under "Your own agents":
 *
 * ```json
 * { "agent": "Night Shift", "name": "checkout-flow", "cwd": "/Users/example/code/checkout-flow",
 *   "status": "waiting", "reason": "permission", "since": "2026-10-05T18:00:00Z", "pid": 4242,
 *   "app": "terminal" }
 * ```
 *
 * `agent` and `status` are required. Everything else is optional, and a field
 * this version does not know is ignored. Nothing in a file is trusted: every
 * text is cleaned and cut to a length, and nothing from it is ever used as
 * markup, a link, a command or a path to open.
 */
export interface StatusFile {
  /** The agent's own name, such as "Night Shift". */
  agent: string;
  /** The session's name. */
  name?: string;
  /** The working folder, when the file gives one. */
  cwd?: string;
  /** As written, in lower case: `working`, `waiting`, `idle`, `finished` or `failed`, or a word this version does not know. */
  status: string;
  /** As written, in lower case: `permission` or `question`, for a session that is waiting. */
  reason?: string;
  /** When the status began, in epoch milliseconds. Whether it could be right is decided where the clock is known. */
  since?: number;
  /** The process the session runs in. */
  pid?: number;
  /** As written, in lower case: `terminal`, `vscode` or `desktop`, or a word this version does not know. */
  app?: string;
}

/** The most files read in one poll. The rest are skipped and counted. */
export const MAX_FILES = 200;

/** The largest file that is read. A larger one is skipped and counted, and not read. */
export const MAX_FILE_BYTES = 16 * 1024;

/** The longest agent name kept, in characters. A longer one is cut. */
export const MAX_AGENT_LENGTH = 40;

// The longest session name kept, and the rule every text in a file is cleaned
// by, are the core's, which branches and the names other agents give share.
export { MAX_NAME_LENGTH };

/** The longest working folder kept. A longer one is not kept at all, since a cut path is a wrong one. */
export const MAX_CWD_LENGTH = 1024;

/** A status, a reason or an app longer than this is no word this format has. */
const MAX_WORD_LENGTH = 40;

/**
 * An ISO 8601 time to the minute or finer, with or without a zone, such as
 * `2026-10-05T18:00:00Z` or `2026-10-05T19:00:00.5+01:00`. A time without a
 * zone is local time.
 */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/** Whether a name in the folder is one to read: it ends in `.json` and is not hidden. */
export function isStatusFileName(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".");
}

/** One of the format's words, in lower case. */
function word(value: unknown): string | undefined {
  const text = clean(value);
  return text !== undefined && text.length <= MAX_WORD_LENGTH ? text.toLowerCase() : undefined;
}

/** Epoch milliseconds, or an ISO 8601 time, as epoch milliseconds. */
function timeOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!ISO_8601.test(text)) return undefined;
  const at = Date.parse(text);
  return Number.isSafeInteger(at) ? at : undefined;
}

/**
 * Parses one status file. Returns null for anything that is not one: text that
 * is not JSON, JSON that is not an object, and an object with no `agent` or no
 * `status`. A field of the wrong kind is left out as if it were not there.
 */
export function parseStatusFile(content: string): StatusFile | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const raw = value as Record<string, unknown>;
  const agent = cut(raw.agent, MAX_AGENT_LENGTH);
  const status = word(raw.status);
  if (agent === undefined || status === undefined) return null;

  const file: StatusFile = { agent, status };
  const name = cut(raw.name, MAX_NAME_LENGTH);
  if (name !== undefined) file.name = name;
  const cwd = clean(raw.cwd);
  if (cwd !== undefined && cwd.length <= MAX_CWD_LENGTH) file.cwd = cwd;
  const reason = word(raw.reason);
  if (reason !== undefined) file.reason = reason;
  const since = timeOf(raw.since);
  if (since !== undefined) file.since = since;
  const pid = validPid(raw.pid);
  if (pid !== undefined) file.pid = pid;
  const app = word(raw.app);
  if (app !== undefined) file.app = app;
  return file;
}
