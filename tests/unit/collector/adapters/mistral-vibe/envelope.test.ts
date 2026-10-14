import { expect, test } from "vitest";

import { envelopeOf } from "@collector/adapters/mistral-vibe/envelope";
import { MINUTE, NOW, PRIVATE_WORDS, publicState, sessionId } from "@tests/fixtures/mistralVibe";

const ID = sessionId("a1");

test("keeps the title, the status, the session's times and the newest turn's, and nothing else", () => {
  const state = publicState({
    id: ID,
    status: "failed",
    title: "demo-project refactor",
    createdAt: NOW - 30 * MINUTE,
    updatedAt: NOW - MINUTE,
    turn: { status: "failed", startedAt: NOW - 2 * MINUTE, completedAt: NOW - MINUTE },
  });
  const envelope = envelopeOf(state);
  expect(envelope).toEqual({
    title: "demo-project refactor",
    statusType: "failed",
    createdAt: NOW - 30 * MINUTE,
    updatedAt: NOW - MINUTE,
    turnStatus: "failed",
    turnStartedAt: NOW - 2 * MINUTE,
    turnCompletedAt: NOW - MINUTE,
  });
  // The first thing asked, the error and the queued turn are all in the state, and none is kept.
  expect(JSON.stringify(state)).toContain(PRIVATE_WORDS);
  expect(JSON.stringify(envelope)).not.toContain(PRIVATE_WORDS);
});

test("a title is cleaned and cut as every session's name is, and no title is none", () => {
  const long = envelopeOf(publicState({ id: ID, title: `  demo‮${"x".repeat(300)}` }));
  expect(long?.title).toBe(`demo ${"x".repeat(195)}`);
  expect(envelopeOf(publicState({ id: ID, title: null }))?.title).toBeNull();
  expect(envelopeOf(publicState({ id: ID, title: "   " }))?.title).toBeNull();
});

test("a session with no turn yet has no turn's times", () => {
  expect(envelopeOf(publicState({ id: ID, turn: null }))).toMatchObject({
    turnStatus: null,
    turnStartedAt: null,
    turnCompletedAt: null,
  });
});

test("values that could not be Vibe's are not kept", () => {
  const state = publicState({ id: ID });
  const session = state.session as Record<string, unknown>;
  session.status = { type: "x".repeat(65) };
  session.createdAt = "yesterday";
  session.updatedAt = 1.5;
  expect(envelopeOf(state)).toMatchObject({ statusType: null, createdAt: null, updatedAt: null });
});

test("what is not a public state of the format this adapter knows is none", () => {
  expect(envelopeOf(null)).toBeNull();
  expect(envelopeOf([])).toBeNull();
  expect(envelopeOf({ format: "harness.public-session-state/v1" })).toBeNull();
  expect(
    envelopeOf({ ...publicState({ id: ID }), format: "harness.public-session-state/v2" }),
  ).toBeNull();
  // A state that names no format is read as this one.
  const { format: _format, ...unnamed } = publicState({ id: ID, status: "running" });
  expect(envelopeOf(unnamed)?.statusType).toBe("running");
});
