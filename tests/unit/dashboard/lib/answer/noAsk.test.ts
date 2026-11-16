import { describe, expect, test } from "vitest";

import type { AnsweringStatus, PermissionAsk, Session } from "@core/sessions/session";
import {
  HERO_PROBLEM_MAX,
  NO_ASK_AFTER_MS,
  NO_ASK_REASONS,
  PERMISSION_PROMPTS_LINK,
  noAskFacts,
  noAskLine,
  noAskReason,
  type NoAskFacts,
} from "@dashboard/lib/answer/noAsk";
import { NO_ASKS_SEEN, rememberAsks, type SeenAsks } from "@dashboard/lib/answer/seenAsks";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;
const MINUTE = 60_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";

const ON: AnsweringStatus = { state: "on", plugin: "seen", holdMs: 5 * MINUTE };
const STARTED = NOW - 60 * MINUTE;

const ASK: PermissionAsk = {
  requestId: "0123456789abcdef0123456789abcdef",
  tool: "Bash",
  command: "npm test",
  allow: true,
  until: NOW + 4 * MINUTE,
};

/** A Claude Code session on this computer, alive, waiting for permission for a minute. */
function waiting(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: ID,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: NOW - MINUTE,
    pid: 4241,
    alive: true,
    ...overrides,
  });
}

function facts(overrides: Partial<NoAskFacts> = {}): NoAskFacts {
  return { answering: ON, startedAt: STARTED, at: NOW, seen: NO_ASKS_SEEN, ...overrides };
}

/** The memory after the page saw `ask` in the session's wait. */
function seenWith(ask: PermissionAsk, session: Session = waiting()): SeenAsks {
  return rememberAsks(NO_ASKS_SEEN, [{ ...session, ask }], NOW);
}

test.each<[string, Session]>([
  ["a held request", waiting({ ask: ASK })],
  ["a request the page could not read", waiting({ askNotRead: true })],
  ["a question", waiting({ waitingReason: "question" })],
  ["another agent's wait", waiting({ id: "codex:1", source: "codex" })],
  [
    "another machine's session",
    waiting({ id: "remote:devbox:claude-code:1", source: "remote:devbox", machine: "devbox" }),
  ],
  ["a wait Agent Lookout answered", waiting({ answered: true })],
  ["an ended process", waiting({ alive: false })],
  ["a session that is working", waiting({ status: "working", waitingReason: undefined })],
])("%s has no reason, whatever answering says", (_what, session) => {
  for (const answering of [
    ON,
    { ...ON, state: "off" as const },
    { ...ON, plugin: "missed" as const },
  ]) {
    expect(noAskReason(session, facts({ answering }))).toBeNull();
  }
});

test("with no answering in the snapshot, or no snapshot, there are no facts, and so no line", () => {
  const snapshot = { generatedAt: NOW, sources: [], sessions: [waiting()] };
  const history = { startedAt: STARTED, points: [] };
  expect(noAskFacts({ snapshot, history, seenAsks: NO_ASKS_SEEN })).toBeNull();
  expect(noAskFacts({ snapshot: null, history, seenAsks: NO_ASKS_SEEN })).toBeNull();
  expect(
    noAskFacts({ snapshot: { ...snapshot, answering: ON }, history: null, seenAsks: NO_ASKS_SEEN }),
  ).toEqual({ answering: ON, startedAt: null, at: NOW, seen: NO_ASKS_SEEN });
});

test("off and unavailable are said at any age, in the first ten seconds, from before the start and past a seen request", () => {
  const seen = seenWith(ASK);
  for (const [state, reason] of [
    ["off", "off"],
    ["unavailable", "unavailable"],
  ] as const) {
    const answering = { ...ON, state };
    for (const session of [
      waiting({ statusSince: NOW }),
      waiting({ statusSince: null }),
      waiting({ statusSince: STARTED - MINUTE }),
    ]) {
      expect(noAskReason(session, facts({ answering }))).toBe(reason);
    }
    expect(noAskReason(waiting(), facts({ answering, seen }))).toBe(reason);
  }
});

describe("a request the page saw in this wait", () => {
  test("leaves no line while its hold lasts, though it has gone from the snapshot, as when it was answered somewhere else", () => {
    const seen = seenWith(ASK);
    for (const plugin of ["seen", "missed", "unknown"] as const) {
      const answering = { ...ON, plugin };
      expect(noAskReason(waiting(), facts({ answering, seen }))).toBeNull();
      expect(noAskReason(waiting(), facts({ answering, seen, at: ASK.until - 1 }))).toBeNull();
    }
    // Even for a wait from before the start, or one longer than the hold.
    const long = waiting({ statusSince: STARTED - MINUTE });
    expect(noAskReason(long, facts({ seen: seenWith(ASK, long) }))).toBeNull();
  });

  test("once its hold has run out, the hold ran out, whatever the plugin says", () => {
    const seen = seenWith(ASK);
    for (const plugin of ["seen", "missed", "unknown"] as const) {
      expect(
        noAskReason(waiting(), facts({ answering: { ...ON, plugin }, seen, at: ASK.until })),
      ).toBe("ran-out");
    }
  });

  test("its hold running out is said in a wait's first ten seconds, and when the wait's start is not known", () => {
    // A hold of 5 seconds, with the request in before the wait's start was written.
    const answering = { ...ON, holdMs: 5_000 };
    const fresh = waiting({ statusSince: NOW });
    const short = { ...ASK, until: NOW + 4_000 };
    expect(
      noAskReason(fresh, facts({ answering, seen: seenWith(short, fresh), at: NOW + 4_000 })),
    ).toBe("ran-out");
    const unknown = waiting({ statusSince: null });
    expect(
      noAskReason(unknown, facts({ seen: seenWith(ASK, unknown), at: ASK.until - 1 })),
    ).toBeNull();
    expect(noAskReason(unknown, facts({ seen: seenWith(ASK, unknown), at: ASK.until }))).toBe(
      "ran-out",
    );
  });

  test("that the page could not read leaves no line for the rest of the wait", () => {
    const seen = rememberAsks(NO_ASKS_SEEN, [waiting({ askNotRead: true })], NOW);
    expect(noAskReason(waiting(), facts({ seen, at: NOW + 60 * MINUTE }))).toBeNull();
  });
});

describe("with no request seen in this wait", () => {
  test("a wait whose start is not known says nothing while answering is on", () => {
    expect(noAskReason(waiting({ statusSince: null }), facts())).toBeNull();
    expect(
      noAskReason(
        waiting({ statusSince: null }),
        facts({ answering: { ...ON, plugin: "missed" } }),
      ),
    ).toBeNull();
  });

  test("nothing is said in a wait's first ten seconds", () => {
    expect(NO_ASK_AFTER_MS).toBe(10_000);
    const missed = { ...ON, plugin: "missed" as const };
    for (const answering of [ON, missed]) {
      expect(noAskReason(waiting({ statusSince: NOW - 9_999 }), facts({ answering }))).toBeNull();
      expect(
        noAskReason(waiting({ statusSince: NOW - NO_ASK_AFTER_MS }), facts({ answering })),
      ).not.toBeNull();
    }
    const early = waiting({ statusSince: STARTED - 5_000 });
    expect(noAskReason(early, facts({ at: STARTED }))).toBeNull();
  });

  test("a wait that began before this run of the collector began is said to be one, whatever the plugin says", () => {
    const early = waiting({ statusSince: STARTED - 30_000 });
    for (const plugin of ["seen", "missed", "unknown"] as const) {
      const answering = { ...ON, plugin };
      expect(noAskReason(early, facts({ answering, at: STARTED + MINUTE }))).toBe("before-start");
    }
  });

  test("past the hold, a wait from before the start is said to be longer than the hold, as that alone is certain", () => {
    const early = waiting({ statusSince: STARTED - 30_000 });
    expect(noAskReason(early, facts({ at: STARTED - 30_000 + ON.holdMs }))).toBe("held-out");
    expect(noAskReason(early, facts({ at: STARTED - 30_000 + ON.holdMs - 1 }))).toBe(
      "before-start",
    );
  });

  test("with the history not read, a wait from before the run is not said to be one", () => {
    const early = waiting({ statusSince: STARTED - 30_000 });
    expect(noAskReason(early, facts({ startedAt: null, at: STARTED + MINUTE }))).toBe("not-held");
  });

  test("with the plugin missed, it may not be installed, however long the wait", () => {
    const answering = { ...ON, plugin: "missed" as const };
    expect(noAskReason(waiting(), facts({ answering }))).toBe("missed");
    expect(noAskReason(waiting({ statusSince: NOW - 10 * MINUTE }), facts({ answering }))).toBe(
      "missed",
    );
  });

  test("a request of another session that reaches the collector mid-wait takes the session from missed to what else is known", () => {
    const session = waiting({ statusSince: NOW - 2 * MINUTE });
    expect(noAskReason(session, facts({ answering: { ...ON, plugin: "missed" } }))).toBe("missed");
    expect(noAskReason(session, facts())).toBe("not-held");
    expect(noAskReason(session, facts({ at: NOW + 3 * MINUTE }))).toBe("held-out");
  });

  test("past the hold, with the plugin seen or unknown, the wait is longer than a request is held", () => {
    for (const plugin of ["seen", "unknown"] as const) {
      const answering = { ...ON, plugin };
      expect(noAskReason(waiting({ statusSince: NOW - ON.holdMs }), facts({ answering }))).toBe(
        "held-out",
      );
      expect(noAskReason(waiting({ statusSince: NOW - ON.holdMs + 1 }), facts({ answering }))).toBe(
        "not-held",
      );
    }
  });

  test("with a hold shorter than ten seconds, the first thing said is that the wait is past it", () => {
    const answering = { ...ON, holdMs: 5_000 };
    expect(noAskReason(waiting({ statusSince: NOW - NO_ASK_AFTER_MS }), facts({ answering }))).toBe(
      "held-out",
    );
  });
});

describe("the words", () => {
  const line = (session: Session, given: Partial<NoAskFacts>, brief = false) =>
    noAskLine(session, facts(given), { brief });

  test("each reason's words, and only missed, and a problem too long for the hero, link to Settings, Permission prompts", () => {
    expect(PERMISSION_PROMPTS_LINK).toBe("Settings, Permission prompts");
    const said = {
      off: line(waiting(), { answering: { ...ON, state: "off" } }),
      "ran-out": line(waiting(), { seen: seenWith(ASK), at: ASK.until }),
      "before-start": line(waiting({ statusSince: STARTED - 30_000 }), { at: STARTED + MINUTE }),
      missed: line(waiting(), { answering: { ...ON, plugin: "missed" } }),
      "held-out": line(waiting({ statusSince: NOW - 6 * MINUTE }), {}),
      "not-held": line(waiting(), {}),
    };
    expect(said).toEqual({
      off: {
        reason: "off",
        text: "AGENT_LOOKOUT_ANSWER is off, so answer it in the session.",
        settings: null,
      },
      "ran-out": {
        reason: "ran-out",
        text: "The hold of 5 minutes on its request has run out, so answer it in the session.",
        settings: null,
      },
      "before-start": {
        reason: "before-start",
        text: "It was already waiting when Agent Lookout started, and its request is not held here, so answer it in the session.",
        settings: null,
      },
      missed: {
        reason: "missed",
        text: "Its request is not held here, and the plugin may not be installed for it.",
        settings: "has the commands that install it.",
      },
      "held-out": {
        reason: "held-out",
        text: "It has waited longer than the 5 minutes a request is held, so answer it in the session.",
        settings: null,
      },
      "not-held": {
        reason: "not-held",
        text: "Its request is not held here, so answer it in the session.",
        settings: null,
      },
    });
    // With unavailable, said on its own below, that is every reason.
    expect([...Object.keys(said), "unavailable"].sort()).toEqual([...NO_ASK_REASONS].sort());
    expect(
      line(waiting({ statusSince: NOW - 10 * MINUTE }), {
        answering: { ...ON, holdMs: 9 * MINUTE },
      })?.text,
    ).toBe(
      "It has waited longer than the 9 minutes a request is held, so answer it in the session.",
    );
  });

  test("unavailable says the collector's own sentence, in the hero too while it is no longer than the line's own longest", () => {
    const problem = "Another copy of Agent Lookout answers permission prompts on this computer.";
    const answering: AnsweringStatus = { ...ON, state: "unavailable", problem };
    for (const brief of [false, true]) {
      expect(line(waiting(), { answering }, brief)).toEqual({
        reason: "unavailable",
        text: problem,
        settings: null,
      });
    }
    const most = "A".repeat(HERO_PROBLEM_MAX);
    expect(line(waiting(), { answering: { ...answering, problem: most } }, true)?.text).toBe(most);
  });

  test("a longer problem is whole in the details, and in the hero the line links to Settings, which says why", () => {
    const problem =
      "Permission prompts are not answered from Agent Lookout on Windows: the plugin's hook is a POSIX sh script, and it reaches Agent Lookout through a Unix socket.";
    expect(problem.length).toBeGreaterThan(HERO_PROBLEM_MAX);
    const answering: AnsweringStatus = { ...ON, state: "unavailable", problem };
    expect(line(waiting(), { answering })?.text).toBe(problem);
    expect(line(waiting(), { answering }, true)).toEqual({
      reason: "unavailable",
      text: "Permission prompts cannot be answered from here.",
      settings: "says why.",
    });
  });

  test("unavailable with no sentence never says Settings says why", () => {
    const answering: AnsweringStatus = { ...ON, state: "unavailable" };
    for (const brief of [false, true]) {
      expect(line(waiting(), { answering }, brief)).toEqual({
        reason: "unavailable",
        text: "Permission prompts cannot be answered from here, so answer it in the session.",
        settings: null,
      });
    }
  });

  test("the hero's longest problem is as long as the line's own longest words, with their link", () => {
    const missed = line(waiting(), { answering: { ...ON, plugin: "missed" } });
    expect(HERO_PROBLEM_MAX).toBe(
      `${missed?.text} ${PERMISSION_PROMPTS_LINK} ${missed?.settings}`.length,
    );
    const others = [
      line(waiting(), { answering: { ...ON, state: "off" } }),
      line(waiting(), { answering: { ...ON, state: "unavailable" } }),
      line(waiting(), { seen: seenWith(ASK), at: ASK.until }),
      line(waiting({ statusSince: STARTED - 30_000 }), { at: STARTED + MINUTE }),
      line(waiting({ statusSince: NOW - 6 * MINUTE }), {}),
      line(waiting(), {}),
    ];
    for (const other of others) expect(other?.text.length).toBeLessThanOrEqual(HERO_PROBLEM_MAX);
  });
});
