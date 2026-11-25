import { EventEmitter } from "node:events";

import { afterEach, expect, test, vi } from "vitest";

import { createMainWindow } from "@desktop/window/mainWindow";
import { tempDir } from "@tests/support/node/tempFiles";

// Electron's parts, so no window is opened.
vi.mock("electron", () => ({
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      reload: vi.fn(),
      setWindowOpenHandler: () => {},
    });
    isDestroyed = () => false;
    isMaximized = () => false;
    show = () => {};
    loadURL = async () => {};
  },
  Menu: {},
  screen: { getAllDisplays: () => [] },
  shell: {},
}));

const START = 1_700_000_600_000;

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(process, "getSystemVersion");
});

test("a page whose process dies is loaded again, not more than every ten seconds, and at once after the clock is set back", async () => {
  // Electron gives its main process this, and Node has none.
  Object.assign(process, { getSystemVersion: () => "15.0" });
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  const window = createMainWindow({ userDataDir: await tempDir(), devTools: false });
  const reload = vi.mocked(window.webContents.reload);
  const dies = () => window.webContents.emit("render-process-gone", {}, { reason: "crashed" });

  dies();
  expect(reload).toHaveBeenCalledTimes(1);
  vi.setSystemTime(START + 9_999);
  dies();
  expect(reload).toHaveBeenCalledTimes(1);

  vi.setSystemTime(START - 60 * 60_000);
  dies();
  expect(reload).toHaveBeenCalledTimes(2);
  dies();
  expect(reload).toHaveBeenCalledTimes(2);
  window.emit("closed");
});
