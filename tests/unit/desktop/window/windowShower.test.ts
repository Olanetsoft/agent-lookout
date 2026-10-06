import { expect, test, vi } from "vitest";

import { createWindowShower, type ShowableWindow } from "@desktop/window/windowShower";

/** A window that writes down what it was told, and can be closed as a person closes it. */
function fakeWindow(minimized = false) {
  let closed: (() => void) | null = null;
  let destroyed = false;
  const told: string[] = [];
  const window: ShowableWindow & { told: string[]; close: () => void } = {
    told,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    restore: () => void told.push("restore"),
    show: () => void told.push("show"),
    focus: () => void told.push("focus"),
    loadURL: async (url) => void told.push(`load ${url}`),
    on: (_event, listener) => {
      closed = listener;
    },
    close: () => {
      destroyed = true;
      closed?.();
    },
  };
  return window;
}

function setUp(ready = true) {
  const made: ReturnType<typeof fakeWindow>[] = [];
  const create = vi.fn((_address: string | undefined) => {
    const window = fakeWindow();
    made.push(window);
    return window;
  });
  return { shower: createWindowShower({ ready: () => ready, create }), create, made };
}

test("makes the window at the address asked for when there is none", () => {
  const { shower, create } = setUp();
  shower.show("agent-lookout://app/#settings");
  expect(create).toHaveBeenCalledExactlyOnceWith("agent-lookout://app/#settings");
  expect(shower.current()).not.toBeNull();
});

test("brings the window there forward, at the address asked for", () => {
  const { shower, create, made } = setUp();
  shower.show();
  shower.show("agent-lookout://app/#settings");
  expect(create).toHaveBeenCalledOnce();
  expect(made[0]?.told).toEqual(["load agent-lookout://app/#settings", "show", "focus"]);
});

test("with no address, the window keeps its page", () => {
  const { shower, made } = setUp();
  shower.show();
  shower.show();
  expect(made[0]?.told).toEqual(["show", "focus"]);
});

test("a minimized window is restored", () => {
  const window = fakeWindow(true);
  const shower = createWindowShower({ ready: () => true, create: () => window });
  shower.show();
  shower.show();
  expect(window.told).toEqual(["restore", "show", "focus"]);
});

test("a window that was closed is made again", () => {
  const { shower, create, made } = setUp();
  shower.show();
  made[0]?.close();
  expect(shower.current()).toBeNull();
  shower.show("agent-lookout://app/#overview");
  expect(create).toHaveBeenCalledTimes(2);
  expect(create).toHaveBeenLastCalledWith("agent-lookout://app/#overview");
  expect(shower.current()).toBe(made[1]);
});

test("before the app is ready, nothing is made", () => {
  const { shower, create } = setUp(false);
  shower.show();
  expect(create).not.toHaveBeenCalled();
  expect(shower.current()).toBeNull();
});
