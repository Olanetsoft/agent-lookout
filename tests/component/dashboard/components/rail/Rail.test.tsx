import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Rail } from "@dashboard/components/rail/Rail";
import type { ViewId } from "@dashboard/lib/view";
import { rgbOf, warmPaint } from "@tests/support/colours";

beforeEach(async () => {
  await page.viewport(1280, 900);
});

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

const links = (container: HTMLElement) => [
  ...container.querySelectorAll<HTMLAnchorElement>('[data-slot="rail-link"]'),
];

test("the rail is a 76px navigation of three views on chrome glass with no blur, each a link to its own address", async () => {
  const screen = await render(<Rail current='overview' needsYou={0} />);
  const nav = screen.getByRole("navigation", { name: "Views" });

  await expect.element(nav).toBeVisible();
  expect(nav.element().getBoundingClientRect().width).toBe(76);
  // The thinnest glass, at the chrome's corners, with no blur: nothing passes behind it.
  const style = getComputedStyle(nav.element());
  expect(style.backgroundColor).toBe(rgbOf("var(--glass-chrome)"));
  expect(style.borderRadius).toBe("22px");
  expect(style.backdropFilter).toBe("none");
  expect(getComputedStyle(nav.element(), "::before").backgroundImage).toMatch(/linear-gradient/);
  expect(
    links(screen.container).map((link) => [link.textContent, link.getAttribute("href")]),
  ).toEqual([
    ["Overview", "#overview"],
    ["Sources", "#sources"],
    ["Settings", "#settings"],
  ]);
  for (const name of ["Overview", "Sources", "Settings"]) {
    await expect.element(screen.getByRole("link", { name, exact: true })).toBeVisible();
  }
  // Every one has its icon above its word.
  for (const link of links(screen.container)) {
    const icon = link.querySelector("svg") as SVGSVGElement;
    expect(icon.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      (link.querySelector("span") as HTMLElement).getBoundingClientRect().top,
    );
  }
  // Nothing in it is a dialog trigger: a view is a place, not a panel.
  expect(nav.element().querySelector("[aria-haspopup], [aria-expanded], button")).toBeNull();
});

test.each(["overview", "sources", "settings"] as const)(
  "on %s, that view alone is the current page, marked in more than one way",
  async (current: ViewId) => {
    const screen = await render(<Rail current={current} needsYou={0} />);
    const all = links(screen.container);
    const here = all.find((link) => link.dataset.view === current) as HTMLAnchorElement;
    const others = all.filter((link) => link !== here);

    expect(all.filter((link) => link.getAttribute("aria-current") === "page")).toEqual([here]);
    // A lit rounded selection: the selected fill inside the control's rim, with a
    // light along its top, and full-strength words. Not a line on its edge.
    const style = getComputedStyle(here);
    expect(style.color).toBe(rgbOf("var(--ink)"));
    expect(style.backgroundColor).toBe(rgbOf("var(--fill-selected)"));
    expect(style.borderRadius).toBe("14px");
    expect(style.boxShadow).toContain(`${rgbOf("var(--control-rim)")} 0px 0px 0px 1px inset`);
    expect(style.boxShadow).toContain(`${rgbOf("var(--control-top)")} 0px 1px 0px 0px inset`);
    expect(getComputedStyle(here, "::before").content).toBe("none");
    for (const other of others) {
      expect(getComputedStyle(other).color).toBe(rgbOf("var(--ink-secondary)"));
      expect(getComputedStyle(other).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(other).boxShadow).toBe("none");
    }
  },
);

test.each(["dark", "light"] as const)(
  "in the %s theme the lamp in the mark is lit only while a session needs the person",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(<Rail current='overview' needsYou={0} />);
    const mark = () => screen.container.querySelector('[data-slot="rail-mark"]') as HTMLElement;
    const lamp = () => mark().querySelector('[data-part="lamp"]') as SVGCircleElement;

    // Nothing waiting: a hollow ring in the ink colour, and no warm colour in the rail.
    expect(mark().dataset.lit).toBe("false");
    expect(mark().querySelector('[data-slot="lookout-mark"]')?.getAttribute("data-lit")).toBe(
      "false",
    );
    expect(getComputedStyle(lamp()).fill).toBe("none");
    expect(getComputedStyle(lamp()).stroke).toBe(rgbOf("var(--ink)"));
    expect(mark().querySelector('[data-part="glint"]')).toBeNull();
    expect(warmPaint(screen.container)).toEqual([]);

    await screen.rerender(<Rail current='overview' needsYou={1} />);
    expect(mark().dataset.lit).toBe("true");
    expect(getComputedStyle(lamp()).fill).toBe(rgbOf("var(--status-needs-you)"));
    expect(getComputedStyle(lamp()).stroke).toBe(rgbOf("var(--status-needs-you-edge)"));
    expect(mark().querySelector('[data-part="glint"]')).not.toBeNull();
    // The lamp, and only the lamp and its glint, are warm.
    const warm = warmPaint(screen.container);
    expect(warm.length).toBeGreaterThan(0);
    expect(warm.every((line) => /<circle lamp>|<path glint>/.test(line))).toBe(true);

    // Before the first answer nothing is known: it is out. (Once answers stop, the
    // page passes the last count, so it keeps it.)
    await screen.rerender(<Rail current='overview' needsYou={null} />);
    expect(mark().dataset.lit).toBe("false");
    expect(warmPaint(screen.container)).toEqual([]);
  },
);

test("the mark links to the Overview, and says how many sessions need the person", async () => {
  const screen = await render(<Rail current='sources' needsYou={0} />);
  const mark = () => screen.container.querySelector('[data-slot="rail-mark"]') as HTMLElement;

  expect(mark().getAttribute("href")).toBe("#overview");
  await expect
    .element(screen.getByRole("link", { name: "Agent Lookout, no session needs you" }))
    .toBeVisible();

  await screen.rerender(<Rail current='sources' needsYou={1} />);
  await expect
    .element(screen.getByRole("link", { name: "Agent Lookout, 1 session needs you" }))
    .toBeVisible();

  await screen.rerender(<Rail current='sources' needsYou={3} />);
  await expect
    .element(screen.getByRole("link", { name: "Agent Lookout, 3 sessions need you" }))
    .toBeVisible();

  await screen.rerender(<Rail current='sources' needsYou={null} />);
  await expect
    .element(screen.getByRole("link", { name: "Agent Lookout", exact: true }))
    .toBeVisible();
});

test("an unselected view lights under the pointer, with the hover fill", async () => {
  const screen = await render(<Rail current='overview' needsYou={0} />);
  const sources = links(screen.container).find((link) => link.dataset.view === "sources")!;

  await screen.getByRole("link", { name: "Sources", exact: true }).hover();
  await vi.waitFor(() =>
    expect(getComputedStyle(sources).backgroundColor).toBe(rgbOf("var(--fill-hover)")),
  );
  await vi.waitFor(() => expect(getComputedStyle(sources).color).toBe(rgbOf("var(--ink)")));
});

test("in a narrow window the rail narrows to its icons and stays, and each view keeps its name", async () => {
  await page.viewport(375, 800);
  const screen = await render(<Rail current='overview' needsYou={0} />);
  const nav = screen.getByRole("navigation", { name: "Views" }).element();

  expect(nav.getBoundingClientRect().width).toBe(56);
  for (const name of ["Overview", "Sources", "Settings"]) {
    const link = screen.getByRole("link", { name, exact: true });
    await expect.element(link).toBeInTheDocument();
    // The word is there for assistive technology, and out of sight.
    const word = link.element().querySelector("span") as HTMLElement;
    expect(
      word.classList.contains("sr-only") || getComputedStyle(word).position === "absolute",
    ).toBe(true);
    expect(link.element().getBoundingClientRect().width).toBeLessThanOrEqual(56);
  }
});

test("the rail's contents stay in view on a long page, and nothing in it moves", async () => {
  const screen = await render(
    <div style={{ display: "flex" }}>
      <Rail current='overview' needsYou={1} />
      <div style={{ height: 3000 }} />
    </div>,
  );
  const inner = screen.container.querySelector('[data-slot="rail-mark"]')
    ?.parentElement as HTMLElement;

  expect(getComputedStyle(inner).position).toBe("sticky");
  window.scrollTo(0, 1200);
  // It keeps the window's inset from the top, as the header does.
  await expect.poll(() => inner.getBoundingClientRect().top, { timeout: 2_000 }).toBeCloseTo(12, 0);
  window.scrollTo(0, 0);
  expect(screen.container.getAnimations({ subtree: true })).toHaveLength(0);
});
