// Stand-ins for the notification system. Neither shows anything or asks anybody.
//
// `fakeNotificationHost` is for tests of everything that sits behind
// `setNotificationHost`: it writes down what it was asked to do, and answers a
// request for permission the way the test says the person would. Like a
// browser, it keeps one notification for each tag. It has no DOM in it, so unit
// tests can use it.
//
// `StubNotification` is for tests of the dashboard's own host and of the app
// over it: it takes the place of the browser's `window.Notification`, so it
// needs a page.

import type {
  NotificationContent,
  NotificationHost,
  NotificationPermissionState,
} from "@dashboard/lib/notificationHost";

/** One notification the fake was asked to show. */
export interface FakeNotification extends NotificationContent {
  /** How many times the page closed it. */
  closes: number;
  /**
   * Whether it is still on show: not closed by the page, not dismissed by the
   * person, and not replaced by a later one with the same tag.
   */
  open: boolean;
  /** The person dismisses it. */
  dismiss(): void;
}

export interface FakeNotificationHost extends NotificationHost {
  /** The permission as it stands. A test can set it, as a person can in a browser's settings. */
  state: NotificationPermissionState;
  /** What the person answers when asked. */
  answer: NotificationPermissionState;
  /** How many times permission was asked for. */
  asked: number;
  /** Everything it was asked to show, in order, open or not. */
  shown: FakeNotification[];
  /** What `show` does next: show it, return null, or throw. Goes back to "show" after one use. */
  next: "show" | "refuse" | "throw";
  /** Those still on show. */
  open(): FakeNotification[];
}

export function fakeNotificationHost(
  options: {
    permission?: NotificationPermissionState;
    answer?: NotificationPermissionState;
  } = {},
): FakeNotificationHost {
  const host: FakeNotificationHost = {
    state: options.permission ?? "default",
    answer: options.answer ?? "granted",
    asked: 0,
    shown: [],
    next: "show",

    permission: () => host.state,

    async requestPermission() {
      host.asked += 1;
      if (host.state === "default") host.state = host.answer;
      return host.state;
    },

    show(content) {
      const outcome = host.next;
      host.next = "show";
      if (outcome === "throw") throw new Error("The fake host was told to throw.");
      if (outcome === "refuse") return null;

      // As in a browser, one notification per tag: the new one takes the place
      // of one still on show, whoever made that, and its maker hears it go.
      for (const earlier of host.shown) {
        if (earlier.open && earlier.tag === content.tag) earlier.dismiss();
      }

      const listeners: (() => void)[] = [];
      const gone = () => {
        if (!notification.open) return;
        notification.open = false;
        for (const listener of listeners) listener();
      };
      const notification: FakeNotification = {
        ...content,
        closes: 0,
        open: true,
        dismiss: gone,
      };
      host.shown.push(notification);
      return {
        close() {
          notification.closes += 1;
          // As in a browser, the page closing one is heard the same way.
          gone();
        },
        onClosed(listener) {
          listeners.push(listener);
        },
      };
    },

    open: () => host.shown.filter((notification) => notification.open),
  };
  return host;
}

/**
 * A stand-in for the browser's own Notifications API, put where
 * `window.Notification` is with `installStubNotification`. It writes down every
 * question asked of it and every notification made of it, and shows nothing.
 */
export class StubNotification extends EventTarget {
  /** What the browser says it allows. A test can set it, as a person can in the browser's settings. */
  static permission: string = "default";
  /** What the person answers when asked. */
  static answer: string = "granted";
  /** How many times permission was asked for. */
  static asked = 0;
  /** Every notification made, in order. */
  static made: StubNotification[] = [];
  /** Makes the constructor throw, as it does in a browser that only allows a service worker to. */
  static refuses = false;

  static requestPermission(): Promise<string> {
    StubNotification.asked += 1;
    StubNotification.permission = StubNotification.answer;
    return Promise.resolve(StubNotification.permission);
  }

  /** As a browser that has not been asked, whose person would say yes, and that has made nothing. */
  static reset(): void {
    StubNotification.permission = "default";
    StubNotification.answer = "granted";
    StubNotification.asked = 0;
    StubNotification.made = [];
    StubNotification.refuses = false;
  }

  readonly title: string;
  readonly options: NotificationOptions | undefined;
  /** When it was made, by `performance.now()`. */
  readonly madeAt = performance.now();
  /** When the page first closed it, by the same clock. Null while it has not. */
  closedAt: number | null = null;
  /** How many times the page closed it. */
  closes = 0;

  constructor(title: string, options?: NotificationOptions) {
    super();
    if (StubNotification.refuses) throw new TypeError("Illegal constructor.");
    this.title = title;
    this.options = options;
    StubNotification.made.push(this);
  }

  close(): void {
    this.closes += 1;
    this.closedAt ??= performance.now();
    this.dispatchEvent(new Event("close"));
  }
}

/**
 * Puts a fresh `StubNotification` where the browser's Notifications API is, and
 * returns what puts the browser's own back.
 */
export function installStubNotification(): () => void {
  const real = Object.getOwnPropertyDescriptor(window, "Notification");
  StubNotification.reset();
  Object.defineProperty(window, "Notification", {
    value: StubNotification,
    configurable: true,
    writable: true,
  });
  return () => {
    if (real) Object.defineProperty(window, "Notification", real);
    else Reflect.deleteProperty(window, "Notification");
  };
}
