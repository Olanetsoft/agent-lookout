import { describe, expect, test } from "vitest";

import {
  ohMyPiStatusOf,
  QUIET_MS,
  type OhMyPiFacts,
  type OhMyPiLine,
} from "@core/mapping/oh-my-pi/ohMyPiMapping";
import { CLOCK_SLACK_MS } from "@core/time";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;
const WRITTEN = NOW - MINUTE;

const ask: OhMyPiLine = { sort: "ask", at: NOW - 5 * MINUTE };
const exit = (fatal: boolean, at = NOW - 2 * MINUTE): Extract<OhMyPiLine, { sort: "exit" }> => ({
  sort: "exit",
  fatal,
  at,
});

function statusOf(facts: Partial<OhMyPiFacts>) {
  return ohMyPiStatusOf({
    newest: { sort: "prompt" },
    behind: null,
    writtenAt: WRITTEN,
    writer: "backed",
    now: NOW,
    ...facts,
  });
}

describe("each row", () => {
  test("1. an exit of kind fatal, newest or behind a reply: failed, since it was recorded", () => {
    expect(statusOf({ newest: exit(true) })).toEqual({
      status: "failed",
      since: NOW - 2 * MINUTE,
      showsLastWrite: false,
    });
    expect(statusOf({ newest: { sort: "reply" }, behind: exit(true) })).toMatchObject({
      status: "failed",
    });
  });

  test("2. any other exit: finished, since it was recorded, whatever ps says", () => {
    for (const writer of ["backed", "maybe", "gone"] as const) {
      expect(statusOf({ newest: exit(false), writer })).toEqual({
        status: "finished",
        since: NOW - 2 * MINUTE,
        showsLastWrite: false,
      });
    }
    expect(statusOf({ newest: { sort: "result" }, behind: exit(false) }).status).toBe("finished");
  });

  test("3. no program that could have written it runs: finished, since its last write", () => {
    for (const newest of [{ sort: "prompt" }, { sort: "unreadable" }, ask, null] as const) {
      expect(statusOf({ newest, writer: "gone" })).toEqual({
        status: "finished",
        since: WRITTEN,
        showsLastWrite: false,
      });
    }
  });

  test("4. a newest line that cannot be read, or is too far back: unknown", () => {
    expect(statusOf({ newest: { sort: "unreadable" } })).toEqual({
      status: "unknown",
      since: null,
      showsLastWrite: false,
    });
    expect(statusOf({ newest: null }).status).toBe("unknown");
  });

  test("5. the ask tool waits, backed and written lately: needs you, since the ask began", () => {
    expect(statusOf({ newest: ask })).toEqual({
      status: "needs-you",
      since: NOW - 5 * MINUTE,
      waitingReason: "question",
      showsLastWrite: false,
    });
  });

  test("6. a prompt, a result or a tool, bash among them, backed and written lately: working, with its last write", () => {
    for (const sort of ["prompt", "result", "tool"] as const) {
      expect(statusOf({ newest: { sort } })).toEqual({
        status: "working",
        since: null,
        showsLastWrite: true,
      });
    }
  });

  test("7. anything else: unknown, so a reply, and every line while no omp backs it", () => {
    expect(statusOf({ newest: { sort: "reply" } }).status).toBe("unknown");
    for (const newest of [{ sort: "prompt" }, ask] as const) {
      expect(statusOf({ newest, writer: "maybe" }).status).toBe("unknown");
    }
  });
});

describe("the order of the rows", () => {
  test("an exit wins over ps, and ps over a line that cannot be read", () => {
    expect(statusOf({ newest: exit(true), writer: "gone" }).status).toBe("failed");
    expect(statusOf({ newest: { sort: "unreadable" }, writer: "gone" }).status).toBe("finished");
  });

  test("an exit behind is read only behind a reply or a result", () => {
    // The fold drops it behind anything else; given one, the newest exit still wins.
    expect(statusOf({ newest: exit(false), behind: exit(true) }).status).toBe("finished");
  });
});

describe("time", () => {
  test("an ask or a turn quiet for 30 minutes is unknown", () => {
    expect(statusOf({ newest: ask, writtenAt: NOW - QUIET_MS + 1 }).status).toBe("needs-you");
    expect(statusOf({ newest: ask, writtenAt: NOW - QUIET_MS }).status).toBe("unknown");
    expect(statusOf({ writtenAt: NOW - QUIET_MS }).status).toBe("unknown");
    expect(statusOf({ writtenAt: null }).status).toBe("unknown");
  });

  test("a write ahead of the clock counts as none", () => {
    expect(statusOf({ writtenAt: NOW + CLOCK_SLACK_MS }).status).toBe("working");
    expect(statusOf({ writtenAt: NOW + CLOCK_SLACK_MS + 1 }).status).toBe("unknown");
    expect(statusOf({ writtenAt: NOW + CLOCK_SLACK_MS + 1, writer: "gone" }).since).toBeNull();
  });

  test("an exit whose time cannot be right finishes nothing by itself", () => {
    const ahead = exit(false, NOW + CLOCK_SLACK_MS + 1);
    expect(statusOf({ newest: ahead, writer: "backed" }).status).toBe("unknown");
    expect(statusOf({ newest: ahead, writer: "gone" })).toMatchObject({
      status: "finished",
      since: WRITTEN,
    });
    expect(statusOf({ newest: exit(true, Date.UTC(2019, 0, 1)) }).status).toBe("unknown");
  });

  test("an ask's start ahead of the clock is no time, and judged again on every poll", () => {
    const later = { sort: "ask" as const, at: NOW + 2 * MINUTE };
    expect(statusOf({ newest: later })).toMatchObject({ status: "needs-you", since: null });
    expect(
      statusOf({ newest: later, now: NOW + 2 * MINUTE, writtenAt: NOW + MINUTE }),
    ).toMatchObject({
      status: "needs-you",
      since: NOW + 2 * MINUTE,
    });
  });
});
