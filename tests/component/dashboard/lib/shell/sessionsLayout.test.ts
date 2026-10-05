import { afterEach, expect, onTestFinished, test, vi } from "vitest";

import {
  keepSessionsLayout,
  readSessionsLayout,
  SESSIONS_LAYOUT_STORAGE_KEY,
} from "@dashboard/lib/shell/sessionsLayout";

// Runs in the component project because the choice lives in localStorage.

afterEach(() => {
  localStorage.removeItem(SESSIONS_LAYOUT_STORAGE_KEY);
});

/** Makes local storage throw on every write, and on reads too when asked. */
function blockStorage({ reads }: { reads: boolean }) {
  const blocked = () => {
    throw new DOMException("Storage is blocked.", "SecurityError");
  };
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
  const read = reads ? vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked) : null;
  return () => {
    write.mockRestore();
    read?.mockRestore();
  };
}

test("the choice is kept under agent-lookout-sessions-layout, and the list is the default", () => {
  expect(SESSIONS_LAYOUT_STORAGE_KEY).toBe("agent-lookout-sessions-layout");
  expect(readSessionsLayout()).toBe("list");

  keepSessionsLayout("board");

  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("board");
  expect(readSessionsLayout()).toBe("board");
});

test("when storage is blocked the choice still holds until the page is closed, however often the card is drawn again", () => {
  const unblock = blockStorage({ reads: true });
  onTestFinished(() => {
    unblock();
    // Leaves nothing held in memory for the next test.
    keepSessionsLayout("list");
  });

  expect(readSessionsLayout()).toBe("list");
  expect(() => keepSessionsLayout("board")).not.toThrow();
  // Each read is a card drawn again, as on the way back from Sources.
  expect(readSessionsLayout()).toBe("board");
  expect(readSessionsLayout()).toBe("board");
  keepSessionsLayout("list");
  expect(readSessionsLayout()).toBe("list");
});

test("a choice storage could not take outlasts an older one it still holds, until storage takes a new one", () => {
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "list");
  const unblock = blockStorage({ reads: false });
  onTestFinished(() => {
    unblock();
    keepSessionsLayout("list");
  });

  keepSessionsLayout("board");
  expect(localStorage.getItem(SESSIONS_LAYOUT_STORAGE_KEY)).toBe("list");
  expect(readSessionsLayout()).toBe("board");

  unblock();
  keepSessionsLayout("list");
  expect(readSessionsLayout()).toBe("list");
  // From then on storage is what is read again.
  localStorage.setItem(SESSIONS_LAYOUT_STORAGE_KEY, "board");
  expect(readSessionsLayout()).toBe("board");
});
