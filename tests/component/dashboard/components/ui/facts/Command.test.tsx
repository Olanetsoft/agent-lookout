import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { Command } from "@dashboard/components/ui/facts/Command";
import { piecesDrawn } from "@tests/support/browser/lines";

/** The command, in a box of the test's own width. */
async function commandIn(text: string) {
  const screen = await render(
    <div>
      <Command>{text}</Command>
    </div>,
  );
  const box = screen.container.firstElementChild as HTMLElement;
  return { box, command: box.firstElementChild as HTMLElement };
}

test("a command is a literal block of its own, in the mono, copied whole", async () => {
  const text = "claude plugin install agent-lookout@agent-lookout";
  const { command } = await commandIn(text);
  expect(command.tagName).toBe("CODE");
  expect(command.dataset.slot).toBe("fact");
  expect(command.dataset.part).toBe("command");
  expect(command.textContent).toBe(text);
  expect(command.querySelector('[data-slot="literal"]')?.textContent).toBe(text);
  const style = getComputedStyle(command);
  expect(style.display).toBe("block");
  expect(style.fontFamily).toMatch(/Mono/);
  expect(style.userSelect).toBe("all");
  expect(style.overflowWrap).toBe("break-word");
});

test("on a narrow width it breaks only between its words, and never runs past its box", async () => {
  const text = "claude plugin marketplace add Olanetsoft/agent-lookout";
  const { box, command } = await commandIn(text);
  for (const width of [120, 160, 200, 260]) {
    box.style.width = `${width}px`;
    expect(command.scrollWidth, `${width}px`).toBeLessThanOrEqual(command.clientWidth);
    expect(box.scrollWidth, `${width}px`).toBeLessThanOrEqual(box.clientWidth);
    // A word longer than a whole line may break inside itself; the rest stay whole.
    const broken = piecesDrawn(command, /\S+/g)
      .filter(({ lines }) => lines > 1)
      .map(({ piece }) => piece);
    expect(
      broken.every((piece) => piece.includes("/")),
      `${width}px`,
    ).toBe(true);
  }
});
