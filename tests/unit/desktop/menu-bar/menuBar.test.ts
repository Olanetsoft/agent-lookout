import { describe, expect, test, vi } from "vitest";

import { shownAsk } from "@collector/answers/shownAsk";
import type { Session } from "@core/sessions/session";
import {
  createMenuBar,
  MENU_TIMES_MAX_AGE_MS,
  MENU_UNSAID_CLOSE_MS,
} from "@desktop/menu-bar/menuBar";
import type { MenuBarActions, MenuBarSnapshot } from "@desktop/menu-bar/menuBarMenu";
import type { MenuBarSettings, MenuBarSettingsStore } from "@desktop/menu-bar/menuBarSettings";
import { FakeMenu, FakeTray } from "@tests/support/desktop/electronStandIns";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;

type Image = "quiet" | "lit";

function memorySettings(show = true): MenuBarSettingsStore & { written: MenuBarSettings[] } {
  const written: MenuBarSettings[] = [];
  return {
    written,
    read: () => written.at(-1) ?? { show },
    write: (settings) => void written.push(settings),
  };
}

function setUp(options: { show?: boolean; makeTray?: (image: Image) => FakeTray<Image> } = {}) {
  const trays: FakeTray<Image>[] = [];
  const pending: (() => void)[] = [];
  let now = NOW;
  const actions: MenuBarActions = {
    openSession: vi.fn(),
    answer: vi.fn(),
    openApp: vi.fn(),
    checkForUpdates: vi.fn(),
    openSettings: vi.fn(),
    quit: vi.fn(),
  };
  const settings = memorySettings(options.show);
  const warn = vi.fn();
  const bar = createMenuBar({
    icons: { quiet: "quiet", lit: "lit" },
    makeTray:
      options.makeTray ??
      ((image) => {
        const tray = new FakeTray(image);
        trays.push(tray);
        return tray;
      }),
    buildMenu: (template) => new FakeMenu(template),
    actions,
    settings,
    now: () => now,
    later: (run) => void pending.push(run),
    warn,
  });
  return {
    bar,
    trays,
    settings,
    actions,
    warn,
    tray: () => trays.at(-1),
    /** Runs what was left for later, as the event loop would. */
    runLater: () => pending.splice(0).forEach((run) => run()),
    tick: (ms: number) => {
      now += ms;
    },
  };
}

function waiting(name: string, since: number, more: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${name}`,
    name,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: since,
    ...more,
  });
}

const snapshot = (...sessions: Session[]): MenuBarSnapshot => ({
  sessions,
  sources: [{ id: "claude-code", label: "Claude Code", state: "ok" }],
});

describe("in the menu bar", () => {
  test("the item is put there at start with the switch on, the lamp unlit and no count", () => {
    const { bar, trays, tray } = setUp();
    bar.start();
    expect(trays).toHaveLength(1);
    expect(tray()?.image).toBe("quiet");
    expect(tray()?.title).toBe("");
    expect(tray()?.toolTip).toBe("Agent Lookout");
    expect(tray()?.menu?.labels[0]).toBe("Looking for agents…");
  });

  test("with the switch off, nothing is put there", () => {
    const { bar, trays } = setUp({ show: false });
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 1_000)));
    expect(trays).toHaveLength(0);
    expect(bar.status()).toEqual({ show: false });
  });

  test("while sessions wait, the lamp is lit with the count beside it in digits that keep their width", () => {
    const { bar, tray } = setUp();
    bar.start();
    bar.update(snapshot(waiting("a", NOW - 1_000), waiting("b", NOW - 2_000)));
    expect(tray()?.image).toBe("lit");
    expect(tray()?.title).toBe("2");
    expect(tray()?.told).toContain('title "2" monospacedDigit');
    expect(tray()?.toolTip).toBe("Agent Lookout: 2 sessions need you");

    bar.update(snapshot(makeSession({ status: "working" })));
    expect(tray()?.image).toBe("quiet");
    expect(tray()?.title).toBe("");
    expect(tray()?.menu?.labels[0]).toBe("Nothing needs you");
  });

  test("a prompt answered by a press or a rule puts the lamp out at once, before the session is seen to move on", () => {
    const { bar, tray } = setUp();
    bar.start();
    bar.update(snapshot(waiting("a", NOW - 1_000)));
    expect(tray()?.image).toBe("lit");

    bar.update(snapshot(waiting("a", NOW - 1_000, { answered: true })));
    expect(tray()?.image).toBe("quiet");
    expect(tray()?.title).toBe("");
    expect(tray()?.toolTip).toBe("Agent Lookout");
    expect(tray()?.menu?.labels[0]).toBe("Nothing needs you");
  });

  test("the icon, the count, the tooltip and the menu are told only of a change", () => {
    const { bar, tray, tick } = setUp();
    bar.start();
    tray()?.told.splice(0);
    bar.update(snapshot(waiting("a", NOW - 1_000)));
    tick(2_000);
    bar.update(snapshot(waiting("a", NOW - 1_000)));
    expect(tray()?.told).toEqual([
      "image lit",
      'title "1" monospacedDigit',
      'tooltip "Agent Lookout: 1 session needs you"',
      "menu",
    ]);

    // Another session waiting makes the menu again, and so does a new wait for the same one.
    tray()?.told.splice(0);
    bar.update(snapshot(waiting("a", NOW - 1_000), waiting("b", NOW)));
    expect(tray()?.told).toContain("menu");
    expect(tray()?.menu?.labels.slice(0, 3)).toEqual(["2 sessions need you", "a · 3s", "b · 2s"]);
    tray()?.told.splice(0);
    bar.update(snapshot(waiting("a", NOW), waiting("b", NOW)));
    expect(tray()?.told).toEqual(["menu"]);
  });

  test("with nothing waiting, the menu is never made again by a poll", () => {
    const { bar, tray, tick } = setUp();
    bar.start();
    bar.update(snapshot(makeSession({ status: "working" })));
    tray()?.told.splice(0);
    tick(10 * MENU_TIMES_MAX_AGE_MS);
    bar.update(snapshot(makeSession({ status: "working" })));
    expect(tray()?.told).toEqual([]);
  });

  test("while it shows a time, a poll makes the menu again once a minute, for a menu opened from the keyboard", () => {
    const { bar, tray, tick } = setUp();
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000)));
    tray()?.told.splice(0);
    tick(MENU_TIMES_MAX_AGE_MS - 1);
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000)));
    expect(tray()?.told).toEqual([]);
    tick(1);
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000)));
    expect(tray()?.told).toEqual(["menu"]);
    expect(tray()?.menu?.labels[1]).toBe("checkout-flow · 2m 00s");
  });

  test("the times are those of the moment the pointer comes over the icon", () => {
    const { bar, tray, tick } = setUp();
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000)));
    expect(tray()?.menu?.labels[1]).toBe("checkout-flow · 1m 00s");
    tick(1_500);
    tray()?.hover();
    expect(tray()?.menu?.labels[1]).toBe("checkout-flow · 1m 01s");
  });
});

const ASK_ID = "0123456789abcdef0123456789abcdef";

/** A permission request held for a session, made by the collector's own rule for what is shown. */
function heldAsk(command: string, requestId = ASK_ID): NonNullable<Session["ask"]> {
  const shown = shownAsk("Bash", { command });
  if (shown === null) throw new Error("not held");
  return { requestId, ...shown, until: NOW + 300_000 };
}

describe("while the menu is open", () => {
  test("it is left as it is, and what came meanwhile is shown once it has closed and the choice is heard", () => {
    const { bar, tray, runLater } = setUp();
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000)));
    const open = tray()?.menu;
    open?.open();

    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000), waiting("docs", NOW - 5_000)));
    tray()?.hover();
    expect(tray()?.menu).toBe(open);
    // The count beside the icon is not in the menu, and follows at once.
    expect(tray()?.title).toBe("2");

    open?.close();
    // Still in place as the menu closes, for the item chosen in it.
    expect(tray()?.menu).toBe(open);
    runLater();
    expect(tray()?.menu).not.toBe(open);
    expect(tray()?.menu?.labels.slice(0, 3)).toEqual([
      "2 sessions need you",
      "checkout-flow · 1m 00s",
      "docs · 5s",
    ]);
  });

  test("a submenu's closing, which Electron tells the top menu of, leaves the top menu in place", () => {
    const { bar, tray, runLater } = setUp();
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000, { ask: heldAsk("npm test") })));
    const open = tray()?.menu as FakeMenu;
    open.open();
    open.openSubmenu("checkout-flow").leave();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000), waiting("docs", NOW - 5_000)));
    runLater();
    tray()?.hover();
    bar.reopen();
    expect(tray()?.menu).toBe(open);
    expect(tray()?.told).not.toContain("pop up");

    // Then the top menu's own closing.
    open.close();
    runLater();
    expect(tray()?.menu).not.toBe(open);
    expect(tray()?.menu?.labels[0]).toBe("2 sessions need you");
  });

  test("with the top menu's closing unsaid after a submenu's, it is taken as closed a minute after", () => {
    const { bar, tray, tick } = setUp();
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000, { ask: heldAsk("npm test") })));
    const open = tray()?.menu as FakeMenu;
    open.open();
    open.openSubmenu("checkout-flow").leave();
    tick(MENU_UNSAID_CLOSE_MS - 1);
    bar.update(snapshot(waiting("docs", NOW - 5_000)));
    expect(tray()?.menu).toBe(open);
    tick(1);
    bar.update(snapshot(waiting("docs", NOW - 5_000)));
    expect(tray()?.menu).not.toBe(open);
    expect(tray()?.menu?.labels[1]).toMatch(/^docs/);
  });

  test("a click on an item says the whole menu has closed, though only a submenu's closing was told", () => {
    const { bar, tray, actions, runLater } = setUp();
    bar.start();
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000, { ask: heldAsk("npm test") })));
    const open = tray()?.menu as FakeMenu;
    open.open();
    const submenu = open.openSubmenu("checkout-flow");
    bar.update(snapshot(waiting("checkout-flow", NOW - 60_000), waiting("docs", NOW - 5_000)));
    // One closing is told for the two openings, then the item hears its click.
    submenu.click("Deny");
    expect(actions.answer).toHaveBeenCalledOnce();
    expect(tray()?.menu).toBe(open);
    runLater();
    expect(tray()?.menu).not.toBe(open);
    bar.reopen();
    expect(tray()?.told.at(-1)).toBe("pop up");
  });

  test("a menu closed with nothing new is left in place", () => {
    const { bar, tray, runLater } = setUp();
    bar.start();
    bar.update(snapshot());
    const open = tray()?.menu;
    open?.open();
    open?.close();
    runLater();
    expect(tray()?.menu).toBe(open);
  });
});

describe("the switch Show in menu bar", () => {
  test("off takes the item away and remembers it; on puts it back with the latest count", () => {
    const { bar, trays, settings } = setUp();
    bar.start();
    bar.update(snapshot(waiting("a", NOW - 1_000)));

    expect(bar.setShown(false)).toEqual({ show: false });
    expect(trays[0]?.destroyed).toBe(true);
    expect(settings.written).toEqual([{ show: false }]);
    bar.update(snapshot(waiting("a", NOW - 1_000), waiting("b", NOW - 1_000)));
    expect(trays).toHaveLength(1);

    expect(bar.setShown(true)).toEqual({ show: true });
    expect(settings.written).toEqual([{ show: false }, { show: true }]);
    expect(trays).toHaveLength(2);
    expect(trays[1]?.title).toBe("2");
    expect(trays[1]?.image).toBe("lit");
    expect(bar.status()).toEqual({ show: true });
  });

  test("on twice makes one item, and off with none is nothing to do", () => {
    const { bar, trays } = setUp();
    bar.start();
    bar.setShown(true);
    expect(trays).toHaveLength(1);
    bar.setShown(false);
    bar.setShown(false);
    expect(trays[0]?.destroyed).toBe(true);
  });

  test("an item that could not be made is said in the log, and the switch reads off", () => {
    const { bar, warn, settings } = setUp({
      makeTray: () => {
        throw new Error("no menu bar");
      },
    });
    bar.start();
    bar.update(snapshot(waiting("a", NOW - 1_000)));
    expect(warn).toHaveBeenCalledWith("The menu bar item could not be shown: Error: no menu bar");
    expect(bar.status()).toEqual({ show: false });

    // Turned on again, it is tried again, and the choice is kept for the next start.
    expect(bar.setShown(true)).toEqual({ show: false });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(settings.written).toEqual([{ show: true }]);
    expect(bar.setShown(false)).toEqual({ show: false });
  });

  test("an item made at the second try reads on", () => {
    let tries = 0;
    const { bar } = setUp({
      makeTray: (image) => {
        tries += 1;
        if (tries === 1) throw new Error("no menu bar yet");
        return new FakeTray(image);
      },
    });
    bar.start();
    expect(bar.status()).toEqual({ show: false });
    expect(bar.setShown(true)).toEqual({ show: true });
    expect(bar.status()).toEqual({ show: true });
  });

  test("stopping takes the item away without changing the switch", () => {
    const { bar, trays, settings } = setUp();
    bar.start();
    bar.stop();
    expect(trays[0]?.destroyed).toBe(true);
    expect(settings.written).toEqual([]);
    expect(bar.status()).toEqual({ show: true });
  });
});

describe("Deny and Allow in the menu", () => {
  const REQUEST_ID = ASK_ID;

  function held(command: string, requestId = REQUEST_ID): Session {
    return waiting("checkout-flow", NOW - 60_000, { ask: heldAsk(command, requestId) });
  }

  test("a press takes the moment the menu, or the submenu it is in, was last shown", () => {
    const { bar, tray, actions, tick } = setUp();
    bar.start();
    bar.update(snapshot(held("npm test")));
    const menu = tray()?.menu as FakeMenu;
    menu.open();
    tick(5_000);
    const submenu = menu.openSubmenu("checkout-flow");
    tick(300);
    submenu.click("Allow");
    expect(actions.answer).toHaveBeenCalledWith({
      sessionId: "claude-code:checkout-flow",
      name: "checkout-flow",
      requestId: REQUEST_ID,
      decision: "allow",
      shownAt: NOW + 5_000,
    });
  });

  test("a submenu's own opening counts, should Electron not tell the top menu of it", () => {
    const { bar, tray, actions, tick } = setUp();
    bar.start();
    bar.update(snapshot(held("npm test")));
    const menu = tray()?.menu as FakeMenu;
    menu.open();
    tick(2_000);
    const submenu = menu.items[1]?.submenu as FakeMenu;
    submenu.open();
    submenu.click("Deny");
    expect(actions.answer).toHaveBeenCalledWith(expect.objectContaining({ shownAt: NOW + 2_000 }));
  });

  test("a menu never shown sends no moment, and a menu made again has its own", () => {
    const { bar, tray, actions, tick } = setUp();
    bar.start();
    bar.update(snapshot(held("npm test")));
    const first = tray()?.menu as FakeMenu;
    first.open();
    first.close();
    tick(1_000);
    bar.update(snapshot(held("npm test", "f".repeat(32))));
    const second = tray()?.menu as FakeMenu;
    expect(second).not.toBe(first);
    (second.items[1]?.submenu as FakeMenu).click("Deny");
    expect(actions.answer).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId: "f".repeat(32), shownAt: null }),
    );
  });

  test("the line of the last press is shown, and the menu is made again for it", () => {
    const { bar, tray } = setUp();
    bar.start();
    bar.update(snapshot(held("npm test")));
    const before = tray()?.menu;
    bar.update({ ...snapshot(), note: "checkout-flow: Allowed from Agent Lookout." });
    expect(tray()?.menu).not.toBe(before);
    expect(tray()?.menu?.labels.slice(0, 2)).toEqual([
      "Nothing needs you",
      "checkout-flow: Allowed from Agent Lookout.",
    ]);
  });

  test("reopen makes the menu afresh and opens it, but leaves one that is open alone", () => {
    const { bar, tray } = setUp();
    bar.reopen();
    bar.start();
    const menu = tray()?.menu as FakeMenu;
    menu.open();
    bar.reopen();
    expect(tray()?.told).not.toContain("pop up");
    menu.close();
    bar.reopen();
    expect(tray()?.menu).not.toBe(menu);
    expect(tray()?.told.at(-1)).toBe("pop up");
  });
});
