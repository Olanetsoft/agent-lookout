import { describe, expect, test } from "vitest";

import {
  canBeScheduledTitle,
  keptName,
  SCHEDULED_TITLE_GLOBS,
} from "@core/mapping/hermes-agent/scheduledRuns";

// The titles are of the forms Hermes Agent's scheduler writes, `<job name> ·
// <date>` with the date as `strftime("%b %d %H:%M")` gives it, with made-up
// words in the place of a job's name.

const RUN = "hermes-agent:default/local-0a1b2c3d";

/** Titles with the scheduler's date where it writes it, as it writes them and as Hermes Agent copies them. */
const SCHEDULED = [
  "Read my inbox and say what matters · Nov 24 10:00",
  // Taken by an earlier run, so numbered.
  "Read my inbox and say what matters · Nov 24 10:00 #2",
  // The copy the API server's fork makes when it cannot number one.
  "Read my inbox and say what matters · Nov 24 10:00 fork",
  // Copies of copies: a fork numbered, a numbered title forked, and a fork forked.
  "Read my inbox and say what matters · Nov 24 10:00 fork #2",
  "Read my inbox and say what matters · Nov 24 10:00 #12 fork",
  "Read my inbox and say what matters · Nov 24 10:00 fork fork",
  // A name that is not ASCII, and one with the dot and a time of its own.
  "読んで、まとめて · Nov 24 10:00",
  "Standup · 09:30 notes · Nov 01 00:05",
  // Months as other locales write them, should one ever be set.
  "Read my inbox · nov. 24 10:00",
  "Read my inbox · 11月 24 10:00",
  "Read my inbox · thg 11 24 10:00",
  // A title typed to end as the scheduler's does, which nothing tells from its own, and one taken
  // with it, since any words can be another locale's month.
  "Ticket 81 · Nov 24 10:00",
  "Planning · see the notes of 12 14:30",
];

/** Titles with no such date in them, or with words after it that Hermes Agent never puts there. */
const OTHERS = [
  "Rename the helper",
  "Read my inbox and say what matters",
  "Read my inbox · Nov 24",
  "Read my inbox · 10:00",
  "Read my inbox - Nov 24 10:00",
  "cron 0a1b2c3d4e5f",
  "Meet at Nov 24 10:00",
  "Team call · Tue 12 14:30 with Ana",
  "Team call · Nov 24 10:00, moved",
  "Team call · Nov 24 10:00:30",
  "Team call · Nov 24 10:00 #two",
  "Team call · Nov 24 10:00#2",
];

describe("canBeScheduledTitle", () => {
  test("says so of a Hermes Agent session's name of the scheduler's form, here or on another computer, and of no other name or agent", () => {
    for (const id of [RUN, `remote:devbox:${RUN}`]) {
      for (const name of SCHEDULED) {
        expect([id, name, canBeScheduledTitle(id, name)]).toEqual([id, name, true]);
      }
      for (const name of OTHERS) {
        expect([id, name, canBeScheduledTitle(id, name)]).toEqual([id, name, false]);
      }
    }
    for (const name of SCHEDULED) {
      expect([name, canBeScheduledTitle("codex:0199", name)]).toEqual([name, false]);
    }
  });
});

describe("keptName", () => {
  test.each(SCHEDULED)("a Hermes Agent session kept as %j is handed back by its own id", (name) => {
    expect(keptName(RUN, name)).toBe(RUN);
    // On another machine, its id there.
    expect(keptName(`remote:devbox:${RUN}`, name)).toBe(RUN);
  });

  test.each(OTHERS)("a Hermes Agent session kept as %j keeps that name", (name) => {
    expect(keptName(RUN, name)).toBe(name);
    expect(keptName(`remote:devbox:${RUN}`, name)).toBe(name);
  });

  test("a model's title of the form, which is shown while its session is, is handed back by the id too", () => {
    expect(keptName(RUN, "Release plan · Friday 24 10:00")).toBe(RUN);
  });

  test("another agent's session keeps whatever name it had, whatever its id holds", () => {
    const name = SCHEDULED[0] as string;
    for (const id of [
      "claude-code:hermes-agent:default/local-1",
      "codex:0199",
      "status-files:hermes-agent",
      "hermes-agents:default/local-1",
      "remote:devbox:codex:hermes-agent:1",
      "remote:hermes-agent:codex:1",
    ]) {
      expect([id, keptName(id, name)]).toEqual([id, name]);
    }
  });
});

describe("SCHEDULED_TITLE_GLOBS", () => {
  /** Each pattern as SQLite's GLOB reads one: `*` for any text, `[0-9]` for a digit, the rest as it is. */
  const patterns = SCHEDULED_TITLE_GLOBS.map(
    (glob) =>
      new RegExp(
        `^${glob
          .replaceAll("[0-9]", "\u0000")
          .replaceAll("*", "\u0001")
          .replaceAll(/[.?+^${}()|\\]/g, "\\$&")
          .replaceAll("\u0000", "[0-9]")
          .replaceAll("\u0001", "[^]*")}$`,
        "u",
      ),
  );
  const matches = (title: string) => patterns.some((pattern) => pattern.test(title));

  test("say the same of each title as the rule for a kept name", () => {
    for (const title of SCHEDULED) expect([title, matches(title)]).toEqual([title, true]);
    for (const title of OTHERS) expect([title, matches(title)]).toEqual([title, false]);
  });

  test("hold nothing that would end a SQL string", () => {
    for (const glob of SCHEDULED_TITLE_GLOBS) expect(glob).not.toMatch(/['"]/);
  });
});
