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

test("a prompt already answered, by a press or a rule, is not counted while Claude Code's file still says it waits", () => {
  const answered = { status: "needs-you" as const, answered: true as const };
  expect(dockBadgeText([answered])).toBe("");
  expect(dockBadgeText([answered, { status: "needs-you" }, { status: "working" }])).toBe("1");

  // The badge goes as the answer is taken, before the session is seen to move on.
  const setBadge = vi.fn<(text: string) => void>();
  const show = createDockBadge(setBadge);
  show({ sessions: [{ status: "needs-you" }] });
  show({ sessions: [answered] });
  show({ sessions: [{ status: "working" }] });
  expect(setBadge.mock.calls.map(([text]) => text)).toEqual(["1", ""]);
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
