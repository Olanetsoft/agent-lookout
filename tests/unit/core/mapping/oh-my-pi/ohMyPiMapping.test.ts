import { describe, expect, test } from "vitest";

import {
  CUT_OFF_MS,
  decidedAtOf,
  exitOf,
  ohMyPiStatusOf,
  QUIET_MS,
  type OhMyPiFacts,
  type OhMyPiLine,
} from "@core/mapping/oh-my-pi/ohMyPiMapping";
import { CLOCK_SLACK_MS } from "@core/time";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WRITTEN = NOW - MINUTE;

const ask: OhMyPiLine = { sort: "ask", at: NOW - 5 * MINUTE };
/** A reply, or a tool's result, with the time on its line, or none, as a refusal has. */
const reply = (at: number | null = WRITTEN): OhMyPiLine => ({ sort: "reply", at });
const result = (at: number | null = WRITTEN): OhMyPiLine => ({ sort: "result", at });
const exit = (fatal: boolean, at = NOW - 2 * MINUTE): Extract<OhMyPiLine, { sort: "exit" }> => ({
  sort: "exit",
  fatal,
  at,
});

function statusOf(facts: Partial<OhMyPiFacts>) {
  return ohMyPiStatusOf({
    newest: { sort: "prompt" },
    behind: null,
    cutOff: null,
    writtenAt: WRITTEN,
    startedAt: NOW - HOUR,
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
    expect(statusOf({ newest: reply(), behind: exit(true) })).toMatchObject({
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
    expect(statusOf({ newest: result(), behind: exit(false) }).status).toBe("finished");
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

  test("3. after a reply or a result, finished since the time on its line, or the header's when later, as a rename written since moves only the last write", () => {
    const at = NOW - 2 * HOUR;
    for (const line of [reply, result]) {
      const facts = { newest: line(at), writtenAt: NOW - MINUTE, writer: "gone" } as const;
      expect(statusOf({ ...facts, startedAt: at - HOUR })).toEqual({
        status: "finished",
        since: at,
        showsLastWrite: false,
      });
      // A fork, a branch or an import keeps each line's time under a header of its own.
      expect(statusOf({ ...facts, startedAt: at + MINUTE }).since).toBe(at + MINUTE);
      expect(statusOf({ ...facts, startedAt: null }).since).toBe(at);
      // With no time on its line that can be right, the last write, as before.
      for (const none of [null, NOW + CLOCK_SLACK_MS + 1]) {
        expect(statusOf({ ...facts, newest: line(none) }).since).toBe(NOW - MINUTE);
      }
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
    for (const newest of [{ sort: "prompt" }, result(), { sort: "tool" }] as const) {
      expect(statusOf({ newest })).toEqual({
        status: "working",
        since: null,
        showsLastWrite: true,
      });
    }
  });

  test("7. anything else: unknown, so a reply, and every line while no omp backs it", () => {
    expect(statusOf({ newest: reply() }).status).toBe("unknown");
    for (const newest of [{ sort: "prompt" }, ask] as const) {
      expect(statusOf({ newest, writer: "maybe" }).status).toBe("unknown");
    }
  });
});

describe("an exit a quit cut a turn off after", () => {
  const at = NOW - 2 * MINUTE;

  test("decides as failed or finished, since it was recorded, while the newest reply or result was written from it to 15 seconds after it", () => {
    for (const fatal of [true, false]) {
      for (const line of [reply, result]) {
        for (const written of [at, at + CUT_OFF_MS]) {
          expect(statusOf({ newest: line(written), cutOff: exit(fatal, at) })).toEqual({
            status: fatal ? "failed" : "finished",
            since: at,
            showsLastWrite: false,
          });
        }
      }
    }
    expect(CUT_OFF_MS).toBe(15_000);
  });

  test("decides by the newest line's own time, whenever the file was last written, as after a rename", () => {
    for (const writtenAt of [at - HOUR, at + CUT_OFF_MS + 1, NOW, null]) {
      expect(statusOf({ newest: result(at + SECOND), cutOff: exit(false, at), writtenAt })).toEqual(
        { status: "finished", since: at, showsLastWrite: false },
      );
      expect(
        exitOf({ newest: reply(at + SECOND), behind: null, cutOff: exit(true, at), now: NOW }),
      ).toEqual(exit(true, at));
    }
  });

  test("decides nothing once the newest line was written more than 15 seconds after it, or before it", () => {
    for (const written of [at + CUT_OFF_MS + 1, at - 1]) {
      expect(statusOf({ newest: result(written), cutOff: exit(true, at) })).toEqual({
        status: "working",
        since: null,
        showsLastWrite: true,
      });
      expect(statusOf({ newest: reply(written), cutOff: exit(false, at) }).status).toBe("unknown");
    }
  });

  test("a reply or a result whose time cannot be read, as a refusal's, never takes it", () => {
    for (const line of [reply, result]) {
      expect(exitOf({ newest: line(null), behind: null, cutOff: exit(false, at), now: NOW })).toBe(
        null,
      );
    }
    expect(statusOf({ newest: result(null), cutOff: exit(true, at), writtenAt: at })).toEqual({
      status: "working",
      since: null,
      showsLastWrite: true,
    });
    expect(statusOf({ newest: reply(null), cutOff: exit(false, at) }).status).toBe("unknown");
    // With no tool's start after the exit, it is the exit behind, and decides whatever the time.
    expect(
      statusOf({ newest: reply(null), behind: exit(false, at), cutOff: exit(false, at) }),
    ).toMatchObject({ status: "finished", since: at });
  });

  test("a newest line's time more than a minute ahead of the clock takes nothing, judged again on every poll", () => {
    // The exit could be right; the result written 11 seconds after it cannot, yet.
    const soon = exit(false, NOW + 50 * SECOND);
    const ahead = result(NOW + CLOCK_SLACK_MS + 1);
    expect(exitOf({ newest: ahead, behind: null, cutOff: soon, now: NOW })).toBeNull();
    expect(statusOf({ newest: ahead, cutOff: soon }).status).toBe("working");
    expect(exitOf({ newest: ahead, behind: null, cutOff: soon, now: NOW + 1 })).toBe(soon);
    expect(statusOf({ newest: ahead, cutOff: soon, now: NOW + 1 })).toMatchObject({
      status: "finished",
      since: NOW + 50 * SECOND,
    });
  });

  test("decides nothing when the newest line is a tool's start or an ask's, so a restored ask still needs you", () => {
    expect(
      statusOf({ newest: { sort: "tool" }, cutOff: exit(false, at), writtenAt: at }).status,
    ).toBe("working");
    expect(
      statusOf({ newest: { sort: "ask", at }, cutOff: exit(false, at), writtenAt: at }),
    ).toMatchObject({ status: "needs-you", since: at });
    expect(
      exitOf({ newest: { sort: "ask", at }, behind: null, cutOff: exit(false, at), now: NOW }),
    ).toBeNull();
  });

  test("the exit newest, or the exit behind, decides whatever the times after it", () => {
    const late = at + CUT_OFF_MS + MINUTE;
    expect(exitOf({ newest: exit(true, at), behind: null, cutOff: null, now: NOW })).toEqual(
      exit(true, at),
    );
    expect(
      exitOf({ newest: reply(late), behind: exit(false, at), cutOff: exit(false, at), now: NOW }),
    ).toEqual(exit(false, at));
  });

  test("an exit cut off ahead of the clock takes nothing, as no line after it can be right either", () => {
    const ahead = exit(false, NOW + CLOCK_SLACK_MS + 1);
    expect(exitOf({ newest: result(ahead.at), behind: null, cutOff: ahead, now: NOW })).toBeNull();
    expect(statusOf({ newest: result(ahead.at), cutOff: ahead }).status).toBe("working");
  });
});

describe("the last write ps is judged against", () => {
  const at = NOW - 2 * HOUR;
  const judged = (facts: Partial<Parameters<typeof decidedAtOf>[0]>) =>
    decidedAtOf({
      newest: reply(at),
      writtenAt: WRITTEN,
      startedAt: at - HOUR,
      now: NOW,
      ...facts,
    });

  test("is a newest reply's or result's own time, or the header's when later, never later than the file's last write", () => {
    for (const line of [reply, result]) {
      expect(judged({ newest: line(at) })).toBe(at);
      expect(judged({ newest: line(at), startedAt: at + SECOND })).toBe(at + SECOND);
      expect(judged({ newest: line(at), startedAt: null })).toBe(at);
      expect(judged({ newest: line(WRITTEN + SECOND) })).toBe(WRITTEN);
      expect(judged({ newest: line(at), startedAt: WRITTEN + SECOND })).toBe(WRITTEN);
    }
  });

  test("is the file's last write for any other line, or a reply or a result with no time that can be right", () => {
    const others = [
      { sort: "prompt" },
      { sort: "tool" },
      ask,
      exit(false, at),
      { sort: "unreadable" },
      null,
      reply(null),
      result(NOW + CLOCK_SLACK_MS + 1),
      reply(Date.UTC(2019, 0, 1)),
    ] as const;
    for (const newest of others) expect(judged({ newest, writtenAt: WRITTEN + 0.5 })).toBe(WRITTEN);
  });

  test("is none when the file's last write cannot be right", () => {
    expect(judged({ writtenAt: null })).toBeNull();
    expect(judged({ writtenAt: NOW + CLOCK_SLACK_MS + 1 })).toBeNull();
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
