import { afterEach, beforeEach, expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { LastMessageResponse } from "@core/api";
import { LastMessage } from "@dashboard/components/panels/LastMessage";
import type { LastMessageReading } from "@dashboard/hooks/data/useLastMessage";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";
import { linesDrawn } from "@tests/support/browser/lines";

const ready = (answer: LastMessageResponse): LastMessageReading => ({ status: "ready", answer });
const said = (text: string, cut = false) => ready({ message: { text, cut } });

/** The part as the details hold it: a block as wide as the dialog's body leaves. */
async function show(reading: LastMessageReading, remote = false, width = 712) {
  const screen = await render(
    <div data-testid='part' style={{ width }}>
      <button type='button'>Before</button>
      <LastMessage reading={reading} remote={remote} agent='Codex' />
    </div>,
  );
  return { screen, part: page.getByTestId("part").element() as HTMLElement };
}

const text = (part: Element) =>
  part.querySelector('[data-part="last-message-text"]') as HTMLElement | null;
const scroll = (part: Element) =>
  part.querySelector('[data-part="last-message-scroll"]') as HTMLElement;

beforeEach(async () => {
  await page.viewport(1440, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("the text is shown as it was written: markup and Markdown as characters, never a link, every line break kept", async () => {
  const written =
    "Done: <b>x</b> and **x**.\n\nSee https://example.com/a and `npm run build`.\nLast line.";
  const { part } = await show(said(written));
  const shown = text(part)!;

  expect(shown.textContent).toBe(written);
  // A plain text node: no element is made of any of it, no bold and no link.
  expect(shown.childNodes).toHaveLength(1);
  expect(shown.firstChild?.nodeType).toBe(Node.TEXT_NODE);
  expect(part.querySelector("b, strong, a, code")).toBeNull();
  // Four lines as written, the blank one included.
  expect(shown.innerText.split("\n")).toHaveLength(4);
  expect(linesDrawn(shown)).toBe(3);

  // In the sans, in ink, at the body size, and it can be selected to copy.
  const style = getComputedStyle(shown);
  expect(style.fontFamily).not.toMatch(/Mono/);
  expect(style.color).toBe(rgbOf("var(--ink)"));
  expect(style.whiteSpace).toBe("pre-wrap");
  expect(style.userSelect).not.toBe("none");
  expect(part.querySelector('[data-part="last-message-cut"]')).toBeNull();
});

test("a message whose start was left out says so above it, quietly", async () => {
  const { part } = await show(said("the end of a long reply.", true));
  const cut = part.querySelector('[data-part="last-message-cut"]') as HTMLElement;
  expect(cut.textContent).toBe("The start of a longer message is left out.");
  expect(getComputedStyle(cut).color).toBe(rgbOf("var(--ink-muted)"));
  expect(cut.compareDocumentPosition(text(part)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test.each([
  [
    { message: null, reason: "off", setting: "AGENT_LOOKOUT_LAST_MESSAGE" },
    "Last messages are off: AGENT_LOOKOUT_LAST_MESSAGE is off.",
  ],
  [
    { message: null, reason: "off", setting: "AGENT_LOOKOUT_WAITING_TEXT" },
    "Last messages are off: AGENT_LOOKOUT_WAITING_TEXT is off.",
  ],
  [{ message: null, reason: "not-read" }, "Agent Lookout does not read what Codex sessions say."],
  [{ message: null, reason: "not-found" }, "Its transcript was not found."],
  [{ message: null, reason: "unreadable" }, "Its transcript could not be read."],
  [{ message: null, reason: "nothing-yet" }, "It has not said anything yet."],
  [
    { message: null, reason: "too-far-back" },
    "Its last message is further back than the end of its transcript that Agent Lookout reads.",
  ],
] as const)("%j is one calm line", async (answer, words) => {
  const { part } = await show(ready(answer));
  const line = part.querySelector('[data-part="last-message-state"]') as HTMLElement;
  expect(line.textContent).toBe(words);
  expect(getComputedStyle(line).color).toBe(rgbOf("var(--ink-secondary)"));
  expect(text(part)).toBeNull();
  // A setting is a literal, in the mono.
  const setting = line.querySelector("code");
  if (answer.reason === "off") {
    expect(setting?.textContent).toBe(answer.setting);
    expect(getComputedStyle(setting!).fontFamily).toMatch(/Mono/);
  } else {
    expect(setting).toBeNull();
  }
});

test("a failure with nothing read before says so, and says the page asks again", async () => {
  const { part } = await show({ status: "failed", answer: null });
  expect(part.querySelector('[data-part="last-message-state"]')?.textContent).toBe(
    "Its last message could not be read. The page asks again every two seconds.",
  );
});

test("while it is read, the turning ring says so", async () => {
  await show({ status: "loading", answer: null });
  await expect.element(page.getByRole("status")).toHaveTextContent("Reading its last message");
});

test("a session on another machine is said to be not read, whatever the reading", async () => {
  const { part } = await show({ status: "idle", answer: null }, true);
  expect(part.querySelector('[data-part="last-message-state"]')?.textContent).toBe(
    "Last messages are not read from another machine.",
  );
});

test("with nothing asked, nothing is drawn", async () => {
  const { part } = await show({ status: "idle", answer: null });
  expect(part.textContent).toBe("Before");
});

test("a short message is no Tab stop, and a long one scrolls in its block, which is one, named", async () => {
  const { screen, part } = await show(said("One short line."));
  expect(scroll(part).hasAttribute("tabindex")).toBe(false);
  expect(scroll(part).hasAttribute("aria-label")).toBe(false);
  expect(scroll(part).hasAttribute("role")).toBe(false);

  const long = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the reply.`).join(
    "\n",
  );
  await screen.rerender(
    <div data-testid='part' style={{ width: 712 }}>
      <button type='button'>Before</button>
      <LastMessage reading={said(long)} remote={false} agent='Codex' />
    </div>,
  );
  await expect.poll(() => scroll(part).getAttribute("tabindex")).toBe("0");
  const block = scroll(part);
  expect(block.getAttribute("aria-label")).toBe("Its last message");
  expect(block.getAttribute("role")).toBe("group");
  // At most 240px tall, scrolling inside itself.
  expect(block.getBoundingClientRect().height).toBeLessThanOrEqual(240);
  expect(block.scrollHeight).toBeGreaterThan(block.clientHeight);

  // Reached from the keyboard, and scrolled with it.
  page.getByRole("button", { name: "Before" }).element().focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(block);
  await userEvent.keyboard("{PageDown}");
  await expect.poll(() => block.scrollTop).toBeGreaterThan(0);
});

test("past the first reading, nothing in it is announced as it changes: a message, a reason or a failure", async () => {
  const live = (part: Element) =>
    part.querySelector('[aria-live], [role="status"], [role="alert"], [role="log"]');
  const { screen, part } = await show(said("First."));
  const again = (reading: LastMessageReading) =>
    screen.rerender(
      <div data-testid='part' style={{ width: 712 }}>
        <button type='button'>Before</button>
        <LastMessage reading={reading} remote={false} agent='Codex' />
      </div>,
    );
  await again(said("Second."));
  expect(text(part)?.textContent).toBe("Second.");
  expect(live(part)).toBeNull();

  await again(ready({ message: null, reason: "nothing-yet" }));
  expect(part.querySelector('[data-part="last-message-state"]')).not.toBeNull();
  expect(live(part)).toBeNull();

  await again({ status: "failed", answer: null });
  expect(part.querySelector('[data-part="last-message-state"]')).not.toBeNull();
  expect(live(part)).toBeNull();
});

test.each(["dark", "light"])(
  "in the %s theme nothing of it is warm, a message, its cut line or a reason",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const { screen, part } = await show(said("A reply.", true));
    expect(warmPaint(part)).toEqual([]);
    await screen.rerender(
      <div data-testid='part' style={{ width: 712 }}>
        <LastMessage
          reading={ready({ message: null, reason: "off", setting: "AGENT_LOOKOUT_LAST_MESSAGE" })}
          remote={false}
          agent='Codex'
        />
      </div>,
    );
    expect(warmPaint(part)).toEqual([]);
  },
);

test("on a phone, a long word with no space in it breaks rather than run past the side", async () => {
  await page.viewport(375, 800);
  const word = `${"a".repeat(30)}/${"b".repeat(60)}/${"c".repeat(60)}`;
  const { part } = await show(said(`Read ${word} first.`), false, 327);
  const block = scroll(part);
  expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
  expect(text(part)!.getBoundingClientRect().right).toBeLessThanOrEqual(
    part.getBoundingClientRect().right,
  );
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
