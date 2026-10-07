import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { expect, onTestFinished, test as anyTest, vi } from "vitest";

import { ALLOW_OUTPUT, DENY_OUTPUT, type StatusReader } from "@collector/answers/heldAsks";
import { createRegistryStatus } from "@collector/answers/registryStatus";
import { createCollector, type Collector } from "@collector/collector";
import type { EventsResponse } from "@core/api";
import { ANSWER_SETTLE_MS } from "@core/answers/settle";
import { createDesktopAnswers } from "@desktop/answers/desktopAnswers";
import { createMenuBar, type MenuBar } from "@desktop/menu-bar/menuBar";
import { menuBarActions } from "@desktop/menu-bar/menuBarActions";
import {
  createDesktopNotifier,
  type DesktopNotifier,
} from "@desktop/notifications/desktopNotifier";
import { ids, registryFile } from "@tests/fixtures/claudeCode";
import {
  FakeMenu,
  FakeTray,
  fakeNotifications,
  type FakeNotification,
} from "@tests/support/desktop/electronStandIns";
import { listen, request } from "@tests/support/node/http";
import { runPermissionHook, type HookRun } from "@tests/support/plugins/permissionHook";
import { startStandIn, type StandIn } from "@tests/support/node/standIns";
import { makeClaudeHome, NO_SETTINGS_FILE, tempDir } from "@tests/support/node/tempFiles";

// Answering is for macOS and Linux: the plugin's hook is a POSIX sh script, and
// it reaches Agent Lookout through a Unix socket. Windows has neither.
const test = anyTest.skipIf(process.platform === "win32");

// Allow and Deny from the Mac app's own notification and its menu bar, from
// end to end: the collector as the app builds it, with its real Claude Code
// adapter reading a registry folder of the test's own and its real socket in a
// folder of the test's own, the plugin's own hook script sending a request to
// it, and the app's notifier, answers and menu bar wired as `main.ts` wires
// them, over stand-ins for Electron's notifications and its menu bar. The
// session is a stand-in process; no Claude Code is run, and nothing is shown.

const SESSION_ID = `claude-code:${ids.busy}`;

function entryFor(standIn: Pick<StandIn, "pid" | "procStart">, status: string) {
  const now = Date.now();
  return registryFile({
    pid: standIn.pid,
    sessionId: ids.busy,
    name: "checkout-flow",
    kind: "interactive",
    entrypoint: "cli",
    procStart: standIn.procStart,
    status,
    ...(status === "waiting" && { waitingFor: "permission prompt" }),
    startedAt: now - 60_000,
    statusUpdatedAt: now - 1_000,
  });
}

/**
 * The app over one session, working until the test says it waits. The
 * collector polls only when asked, keeps its own clock, and shows its own
 * notifications for a wait, as with no window open. The app's notifier,
 * answers and menu bar keep a clock the test moves ahead.
 */
async function app(env: Record<string, string> = {}) {
  const standIn = await startStandIn();
  const file = `${standIn.pid}.json`;
  const claudeHome = await makeClaudeHome({ [file]: entryFor(standIn, "busy") });
  const socketPath = path.join(await tempDir(), "al", "answer.sock");
  let ahead = 0;
  const now = () => Date.now() + ahead;
  let locked = false;
  const notifications = fakeNotifications();
  const trays: FakeTray<string>[] = [];
  const opened: (string | undefined)[] = [];
  let reads = 0;
  let registry: StatusReader | null = null;

  // As `main.ts` makes them: the answers first, which reach the rest late.
  let collector: Collector | null = null;
  let notifier: DesktopNotifier | null = null;
  let bar: MenuBar | null = null;
  const answers = createDesktopAnswers({
    collector: () => collector,
    locked: () => locked,
    tell: (notice, sessionId) => notifier?.tell(notice, sessionId),
    menuChanged: (refused) => {
      if (collector !== null) bar?.update(answers.forMenu(collector.poller.getSnapshot()));
      if (refused) bar?.reopen();
    },
    now,
  });
  const shown = createDesktopNotifier({
    notifications,
    onClick: (sessionId) => opened.push(sessionId),
    answers,
    now,
  });
  notifier = shown;
  const tray = createMenuBar({
    icons: { quiet: "quiet", lit: "lit" },
    makeTray: (image) => {
      const made = new FakeTray(image);
      trays.push(made);
      return made;
    },
    buildMenu: (template) => new FakeMenu(template),
    actions: menuBarActions({
      showWindow: (address) => opened.push(address),
      activate: () => {},
      checkForUpdates: () => {},
      openSettings: () => {},
      answer: (press) => void answers.press({ ...press, from: "menu" }),
      quit: () => {},
    }),
    settings: { read: () => ({ show: true }), write: () => {} },
    now,
  });
  bar = tray;
  const built = createCollector({
    version: "9.9.9-test",
    env: {
      AGENT_LOOKOUT_HISTORY: "off",
      AGENT_LOOKOUT_SETTINGS_FILE: NO_SETTINGS_FILE,
      AGENT_LOOKOUT_CLAUDE_HOME: claudeHome,
      AGENT_LOOKOUT_CODEX_HOME: await tempDir(),
      AGENT_LOOKOUT_STATUS_DIR: await tempDir(),
      AGENT_LOOKOUT_TMUX: "off",
      AGENT_LOOKOUT_TERMINAL_JUMP: "off",
      AGENT_LOOKOUT_NOTIFICATIONS: "on",
      AGENT_LOOKOUT_ANSWER_SOCKET: socketPath,
      ...env,
    },
    notifier: shown,
    intervalMs: 60 * 60_000,
    answering: {
      // The registry as the collector reads it, counting the reads, so a test
      // knows a request has reached the socket.
      status: {
        async statusOf(sessionId) {
          const reading = await (registry as StatusReader).statusOf(sessionId);
          reads += 1;
          return reading;
        },
      },
    },
    onSnapshot: (snapshot) => {
      answers.follow(snapshot, (served, menu) => {
        shown.observe(served);
        tray.update(menu);
      });
    },
  });
  collector = built;
  registry = createRegistryStatus({
    snapshot: () => built.poller.getSnapshot(),
    env: { AGENT_LOOKOUT_CLAUDE_HOME: claudeHome },
  });
  tray.start();
  built.start();
  await built.answering.start();
  onTestFinished(() => {
    built.stop();
    tray.stop();
  });
  await built.poller.pollOnce();
  const port = await listen(createServer(built.handler));

  const rewrite = async (status: string) => {
    const target = path.join(claudeHome, "sessions", file);
    await writeFile(`${target}.tmp`, entryFor(standIn, status));
    await rename(`${target}.tmp`, target);
  };

  return {
    collector: built,
    notifications,
    opened,
    menu: () => trays.at(-1)?.menu as FakeMenu,
    tray: () => trays.at(-1) as FakeTray<string>,
    forward: (ms: number) => {
      ahead += ms;
    },
    lock: (value: boolean) => {
      locked = value;
    },
    rewrite,
    /** Opens the menu, and the session's submenu once the menu offers it. */
    async submenu(): Promise<FakeMenu> {
      await vi.waitFor(() => expect(trays.at(-1)?.menu?.hasSubmenu("checkout-flow")).toBe(true));
      const menu = trays.at(-1)?.menu as FakeMenu;
      menu.open();
      return menu.openSubmenu("checkout-flow");
    },
    /** The Events log, as the page reads it. */
    events: async () => (await request(port, "/api/events")).json<EventsResponse>().events,
    /**
     * Claude Code asks: the hook sends its request, and once it has reached
     * the socket, the session's file says it waits and a poll reads it. It
     * hands back what the hook prints, once it has an answer.
     */
    async asks(
      toolName = "Bash",
      toolInput: unknown = { command: "npm test" },
    ): Promise<{ answered: Promise<HookRun> }> {
      const answered = runPermissionHook(socketPath, { sessionId: ids.busy, toolName, toolInput });
      await vi.waitFor(() => expect(reads).toBeGreaterThan(0), { timeout: 5_000 });
      await rewrite("waiting");
      await vi.waitFor(
        async () => {
          await built.poller.pollOnce();
          const session = built.poller.getSnapshot().sessions.find((s) => s.id === SESSION_ID);
          expect(session?.status).toBe("needs-you");
        },
        { timeout: 5_000, interval: 50 },
      );
      return { answered };
    },
  };
}

/** The notification of the wait, once it has been made. */
async function waitNotice(notifications: { made: FakeNotification[] }): Promise<FakeNotification> {
  return vi.waitFor(
    () => {
      const made = notifications.made.find((notice) => notice.options.subtitle !== undefined);
      expect(made).toBeDefined();
      return made as FakeNotification;
    },
    { timeout: 5_000 },
  );
}

test("Allow on the notification, once it has been shown a second, reaches the hook, and the Events log has it as an answer by Agent Lookout", async () => {
  const shown = await app();
  const { answered } = await shown.asks();
  const notice = await waitNotice(shown.notifications);
  expect(notice.options).toMatchObject({
    title: "checkout-flow",
    subtitle: "Asks to run",
    body: "npm test",
  });
  expect(notice.buttons).toEqual(["Deny", "Allow"]);

  shown.forward(ANSWER_SETTLE_MS);
  notice.press("Allow");
  expect(await answered).toEqual({ code: 0, stdout: `${ALLOW_OUTPUT}\n` });
  await vi.waitFor(async () =>
    expect((await shown.events()).find((event) => event.kind === "answered")).toMatchObject({
      sessionId: SESSION_ID,
      decision: "allow",
      by: "agent-lookout",
    }),
  );
  // An answer says nothing more, and the event holds nothing of what was asked.
  expect(shown.notifications.made).toHaveLength(1);
  expect(JSON.stringify(await shown.events())).not.toContain("npm test");

  notice.click();
  expect(shown.opened).toEqual([SESSION_ID]);
});

test("a press in the first second sends nothing and a notification says so; the request is still held, and Deny in the menu answers it", async () => {
  const shown = await app();
  const { answered } = await shown.asks();
  const notice = await waitNotice(shown.notifications);
  notice.press("Allow");
  await vi.waitFor(() => expect(shown.notifications.made).toHaveLength(2));
  expect(shown.notifications.made[1]?.options).toEqual({
    title: "checkout-flow",
    body: "It was pressed in the first second it was shown, so nothing was sent.",
  });
  expect(shown.notifications.made[1]?.buttons).toEqual([]);

  // The menu lists the session, with what it asks in its submenu.
  const submenu = await shown.submenu();
  expect(submenu.labels).toEqual([
    "Open Details",
    "-",
    "Asks to run",
    "npm test",
    "-",
    "Deny",
    "Allow",
  ]);
  shown.forward(ANSWER_SETTLE_MS);
  submenu.click("Deny");
  expect(await answered).toEqual({ code: 0, stdout: `${DENY_OUTPUT}\n` });
  await vi.waitFor(() =>
    expect(shown.menu().labels[1]).toBe(
      "checkout-flow: Denied from Agent Lookout. Claude carries on without it.",
    ),
  );
  expect((await shown.events()).filter((event) => event.kind === "answered")).toEqual([
    expect.objectContaining({ decision: "deny", by: "agent-lookout" }),
  ]);
});

test("a press in the menu's first second sends nothing, and the menu opens again to say so", async () => {
  const shown = await app();
  await shown.asks();
  (await shown.submenu()).click("Allow");
  await vi.waitFor(() => expect(shown.tray().told.at(-1)).toBe("pop up"));
  expect(shown.menu().labels[1]).toBe(
    "checkout-flow: It was pressed in the first second it was shown, so nothing was sent.",
  );
  expect((await shown.events()).some((event) => event.kind === "answered")).toBe(false);
});

test("a request answered in the session meanwhile is refused, and the menu says nothing was sent", async () => {
  const shown = await app();
  const { answered } = await shown.asks();
  const submenu = await shown.submenu();
  // As a Yes in the terminal does: the file no longer says it waits, and the request is let go.
  await shown.rewrite("busy");
  expect(await answered).toEqual({ code: 0, stdout: "" });
  shown.forward(ANSWER_SETTLE_MS);
  submenu.click("Allow");
  await vi.waitFor(() => expect(shown.tray().told.at(-1)).toBe("pop up"));
  expect(shown.menu().labels[1]).toMatch(/^checkout-flow: .*so nothing was sent\.$/);
  expect((await shown.events()).some((event) => event.kind === "answered")).toBe(false);
});

test("nothing is answered while the Mac is locked, and a notification says why", async () => {
  const shown = await app();
  const { answered } = await shown.asks();
  const notice = await waitNotice(shown.notifications);
  shown.lock(true);
  shown.forward(ANSWER_SETTLE_MS);
  notice.press("Allow");
  await vi.waitFor(() => expect(shown.notifications.made).toHaveLength(2));
  expect(shown.notifications.made[1]?.options.body).toBe(
    "Nothing is answered while this Mac is locked, so nothing was sent.",
  );
  // Still held: unlocked, the menu answers it.
  shown.lock(false);
  const submenu = await shown.submenu();
  shown.forward(ANSWER_SETTLE_MS);
  submenu.click("Allow");
  expect(await answered).toEqual({ code: 0, stdout: `${ALLOW_OUTPUT}\n` });
});

test("an edit offers Deny alone in the notification and the menu, and Deny answers it", async () => {
  const shown = await app();
  const { answered } = await shown.asks("Write", {
    file_path: "/Users/example/code/demo/a.ts",
    content: "export {};",
  });
  const notice = await waitNotice(shown.notifications);
  expect(notice.buttons).toEqual(["Deny"]);
  expect(notice.options.body).not.toContain("export {}");
  const submenu = await shown.submenu();
  expect(submenu.labels).not.toContain("Allow");
  shown.forward(ANSWER_SETTLE_MS);
  notice.press("Deny");
  expect(await answered).toEqual({ code: 0, stdout: `${DENY_OUTPUT}\n` });
});

test("a command too long for a notification offers Deny alone there, and Allow in the menu, which shows it whole", async () => {
  const shown = await app();
  const command = "npm test\nnpm run build";
  const { answered } = await shown.asks("Bash", { command });
  const notice = await waitNotice(shown.notifications);
  expect(notice.buttons).toEqual(["Deny"]);
  expect(notice.options.body).toMatch(/^To allow it, open Agent Lookout/);
  const submenu = await shown.submenu();
  expect(submenu.labels.slice(2, 5)).toEqual(["Asks to run", "npm test", "npm run build"]);
  shown.forward(ANSWER_SETTLE_MS);
  submenu.click("Allow");
  expect(await answered).toEqual({ code: 0, stdout: `${ALLOW_OUTPUT}\n` });
});

test("with AGENT_LOOKOUT_ANSWER off, a wait's notification has no buttons and the menu lists it with no submenu", async () => {
  const shown = await app({ AGENT_LOOKOUT_ANSWER: "off" });
  await shown.rewrite("waiting");
  await vi.waitFor(
    async () => {
      await shown.collector.poller.pollOnce();
      expect(shown.notifications.made).toHaveLength(1);
    },
    { timeout: 5_000, interval: 50 },
  );
  expect(shown.notifications.made[0]?.buttons).toEqual([]);
  expect(shown.notifications.made[0]?.options).toEqual({
    title: "checkout-flow",
    body: "Waiting for permission",
  });
  const item = shown.menu().template[1];
  expect(item?.label).toMatch(/^checkout-flow/);
  expect(item?.submenu).toBeUndefined();
});
