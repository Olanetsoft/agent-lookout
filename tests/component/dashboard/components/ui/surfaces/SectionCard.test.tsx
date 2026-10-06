import { afterEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { SectionCard } from "@dashboard/components/ui/surfaces/SectionCard";
import { rgbOf } from "@tests/support/browser/colours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/** A shadow token as the browser computes it on an element. */
function shadowOf(expression: string): string {
  const element = document.createElement("div");
  element.style.boxShadow = expression;
  document.body.append(element);
  const value = getComputedStyle(element).boxShadow;
  element.remove();
  return value;
}

test.each(["dark", "light"] as const)(
  "in the %s theme a card is glass at card height: its tint, its rim, its shadow and 24px corners, with no border and no blur",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <SectionCard title='Sessions'>
        <p>body</p>
      </SectionCard>,
    );
    const card = screen.getByRole("region", { name: "Sessions" });
    const element = card.element();
    const style = getComputedStyle(element);

    await expect.element(card).toBeVisible();
    expect(element.classList.contains("glass-card")).toBe(true);
    expect(style.backgroundColor).toBe(rgbOf("var(--glass-card)"));
    expect(style.boxShadow).toBe(shadowOf("var(--elev-2)"));
    expect(style.borderTopWidth).toBe("0px");
    expect(style.borderRadius).toBe("24px");
    expect(style.backdropFilter).toBe("none");
    // The rim of light is drawn by its own layer.
    expect(getComputedStyle(element, "::before").backgroundImage).toMatch(/linear-gradient/);
    // What the body draws is clipped to the corners.
    expect(style.overflow).toBe("hidden");
  },
);

test("a card is labelled by its title, with its count beside it, a quiet word after it and a slot on the right", async () => {
  const screen = await render(
    <div style={{ width: 600 }}>
      <SectionCard title='Timeline' count={8} sub='last hour' aside={<span>Legend</span>}>
        <p>body</p>
      </SectionCard>
    </div>,
  );

  // The count is beside the title, not in it, so the card's name stays the same.
  await expect.element(screen.getByRole("region", { name: "Timeline", exact: true })).toBeVisible();
  const title = screen.getByRole("heading", { level: 2, name: "Timeline" });
  expect(getComputedStyle(title.element()).fontSize).toBe("15px");
  expect(getComputedStyle(title.element()).fontWeight).toBe("600");

  const count = screen.container.querySelector('[data-part="count"]') as HTMLElement;
  const sub = screen.container.querySelector('[data-part="sub"]') as HTMLElement;
  const aside = screen.container.querySelector('[data-part="aside"]') as HTMLElement;
  expect(count.textContent).toBe("8");
  expect(getComputedStyle(count).fontVariantNumeric).toBe("tabular-nums");
  expect(getComputedStyle(count).color).toBe(rgbOf("var(--ink-muted)"));
  expect(sub.textContent).toBe("last hour");
  expect(getComputedStyle(sub).color).toBe(rgbOf("var(--ink-muted)"));
  expect(count.getBoundingClientRect().left).toBeGreaterThan(
    title.element().getBoundingClientRect().right,
  );
  expect(sub.getBoundingClientRect().left).toBeGreaterThan(count.getBoundingClientRect().right);
  expect(aside.textContent).toBe("Legend");
  expect(aside.getBoundingClientRect().right).toBeGreaterThan(sub.getBoundingClientRect().right);
});

test("only the head is inset: the body runs to the card's edges and owns its own inset", async () => {
  const screen = await render(
    <div style={{ width: 600 }}>
      <SectionCard title='Sessions'>
        <div data-testid='body'>body</div>
      </SectionCard>
    </div>,
  );
  const card = screen.getByRole("region", { name: "Sessions" }).element().getBoundingClientRect();
  const title = screen.getByRole("heading", { name: "Sessions" }).element().getBoundingClientRect();
  const body = screen.getByTestId("body").element().getBoundingClientRect();

  // 24px in, with no border to step over.
  expect(title.left - card.left).toBe(24);
  expect(body.left - card.left).toBe(0);
  expect(card.right - body.right).toBe(0);
});
