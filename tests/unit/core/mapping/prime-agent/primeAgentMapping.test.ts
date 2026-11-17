import { describe, expect, test } from "vitest";

import {
  mayBeWorking,
  primeAgentHolder,
  primeAgentHolderStatus,
  primeAgentJournalStatus,
  primeAgentLeaseProcess,
  primeAgentRecordStatus,
  type JournalRecord,
  type LeaseProcessFacts,
  type QueueState,
  type TrailEntry,
} from "@core/mapping/prime-agent/primeAgentMapping";

const SESSION = "0190a1b2-c3d4-7e5f-8a9b-000000000001";
const OTHER = "0190a1b2-c3d4-7e5f-8a9b-000000000002";
const CREATED = Date.UTC(2026, 9, 1, 11, 0, 0);

const facts = (changes: Partial<LeaseProcessFacts> = {}): LeaseProcessFacts => ({
  alive: true,
  start: "unknown",
  beforeBoot: false,
  program: "prime-agent",
  ...changes,
});

const record = (
  operation: string,
  busy: boolean,
  at = CREATED + 1_000,
  changes: Partial<JournalRecord> = {},
): JournalRecord => ({
  sessionId: SESSION,
  sessionFile: `${SESSION}.jsonl`,
  busy,
  operation,
  recordedAt: at,
  ...changes,
});

const notParked: QueueState = { suspended: false, recordedAt: CREATED + 1_000 };
const parked: QueueState = { suspended: true, recordedAt: CREATED + 1_000 };

const entry = (one: JournalRecord, queue: QueueState = notParked): TrailEntry => ({
  record: one,
  queue,
});

const status = (trail: TrailEntry[], queue: QueueState = notParked) =>
  primeAgentJournalStatus({ sessionId: SESSION, createdAt: CREATED, trail, queue });

describe("whether a lease's process holds it", () => {
  test.each([
    ["H3: signal 0 finds no process", facts({ alive: false, start: "same" }), "gone"],
    ["H4: its start differs", facts({ start: "different" }), "gone"],
    [
      "H5: its start is the lease's, even before the boot",
      facts({ start: "same", beforeBoot: true, program: null }),
      "runs",
    ],
    ["H6: no start compared, taken before the boot", facts({ beforeBoot: true }), "gone"],
    ["H7: ps names prime-agent", facts(), "runs"],
    ["H7b: ps names another program", facts({ program: "other" }), "unknown"],
    ["H7c: ps names none or failed", facts({ program: "not-listed" }), "unknown"],
    ["H8: ps not asked, as on Windows", facts({ program: null }), "unknown"],
  ] as const)("%s", (_name, given, answer) => {
    expect(primeAgentLeaseProcess(given)).toBe(answer);
  });
});

describe("who holds a session", () => {
  test.each([
    ["H1: no lease names it", { listed: true, leases: [], stray: false }, "none"],
    [
      "H2: the leases could not be listed",
      { listed: false, leases: ["runs"], stray: false },
      "unknown",
    ],
    [
      "H3 to H6: its lease's process is gone",
      { listed: true, leases: ["gone"], stray: false },
      "none",
    ],
    [
      "H9: a stray lease could be its own",
      { listed: true, leases: ["gone"], stray: true },
      "unknown",
    ],
    [
      "H9: a lease of its own that runs still counts",
      { listed: true, leases: ["runs"], stray: true },
      "runs",
    ],
    ["H10: one of two runs", { listed: true, leases: ["gone", "runs"], stray: false }, "runs"],
    [
      "H10: one of two cannot be told",
      { listed: true, leases: ["gone", "unknown"], stray: false },
      "unknown",
    ],
  ] as const)("%s", (_name, given, answer) => {
    expect(primeAgentHolder({ ...given, leases: [...given.leases] })).toBe(answer);
  });

  test("none is finished and unknown is unknown, before any journal is read", () => {
    expect(primeAgentHolderStatus("none")).toBe("finished");
    expect(primeAgentHolderStatus("unknown")).toBe("unknown");
    expect(primeAgentHolderStatus("runs")).toBeNull();
  });
});

describe("what one record says", () => {
  test.each([
    ["prompt_accepted", true, notParked, "working"],
    ["prompt_accepted", true, parked, "working"],
    ["prompt_accepted", true, null, "working"],
    ["steer_queued", true, notParked, "working"],
    ["follow_up_queued", true, notParked, "working"],
    ["turn_end", true, notParked, "working"],
    ["queue_purged", true, notParked, "working"],
    ["queue_cleared", true, notParked, "working"],
    ["steer_queued", true, parked, "unknown"],
    ["turn_end", true, parked, "unknown"],
    ["steer_queued", true, null, "unknown"],
    ["steer_queued", true, "unreadable", "unknown"],
    ["turn_end", false, parked, "idle"],
    ["queue_purged", false, null, "idle"],
    ["queue_cleared", false, notParked, "idle"],
    ["create", true, notParked, "unknown"],
    ["prompt_accepted", false, notParked, "unknown"],
    ["steer_queued", false, notParked, "unknown"],
    ["queue_resumed", true, notParked, "unknown"],
    ["shutdown", true, notParked, "unknown"],
    ["shutdown", false, notParked, "unknown"],
    ["killed", false, notParked, "unknown"],
    ["replaced", false, notParked, "unknown"],
    ["worker_gave_up", false, notParked, "unknown"],
    ["a_new_step", true, notParked, "unknown"],
  ] as const)("%s with busy %s and queue %j is %s", (operation, busy, queue, answer) => {
    expect(primeAgentRecordStatus(record(operation, busy), queue)).toBe(answer);
  });

  test("only a step that can be working with busy true starts a run", () => {
    expect(mayBeWorking(record("prompt_accepted", true))).toBe(true);
    expect(mayBeWorking(record("turn_end", true))).toBe(true);
    expect(mayBeWorking(record("turn_end", false))).toBe(false);
    expect(mayBeWorking(record("create", true))).toBe(false);
  });
});

describe("a session's status from its worker's journal", () => {
  test("is unknown with no record, or when the newest is not this session's", () => {
    expect(status([])).toEqual({ status: "unknown", since: null });
    // The slot moved to another session with /new: its newest record is that one's.
    const moved = [
      entry(record("turn_end", false, CREATED + 1_000)),
      entry(
        record("prompt_accepted", true, CREATED + 2_000, {
          sessionId: OTHER,
          sessionFile: `${OTHER}.jsonl`,
        }),
      ),
    ];
    expect(status(moved)).toEqual({ status: "unknown", since: null });
  });

  test("matches a record by its file's name, and by its session's ID only when it names no file", () => {
    const named = record("prompt_accepted", true, CREATED + 1_000, {
      sessionFile: `${OTHER}.jsonl`,
    });
    expect(status([entry(named)]).status).toBe("unknown");
    const noFile = record("prompt_accepted", true, CREATED + 1_000, { sessionFile: null });
    expect(status([entry(noFile)]).status).toBe("working");
    const otherId = record("prompt_accepted", true, CREATED + 1_000, {
      sessionFile: null,
      sessionId: OTHER,
    });
    expect(status([entry(otherId)]).status).toBe("unknown");
  });

  test("counts no record written before the lease was taken", () => {
    // Another run's prompt, and no create yet for this one.
    const before = record("prompt_accepted", true, CREATED - 1_000);
    expect(status([entry(before)])).toEqual({ status: "unknown", since: null });
  });

  test("counts no queue line written before the lease was taken", () => {
    const queued = record("steer_queued", true, CREATED + 3_000);
    const old: QueueState = { suspended: false, recordedAt: CREATED - 1_000 };
    expect(status([entry(queued, old)], old)).toEqual({ status: "unknown", since: null });
  });

  test("a working session's time is the first line of the run that works, an idle one's its line's", () => {
    const run = [
      entry(record("create", true, CREATED + 500)),
      entry(record("prompt_accepted", true, CREATED + 1_000)),
      entry(record("steer_queued", true, CREATED + 2_000)),
    ];
    expect(status(run)).toEqual({ status: "working", since: CREATED + 1_000 });
    const settled = [...run, entry(record("turn_end", false, CREATED + 3_000))];
    expect(status(settled)).toEqual({ status: "idle", since: CREATED + 3_000 });
  });

  test("a run stops at a line that did not say working by the queue line read before it", () => {
    const run = [
      entry(record("prompt_accepted", true, CREATED + 1_000)),
      entry(record("steer_queued", true, CREATED + 2_000), parked),
      entry(record("prompt_accepted", true, CREATED + 3_000)),
    ];
    expect(status(run)).toEqual({ status: "working", since: CREATED + 3_000 });
  });

  test("the newest record goes by the newest queue line", () => {
    const queued = [entry(record("steer_queued", true, CREATED + 2_000), notParked)];
    expect(status(queued, parked).status).toBe("unknown");
    expect(status(queued, notParked).status).toBe("working");
  });
});
