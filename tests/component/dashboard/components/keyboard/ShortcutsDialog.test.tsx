import { useState } from "react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ShortcutsDialog } from "@dashboard/components/keyboard/ShortcutsDialog";
import { Button } from "@dashboard/components/ui/controls/Button";
import { startAtTop } from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

/** A page with a button that opens the sheet. */
function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ padding: 40 }}>
      <Button onClick={() => setOpen(true)}>Open shortcuts</Button>
      <ShortcutsDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Says the page runs on this platform, until the test finishes. */
function platform(name: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(name);
}

const sheet = () => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const rows = () => [...sheet().element().querySelectorAll<HTMLElement>('[data-slot="fact-row"]')];
/** A key as it reads to the eye, with each sign drawn as an icon read as the sign. */
const drawn = (key: Element) => {
  const shown = key.querySelector("[aria-hidden]") ?? key;
  return [...shown.childNodes]
    .map((node) => (node instanceof SVGElement ? node.dataset.sign : node.textContent))
    .join("");
};
/** Each row as it reads to the eye: what it does, then its keys. */
const seen = () =>
  rows().map((row) => [
    row.querySelector("dt")?.textContent,
    [...row.querySelectorAll("dd kbd")].map(drawn).join(" "),
  ]);

async function openSheet() {
  const screen = await render(<Harness />);
  startAtTop();
  await userEvent.tab();
  await userEvent.keyboard("{Enter}");
  await expect.element(sheet()).toBeVisible();
  return screen;
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
});

test("on a Mac the sheet lists every shortcut in groups, as rows of facts, with ⌘K for the search", async () => {
  platform("MacIntel");
  await openSheet();

  await expect
    .element(sheet())
    .toHaveAccessibleDescription("/ and ? work wherever you are not typing.");
  const headings = [...sheet().element().querySelectorAll("h3")].map((h) => h.textContent);
  expect(headings).toEqual([
    "On every view",
    "In the search",
    "In a chart or the timeline",
    "In a switch",
  ]);
  expect(seen()).toEqual([
    ["Find a session", "/ ⌘K"],
    ["Show these shortcuts", "?"],
    ["Close a dialog", "Esc"],
    ["Move through the sessions", "↑ ↓"],
    ["Jump to the session, or show it", "Enter"],
    ["Move along it", "← →"],
    ["Go to the first or the last", "Home End"],
    ["Ten steps in a history chart", "Page Up Page Down"],
    ["Choose the next or the previous option", "← →"],
  ]);
  // Two keys that do the same are joined by "or".
  expect(rows()[0]!.querySelector("dd")?.textContent).toBe("/ or KCommand K");
});

test("away from a Mac the search's key is Ctrl+K", async () => {
  platform("Win32");
  await openSheet();

  expect(seen()[0]).toEqual(["Find a session", "/ Ctrl+K"]);
  expect(sheet().element().textContent).not.toContain("⌘");
});

test("a key drawn as a sign is said in words, and the sign is kept from assistive technology", async () => {
  platform("MacIntel");
  await openSheet();

  const keys = [...sheet().element().querySelectorAll("kbd")];
  const said = keys.map((key) =>
    [...key.childNodes]
      .filter((node) => !(node instanceof HTMLElement && node.getAttribute("aria-hidden")))
      .map((node) => node.textContent)
      .join(""),
  );
  expect(said).toContain("Command K");
  expect(said).toContain("Up arrow");
  expect(said).toContain("Left arrow");
  expect(said).toContain("Escape");
  expect(said).toContain("Home");
  for (const key of keys) {
    const sign = key.querySelector("[aria-hidden]");
    if (sign) expect(key.querySelector(".sr-only")?.textContent, drawn(key)).toBeTruthy();
  }
});

test("a sign is drawn as an icon as large as the letters beside it, in the ink of the key", async () => {
  platform("MacIntel");
  await openSheet();

  const signs = [...sheet().element().querySelectorAll<SVGElement>("kbd svg")];
  expect(signs.map((sign) => sign.dataset.sign)).toEqual(["⌘", "↑", "↓", "←", "→", "←", "→"]);
  // No sign is left to a font that lacks it.
  expect(sheet().element().textContent).not.toMatch(/[⌘↑↓←→]/);
  for (const sign of signs) {
    expect(sign.getAttribute("aria-hidden")).toBe("true");
    const box = sign.getBoundingClientRect();
    expect([box.width, box.height]).toEqual([14, 14]);
    expect(sign.getAttribute("stroke-width")).toBe("1.75");
    expect(getComputedStyle(sign).color).toBe(rgbOf("var(--ink)"));
    // It sits on the line of the letters, not above or below them.
    const key = sign.closest("kbd")!.getBoundingClientRect();
    expect(box.top).toBeGreaterThanOrEqual(key.top - 2);
    expect(box.bottom).toBeLessThanOrEqual(key.bottom + 2);
  }
});

test.each(["dark", "light"] as const)(
  "in the %s theme the sheet is the small dialog of floating glass, its keys in the mono, and nothing in it is warm",
  async (theme) => {
    onTestFinished(() => page.viewport(414, 896));
    await page.viewport(1280, 900);
    document.documentElement.setAttribute("data-theme", theme);
    await openSheet();
    const element = sheet().element() as HTMLElement;

    expect(element.getAttribute("data-slot")).toBe("details-modal");
    expect(getComputedStyle(element).backgroundColor).toBe(rgbOf("var(--glass-float)"));
    expect(element.getBoundingClientRect().width).toBe(440);
    expect(warmPaint(element)).toEqual([]);

    const row = rows()[0]!;
    const label = row.querySelector("dt") as HTMLElement;
    expect(getComputedStyle(label).color).toBe(rgbOf("var(--ink-secondary)"));
    for (const key of row.querySelectorAll("kbd")) {
      const style = getComputedStyle(key);
      expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
      expect(style.fontSize).toBe("12.5px");
      expect(style.color).toBe(rgbOf("var(--ink)"));
    }
    // A hairline between rows, as in every list of facts.
    expect(getComputedStyle(row).borderBottomColor).toBe(rgbOf("var(--hairline)"));
    const heading = element.querySelector("h3") as HTMLElement;
    expect(getComputedStyle(heading).fontSize).toBe("12px");
    expect(getComputedStyle(heading).fontWeight).toBe("600");
  },
);

test("at the width of a phone nothing in the sheet runs past its edge", async () => {
  onTestFinished(() => page.viewport(414, 896));
  await page.viewport(375, 800);
  await openSheet();
  const element = sheet().element() as HTMLElement;
  const box = element.getBoundingClientRect();

  expect(box.width).toBe(343);
  for (const inside of element.querySelectorAll("*")) {
    expect(inside.getBoundingClientRect().right, inside.outerHTML.slice(0, 60)).toBeLessThanOrEqual(
      box.right,
    );
  }
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
});

test("it closes on Escape and gives focus back to what opened it", async () => {
  await openSheet();
  await userEvent.keyboard("{Escape}");
  await expect.element(sheet()).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Open shortcuts" })).toHaveFocus();
});
