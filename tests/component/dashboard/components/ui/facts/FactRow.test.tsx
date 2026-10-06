import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { FactList, FactRow } from "@dashboard/components/ui/facts/FactRow";

test("a row is its label at the left and its value at the right, on one line", async () => {
  const screen = await render(
    <div style={{ width: 300 }}>
      <FactList>
        <FactRow label='Registry read'>every 2 seconds</FactRow>
      </FactList>
    </div>,
  );
  const row = screen.container.querySelector('[data-slot="fact-row"]') as HTMLElement;
  const [label, value] = [row.querySelector("dt"), row.querySelector("dd")] as HTMLElement[];

  expect(row.querySelectorAll("dd")).toHaveLength(1);
  expect(label?.getBoundingClientRect().top).toBe(value?.getBoundingClientRect().top);
  expect(value?.getBoundingClientRect().right).toBe(row.getBoundingClientRect().right);
});

test("a note is a line of its own under the pair, across the whole row, in the caption size", async () => {
  const note = "Only background jobs. Any other session leaves the list when it ends.";
  const screen = await render(
    <div style={{ width: 240 }}>
      <FactList>
        <FactRow label='Finished' note={note}>
          Partly
        </FactRow>
      </FactList>
    </div>,
  );
  const row = screen.container.querySelector('[data-slot="fact-row"]') as HTMLElement;
  const [label, value, said] = [...row.children] as HTMLElement[];

  expect([label?.tagName, value?.tagName, said?.tagName]).toEqual(["DT", "DD", "DD"]);
  expect(said?.textContent).toBe(note);
  // The pair keeps its two sides.
  expect(label?.getBoundingClientRect().top).toBe(value?.getBoundingClientRect().top);
  expect(value?.getBoundingClientRect().right).toBe(row.getBoundingClientRect().right);
  // The note starts under both, at the row's left, and takes its whole width.
  const box = (said as HTMLElement).getBoundingClientRect();
  expect(box.top).toBeGreaterThanOrEqual((label as HTMLElement).getBoundingClientRect().bottom);
  expect(box.left).toBe(row.getBoundingClientRect().left);
  expect(box.width).toBe(row.getBoundingClientRect().width);
  expect(getComputedStyle(said as HTMLElement).fontSize).toBe("12px");
  expect(getComputedStyle(said as HTMLElement).textAlign).toBe("start");
});
