import {
  foldV2Record,
  foldV3Row,
  isV2TurnStart,
  isV3TurnRow,
  startV2Scan,
  startV3Scan,
  type KiroV2Record,
  type KiroV2Scan,
  type KiroV3Row,
  type KiroV3Scan,
} from "../../../core/mapping/kiro-cli/kiroCliMapping.ts";
import type { LineReading } from "./lineLog.ts";

/**
 * What one line of a Kiro CLI log is, for the little a status needs. Built from
 * Kiro's documentation and open-source readers of its files, and not yet
 * checked on a computer running Kiro CLI.
 *
 * A V3 `messages.jsonl` row is `{"id":…,"timestamp":…,"payload":{"type":…}}`.
 * A line is parsed only when `"turn_`, `"pending_interaction"` or
 * `"interaction_resolved"` appears in it, which now and then is a prompt or a
 * tool's output that holds those words. Of a line parsed only `payload.type`,
 * `timestamp`, `payload.toolCallId` and `payload.interactionType` are kept,
 * and the rest is dropped with the parsed line. Every other line is
 * bookkeeping, a message or a tool's call or result, and is passed over
 * unparsed, once it is seen to start with `{` and end with `}`. A line that does
 * not, or that is parsed and is not a row, cannot be read, which makes the
 * status unknown until the next turn row.
 *
 * A V2 `<uuid>.jsonl` record is
 * `{"version":"v1","kind":…,"data":{"content":[…],"meta":{"timestamp":…}}}`.
 * Each record read is parsed, and of it only `version`, `kind`, whether an
 * `AssistantMessage`'s `data.content` holds a block of kind `toolUse`, and a
 * `Prompt`'s `data.meta.timestamp` are kept. A line that does not parse, has
 * another `version` or a kind not recognised makes the status unknown. What a prompt, a reply or a tool said is
 * dropped with the parsed line, never kept, copied or logged.
 */

/** RFC 3339, as Kiro writes its times: `2026-11-07T20:55:08.089Z`, with up to nine digits of a second. */
const KIRO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds of a time Kiro wrote, or null. Whether it could be right is asked later. */
export function parseKiroTime(value: unknown): number | null {
  if (typeof value !== "string" || !KIRO_TIME.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.floor(at) : null;
}

/** The longest `toolCallId` kept. A longer one is not one Kiro wrote. */
const MAX_ID_LENGTH = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

function idOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_ID_LENGTH ? value : null;
}

/** A hint that a V3 line may be one of the rows a status needs, checked before it is parsed. */
const V3_HINT = /"(?:turn_|pending_interaction"|interaction_resolved")/;

const TURN_TYPE = /^turn_/;

/** What one V3 line is, or null for a blank one. */
export function readV3Row(line: string): KiroV3Row | null {
  const text = line.trim();
  if (text === "") return null;
  if (!text.startsWith("{") || !text.endsWith("}")) return { kind: "unreadable" };
  if (!V3_HINT.test(text)) return { kind: "other" };
  const value = parse(text);
  if (!isRecord(value) || !isRecord(value.payload)) return { kind: "unreadable" };
  const { payload } = value;
  const type = payload.type;
  if (typeof type !== "string") return { kind: "unreadable" };
  const at = parseKiroTime(value.timestamp);
  if (type === "turn_start") return { kind: "turn-start", at };
  if (type === "turn_end") return { kind: "turn-end", at };
  if (TURN_TYPE.test(type)) return { kind: "turn-other" };
  if (type === "pending_interaction" || type === "interaction_resolved") {
    const toolCallId = idOf(payload.toolCallId);
    if (toolCallId === null) return { kind: "unreadable" };
    if (type === "interaction_resolved") return { kind: "resolved", toolCallId };
    return {
      kind: "pending",
      toolCallId,
      approval: payload.interactionType === "tool_approval",
      at,
    };
  }
  return { kind: "other" };
}

/** How a V3 row log is read: back to its newest turn row. */
export const V3_READING: LineReading<KiroV3Row, KiroV3Scan> = {
  row: readV3Row,
  floor: isV3TurnRow,
  start: startV3Scan,
  fold: foldV3Row,
};

/** The longest a prompt's time can be, in seconds: past the year 9999 it is not one. */
const MAX_SECONDS = 253_402_300_800;

/** A `Prompt`'s time, written in seconds since 1970, as milliseconds, or null. */
function promptTime(data: unknown): number | null {
  const meta = isRecord(data) ? data.meta : undefined;
  if (!isRecord(meta)) return null;
  const seconds = meta.timestamp;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  if (seconds <= 0 || seconds > MAX_SECONDS) return null;
  return Math.floor(seconds * 1000);
}

/**
 * What one V2 line is, or null for a blank one. No payload is known for a
 * `Clear`, so only its `version` and `kind` are asked of it.
 */
export function readV2Record(line: string): KiroV2Record | null {
  const text = line.trim();
  if (text === "") return null;
  const value = parse(text);
  if (!isRecord(value) || value.version !== "v1") return { kind: "unknown" };
  const { data } = value;
  switch (value.kind) {
    case "Prompt":
      return { kind: "prompt", at: promptTime(data) };
    case "AssistantMessage": {
      if (!isRecord(data) || !Array.isArray(data.content)) return { kind: "unknown" };
      const toolUse = data.content.some((block) => isRecord(block) && block.kind === "toolUse");
      return { kind: "reply", toolUse };
    }
    case "ToolResults":
      return { kind: "tool-results" };
    case "Clear":
      return { kind: "clear" };
    default:
      return { kind: "unknown" };
  }
}

/** How a V2 transcript is read: back to its newest `Prompt`. */
export const V2_READING: LineReading<KiroV2Record, KiroV2Scan> = {
  row: readV2Record,
  floor: isV2TurnStart,
  start: startV2Scan,
  fold: foldV2Record,
};
