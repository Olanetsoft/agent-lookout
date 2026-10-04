import { describe, expect, test } from "vitest";

import { isApiPath, isLoopbackHostHeader, isLoopbackOrigin } from "@collector/handler";

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
});
