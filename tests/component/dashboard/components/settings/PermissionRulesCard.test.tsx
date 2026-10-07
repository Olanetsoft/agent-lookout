import { afterEach, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ACTION_HEADER, type RuleAnswer, type SettingsResponse } from "@core/api";
import type { PermissionRule } from "@core/permission-rules/permissionRules";
import { applyRulesChange, rulesChangeIn } from "@core/permission-rules/rulesChange";
import { DEFAULT_TIME_RULES } from "@core/time-rules/timeRules";
import { PermissionRulesCard } from "@dashboard/components/settings/PermissionRulesCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const NOW = Date.now();

const DENY_PUSH: PermissionRule = {
  id: "aaaaaaaaaaaa",
  decision: "deny",
  tool: "Bash",
  command: "git push --force:*",
};
const ALLOW_TESTS: PermissionRule = {
  id: "bbbbbbbbbbbb",
  decision: "allow",
  tool: "Bash",
  command: "npm test:*",
};
const ASK_ALL: PermissionRule = { id: "cccccccccccc", decision: "ask", tool: "*" };

const ANSWER: RuleAnswer = {
  at: NOW - 60_000,
  sessionId: "claude-code:00000000-0000-4000-8000-000000000001",
  sessionName: "checkout-flow",
  tool: "Bash",
  decision: "allow",
  rule: { decision: "allow", tool: "Bash", command: "npm test:*" },
};

/** The rules as the app holds them, which a change it takes replaces. */
let held: PermissionRule[];
let answers: RuleAnswer[];
/** Each change the card asked for: its action and its body. */
let changes: { action: string | null; body: unknown }[];
let refusing: string | null;
let ids: number;

beforeEach(() => {
  held = [DENY_PUSH, ALLOW_TESTS, ASK_ALL];
  answers = [ANSWER];
  changes = [];
  refusing = null;
  ids = 0;
  setApiHost(async (path, init) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (path === "/api/settings/permission-rules") {
      const body: unknown = JSON.parse(init?.body as string);
      changes.push({ action: new Headers(init?.headers).get(ACTION_HEADER), body });
      if (refusing !== null) return json({ error: refusing, reason: "not-saved" }, 500);
      // The app's own reading of a change, so the card is held to what the app takes.
      const asked = rulesChangeIn(body);
      if (!asked.ok) return json({ error: asked.problem, reason: "invalid" }, 400);
      const made = applyRulesChange(held, asked.change, () =>
        `dddddddddd${(ids += 1)}0`.slice(-12),
      );
      if (!made.ok) return json({ error: made.problem, reason: made.reason }, 409);
      held = made.rules;
      return json({ ok: true, permissionRules: held });
    }
    return json({
      timeRules: DEFAULT_TIME_RULES,
      file: "~/.agent-lookout/settings.json",
      problem: null,
      permissionRules: held,
      permissionRulesProblem: null,
      ruleAnswers: answers,
      ruleAnswersSince: NOW - 3_600_000,
    } satisfies SettingsResponse);
  });
});

afterEach(() => {
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
});

const ON = { state: "on", plugin: "seen", holdMs: 300_000 } as const;
const card = () => page.getByRole("region", { name: "Permission rules" });
const rules = () => card().getByRole("list", { name: "Permission rules, in order" });
const rows = () => [...rules().element().querySelectorAll<HTMLElement>("[data-part='rule']")];
const rowTexts = () => rows().map((row) => row.querySelector("p")?.textContent);
const field = (name: RegExp) => card().getByRole("textbox", { name });
const lastChange = () => changes.at(-1);

async function shown() {
  const screen = await render(<PermissionRulesCard answering={ON} now={NOW} />);
  await expect.element(rules()).toBeVisible();
  return screen;
}

test("lists the rules in their order, each with its decision and the rule as Claude Code writes one, in the mono", async () => {
  await shown();
  expect(rowTexts()).toEqual([
    "DenyBash(git push --force:*)",
    "AllowBash(npm test:*)",
    "AskEvery tool",
  ]);
  const literal = rows()[0]?.querySelector<HTMLElement>("[data-part='rule-text']");
  expect(getComputedStyle(literal as HTMLElement).fontFamily).toMatch(/Mono/);
  await expect.element(card().getByText("deny, then ask, then allow")).toBeVisible();
  // The count beside the title.
  expect(card().element().querySelector("[data-part='count']")?.textContent).toBe("3");
  // An allow rule says plainly what it does.
  expect(card().element().textContent).toContain("Claude Code runs it without asking you.");
});

test("with no rule it says every prompt waits for the person, and says why no rule is used while answering is off", async () => {
  held = [];
  answers = [];
  await render(
    <PermissionRulesCard
      answering={{ state: "off", plugin: "unknown", holdMs: 300_000 }}
      now={NOW}
    />,
  );
  await expect
    .element(card().getByText("No rule yet, so every permission prompt waits for you."))
    .toBeVisible();
  await expect.element(card().getByText("No rule is used now")).toBeVisible();
  expect(card().element().textContent).toContain(
    "AGENT_LOOKOUT_ANSWER is off, so no permission prompt is answered from here, by hand or by a rule.",
  );
  await expect.element(card().getByText("No request was answered by a rule yet.")).toBeVisible();
});

test("adding a rule sends one change, through the route that acts, and shows the list the app answers with", async () => {
  await shown();
  await card().getByRole("radio", { name: "Deny" }).click();
  await expect
    .element(card().getByText("Deny: Claude Code is told no, and carries on without it."))
    .toBeVisible();
  await userEvent.type(field(/^Tool/), "Bash");
  await userEvent.type(field(/^Command/), "rm -rf:*{Enter}");

  await vi.waitFor(() =>
    expect(lastChange()).toEqual({
      action: "permission-rules",
      body: { add: { decision: "deny", tool: "Bash", command: "rm -rf:*" } },
    }),
  );
  await vi.waitFor(() => expect(rowTexts().at(-1)).toBe("DenyBash(rm -rf:*)"));
  await expect.element(card().getByText("Added Deny Bash(rm -rf:*).")).toBeVisible();
  await expect.element(field(/^Tool/)).toHaveValue("");
});

test.each([
  ["Bash", "", /An allow rule for Bash names a command/],
  ["*", "", /An allow rule names one tool/],
  ["Bash", "npm test && rm -rf ~", /no ;, &, \|/],
  ["Bash", "cat ~/.ssh/config", /names one plain command/],
  ["Write", "", /never allows one/],
  ["WebFetch", "curl", /goes with Bash only/],
  ["bash", "npm test", /writes this tool's name Bash/],
  ["Bash", "sudo npm test", /sudo runs another command/],
  ["Bash", "curl:*", /curl can send requests, or run code that does/],
  ["Bash", "python -m pytest", /allow a script the project owns, such as \.\/scripts\/test\.sh/],
  ["mcp__docs", "", /names one tool of a server/],
])(
  "an allow rule for %j with %j is not sent: the card says why, in the app's own words",
  async (tool, command, problem) => {
    await shown();
    await userEvent.type(field(/^Tool/), tool);
    if (command !== "") await userEvent.type(field(/^Command/), command);
    await card().getByRole("button", { name: "Add rule" }).click();
    await expect.element(card().getByText(problem)).toBeVisible();
    expect(changes).toEqual([]);
  },
);

test("the help says no allow rule may begin with a program that sends requests or runs code, and that a list holding one is not used", async () => {
  await shown();
  const text = card().element().textContent ?? "";
  expect(text).toContain(
    "Claude can reach Agent Lookout on this computer, so no allow rule may begin with a program that sends requests or runs the code it is given, such as curl or python, and a saved list that holds one is not used at all.",
  );
  expect(text).toContain(
    "A rule for a program that runs a file Claude can edit, such as npm test, still lets Claude change these rules and answer its own prompts.",
  );
});

test("moving a rule sends its id, keeps focus on its button, and the first rule cannot move up", async () => {
  await shown();
  const up = (name: string) => card().getByRole("button", { name: `Move up: ${name}` });
  const down = (name: string) => card().getByRole("button", { name: `Move down: ${name}` });

  // At the top, Move up is drawn, takes focus and does nothing.
  await expect
    .element(up("Deny Bash(git push --force:*)"))
    .toHaveAttribute("aria-disabled", "true");
  up("Deny Bash(git push --force:*)").element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(up("Deny Bash(git push --force:*)")).toHaveFocus();
  expect(changes).toEqual([]);

  down("Deny Bash(git push --force:*)").element().focus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(rowTexts()).toEqual([
      "AllowBash(npm test:*)",
      "DenyBash(git push --force:*)",
      "AskEvery tool",
    ]),
  );
  expect(lastChange()?.body).toEqual({ move: { id: DENY_PUSH.id, to: "down" } });
  await expect.element(down("Deny Bash(git push --force:*)")).toHaveFocus();
  await expect
    .element(card().getByRole("status").filter({ hasText: "moved down" }))
    .toBeInTheDocument();
});

test("editing fills the form with the rule, saves it in its place, and gives focus back to its Edit", async () => {
  await shown();
  const edit = card().getByRole("button", { name: "Edit: Allow Bash(npm test:*)" });
  await edit.click();
  await expect.element(card().getByRole("heading", { name: "Edit the rule" })).toBeVisible();
  await expect.element(field(/^Tool/)).toHaveFocus();
  await expect.element(field(/^Tool/)).toHaveValue("Bash");
  await expect.element(field(/^Command/)).toHaveValue("npm test:*");

  await userEvent.clear(field(/^Command/));
  await userEvent.type(field(/^Command/), "npm run test:*");
  await card().getByRole("button", { name: "Save rule" }).click();

  await vi.waitFor(() => expect(rowTexts()[1]).toBe("AllowBash(npm run test:*)"));
  expect(lastChange()?.body).toEqual({
    edit: { id: ALLOW_TESTS.id, decision: "allow", tool: "Bash", command: "npm run test:*" },
  });
  await expect
    .element(card().getByRole("button", { name: "Edit: Allow Bash(npm run test:*)" }))
    .toHaveFocus();
  await expect.element(card().getByRole("heading", { name: "Add a rule" })).toBeVisible();
});

test("Escape, or Cancel, stops editing and sends nothing", async () => {
  await shown();
  await card().getByRole("button", { name: "Edit: Ask Every tool" }).click();
  await expect.element(field(/^Tool/)).toHaveValue("*");
  await userEvent.keyboard("{Escape}");
  await expect.element(card().getByRole("heading", { name: "Add a rule" })).toBeVisible();
  await expect.element(field(/^Tool/)).toHaveValue("");
  await expect.element(card().getByRole("button", { name: "Edit: Ask Every tool" })).toHaveFocus();
  expect(changes).toEqual([]);
});

test("removing a rule sends its id, and focus goes to the next rule's Remove, then the one before, then the title", async () => {
  held = [DENY_PUSH, ALLOW_TESTS];
  await shown();
  await card().getByRole("button", { name: "Remove: Deny Bash(git push --force:*)" }).click();
  await vi.waitFor(() => expect(rowTexts()).toEqual(["AllowBash(npm test:*)"]));
  expect(lastChange()?.body).toEqual({ remove: { id: DENY_PUSH.id } });
  await expect
    .element(card().getByRole("button", { name: "Remove: Allow Bash(npm test:*)" }))
    .toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect
    .element(card().getByText("No rule yet, so every permission prompt waits for you."))
    .toBeVisible();
  await expect.element(card().getByRole("heading", { name: "Permission rules" })).toHaveFocus();
});

test("every control can be reached with Tab, in the order of the rules", async () => {
  held = [ALLOW_TESTS];
  await shown();
  card().getByRole("button", { name: "Move up: Allow Bash(npm test:*)" }).element().focus();
  const names: (string | null)[] = [];
  for (let step = 0; step < 4; step += 1) {
    names.push(document.activeElement?.getAttribute("aria-label") ?? null);
    await userEvent.tab();
  }
  expect(names).toEqual([
    "Move up: Allow Bash(npm test:*)",
    "Move down: Allow Bash(npm test:*)",
    "Edit: Allow Bash(npm test:*)",
    "Remove: Allow Bash(npm test:*)",
  ]);
});

test("an allow rule for a tool that is not Bash says it allows every request of that tool", async () => {
  await shown();
  await userEvent.type(field(/^Tool/), "Read");
  const sentence = card().element().querySelector("[data-part='decision-sentence']");
  expect(sentence?.textContent).toContain("Claude Code runs it without asking you.");
  expect(sentence?.textContent).toContain(
    "A rule for Read allows every Read request, whatever it asks for.",
  );
  await card().getByRole("radio", { name: "Deny" }).click();
  expect(sentence?.textContent).not.toContain("every Read request");
});

test("a change from the form that the app did not take says why under the form's buttons, and keeps what was typed", async () => {
  await shown();
  // The list holds this rule already, so the app refuses it.
  await userEvent.type(field(/^Tool/), "Bash");
  await userEvent.type(field(/^Command/), "npm test:*{Enter}");
  const take = card().element().querySelector<HTMLElement>("[data-part='take']") as HTMLElement;
  await vi.waitFor(() => expect(take.textContent).toBe("The list holds that rule already."));
  expect(changes).toHaveLength(1);
  // Right under Add rule, where the person is looking, and not in a note far above it.
  const add = card().getByRole("button", { name: "Add rule" }).element();
  expect(take.getBoundingClientRect().top - add.getBoundingClientRect().bottom).toBeLessThan(16);
  expect(getComputedStyle(take).display).not.toBe("none");
  expect(card().element().textContent).not.toContain("The permission rules could not be changed");
  await expect.element(field(/^Tool/)).toHaveValue("Bash");
  await expect.element(field(/^Command/)).toHaveValue("npm test:*");
  expect(rowTexts()).toHaveLength(3);
  // Typing again puts it away.
  await userEvent.type(field(/^Command/), "{Backspace}");
  expect(take.textContent).toBe("");
});

test("a change the app did not take leaves the list as it was, and a note says why", async () => {
  await shown();
  refusing = "~/.agent-lookout/settings.json could not be written, so the change was not saved.";
  await card().getByRole("button", { name: "Remove: Ask Every tool" }).click();
  await expect.element(card().getByText("The permission rules could not be changed")).toBeVisible();
  expect(card().element().textContent).toContain(
    "could not be written, so the change was not saved.",
  );
  expect(rowTexts()).toHaveLength(3);
});

test("the recent automatic answers say the session, the time, what was done and by which rule, and nothing of what was asked", async () => {
  answers = [
    ANSWER,
    {
      ...ANSWER,
      at: NOW - 30_000,
      tool: "Write",
      decision: "deny",
      rule: { decision: "deny", tool: "*" },
    },
  ];
  await shown();
  const list = card().getByRole("list", { name: "Recent automatic answers, newest first" });
  await expect.element(list).toBeVisible();
  const lines = [...list.element().querySelectorAll("[data-part='rule-answer']")].map(
    (row) => row.textContent,
  );
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain("checkout-flow");
  expect(lines[0]).toContain("Allowed Bash by the rule Bash(npm test:*)");
  expect(lines[1]).toContain("Denied Write by the rule for every tool");
  // A list that can grow scrolls inside itself, and the keyboard reaches it.
  expect(list.element().getAttribute("tabindex")).toBe("0");
  expect(list.element().classList).toContain("thin-scroll");
  expect(card().element().textContent).toMatch(/since \d\d:\d\d/);
});

test("before the app has answered the card says nothing, and when it cannot be read it says so", async () => {
  let answer: (response: Response) => void = () => {};
  setApiHost(() => new Promise((resolve) => (answer = resolve)));
  await render(<PermissionRulesCard answering={ON} now={NOW} />);
  const state = card().element().querySelector("[data-part='state']") as HTMLElement;
  expect(state.textContent).toBe("");
  answer(new Response("not data", { status: 500 }));
  await expect.element(card().getByText("The permission rules could not be read.")).toBeVisible();
  expect(card().getByRole("button").elements()).toEqual([]);
});

test.each([375, 1280])("at %i pixels nothing runs off the side of the card", async (width) => {
  await page.viewport(width, 900);
  onTestFinished(() => page.viewport(1280, 900));
  held = [
    DENY_PUSH,
    ALLOW_TESTS,
    ASK_ALL,
    { id: "eeeeeeeeeeee", decision: "allow", tool: "mcp__documentation-server__search_everything" },
    {
      id: "ffffffffffff",
      decision: "deny",
      tool: "Bash",
      command: "terraform apply -auto-approve -var-file=production.tfvars:*",
    },
  ];
  // The width of the column the card sits in: the phone's, and the right column's at 1280.
  const cardWidth = width === 375 ? 283 : 377;
  await render(
    <div style={{ width: cardWidth }}>
      <PermissionRulesCard answering={ON} now={NOW} />
    </div>,
  );
  await expect.element(rules()).toBeVisible();
  const box = card().element();
  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  const right = box.getBoundingClientRect().right - 24 + 0.5;
  for (const part of box.querySelectorAll<HTMLElement>(
    "p, input, button, label, code, [data-slot='segmented-control'], [data-slot='badge']",
  )) {
    expect(part.getBoundingClientRect().right, part.textContent ?? "").toBeLessThanOrEqual(right);
  }
  // A row's buttons sit on one line under its rule.
  for (const row of rows()) {
    const buttons = [...row.querySelectorAll("button")].map(
      (button) => button.getBoundingClientRect().top,
    );
    expect(new Set(buttons).size).toBe(1);
  }
});

test("the fields are the recessed well, the command in the mono", async () => {
  await shown();
  const command = field(/^Command/).element();
  expect(getComputedStyle(command).backgroundColor).toBe(rgbOf("var(--well)"));
  expect(getComputedStyle(command).fontFamily).toMatch(/Mono/);
  expect(getComputedStyle(command).textAlign).toBe("left");
  expect(command.getBoundingClientRect().height).toBe(30);
});

test.each(["dark", "light"] as const)("in the %s theme nothing in it is warm", async (theme) => {
  document.documentElement.setAttribute("data-theme", theme);
  const screen = await shown();
  expect(warmPaint(screen.container)).toEqual([]);
});

test("rules the file holds and Agent Lookout could not read are said in a note above the rules", async () => {
  held = [];
  setApiHost(
    async () =>
      new Response(
        JSON.stringify({
          timeRules: DEFAULT_TIME_RULES,
          file: "~/.agent-lookout/settings.json",
          problem: null,
          permissionRules: [],
          permissionRulesProblem:
            "~/.agent-lookout/settings.json holds permission rules Agent Lookout cannot read, or a rule it refuses, so no rule is used.",
          ruleAnswers: [],
          ruleAnswersSince: NOW,
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
  );
  await render(<PermissionRulesCard answering={ON} now={NOW} />);
  const note = card()
    .getByRole("status")
    .filter({ hasText: "The settings file could not be used" });
  await expect.element(note).toBeVisible();
  expect(note.element().textContent).toContain("or a rule it refuses, so no rule is used.");
  // 12px above the first part.
  const rulesPart = card().element().querySelector("[data-part='rules']") as HTMLElement;
  expect(
    rulesPart.getBoundingClientRect().top - note.element().getBoundingClientRect().bottom,
  ).toBe(12);
});
