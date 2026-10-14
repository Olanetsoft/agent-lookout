import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { PluginInstallStatus, PluginInstallStep } from "@core/answers/pluginInstall";
import { PluginNotice } from "@dashboard/components/dashboard/PluginNotice";
import { resetPluginInstallForTests } from "@dashboard/hooks/app/usePluginInstall";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

/**
 * The app is a stand-in: what it answers is the test's own, and no request
 * leaves the page.
 */
let asked: string[];
let fetchStatus: ReturnType<typeof vi.fn<() => Promise<PluginInstallStatus | null>>>;
let markTold: ReturnType<typeof vi.fn<() => Promise<PluginInstallStatus | null>>>;

const INSTALLED = "Agent Lookout installed its Claude Code plugin";
const FAILED = "Agent Lookout could not install its Claude Code plugin";

beforeEach(() => {
  resetPluginInstallForTests();
  asked = [];
  setApiHost(async (path) => {
    asked.push(path);
    throw new TypeError("Failed to fetch");
  });
  fetchStatus = vi.fn(async () => ({ state: "installed" }) as const);
  markTold = vi.fn(async () => ({ state: "idle" }) as const);
});

afterEach(async () => {
  setApiHost();
  await page.viewport(414, 896);
});

/** The note as the Overview draws it in the app's window, inside the view. */
function inTheApp() {
  return render(
    <main tabIndex={-1} aria-label='Overview'>
      <PluginNotice inApp fetchStatus={fetchStatus} markTold={markTold} pollMs={20} />
    </main>,
  );
}

type Screen = Awaited<ReturnType<typeof render>>;

const noticeIn = (screen: Screen) =>
  screen.container.querySelector<HTMLElement>('[data-slot="plugin-notice"]');

const commandsIn = (screen: Screen) =>
  [...screen.container.querySelectorAll<HTMLElement>('[data-part="command"]')].map(
    (command) => command.textContent,
  );

/** The words of the note, line by line: its title, then what it says. */
const linesIn = (screen: Screen) =>
  [...(noticeIn(screen)?.querySelectorAll("p") ?? [])].map((line) => line.textContent);

test("once installed, it says so, what it means and how to remove it, in a quiet note", async () => {
  const screen = await inTheApp();
  await expect.element(screen.getByText(INSTALLED, { exact: true })).toBeVisible();

  expect(linesIn(screen)).toEqual([
    INSTALLED,
    "Allow and Deny on Claude Code's permission prompts now work from here. A new Claude Code session picks it up. To remove it, run this in a terminal:",
  ]);
  expect(commandsIn(screen)).toEqual(["claude plugin uninstall agent-lookout@agent-lookout"]);
  const callout = noticeIn(screen)?.querySelector<HTMLElement>('[data-slot="callout"]');
  expect(callout?.dataset.tone).toBe("info");
  // It can appear after the page has loaded, so a screen reader is told of it.
  expect(callout?.getAttribute("role")).toBe("status");
  expect(getComputedStyle(callout!).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
  await pointAway();
  expect(warmPaint(screen.container)).toEqual([]);
  expect(fetchStatus).toHaveBeenCalledOnce();
  expect(markTold).not.toHaveBeenCalled();
});

test.each<[PluginInstallStep, string]>([
  ["check", "It could not tell whether the plugin is installed, so it changed nothing."],
  ["unfinished", "The app quit before the install finished."],
  ["marketplace", "Claude Code did not install it."],
  ["install", "Claude Code did not install it."],
  // The list after the install did not name the plugin, or did not run: either way, unconfirmed.
  ["confirm", "It could not confirm that Claude Code installed it."],
])(
  "when it could not, at %s, it says so plainly, with the two commands that install it",
  async (step, first) => {
    fetchStatus = vi.fn(async () => ({ state: "failed", step }) as const);
    const screen = await inTheApp();
    await expect.element(screen.getByText(FAILED, { exact: true })).toBeVisible();

    expect(linesIn(screen)).toEqual([
      FAILED,
      `${first} To answer Claude Code's permission prompts from here, run these two commands in a terminal:`,
    ]);
    expect(commandsIn(screen)).toEqual([
      "claude plugin marketplace add Olanetsoft/agent-lookout",
      "claude plugin install agent-lookout@agent-lookout",
    ]);
    const callout = noticeIn(screen)?.querySelector<HTMLElement>('[data-slot="callout"]');
    // A failure to install is not a session that needs the person: quiet, and nothing warm.
    expect(callout?.dataset.tone).toBe("info");
    await pointAway();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("Dismiss hides it at once, tells the app once, and keeps focus in the view", async () => {
  const screen = await inTheApp();
  await expect.element(screen.getByText(INSTALLED, { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Dismiss" }).click();

  expect(noticeIn(screen)).toBeNull();
  expect(markTold).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByRole("main").element());
});

test("a dismissal the app never heard still hides it", async () => {
  markTold = vi.fn(async () => null);
  const screen = await inTheApp();
  await expect.element(screen.getByText(INSTALLED, { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Dismiss" }).click();
  expect(noticeIn(screen)).toBeNull();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(noticeIn(screen)).toBeNull();
});

test("a dismissal the app never heard stays hidden when the Overview is drawn again", async () => {
  markTold = vi.fn(async () => null);
  const first = await inTheApp();
  await expect.element(first.getByText(INSTALLED, { exact: true })).toBeVisible();
  await first.getByRole("button", { name: "Dismiss" }).click();
  await first.unmount();

  // The app still says it, since it never heard the dismissal.
  const again = await inTheApp();
  await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledTimes(2));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(noticeIn(again)).toBeNull();
  expect(markTold).toHaveBeenCalledOnce();
});

test("while the install is under way it draws nothing, asks again, and says what came of it once it ends", async () => {
  const answers: PluginInstallStatus[] = [
    { state: "running" },
    { state: "running" },
    { state: "installed" },
  ];
  fetchStatus = vi.fn(async () => answers.shift() ?? { state: "installed" });
  const screen = await inTheApp();

  expect(noticeIn(screen)).toBeNull();
  await expect.element(screen.getByText(INSTALLED, { exact: true })).toBeVisible();
  expect(fetchStatus).toHaveBeenCalledTimes(3);
  // Once it has ended, it is not asked again.
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fetchStatus).toHaveBeenCalledTimes(3);
});

test.each<[string, PluginInstallStatus | null]>([
  ["nothing to say", { state: "idle" }],
  ["no answer", null],
])("with %s it draws nothing, and is not asked again", async (_what, answer) => {
  fetchStatus = vi.fn(async () => answer);
  const screen = await inTheApp();
  await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fetchStatus).toHaveBeenCalledOnce();
  expect(noticeIn(screen)).toBeNull();
  expect(screen.container.textContent).toBe("");
});

test("drawn away while the install is under way, it asks nothing more", async () => {
  fetchStatus = vi.fn(async () => ({ state: "running" }) as const);
  const screen = await inTheApp();
  await vi.waitFor(() => expect(fetchStatus).toHaveBeenCalled());
  await screen.unmount();
  const calls = fetchStatus.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(fetchStatus).toHaveBeenCalledTimes(calls);
});

test("in a browser it is never drawn, and the app is never asked", async () => {
  const screen = await render(
    <PluginNotice inApp={false} fetchStatus={fetchStatus} markTold={markTold} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.container.innerHTML).toBe("");
  expect(fetchStatus).not.toHaveBeenCalled();
  expect(markTold).not.toHaveBeenCalled();
});

test("in a browser by default, as a page served over http is", async () => {
  const screen = await render(<PluginNotice />);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(screen.container.innerHTML).toBe("");
  expect(asked).toEqual([]);
});

test("its Dismiss is reached by Tab, shows the focus ring, and Enter dismisses it", async () => {
  const screen = await inTheApp();
  await expect.element(screen.getByText(INSTALLED, { exact: true })).toBeVisible();
  const dismiss = screen.getByRole("button", { name: "Dismiss" }).element();
  await pointAway();

  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(dismiss);
  const style = getComputedStyle(dismiss);
  expect(style.outlineStyle).toBe("solid");
  expect(style.outlineWidth).toBe("2px");
  expect(style.outlineColor).toBe(rgbOf("var(--focus)"));

  await userEvent.keyboard("{Enter}");
  expect(noticeIn(screen)).toBeNull();
  expect(markTold).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(screen.getByRole("main").element());
});

test("on a phone, its commands break between their words and nothing runs past the note", async () => {
  await page.viewport(375, 812);
  fetchStatus = vi.fn(async () => ({ state: "failed", step: "marketplace" }) as const);
  const screen = await render(
    <main tabIndex={-1} style={{ width: "343px" }}>
      <PluginNotice inApp fetchStatus={fetchStatus} markTold={markTold} />
    </main>,
  );
  await expect.element(screen.getByText(FAILED, { exact: true })).toBeVisible();

  const notice = noticeIn(screen)!;
  const commands = [...notice.querySelectorAll<HTMLElement>('[data-part="command"]')];
  expect(commands).toHaveLength(2);
  const [first, second] = commands.map((command) => command.getBoundingClientRect());
  expect(second!.top).toBeGreaterThanOrEqual(first!.bottom);
  for (const command of commands) {
    expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth);
    expect(command.getBoundingClientRect().right).toBeLessThanOrEqual(
      notice.getBoundingClientRect().right + 0.5,
    );
  }
  expect(notice.scrollWidth).toBeLessThanOrEqual(notice.clientWidth);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
