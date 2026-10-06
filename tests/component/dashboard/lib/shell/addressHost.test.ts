import { afterEach, expect, test } from "vitest";

import { goTo, setAddressHost } from "@dashboard/lib/shell/addressHost";
import { closeSession, openSession, sessionHref } from "@dashboard/lib/shell/sessionDetails";

// Runs in the component project because the address is the page's own.

const ID = "claude-code:00000000-0000-4000-8000-000000000001";

/** A host that moves the address without adding to the history, as a frame on another page needs. */
const replacing = {
  go(href: string) {
    location.replace(href);
    return false;
  },
};

const nextHash = () =>
  new Promise<void>((resolve) =>
    window.addEventListener("hashchange", () => resolve(), { once: true }),
  );

afterEach(() => {
  setAddressHost();
  history.replaceState(null, "", `${location.pathname}${location.search}`);
});

test("by default a move adds an entry to the history, and says so", async () => {
  history.replaceState(null, "", `${location.pathname}${location.search}#overview`);
  let moved = nextHash();
  expect(goTo("#sources")).toBe(true);
  await moved;
  expect(location.hash).toBe("#sources");
  // Back lands where the page was, so the move added an entry. The history's length can
  // not say so: the browser keeps at most 50 entries, and the test runner's page adds its own.
  moved = nextHash();
  history.back();
  await moved;
  expect(location.hash).toBe("#overview");
});

test("a host that replaces the address adds nothing to the history, and says so", async () => {
  setAddressHost(replacing);
  const before = history.length;
  const moved = nextHash();
  expect(goTo("#settings")).toBe(false);
  await moved;
  expect(location.hash).toBe("#settings");
  expect(history.length).toBe(before);
});

test("with that host, a session's details open and close with no step through the history", async () => {
  setAddressHost(replacing);
  history.replaceState(null, "", `${location.pathname}${location.search}#overview`);
  const before = history.length;

  let moved = nextHash();
  openSession(ID);
  await moved;
  expect(location.hash).toBe(sessionHref(ID));
  // Nothing is marked as added here, so closing does not go back.
  expect(history.state).toBeNull();

  moved = nextHash();
  closeSession();
  await moved;
  expect(location.hash).toBe("#overview");
  expect(history.length).toBe(before);
});
