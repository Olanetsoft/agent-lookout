import { describe, expect, test } from "vitest";

import { antigravityLiveness, holdConversations } from "@core/mapping/antigravityLiveness";
import { conversationId, MINUTE, NOW } from "@tests/fixtures/antigravity";

const A = conversationId("a1");
const B = conversationId("b2");
const C = conversationId("c3");

/** A written ten minutes ago, B five minutes ago, C a day ago. */
const conversations = [
  { id: A, writtenAt: NOW - 10 * MINUTE },
  { id: B, writtenAt: NOW - 5 * MINUTE },
  { id: C, writtenAt: NOW - 24 * 60 * MINUTE },
];

describe("holdConversations", () => {
  test("with no agy program running, nothing is open, and that is certain", () => {
    expect(holdConversations([], conversations)).toEqual({ held: new Set(), complete: true });
  });

  test("a program may have open each conversation written since it started, and no other", () => {
    const holding = holdConversations([{ startedAt: NOW - 7 * MINUTE }], conversations);
    expect(holding).toEqual({ held: new Set([B]), complete: true });
    expect(antigravityLiveness(B, holding)).toBe(true);
    expect(antigravityLiveness(A, holding)).toBe(false);
    expect(antigravityLiveness(C, holding)).toBe(false);
  });

  test("errs towards open: one program that wrote to two conversations may have either", () => {
    const holding = holdConversations([{ startedAt: NOW - 60 * MINUTE }], conversations);
    expect(holding).toEqual({ held: new Set([A, B]), complete: true });
  });

  test("a write in the second the program started counts as its own", () => {
    const holding = holdConversations([{ startedAt: NOW - 5 * MINUTE }], conversations);
    expect(holding.held.has(B)).toBe(true);
  });

  test("a program started with --conversation has that one open, however old", () => {
    const holding = holdConversations(
      [{ startedAt: NOW - MINUTE, conversation: C }],
      conversations,
    );
    expect(holding).toEqual({ held: new Set([C]), complete: true });
  });

  test("a program that has written nothing since it started could have any open", () => {
    const holding = holdConversations([{ startedAt: NOW - MINUTE }], conversations);
    expect(holding).toEqual({ held: new Set(), complete: false });
    expect(antigravityLiveness(A, holding)).toBe("unknown");
  });

  test("and so could one whose start is not known, even one that names its conversation", () => {
    expect(holdConversations([{ startedAt: null }], conversations).complete).toBe(false);
    // It may have moved on from that one with /new, and nothing says when it started writing.
    const holding = holdConversations([{ startedAt: null, conversation: A }], conversations);
    expect(holding).toEqual({ held: new Set([A]), complete: false });
    expect(antigravityLiveness(B, holding)).toBe("unknown");
  });

  test("a program that wrote to one conversation and then resumed an older one holds the older one only once it writes to it", () => {
    // Started six minutes ago and wrote B. Resuming C writes nothing the files show.
    const holding = holdConversations([{ startedAt: NOW - 6 * MINUTE }], conversations);
    expect(antigravityLiveness(C, holding)).toBe(false);
  });

  test("a conversation written after the process table was read may be open in a program started since", () => {
    const listedAt = NOW - 6 * MINUTE;
    // The table showed no agy program. B was written after it was read, A before.
    const holding = holdConversations([], conversations, listedAt);
    expect(holding).toEqual({ held: new Set([B]), complete: true });
    expect(antigravityLiveness(A, holding)).toBe(false);
    // Written in the same millisecond the table was read is not after it.
    expect(holdConversations([], conversations, NOW - 5 * MINUTE).held.has(B)).toBe(false);
  });

  test("a conversation whose files could not be looked at is held by nothing but its name", () => {
    const holding = holdConversations(
      [{ startedAt: NOW - 60 * MINUTE }],
      [...conversations, { id: "unread", writtenAt: null }],
    );
    expect(holding.held.has("unread")).toBe(false);
  });

  test("several programs hold what each could", () => {
    const holding = holdConversations(
      [{ startedAt: NOW - 7 * MINUTE }, { startedAt: NOW - 2 * MINUTE, conversation: C }],
      conversations,
    );
    expect(holding).toEqual({ held: new Set([B, C]), complete: true });
  });
});

test("with no process table there is nothing to tell by", () => {
  expect(antigravityLiveness(A, null)).toBe("unknown");
});
