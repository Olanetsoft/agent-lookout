import { createElement } from "react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useSettling } from "@dashboard/hooks/dom/useSettling";
import { assistivePress } from "@tests/support/browser/browser";

// Runs in the component project because it measures where the browser lays things out.

const SETTLE_MS = 300;

/** A button that counts the presses it takes. The parent keeps no clock, so only the test draws it again. */
function Box({ take, of = "request", gap = 0 }: { take: () => void; of?: string; gap?: number }) {
  const { settling, tooSoon } = useSettling("box", of, SETTLE_MS);
  return createElement(
    "div",
    { style: { height: 3000 } },
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
  );
}

const box = () => document.getElementById("box") as HTMLElement;
const above = () => page.getByTestId("above").element() as HTMLElement;

async function settled() {
  await expect.poll(() => box().getAttribute("aria-disabled"), { timeout: 3_000 }).toBe("false");
}

async function drawn() {
  const take = vi.fn();
  const screen = await render(createElement(Box, { take }));
  await settled();
  return { take, screen };
}

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
  above().style.height = "60px";
  box().click();
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

test("a page that comes down under the pointer, now too short to stay scrolled, is a move", async () => {
  const { take, screen } = await drawn();
  const whole = screen.container.firstElementChild as HTMLElement;
  window.scrollTo({ top: 400 });
  await screen.rerender(createElement(Box, { take }));
  await settled();
  const was = box().getBoundingClientRect().top;
  whole.style.height = `${window.innerHeight + 100}px`;
  onTestFinished(() => whole.removeAttribute("style"));
  expect(box().getBoundingClientRect().top).toBeGreaterThan(was + 100);
  box().click();
  expect(take).not.toHaveBeenCalled();
});
