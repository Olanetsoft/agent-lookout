import { expect, test } from "vitest";

import { APP_PROTOCOL } from "@core/appAddress";
import { inAppWindow, markAppWindow } from "@dashboard/lib/shell/appWindow";

test("the page knows it is in the Mac app's window from its own address", () => {
  expect(APP_PROTOCOL).toBe("agent-lookout:");
  expect(inAppWindow("agent-lookout:")).toBe(true);
  for (const protocol of ["http:", "https:", "file:", "agent-lookout-other:", ""]) {
    expect(inAppWindow(protocol), protocol).toBe(false);
  }
  // Where there is no page at all, as here in Node, it is not the app.
  expect(inAppWindow()).toBe(false);
});

test("only there is <html> marked for the window's own chrome", () => {
  const inApp = { dataset: {} as DOMStringMap } as HTMLElement;
  markAppWindow(inApp, "agent-lookout:");
  expect(inApp.dataset.host).toBe("app");

  const inTab = { dataset: {} as DOMStringMap } as HTMLElement;
  markAppWindow(inTab, "http:");
  expect(inTab.dataset.host).toBeUndefined();
});
