import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, test, vi } from "vitest";

import { shownAsk } from "@collector/answers/shownAsk";
import type { Session, SourceState } from "@core/sessions/session";
import {
  MAX_MENU_DETAIL_LENGTH,
  MAX_MENU_NAME_LENGTH,
  MAX_MENU_SESSIONS,
  MAX_MENU_TELLING_LENGTH,
  menuBarHasTimes,
  menuBarHeadline,
  menuBarKey,
  menuBarTemplate,
  menuBarTitle,
  menuBarToolTip,
  waitingSessions,
  type MenuBarActions,
  type MenuBarPress,
  type MenuBarSnapshot,
} from "@desktop/menu-bar/menuBarMenu";
import { makeSession } from "@tests/fixtures/session";

const NOW = 1_700_000_600_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function waiting(name: string, waitedMs: number | null, more: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${name}`,
    name,
    status: "needs-you",
    waitingReason: "permission",
    statusSince: waitedMs === null ? null : NOW - waitedMs,
    ...more,
  });
}

const SOURCE_LABEL = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "status-files": "Status files",
};

function snapshot(sessions: Session[], states: SourceState[] = ["ok"]): MenuBarSnapshot {
  const ids = ["claude-code", "codex", "status-files"] as const;
  return {
    sessions,
    sources: states.map((state, index) => {
      const id = ids[index % ids.length] ?? "claude-code";
      return { id, label: SOURCE_LABEL[id], state };
    }),
  };
}

/** Both agents, read. */
const BOTH: SourceState[] = ["ok", "ok"];

function actions() {
  return {
    openSession: vi.fn<(sessionId: string) => void>(),
    answer: vi.fn<(press: MenuBarPress) => void>(),
    openApp: vi.fn<() => void>(),
    checkForUpdates: vi.fn<() => void>(),
    openSettings: vi.fn<() => void>(),
    quit: vi.fn<() => void>(),
  } satisfies MenuBarActions;
}

/** Each item by its label, or a dash for a separator. */
const labels = (template: MenuItemConstructorOptions[]) =>
  template.map((item) => (item.type === "separator" ? "-" : item.label));

/** Clicks a menu item as Electron would. */
function click(item: MenuItemConstructorOptions | undefined): void {
  (item?.click as (() => void) | undefined)?.();
}

describe("the count beside the icon", () => {
  test("is the number of sessions that need you, and nothing at zero", () => {
    expect(menuBarTitle(null)).toBe("");
    expect(menuBarTitle(snapshot([]))).toBe("");
    expect(menuBarTitle(snapshot([makeSession({ status: "working" })]))).toBe("");
    expect(menuBarTitle(snapshot([waiting("a", MINUTE)]))).toBe("1");
    expect(
      menuBarTitle(
        snapshot([
          waiting("a", MINUTE),
          makeSession({ id: "codex:1", status: "idle" }),
          waiting("b", SECOND),
          waiting("c", null),
        ]),
      ),
    ).toBe("3");
  });

  test("leaves out a prompt already answered, by a press or a rule, while Claude Code's file still says it waits", () => {
    const answered = waiting("answered-one", MINUTE, { answered: true });
    expect(menuBarTitle(snapshot([answered]))).toBe("");
    expect(menuBarToolTip(snapshot([answered]))).toBe("Agent Lookout");
    expect(menuBarTitle(snapshot([answered, waiting("a", SECOND)]))).toBe("1");
    expect(menuBarToolTip(snapshot([answered, waiting("a", SECOND)]))).toBe(
      "Agent Lookout: 1 session needs you",
    );
  });

  test("is said in the tooltip too", () => {
    expect(menuBarToolTip(null)).toBe("Agent Lookout");
    expect(menuBarToolTip(snapshot([]))).toBe("Agent Lookout");
    expect(menuBarToolTip(snapshot([waiting("a", MINUTE)]))).toBe(
      "Agent Lookout: 1 session needs you",
    );
    expect(menuBarToolTip(snapshot([waiting("a", MINUTE), waiting("b", MINUTE)]))).toBe(
      "Agent Lookout: 2 sessions need you",
    );
  });
});

describe("the menu's first line", () => {
  test("counts the sessions that need you", () => {
    expect(menuBarHeadline(snapshot([waiting("a", MINUTE)]))).toBe("1 session needs you");
    expect(menuBarHeadline(snapshot([waiting("a", MINUTE), waiting("b", 0)]))).toBe(
      "2 sessions need you",
    );
  });

  test("says Nothing needs you once something was counted, and only then", () => {
    expect(menuBarHeadline(snapshot([]))).toBe("Nothing needs you");
    expect(menuBarHeadline(snapshot([makeSession()], ["searching"]))).toBe("Nothing needs you");
    // Before the first poll, or while every agent is still being looked for, nothing was counted.
    expect(menuBarHeadline(null)).toBe("Looking for agents…");
    expect(menuBarHeadline(snapshot([], ["searching", "unavailable"]))).toBe("Looking for agents…");
    expect(menuBarHeadline(snapshot([], ["error", "unavailable", "not-set-up"]))).toBe(
      "No agent tool could be read",
    );
  });
});

describe("the menu", () => {
  test("lists the sessions that need you, the longest wait first, with how long each has waited", () => {
    const template = menuBarTemplate(
      snapshot([
        waiting("billing-webhooks", 63 * SECOND),
        makeSession({ id: "codex:1", name: "docs-site", status: "working" }),
        waiting("checkout-flow", 4 * MINUTE + 12 * SECOND, {
          waitingReason: "question",
          waitingText: "Which region should it use?",
        }),
        waiting("no-start", null, { waitingReason: undefined }),
        waiting("search-index", 2 * 60 * MINUTE + 5 * MINUTE),
      ]),
      NOW,
      actions(),
    );
    expect(labels(template)).toEqual([
      "4 sessions need you",
      "search-index · 2h 05m",
      "checkout-flow · 4m 12s",
      "billing-webhooks · 1m 03s",
      "no-start",
      "-",
      "Open Agent Lookout",
      "Check for Updates…",
      "Settings…",
      "-",
      "Quit Agent Lookout",
    ]);
    // The first line says where things stand, and is not something to choose.
    expect(template[0]?.enabled).toBe(false);
    // Under each name, the reason, and what it is asking when that is known.
    expect(template.slice(1, 5).map((item) => item.sublabel)).toEqual([
      "Waiting for permission",
      "Asked you a question: Which region should it use?",
      "Waiting for permission",
      "Waiting for you",
    ]);
  });

  test("lists no session whose prompt was answered, and with only such, says Nothing needs you", () => {
    const answered = waiting("answered-one", 2 * MINUTE, { answered: true });
    const only = menuBarTemplate(snapshot([answered]), NOW, actions());
    expect(labels(only)[0]).toBe("Nothing needs you");
    expect(labels(only).join(" ")).not.toContain("answered-one");

    const both = menuBarTemplate(
      snapshot([answered, waiting("billing-webhooks", 63 * SECOND)]),
      NOW,
      actions(),
    );
    expect(labels(both).slice(0, 2)).toEqual(["1 session needs you", "billing-webhooks · 1m 03s"]);
    expect(labels(both).join(" ")).not.toContain("answered-one");
    // What the menu shows changes once the answer is taken, so it is made again.
    expect(menuBarKey(snapshot([answered]))).not.toBe(
      menuBarKey(snapshot([waiting("answered-one", 2 * MINUTE)])),
    );
  });

  test("with nothing waiting, says so, and has the app's own items", () => {
    const template = menuBarTemplate(snapshot([makeSession({ status: "idle" })]), NOW, actions());
    expect(labels(template)).toEqual([
      "Nothing needs you",
      "-",
      "Open Agent Lookout",
      "Check for Updates…",
      "Settings…",
      "-",
      "Quit Agent Lookout",
    ]);
  });

  test("before the first poll, says it is looking, and lists nothing", () => {
    expect(labels(menuBarTemplate(null, NOW, actions())).slice(0, 2)).toEqual([
      "Looking for agents…",
      "-",
    ]);
  });

  test("cuts a long name, and the line under it, and keeps the whole of what it is asking for the tooltip", () => {
    const name = "a-session-with-a-name-far-longer-than-the-menu-has-room-for";
    const asking = `Run: npm run test -- --reporter=verbose ${"packages/".repeat(8)}`;
    const [, item] = menuBarTemplate(
      snapshot([waiting(name, 42 * SECOND, { waitingText: asking })]),
      NOW,
      actions(),
    );

    const [shownName, waited] = (item?.label ?? "").split(" · ");
    expect(Array.from(shownName ?? "")).toHaveLength(MAX_MENU_NAME_LENGTH);
    expect(shownName?.endsWith("…")).toBe(true);
    expect(name.startsWith(shownName?.slice(0, -1) ?? "")).toBe(true);
    expect(waited).toBe("42s");

    expect(Array.from(item?.sublabel ?? "").length).toBeLessThanOrEqual(MAX_MENU_DETAIL_LENGTH);
    expect(item?.sublabel?.startsWith("Waiting for permission: Run: npm run test")).toBe(true);
    expect(item?.sublabel?.endsWith("…")).toBe(true);
    expect(item?.toolTip).toBe(`Waiting for permission: ${asking}`);
  });

  test("puts a name that runs over lines on one line, and names a session with no name by its folder", () => {
    const template = menuBarTemplate(
      snapshot([
        waiting("first line\nsecond line", 5 * SECOND),
        waiting("   ", 4 * SECOND, { project: "demo" }),
      ]),
      NOW,
      actions(),
    );
    expect(labels(template).slice(1, 3)).toEqual(["first line second line · 5s", "demo · 4s"]);
  });

  test(`lists at most ${MAX_MENU_SESSIONS}, and counts the rest`, () => {
    const many = Array.from({ length: MAX_MENU_SESSIONS + 3 }, (_, index) =>
      waiting(`session-${String(index).padStart(2, "0")}`, (100 - index) * SECOND),
    );
    const template = menuBarTemplate(snapshot(many), NOW, actions());
    expect(template[0]?.label).toBe("13 sessions need you");
    expect(template[1]?.label).toBe("session-00 · 1m 40s");
    expect(template[MAX_MENU_SESSIONS]?.label).toBe("session-09 · 1m 31s");
    expect(template[MAX_MENU_SESSIONS + 1]).toEqual({ label: "And 3 more", enabled: false });
    expect(template[MAX_MENU_SESSIONS + 2]?.type).toBe("separator");
  });

  test("choosing a session opens it, and each of the app's items does its own thing", () => {
    const did = actions();
    const template = menuBarTemplate(
      snapshot([waiting("checkout-flow", MINUTE), waiting("billing-webhooks", SECOND)]),
      NOW,
      did,
    );
    const item = (label: string) => template.find((entry) => entry.label?.startsWith(label));

    click(item("billing-webhooks"));
    expect(did.openSession).toHaveBeenCalledExactlyOnceWith("claude-code:billing-webhooks");
    click(item("Open Agent Lookout"));
    expect(did.openApp).toHaveBeenCalledOnce();
    click(item("Check for Updates…"));
    expect(did.checkForUpdates).toHaveBeenCalledOnce();
    click(item("Settings…"));
    expect(did.openSettings).toHaveBeenCalledOnce();
    click(item("Quit Agent Lookout"));
    expect(did.quit).toHaveBeenCalledOnce();
    expect(did.openSession).toHaveBeenCalledOnce();
  });

  test("tells two sessions of one name apart by their agent", () => {
    const template = menuBarTemplate(
      snapshot(
        [
          waiting("checkout-flow", 4 * MINUTE),
          waiting("checkout-flow", MINUTE, { id: "codex:1", source: "codex" }),
          waiting("billing-webhooks", SECOND),
        ],
        BOTH,
      ),
      NOW,
      actions(),
    );
    expect(labels(template).slice(1, 4)).toEqual([
      "checkout-flow (Claude Code) · 4m 00s",
      "checkout-flow (Codex) · 1m 00s",
      "billing-webhooks · 1s",
    ]);
  });

  test("of one agent, by their project, then their branch, then their app", () => {
    const one = (more: Partial<Session>[]) =>
      labels(
        menuBarTemplate(
          snapshot(
            more.map((fields, index) =>
              waiting("checkout-flow", (index + 1) * MINUTE, {
                id: `claude-code:${index}`,
                ...fields,
              }),
            ),
          ),
          NOW,
          actions(),
        ),
      ).slice(1, more.length + 1);

    expect(one([{ project: "storefront" }, { project: "admin" }])).toEqual([
      "checkout-flow (admin) · 2m 00s",
      "checkout-flow (storefront) · 1m 00s",
    ]);
    expect(
      one([
        { git: { branch: "main" } },
        { git: { branch: "fix/tax" } },
        { git: { commit: "a1b2c3d" } },
      ]),
    ).toEqual([
      "checkout-flow (a1b2c3d) · 3m 00s",
      "checkout-flow (fix/tax) · 2m 00s",
      "checkout-flow (main) · 1m 00s",
    ]);
    expect(one([{ surface: "terminal" }, { surface: "vscode" }])).toEqual([
      "checkout-flow (VS Code) · 2m 00s",
      "checkout-flow (Terminal) · 1m 00s",
    ]);
  });

  test("names agents by the rule the page uses, cuts what tells them apart, and leaves alike what nothing does", () => {
    const agent = "An agent whose own name runs far past the room in brackets";
    const told = labels(
      menuBarTemplate(
        snapshot(
          [
            waiting("nightly", 2 * MINUTE, { id: "status-files:1", source: "status-files", agent }),
            waiting("nightly", MINUTE),
          ],
          ["ok", "ok", "ok"],
        ),
        NOW,
        actions(),
      ),
    );
    const bracketed = /\((.*)\)/.exec(told[1] ?? "")?.[1] ?? "";
    expect(Array.from(bracketed)).toHaveLength(MAX_MENU_TELLING_LENGTH);
    expect(bracketed.endsWith("…")).toBe(true);
    expect(told[2]).toBe("nightly (Claude Code) · 1m 00s");

    const alike = labels(
      menuBarTemplate(
        snapshot([waiting("same", 2 * MINUTE), waiting("same", MINUTE, { id: "claude-code:2" })]),
        NOW,
        actions(),
      ),
    );
    expect(alike.slice(1, 3)).toEqual(["same · 2m 00s", "same · 1m 00s"]);
  });

  test("a wait whose start is a moment ahead of the clock reads as no time at all", () => {
    const [, item] = menuBarTemplate(snapshot([waiting("ahead", -5 * SECOND)]), NOW, actions());
    expect(item?.label).toBe("ahead · 0s");
  });
});

describe("what the menu shows apart from its times", () => {
  test("is the same for the same sessions, whatever the moment", () => {
    const sessions = [waiting("checkout-flow", MINUTE), makeSession({ status: "working" })];
    expect(menuBarKey(snapshot(sessions))).toBe(menuBarKey(snapshot([...sessions])));
    expect(menuBarKey(null)).toBe(menuBarKey(null));
  });

  test("changes with the headline, a session, its wait, its reason and what it is asking", () => {
    const base = waiting("checkout-flow", MINUTE);
    const key = menuBarKey(snapshot([base]));
    for (const changed of [
      snapshot([]),
      snapshot([{ ...base, id: "claude-code:other" }]),
      snapshot([{ ...base, statusSince: NOW }]),
      snapshot([{ ...base, waitingReason: "question" }]),
      snapshot([{ ...base, waitingText: "Run: npm test" }]),
      snapshot([base, waiting("docs", SECOND)]),
    ]) {
      expect(menuBarKey(changed)).not.toBe(key);
    }
    const many = Array.from({ length: MAX_MENU_SESSIONS + 1 }, (_, index) =>
      waiting(`s-${index}`, (100 - index) * SECOND),
    );
    expect(menuBarKey(snapshot([...many, waiting("last", SECOND)]))).not.toBe(
      menuBarKey(snapshot(many)),
    );
    expect(menuBarKey(snapshot([], ["searching"]))).not.toBe(menuBarKey(snapshot([])));
  });

  test("has times only while a listed session's wait has a known start", () => {
    expect(menuBarHasTimes(null)).toBe(false);
    expect(menuBarHasTimes(snapshot([makeSession({ status: "working" })]))).toBe(false);
    expect(menuBarHasTimes(snapshot([waiting("no-start", null)]))).toBe(false);
    expect(menuBarHasTimes(snapshot([waiting("a", MINUTE)]))).toBe(true);
  });
});

test("the sessions that need you are ordered as the Needs you panel orders them", () => {
  const sessions = [
    waiting("b", MINUTE),
    waiting("unknown-start", null),
    waiting("a", MINUTE),
    waiting("longest", 2 * MINUTE),
    makeSession({ id: "codex:9", status: "working" }),
  ];
  expect(waitingSessions(sessions).map((session) => session.name)).toEqual([
    "longest",
    "a",
    "b",
    "unknown-start",
  ]);
});

describe("a session whose permission request is held", () => {
  const REQUEST_ID = "0123456789abcdef0123456789abcdef";

  /** A held request, made by the collector's own rule for what is shown. */
  function ask(tool: string, input: Record<string, unknown>, requestId = REQUEST_ID) {
    const shown = shownAsk(tool, input);
    if (shown === null) throw new Error(`${tool} is not held`);
    return { requestId, ...shown, until: NOW + 5 * MINUTE };
  }

  const asking = (held: ReturnType<typeof ask>) => waiting("checkout-flow", MINUTE, { ask: held });

  function submenuOf(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
    const submenu = template[1]?.submenu;
    if (!Array.isArray(submenu)) throw new Error("The session has no submenu.");
    return submenu;
  }

  test("opens a submenu: Open Details, what it asks a line each, then Deny and Allow", () => {
    const template = menuBarTemplate(
      snapshot([asking(ask("Bash", { command: "npm test\nnpm run build" }))]),
      NOW,
      actions(),
    );
    expect(template[1]).toMatchObject({ label: "checkout-flow · 1m 00s" });
    expect(template[1]?.click).toBeUndefined();
    const submenu = submenuOf(template);
    expect(labels(submenu)).toEqual([
      "Open Details",
      "-",
      "Asks to run",
      "npm test",
      "npm run build",
      "-",
      "Deny",
      "Allow",
    ]);
    // What it asks is there to be read, and does nothing when chosen.
    expect(submenu.slice(2, 5).every((item) => item.enabled === false)).toBe(true);
  });

  test("its other inputs come after a separator, apart from the command's lines", () => {
    const withInput = submenuOf(
      menuBarTemplate(
        snapshot([asking(ask("Bash", { command: "npm test", dangerouslyDisableSandbox: true }))]),
        NOW,
        actions(),
      ),
    );
    expect(labels(withInput)).toEqual([
      "Open Details",
      "-",
      "Asks to run",
      "npm test",
      "-",
      "dangerouslyDisableSandbox: true",
      "-",
      "Deny",
      "Allow",
    ]);
    const twoLines = submenuOf(
      menuBarTemplate(
        snapshot([asking(ask("Bash", { command: "npm test\ndangerouslyDisableSandbox: true" }))]),
        NOW,
        actions(),
      ),
    );
    expect(labels(twoLines)).toEqual([
      "Open Details",
      "-",
      "Asks to run",
      "npm test",
      "dangerouslyDisableSandbox: true",
      "-",
      "Deny",
      "Allow",
    ]);
    // A tool with no command has its inputs under its heading.
    const fetch = submenuOf(
      menuBarTemplate(
        snapshot([asking(ask("WebFetch", { url: "https://example.com" }))]),
        NOW,
        actions(),
      ),
    );
    expect(labels(fetch).slice(2, 5)).toEqual([
      "Asks to use WebFetch",
      "url: https://example.com",
      "-",
    ]);
  });

  test("Deny and Allow name the session, the request and when the menu was shown; Open Details opens it", () => {
    const chosen = actions();
    let shownAt: number | null = null;
    const template = menuBarTemplate(
      snapshot([asking(ask("Bash", { command: "npm test" }))]),
      NOW,
      chosen,
      () => shownAt,
    );
    const submenu = submenuOf(template);
    const find = (label: string) => submenu.find((item) => item.label === label);
    click(find("Deny"));
    shownAt = NOW - 3 * SECOND;
    click(find("Allow"));
    expect(chosen.answer.mock.calls.map(([press]) => press)).toEqual([
      {
        sessionId: "claude-code:checkout-flow",
        name: "checkout-flow",
        requestId: REQUEST_ID,
        decision: "deny",
        shownAt: null,
      },
      {
        sessionId: "claude-code:checkout-flow",
        name: "checkout-flow",
        requestId: REQUEST_ID,
        decision: "allow",
        shownAt: NOW - 3 * SECOND,
      },
    ]);
    click(find("Open Details"));
    expect(chosen.openSession).toHaveBeenCalledWith("claude-code:checkout-flow");
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["Write", { file_path: "/Users/example/code/demo/a.ts", content: "x" }, "Asks to use Write"],
    ["ExitPlanMode", { plan: "Do it" }, "Asks to use ExitPlanMode"],
    ["Bash", { command: "ls ..." }, "Asks to run"],
  ])("offers Deny alone for %s it cannot allow from here, and says why", (tool, input, heading) => {
    const submenu = submenuOf(
      menuBarTemplate(snapshot([asking(ask(tool, input))]), NOW, actions()),
    );
    expect(submenu[2]?.label).toBe(heading);
    expect(labels(submenu)).toContain("Deny");
    expect(labels(submenu)).not.toContain("Allow");
    const note = submenu.at(-3);
    expect(note?.enabled).toBe(false);
    expect(note?.label).toMatch(/only Deny|Answer in the session|open Agent Lookout/);
  });

  test("an & in what it asks is written so the menu draws it", () => {
    const submenu = submenuOf(
      menuBarTemplate(snapshot([asking(ask("Bash", { command: "a && b" }))]), NOW, actions()),
    );
    expect(submenu[3]?.label).toBe("a &&&& b");
  });

  test("the menu is made again for a newer request, and with what the last press came to", () => {
    const first = snapshot([asking(ask("Bash", { command: "npm test" }))]);
    const newer = snapshot([asking(ask("Bash", { command: "npm test" }, "f".repeat(32)))]);
    expect(menuBarKey(newer)).not.toBe(menuBarKey(first));
    expect(menuBarKey({ ...first, note: "checkout-flow: Allowed from Agent Lookout." })).not.toBe(
      menuBarKey(first),
    );
  });

  test("what the last press came to is the line under the headline, which does nothing", () => {
    const template = menuBarTemplate(
      {
        ...snapshot([]),
        note: "checkout-flow: That request is no longer held, so nothing was sent.",
      },
      NOW,
      actions(),
    );
    expect(template[1]).toEqual({
      label: "checkout-flow: That request is no longer held, so nothing was sent.",
      enabled: false,
    });
  });
});
