import { expect, test, vi } from "vitest";

import { createDockBadge, dockBadgeText } from "@desktop/notifications/dockBadge";
import type { SessionStatus } from "@core/sessions/session";

const sessions = (...statuses: SessionStatus[]) => statuses.map((status) => ({ status }));

test("the badge counts the sessions that need you, and says nothing at zero", () => {
  expect(dockBadgeText(sessions())).toBe("");
  expect(dockBadgeText(sessions("working", "idle", "finished", "failed"))).toBe("");
  expect(dockBadgeText(sessions("needs-you"))).toBe("1");
  expect(dockBadgeText(sessions("needs-you", "working", "needs-you", "needs-you"))).toBe("3");
});

test("the Dock is told only when the badge changes", () => {
  const setBadge = vi.fn<(text: string) => void>();
  const show = createDockBadge(setBadge);

  show({ sessions: sessions("working") });
  show({ sessions: sessions("needs-you", "working") });
  show({ sessions: sessions("working", "needs-you") });
  show({ sessions: sessions("needs-you", "needs-you") });
  show({ sessions: sessions() });

  expect(setBadge.mock.calls.map(([text]) => text)).toEqual(["1", "2", ""]);
});

test("a badge the Dock refused is tried again on the next snapshot", () => {
  const setBadge = vi.fn<(text: string) => void>().mockImplementationOnce(() => {
    throw new Error("no Dock");
  });
  const show = createDockBadge(setBadge);

  expect(() => show({ sessions: sessions("needs-you") })).toThrow("no Dock");
  show({ sessions: sessions("needs-you") });

  expect(setBadge.mock.calls.map(([text]) => text)).toEqual(["1", "1"]);
});
