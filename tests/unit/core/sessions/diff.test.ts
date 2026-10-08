import { describe, expect, test } from "vitest";

import {
  diffSessions,
  severityFor,
  withoutRepeats,
  type ReportedStatuses,
} from "@core/sessions/diff";
import type { Session, SessionStatus } from "@core/sessions/session";
import { makeSession } from "@tests/fixtures/session";

const at = 1_700_000_060_000;

describe("severityFor", () => {
  test("needing you is a warning, failing is critical, the rest is advisory", () => {
    expect(severityFor("needs-you")).toBe("warning");
    expect(severityFor("failed")).toBe("critical");
    for (const status of ["working", "idle", "finished", "unknown", undefined] as const) {
      expect(severityFor(status)).toBe("advisory");
    }
  });
});

describe("diffSessions", () => {
  test("two identical polls produce no events", () => {
    const sessions = [makeSession(), makeSession({ id: "claude-code:2", status: "working" })];
    expect(diffSessions(sessions, sessions, at)).toEqual([]);
  });

  test("a new session has appeared, with the status it arrived in", () => {
    const session = makeSession({ id: "claude-code:new", name: "demo-api", status: "working" });
    expect(diffSessions([], [session], at)).toEqual([
      {
        id: `claude-code:new@${at}:appeared`,
        at,
        sessionId: "claude-code:new",
        sessionName: "demo-api",
        kind: "appeared",
        to: "working",
        severity: "advisory",
      },
    ]);
  });

  test("a session that appears already needing you is a warning", () => {
    const session = makeSession({ status: "needs-you", waitingReason: "permission" });
    expect(diffSessions([], [session], at)[0]).toMatchObject({
      kind: "appeared",
      to: "needs-you",
      severity: "warning",
    });
  });

  test("a status change records where it came from and where it went", () => {
    const before = makeSession({ status: "working" });
    const after = makeSession({ status: "needs-you", waitingReason: "question" });
    expect(diffSessions([before], [after], at)).toEqual([
      {
        id: `${after.id}@${at}:status-changed`,
        at,
        sessionId: after.id,
        sessionName: "demo-project",
        kind: "status-changed",
        from: "working",
        to: "needs-you",
        severity: "warning",
      },
    ]);
  });

  test("a change to failed is critical", () => {
    const before = makeSession({ status: "working" });
    const after = makeSession({ status: "failed" });
    expect(diffSessions([before], [after], at)[0]).toMatchObject({
      from: "working",
      to: "failed",
      severity: "critical",
    });
  });

  test("leaving needs-you is advisory", () => {
    const before = makeSession({ status: "needs-you", waitingReason: "permission" });
    const after = makeSession({ status: "working" });
    expect(diffSessions([before], [after], at)[0]).toMatchObject({
      from: "needs-you",
      to: "working",
      severity: "advisory",
    });
  });

  test("a session that is gone has ended, with its last status and name", () => {
    const session = makeSession({ status: "needs-you", name: "demo-api" });
    expect(diffSessions([session], [], at)).toEqual([
      {
        id: `${session.id}@${at}:ended`,
        at,
        sessionId: session.id,
        sessionName: "demo-api",
        kind: "ended",
        from: "needs-you",
        severity: "advisory",
      },
    ]);
  });

  test("an event uses the session's current name", () => {
    const before = makeSession({ name: "demo-project", status: "idle" });
    const after = makeSession({ name: "renamed-project", status: "working" });
    expect(diffSessions([before], [after], at)[0]?.sessionName).toBe("renamed-project");
  });

  test("changes that are not a status change are not events", () => {
    const before = makeSession({
      status: "needs-you",
      waitingReason: "permission",
      waitingDetail: "permission prompt",
      statusSince: 1_000,
      name: "demo-project",
      alive: true,
    });
    const after = makeSession({
      status: "needs-you",
      waitingReason: "question",
      waitingDetail: "input needed",
      statusSince: 2_000,
      name: "renamed-project",
      alive: false,
      stale: true,
    });
    expect(diffSessions([before], [after], at)).toEqual([]);
  });

  test("new token counts are not an event, and no event carries them", () => {
    const tokens = { input: 873_215, cached: 641_331, output: 52_717 };
    const before = makeSession({ id: "codex:a", source: "codex", status: "working" });
    const counted: Session = { ...before, tokens };
    const later: Session = { ...counted, tokens: { ...tokens, output: 60_001 } };
    expect(diffSessions([before], [counted], at)).toEqual([]);
    expect(diffSessions([counted], [later], at)).toEqual([]);

    const events = [
      ...diffSessions([], [counted], at),
      ...diffSessions([counted], [{ ...counted, status: "idle" }], at),
      ...diffSessions([counted], [], at),
    ];
    expect(events.map((event) => event.kind)).toEqual(["appeared", "status-changed", "ended"]);
    const said = JSON.stringify(events);
    for (const count of ["873215", "641331", "52717", "tokens"]) {
      expect(said).not.toContain(count);
    }
  });

  test("several changes in one poll each get their own event with a unique id", () => {
    const staying = makeSession({ id: "claude-code:stay", status: "idle" });
    const changing = makeSession({ id: "claude-code:change", status: "working" });
    const leaving = makeSession({ id: "claude-code:leave", status: "idle" });
    const arriving = makeSession({ id: "claude-code:arrive", status: "working" });

    const events = diffSessions(
      [staying, changing, leaving],
      [staying, { ...changing, status: "idle" }, arriving],
      at,
    );

    expect(events.map((event) => [event.sessionId, event.kind])).toEqual([
      ["claude-code:change", "status-changed"],
      ["claude-code:arrive", "appeared"],
      ["claude-code:leave", "ended"],
    ]);
    expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
    expect(events.every((event) => event.at === at)).toBe(true);
  });

  test("the same change at a different time gets a different id", () => {
    const before = makeSession({ status: "working" });
    const after = makeSession({ status: "idle" });
    const first = diffSessions([before], [after], at)[0];
    const second = diffSessions([before], [after], at + 2_000)[0];
    expect(first?.id).not.toBe(second?.id);
  });
});

describe("withoutRepeats", () => {
  const a = makeSession({ id: "claude-code:a", name: "demo-a", status: "working" });
  const reportedAs = (entries: [string, SessionStatus][]): ReportedStatuses => new Map(entries);

  test("with one way of reading, every event passes and the record keeps up", () => {
    const reported = reportedAs([["claude-code:a", "working"]]);
    const b = makeSession({ id: "claude-code:b", name: "demo-b", status: "idle" });
    const events = diffSessions([a], [{ ...a, status: "needs-you" }, b], at);

    expect(withoutRepeats(events, reported)).toEqual(events);
    expect([...reported]).toEqual([
      ["claude-code:a", "needs-you"],
      ["claude-code:b", "idle"],
    ]);

    const ending = diffSessions([{ ...a, status: "needs-you" }, b], [b], at + 2_000);
    expect(withoutRepeats(ending, reported)).toEqual(ending);
    expect([...reported]).toEqual([["claude-code:b", "idle"]]);
  });

  test("a status change that was already reported is not reported again", () => {
    const reported = reportedAs([["claude-code:a", "idle"]]);
    const events = diffSessions([a], [{ ...a, status: "idle" }], at);
    expect(withoutRepeats(events, reported)).toEqual([]);
    expect(reported.get("claude-code:a")).toBe("idle");
  });

  test("a change is reported from the status the log last gave, not the stale one", () => {
    const reported = reportedAs([["claude-code:a", "needs-you"]]);
    const events = diffSessions([a], [{ ...a, status: "idle" }], at);
    expect(withoutRepeats(events, reported)).toEqual([
      {
        id: `claude-code:a@${at}:status-changed`,
        at,
        sessionId: "claude-code:a",
        sessionName: "demo-a",
        kind: "status-changed",
        from: "needs-you",
        to: "idle",
        severity: "advisory",
      },
    ]);
  });

  test("an arrival that was already reported is dropped", () => {
    const reported = reportedAs([["claude-code:a", "working"]]);
    expect(withoutRepeats(diffSessions([], [a], at), reported)).toEqual([]);
  });

  test("an arrival of a session already present in another status is a status change", () => {
    const reported = reportedAs([["claude-code:a", "working"]]);
    const events = withoutRepeats(diffSessions([], [{ ...a, status: "failed" }], at), reported);
    expect(events).toEqual([
      {
        id: `claude-code:a@${at}:status-changed`,
        at,
        sessionId: "claude-code:a",
        sessionName: "demo-a",
        kind: "status-changed",
        from: "working",
        to: "failed",
        severity: "critical",
      },
    ]);
    expect(reported.get("claude-code:a")).toBe("failed");
  });

  test("an ending that was already reported, or of a session never present, is dropped", () => {
    const reported = reportedAs([]);
    expect(withoutRepeats(diffSessions([a], [], at), reported)).toEqual([]);
  });

  test("an ending is reported from the status the log last gave", () => {
    const reported = reportedAs([["claude-code:a", "needs-you"]]);
    const events = withoutRepeats(diffSessions([a], [], at), reported);
    expect(events).toMatchObject([{ kind: "ended", from: "needs-you", severity: "advisory" }]);
    expect(reported.has("claude-code:a")).toBe(false);
  });
});
