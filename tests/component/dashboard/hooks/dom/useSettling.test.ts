import { createElement, type CSSProperties } from "react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useSettling } from "@dashboard/hooks/dom/useSettling";
import { assistivePress } from "@tests/support/browser/browser";

// Runs in the component project because it measures where the browser lays things out.

const SETTLE_MS = 300;

interface BoxProps {
  take: () => void;
  of?: string;
  gap?: number;
  ms?: number;
  /** How what holds it is drawn. */
  within?: CSSProperties;
}

/** A button that counts the presses it takes. The parent keeps no clock, so only the test draws it again. */
function Box({ take, of = "request", gap = 0, ms = SETTLE_MS, within }: BoxProps) {
  const { settling, tooSoon } = useSettling("box", of, ms);
  return createElement(
    "div",
    { "data-testid": "within", style: within },
    createElement("div", { "data-testid": "above", style: { height: gap } }),
    createElement(
      "button",
      {
        id: "box",
        "aria-disabled": settling,
        onClick: () => {
          if (!tooSoon()) take();
        },
      },
      "Answer",
    ),
    createElement("div", { "data-testid": "below", style: { height: 3000 } }),
  );
}

const box = () => document.getElementById("box") as HTMLElement;
const part = (name: "within" | "above" | "below") =>
  page.getByTestId(name).element() as HTMLElement;

async function settled() {
  await expect.poll(() => box().getAttribute("aria-disabled"), { timeout: 3_000 }).toBe("false");
}

async function drawn(props: Partial<BoxProps> = {}) {
  const take = vi.fn();
  const screen = await render(createElement(Box, { take, ...props }));
  await settled();
  return { take, screen };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Once the page has been told of a scroll, which it is as it is next drawn. */
const frame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));

afterEach(() => window.scrollTo({ top: 0 }));

test("what stays where it is takes an assistive press at once", async () => {
  const { take } = await drawn();
  assistivePress(box());
  expect(take).toHaveBeenCalledOnce();
});

test("drawn again somewhere else, it takes no press until it has been there long enough", async () => {
  const { take, screen } = await drawn();
  await screen.rerender(createElement(Box, { take, gap: 60 }));
  expect(box().getAttribute("aria-disabled")).toBe("true");
  box().click();
  expect(take).not.toHaveBeenCalled();
  await settled();
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test("moved by something else on the page, with nothing of its own drawn again, it takes no press", async () => {
  const { take } = await drawn();
  part("above").style.height = "60px";
  box().click();
  box().click();
  expect(take).not.toHaveBeenCalled();
  await settled();
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test("grown taller where it is, as when what it holds comes onto another line, it takes no press", async () => {
  const { take } = await drawn();
  box().style.height = "60px";
  box().click();
  expect(take).not.toHaveBeenCalled();
  await settled();
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test.each<[string, () => void]>([
  ["sideways", () => (box().style.marginLeft = "60px")],
  ["with what holds it", () => (part("within").style.marginTop = "60px")],
])("moved %s, it takes no press", async (_, move) => {
  const { take } = await drawn({ within: { position: "relative" } });
  move();
  box().click();
  expect(take).not.toHaveBeenCalled();
});

test("a move of a few pixels is none, and one more from where it settled is", async () => {
  const { take } = await drawn();
  part("above").style.height = "3px";
  box().click();
  expect(take).toHaveBeenCalledOnce();
  part("above").style.height = "6px";
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test("moved again before it settled, it takes no press until it has been there long enough", async () => {
  const { take, screen } = await drawn({ ms: 1_000 });
  await screen.rerender(createElement(Box, { take, ms: 1_000, gap: 60 }));
  await wait(600);
  await screen.rerender(createElement(Box, { take, ms: 1_000, gap: 120 }));
  await wait(600);
  box().click();
  expect(take).not.toHaveBeenCalled();
  await settled();
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test("another request in the same place takes no press", async () => {
  const { take, screen } = await drawn();
  await screen.rerender(createElement(Box, { take, of: "another" }));
  box().click();
  expect(take).not.toHaveBeenCalled();
});

test("the page coming back into sight starts it again", async () => {
  const { take } = await drawn();
  document.dispatchEvent(new Event("visibilitychange"));
  await expect.poll(() => box().getAttribute("aria-disabled")).toBe("true");
  box().click();
  expect(take).not.toHaveBeenCalled();
  await settled();
});

test("a dialog closing over it starts it again", async () => {
  const { take, screen } = await drawn();
  // As Radix does to the page while a dialog is open.
  screen.container.setAttribute("aria-hidden", "true");
  await screen.rerender(createElement(Box, { take }));
  screen.container.removeAttribute("aria-hidden");
  box().click();
  expect(take).not.toHaveBeenCalled();
  await settled();
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test("scrolling the page to it, or animating it, is no move", async () => {
  const { take } = await drawn();
  window.scrollTo({ top: 200 });
  box().style.transform = "translateY(40px)";
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test("a page pulled past its end, as Safari says it is while it bounces or is pinched, has not moved", async () => {
  const { take, screen } = await drawn();
  const { scrollHeight, clientHeight } = document.documentElement;
  const scrollTop = vi.spyOn(document.documentElement, "scrollTop", "get");
  onTestFinished(() => scrollTop.mockRestore());
  scrollTop.mockReturnValue(scrollHeight - clientHeight + 120);
  await screen.rerender(createElement(Box, { take }));
  await screen.rerender(createElement(Box, { take }));
  expect(box().getAttribute("aria-disabled")).toBe("false");
  box().click();
  expect(take).toHaveBeenCalledOnce();
});

test.each<[string, CSSProperties | undefined, () => Element]>([
  ["page", undefined, () => document.documentElement],
  ["dialog", { position: "fixed", inset: 0, overflowY: "auto" }, () => part("within")],
])(
  "a %s that comes down under the pointer, too short now to stay scrolled, is a move, with nothing drawn since it was scrolled",
  async (_, within, scroller) => {
    const { take } = await drawn({ within });
    scroller().scrollTo({ top: 400 });
    await frame();
    const was = box().getBoundingClientRect().top;
    part("below").style.height = `${window.innerHeight + 100}px`;
    expect(box().getBoundingClientRect().top).toBeGreaterThan(was + 100);
    await expect.poll(() => box().getAttribute("aria-disabled"), { interval: 10 }).toBe("true");
    box().click();
    expect(take).not.toHaveBeenCalled();
    await settled();
    box().click();
    expect(take).toHaveBeenCalledOnce();
  },
);

test("in a dialog, the page behind it getting shorter is no move", async () => {
  const behind = document.createElement("div");
  behind.style.height = "3000px";
  document.body.append(behind);
  onTestFinished(() => behind.remove());
  window.scrollTo({ top: 400 });
  const { take } = await drawn({ within: { position: "fixed", inset: 0, overflowY: "auto" } });
  behind.remove();
  expect(window.scrollY).toBe(0);
  box().click();
  expect(take).toHaveBeenCalledOnce();
});
