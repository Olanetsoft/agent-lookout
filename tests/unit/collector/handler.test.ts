import type { IncomingMessage } from "node:http";

import { describe, expect, test } from "vitest";

import {
  isApiPath,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  notificationsSaid,
} from "@collector/handler";

describe("the helpers", () => {
  test("isLoopbackHostHeader", () => {
    expect(isLoopbackHostHeader("localhost:5173")).toBe(true);
    expect(isLoopbackHostHeader("[::1]:5173")).toBe(true);
    expect(isLoopbackHostHeader(undefined)).toBe(false);
    expect(isLoopbackHostHeader("localhost:5173\nX-Injected: 1")).toBe(false);
    expect(isLoopbackHostHeader("localhost:123456")).toBe(false);
  });

  test("isLoopbackOrigin", () => {
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackOrigin("http://localhost:5173/")).toBe(false);
    expect(isLoopbackOrigin("ftp://localhost")).toBe(false);
    expect(isLoopbackOrigin("localhost:5173")).toBe(false);
  });

  test("isApiPath tells a host which requests to hand over", () => {
    expect(isApiPath("/api/sessions")).toBe(true);
    expect(isApiPath("/api/events?since=1")).toBe(true);
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/api?x=1")).toBe(true);
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isApiPath("/assets/api/index.js")).toBe(false);
    expect(isApiPath("/index.html?next=/api/sessions")).toBe(false);
    expect(isApiPath(undefined)).toBe(false);
  });

  test("notificationsSaid reads the events from the header, and nothing else", () => {
    // Node gives header names in lower case, and repeats of this one joined by a comma.
    const said = (value?: string | string[]) =>
      notificationsSaid({
        headers: value === undefined ? {} : { "x-agent-lookout-notifications": value },
      } as unknown as IncomingMessage);

    // On alone is a wait alone, as a page said before the events could be chosen.
    expect(said("on")).toEqual(["needs-you"]);
    expect(said(" On ")).toEqual(["needs-you"]);
    expect(said("off")).toEqual([]);
    expect(said("on; events=needs-you,finished")).toEqual(["needs-you", "finished"]);
    expect(said("on; events=ended")).toEqual(["ended"]);
    expect(said()).toBeNull();
    expect(said("")).toBeNull();
    expect(said("yes")).toBeNull();
    expect(said("on, off")).toBeNull();
    expect(said(["on", "off"])).toBeNull();
    // A header sent twice arrives joined by a comma, and says nothing.
    expect(said("on; events=finished, off")).toBeNull();
    expect(said("on; events=finished, on; events=failed")).toBeNull();
  });
});
