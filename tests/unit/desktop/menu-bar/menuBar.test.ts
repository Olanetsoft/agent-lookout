import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, test, vi } from "vitest";

import type { Session } from "@core/sessions/session";
import {
  createMenuBar,
  MENU_TIMES_MAX_AGE_MS,
  type MenuBarTrayLike,
} from "@desktop/menu-bar/menuBar";
import type { MenuBarActions, MenuBarSnapshot } from "@desktop/menu-bar/menuBarMenu";
import type { MenuBarSettings, MenuBarSettingsStore } from "@desktop/menu-bar/menuBarSettings";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;

type Image = "quiet" | "lit";

/** A menu as `Menu.buildFromTemplate` makes it, which a test can open and close. */
class FakeMenu {
  private readonly listeners = new Map<string, () => void>();
  constructor(readonly template: MenuItemConstructorOptions[]) {}
  on(event: "menu-will-show" | "menu-will-close", listener: () => void): this {
    this.listeners.set(event, listener);
    return this;
  }
  open(): void {
    this.listeners.get("menu-will-show")?.();
  }
  close(): void {
    this.listeners.get("menu-will-close")?.();
  }
  get labels(): (string | undefined)[] {
    return this.template.map((item) => (item.type === "separator" ? "-" : item.label));
  }
}

/** The item in the menu bar, as `new Tray(image)` makes it, writing down what it is told. */
class FakeTray implements MenuBarTrayLike<Image, FakeMenu> {
  image: Image;
  title = "";
  toolTip = "";
  menu: FakeMenu | null = null;
  destroyed = false;
  told: string[] = [];
  private pointerOver: (() => void) | null = null;
  constructor(image: Image) {
    this.image = image;
  }
  setImage(image: Image): void {
    this.told.push(`image ${image}`);
    this.image = image;
  }
  setTitle(title: string, options?: { fontType?: string }): void {
    this.told.push(`title "${title}" ${options?.fontType}`);
    this.title = title;
  }
  setToolTip(toolTip: string): void {
    this.told.push(`tooltip "${toolTip}"`);
    this.toolTip = toolTip;
  }
  setContextMenu(menu: FakeMenu | null): void {
    this.told.push("menu");
    this.menu = menu;
  }
  on(_event: "mouse-enter", listener: () => void): this {
    this.pointerOver = listener;
    return this;
  }
  hover(): void {
    this.pointerOver?.();
  }
  destroy(): void {
    this.destroyed = true;
  }
}

function memorySettings(show = true): MenuBarSettingsStore & { written: MenuBarSettings[] } {
  const written: MenuBarSettings[] = [];
  return {
    written,
    read: () => written.at(-1) ?? { show },
    write: (settings) => void written.push(settings),
  };
}

function setUp(options: { show?: boolean; makeTray?: (image: Image) => FakeTray } = {}) {
  const trays: FakeTray[] = [];
  const pending: (() => void)[] = [];
  let now = NOW;
  const actions: MenuBarActions = {
    openSession: vi.fn(),
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
