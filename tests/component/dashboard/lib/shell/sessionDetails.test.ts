import { afterEach, expect, test } from "vitest";

import { closeSession, openSession, sessionHref } from "@dashboard/lib/shell/sessionDetails";

// Runs in the component project because the details' address is in the page's history.

const ID = "claude-code:00000000-0000-4000-8000-000000000001";

/** The next change of the address, as a step through the history makes. */
const nextHash = () =>
  new Promise<void>((resolve) =>
    window.addEventListener("hashchange", () => resolve(), { once: true }),
  );

afterEach(() => {
  history.replaceState(null, "", `${location.pathname}${location.search}`);
});

test("closing twice before the step back has landed, as a double click on Close does, steps back once and stays on the Overview", async () => {
  history.replaceState(null, "", `${location.pathname}${location.search}#sources`);
  let moved = nextHash();
  location.hash = "#overview";
  await moved;
  moved = nextHash();
  openSession(ID);
  await moved;
  expect(location.hash).toBe(sessionHref(ID));

  moved = nextHash();
  closeSession();
  closeSession();
  await moved;
  // Time for a second step to land, were one taken.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(location.hash).toBe("#overview");

  // Once it has landed, the next details close as they should.
  moved = nextHash();
  openSession(ID);
  await moved;
  moved = nextHash();
  closeSession();
  await moved;
  expect(location.hash).toBe("#overview");
});
