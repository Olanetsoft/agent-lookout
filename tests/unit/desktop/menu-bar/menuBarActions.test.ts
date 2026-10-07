import type { MenuItemConstructorOptions } from "electron";
import { expect, test, vi } from "vitest";

import { menuBarActions, sessionAddress } from "@desktop/menu-bar/menuBarActions";
import { menuBarTemplate } from "@desktop/menu-bar/menuBarMenu";
import { createWindowShower, type ShowableWindow } from "@desktop/window/windowShower";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;
const ID = "claude-code:00000000-0000-4000-8000-000000000001";

/** The app's window, as a stand-in that writes down what it was told. */
function fakeWindow() {
  const told: string[] = [];
  const window: ShowableWindow & { told: string[] } = {
    told,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => void told.push("restore"),
    show: () => void told.push("show"),
    focus: () => void told.push("focus"),
    loadURL: async (url) => void told.push(`load ${url}`),
    on: () => undefined,
  };
  return window;
}

/** The menu bar's actions over a real shower, with a stand-in window and app. */
function setUp() {
  const steps: string[] = [];
  const quit = vi.fn();
  const windows: ReturnType<typeof fakeWindow>[] = [];
  const shower = createWindowShower({
    ready: () => true,
    create: (address) => {
      steps.push(`create ${address}`);
      const window = fakeWindow();
      windows.push(window);
      return window;
    },
  });
  const actions = menuBarActions({
    showWindow: (address) => shower.show(address),
    activate: () => void steps.push("activate"),
    checkForUpdates: () => void steps.push("check for updates"),
    openSettings: () => void steps.push("settings"),
    answer: (press) => void steps.push(`answer ${press.decision} ${press.requestId}`),
    quit,
  });
  const template = menuBarTemplate(
    {
      sessions: [
        makeSession({ id: ID, name: "checkout-flow", status: "needs-you", statusSince: NOW }),
      ],
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok" }],
    },
    NOW,
    actions,
  );
  return { steps, windows, shower, quit, template };
}

/** Clicks a menu item as Electron would. */
function click(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

const item = (template: MenuItemConstructorOptions[], label: string) =>
  template.find((entry) => entry.label?.startsWith(label));

test("a session's address is its details in the app's window", () => {
  expect(sessionAddress(ID)).toBe(`agent-lookout://app/#overview/session/${ID}`);
  expect(sessionAddress("status-files:my agent.json")).toBe(
    "agent-lookout://app/#overview/session/status-files:my%20agent.json",
  );
});

test("choosing a session with the window closed brings the app forward and opens the window on its details", () => {
  const { steps, template, shower } = setUp();
  click(item(template, "checkout-flow"));
  expect(steps).toEqual(["activate", `create agent-lookout://app/#overview/session/${ID}`]);
  expect(shower.current()).not.toBeNull();
});

test("choosing a session with the window open moves it to the session's details and brings it forward", () => {
  const { steps, windows, template, shower } = setUp();
  shower.show();
  steps.length = 0;
  click(item(template, "checkout-flow"));
  expect(steps).toEqual(["activate"]);
  expect(windows).toHaveLength(1);
  expect(windows[0]?.told).toEqual([
    `load agent-lookout://app/#overview/session/${ID}`,
    "show",
    "focus",
  ]);
});

test("Open Agent Lookout brings the window forward as it was, and Settings… and Check for Updates… bring the app forward first", () => {
  const { steps, windows, template } = setUp();
  click(item(template, "Open Agent Lookout"));
  click(item(template, "Open Agent Lookout"));
  click(item(template, "Settings…"));
  click(item(template, "Check for Updates…"));
  expect(steps).toEqual([
    "activate",
    "create undefined",
    "activate",
    "activate",
    "settings",
    "activate",
    "check for updates",
  ]);
  expect(windows[0]?.told).toEqual(["show", "focus"]);
});

test("Quit Agent Lookout quits, and brings nothing forward", () => {
  const { steps, quit, template } = setUp();
  click(item(template, "Quit Agent Lookout"));
  expect(quit).toHaveBeenCalledOnce();
  expect(steps).toEqual([]);
});

test("Deny and Allow in a session's submenu go to the app's answers, and bring nothing forward", () => {
  const { steps } = setUp();
  const requestId = "0123456789abcdef0123456789abcdef";
  const answered: string[] = [];
  const actions = menuBarActions({
    showWindow: () => void steps.push("show"),
    activate: () => void steps.push("activate"),
    checkForUpdates: () => {},
    openSettings: () => {},
    answer: (press) => void answered.push(`${press.decision} ${press.requestId}`),
    quit: () => {},
  });
  const template = menuBarTemplate(
    {
      sessions: [
        makeSession({
          id: ID,
          name: "checkout-flow",
          status: "needs-you",
          statusSince: NOW,
          ask: { requestId, tool: "Bash", command: "npm test", allow: true, until: NOW + 60_000 },
        }),
      ],
      sources: [{ id: "claude-code", label: "Claude Code", state: "ok" }],
    },
    NOW,
    actions,
  );
  const submenu = item(template, "checkout-flow")?.submenu as MenuItemConstructorOptions[];
  click(item(submenu, "Deny"));
  click(item(submenu, "Allow"));
  expect(answered).toEqual([`deny ${requestId}`, `allow ${requestId}`]);
  expect(steps).toEqual([]);
  click(item(submenu, "Open Details"));
  expect(steps).toEqual(["activate", "show"]);
});
