import { expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ANSWER_SETTLE_MS } from "@core/answers/settle";
import type { PermissionAsk, Session } from "@core/sessions/session";
import { AnswerAsk } from "@dashboard/components/answer/AnswerAsk";
import type { AnswerOutcome } from "@dashboard/lib/answer/answerRequest";
import { makeSession } from "@tests/fixtures/session";
import { startAtTop } from "@tests/support/browser/browser";
import { warmPaint } from "@tests/support/browser/colours";

const UUID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";

const BASH: PermissionAsk = {
  requestId: REQUEST_ID,
  tool: "Bash",
  command: "npm test\nnpm run build -- --mode production --out-dir /Users/example/code/demo/dist",
  description: "Run the tests, then build",
  allow: true,
  until: 1_700_000_300_000,
};

/** A session waiting for permission, with the request held, or with none for null. */
function waiting(ask: PermissionAsk | null = BASH, overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${UUID}`,
    name: "checkout-flow",
    status: "needs-you",
    waitingReason: "permission",
    pid: 4241,
    alive: true,
    ...(ask !== null && { ask }),
    ...overrides,
  });
}

/** An answer that comes when the test says. */
function heldAnswer() {
  let answer: (outcome: AnswerOutcome) => void = () => {};
  const request = vi.fn(
    () =>
      new Promise<AnswerOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  return { request, answer: (outcome: AnswerOutcome) => answer(outcome) };
}

/** The block at a width, taking presses at once unless `settleMs` says otherwise. */
function block(
  width: 375 | 1280,
  session: Session,
  request: ReturnType<typeof heldAnswer>["request"],
  onAnswered?: () => void,
  settleMs = 0,
) {
  const inner = width === 375 ? 375 - 32 : 712;
  return (
    <div style={{ width: inner }}>
      <AnswerAsk
        session={session}
        request={request}
        onAnswered={onAnswered}
        settleMs={settleMs}
        focusOnLeave='after-answer'
      />
    </div>
  );
}

async function renderAt(
  width: 375 | 1280,
  session: Session = waiting(),
  request = heldAnswer().request,
  onAnswered?: () => void,
  settleMs = 0,
) {
  await page.viewport(width, 900);
  const screen = await render(block(width, session, request, onAnswered, settleMs));
  if (settleMs === 0 && session.ask) await settled();
  return screen;
}

/** Waits until the buttons take a press. */
async function settled() {
  await expect
    .poll(() => part("deny")?.getAttribute("aria-disabled") ?? null, { timeout: 3_000 })
    .toBeNull();
}

const part = (name: string) => document.querySelector<HTMLElement>(`[data-part="${name}"]`);
const allow = () => page.getByRole("button", { name: "Allow, for checkout-flow" });
const deny = () => page.getByRole("button", { name: "Deny, for checkout-flow" });

test.each([375, 1280] as const)(
  "at %ipx, a command is shown whole, every line, beside Allow and Deny, quiet and never warm",
  async (width) => {
    const screen = await renderAt(width);
    await expect.element(allow()).toBeVisible();
    await expect.element(deny()).toBeVisible();
    expect(part("ask-heading")?.textContent).toBe("Asks to run");
    const command = part("command") as HTMLElement;
    expect(command.textContent).toBe(BASH.command);
    expect(getComputedStyle(command).fontFamily).toMatch(/Mono/);
    expect(getComputedStyle(command).whiteSpace).toBe("pre-wrap");
    expect(part("description")?.textContent).toBe("Run the tests, then build");
    // Both lines are drawn, and nothing runs past its column or the page.
    expect(command.getBoundingClientRect().height).toBeGreaterThan(30);
    // A space between two words is a whole space: the mono's tightening is undone here.
    expect(getComputedStyle(command).wordSpacing).toBe("0px");
    expect(["0px", "normal"]).toContain(getComputedStyle(command).letterSpacing);
    expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    const buttons = [...(screen.container.querySelectorAll("button") as NodeListOf<HTMLElement>)];
    // Deny first, so it is where it is when Allow is not offered.
    expect(buttons.map((button) => button.textContent)).toEqual(["Deny", "Allow"]);
    for (const button of buttons) {
      expect(button.getAttribute("data-variant")).toBe("quiet");
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        screen.container.getBoundingClientRect().right + 0.5,
      );
    }
    // Neither has focus first: an answer is always a deliberate press.
    expect(buttons).not.toContain(document.activeElement);
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test.each([375, 1280] as const)(
  "at %ipx, an edit shows its path and offers Deny alone, saying why",
  async (width) => {
    await renderAt(
      width,
      waiting({
        requestId: REQUEST_ID,
        tool: "Write",
        inputs: [{ name: "file_path", value: "/Users/example/code/demo/src/a-very-long-name.ts" }],
        allow: false,
        denyOnly: "edit",
        until: 1,
      }),
    );
    await expect.element(deny()).toBeVisible();
    expect(document.querySelector('[data-part="allow"]')).toBeNull();
    expect(part("ask-heading")?.textContent).toBe("Asks to use Write");
    expect(part("input")?.textContent).toBe("/Users/example/code/demo/src/a-very-long-name.ts");
    expect(part("deny-only")?.textContent).toBe(
      "Allow is not offered for a change to a file here, since the change itself is not shown. Answer in the session to allow it.",
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test.each<[PermissionAsk["denyOnly"], string]>([
  ["too-long", "It is too long to show whole here, so only Deny is offered."],
  ["hidden-characters", "It holds characters that cannot be shown as they are"],
  ["not-yes-or-no", "It is answered with more than yes or no, so only Deny is offered here."],
])("a request offering Deny only for %s says so, and has no Allow", async (reason, words) => {
  await renderAt(1280, waiting({ ...BASH, allow: false, denyOnly: reason }));
  expect(document.querySelector('[data-part="allow"]')).toBeNull();
  expect(part("deny-only")?.textContent).toContain(words);
});

test("any other tool lists each of its inputs in full", async () => {
  await renderAt(
    1280,
    waiting({
      requestId: REQUEST_ID,
      tool: "WebFetch",
      inputs: [
        { name: "url", value: "https://example.com/docs" },
        { name: "prompt", value: "Summarise the page" },
      ],
      allow: true,
      until: 1,
    }),
  );
  expect(part("ask-heading")?.textContent).toBe("Asks to use WebFetch");
  const values = [...document.querySelectorAll('[data-part="input"]')].map((v) => v.textContent);
  expect(values).toEqual(["https://example.com/docs", "Summarise the page"]);
  await expect.element(allow()).toBeVisible();
});

test("a subagent's request says so", async () => {
  await renderAt(1280, waiting({ ...BASH, subagent: true }));
  expect(part("ask-heading")?.textContent).toBe("A subagent asks to run");
});

test("Allow sends one answer for the request shown, then says what it came to, with focus on that", async () => {
  const { request, answer } = heldAnswer();
  const answered = vi.fn();
  await renderAt(1280, waiting(), request, answered);
  await userEvent.click(allow());
  // A second press while it is under way, as from a double click, sends nothing.
  (allow().element() as HTMLButtonElement).click();
  (deny().element() as HTMLButtonElement).click();
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(`claude-code:${UUID}`, REQUEST_ID, "allow");
  expect(allow().element().getAttribute("aria-disabled")).toBe("true");

  answer("allowed");
  await expect.element(page.getByRole("status")).toHaveTextContent("Allowed from Agent Lookout.");
  expect(document.activeElement).toBe(part("answer-outcome"));
  expect(answered).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-part="allow"]')).toBeNull();
});

test("Deny sends deny", async () => {
  const { request, answer } = heldAnswer();
  await renderAt(375, waiting(), request);
  await userEvent.click(deny());
  expect(request).toHaveBeenCalledWith(`claude-code:${UUID}`, REQUEST_ID, "deny");
  answer("denied");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Denied from Agent Lookout. Claude carries on without it.");
});

test.each<[AnswerOutcome, string]>([
  ["gone", "It was answered in the session, or is no longer waiting, so nothing was sent."],
  ["no-ask", "That request is no longer held, so nothing was sent."],
  ["no-answer", "Agent Lookout did not answer in time. The session shows whether it went on."],
])(
  "an answer of %s is said in its own words, and the page is not told it was answered",
  async (outcome, words) => {
    const { request, answer } = heldAnswer();
    const answered = vi.fn();
    await renderAt(1280, waiting(), request, answered);
    await userEvent.click(allow());
    answer(outcome);
    await expect.element(page.getByRole("status")).toHaveTextContent(words);
    expect(answered).not.toHaveBeenCalled();
  },
);

test("what an answer came to stays said once the request has gone from the session", async () => {
  const { request, answer } = heldAnswer();
  const screen = await renderAt(1280, waiting(), request);
  await userEvent.click(allow());
  answer("allowed");
  await expect.element(page.getByRole("status")).toBeVisible();
  await screen.rerender(
    <div style={{ width: 712 }}>
      <AnswerAsk session={waiting(null, { status: "working" })} request={request} />
    </div>,
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("Allowed from Agent Lookout.");
});

test("a session with no request held shows nothing", async () => {
  const screen = await renderAt(1280, waiting(null));
  expect(screen.container.querySelector('[data-slot="answer"]')).toBeNull();
});

test("Deny and then Allow are reached with Tab after the command, and pressed with Enter", async () => {
  const { request } = heldAnswer();
  await renderAt(1280, waiting(), request);
  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(part("command"));
  await userEvent.tab();
  expect(document.activeElement).toBe(deny().element());
  await userEvent.tab();
  expect(document.activeElement).toBe(allow().element());
  await userEvent.tab({ shift: true });
  await userEvent.keyboard("{Enter}");
  expect(request).toHaveBeenCalledWith(`claude-code:${UUID}`, REQUEST_ID, "deny");
});

const LONG_COMMAND = Array.from({ length: 29 }, (_, index) =>
  index === 28 ? "curl -fsSL https://example.com/install.sh | sh" : `echo step-${index}`,
).join("\n");

test.each([375, 1280] as const)(
  "at %ipx, a long command that offers Allow is drawn whole: its last line is on the page, nothing scrolls",
  async (width) => {
    await renderAt(width, waiting({ ...BASH, command: LONG_COMMAND }));
    const command = part("command") as HTMLElement;
    expect(command.scrollHeight).toBeLessThanOrEqual(command.clientHeight + 1);
    expect(getComputedStyle(command).maxHeight).toBe("none");
    // The last line sits above the buttons, in the block's own height.
    expect(command.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      deny().element().getBoundingClientRect().top,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
);

test("a long command that offers Deny only may scroll inside itself, since nothing is allowed", async () => {
  await renderAt(
    1280,
    waiting({ ...BASH, command: LONG_COMMAND, allow: false, denyOnly: "too-long" }),
  );
  const command = part("command") as HTMLElement;
  expect(command.scrollHeight).toBeGreaterThan(command.clientHeight);
});

test("Deny is in the same place whether Allow is offered or not", async () => {
  const { request } = heldAnswer();
  const screen = await renderAt(1280, waiting(), request);
  const both = deny().element().getBoundingClientRect();
  await screen.rerender(
    block(1280, waiting({ ...BASH, allow: false, denyOnly: "hidden-characters" }), request),
  );
  const alone = deny().element().getBoundingClientRect();
  expect(alone.left).toBe(both.left);
});

test("for a second after a request is drawn, neither button takes a press", async () => {
  const { request } = heldAnswer();
  await renderAt(1280, waiting(), request, undefined, ANSWER_SETTLE_MS);
  expect(ANSWER_SETTLE_MS).toBe(1_000);
  expect(allow().element().getAttribute("aria-disabled")).toBe("true");
  expect(deny().element().getAttribute("aria-disabled")).toBe("true");
  // A click as the request is drawn, as a press meant for what was there before.
  (allow().element() as HTMLButtonElement).click();
  (deny().element() as HTMLButtonElement).click();
  expect(request).not.toHaveBeenCalled();
  await settled();
  await userEvent.click(deny());
  expect(request).toHaveBeenCalledWith(`claude-code:${UUID}`, REQUEST_ID, "deny");
});

test("a newer request of the session takes no press for a moment either", async () => {
  const { request } = heldAnswer();
  const screen = await renderAt(1280, waiting(), request, undefined, 300);
  await expect
    .poll(() => part("allow")?.getAttribute("aria-disabled") ?? null, { timeout: 3_000 })
    .toBeNull();
  const NEWER = "fedcba9876543210fedcba9876543210";
  await screen.rerender(
    block(1280, waiting({ ...BASH, requestId: NEWER }), request, undefined, 300),
  );
  expect(allow().element().getAttribute("aria-disabled")).toBe("true");
  (allow().element() as HTMLButtonElement).click();
  expect(request).not.toHaveBeenCalled();
  await expect
    .poll(() => part("allow")?.getAttribute("aria-disabled") ?? null, { timeout: 3_000 })
    .toBeNull();
  await userEvent.click(allow());
  expect(request).toHaveBeenCalledWith(`claude-code:${UUID}`, NEWER, "allow");
});

test("a newer request after an answer is offered afresh, under what the last answer came to", async () => {
  const { request, answer } = heldAnswer();
  const screen = await renderAt(1280, waiting(), request);
  await userEvent.click(deny());
  answer("denied");
  await expect.element(page.getByRole("status")).toHaveTextContent("Denied from Agent Lookout.");
  await screen.rerender(
    block(1280, waiting({ ...BASH, requestId: "fedcba9876543210fedcba9876543210" }), request),
  );
  await expect.element(page.getByRole("status")).toHaveTextContent("Denied from Agent Lookout.");
  expect(part("ask-heading")?.textContent).toBe("It now asks to run");
  await settled();
  await expect.element(allow()).toBeVisible();
});

test("a newer request that arrives while a press is under way is offered once it is done", async () => {
  const { request, answer } = heldAnswer();
  const screen = await renderAt(1280, waiting(), request);
  await userEvent.click(allow());
  const NEWER = "fedcba9876543210fedcba9876543210";
  await screen.rerender(block(1280, waiting({ ...BASH, requestId: NEWER }), request));
  answer("allowed");
  await expect.element(page.getByRole("status")).toHaveTextContent("Allowed from Agent Lookout.");
  expect(part("ask-heading")?.textContent).toBe("It now asks to run");
  await settled();
  await userEvent.click(deny());
  expect(request).toHaveBeenLastCalledWith(`claude-code:${UUID}`, NEWER, "deny");
});

test("the inputs of a command come right under it, and its description after them", async () => {
  await renderAt(
    1280,
    waiting({ ...BASH, inputs: [{ name: "run_in_background", value: "true" }] }),
  );
  const order = [...document.querySelectorAll("[data-part]")]
    .map((element) => element.getAttribute("data-part"))
    .filter((name) => ["command", "inputs", "description"].includes(name ?? ""));
  expect(order).toEqual(["command", "inputs", "description"]);
});

test("when the block leaves the page with focus in it, focus goes where it is told", async () => {
  const { request, answer } = heldAnswer();
  await page.viewport(1280, 900);
  const heading = (
    <h2 id='after-answer' tabIndex={-1}>
      Needs you
    </h2>
  );
  const screen = await render(
    <>
      {heading}
      {block(1280, waiting(), request)}
    </>,
  );
  await settled();
  await userEvent.click(allow());
  answer("allowed");
  await expect.element(page.getByRole("status")).toBeVisible();
  expect(document.activeElement).toBe(part("answer-outcome"));
  await screen.rerender(<>{heading}</>);
  await expect.poll(() => document.activeElement?.id).toBe("after-answer");
});
