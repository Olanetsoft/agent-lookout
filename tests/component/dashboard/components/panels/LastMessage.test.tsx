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
const saidStart = (text: string) => ready({ message: { text, cut: false, endCut: true } });

/** The part as the details hold it: a block as wide as the dialog's body leaves. */
async function show(reading: LastMessageReading, remote = false, width = 712) {
  const screen = await render(
    <div data-testid='part' style={{ width }}>
      <button type='button'>Before</button>
      <LastMessage reading={reading} remote={remote} agent='Gemini CLI' />
    </div>,
  );
  return { screen, part: page.getByTestId("part").element() as HTMLElement };
}

const text = (part: Element) =>
  part.querySelector('[data-part="last-message-text"]') as HTMLElement | null;
const scroll = (part: Element) =>
  part.querySelector('[data-part="last-message-scroll"]') as HTMLElement;
const endLine = (part: Element) =>
  part.querySelector('[data-part="last-message-end-cut"]') as HTMLElement;

/** A reply of short lines, one per line break, none of them long enough to wrap. */
const lines = (count: number) =>
  Array.from({ length: count }, (_, index) => `Line ${index + 1} of the reply.`).join("\n");

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
  expect(part.querySelector('[data-part="last-message-end-cut"]')).toBeNull();
});

test("a message whose start was left out says so above it, quietly", async () => {
  const { part } = await show(said("the end of a long reply.", true));
  const cut = part.querySelector('[data-part="last-message-cut"]') as HTMLElement;
  expect(cut.textContent).toBe("The start of a longer message is left out.");
  expect(getComputedStyle(cut).color).toBe(rgbOf("var(--ink-muted)"));
  expect(cut.compareDocumentPosition(text(part)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(part.querySelector('[data-part="last-message-end-cut"]')).toBeNull();
});

test("a message whose end its transcript left out says so after it, quietly, as the start line does above", async () => {
  const { screen, part } = await show(said("the end of a long reply.", true));
  const startLine = part.querySelector('[data-part="last-message-cut"]') as HTMLElement;
  const startStyle = getComputedStyle(startLine);
  const caption = { size: startStyle.fontSize, weight: startStyle.fontWeight };

  await screen.rerender(
    <div data-testid='part' style={{ width: 712 }}>
      <button type='button'>Before</button>
      <LastMessage
        reading={saidStart("The start of a long reply.")}
        remote={false}
        agent='Gemini CLI'
      />
    </div>,
  );
  const end = part.querySelector('[data-part="last-message-end-cut"]') as HTMLElement;
  expect(end.textContent).toBe("The end of a longer message is left out.");
  expect(text(part)?.textContent).toBe("The start of a long reply.");
  expect(part.querySelector('[data-part="last-message-cut"]')).toBeNull();
  // After the text, in the same quiet caption as the line that says the start is left out.
  expect(text(part)!.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const style = getComputedStyle(end);
  expect(style.color).toBe(rgbOf("var(--ink-muted)"));
  expect({ size: style.fontSize, weight: style.fontWeight }).toEqual(caption);
  expect(style.fontFamily).not.toMatch(/Mono/);
});

test.each([
  [712, 1440, 900],
  [295, 375, 800],
])(
  "a long start's end line comes after its text inside the scrolling block, never under a line the block cuts, at %ipx",
  async (width, windowWidth, windowHeight) => {
    await page.viewport(windowWidth, windowHeight);
    const long = lines(40);
    const { part } = await show(saidStart(long), false, width);
    await expect.poll(() => scroll(part).getAttribute("tabindex")).toBe("0");
    const block = scroll(part);
    const shown = text(part)!;
    const end = endLine(part);

    // The last thing in the block, after the text, and nothing is drawn under the block.
    expect(block.contains(end)).toBe(true);
    expect(block.lastElementChild).toBe(end);
    expect(shown.compareDocumentPosition(end) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.nextElementSibling).toBeNull();

    // Before any scrolling it is out of sight, past the block's bottom edge, so
    // it never sits under the line that edge cuts.
    expect(end.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      block.getBoundingClientRect().bottom,
    );

    // Scrolled to the end, it shows whole inside the block, 6px under the text.
    block.scrollTop = block.scrollHeight;
    await expect
      .poll(() => block.scrollTop + block.clientHeight)
      .toBeGreaterThanOrEqual(block.scrollHeight - 1);
    const box = block.getBoundingClientRect();
    const line = end.getBoundingClientRect();
    expect(line.top).toBeGreaterThanOrEqual(box.top);
    expect(line.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
    expect(line.top - shown.getBoundingClientRect().bottom).toBeCloseTo(6, 0);

    // Read as the reply and then the line, in the group named for the message.
    expect(block.textContent).toBe(`${long}The end of a longer message is left out.`);
    expect(block.getAttribute("role")).toBe("group");
    expect(block.getAttribute("aria-label")).toBe("Its last message");
  },
);

test("a short reply whose end was left out keeps its line 6px under the text, with no Tab stop", async () => {
  const { part } = await show(saidStart("The start of a long reply."));
  const block = scroll(part);
  const end = endLine(part);
  expect(block.hasAttribute("tabindex")).toBe(false);
  expect(block.hasAttribute("role")).toBe(false);
  expect(block.scrollHeight).toBe(block.clientHeight);
  expect(end.getBoundingClientRect().top - text(part)!.getBoundingClientRect().bottom).toBeCloseTo(
    6,
    0,
  );
});

test("a reply that fits keeps its end line whole under the block, with no Tab stop", async () => {
  // Twelve lines fit in the block's 240px. With the end line under them they would not.
  const { part } = await show(saidStart(lines(12)));
  const block = scroll(part);
  const shown = text(part)!;
  const end = endLine(part);
  expect(linesDrawn(shown)).toBe(12);
  // Wait out the report its size watcher gives as it starts.
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  expect(block.contains(end)).toBe(false);
  expect(block.nextElementSibling).toBe(end);
  expect(block.hasAttribute("tabindex")).toBe(false);
  expect(block.hasAttribute("role")).toBe(false);
  expect(block.scrollHeight).toBe(block.clientHeight);
  // Whole, 6px under the text, with nothing cut.
  expect(end.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    block.getBoundingClientRect().bottom,
  );
  expect(end.getBoundingClientRect().top - shown.getBoundingClientRect().bottom).toBeCloseTo(6, 0);
});

test("a reply with both its start and its end left out keeps the start line above the block, where it stays as the text scrolls", async () => {
  const long = lines(40);
  const { part } = await show(ready({ message: { text: long, cut: true, endCut: true } }));
  await expect.poll(() => scroll(part).getAttribute("tabindex")).toBe("0");
  const block = scroll(part);
  const start = part.querySelector('[data-part="last-message-cut"]') as HTMLElement;
  const end = endLine(part);

  // Read in order: the start line, then the group that holds the text and then the end line.
  expect(block.contains(start)).toBe(false);
  expect(start.nextElementSibling).toBe(block);
  expect(block.lastElementChild).toBe(end);
  expect(part.textContent).toBe(
    `BeforeThe start of a longer message is left out.${long}The end of a longer message is left out.`,
  );

  // Whole, 6px over the text, and it does not move when the block scrolls.
  const at = start.getBoundingClientRect();
  expect(at.bottom).toBeLessThanOrEqual(block.getBoundingClientRect().top);
  expect(text(part)!.getBoundingClientRect().top - at.bottom).toBeCloseTo(6, 0);
  block.scrollTop = block.scrollHeight;
  await expect.poll(() => block.scrollTop).toBeGreaterThan(0);
  expect(start.getBoundingClientRect().top).toBe(at.top);
  expect(end.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    block.getBoundingClientRect().bottom + 0.5,
  );
});

test("the end line goes in the block only while the text alone is too long for it, however the reply changes", async () => {
  // At 20px a line, twelve lines fill the 240px block exactly, with nothing to scroll.
  const exact = document.createElement("style");
  exact.textContent =
    '[data-testid="part"] [data-part="last-message-text"] { line-height: 20px !important; }';
  document.head.append(exact);
  try {
    const twelve = lines(12);
    const { screen, part } = await show(said(twelve));
    const again = (reading: LastMessageReading) =>
      screen.rerender(
        <div data-testid='part' style={{ width: 712 }}>
          <button type='button'>Before</button>
          <LastMessage reading={reading} remote={false} agent='Gemini CLI' />
        </div>,
      );
    const settled = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const under = async () => {
      await settled();
      const block = scroll(part);
      expect(block.contains(endLine(part))).toBe(false);
      expect(block.nextElementSibling).toBe(endLine(part));
      expect(block.hasAttribute("tabindex")).toBe(false);
      expect(block.scrollHeight).toBe(block.clientHeight);
    };
    const inside = async () => {
      await expect.poll(() => scroll(part).getAttribute("tabindex")).toBe("0");
      expect(scroll(part).lastElementChild).toBe(endLine(part));
      expect(scroll(part).getAttribute("role")).toBe("group");
    };

    const block = scroll(part);
    expect(block.getBoundingClientRect().height).toBe(240);
    expect(block.scrollHeight).toBe(block.clientHeight);

    // The end line comes to a reply that just fills the block: it goes under it.
    await again(saidStart(twelve));
    await under();
    // A longer reply takes it into the block, at the end of what scrolls.
    await again(saidStart(lines(40)));
    await inside();
    // And one that fits again puts it back under, with nothing left to scroll.
    await again(saidStart(twelve));
    await under();
    await again(said(twelve));
    await settled();
    expect(endLine(part)).toBeNull();
    expect(scroll(part).hasAttribute("tabindex")).toBe(false);
  } finally {
    exact.remove();
  }
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
  [
    { message: null, reason: "not-read" },
    "Agent Lookout does not read what Gemini CLI sessions say.",
  ],
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

  const long = lines(40);
  await screen.rerender(
    <div data-testid='part' style={{ width: 712 }}>
      <button type='button'>Before</button>
      <LastMessage reading={said(long)} remote={false} agent='Gemini CLI' />
    </div>,
  );
  await expect.poll(() => scroll(part).getAttribute("tabindex")).toBe("0");
  const block = scroll(part);
  expect(block.getAttribute("aria-label")).toBe("Its last message");
  expect(block.getAttribute("role")).toBe("group");
  // 240px tall, cutting through a line rather than showing whole lines only, and scrolling inside itself.
  expect(block.getBoundingClientRect().height).toBeCloseTo(240, 0);
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
        <LastMessage reading={reading} remote={false} agent='Gemini CLI' />
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
  "in the %s theme nothing of it is warm, a message, its cut lines or a reason",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const { screen, part } = await show(said("A reply.", true));
    expect(warmPaint(part)).toEqual([]);
    await screen.rerender(
      <div data-testid='part' style={{ width: 712 }}>
        <LastMessage reading={saidStart("A reply.")} remote={false} agent='Gemini CLI' />
      </div>,
    );
    expect(part.querySelector('[data-part="last-message-end-cut"]')).not.toBeNull();
    expect(warmPaint(part)).toEqual([]);
    await screen.rerender(
      <div data-testid='part' style={{ width: 712 }}>
        <LastMessage
          reading={ready({ message: null, reason: "off", setting: "AGENT_LOOKOUT_LAST_MESSAGE" })}
          remote={false}
          agent='Gemini CLI'
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
