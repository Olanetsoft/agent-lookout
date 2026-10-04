import { expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ErrorBoundary } from "@dashboard/components/ui/ErrorBoundary";
import { rgbOf, warmPaint } from "@tests/support/colours";

test("when drawing fails, the page says so in the error presentation and can try again", async () => {
  const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
  let broken = true;
  function Fragile() {
    if (broken) throw new Error("Cannot read properties of undefined (reading 'open')");
    return <p>Drawn</p>;
  }
  const screen = await render(
    <ErrorBoundary>
      <Fragile />
    </ErrorBoundary>,
  );

  // An alert in the error presentation, on a glass card: not an empty page, not
  // a spinner, not an empty state.
  const alert = screen.getByRole("alert");
  await expect.element(alert).toHaveTextContent("Agent Lookout could not draw this page");
  await expect.element(alert).toHaveTextContent("reload the page");
  expect(getComputedStyle(alert.element()).backgroundColor).toBe(rgbOf("var(--fill-selected)"));
  expect(getComputedStyle(alert.element()).boxShadow).toContain(
    `${rgbOf("var(--ink)")} 3px 0px 0px 0px inset`,
  );
  const card = getComputedStyle(screen.getByRole("region", { name: "Page problem" }).element());
  expect(card.backgroundColor).toBe(rgbOf("var(--glass-card)"));
  expect(card.borderRadius).toBe("24px");
  expect(card.borderTopWidth).toBe("0px");
  expect(warmPaint(screen.container)).toEqual([]);
  await expect
    .element(screen.getByText("Cannot read properties of undefined (reading 'open')"))
    .toBeVisible();
  expect(screen.container.querySelector('[data-slot="loading"]')).toBeNull();
  expect(screen.container.textContent).not.toBe("");

  // Still broken: trying again says so again.
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();

  broken = false;
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect.element(screen.getByText("Drawn")).toBeVisible();
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
  quiet.mockRestore();
});
