import { describe, expect, test } from "vitest";

import {
  autohandEndedAt,
  autohandStatusOf,
  chooseCandidate,
  effectiveMetadataStatus,
  heartbeatClass,
  importedAndNeverResumed,
  inFreshWindow,
  type AutohandEvidence,
  type Candidate,
  type MetadataFacts,
} from "@core/mapping/autohand-code/autohandCodeMapping";

const NOW = Date.UTC(2026, 10, 10, 12);
const SECOND = 1_000;

const facts = (more: Partial<MetadataFacts> = {}): MetadataFacts => ({
  status: "active",
  createdAt: NOW - 3_600_000,
  lastActiveAt: NOW - 60 * SECOND,
  closedAt: null,
  importedAt: null,
  projectPath: "/Users/example/code/demo-project",
  title: null,
  client: "terminal",
  ...more,
});

const candidate = (more: Partial<Candidate> = {}): Candidate => ({
  name: "a.json",
  pid: 10,
  updatedAt: NOW,
  phase: "thinking",
  heartbeatClass: "fresh",
  ...more,
});

describe("a heartbeat's class", () => {
  test("is fresh while at most 15 seconds old, as Autohand Code judges it, or up to a minute ahead", () => {
    expect(inFreshWindow(NOW - 15_000, NOW)).toBe(true);
    expect(inFreshWindow(NOW - 15_001, NOW)).toBe(false);
    expect(inFreshWindow(NOW + 60_000, NOW)).toBe(true);
    expect(inFreshWindow(NOW + 60_001, NOW)).toBe(false);
    expect(inFreshWindow(null, NOW)).toBe(false);
    expect(heartbeatClass(NOW - 15_000, true, NOW)).toBe("fresh");
    expect(heartbeatClass(NOW - 15_001, true, NOW)).toBe("quiet");
    expect(heartbeatClass(null, true, NOW)).toBe("quiet");
    expect(heartbeatClass(NOW - 5_000, false, NOW)).toBe("just-dead");
    expect(heartbeatClass(NOW - 15_001, false, NOW)).toBe("gone");
    expect(heartbeatClass(NOW + 60_001, false, NOW)).toBe("gone");
  });
});

describe("the heartbeat chosen", () => {
  test("is a fresh one first, one waiting before one working before one idle, whichever is newer", () => {
    const waiting = candidate({ name: "b.json", phase: "waiting_input", updatedAt: NOW - 10_000 });
    const idle = candidate({ name: "a.json", phase: "idle", updatedAt: NOW });
    const working = candidate({ name: "c.json", phase: "editing", updatedAt: NOW - 1 });
    expect(chooseCandidate([idle, working, waiting])).toBe(waiting);
    expect(chooseCandidate([idle, working])).toBe(working);
    expect(chooseCandidate([candidate({ phase: null }), idle])).toBe(idle);
    const quiet = candidate({ heartbeatClass: "quiet", phase: "waiting_input" });
    expect(chooseCandidate([quiet, idle])).toBe(idle);
    expect(chooseCandidate([])).toBeNull();
  });

  test("of the others, the newest, then by name and process, so it holds as two processes take turns", () => {
    const older = candidate({ heartbeatClass: "gone", updatedAt: NOW - 60_000, name: "a.json" });
    const newer = candidate({ heartbeatClass: "gone", updatedAt: NOW - 30_000, name: "b.json" });
    expect(chooseCandidate([older, newer])).toBe(newer);
    expect(chooseCandidate([candidate({ heartbeatClass: "quiet" }), newer])?.heartbeatClass).toBe(
      "quiet",
    );
    expect(
      chooseCandidate([candidate({ heartbeatClass: "just-dead" }), newer])?.heartbeatClass,
    ).toBe("just-dead");
    const one = candidate({ pid: 20, updatedAt: NOW - 1_000 });
    const two = candidate({ pid: 10, updatedAt: NOW });
    expect(chooseCandidate([one, two])).toBe(two);
    expect(chooseCandidate([two, one])).toBe(two);
    const unknownTime = candidate({ heartbeatClass: "quiet", updatedAt: null, name: "a.json" });
    const known = candidate({ heartbeatClass: "quiet", updatedAt: NOW - 20_000, name: "z.json" });
    expect(chooseCandidate([unknownTime, known])).toBe(known);
  });
});

describe("what metadata.json counts as", () => {
  test("completed written after its close is a resumed session, active", () => {
    const closedAt = NOW - 60_000;
    expect(
      effectiveMetadataStatus(
        facts({ status: "completed", closedAt, lastActiveAt: closedAt + 1_001 }),
        NOW,
        NOW,
      ),
    ).toBe("active");
    expect(
      effectiveMetadataStatus(
        facts({ status: "completed", closedAt, lastActiveAt: closedAt + 1_000 }),
        NOW,
        NOW,
      ),
    ).toBe("completed");
    expect(
      effectiveMetadataStatus(
        facts({ status: "completed", closedAt: null, lastActiveAt: NOW }),
        NOW,
        NOW,
      ),
    ).toBe("completed");
  });

  test("crashed saved after the crash is a session that went on, active", () => {
    const writtenAt = NOW - 10_000;
    expect(
      effectiveMetadataStatus(
        facts({ status: "crashed", lastActiveAt: writtenAt - 1_000 }),
        writtenAt,
        NOW,
      ),
    ).toBe("active");
    expect(
      effectiveMetadataStatus(
        facts({ status: "crashed", lastActiveAt: writtenAt - 1_001 }),
        writtenAt,
        NOW,
      ),
    ).toBe("crashed");
    expect(
      effectiveMetadataStatus(facts({ status: "crashed", lastActiveAt: null }), writtenAt, NOW),
    ).toBe("crashed");
    expect(effectiveMetadataStatus(facts({ status: "crashed" }), null, NOW)).toBe("crashed");
    // A time that cannot be right is not believed.
    expect(
      effectiveMetadataStatus(
        facts({ status: "crashed", lastActiveAt: NOW + 120_000 }),
        writtenAt,
        NOW,
      ),
    ).toBe("crashed");
  });

  test("an import never resumed is told by its copy's time, each condition counting", () => {
    const importedAt = NOW - 60_000;
    expect(importedAndNeverResumed(facts({ status: "completed", importedAt }))).toBe(true);
    expect(
      importedAndNeverResumed(facts({ status: "completed", importedAt, closedAt: importedAt })),
    ).toBe(true);
    expect(
      importedAndNeverResumed(facts({ status: "completed", importedAt, closedAt: importedAt + 1 })),
    ).toBe(false);
    expect(importedAndNeverResumed(facts({ status: "active", importedAt }))).toBe(false);
    expect(importedAndNeverResumed(facts({ status: "completed" }))).toBe(false);
  });
});

describe("the status", () => {
  const evidence = (more: Partial<AutohandEvidence> = {}): AutohandEvidence => ({
    chosen: null,
    metadata: "active",
    movedOn: false,
    standIn: null,
    ended: false,
    lastProcessGone: false,
    ...more,
  });
  const fresh = (phase: Candidate["phase"]) => candidate({ phase });

  test("follows a fresh heartbeat's stage, whatever metadata.json says", () => {
    for (const metadata of [
      "active",
      "completed",
      "crashed",
      "other",
      "unreadable",
      null,
    ] as const) {
      expect(autohandStatusOf(evidence({ chosen: fresh("waiting_input"), metadata }))).toEqual({
        status: "needs-you",
        waitingReason: "other",
        row: 1,
      });
      for (const phase of ["thinking", "editing", "running_command"] as const) {
        expect(autohandStatusOf(evidence({ chosen: fresh(phase), metadata })).status).toBe(
          "working",
        );
      }
      expect(autohandStatusOf(evidence({ chosen: fresh("idle"), metadata })).status).toBe("idle");
      expect(autohandStatusOf(evidence({ chosen: fresh(null), metadata })).row).toBe(4);
    }
  });

  test("goes by the first row that applies", () => {
    const rows: [Partial<AutohandEvidence>, string, number][] = [
      [{ movedOn: true }, "finished", 5],
      [{ movedOn: true, metadata: "crashed" }, "failed", 5],
      [{ standIn: "working", lastProcessGone: true }, "working", 6],
      [{ chosen: candidate({ heartbeatClass: "quiet" }) }, "unknown", 7],
      [{ chosen: candidate({ heartbeatClass: "just-dead" }), metadata: "crashed" }, "unknown", 8],
      [{ chosen: candidate({ heartbeatClass: "gone" }), metadata: "crashed" }, "failed", 9],
      [{ chosen: candidate({ heartbeatClass: "gone" }), metadata: "other" }, "finished", 10],
      [{ chosen: candidate({ heartbeatClass: "gone" }), metadata: null }, "finished", 10],
      [{ ended: true }, "finished", 11],
      [{ lastProcessGone: true, metadata: "crashed" }, "failed", 11],
      [{ metadata: "completed" }, "finished", 12],
      [{ metadata: "crashed" }, "failed", 13],
      [{ metadata: "active" }, "unknown", 14],
      [{ metadata: null }, "unknown", 14],
      [{ metadata: "other" }, "unknown", 15],
      [{ metadata: "unreadable" }, "unknown", 15],
    ];
    for (const [more, status, row] of rows) {
      expect(autohandStatusOf(evidence(more)), JSON.stringify(more)).toEqual({ status, row });
    }
    // A wait held over keeps its reason.
    expect(autohandStatusOf(evidence({ standIn: "needs-you" }))).toEqual({
      status: "needs-you",
      waitingReason: "other",
      row: 6,
    });
    // A heartbeat there now comes before a process that moved on.
    expect(
      autohandStatusOf(evidence({ chosen: candidate({ heartbeatClass: "quiet" }), movedOn: true }))
        .row,
    ).toBe(7);
  });
});

describe("when a session ended", () => {
  test("is its close, unless resumed since", () => {
    const closedAt = NOW - 60_000;
    const closed = facts({ status: "completed", closedAt, lastActiveAt: closedAt });
    expect(
      autohandEndedAt({
        facts: closed,
        effective: "completed",
        writtenAt: NOW,
        updatedAt: NOW - 5_000,
        now: NOW,
      }),
    ).toBe(closedAt);
    expect(
      autohandEndedAt({
        facts: closed,
        effective: "active",
        writtenAt: NOW,
        updatedAt: NOW - 5_000,
        now: NOW,
      }),
    ).toBe(NOW - 5_000);
  });

  test("else the latest of its heartbeat, its last activity and, when it was marked so, its file's write", () => {
    const crashed = facts({ status: "crashed", lastActiveAt: NOW - 90_000 });
    expect(
      autohandEndedAt({
        facts: crashed,
        effective: "crashed",
        writtenAt: NOW - 30_000,
        updatedAt: NOW - 60_000,
        now: NOW,
      }),
    ).toBe(NOW - 30_000);
    const unclosed = facts({ status: "completed", lastActiveAt: NOW - 90_000 });
    expect(
      autohandEndedAt({
        facts: unclosed,
        effective: "completed",
        writtenAt: NOW - 30_000,
        updatedAt: null,
        now: NOW,
      }),
    ).toBe(NOW - 30_000);
    const active = facts({ lastActiveAt: NOW - 90_000 });
    expect(
      autohandEndedAt({
        facts: active,
        effective: "active",
        writtenAt: NOW - 30_000,
        updatedAt: NOW - 60_000,
        now: NOW,
      }),
    ).toBe(NOW - 60_000);
  });

  test("else its file's write, else not known, and never a time that cannot be right", () => {
    const blank = facts({ lastActiveAt: null });
    expect(
      autohandEndedAt({
        facts: blank,
        effective: "active",
        writtenAt: NOW - 30_000,
        updatedAt: null,
        now: NOW,
      }),
    ).toBe(NOW - 30_000);
    expect(
      autohandEndedAt({ facts: null, effective: null, writtenAt: null, updatedAt: null, now: NOW }),
    ).toBeNull();
    expect(
      autohandEndedAt({
        facts: null,
        effective: null,
        writtenAt: null,
        updatedAt: NOW + 120_000,
        now: NOW,
      }),
    ).toBeNull();
    const ahead = facts({
      status: "completed",
      closedAt: NOW + 120_000,
      lastActiveAt: NOW - 5_000,
    });
    expect(
      autohandEndedAt({
        facts: ahead,
        effective: "completed",
        writtenAt: NOW - 1_000,
        updatedAt: null,
        now: NOW,
      }),
    ).toBe(NOW - 5_000);
  });
});
