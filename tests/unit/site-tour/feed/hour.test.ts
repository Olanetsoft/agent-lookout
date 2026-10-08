import { expect, test } from "vitest";

import { tokenCountsOf } from "@core/tokens/tokenCounts";
import { createFeed, type Shown } from "@site-tour/feed/derive";
import { SESSIONS, WAIT_STARTS, WATCHING_SINCE } from "@site-tour/feed/hour";

const T0 = Date.UTC(2026, 9, 5, 8, 12, 0);
const NOW = T0 + 30_000;

/** Words that would tell a visitor the sessions in the landing page's dashboard are made up. */
const GIVEAWAY = /\b(?:example|sample|demo|test|fake|dummy|mock|placeholder|foo|bar|lorem)\b/i;

/** The one place a giveaway word belongs: what checkout-flow asks to run, and what for. */
const ASKED = "Run: npm test";
const ASKED_WHOLE = ['"command":"npm test"', '"description":"Run the test suite"'];

test("nothing a visitor can read in the hour says it is made up: names, folders, branches and all", () => {
  const feed = createFeed(T0);
  const shown: Shown[] = [
    { moment: "quiet" },
    { moment: "waiting" },
    { moment: "answered", answeredAt: NOW - 5_000 },
  ];
  const read = JSON.stringify([
    SESSIONS,
    ...shown.flatMap((at) => [
      feed.snapshot(at, NOW),
      feed.events(at),
      feed.history(at, NOW, 60 * 60 * 1000),
      SESSIONS.map((session) => feed.lastMessage(session.id, at, NOW)),
    ]),
  ]);
  const said = ASKED_WHOLE.reduce((text, words) => text.replaceAll(words, ""), read);
  expect(said.replaceAll(ASKED, "")).not.toMatch(GIVEAWAY);
});

test("every session lives in a folder under one ordinary home folder, on its own machine", () => {
  for (const session of SESSIONS) {
    if (session.machine === undefined) {
      expect(session.folder).toMatch(/^\/Users\/sam\/code\/[a-z-]+$/);
    } else {
      expect(session.folder).toMatch(/^\/home\/sam\/code\/[a-z-]+$/);
    }
  }
});

test("checkout-flow is still waiting when the hour ends", () => {
  const checkout = SESSIONS.find((session) => session.name === "checkout-flow")!;
  const last = checkout.steps.at(-1)!;
  expect(last).toMatchObject({ at: WAIT_STARTS, status: "needs-you", waitingText: ASKED });
});

test("only the Codex sessions have token counts, and each has some from before it is first listed", () => {
  for (const session of SESSIONS) {
    if (session.source !== "codex") {
      expect(session.tokens).toBeUndefined();
      continue;
    }
    expect(session.tokens?.length).toBeGreaterThan(0);
    expect(session.tokens![0].at).toBeLessThanOrEqual(session.appearsAt ?? WATCHING_SINCE);
  }
});

test("a Codex session's counts are each one reply's, in the order they came, as a long session has them", () => {
  for (const session of SESSIONS) {
    const replies = session.tokens ?? [];
    for (const [i, { at, ...counts }] of replies.entries()) {
      // The one check every reader makes keeps them as they are, cached part and all.
      expect(tokenCountsOf(counts)).toEqual(counts);
      expect(at).toBeGreaterThan(session.startedAt);
      expect(at).toBeLessThanOrEqual(0);
      // Most of a long session's prompt comes from a cache, and a reply writes a few thousand at most.
      expect(counts.cached / counts.input).toBeGreaterThan(0.9);
      expect(counts.output).toBeLessThanOrEqual(5_000);
      // Its context grows with every reply, and stays far from filling the model's window.
      expect(counts.input).toBeLessThan(200_000);
      if (i > 0) {
        expect(at).toBeGreaterThan(replies[i - 1].at);
        expect(counts.input).toBeGreaterThan(replies[i - 1].input);
      }
      // A reply comes while the session works, or ends its turn as it goes idle.
      const step = session.steps.filter((one) => one.at <= at).at(-1);
      if (step?.status !== "working") expect(step).toMatchObject({ at, status: "idle" });
    }
  }
});
