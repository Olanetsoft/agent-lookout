import { describe, expect, test } from "vitest";

import type { Envelope } from "@collector/adapters/mistral-vibe/envelope";
import {
  mistralVibeSession,
  type MistralVibeSessionInput,
} from "@collector/adapters/mistral-vibe/toSession";
import { CWD, DAY, HOUR, MINUTE, NOW, PRIVATE_WORDS, sessionId } from "@tests/fixtures/mistralVibe";

const ID = sessionId("a1");

function envelope(fields: Partial<Envelope> = {}): Envelope {
  return {
    title: "demo-project refactor",
    statusType: "running",
    createdAt: NOW - HOUR,
    updatedAt: NOW - 2 * MINUTE,
    turnStatus: "in_progress",
    turnStartedAt: NOW - 5 * MINUTE,
    turnCompletedAt: null,
    ...fields,
  };
}

function session(fields: Partial<MistralVibeSessionInput> = {}) {
  const state = fields.envelope === undefined ? envelope() : fields.envelope;
  return mistralVibeSession({
    sessionId: ID,
    envelope: state,
    title: state?.title ?? null,
    cwd: CWD,
    held: true,
    writtenAt: NOW - 30_000,
    now: NOW,
    ...fields,
  });
}

describe("a Mistral Vibe session", () => {
  test("is named by its title, with its folder and project, its start, and when it last wrote", () => {
    expect(session()).toEqual({
      id: `mistral-vibe:${ID}`,
      source: "mistral-vibe",
      surface: "unknown",
      name: "demo-project refactor",
      cwd: CWD,
      project: "demo",
      status: "working",
      startedAt: NOW - HOUR,
      statusSince: NOW - 5 * MINUTE,
      lastWriteAt: NOW - 30_000,
      links: {},
      stale: false,
    });
  });

  test("with no title it takes its folder's name, and with no folder its id", () => {
    expect(session({ title: null }).name).toBe("demo");
    expect(session({ title: "   " }).name).toBe("demo");
    expect(session({ title: null, cwd: null })).toMatchObject({
      name: ID,
      cwd: null,
      project: null,
    });
  });

  test("its status time is when its turn began while it works, when the turn ended once idle or failed", () => {
    expect(session().statusSince).toBe(NOW - 5 * MINUTE);
    const ended = envelope({
      statusType: "idle",
      turnStatus: "completed",
      turnCompletedAt: NOW - 3 * MINUTE,
    });
    expect(session({ envelope: ended })).toMatchObject({
      status: "idle",
      statusSince: NOW - 3 * MINUTE,
    });
    const failed = envelope({
      statusType: "failed",
      turnStatus: "failed",
      turnCompletedAt: NOW - 4 * MINUTE,
    });
    expect(session({ envelope: failed })).toMatchObject({
      status: "failed",
      statusSince: NOW - 4 * MINUTE,
    });
  });

  test("with no turn's times, its status time is the state's last change", () => {
    const fresh = envelope({ statusType: "idle", turnStatus: null, turnStartedAt: null });
    expect(session({ envelope: fresh }).statusSince).toBe(NOW - 2 * MINUTE);
    const noStart = envelope({ turnStartedAt: null });
    expect(session({ envelope: noStart }).statusSince).toBe(NOW - 2 * MINUTE);
  });

  test("once no program holds it, it is finished since the state's last change", () => {
    expect(session({ held: false })).toMatchObject({
      status: "finished",
      statusSince: NOW - 2 * MINUTE,
    });
  });

  test("a state not read has no status and no status time, and keeps its name", () => {
    expect(session({ envelope: null, title: "demo-project refactor" })).toMatchObject({
      status: "unknown",
      statusSince: null,
      startedAt: null,
      name: "demo-project refactor",
    });
    expect(session({ tooNew: true })).toMatchObject({ status: "unknown", statusSince: null });
  });

  test("a time that could not be right is not known, and a status cannot begin before the session", () => {
    const future = envelope({ turnStartedAt: NOW + DAY });
    expect(session({ envelope: future }).statusSince).toBe(NOW - 2 * MINUTE);
    const early = envelope({ createdAt: NOW - HOUR, turnStartedAt: NOW - 2 * HOUR });
    expect(session({ envelope: early }).statusSince).toBeNull();
    expect(session({ writtenAt: NOW - 2 * HOUR }).lastWriteAt).toBeUndefined();
    expect(session({ writtenAt: NOW + DAY }).lastWriteAt).toBeUndefined();
    expect(session({ writtenAt: undefined }).lastWriteAt).toBeUndefined();
    expect(session({ writtenAt: NOW - 30_000.75 }).lastWriteAt).toBe(NOW - 30_001);
  });

  test("an idle session is stale after a day, as every agent's is", () => {
    const old = envelope({
      statusType: "idle",
      createdAt: NOW - 3 * DAY,
      turnStatus: "completed",
      turnCompletedAt: NOW - 2 * DAY,
    });
    expect(session({ envelope: old }).stale).toBe(true);
  });

  test("has no pid, alive, jump, stop, link or tokens, and never needs you", () => {
    for (const statusType of ["running", "blocked", "idle", "failed"]) {
      const made = session({ envelope: envelope({ statusType }) });
      expect(made.status).not.toBe("needs-you");
      for (const key of [
        "pid",
        "alive",
        "jump",
        "stop",
        "tokens",
        "waitingReason",
        "waitingText",
      ]) {
        expect(made, key).not.toHaveProperty(key);
      }
      expect(made.links).toEqual({});
    }
  });

  test("carries nothing it was not given", () => {
    expect(JSON.stringify(session())).not.toContain(PRIVATE_WORDS);
  });
});
