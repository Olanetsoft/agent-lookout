import { expect, test } from "vitest";

import { createFeed, type Shown } from "@site-tour/feed/derive";
import { SESSIONS, WAIT_STARTS } from "@site-tour/feed/hour";

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
