import { expect, test } from "vitest";

import { parseKiroTime, readV2Record, readV3Row } from "@collector/adapters/kiro-cli/rows";
import {
  NOW,
  PRIVATE_WORDS,
  v2Clear,
  v2Prompt,
  v2Record,
  v2Reply,
  v2ToolResults,
  v2ToolUse,
  v3Assistant,
  v3Note,
  v3Pending,
  v3Resolved,
  v3Row,
  v3TurnEnd,
  v3TurnStart,
  v3User,
} from "@tests/fixtures/kiro-cli/kiroCli";

test("Kiro's times are read as RFC 3339, to nine digits of a second, and nothing else", () => {
  expect(parseKiroTime("2026-11-07T20:55:08.089Z")).toBe(Date.UTC(2026, 10, 7, 20, 55, 8, 89));
  expect(parseKiroTime("2026-11-07T20:55:08.089496201Z")).toBe(
    Date.UTC(2026, 10, 7, 20, 55, 8, 89),
  );
  expect(parseKiroTime("2026-11-07T21:55:08+01:00")).toBe(Date.UTC(2026, 10, 7, 20, 55, 8));
  for (const value of ["2026-11-07 20:55:08", "1794084908089", 1794084908089, "", null, "soon"]) {
    expect(parseKiroTime(value), String(value)).toBeNull();
  }
});

test("a V3 turn row, wait and answer are read with their times and IDs, and nothing else of them", () => {
  expect(readV3Row(v3TurnStart(NOW))).toEqual({ kind: "turn-start", at: NOW });
  expect(readV3Row(v3TurnEnd(NOW))).toEqual({ kind: "turn-end", at: NOW });
  expect(readV3Row(v3Pending("call-1", NOW))).toEqual({
    kind: "pending",
    toolCallId: "call-1",
    approval: true,
    at: NOW,
  });
  expect(readV3Row(v3Pending("call-1", NOW, "question"))).toMatchObject({ approval: false });
  expect(readV3Row(v3Resolved("call-1"))).toEqual({ kind: "resolved", toolCallId: "call-1" });
  // A turn row of a kind not known is one, so it is not passed over as bookkeeping.
  expect(readV3Row(v3Row({ type: "turn_cancelled" }))).toEqual({ kind: "turn-other" });
  for (const line of [v3TurnStart(), v3Pending("call-1"), v3Resolved("call-1")]) {
    expect(JSON.stringify(readV3Row(line))).not.toContain(PRIVATE_WORDS);
  }
});

test("any other V3 row is bookkeeping, even one whose words name a turn row", () => {
  for (const line of [v3User(), v3Assistant(), v3Note()]) {
    expect(readV3Row(line)).toEqual({ kind: "other" });
  }
  const quoting = v3Row({ type: "assistant", content: 'Kiro writes "turn_end" when a turn ends.' });
  expect(readV3Row(quoting)).toEqual({ kind: "other" });
  expect(readV3Row("  \n")).toBeNull();
});

test("a V3 line that is not a row, or names a row it cannot be read as, cannot be read", () => {
  for (const line of [
    "not json",
    '{"id":"row-1","timestamp":"2026-10-01T12:00:00Z","payload":{"type":"turn_st',
    '{"payload":{"type":"turn_start"',
    '["turn_start"]',
    '{"payload":"turn_start"}',
    '{"payload":{"type":1,"note":"turn_start"}}',
    '{"payload":{"type":"pending_interaction","interactionType":"tool_approval"}}',
    '{"payload":{"type":"interaction_resolved","toolCallId":""}}',
    `{"payload":{"type":"interaction_resolved","toolCallId":"${"x".repeat(257)}"}}`,
  ]) {
    expect(readV3Row(line), line).toEqual({ kind: "unreadable" });
  }
  // A line spaced as a person would write it is still a row.
  expect(readV3Row('{ "payload": { "type": "turn_start" } }')).toEqual({
    kind: "turn-start",
    at: null,
  });
});

test("a V2 record is read for its kind, a reply's tool use and a prompt's time, and nothing else", () => {
  expect(readV2Record(v2Prompt(NOW))).toEqual({ kind: "prompt", at: NOW });
  expect(readV2Record(v2Reply())).toEqual({ kind: "reply", toolUse: false });
  expect(readV2Record(v2ToolUse())).toEqual({ kind: "reply", toolUse: true });
  expect(readV2Record(v2ToolResults())).toEqual({ kind: "tool-results" });
  expect(readV2Record(v2Clear())).toEqual({ kind: "clear" });
  expect(readV2Record(v2Record("Prompt", { content: [] }))).toEqual({ kind: "prompt", at: null });
  expect(readV2Record(v2Record("Prompt", { meta: { timestamp: -1 } }))).toEqual({
    kind: "prompt",
    at: null,
  });
  for (const line of [v2Prompt(), v2Reply(), v2ToolUse(), v2ToolResults()]) {
    expect(JSON.stringify(readV2Record(line))).not.toContain(PRIVATE_WORDS);
  }
  expect(readV2Record("")).toBeNull();
});

test("a V2 line of another version, a kind not known or a shape not known is unknown", () => {
  for (const line of [
    "not json",
    '{"version":"v1","kind":"Prompt"',
    `${JSON.stringify({ version: "v2", kind: "AssistantMessage", data: { content: [] } })}`,
    `${JSON.stringify({ kind: "AssistantMessage", data: { content: [] } })}`,
    v2Record("Compaction"),
    v2Record("AssistantMessage", { content: "text" }),
    `${JSON.stringify({ version: "v1", kind: "AssistantMessage" })}`,
    "[]",
  ]) {
    expect(readV2Record(line), line).toEqual({ kind: "unknown" });
  }
});
