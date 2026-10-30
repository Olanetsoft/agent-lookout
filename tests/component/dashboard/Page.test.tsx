import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { SessionsSnapshot } from "@core/sessions/session";
import Page from "@dashboard/Page";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { makeSession } from "@tests/fixtures/session";

/**
 * The header, which stands outside every view's own boundary, as a part of the
 * frame that cannot draw a session named "boom". What it throws reaches the
 * page's boundary, and the app under it is taken down.
 */
vi.mock("@dashboard/components/dashboard/Header", async (importOriginal) => {
  const { createElement } = await import("react");
  const real = await importOriginal<typeof import("@dashboard/components/dashboard/Header")>();
  function Header(props: Parameters<typeof real.Header>[0]) {
    if (props.snapshot?.sessions.some((session) => session.name === "boom")) {
      throw new Error("The header could not draw a session.");
    }
    return createElement(real.Header, props);
  }
  return { ...real, Header };
});

const MINUTE = 60_000;

/** What the local server answers: one idle session, with the name given. */
function snapshotOf(name: string): SessionsSnapshot {
  const now = Date.now();
  return {
    generatedAt: now,
    sources: [{ id: "claude-code", label: "Claude Code", state: "ok", checkedAt: now }],
    sessions: [makeSession({ name, status: "idle", statusSince: now - MINUTE })],
  };
}

/** A local server that names its one session `name()`, and the paths it was asked for. */
function serve(name: () => string): string[] {
  const asked: string[] = [];
  setApiHost(async (path) => {
    asked.push(path);
    const body = path.startsWith("/api/sessions")
      ? snapshotOf(name())
      : path.startsWith("/api/events")
        ? { events: [] }
        : { points: [], startedAt: Date.now() - 10 * MINUTE };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  return asked;
}

afterEach(async () => {
  await cleanup();
  setApiHost();
});

test("the page draws the app with a store that polls the local server", async () => {
  const asked = serve(() => "fine-one");

  const screen = await render(<Page />);

  await expect
    .element(screen.getByRole("region", { name: "Sessions" }).getByText("fine-one"))
    .toBeVisible();
  expect(asked.slice(0, 3)).toEqual([
    "/api/sessions",
    "/api/events?since=0",
    "/api/history?windowMs=3600000",
  ]);
});

test("the page polls on a worker's beat, which is ended when the page goes", async () => {
  const asked = serve(() => "fine-one");
  const polls = () => asked.filter((path) => path === "/api/sessions").length;
  const pageTimer = vi.spyOn(window, "setInterval");
  const told = vi.spyOn(Worker.prototype, "postMessage");
  const ended = vi.spyOn(Worker.prototype, "terminate");
  onTestFinished(() => [pageTimer, told, ended].forEach((spy) => spy.mockRestore()));

  const screen = await render(<Page />);
  await expect
    .element(screen.getByRole("region", { name: "Sessions" }).getByText("fine-one"))
    .toBeVisible();

  // One worker, told the two seconds between polls. The page keeps no timer for it.
  expect(told.mock.calls).toEqual([[2_000]]);
  expect(pageTimer.mock.calls.filter(([, ms]) => ms === 2_000)).toEqual([]);
  // The next poll comes on the worker's beat.
  await vi.waitFor(() => expect(polls()).toBeGreaterThanOrEqual(2), { timeout: 6_000 });

  await screen.unmount();
  expect(ended).toHaveBeenCalledTimes(1);
});

test("after a fault in the frame, Try again asks the server afresh and draws what it answers now", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => quiet.mockRestore());
  let name = "boom";
  const asked = serve(() => name);

  const screen = await render(<Page />);

  // The first answer cannot be drawn: the page says so, with the app taken down.
  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout could not draw this page");
  expect(screen.container.querySelector('[data-slot="frame"]')).toBeNull();

  // The server's answer is good again by the time the person tries again.
  name = "fine-one";
  const before = asked.length;
  await screen.getByRole("button", { name: "Try again" }).click();

  await expect
    .element(screen.getByRole("region", { name: "Sessions" }).getByText("fine-one"))
    .toBeVisible();
  expect(screen.container.querySelector('[data-slot="page-error"]')).toBeNull();
  expect(asked.slice(before)).toContain("/api/sessions");
});
