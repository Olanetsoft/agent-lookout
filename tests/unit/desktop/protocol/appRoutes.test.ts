import type { IncomingMessage, ServerResponse } from "node:http";

import { expect, test, vi } from "vitest";

import { createAppRoutes } from "@desktop/protocol/appRoutes";

function route(url: string | undefined) {
  const update = vi.fn();
  const menuBar = vi.fn();
  const notifications = vi.fn();
  const req = { url } as IncomingMessage;
  const res = {} as ServerResponse;
  createAppRoutes({ update, menuBar, notifications })(req, res);
  return { update, menuBar, notifications, req, res };
}

test.each(["/api/app/menu-bar", "/api/app/menu-bar/setting", "/api/app/menu-bar?x=1"])(
  "%s goes to the menu bar's routes",
  (url) => {
    const { update, menuBar, notifications, req, res } = route(url);
    expect(menuBar).toHaveBeenCalledExactlyOnceWith(req, res);
    expect(update).not.toHaveBeenCalled();
    expect(notifications).not.toHaveBeenCalled();
  },
);

test.each([
  "/api/app/notifications",
  "/api/app/notifications/test",
  "/api/app/notifications/other",
  "/api/app/notifications?x=1",
])("%s goes to the notifications' routes", (url) => {
  const { update, menuBar, notifications, req, res } = route(url);
  expect(notifications).toHaveBeenCalledExactlyOnceWith(req, res);
  expect(update).not.toHaveBeenCalled();
  expect(menuBar).not.toHaveBeenCalled();
});

test.each([
  "/api/app/update",
  "/api/app/update/check",
  "/api/app",
  "/api/app/menu-barn",
  "/api/app/notificationsx",
  "/api/app/other",
  undefined,
])("%s goes to the updates' routes, which answer what is not theirs with a 404", (url) => {
  const { update, menuBar, notifications } = route(url);
  expect(update).toHaveBeenCalledOnce();
  expect(menuBar).not.toHaveBeenCalled();
  expect(notifications).not.toHaveBeenCalled();
});
