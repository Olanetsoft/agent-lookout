import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { AnsweringStatus } from "@core/sessions/session";
import { AnswerCard } from "@dashboard/components/settings/AnswerCard";
import { warmPaint } from "@tests/support/browser/colours";

const ON: AnsweringStatus = { state: "on", plugin: "unknown", holdMs: 300_000 };

async function renderAt(width: 375 | 1280, answering: AnsweringStatus | null) {
  await page.viewport(width, 800);
  return render(
    <div style={{ width: width === 375 ? 343 : 420 }}>
      <AnswerCard answering={answering} />
    </div>,
  );
}

const part = (name: string) => document.querySelector<HTMLElement>(`[data-part="${name}"]`);

test.each([375, 1280] as const)(
  "at %ipx, a permission prompt no request came for says the plugin may not be installed, and how to install it",
  async (width) => {
    const screen = await renderAt(width, { ...ON, plugin: "missed" });
    expect(part("state")?.textContent).toBe(
      "Permission prompts of Claude Code sessions with the plugin can be answered from here.",
    );
    expect(part("plugin")?.textContent).toBe(
      "A Claude Code session asked for permission, but its request did not reach Agent Lookout. The plugin may not be installed for it.",
    );
    const commands = [...document.querySelectorAll<HTMLElement>('[data-part="install-command"]')];
    expect(commands.map((command) => command.textContent)).toEqual([
      "/plugin marketplace add Olanetsoft/agent-lookout",
      "/plugin install agent-lookout@agent-lookout",
    ]);
    const [first, second] = commands.map((command) => command.getBoundingClientRect());
    // Each on a line of its own, and no word of either broken.
    expect(second!.top).toBeGreaterThanOrEqual(first!.bottom);
    for (const command of commands) {
      expect(getComputedStyle(command).fontFamily).toMatch(/Mono/);
      expect(getComputedStyle(command).display).toBe("block");
      expect(getComputedStyle(command).overflowWrap).toBe("break-word");
      expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth);
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("once the plugin's requests arrive, it says how long one is held", async () => {
  await renderAt(1280, { ...ON, plugin: "seen" });
  expect(part("plugin")?.textContent).toBe(
    "Requests from the plugin reach Agent Lookout. Each is held for 5 minutes, and the session's own prompt can still be answered meanwhile. Deny is always offered, and Allow when all of what it allows is shown.",
  );
  expect(part("install")).toBeNull();
});

test("before any permission prompt, it says what answering needs", async () => {
  await renderAt(1280, ON);
  expect(part("plugin")?.textContent).toContain("Answering needs the Agent Lookout plugin");
  expect(document.querySelectorAll('[data-part="install-command"]')).toHaveLength(2);
});

test("off, and not working, are said plainly", async () => {
  await renderAt(1280, { state: "off", plugin: "unknown", holdMs: 300_000 });
  expect(part("state")?.textContent).toBe("Permission prompts are not answered from here.");
  expect(part("plugin")?.textContent).toBe("AGENT_LOOKOUT_ANSWER is off, so no request is held.");
});

test("a problem is given as the collector says it", async () => {
  await renderAt(1280, {
    state: "unavailable",
    plugin: "unknown",
    holdMs: 300_000,
    problem: "Another copy of Agent Lookout answers permission prompts on this computer.",
  });
  expect(part("state")?.textContent).toBe("Permission prompts cannot be answered from here.");
  expect(part("plugin")?.textContent).toBe(
    "Another copy of Agent Lookout answers permission prompts on this computer.",
  );
});

test("before the app has answered, it says nothing", async () => {
  await renderAt(1280, null);
  expect(part("state")?.textContent).toBe("");
  expect(part("plugin")).toBeNull();
});
