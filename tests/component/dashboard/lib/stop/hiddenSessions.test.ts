import { afterEach, expect, test, vi } from "vitest";

import {
  HIDDEN_SESSIONS_STORAGE_KEY,
  hiddenKey,
  hideSession,
  MAX_HIDDEN,
  readHidden,
} from "@dashboard/lib/stop/hiddenSessions";

afterEach(() => {
  localStorage.removeItem(HIDDEN_SESSIONS_STORAGE_KEY);
  vi.restoreAllMocks();
});

const session = {
  id: "claude-code:00000000-0000-4000-8000-000000000001",
  statusSince: 1_700_000_000_000,
};

test("nothing is hidden until the person hides a session, and nothing is written before", () => {
  expect(readHidden()).toEqual(new Set());
  expect(localStorage.getItem(HIDDEN_SESSIONS_STORAGE_KEY)).toBeNull();
});

test("a hidden session is kept with the moment its idle began, so a change of status shows it again", () => {
  const hidden = hideSession(session);

  expect(hidden.has(hiddenKey(session))).toBe(true);
  expect(readHidden().has(hiddenKey(session))).toBe(true);
  expect(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_STORAGE_KEY) ?? "[]")).toEqual([
    `1700000000000 ${session.id}`,
  ]);
  // Idle again since another moment: no longer hidden.
  expect(readHidden().has(hiddenKey({ ...session, statusSince: 1_700_000_500_000 }))).toBe(false);
});

test("hiding the same session twice keeps it once, and the oldest go first past the limit", () => {
  hideSession(session);
  hideSession(session);
  expect(JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_STORAGE_KEY) ?? "[]")).toHaveLength(1);

  for (let n = 0; n < MAX_HIDDEN + 5; n += 1)
    hideSession({ id: `claude-code:${n}`, statusSince: n });
  const kept = JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_STORAGE_KEY) ?? "[]") as string[];
  expect(kept).toHaveLength(MAX_HIDDEN);
  expect(kept.at(-1)).toBe(`${MAX_HIDDEN + 4} claude-code:${MAX_HIDDEN + 4}`);
  expect(kept).not.toContain(hiddenKey(session));
});

test("anything else in storage is read as nothing hidden", () => {
  localStorage.setItem(HIDDEN_SESSIONS_STORAGE_KEY, "{not json");
  expect(readHidden()).toEqual(new Set());
  localStorage.setItem(HIDDEN_SESSIONS_STORAGE_KEY, JSON.stringify({ a: 1 }));
  expect(readHidden()).toEqual(new Set());
  localStorage.setItem(HIDDEN_SESSIONS_STORAGE_KEY, JSON.stringify(["a", 2, null]));
  expect(readHidden()).toEqual(new Set(["a"]));
});

test("with storage blocked, it stays hidden on this page", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  const other = { ...session, id: "claude-code:blocked" };
  expect(hideSession(other).has(hiddenKey(other))).toBe(true);
  expect(readHidden().has(hiddenKey(other))).toBe(true);
});
