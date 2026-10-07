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
  // The row is measured once its fonts are in, which on Windows can be after the first layout.
  await document.fonts.ready;
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
  // The row is measured once its fonts are in, which on Windows can be after the first layout.
  await document.fonts.ready;
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

test("a literal string that does not fit beside its label takes a line of its own under it, at the right", async () => {
  const screen = await render(
    <div style={{ width: 240 }}>
      <FactList>
        <FactRow label='Version' mono>
          v0.2.4
        </FactRow>
        <FactRow label='Registry folder' mono>
          /tmp/example-home/sessions
        </FactRow>
      </FactList>
    </div>,
  );
  await document.fonts.ready;
  const [short, long] = [...screen.container.querySelectorAll('[data-slot="fact-row"]')].map(
    (row) =>
      [row, row.querySelector("dt"), row.querySelector("dd")].map((element) =>
        (element as HTMLElement).getBoundingClientRect(),
      ),
  ) as DOMRect[][];

  // One that fits stays on the label's line, on its baseline.
  const [shortRow, shortLabel, shortValue] = short as DOMRect[];
  expect(shortValue?.top).toBeLessThan((shortLabel as DOMRect).bottom);
  expect(shortValue?.right).toBe(shortRow?.right);
  // One that does not goes under the label, 4px down, and still keeps to the right.
  const [longRow, longLabel, longValue] = long as DOMRect[];
  expect(longValue?.top).toBe((longLabel as DOMRect).bottom + 4);
  expect(longValue?.right).toBe(longRow?.right);
  expect(longValue?.width).toBeLessThanOrEqual((longRow as DOMRect).width);
  // Given as a string, it breaks as a literal does: after a slash, never at a hyphen.
  const value = screen.container.querySelectorAll("dd")[1] as HTMLElement;
  expect(value.querySelector('[data-slot="literal"]')?.textContent).toBe(
    "/tmp/example-home/sessions",
  );
});
