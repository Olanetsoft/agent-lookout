import { expect, test } from "vitest";

import { createGrokBuildMemory } from "@collector/adapters/grok-build/finishedSessions";
import type { RegistryEntry } from "@collector/adapters/grok-build/registry";
import {
  DAY,
  MINUTE,
  NOW,
  OPENED_AT,
  OTHER_SESSION_ID,
  PID,
  PROJECT,
  SECOND,
  SESSION_ID,
} from "@tests/fixtures/grok-build/grokBuild";

const entryOf = (sessionId = SESSION_ID, openedAt = OPENED_AT): RegistryEntry => ({
  sessionId,
  pid: PID,
  cwd: PROJECT,
  openedAt,
});

const seenFacts = { listed: true, title: null, writtenAt: OPENED_AT + MINUTE };

test("a session seen listed and then not is watched, for a day from when it was last listed", () => {
  const memory = createGrokBuildMemory();
  memory.seen(entryOf(), seenFacts, NOW);
  expect(memory.unlisted(new Set([SESSION_ID]), NOW)).toEqual([]);
  const watched = memory.unlisted(new Set(), NOW + DAY - 1);
  expect(watched.map((item) => item.entry.sessionId)).toEqual([SESSION_ID]);
  // Watching it does not move when it was last listed.
  memory.seen(entryOf(), { ...seenFacts, listed: false, writtenAt: NOW + DAY - 2 }, NOW + DAY - 1);
  expect(memory.unlisted(new Set(), NOW + DAY)).toEqual([]);
  expect(memory.size).toEqual({ seen: 0, ended: 1 });
  // It ended with its process running on, so it names none.
  const [ended] = memory.finished(NOW + DAY);
  expect(ended).toMatchObject({
    id: `grok-build:${SESSION_ID}`,
    status: "finished",
    statusSince: NOW + DAY - 2,
  });
  expect(ended?.pid).toBeUndefined();
});

test("a clock set back keeps a session watched", () => {
  const memory = createGrokBuildMemory();
  memory.seen(entryOf(), seenFacts, NOW);
  expect(memory.unlisted(new Set(), NOW - DAY)).toHaveLength(1);
});

test("an ended session is shown for a day from its end, judged against each poll's clock", () => {
  const memory = createGrokBuildMemory();
  memory.ended(
    { entry: entryOf(), title: null, writtenAt: OPENED_AT + MINUTE, processRunsOn: false },
    NOW,
  );
  expect(memory.finished(OPENED_AT + MINUTE + DAY - 1)).toHaveLength(1);
  expect(memory.finished(OPENED_AT + MINUTE + DAY)).toEqual([]);
  expect(memory.size.ended).toBe(0);
});

test("a session listed again leaves the ended ones", () => {
  const memory = createGrokBuildMemory();
  memory.ended({ entry: entryOf(), title: null, writtenAt: null, processRunsOn: false }, NOW);
  memory.seen(entryOf(), seenFacts, NOW + SECOND);
  expect(memory.finished(NOW + SECOND)).toEqual([]);
  expect(memory.ids()).toEqual(new Set([SESSION_ID]));
});

test("a look that finds no log or title keeps what an earlier one found", () => {
  const memory = createGrokBuildMemory();
  memory.ended(
    {
      entry: entryOf(),
      title: "Release checklist",
      writtenAt: OPENED_AT + MINUTE,
      processRunsOn: false,
    },
    NOW,
  );
  memory.ended(
    { entry: entryOf(), title: null, writtenAt: null, processRunsOn: false },
    NOW + SECOND,
  );
  expect(memory.finished(NOW + SECOND)).toMatchObject([
    { name: "Release checklist", statusSince: OPENED_AT + MINUTE },
  ]);
});

test("at most so many are remembered as seen and as ended, the oldest dropped", () => {
  const memory = createGrokBuildMemory(DAY, 2);
  for (const [index, id] of ["a", "b", "c"].entries()) {
    memory.seen(entryOf(id), seenFacts, NOW + index);
  }
  // One listed now leaves room for one watched, the newest. The others end.
  const watched = memory.unlisted(new Set([OTHER_SESSION_ID]), NOW + 5);
  expect(watched.map((item) => item.entry.sessionId)).toEqual(["c"]);
  expect(memory.size).toEqual({ seen: 1, ended: 2 });
  for (const [index, id] of ["x", "y", "z"].entries()) {
    memory.ended(
      {
        entry: entryOf(id),
        title: null,
        writtenAt: NOW - (3 - index) * MINUTE,
        processRunsOn: false,
      },
      NOW,
    );
  }
  expect(memory.size.ended).toBe(2);
  expect(
    memory
      .finished(NOW)
      .map((session) => session.id)
      .sort(),
  ).toEqual(["grok-build:y", "grok-build:z"]);
});
