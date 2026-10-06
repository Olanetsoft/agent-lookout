import type { IncomingMessage, ServerResponse } from "node:http";

import { expect, test, vi } from "vitest";

import { createAppRoutes } from "@desktop/protocol/appRoutes";

function route(url: string | undefined) {
  const update = vi.fn();
  const menuBar = vi.fn();
  const req = { url } as IncomingMessage;
  const res = {} as ServerResponse;
  createAppRoutes({ update, menuBar })(req, res);
  return { update, menuBar, req, res };
}

test.each(["/api/app/menu-bar", "/api/app/menu-bar/setting", "/api/app/menu-bar?x=1"])(
  "%s goes to the menu bar's routes",
  (url) => {
    const { update, menuBar, req, res } = route(url);
    expect(menuBar).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(update).not.toHaveBeenCalled();
  },
);

test.each([
  "/api/app/update",
  "/api/app/update/check",
  "/api/app",
  "/api/app/menu-barn",
  "/api/app/other",
  undefined,
])("%s goes to the updates' routes, which answer what is not theirs with a 404", (url) => {
  const { update, menuBar } = route(url);
  expect(update).toHaveBeenCalledOnce();
  expect(menuBar).not.toHaveBeenCalled();
});
