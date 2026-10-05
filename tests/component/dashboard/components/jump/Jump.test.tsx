import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { JUMP_INTERVAL_MS } from "@core/api";
import type { Session } from "@core/sessions/session";
import { Jump, JumpNote } from "@dashboard/components/jump/Jump";
import { JUMP_NOTE_MS, useJump } from "@dashboard/hooks/data/useJump";
import { setApiHost, type ApiHost } from "@dashboard/lib/api/apiHost";
import { makeSession } from "@tests/fixtures/session";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

const ID = "claude-code:00000000-0000-4000-8000-000000000001";
const LINK = "vscode://anthropic.claude-code/open?session=00000000-0000-4000-8000-000000000001";

/** A session the collector found in a tmux pane. */
const IN_TMUX = makeSession({
  id: ID,
  name: "checkout-flow",
  status: "working",
  pid: 4242,
  alive: true,
  jump: { kind: "tmux", place: "work:2.1" },
});
const IN_VSCODE = makeSession({
  id: ID,
  name: "docs-site",
  surface: "vscode",
  links: { open: LINK },
});
const NOWHERE = makeSession({ id: ID, name: "search-indexing" });

/** One session as a row draws it: its name, what Jump came to beside it, and its Jump. */
function Row({
  session,
  variant,
  size,
}: {
  session: Session;
  variant?: "quiet" | "needs-you";
  size?: "sm" | "hero";
}) {
  const jump = useJump(session.id);
  return (
    <div data-slot='row' className='flex w-96 items-center gap-2 p-10'>
      <span className='flex-1'>{session.name}</span>
      <JumpNote session={session} jump={jump} />
      <Jump session={session} jump={jump} variant={variant} size={size} />
    </div>
  );
}

interface Sent {
  path: string;
  method: string | undefined;
  body: unknown;
  headers: Headers;
}

/** Stands in for the collector: answers each request as the test says, and writes it down. */
function collector(answer: () => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const host: ApiHost = async (path, init) => {
    sent.push({
      path,
      method: init?.method,
      body: init?.body,
      headers: new Headers(init?.headers),
    });
    return answer();
  };
  setApiHost(host);
  return sent;
}

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SELECTED = json(200, { ok: true, kind: "tmux", place: "work:2.1" });
/** What the collector says to a jump that comes within a second of the last. */
const TOO_SOON = json(429, { error: "x", reason: "too-soon" });

/** Waits out the second in which the collector would refuse another jump. */
const secondOver = () => new Promise((resolve) => setTimeout(resolve, JUMP_INTERVAL_MS));

const note = (root: ParentNode) => root.querySelector<HTMLElement>('[data-part="jump-note"]');
const said = (root: ParentNode) => root.querySelector<HTMLElement>('[data-part="jump-said"]');

beforeEach(() => {
  // A request no test answers would be a test that reached a real server.
  collector(() => {
    throw new Error("No request was expected.");
  });
});

afterEach(() => {
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
});

test.each(["dark", "light"] as const)(
  "in the %s theme a session in tmux has a Jump that is a button, named for the session and the place, in the quiet capsule every Jump wears",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<Row session={IN_TMUX} />);
    const jump = screen.getByRole("button", { name: "Jump to checkout-flow in tmux, work:2.1" });

    await expect.element(jump).toBeVisible();
    const button = jump.element() as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.type).toBe("button");
    expect(button.textContent).toBe("Jump");
    expect(screen.container.querySelector("a")).toBeNull();

    // The same primitive, variant and size as the link a VS Code session has.
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("quiet");
    const style = getComputedStyle(button);
    expect(style.height).toBe("28px");
    expect(style.width).toBe("64px");
    expect(style.borderRadius).toBe("999px");
    expect(style.backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
    expect(style.color).toBe(rgbOf("var(--ink-secondary)"));
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("a session in VS Code keeps its link, drawn the same, and pressing nothing asks the collector for nothing", async () => {
  const sent = collector(SELECTED);
  const screen = await render(
    <>
      <Row session={IN_VSCODE} />
      <Row session={{ ...IN_TMUX, id: `${ID}-2` }} />
    </>,
  );
  const link = screen.getByRole("link", { name: "Jump to docs-site in VS Code" }).element();
  const button = screen
    .getByRole("button", { name: "Jump to checkout-flow in tmux, work:2.1" })
    .element();

  expect(link.getAttribute("href")).toBe(LINK);
  for (const property of ["height", "width", "backgroundColor", "color", "fontSize"] as const) {
    expect([property, getComputedStyle(button)[property]]).toEqual([
      property,
      getComputedStyle(link)[property],
    ]);
  }
  // A link's row has nothing to say about a press, so it holds no line for it.
  const [linkRow] = screen.container.querySelectorAll('[data-slot="row"]');
  expect(said(linkRow as HTMLElement)).toBeNull();
  expect(sent).toEqual([]);
});

test("a session with no pane and no link has no Jump, and no line about one", async () => {
  const screen = await render(<Row session={NOWHERE} />);

  expect(screen.container.querySelector('[data-part="jump"]')).toBeNull();
  expect(screen.container.querySelector("button, a")).toBeNull();
  expect(said(screen.container)).toBeNull();
  expect(note(screen.container)).toBeNull();
});

test("a session that says it is in a pane of a kind this page does not know has no Jump", async () => {
  const odd = { ...NOWHERE, jump: { kind: "screen", place: "work:2.1" } } as unknown as Session;
  const screen = await render(<Row session={odd} />);

  expect(screen.container.querySelector('[data-part="jump"]')).toBeNull();
});

test("a press asks the collector once, naming the session and nothing else, and says the pane was selected", async () => {
  const sent = collector(SELECTED);
  const screen = await render(<Row session={IN_TMUX} />);
  // Before the press the line a screen reader hears is there, and empty.
  expect(said(screen.container)?.getAttribute("role")).toBe("status");
  expect(said(screen.container)?.textContent).toBe("");
  expect(note(screen.container)).toBeNull();

  await screen.getByRole("button", { name: /^Jump to checkout-flow/ }).click();

  await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.path).toBe("/api/jump");
  expect(sent[0]?.method).toBe("POST");
  expect(sent[0]?.body).toBe(JSON.stringify({ sessionId: ID }));
  expect(sent[0]?.headers.get("Content-Type")).toBe("application/json");
  expect(sent[0]?.headers.get("X-Agent-Lookout-Action")).toBe("jump");

  // For the eye: a quiet badge, the fact tone, which is not warm.
  const badge = note(screen.container) as HTMLElement;
  expect(badge.textContent).toBe("Selected in tmux");
  expect(badge.getAttribute("data-slot")).toBe("badge");
  expect(badge.getAttribute("data-tone")).toBe("neutral");
  expect(badge.getAttribute("aria-hidden")).toBe("true");
  expect(getComputedStyle(badge).backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
  expect(warmPaint(screen.container)).toEqual([]);
  // No dialog opened, and the button kept its place and its focus.
  expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  expect(document.activeElement?.getAttribute("data-part")).toBe("jump");
});

test("what a press came to is said for a few seconds and then taken away", async () => {
  collector(SELECTED);
  const screen = await render(<Row session={IN_TMUX} />);
  await screen.getByRole("button", { name: /^Jump to checkout-flow/ }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");

  expect(JUMP_NOTE_MS).toBe(4_000);
  await vi.waitFor(() => expect(note(screen.container)).toBeNull(), {
    timeout: JUMP_NOTE_MS + 2_000,
    interval: 100,
  });
  expect(said(screen.container)?.textContent).toBe("");
  // The button is still there for the next press.
  await expect
    .element(screen.getByRole("button", { name: /^Jump to checkout-flow/ }))
    .toBeVisible();
});

test.each([
  ["the pane has gone", 409, { error: "x", reason: "pane-gone" }, "That pane has closed"],
  ["tmux has stopped", 409, { error: "x", reason: "tmux-stopped" }, "tmux has stopped"],
  ["no pane is known", 404, { error: "x", reason: "no-pane" }, "No tmux pane found"],
  [
    "it was pressed twice in a second",
    429,
    { error: "x", reason: "too-soon" },
    "Try again in a moment",
  ],
  ["tmux could not be run", 500, { error: "x", reason: "failed" }, "Jump did not work"],
  ["the collector refuses", 403, { error: "x" }, "Jump did not work"],
])("when %s, the row says so in an outlined badge, calmly", async (_what, status, body, words) => {
  collector(json(status, body));
  const screen = await render(<Row session={IN_TMUX} />);
  await screen.getByRole("button", { name: /^Jump to checkout-flow/ }).click();

  await expect.element(screen.getByRole("status")).toHaveTextContent(words);
  const badge = note(screen.container) as HTMLElement;
  expect(badge.textContent).toBe(words);
  expect(badge.getAttribute("data-tone")).toBe("outline");
  expect(getComputedStyle(badge).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(warmPaint(screen.container)).toEqual([]);
  expect(
    document.querySelector('[role="dialog"], [role="alertdialog"], [role="alert"]'),
  ).toBeNull();
});

test("when the collector does not answer at all, the row says Jump did not work", async () => {
  collector(() => {
    throw new TypeError("Failed to fetch");
  });
  const screen = await render(<Row session={IN_TMUX} />);
  await screen.getByRole("button", { name: /^Jump to checkout-flow/ }).click();

  await expect.element(screen.getByRole("status")).toHaveTextContent("Jump did not work");
});

test("a press while one is under way asks nothing more, and the next press is heard afresh", async () => {
  let answer: (response: Response) => void = () => {};
  const sent = collector(() => new Promise<Response>((resolve) => (answer = resolve)));
  const screen = await render(<Row session={IN_TMUX} />);
  const jump = screen.getByRole("button", { name: /^Jump to checkout-flow/ });

  await jump.click();
  await jump.click();
  await jump.click();
  expect(sent).toHaveLength(1);
  expect(note(screen.container)).toBeNull();

  answer(json(409, { error: "x", reason: "pane-gone" })());
  await expect.element(screen.getByRole("status")).toHaveTextContent("That pane has closed");

  // The next press clears what was said, so the same words would be heard again.
  await secondOver();
  await jump.click();
  expect(sent).toHaveLength(2);
  await vi.waitFor(() => expect(said(screen.container)?.textContent).toBe(""));
  answer(SELECTED());
  await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");
});

test.each([
  ["the pane was selected", SELECTED, "Selected in tmux"],
  ["the pane had closed", json(409, { error: "x", reason: "pane-gone" }), "That pane has closed"],
])(
  "the second click of a double click is not sent, so when %s the row goes on saying so",
  async (_what, first, words) => {
    // The collector makes one jump a second, and would refuse the second click.
    const answers = [first, TOO_SOON];
    const sent = collector(() => (answers.shift() ?? TOO_SOON)());
    const screen = await render(<Row session={IN_TMUX} />);
    const jump = screen.getByRole("button", { name: /^Jump to checkout-flow/ });

    await jump.click();
    await expect.element(screen.getByRole("status")).toHaveTextContent(words);
    await jump.click();
    await jump.click();

    expect(sent).toHaveLength(1);
    expect(note(screen.container)?.textContent).toBe(words);
    expect(said(screen.container)?.textContent).toBe(words);

    // Once that second is over, a press is sent again.
    await secondOver();
    await jump.click();
    expect(sent).toHaveLength(2);
  },
);

test("the place is said when the button is pointed at, and when it is reached with Tab", async () => {
  const screen = await render(<Row session={IN_TMUX} />);
  const jump = screen.getByRole("button", { name: /^Jump to checkout-flow/ });
  const tooltip = () => document.querySelector('[data-slot="tooltip"]');

  await pointAway();
  await jump.hover();
  await vi.waitFor(() => expect(tooltip()?.textContent).toContain("tmux, work:2.1"));
  await pointAway();
  await vi.waitFor(() => expect(tooltip()).toBeNull());

  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(jump.element());
  await vi.waitFor(() => expect(tooltip()?.textContent).toContain("tmux, work:2.1"));
  expect(getComputedStyle(jump.element()).outlineColor).toBe(rgbOf("var(--focus)"));

  // Enter presses it, as it does any button.
  const sent = collector(SELECTED);
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");
  expect(sent).toHaveLength(1);
});

test.each(["dark", "light"] as const)(
  "in the %s theme the lamp's solid Jump, for a session that needs the person, is the only warm thing: what it came to is not",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    collector(SELECTED);
    const waiting = {
      ...IN_TMUX,
      status: "needs-you" as const,
      waitingReason: "permission" as const,
    };
    const screen = await render(<Row session={waiting} variant='needs-you' size='hero' />);
    const jump = screen.getByRole("button", { name: "Jump to checkout-flow in tmux, work:2.1" });

    const style = getComputedStyle(jump.element());
    expect(jump.element().getAttribute("data-variant")).toBe("needs-you");
    expect(style.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(style.height).toBe("38px");

    await jump.click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Selected in tmux");
    expect(warmPaint(note(screen.container) as HTMLElement)).toEqual([]);
    // Everything warm in the row is the button's own paint.
    const elsewhere = warmPaint(screen.container).filter((paint) => !paint.startsWith("<button "));
    expect(elsewhere).toEqual([]);
  },
);
