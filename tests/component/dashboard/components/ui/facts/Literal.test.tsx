import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { Literal } from "@dashboard/components/ui/facts/Literal";
import { linesDrawn, piecesDrawn } from "@tests/support/browser/lines";

/** The literal, in the mono at the fact size, in a box of the test's own width. */
async function literalIn(text: string) {
  const screen = await render(
    <div className='font-mono text-fact'>
      <Literal>{text}</Literal>
    </div>,
  );
  const box = screen.container.firstElementChild as HTMLElement;
  return { box, literal: box.firstElementChild as HTMLElement };
}

test("a command breaks only between its words, at every width, and reads as it was given", async () => {
  const command = "claude agents --json --all";
  const { box, literal } = await literalIn(command);
  expect(literal.textContent).toBe(command);
  expect(literal.innerText).toBe(command);

  // Every width from a word's own to the whole command's: no line starts or
  // ends inside a word, so a flag never loses a hyphen to the line before.
  const widest = literal.getBoundingClientRect().width;
  let wrapped = 0;
  for (let width = 50; width <= Math.ceil(widest) + 1; width += 1) {
    box.style.width = `${width}px`;
    expect(
      piecesDrawn(literal, /\S+/g).filter(({ lines }) => lines > 1),
      `${width}px`,
    ).toEqual([]);
    if (linesDrawn(literal) > 1) wrapped += 1;
    expect(box.scrollWidth, `${width}px`).toBeLessThanOrEqual(box.clientWidth);
  }
  // And most of those widths did break it.
  expect(wrapped).toBeGreaterThan(50);
});

test("a path breaks only after a slash, never on the first slash alone, and never at a hyphen", async () => {
  const path = "/Users/example/code/agent-lookout-demo/sessions";
  const { box, literal } = await literalIn(path);
  expect(literal.textContent).toBe(path);

  const widest = literal.getBoundingClientRect().width;
  for (let width = 160; width <= Math.ceil(widest) + 1; width += 1) {
    box.style.width = `${width}px`;
    expect(
      piecesDrawn(literal, /\/?[^/]+\/?/g).filter(({ lines }) => lines > 1),
      `${width}px`,
    ).toEqual([]);
  }
  // A path's first "/", and a home folder's "~/", stay with the name after them.
  const words = (element: Element) =>
    [...element.querySelectorAll('[data-part="word"]')].map((word) => word.textContent);
  expect(words(literal)).toEqual([
    "/Users/",
    "example/",
    "code/",
    "agent-lookout-demo/",
    "sessions",
  ]);
  const { literal: home } = await literalIn("~/.claude/sessions and ./dist");
  expect(words(home)).toEqual(["~/.claude/", "sessions", "and", "./dist"]);
});

test("a word longer than a whole line breaks inside itself rather than run past its box", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const { box, literal } = await literalIn(`claude --resume ${id}`);
  box.style.width = "120px";

  expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  expect(literal.getBoundingClientRect().right).toBeLessThanOrEqual(
    box.getBoundingClientRect().right + 0.5,
  );
  // The words that fit stay whole; only the ID is broken.
  expect(piecesDrawn(literal, /\S+/g).map(({ piece, lines }) => [piece, lines > 1])).toEqual([
    ["claude", false],
    ["--resume", false],
    [id, true],
  ]);
});
