import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ACTION_HEADER } from "@core/api";
import { MenuBarCard } from "@dashboard/components/settings/MenuBarCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { warmPaint } from "@tests/support/browser/colours";

/** Whether the app shows its item in the menu bar, as `GET /api/app/menu-bar` would say. */
let show: boolean;
/** Each request the card made: its path, method, action and body. */
let asked: { path: string; method: string; action: string | null; body: string | null }[];
/** Whether the app answers at all, and whether it takes a change of the switch. */
let answering: boolean;
let refusing: boolean;

beforeEach(() => {
  show = true;
  asked = [];
  answering = true;
  refusing = false;
  setApiHost(async (path, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    asked.push({ path, method: init?.method ?? "GET", action: headers.get(ACTION_HEADER), body });
    if (!answering) throw new TypeError("Failed to fetch");
    if (path === "/api/app/menu-bar/setting") {
      if (refusing) {
        return new Response(JSON.stringify({ error: "No." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      show = (JSON.parse(body ?? "{}") as { show: boolean }).show;
    }
    return new Response(JSON.stringify({ show }), {
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  setApiHost();
});

const card = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("region", { name: "Menu bar" });

test("shows the switch Show in menu bar, on, as the app says, and what it does", async () => {
  const screen = await render(<MenuBarCard />);
  await expect.element(screen.getByRole("radiogroup", { name: "Show in menu bar" })).toBeVisible();
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  expect(card(screen).element().textContent).toContain(
    "shows how many sessions need you, with the window open or closed",
  );
  expect(card(screen).element().textContent).toContain("choose one to open its details");
  expect(asked).toEqual([{ path: "/api/app/menu-bar", method: "GET", action: null, body: null }]);
});

test("off takes the item away: the app is told, and the switch shows its answer", async () => {
  const screen = await render(<MenuBarCard />);
  await screen.getByRole("radio", { name: "Off" }).click();

  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  expect(asked).toContainEqual({
    path: "/api/app/menu-bar/setting",
    method: "POST",
    action: "menu-bar-setting",
    body: '{"show":false}',
  });
  expect(show).toBe(false);

  await screen.getByRole("radio", { name: "On" }).click();
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  expect(show).toBe(true);
});

test("a switch that was turned off before shows off", async () => {
  show = false;
  const screen = await render(<MenuBarCard />);
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
});

test("a change the app does not take leaves the switch as it was", async () => {
  refusing = true;
  const screen = await render(<MenuBarCard />);
  await screen.getByRole("radio", { name: "Off" }).click();
  await vi.waitFor(() =>
    expect(asked.some((request) => request.path === "/api/app/menu-bar/setting")).toBe(true),
  );
  // The refusal has had its turn to come back.
  await new Promise((resolve) => setTimeout(resolve, 50));
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
});

test("says so when the app does not answer, and offers no switch", async () => {
  answering = false;
  const screen = await render(<MenuBarCard />);
  await expect
    .element(card(screen).getByText("Whether Agent Lookout is in the menu bar could not be read."))
    .toBeVisible();
  expect(screen.getByRole("radiogroup").elements()).toHaveLength(0);
});

test("before the app has answered, the row is empty and keeps its height", async () => {
  let answer = () => {};
  const held = new Promise<void>((resolve) => {
    answer = resolve;
  });
  setApiHost(async () => {
    await held;
    return new Response(JSON.stringify({ show: true }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const screen = await render(<MenuBarCard />);
  const row = card(screen).element().querySelector('[data-part="row"]') as HTMLElement;
  const before = row.getBoundingClientRect().height;
  expect(screen.getByRole("radiogroup").elements()).toHaveLength(0);
  answer();
  await expect.element(screen.getByRole("radiogroup", { name: "Show in menu bar" })).toBeVisible();
  expect(row.getBoundingClientRect().height).toBe(before);
});

test.each(["dark", "light"] as const)("in the %s theme nothing in it is warm", async (theme) => {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    const screen = await render(<MenuBarCard />);
    await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
    expect(warmPaint(screen.container)).toEqual([]);
  } finally {
    document.documentElement.removeAttribute("data-theme");
  }
});
