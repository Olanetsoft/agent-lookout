import { describe, expect, test } from "vitest";

import type { UnrealAgentSessionFile } from "@collector/adapters/unreal-agent/sessionFile";
import { unrealAgentSession } from "@collector/adapters/unreal-agent/toSession";
import {
  applyUnrealAgentLine,
  startUnrealAgentReplay,
  type UnrealAgentItem,
} from "@core/mapping/unreal-agent/unrealAgentReplay";
import {
  DAY,
  MINUTE,
  NOW,
  PROJECT,
  SECOND,
  SESSION_ID,
  uuidOf,
} from "@tests/fixtures/unreal-agent/unrealAgent";

const CREATED = NOW - 2 * DAY;
const TURN = uuidOf(3, 1);

function fileOf(
  items: [UnrealAgentItem, number][],
  changes: Partial<UnrealAgentSessionFile> = {},
): UnrealAgentSessionFile {
  const replay = startUnrealAgentReplay(true);
  items.forEach(([item, at], index) =>
    applyUnrealAgentLine(replay, { kind: "item", sequence: index + 1, at, item }),
  );
  return {
    id: SESSION_ID,
    createdAt: CREATED,
    folder: PROJECT,
    replay,
    tooLong: false,
    ...changes,
  };
}

const settings: UnrealAgentItem = { kind: "input", input: "settings" };
const message: UnrealAgentItem = { kind: "input", input: "external" };
const turn: UnrealAgentItem = { kind: "turn", id: TURN, type: "regular" };
const reply = (outcome: "complete" | "failed"): UnrealAgentItem => ({
  kind: "reply",
  turnId: TURN,
  outcome,
});

describe("an Unreal Agent session", () => {
  test("takes its folder's name, and its ID without one", () => {
    const file = fileOf([[settings, NOW - 10 * MINUTE]]);
    const named = unrealAgentSession({
      file,
      liveness: "may-be-open",
      writtenAt: NOW - MINUTE,
      now: NOW,
    });
    expect(named).toMatchObject({
      id: `unreal-agent:${SESSION_ID}`,
      source: "unreal-agent",
      surface: "unknown",
      name: "demo-project",
      cwd: PROJECT,
      project: "demo-project",
      startedAt: CREATED,
      links: {},
    });
    const bare = unrealAgentSession({
      file: { ...file, folder: null },
      liveness: "may-be-open",
      writtenAt: NOW - MINUTE,
      now: NOW,
    });
    expect(bare).toMatchObject({ name: `unreal-agent:${SESSION_ID}`, cwd: null, project: null });
  });

  test("has a status time for each status", () => {
    const at = (minutes: number) => NOW - minutes * MINUTE;
    const working = fileOf([
      [settings, at(30)],
      [message, at(20)],
      [turn, at(10)],
    ]);
    expect(
      unrealAgentSession({ file: working, liveness: "may-be-open", writtenAt: at(10), now: NOW }),
    ).toMatchObject({ status: "working", statusSince: at(10) });
    // A message not yet answered by a turn.
    const waiting = fileOf([
      [settings, at(30)],
      [turn, at(25)],
      [reply("complete"), at(24)],
      [message, at(5)],
      [message, at(4)],
    ]);
    expect(
      unrealAgentSession({ file: waiting, liveness: "may-be-open", writtenAt: at(4), now: NOW }),
    ).toMatchObject({ status: "working", statusSince: at(5) });
    const idle = fileOf([
      [settings, at(30)],
      [turn, at(25)],
      [reply("complete"), at(24)],
    ]);
    expect(
      unrealAgentSession({ file: idle, liveness: "may-be-open", writtenAt: at(20), now: NOW }),
    ).toMatchObject({ status: "idle", statusSince: at(24) });
    const failed = fileOf([
      [settings, at(30)],
      [turn, at(25)],
      [reply("failed"), at(23)],
    ]);
    expect(
      unrealAgentSession({ file: failed, liveness: "may-be-open", writtenAt: at(20), now: NOW }),
    ).toMatchObject({ status: "failed", statusSince: at(23) });
    expect(
      unrealAgentSession({ file: idle, liveness: "closed", writtenAt: at(20), now: NOW }),
    ).toMatchObject({ status: "finished", statusSince: at(20), lastWriteAt: at(20) });
    expect(
      unrealAgentSession({ file: idle, liveness: "cannot-tell", writtenAt: at(20), now: NOW }),
    ).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("keeps no time more than 2 seconds before its start", () => {
    const early = NOW - 3 * DAY;
    const file = fileOf([
      [settings, early],
      [turn, early],
      [reply("complete"), early],
    ]);
    const idle = unrealAgentSession({ file, liveness: "may-be-open", writtenAt: early, now: NOW });
    expect(idle).toMatchObject({ status: "idle", statusSince: null });
    expect(idle).not.toHaveProperty("lastWriteAt");
    const closed = unrealAgentSession({
      file,
      liveness: "closed",
      writtenAt: CREATED - SECOND,
      now: NOW,
    });
    expect(closed).toMatchObject({
      status: "finished",
      statusSince: CREATED - SECOND,
      lastWriteAt: CREATED - SECOND,
    });
  });

  test("has its file's last write, to the millisecond below, and none that cannot be right", () => {
    const file = fileOf([[settings, NOW - MINUTE]]);
    const session = unrealAgentSession({
      file,
      liveness: "may-be-open",
      writtenAt: NOW - 1500.7,
      now: NOW,
    });
    expect(session.lastWriteAt).toBe(NOW - 1501);
    const ahead = unrealAgentSession({
      file,
      liveness: "may-be-open",
      writtenAt: NOW + 2 * MINUTE,
      now: NOW,
    });
    expect(ahead).not.toHaveProperty("lastWriteAt");
  });

  test("is stale after a day idle", () => {
    const file = fileOf([
      [settings, NOW - 2 * DAY],
      [turn, NOW - 2 * DAY],
      [reply("complete"), NOW - 25 * 60 * MINUTE],
    ]);
    const old = unrealAgentSession({
      file,
      liveness: "may-be-open",
      writtenAt: NOW - MINUTE,
      now: NOW,
    });
    expect(old).toMatchObject({ status: "idle", stale: true });
    const fresh = unrealAgentSession({
      file,
      liveness: "may-be-open",
      writtenAt: NOW - MINUTE,
      now: NOW - DAY,
    });
    expect(fresh.stale).toBe(false);
  });
});
