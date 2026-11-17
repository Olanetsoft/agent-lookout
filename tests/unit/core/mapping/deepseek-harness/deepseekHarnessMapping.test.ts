import { describe, expect, test } from "vitest";

import {
  applyDeepseekHarnessLine,
  continuedDeepseekHarnessWait,
  copyDeepseekHarnessTurn,
  deepseekHarnessStatusOf,
  PENDING_MAX,
  QUIET_MS,
  startDeepseekHarnessTurn,
  type DeepseekHarnessChild,
  type DeepseekHarnessFamily,
  type DeepseekHarnessLine,
  type DeepseekHarnessTurn,
} from "@core/mapping/deepseek-harness/deepseekHarnessMapping";
import { KEEP_AWAKE_WORKING_MS } from "@core/keep-awake/keepAwakeRule";
import { MINUTE, NOW, SECOND, STARTED_AT } from "@tests/fixtures/deepseek-harness/deepseekHarness";

const A = "0b5d6c1e-2f3a-4b4c-8d5e-6f7a8b9c0d1e";
const B = "1c6e7d2f-3a4b-4c5d-9e6f-7a8b9c0d1e2f";

/** The turns after these lines, from a session that began at `STARTED_AT`. */
function fold(lines: DeepseekHarnessLine[], createdAt: number | null = STARTED_AT) {
  let turn = startDeepseekHarnessTurn(createdAt);
  for (const line of lines) turn = applyDeepseekHarnessLine(turn, line, createdAt);
  return turn;
}

const start = (time: number | null = NOW - 5 * MINUTE): DeepseekHarnessLine => ({
  kind: "turn-start",
  time,
});
const end = (
  kind: Extract<DeepseekHarnessLine, { kind: "turn-end" }>["end"],
  time: number | null = NOW - MINUTE,
): DeepseekHarnessLine => ({ kind: "turn-end", end: kind, time });
const ask = (id = A, time: number | null = NOW - 2 * MINUTE): DeepseekHarnessLine => ({
  kind: "approval-asked",
  id,
  time,
});
const question = (
  callId = "call_1",
  time: number | null = NOW - 2 * MINUTE,
): DeepseekHarnessLine => ({
  kind: "question-asked",
  callId,
  time,
});

const child = (
  turn: DeepseekHarnessTurn,
  writtenAt: number | null = NOW - MINUTE,
): DeepseekHarnessChild => ({
  turn,
  writtenAt,
});

function family(own: DeepseekHarnessTurn | null, extra: Partial<DeepseekHarnessFamily> = {}) {
  return deepseekHarnessStatusOf({
    own,
    children: [],
    writtenAt: NOW - 10 * SECOND,
    writer: "maybe",
    now: NOW,
    ...extra,
  });
}

describe("the fold", () => {
  test("a turn that starts is open since then, waiting on nothing", () => {
    expect(fold([start()])).toEqual({
      state: "open",
      since: NOW - 5 * MINUTE,
      approvals: new Map(),
      questions: new Map(),
      waitSince: null,
    });
  });

  test("an approval asked and not answered is waited on since it was asked, and its answer ends the wait", () => {
    const asked = fold([start(), ask()]);
    expect(asked).toMatchObject({ state: "open", waitSince: NOW - 2 * MINUTE });
    expect(fold([start(), ask(), { kind: "approval-decided", id: A }])).toMatchObject({
      state: "open",
      waitSince: null,
    });
  });

  test("a second ask does not move the time the wait began, and the wait ends only when both are answered", () => {
    const both = fold([start(), ask(A, NOW - 3 * MINUTE), question("call_1", NOW - MINUTE)]);
    expect(both).toMatchObject({ waitSince: NOW - 3 * MINUTE });
    const one = applyDeepseekHarnessLine(both, { kind: "approval-decided", id: A }, STARTED_AT);
    expect(one).toMatchObject({ waitSince: NOW - 3 * MINUTE });
    const none = applyDeepseekHarnessLine(
      one,
      { kind: "tool-result", callId: "call_1" },
      STARTED_AT,
    );
    expect(none).toMatchObject({ waitSince: null });
  });

  test("an ask or a question outside an open turn is no wait", () => {
    expect(fold([ask()])).toEqual({ state: "none", since: STARTED_AT });
    expect(fold([start(), end("completed"), question()])).toMatchObject({ state: "ended" });
  });

  test("an ask left in an earlier turn is not waited on in the next", () => {
    const turn = fold([start(), ask(), end("aborted"), start(NOW - 30 * SECOND)]);
    expect(turn).toMatchObject({ state: "open", waitSince: null });
    if (turn.state === "open") expect(turn.approvals.size).toBe(0);
  });

  test("a turn's end with no turn under way is passed over, as a fork's closers are", () => {
    expect(fold([end("error")])).toEqual({ state: "none", since: STARTED_AT });
  });

  test("a fork's end of what it copied starts again with no turn since the session began, and its closers are passed over", () => {
    const turn = fold([
      start(NOW - 50 * MINUTE),
      end("error", NOW - 49 * MINUTE),
      { kind: "end-seed", inherited: true, time: NOW - 49 * MINUTE },
      end("forked", NOW - 49 * MINUTE),
    ]);
    expect(turn).toEqual({ state: "none", since: STARTED_AT });
  });

  test("a reopened session starts again with no turn, since it was reopened", () => {
    const turn = fold([
      start(NOW - 50 * MINUTE),
      end("error", NOW - 49 * MINUTE),
      { kind: "end-seed", inherited: false, time: NOW - 10 * MINUTE },
    ]);
    expect(turn).toEqual({ state: "none", since: NOW - 10 * MINUTE });
    // With no time that can be right, since it began.
    expect(fold([{ kind: "end-seed", inherited: false, time: null }])).toEqual({
      state: "none",
      since: STARTED_AT,
    });
  });

  test("a line in a layout it does not know is unsure until the next turn begins or ends", () => {
    const unsure = fold([start(), { kind: "unsure" }]);
    expect(unsure).toEqual({ state: "unsure" });
    expect(applyDeepseekHarnessLine(unsure, ask(), STARTED_AT)).toEqual({ state: "unsure" });
    expect(applyDeepseekHarnessLine(unsure, end("completed"), STARTED_AT)).toMatchObject({
      state: "ended",
    });
    expect(applyDeepseekHarnessLine(unsure, start(), STARTED_AT)).toMatchObject({ state: "open" });
  });

  test("a result in another layout is unsure while a question waits, and nothing otherwise", () => {
    const other: DeepseekHarnessLine = { kind: "tool-result", callId: null };
    expect(fold([start(), question(), other])).toEqual({ state: "unsure" });
    expect(fold([start(), ask(), other])).toMatchObject({ state: "open" });
    // A resume's results, then its interrupted end, leave it idle.
    expect(fold([start(), question(), other, end("interrupted")])).toMatchObject({
      state: "ended",
      end: "interrupted",
    });
  });

  test(`more than ${PENDING_MAX} waits at once make the turn unsure, and no more are kept`, () => {
    const lines = [start()];
    for (let n = 0; n < PENDING_MAX; n++) lines.push(question(`call_${n}`));
    const full = fold(lines);
    expect(full.state).toBe("open");
    if (full.state === "open") expect(full.questions.size).toBe(PENDING_MAX);
    // Asking one already waited on again is no new wait.
    expect(
      applyDeepseekHarnessLine(copyDeepseekHarnessTurn(full), question("call_0"), STARTED_AT).state,
    ).toBe("open");
    expect(applyDeepseekHarnessLine(full, ask(), STARTED_AT)).toEqual({ state: "unsure" });
  });

  test("a copy is changed without its original", () => {
    const turn = fold([start(), ask()]);
    const copy = copyDeepseekHarnessTurn(turn);
    applyDeepseekHarnessLine(copy, { kind: "approval-decided", id: A }, STARTED_AT);
    expect(turn).toMatchObject({ waitSince: NOW - 2 * MINUTE });
    if (turn.state === "open") expect(turn.approvals.has(A)).toBe(true);
  });
});

describe("the status", () => {
  test("waits 30 quiet minutes, as long as keep-awake holds a working session", () => {
    expect(QUIET_MS).toBe(KEEP_AWAKE_WORKING_MS);
  });

  test("a log that cannot be used, or an unsure turn, is unknown", () => {
    expect(family(null).status).toBe("unknown");
    expect(family({ state: "unsure" }).status).toBe("unknown");
  });

  test("an error is failed whatever ps says, and a session DeepSeek Harness closed mid-turn is finished, since its end", () => {
    for (const writer of ["gone", "backed", "maybe"] as const) {
      expect(family({ state: "ended", end: "error", at: NOW - MINUTE }, { writer })).toMatchObject({
        status: "failed",
        since: NOW - MINUTE,
      });
      expect(
        family({ state: "ended", end: "disposed", at: NOW - MINUTE }, { writer }),
      ).toMatchObject({
        status: "finished",
        since: NOW - MINUTE,
      });
    }
  });

  test("with no program that could write it, a session is finished, since its last write", () => {
    const open = fold([start()]);
    expect(family(open, { writer: "gone" })).toMatchObject({
      status: "finished",
      since: NOW - 10 * SECOND,
    });
    expect(family(fold([start(), end("completed")]), { writer: "gone" }).status).toBe("finished");
  });

  test("an open turn is working since it began, with its last write shown", () => {
    expect(family(fold([start()]))).toEqual({
      status: "working",
      since: NOW - 5 * MINUTE,
      showsLastWrite: true,
    });
  });

  test("an open turn quiet for 29:59 is working, and for 30:00 unknown", () => {
    const open = fold([start()]);
    expect(family(open, { writtenAt: NOW - QUIET_MS + SECOND }).status).toBe("working");
    expect(family(open, { writtenAt: NOW - QUIET_MS })).toEqual({
      status: "unknown",
      since: null,
      showsLastWrite: false,
    });
    // A last write that cannot be right counts as quiet that long.
    expect(family(open, { writtenAt: null }).status).toBe("unknown");
  });

  test("an approval waits for permission, a question or a plan review for an answer, since the wait began", () => {
    expect(family(fold([start(), ask()]))).toMatchObject({
      status: "needs-you",
      waitingReason: "permission",
      since: NOW - 2 * MINUTE,
      wait: { since: NOW - 2 * MINUTE, ids: [`approval:${A}`] },
      showsLastWrite: false,
    });
    expect(family(fold([start(), question()]))).toMatchObject({
      status: "needs-you",
      waitingReason: "question",
    });
    expect(family(fold([start(), question(), ask(B)]))).toMatchObject({
      waitingReason: "permission",
    });
  });

  test("a wait quiet for 30 minutes is unknown unless the desktop app backs it", () => {
    const waiting = fold([start(), ask()]);
    expect(family(waiting, { writtenAt: NOW - QUIET_MS }).status).toBe("unknown");
    expect(family(waiting, { writtenAt: NOW - QUIET_MS - MINUTE, writer: "backed" }).status).toBe(
      "needs-you",
    );
    expect(family(waiting, { writtenAt: null, writer: "backed" }).status).toBe("needs-you");
    expect(family(waiting, { writtenAt: NOW - QUIET_MS + SECOND }).status).toBe("needs-you");
  });

  test("an end of a kind this does not know is unknown, and every other end is idle since it", () => {
    expect(family({ state: "ended", end: "other", at: NOW - MINUTE }).status).toBe("unknown");
    for (const kind of [
      "completed",
      "blocked",
      "max-tokens",
      "interrupted",
      "forked",
      "aborted",
    ] as const) {
      expect(family({ state: "ended", end: kind, at: NOW - MINUTE }), kind).toEqual({
        status: "idle",
        since: NOW - MINUTE,
        showsLastWrite: false,
      });
    }
  });

  test("a time more than a minute ahead of the clock is none, and one within that stands", () => {
    const ahead = NOW + 2 * MINUTE;
    expect(family(fold([start(ahead)]))).toMatchObject({ status: "working", since: null });
    expect(family(fold([start(), ask(A, ahead)]))).toMatchObject({
      status: "needs-you",
      since: null,
    });
    for (const end of ["completed", "error", "disposed"] as const) {
      expect(family({ state: "ended", end, at: ahead }).since, end).toBeNull();
    }
    expect(family(startDeepseekHarnessTurn(ahead))).toMatchObject({ status: "idle", since: null });
    expect(
      family(fold([start(), end("completed")]), { children: [child(fold([start(ahead)]))] }),
    ).toMatchObject({ status: "working", since: null });
    expect(family(fold([start(NOW + 30 * SECOND)])).since).toBe(NOW + 30 * SECOND);
  });

  test("with no turn yet, a session is idle since it began", () => {
    expect(family(startDeepseekHarnessTurn(STARTED_AT))).toMatchObject({
      status: "idle",
      since: STARTED_AT,
    });
  });

  describe("with subagents", () => {
    test("a subagent's turn under way makes an idle session working, since the earliest such turn began", () => {
      const idle = fold([start(NOW - 20 * MINUTE), end("completed", NOW - 19 * MINUTE)]);
      expect(
        family(idle, {
          children: [
            child(fold([start(NOW - 8 * MINUTE)])),
            child(fold([start(NOW - 9 * MINUTE)])),
          ],
        }),
      ).toEqual({ status: "working", since: NOW - 9 * MINUTE, showsLastWrite: true });
      expect(
        family(startDeepseekHarnessTurn(STARTED_AT), { children: [child(fold([start()]))] }).status,
      ).toBe("working");
    });

    test("a subagent quiet for 30 minutes does not", () => {
      const idle = fold([start(), end("completed")]);
      expect(family(idle, { children: [child(fold([start()]), NOW - QUIET_MS)] }).status).toBe(
        "idle",
      );
      expect(family(idle, { children: [child(fold([start()]), null)] }).status).toBe("idle");
    });

    test("a subagent's approval makes the session need you, since it was asked", () => {
      const idle = fold([start(), end("completed")]);
      expect(
        family(idle, { children: [child(fold([start(), ask(B, NOW - 7 * MINUTE)]))] }),
      ).toMatchObject({
        status: "needs-you",
        waitingReason: "permission",
        since: NOW - 7 * MINUTE,
      });
    });

    test("the earliest of the waits of a session and its subagents is when it began to wait", () => {
      const waiting = fold([start(), question("call_1", NOW - 3 * MINUTE)]);
      expect(
        family(waiting, { children: [child(fold([start(), ask(B, NOW - 6 * MINUTE)]))] }),
      ).toMatchObject({
        since: NOW - 6 * MINUTE,
        waitingReason: "permission",
        wait: { ids: ["question:call_1", `approval:${B}`] },
      });
    });

    test("a subagent's turn does not make a session working whose end this does not know", () => {
      expect(
        family(
          { state: "ended", end: "other", at: NOW - MINUTE },
          { children: [child(fold([start()]))] },
        ).status,
      ).toBe("unknown");
    });
  });
});

describe("a wait across polls", () => {
  test("goes on while it shares anything it waited on, with the earliest time", () => {
    const before = { since: NOW - 5 * MINUTE, ids: ["approval:a", "question:q"] };
    expect(
      continuedDeepseekHarnessWait(before, { since: NOW - MINUTE, ids: ["question:q"] }),
    ).toEqual({
      since: NOW - 5 * MINUTE,
      ids: ["question:q"],
    });
  });

  test("is new when it shares nothing, or with none before", () => {
    const wait = { since: NOW - MINUTE, ids: ["approval:b"] };
    expect(
      continuedDeepseekHarnessWait({ since: NOW - 5 * MINUTE, ids: ["approval:a"] }, wait),
    ).toBe(wait);
    expect(continuedDeepseekHarnessWait(undefined, wait)).toBe(wait);
  });
});
