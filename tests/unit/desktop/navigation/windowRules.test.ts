import { EventEmitter } from "node:events";

import type { WebContents } from "electron";
import { describe, expect, test, vi } from "vitest";

import { APP_START_URL } from "@core/appAddress";
import { guardNavigation, type OpenExternal } from "@desktop/navigation/windowRules";

/** A navigation as Electron hands it to a listener, which may stop it. */
function navigation(url: string, isMainFrame = true) {
  return { url, isMainFrame, preventDefault: vi.fn() };
}

type WindowOpenHandler = (details: { url: string }) => { action: string };

/**
 * A stand-in for a window's page: an emitter for its events, and the window
 * open handler it was given.
 */
class FakeContents extends EventEmitter {
  windowOpen: WindowOpenHandler | null = null;

  setWindowOpenHandler(handler: WindowOpenHandler): void {
    this.windowOpen = handler;
  }
}

function guarded() {
  const contents = new FakeContents();
  const opened: string[] = [];
  const openExternal: OpenExternal = async (url) => {
    opened.push(url);
  };
  guardNavigation(contents as unknown as WebContents, openExternal);
  return { contents, opened };
}

describe("the window's page", () => {
  test("may go to the app's own pages", () => {
    const { contents, opened } = guarded();
    for (const event of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
      const to = navigation(`${APP_START_URL}#settings`, event !== "will-frame-navigate");
      contents.emit(event, to);
      expect(to.preventDefault, event).not.toHaveBeenCalled();
    }
    expect(opened).toEqual([]);
  });

  test("never leaves them, and only a link that may leave the app reaches the system", () => {
    const { contents, opened } = guarded();
    for (const url of [
      "https://github.com/Olanetsoft/agent-lookout",
      "http://example.com/",
      "file:///Applications/",
      "javascript:alert(1)",
      "agent-lookout://other/",
      "https://user:secret@example.com/",
    ]) {
      const to = navigation(url);
      contents.emit("will-navigate", to);
      expect(to.preventDefault, url).toHaveBeenCalledOnce();
    }
    expect(opened).toEqual(["https://github.com/Olanetsoft/agent-lookout"]);
  });

  test("opens no window, and a link it opens in one reaches the system only when it may leave the app", () => {
    const { contents, opened } = guarded();
    expect(contents.windowOpen).not.toBeNull();
    for (const url of [
      "https://example.com/docs",
      APP_START_URL,
      "file:///etc/hosts",
      "vscode://file/x",
      "about:blank",
    ]) {
      expect(contents.windowOpen?.({ url }), url).toEqual({ action: "deny" });
    }
    expect(opened).toEqual(["https://example.com/docs"]);
  });

  test("a system that cannot open the link changes nothing", async () => {
    const contents = new FakeContents();
    const openExternal = vi.fn<OpenExternal>(async () => {
      throw new Error("no app opens that");
    });
    guardNavigation(contents as unknown as WebContents, openExternal);
    const to = navigation("https://example.com/");
    expect(() => contents.emit("will-navigate", to)).not.toThrow();
    expect(to.preventDefault).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith("https://example.com/");
  });

  test("is not redirected away from the app's pages, and no frame in it leaves them", () => {
    const { contents, opened } = guarded();

    const redirect = navigation("https://example.com/");
    contents.emit("will-redirect", redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();

    const frame = navigation("https://example.com/", false);
    contents.emit("will-frame-navigate", frame);
    expect(frame.preventDefault).toHaveBeenCalledOnce();

    // The main frame's own navigation is will-navigate's to decide.
    const main = navigation("https://example.com/", true);
    contents.emit("will-frame-navigate", main);
    expect(main.preventDefault).not.toHaveBeenCalled();

    // Neither a redirect nor a frame is ever handed to the system.
    expect(opened).toEqual([]);
  });

  test("may attach no webview", () => {
    const { contents } = guarded();
    const attach = { preventDefault: vi.fn() };
    contents.emit("will-attach-webview", attach);
    expect(attach.preventDefault).toHaveBeenCalledOnce();
  });
});
