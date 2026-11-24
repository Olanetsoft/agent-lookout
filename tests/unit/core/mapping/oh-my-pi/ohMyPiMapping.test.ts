import { describe, expect, test } from "vitest";

import {
  askedAtOf,
  CUT_OFF_MS,
  decidedAtOf,
  exitOf as exitOfRead,
  NO_APPROVALS,
  ohMyPiStatusOf,
  QUIET_MS,
  type OhMyPiApprovals,
  type OhMyPiFacts,
  type OhMyPiJudgedApproval,
  type OhMyPiJudgedApprovals,
  type OhMyPiLine,
  type OhMyPiWriter,
} from "@core/mapping/oh-my-pi/ohMyPiMapping";
import { CLOCK_SLACK_MS } from "@core/time";

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const SECOND = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WRITTEN = NOW - MINUTE;
/** When the header says the session began. */
const STARTED = NOW - HOUR;

const ask: OhMyPiLine = { sort: "ask", at: NOW - 5 * MINUTE };
/** A reply, or a tool's result, with the time on its line, or none, as a refusal has. */
const reply = (at: number | null = WRITTEN): OhMyPiLine => ({ sort: "reply", at });
const result = (at: number | null = WRITTEN): OhMyPiLine => ({ sort: "result", at });
const exit = (fatal: boolean, at = NOW - 2 * MINUTE): Extract<OhMyPiLine, { sort: "exit" }> => ({
  sort: "exit",
  fatal,
  at,
});

/** The approvals with no end, asked at these times, their lines 100 bytes apart, with none to be unsure of, each asked by an `omp` that runs, with no prompt or reply since unless given. */
const waiting = (
  times: (number | null)[],
  unsure: OhMyPiApprovals["unsure"] = null,
  each: Partial<Pick<OhMyPiJudgedApproval, "writer" | "replied">> = {},
): OhMyPiJudgedApprovals => ({
  open: times.map((at, index) => ({
    start: 100 * (index + 1),
    at,
    replied: false,
    writer: "backed",
    ...each,
  })),
  unsure,
});

/** The exit that decides, with no approval open unless given. */
const exitOf = (
  facts: Omit<Parameters<typeof exitOfRead>[0], "approvals"> & { approvals?: OhMyPiApprovals },
) => exitOfRead({ approvals: NO_APPROVALS, ...facts });

function statusOf(facts: Partial<OhMyPiFacts>) {
  return ohMyPiStatusOf({
    newest: { sort: "prompt" },
    behind: null,
    cutOff: null,
    approvals: NO_APPROVALS,
    writtenAt: WRITTEN,
    startedAt: STARTED,
    writer: "backed",
    now: NOW,
    ...facts,
  });
}

describe("an approval that waits", () => {
  const at = NOW - 3 * MINUTE;
  const permission = {
    status: "needs-you",
    since: at,
    waitingReason: "permission",
    wait: { since: at, ids: ["approval:100"] },
    showsLastWrite: false,
  };

  test("needs you for permission, since it was asked, whatever line is newest and decides", () => {
    for (const newest of [
      { sort: "tool" },
      result(),
      result(null),
      { sort: "prompt" },
      reply(),
      { sort: "unreadable" },
      null,
    ] as const) {
      expect(statusOf({ newest, approvals: waiting([at]) })).toEqual(permission);
    }
  });

  test("of several, since the first of them was asked", () => {
    expect(statusOf({ approvals: waiting([at + MINUTE, at]) })).toMatchObject({
      status: "needs-you",
      since: at,
      wait: { since: at, ids: ["approval:100", "approval:200"] },
    });
  });

  test("with a time that is not known, or cannot be right, since the first that is, or none", () => {
    expect(statusOf({ approvals: waiting([null]) })).toMatchObject({
      status: "needs-you",
      since: null,
      waitingReason: "permission",
    });
    expect(statusOf({ approvals: waiting([null, at]) }).since).toBe(at);
    const ahead = waiting([NOW + CLOCK_SLACK_MS + 1]);
    expect(statusOf({ approvals: ahead })).toMatchObject({ status: "needs-you", since: null });
    expect(statusOf({ approvals: ahead, now: NOW + 1 }).since).toBe(NOW + CLOCK_SLACK_MS + 1);
  });

  test("with its ask tool newest, for permission, since the earlier of the two", () => {
    for (const [asked, since] of [
      [at, at],
      [NOW - 10 * MINUTE, NOW - 10 * MINUTE],
    ] as const) {
      expect(
        statusOf({ newest: { sort: "ask", at: asked }, approvals: waiting([at]) }),
      ).toMatchObject({
        status: "needs-you",
        since,
        waitingReason: "permission",
        wait: { since, ids: ["approval:100", `ask:${asked}`] },
      });
    }
  });

  test("whatever prompt or reply follows it, as while its command runs in the background", () => {
    const approvals = waiting([at], null, { replied: true });
    for (const newest of [
      { sort: "prompt" },
      reply(),
      reply(null),
      { sort: "tool" },
      result(),
    ] as const) {
      expect(statusOf({ newest, approvals })).toEqual(permission);
    }
  });

  test("asked by an omp that has gone, does not wait for one that opened the file since", () => {
    for (const replied of [true, false]) {
      const approvals = waiting([at], null, { writer: "gone", replied });
      for (const newest of [{ sort: "prompt" }, result(), { sort: "tool" }] as const) {
        expect(statusOf({ newest, approvals })).toEqual({
          status: "working",
          since: null,
          showsLastWrite: true,
        });
      }
      expect(statusOf({ newest: reply(), approvals }).status).toBe("unknown");
      expect(statusOf({ newest: ask, approvals })).toMatchObject({
        status: "needs-you",
        waitingReason: "question",
        wait: { ids: [`ask:${NOW - 5 * MINUTE}`] },
      });
    }
    // Of two, the one whose omp runs.
    const [left, live] = waiting([at, at + MINUTE]).open as [
      OhMyPiJudgedApproval,
      OhMyPiJudgedApproval,
    ];
    expect(
      statusOf({ approvals: { open: [{ ...left, writer: "gone" }, live], unsure: null } }),
    ).toMatchObject({ since: at + MINUTE, wait: { ids: ["approval:200"] } });
  });

  test("asked by an omp that may have gone, leaves an open turn unknown, not working", () => {
    for (const replied of [true, false]) {
      const approvals = waiting([at], null, { writer: "maybe", replied });
      for (const newest of [{ sort: "prompt" }, result(), { sort: "tool" }, reply()] as const) {
        expect(statusOf({ newest, approvals })).toEqual({
          status: "unknown",
          since: null,
          showsLastWrite: false,
        });
      }
      expect(statusOf({ newest: ask, approvals }).waitingReason).toBe("question");
    }
  });

  test("with no time known, is judged as the session is, until a prompt or a reply another omp could have written", () => {
    for (const none of [null, NOW + CLOCK_SLACK_MS + 1]) {
      for (const [writer, replied, status] of [
        ["backed", false, "needs-you"],
        ["backed", true, "unknown"],
        ["maybe", false, "unknown"],
        ["maybe", true, "unknown"],
        ["gone", false, "finished"],
        ["gone", true, "finished"],
      ] as const) {
        // What ps says of the approval is not looked at.
        const approvals = waiting([none], null, { writer: "backed", replied });
        expect(statusOf({ newest: { sort: "tool" }, approvals, writer }).status).toBe(status);
      }
    }
  });

  test("with an exit before it, waits, since an omp ran again to ask", () => {
    const approvals = waiting([at]);
    const before = exit(true, at - SECOND);
    for (const lines of [
      { newest: before },
      { newest: reply(), behind: before, cutOff: before },
      // As --restore writes, within 15 seconds of the exit.
      { newest: result(at + SECOND), cutOff: before },
    ]) {
      expect(statusOf({ ...lines, approvals })).toEqual(permission);
      // Whether a prompt or a reply follows it, as while its command runs in the background, or none.
      for (const replied of [true, false]) {
        const open = waiting([at], null, { replied });
        expect(
          exitOf({
            behind: null,
            cutOff: null,
            ...lines,
            approvals: open,
            startedAt: STARTED,
            now: NOW,
          }),
        ).toBeNull();
      }
      // Nor is it ended by that exit while the omp that asked may run, or once it has gone.
      const maybe = waiting([at], null, { writer: "maybe" });
      expect(statusOf({ ...lines, approvals: maybe, writer: "maybe" }).status).toBe("unknown");
      const gone = waiting([at], null, { writer: "gone" });
      expect(statusOf({ ...lines, approvals: gone, writer: "gone" })).toMatchObject({
        status: "finished",
        since: decidedAtOf({
          ...lines,
          approvals: gone,
          writtenAt: WRITTEN,
          startedAt: STARTED,
          now: NOW,
        }),
      });
      // One copied from before the header is another session's, so the exit decides.
      const copied = waiting([STARTED - SECOND]);
      expect(statusOf({ ...lines, approvals: copied }).status).toBe("failed");
    }
  });

  test("does not outlive the program that asked", () => {
    const approvals = waiting([at], null, { writer: "gone" });
    for (const newest of [{ sort: "tool" }, null] as const) {
      expect(statusOf({ newest, approvals, writer: "gone" })).toEqual({
        status: "finished",
        since: at,
        showsLastWrite: false,
      });
    }
  });

  test("while no omp is known to back it, or it wrote nothing for 30 minutes, is unknown", () => {
    const approvals = waiting([at]);
    const newest = { sort: "tool" } as const;
    const maybe: OhMyPiWriter = "maybe";
    expect(
      statusOf({ newest, approvals: waiting([at], null, { writer: maybe }), writer: maybe }),
    ).toEqual({ status: "unknown", since: null, showsLastWrite: false });
    expect(statusOf({ newest, approvals, writtenAt: NOW - QUIET_MS }).status).toBe("unknown");
    expect(statusOf({ newest, approvals, writtenAt: NOW - QUIET_MS + 1 }).status).toBe("needs-you");
    expect(statusOf({ newest, approvals, writtenAt: null }).status).toBe("unknown");
  });

  test("asked before the header, as one a copy keeps, waits in the session copied, not in this one", () => {
    const newest = { sort: "tool" } as const;
    const copied = waiting([at]);
    expect(statusOf({ newest, approvals: copied, startedAt: at + 1 })).toEqual({
      status: "working",
      since: null,
      showsLastWrite: true,
    });
    // Nor does it hold up a turn when its omp cannot be told.
    const maybe = waiting([at], null, { writer: "maybe" });
    expect(statusOf({ newest, approvals: maybe, startedAt: at + 1 }).status).toBe("working");
    expect(statusOf({ newest, approvals: copied, startedAt: at }).status).toBe("needs-you");
    expect(
      statusOf({ newest, approvals: waiting([at, at + MINUTE]), startedAt: at + 1 }),
    ).toMatchObject({ since: at + MINUTE, wait: { ids: ["approval:200"] } });
    // With no time of its own, or a header whose time cannot be right, it counts.
    expect(statusOf({ newest, approvals: waiting([null]), startedAt: at + 1 }).status).toBe(
      "needs-you",
    );
    for (const startedAt of [null, NOW + CLOCK_SLACK_MS + 1]) {
      expect(statusOf({ newest, approvals: copied, startedAt }).status).toBe("needs-you");
    }
  });

  test("that could wait unseen leaves an open turn unknown, and an ask, or one that is seen, needing you", () => {
    for (const unsure of ["unread", "too-far", "too-many"] as const) {
      const unknown = { status: "unknown", since: null, showsLastWrite: false };
      for (const newest of [{ sort: "prompt" }, result(), { sort: "tool" }, null] as const) {
        expect(statusOf({ newest, approvals: waiting([], unsure) })).toEqual({
          ...unknown,
          unseen: unsure,
        });
        // Not why it is unknown when something else would leave it so.
        for (const other of [
          { writer: "maybe" },
          { writtenAt: NOW - QUIET_MS },
          { writtenAt: null },
          { approvals: waiting([at], unsure, { writer: "maybe" }) },
        ] as const) {
          if (newest === null && "approvals" in other) continue;
          expect(statusOf({ newest, approvals: waiting([], unsure), ...other })).toEqual(unknown);
        }
      }
      for (const newest of [reply(), { sort: "unreadable" }] as const) {
        expect(statusOf({ newest, approvals: waiting([], unsure) })).toEqual(unknown);
      }
      expect(statusOf({ newest: ask, approvals: waiting([], unsure) })).toMatchObject({
        status: "needs-you",
        waitingReason: "question",
      });
      expect(statusOf({ newest: ask, approvals: waiting([], unsure) })).not.toHaveProperty(
        "unseen",
      );
      expect(statusOf({ newest: result(), approvals: waiting([at], unsure) })).toEqual(permission);
      expect(
        statusOf({ newest: result(), approvals: waiting([], unsure), writer: "gone" }).status,
      ).toBe("finished");
    }
  });
});

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
      wait: { since: NOW - 5 * MINUTE, ids: [`ask:${NOW - 5 * MINUTE}`] },
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
        exitOf({
          newest: reply(at + SECOND),
          behind: null,
          cutOff: exit(true, at),
          startedAt: STARTED,
          now: NOW,
        }),
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
      expect(
        exitOf({
          newest: line(null),
          behind: null,
          cutOff: exit(false, at),
          startedAt: STARTED,
          now: NOW,
        }),
      ).toBe(null);
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
    expect(
      exitOf({ newest: ahead, behind: null, cutOff: soon, startedAt: STARTED, now: NOW }),
    ).toBeNull();
    expect(statusOf({ newest: ahead, cutOff: soon }).status).toBe("working");
    expect(
      exitOf({ newest: ahead, behind: null, cutOff: soon, startedAt: STARTED, now: NOW + 1 }),
    ).toBe(soon);
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
      exitOf({
        newest: { sort: "ask", at },
        behind: null,
        cutOff: exit(false, at),
        startedAt: STARTED,
        now: NOW,
      }),
    ).toBeNull();
  });

  test("the exit newest, or the exit behind, decides whatever the times after it", () => {
    const late = at + CUT_OFF_MS + MINUTE;
    expect(
      exitOf({ newest: exit(true, at), behind: null, cutOff: null, startedAt: STARTED, now: NOW }),
    ).toEqual(exit(true, at));
    expect(
      exitOf({
        newest: reply(late),
        behind: exit(false, at),
        cutOff: exit(false, at),
        startedAt: STARTED,
        now: NOW,
      }),
    ).toEqual(exit(false, at));
  });

  test("an exit cut off ahead of the clock takes nothing, as no line after it can be right either", () => {
    const ahead = exit(false, NOW + CLOCK_SLACK_MS + 1);
    expect(
      exitOf({
        newest: result(ahead.at),
        behind: null,
        cutOff: ahead,
        startedAt: STARTED,
        now: NOW,
      }),
    ).toBeNull();
    expect(statusOf({ newest: result(ahead.at), cutOff: ahead }).status).toBe("working");
  });
});

describe("an exit from before the header, as a fork or a branch copies", () => {
  /** When the copy was made, and the header it wrote says it began. */
  const copiedAt = NOW - MINUTE;
  const endAt = copiedAt - HOUR;
  const exitFor = (facts: Partial<Parameters<typeof exitOf>[0]>) =>
    exitOf({
      newest: reply(),
      behind: null,
      cutOff: null,
      startedAt: copiedAt,
      now: NOW,
      ...facts,
    });

  test("decides nothing, newest, behind or cut off, so ps decides", () => {
    for (const fatal of [true, false]) {
      const copied = exit(fatal, endAt);
      expect(exitFor({ newest: copied })).toBeNull();
      expect(exitFor({ newest: reply(endAt), behind: copied, cutOff: copied })).toBeNull();
      // An aborted reply copied with it, within 15 seconds of it.
      expect(exitFor({ newest: reply(endAt + SECOND), cutOff: copied })).toBeNull();
      expect(statusOf({ newest: copied, startedAt: copiedAt })).toEqual({
        status: "unknown",
        since: null,
        showsLastWrite: false,
      });
      expect(statusOf({ newest: copied, startedAt: copiedAt, writer: "gone" })).toEqual({
        status: "finished",
        since: WRITTEN,
        showsLastWrite: false,
      });
      expect(
        statusOf({ newest: reply(endAt), behind: copied, startedAt: copiedAt, writer: "gone" }),
      ).toMatchObject({ status: "finished", since: copiedAt });
    }
  });

  test("one at or after the header still decides, and every one does when the header's time cannot be right", () => {
    for (const at of [copiedAt, copiedAt + SECOND]) {
      const own = exit(true, at);
      expect(exitFor({ newest: own })).toBe(own);
      expect(exitFor({ newest: reply(at), behind: own, cutOff: own })).toBe(own);
      expect(exitFor({ newest: reply(at + SECOND), cutOff: own })).toBe(own);
      expect(statusOf({ newest: own, startedAt: copiedAt })).toMatchObject({
        status: "failed",
        since: at,
      });
    }
    const copied = exit(false, endAt);
    for (const startedAt of [null, NOW + CLOCK_SLACK_MS + 1, Date.UTC(2019, 0, 1)]) {
      expect(exitFor({ newest: copied, startedAt })).toBe(copied);
      expect(exitFor({ newest: reply(endAt), behind: copied, startedAt })).toBe(copied);
      expect(exitFor({ newest: reply(endAt + SECOND), cutOff: copied, startedAt })).toBe(copied);
    }
  });

  test("its own exit, after the clock was set back past the header, decides until the header is within a minute of the clock", () => {
    const headerAt = NOW + CLOCK_SLACK_MS + MINUTE;
    const crash = exit(true, NOW - 10 * MINUTE);
    const facts = {
      newest: crash,
      startedAt: headerAt,
      writtenAt: crash.at,
      writer: "gone" as const,
    };
    expect(statusOf(facts)).toMatchObject({ status: "failed", since: crash.at });
    expect(statusOf({ ...facts, now: headerAt - CLOCK_SLACK_MS })).toMatchObject({
      status: "finished",
      since: crash.at,
    });
  });
});

describe("the last write ps is judged against", () => {
  const at = NOW - 2 * HOUR;
  const judged = (facts: Partial<Parameters<typeof decidedAtOf>[0]>) =>
    decidedAtOf({
      newest: reply(at),
      approvals: NO_APPROVALS,
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

  test("is the file's last write when it was written since it was read and not read again", () => {
    for (const line of [reply, result]) {
      expect(judged({ newest: line(at), current: false })).toBe(WRITTEN);
      expect(judged({ newest: line(at), current: true })).toBe(at);
    }
    expect(judged({ current: false, writtenAt: null })).toBeNull();
  });

  test("while an approval waits, is when it was asked, or the newest reply's or result's time when that is later", () => {
    const approvals = waiting([at + MINUTE, at]);
    for (const newest of [{ sort: "tool" }, { sort: "prompt" }, ask, null] as const) {
      expect(judged({ newest, approvals })).toBe(at + MINUTE);
      expect(judged({ newest, approvals, current: false })).toBe(WRITTEN);
    }
    expect(judged({ newest: result(at + SECOND), approvals })).toBe(at + MINUTE);
    expect(judged({ newest: result(at + HOUR), approvals })).toBe(at + HOUR);
    // Never later than the file's last write.
    expect(judged({ newest: { sort: "tool" }, approvals: waiting([WRITTEN + SECOND]) })).toBe(
      WRITTEN,
    );
  });

  test("passes over an approval a prompt or a reply follows, which another omp may have written", () => {
    for (const asked of [at - MINUTE, null]) {
      const approvals = waiting([asked], null, { replied: true });
      for (const newest of [{ sort: "tool" }, { sort: "prompt" }, ask] as const) {
        expect(judged({ newest, approvals })).toBe(WRITTEN);
      }
      expect(judged({ newest: result(at), approvals })).toBe(at);
      expect(judged({ newest: reply(at), approvals })).toBe(at);
    }
  });

  test("for an approval is when it was asked, never later than the file's last write, or none", () => {
    const facts = { writtenAt: WRITTEN + 0.5, now: NOW };
    expect(askedAtOf({ at }, facts)).toBe(at);
    expect(askedAtOf({ at: WRITTEN + SECOND }, facts)).toBe(WRITTEN);
    expect(askedAtOf({ at }, { ...facts, writtenAt: null })).toBe(at);
    for (const none of [null, NOW + CLOCK_SLACK_MS + 1]) {
      expect(askedAtOf({ at: none }, facts)).toBeNull();
    }
  });

  test("is the file's last write while an approval waits with no time that can be right", () => {
    for (const none of [null, NOW + CLOCK_SLACK_MS + 1]) {
      expect(judged({ newest: { sort: "tool" }, approvals: waiting([none]) })).toBe(WRITTEN);
      expect(judged({ newest: result(at), approvals: waiting([none]) })).toBe(WRITTEN);
      expect(judged({ newest: result(none), approvals: waiting([at]) })).toBe(WRITTEN);
    }
  });

  test("passes over an approval asked before the header", () => {
    const facts = { approvals: waiting([at - MINUTE]), startedAt: at };
    expect(judged({ newest: { sort: "tool" }, ...facts })).toBe(WRITTEN);
    expect(judged({ newest: result(at + SECOND), ...facts })).toBe(at + SECOND);
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
