import { createElement } from "react";
import { expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useOverflows } from "@dashboard/hooks/dom/useOverflows";

// Runs in the component project because it measures boxes the browser lays out.

const LINE = "every word of this line takes room";

/**
 * A box at most 60px tall, of the width given, that says whether what is in it
 * overflows. With `lines`, each line break in the text starts a line.
 */
function Box({
  text,
  width,
  lines = false,
  lineHeight = 20,
}: {
  text: string;
  width: number;
  lines?: boolean;
  lineHeight?: number;
}) {
  const [ref, overflows] = useOverflows<HTMLDivElement>(text);
  return createElement(
    "div",
    {
      ref,
      "data-testid": "box",
      "data-overflows": String(overflows),
      style: {
        maxHeight: "60px",
        overflowY: "auto",
        width: `${width}px`,
        lineHeight: `${lineHeight}px`,
      },
    },
    createElement("p", { style: { margin: 0, whiteSpace: lines ? "pre-line" : "normal" } }, text),
  );
}

const box = () => page.getByTestId("box");

/** Two frames, so the observer's first notice of a box has come and gone. */
const frames = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

test("new text that runs past the box overflows, and text that fits again does not", async () => {
  const screen = await render(createElement(Box, { text: "short", width: 400 }));
  await expect.element(box()).toHaveAttribute("data-overflows", "false");

  await screen.rerender(createElement(Box, { text: Array(8).fill(LINE).join("\n"), width: 400 }));
  await expect.element(box()).toHaveAttribute("data-overflows", "true");

  await screen.rerender(createElement(Box, { text: "short again", width: 400 }));
  await expect.element(box()).toHaveAttribute("data-overflows", "false");
});

test("the same text overflows once the box is narrowed enough that it wraps onto more lines, and stops once widened", async () => {
  const text = `${LINE} ${LINE}`;
  const screen = await render(createElement(Box, { text, width: 600 }));
  await expect.element(box()).toHaveAttribute("data-overflows", "false");

  await screen.rerender(createElement(Box, { text, width: 80 }));
  await expect.element(box()).toHaveAttribute("data-overflows", "true");

  await screen.rerender(createElement(Box, { text, width: 600 }));
  await expect.element(box()).toHaveAttribute("data-overflows", "false");
});

test("with the box already at its full height, a line more overflows, and so does a taller line", async () => {
  const three = Array(3).fill(LINE).join("\n");
  const screen = await render(createElement(Box, { text: three, width: 400, lines: true }));
  // Three lines of 20px fill the 60px box exactly.
  await expect.element(box()).toHaveAttribute("data-overflows", "false");

  // The box stays 60px tall: only what is in it grows.
  await screen.rerender(createElement(Box, { text: `${three}\n${LINE}`, width: 400, lines: true }));
  await expect.element(box()).toHaveAttribute("data-overflows", "true");

  await screen.rerender(createElement(Box, { text: three, width: 400, lines: true }));
  await expect.element(box()).toHaveAttribute("data-overflows", "false");

  // The same text, so only the watch on what is in the box sees it grow.
  await frames();
  await screen.rerender(
    createElement(Box, { text: three, width: 400, lines: true, lineHeight: 24 }),
  );
  await expect.element(box()).toHaveAttribute("data-overflows", "true");
});
