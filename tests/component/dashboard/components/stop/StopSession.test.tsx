import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session } from "@core/sessions/session";
import { StopButton, StopNote } from "@dashboard/components/stop/StopSession";
import { useStop } from "@dashboard/hooks/actions/useStop";
import type { StopOutcome } from "@dashboard/lib/stop/stopRequest";
import { makeSession } from "@tests/fixtures/session";
import { startAtTop } from "@tests/support/browser/browser";
import { warmPaint } from "@tests/support/browser/colours";

const UUID = "00000000-0000-4000-8000-000000000001";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

function working(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${UUID}`,
    name: "checkout-flow",
    status: "working",
    surface: "terminal",
    pid: 4241,
    alive: true,
    stop: { how: "signal" },
    ...overrides,
  });
}

/** A stop that answers when the test says. */
function heldStop() {
  let answer: (outcome: StopOutcome) => void = () => {};
  const request = vi.fn(
    () =>
      new Promise<StopOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  return { request, answer: (outcome: StopOutcome) => answer(outcome) };
}

/** The button and its note as a session's details hold them: the button in the head, the note under it. */
function Harness({
  session,
  request,
  onStopped,
}: {
  session: Session;
  request: (id: string) => Promise<StopOutcome>;
  onStopped?: () => void;
}) {
  const stop = useStop(session.id, { request, onStopped });
  return (
    <div style={{ width: "100%" }} data-testid='details'>
      <header className='flex items-start justify-between gap-4'>
        <h2 className='text-title font-semibold'>{session.name}</h2>
        <StopButton session={session} stop={stop} />
      </header>
      <StopNote session={session} stop={stop} className='mt-3' />
    </div>
  );
}

async function renderAt(
  width: 375 | 1280,
  session: Session = working(),
  request: (id: string) => Promise<StopOutcome> = heldStop().request,
  onStopped?: () => void,
) {
  await page.viewport(width, 800);
  // The details are 760px at most, less the dialog's own insets, and the window's on a phone.
  const inner = width === 375 ? 375 - 32 - 48 : 712;
  return render(
    <div style={{ width: inner }}>
      <Harness session={session} request={request} onStopped={onStopped} />
    </div>,
  );
}

const stopButton = () => page.getByRole("button", { name: "Stop checkout-flow" });
const note = (part: string) =>
  document.querySelector(`[data-part="${part}"]`) as HTMLElement | null;

test.each([375, 1280] as const)(
  "at %ipx, Stop is one quiet button, and pressing it only asks, with focus on Cancel",
  async (width) => {
    const { request } = heldStop();
    const screen = await renderAt(width, working(), request);
    await expect.element(stopButton()).toBeVisible();
    expect(stopButton().element().getAttribute("data-variant")).toBe("quiet");
    expect(stopButton().element().textContent).toBe("Stop");
    expect(warmPaint(screen.container)).toEqual([]);

    await userEvent.click(stopButton());
    const confirm = note("stop-confirm") as HTMLElement;
    expect(confirm).not.toBeNull();
    expect(note("question")?.textContent).toBe("Stop checkout-flow?");
    expect(note("does")?.textContent).toBe(
      `Its process ends now. The conversation is kept, and claude --resume ${UUID} opens it again.`,
    );
    expect(note("interrupts")?.textContent).toBe(
      "It is working now. What it is doing will stop part-way.",
    );
    // The command is a literal string, in the mono, and the ID after it too.
    const facts = [...confirm.querySelectorAll<HTMLElement>('[data-slot="fact"]')];
    expect(facts.map((fact) => fact.textContent)).toEqual(["claude --resume", UUID]);
    for (const fact of facts) expect(getComputedStyle(fact).fontFamily).toMatch(/Mono/);
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(request).not.toHaveBeenCalled();

    // Nothing in it runs past its column, and nothing in it is warm.
    expect(confirm.scrollWidth).toBeLessThanOrEqual(confirm.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    const buttons = [...confirm.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Stop session", "Cancel"]);
    for (const button of buttons) {
      expect(button.getBoundingClientRect().right).toBeLessThanOrEqual(
        confirm.getBoundingClientRect().right + 0.5,
      );
    }
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("Enter, from where the confirmation puts focus, cancels: it never stops a session", async () => {
  const { request } = heldStop();
  await renderAt(1280, working(), request);
  await userEvent.click(stopButton());
  await userEvent.keyboard("{Enter}");

  expect(request).not.toHaveBeenCalled();
  expect(note("stop-confirm")).toBeNull();
  // Back where the person was.
  expect(document.activeElement).toBe(stopButton().element());
});

test("Cancel puts it back as it was, with focus on Stop", async () => {
  const { request } = heldStop();
  await renderAt(1280, working(), request);
  await userEvent.click(stopButton());
  await userEvent.click(page.getByRole("button", { name: "Cancel" }));

  expect(note("stop-confirm")).toBeNull();
  expect(document.activeElement).toBe(stopButton().element());
  expect(request).not.toHaveBeenCalled();
});

test("Stop session sends one request, says it is under way, and then what it came to, with focus on that", async () => {
  const { request, answer } = heldStop();
  const stopped = vi.fn();
  await renderAt(1280, working(), request, stopped);
  await userEvent.click(stopButton());
  const confirm = page.getByRole("button", { name: "Stop session" });
  await userEvent.click(confirm);
  // A second press while it is under way, as from a double click, sends nothing.
  (confirm.element() as HTMLButtonElement).click();

  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(`claude-code:${UUID}`);
  expect(note("question")?.textContent).toBe("Stopping checkout-flow…");
  expect(confirm.element().getAttribute("aria-disabled")).toBe("true");

  answer("stopped");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Stopped. Its process has ended, and its conversation is kept.");
  expect(document.activeElement).toBe(note("stop-outcome"));
  expect(stopped).toHaveBeenCalledOnce();
});

test.each<[StopOutcome, string]>([
  ["still-running", "Asked to stop, still running. It had not ended 10 seconds later."],
  [
    "cannot-confirm",
    "Agent Lookout cannot confirm this process is that session, so it did not stop it.",
  ],
  ["gone", "That session has already ended."],
  ["not-allowed", "Agent Lookout is not allowed to stop this process."],
  ["no-answer", "Agent Lookout did not answer in time. The list shows whether it stopped."],
])(
  "an answer of %s is said in its own words, and the page is not told it stopped",
  async (outcome, words) => {
    const { request, answer } = heldStop();
    const stopped = vi.fn();
    await renderAt(1280, working(), request, stopped);
    await userEvent.click(stopButton());
    await userEvent.click(page.getByRole("button", { name: "Stop session" }));
    answer(outcome);

    await expect.element(page.getByRole("status")).toHaveTextContent(words);
    expect(stopped).not.toHaveBeenCalled();
    // Stop can be pressed again.
    await userEvent.click(stopButton());
    expect(note("stop-confirm")).not.toBeNull();
  },
);

test("a waiting session's confirmation says its question is left unanswered", async () => {
  await renderAt(375, working({ status: "needs-you", waitingReason: "permission" }));
  await userEvent.click(stopButton());
  expect(note("interrupts")?.textContent).toBe(
    "It is waiting for you. The question is left unanswered.",
  );
});

test("an idle session's says nothing is lost, and a VS Code one says its history opens it too", async () => {
  await renderAt(1280, working({ status: "idle", surface: "vscode" }));
  await userEvent.click(stopButton());
  expect(note("interrupts")).toBeNull();
  expect(note("does")?.textContent).toBe(
    `Its process ends now. The conversation is kept: open it again from the session history in VS Code, or with claude --resume ${UUID}.`,
  );
});

test.each([375, 1280] as const)(
  "at %ipx, claude --resume is never broken across two lines, and the ID after it may be",
  async (width) => {
    await renderAt(width, working({ status: "idle", surface: "vscode" }));
    await userEvent.click(stopButton());
    const [command, id] = [
      ...document.querySelectorAll<HTMLElement>('[data-part="does"] [data-slot="fact"]'),
    ];

    expect(command?.textContent).toBe("claude --resume");
    expect(command?.getClientRects().length).toBe(1);
    expect(getComputedStyle(command as HTMLElement).whiteSpace).toBe("nowrap");
    expect(getComputedStyle(id as HTMLElement).overflowWrap).toBe("anywhere");
    const does = note("does") as HTMLElement;
    expect(does.scrollWidth).toBeLessThanOrEqual(does.clientWidth);
  },
);

test("a background job's says it is stopped with claude stop", async () => {
  await renderAt(1280, working({ stop: { how: "background" } }));
  await userEvent.click(stopButton());
  expect(note("does")?.textContent).toBe(
    `Agent Lookout asks Claude Code to stop this background job with claude stop. The conversation is kept, and claude --resume ${UUID} opens it again.`,
  );
});

test("a session the collector cannot stop has no button", async () => {
  await renderAt(1280, working({ stop: undefined }));
  await expect.element(page.getByText("checkout-flow")).toBeVisible();
  expect(document.querySelector('[data-part="stop"]')).toBeNull();
});

test("Stop is reached with Tab and pressed with Enter, like any button", async () => {
  await renderAt(1280);
  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(stopButton().element());
  await userEvent.keyboard("{Enter}");
  expect(note("stop-confirm")).not.toBeNull();
  expect(document.activeElement?.textContent).toBe("Cancel");
});
