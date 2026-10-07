// Stand-ins for the parts of Electron the Mac app's main process hands its
// modules: a notification, the class that makes them, a menu and the item in
// the menu bar. Each writes down what it is told and shows nothing, so no
// test raises a notification or puts an icon in the menu bar of the machine
// it runs on. A test plays the person on them: it clicks a notification or
// presses one of its buttons, and opens a menu, a submenu of it, and clicks
// an item.

import type { MenuItemConstructorOptions, NotificationConstructorOptions } from "electron";

import type { MenuBarTrayLike } from "@desktop/menu-bar/menuBar";
import type { NotificationLike, NotificationMaker } from "@desktop/notifications/desktopNotifier";

type Listener = (...args: never[]) => void;

/** One notification, as `new Notification(options)` makes it. */
export class FakeNotification implements NotificationLike {
  shown = false;
  closed = false;
  private readonly listeners = new Map<string, Listener[]>();
  constructor(readonly options: NotificationConstructorOptions) {}

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  show(): void {
    this.shown = true;
  }
  close(): void {
    this.closed = true;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...given: unknown[]) => void)(...args);
    }
  }
  /** macOS says it is on the screen. */
  appear(): void {
    this.emit("show");
  }
  /** The person clicks it. */
  click(): void {
    this.emit("click");
  }
  /** The person presses one of its buttons, by its label. */
  press(label: string): void {
    const index = (this.options.actions ?? []).findIndex((action) => action.text === label);
    if (index < 0) throw new Error(`The notification has no ${label} button.`);
    this.emit("action", { actionIndex: index }, index);
  }
  /** macOS would not show it. */
  fail(error: string): void {
    this.emit("failed", {}, error);
  }
  /** The labels of its buttons, in order. */
  get buttons(): string[] {
    return (this.options.actions ?? []).map((action) => action.text ?? "");
  }
}

/** Electron's `Notification` class: what it made, in order. */
export function fakeNotifications(
  supported = true,
): NotificationMaker & { made: FakeNotification[] } {
  const made: FakeNotification[] = [];
  return {
    made,
    isSupported: () => supported,
    create(options) {
      const notification = new FakeNotification(options);
      made.push(notification);
      return notification;
    },
  };
}

/**
 * A menu as `Menu.buildFromTemplate` makes it, with a menu of its own for
 * each submenu. Opening a submenu tells the top menu it opens too, as
 * Electron does on macOS.
 */
export class FakeMenu {
  readonly items: { submenu?: FakeMenu }[];
  private readonly listeners = new Map<string, (() => void)[]>();
  constructor(
    readonly template: MenuItemConstructorOptions[],
    private readonly top: FakeMenu | null = null,
  ) {
    this.items = template.map((item) =>
      Array.isArray(item.submenu) ? { submenu: new FakeMenu(item.submenu, top ?? this) } : {},
    );
  }
  on(event: "menu-will-show" | "menu-will-close", listener: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  private emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
  open(): void {
    this.emit("menu-will-show");
  }
  close(): void {
    this.emit("menu-will-close");
  }
  /** Opens the submenu of the item whose label begins with this, and hands it back. */
  openSubmenu(label: string): FakeMenu {
    const index = this.template.findIndex((item) => item.label?.startsWith(label));
    const submenu = this.items[index]?.submenu;
    if (submenu === undefined) throw new Error(`No item ${label} with a submenu.`);
    (this.top ?? this).open();
    submenu.open();
    return submenu;
  }
  /**
   * Clicks the item whose label begins with this, as Electron does: the menu
   * closes, and the item hears its click after.
   */
  click(label: string): void {
    const item = this.template.find((entry) => entry.label?.startsWith(label));
    if (item === undefined) throw new Error(`No item ${label}.`);
    if (item.enabled === false) throw new Error(`${label} cannot be chosen.`);
    (this.top ?? this).close();
    (item.click as (() => void) | undefined)?.();
  }
  /** Whether the item whose label begins with this has a submenu. */
  hasSubmenu(label: string): boolean {
    const index = this.template.findIndex((item) => item.label?.startsWith(label));
    return this.items[index]?.submenu !== undefined;
  }
  get labels(): (string | undefined)[] {
    return this.template.map((item) => (item.type === "separator" ? "-" : item.label));
  }
}

/** The item in the menu bar, as `new Tray(image)` makes it, writing down what it is told. */
export class FakeTray<Image> implements MenuBarTrayLike<Image, FakeMenu> {
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
    this.told.push(`image ${String(image)}`);
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
  popUpContextMenu(): void {
    this.told.push("pop up");
    this.menu?.open();
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
