import { describe, expect, test } from "vitest";

import { envelopeOf } from "@collector/adapters/mistral-vibe/envelope";
import {
  MINUTE,
  NOW,
  PRIVATE_WORDS,
  publicState,
  sessionId,
  usage,
} from "@tests/fixtures/mistralVibe";

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
    tokens: null,
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

describe("the token counts of the newest reply", () => {
  const turn = { status: "completed", startedAt: NOW - 2 * MINUTE, completedAt: NOW - MINUTE };
  const tokensOf = (contextUsage: unknown) =>
    envelopeOf(publicState({ id: ID, turn, contextUsage }))?.tokens;

  test("are the reply's input, cached part and output from `session.contextUsage`", () => {
    expect(tokensOf(usage(12_000, 340, 9_000))).toEqual({
      input: 12_000,
      cached: 9_000,
      output: 340,
    });
  });

  test("never come from the session's running total, beside them", () => {
    const state = publicState({
      id: ID,
      turn,
      contextUsage: usage(12_000, 340),
      extra: { tokenUsage: usage(980_000, 41_000, 700_000) },
    });
    expect(envelopeOf(state)?.tokens).toEqual({ input: 12_000, output: 340 });
    expect(
      envelopeOf(publicState({ id: ID, turn, extra: { tokenUsage: usage(980_000, 41_000) } })),
    ).toMatchObject({ tokens: null });
  });

  test("are none before the first reply", () => {
    expect(tokensOf(usage(12_000, 340))).not.toBeNull();
    expect(tokensOf(null)).toBeNull();
    const state = publicState({ id: ID, turn });
    delete (state.session as Record<string, unknown>).contextUsage;
    expect(envelopeOf(state)?.tokens).toBeNull();
  });

  test("are none for a state with no turn, as a rewind in place leaves, though the usage stays", () => {
    const contextUsage = usage(12_000, 340, 9_000);
    expect(tokensOf(contextUsage)).not.toBeNull();
    expect(envelopeOf(publicState({ id: ID, turn: null, contextUsage }))).toMatchObject({
      turnStatus: null,
      tokens: null,
    });
    const state = publicState({ id: ID, contextUsage });
    delete state.latestTurn;
    expect(envelopeOf(state)?.tokens).toBeNull();
  });

  test("are none once a compaction has set them to 0, until the next reply reports", () => {
    expect(tokensOf(usage(1, 0))).not.toBeNull();
    expect(tokensOf(usage(0, 0))).toBeNull();
  });

  test("leave out a cached part of 0, which Vibe also writes for a provider that sent none", () => {
    expect(tokensOf(usage(12_000, 340, 0))).toEqual({ input: 12_000, output: 340 });
    const { cachedInputTokens: _cached, ...withoutCached } = usage(12_000, 340);
    expect(tokensOf(withoutCached)).toEqual({ input: 12_000, output: 340 });
  });

  test("keep an output of 0, for a reply that wrote nothing", () => {
    expect(tokensOf(usage(12_000, 0))).toEqual({ input: 12_000, output: 0 });
  });

  test("keep only three whole numbers, whatever else the field holds", () => {
    const tokens = tokensOf({
      ...usage(12_000, 340, 9_000),
      modelName: PRIVATE_WORDS,
      reasoningTokens: 120,
    });
    expect(tokens).toEqual({ input: 12_000, cached: 9_000, output: 340 });
  });

  test.each<[string, unknown]>([
    ["text", "12000"],
    ["a list", [usage(12_000, 340)]],
    ["a number", 12_000],
    ["an empty object", {}],
    ["an input as text", { ...usage(12_000, 340), inputTokens: "12000" }],
    ["an output as text", { ...usage(12_000, 340), outputTokens: "340" }],
    ["a cached part as text", { ...usage(12_000, 340), cachedInputTokens: "9000" }],
    ["an input of true", { ...usage(1, 340), inputTokens: true }],
    ["no input", { cachedInputTokens: 0, outputTokens: 340, totalTokens: 340 }],
    ["no output", { cachedInputTokens: 0, inputTokens: 12_000, totalTokens: 12_000 }],
    ["no total", { cachedInputTokens: 0, inputTokens: 12_000, outputTokens: 340 }],
    ["a total as text", { ...usage(12_000, 340), totalTokens: "12340" }],
    ["a total that is not the two together", { ...usage(12_000, 340), totalTokens: 12_341 }],
    ["a negative input", { ...usage(12_000, 340), inputTokens: -12_000, totalTokens: -11_660 }],
    ["a negative output", { ...usage(12_000, 340), outputTokens: -1, totalTokens: 11_999 }],
    ["a negative cached part", usage(12_000, 340, -1)],
    ["a fraction", { ...usage(12_000, 340), inputTokens: 12_000.5, totalTokens: 12_340.5 }],
    ["a cached part larger than the input", usage(12_000, 340, 12_001)],
    ["an input past the safe range", usage(Number.MAX_SAFE_INTEGER + 1, 0)],
    ["an output past the safe range", usage(1, Number.MAX_SAFE_INTEGER + 1)],
    ["a cached part past the safe range", usage(12_000, 340, Number.MAX_SAFE_INTEGER + 1)],
    ["a total past the safe range", usage(Number.MAX_SAFE_INTEGER, 1)],
  ])("are none for %s", (_name, contextUsage) => {
    expect(tokensOf(usage(12_000, 340))).not.toBeNull();
    expect(tokensOf(contextUsage)).toBeNull();
  });
});
