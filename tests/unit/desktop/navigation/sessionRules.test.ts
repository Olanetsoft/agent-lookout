import { EventEmitter } from "node:events";

import type { Session } from "electron";
import { describe, expect, test, vi } from "vitest";

import { APP_ORIGIN, APP_START_URL } from "@core/appAddress";
import { appOriginOf, applySessionRules, mayUse } from "@desktop/navigation/sessionRules";

test("the app's own page may show notifications", () => {
  expect(mayUse("notifications", APP_ORIGIN)).toBe(true);
});

test("the app's own page may write text to the clipboard, for a button that copies, and never read it", () => {
  expect(mayUse("clipboard-sanitized-write", APP_ORIGIN)).toBe(true);
  expect(mayUse("clipboard-read", APP_ORIGIN)).toBe(false);
});

test("no other origin may, and the page may use nothing else", () => {
  for (const origin of ["https://example.com", "http://127.0.0.1:4777", "null", undefined]) {
    expect(mayUse("notifications", origin), String(origin)).toBe(false);
    expect(mayUse("clipboard-sanitized-write", origin), String(origin)).toBe(false);
  }
  for (const permission of [
    "openExternal",
    "clipboard-read",
    "media",
    "geolocation",
    "fullscreen",
    "hid",
    "serial",
    "usb",
    "unknown",
  ]) {
    expect(mayUse(permission, APP_ORIGIN), permission).toBe(false);
  }
});

test("the app's origin is known however Electron writes it", () => {
  expect(appOriginOf("agent-lookout://app")).toBe(APP_ORIGIN);
  expect(appOriginOf("agent-lookout://app/")).toBe(APP_ORIGIN);
  expect(appOriginOf("agent-lookout://app/#settings")).toBe(APP_ORIGIN);
  for (const other of ["agent-lookout://other/", "https://app/", "null", ""]) {
    expect(appOriginOf(other), other).toBeUndefined();
  }
});

type RequestHandler = (
  contents: unknown,
  permission: string,
  callback: (granted: boolean) => void,
  details: { requestingUrl: string },
) => void;
type CheckHandler = (contents: unknown, permission: string, origin: string) => boolean;
type WebRequestListener = (
  details: { url: string },
  callback: (answer: { cancel?: boolean }) => void,
) => void;

/** A stand-in for the window's session, which keeps every rule it is given. */
class FakeSession extends EventEmitter {
  request: RequestHandler | null = null;
  check: CheckHandler | null = null;
  device: (() => boolean) | null = null;
  filter: { urls: string[] } | null = null;
  beforeRequest: WebRequestListener | null = null;

  setPermissionRequestHandler(handler: RequestHandler): void {
    this.request = handler;
  }

  setPermissionCheckHandler(handler: CheckHandler): void {
    this.check = handler;
  }

  setDevicePermissionHandler(handler: () => boolean): void {
    this.device = handler;
  }

  webRequest = {
    onBeforeRequest: (filter: { urls: string[] }, listener: WebRequestListener) => {
      this.filter = filter;
      this.beforeRequest = listener;
    },
  };
}

function ruled(): FakeSession {
  const session = new FakeSession();
  applySessionRules(session as unknown as Session);
  return session;
}

/** What the session's request handler answers for a permission asked from an address. */
function granted(session: FakeSession, permission: string, requestingUrl: string): boolean {
  const callback = vi.fn<(granted: boolean) => void>();
  session.request?.(null, permission, callback, { requestingUrl });
  expect(callback).toHaveBeenCalledOnce();
  return callback.mock.calls[0]?.[0] as boolean;
}

describe("the window's session", () => {
  test("grants notifications and clipboard writes to the app's own page, and nothing else to anyone", () => {
    const session = ruled();
    expect(granted(session, "notifications", APP_START_URL)).toBe(true);
    expect(granted(session, "notifications", `${APP_ORIGIN}/#settings`)).toBe(true);
    for (const url of ["https://example.com/", "agent-lookout://other/", "file:///", ""]) {
      expect(granted(session, "notifications", url), url).toBe(false);
    }
    for (const permission of ["media", "clipboard-read", "openExternal", "geolocation", "hid"]) {
      expect(granted(session, permission, APP_START_URL), permission).toBe(false);
    }
    expect(granted(session, "clipboard-sanitized-write", APP_START_URL)).toBe(true);
    expect(granted(session, "clipboard-sanitized-write", "https://example.com/")).toBe(false);
  });

  test("says the same when asked whether a permission is held", () => {
    const session = ruled();
    expect(session.check?.(null, "notifications", APP_ORIGIN)).toBe(true);
    expect(session.check?.(null, "notifications", `${APP_ORIGIN}/`)).toBe(true);
    expect(session.check?.(null, "notifications", "https://example.com")).toBe(false);
    expect(session.check?.(null, "clipboard-read", APP_ORIGIN)).toBe(false);
    expect(session.check?.(null, "clipboard-sanitized-write", APP_ORIGIN)).toBe(true);
    expect(session.check?.(null, "clipboard-sanitized-write", "https://example.com")).toBe(false);
  });

  test("lets the page reach no device", () => {
    expect(ruled().device?.()).toBe(false);
  });

  test("cancels every request that would go over the network", () => {
    const session = ruled();
    expect(session.filter).toEqual({ urls: ["*://*/*", "ws://*/*", "wss://*/*"] });
    for (const url of [
      "https://example.com/",
      "http://127.0.0.1:4777/api/sessions",
      "ws://127.0.0.1:5173/",
      "wss://example.com/socket",
    ]) {
      const callback = vi.fn<(answer: { cancel?: boolean }) => void>();
      session.beforeRequest?.({ url }, callback);
      expect(callback, url).toHaveBeenCalledWith({ cancel: true });
    }
  });

  test("refuses every download", () => {
    const session = ruled();
    const download = { preventDefault: vi.fn() };
    session.emit("will-download", download);
    expect(download.preventDefault).toHaveBeenCalledOnce();
  });
});
