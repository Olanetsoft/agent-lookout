import { afterEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { Callout } from "@dashboard/components/ui/feedback/Callout";
import { EmptyState } from "@dashboard/components/ui/feedback/EmptyState";
import { Loading } from "@dashboard/components/ui/feedback/Loading";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test("the three states cannot be mistaken for one another", async () => {
  const screen = await render(
    <div>
      <Loading label='Reading sessions' />
      <EmptyState title='No agents are running'>Nothing is wrong.</EmptyState>
      <Callout tone='error' title='Agent Lookout is not answering'>
        Check that it is still running.
      </Callout>
    </div>,
  );

  // Waiting is a status with a spinner. A failure is an alert in a filled box
  // with an ink edge and an icon. Empty is neither: plain centred words.
  const loading = screen.getByRole("status");
  const error = screen.getByRole("alert");
  await expect.element(loading).toHaveTextContent("Reading sessions");
  await expect.element(error).toHaveTextContent("Agent Lookout is not answering");

  const empty = screen.container.querySelector('[data-slot="empty-state"]');
  expect(empty?.getAttribute("role")).toBeNull();
  expect(empty?.querySelector('[role="alert"], [role="status"]')).toBeNull();

  const errorBox = getComputedStyle(error.element());
  const emptyBox = getComputedStyle(empty as Element);
  expect(errorBox.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(emptyBox.backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(emptyBox.borderTopWidth).toBe("0px");
  expect(emptyBox.textAlign).toBe("center");
  expect(emptyBox.boxShadow).toBe("none");
  expect(empty?.querySelector("svg")).toBeNull();
  expect(error.element().querySelector("svg")).not.toBeNull();
  // The spinner is the open ring of the marks: the strong rule, with one quarter in ink.
  const ring = loading.element().querySelector(".animate-spin-loader") as HTMLElement;
  expect(getComputedStyle(ring).borderRightColor).toBe(rgbOf("var(--rule-strong)"));
  expect(getComputedStyle(ring).borderTopColor).toBe(rgbOf("var(--ink-secondary)"));
  expect(getComputedStyle(ring).borderRadius).toBe("999px");
  expect(getComputedStyle(loading.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(loading.element().querySelector(".animate-spin-loader")).not.toBeNull();
  expect(error.element().querySelector(".animate-spin-loader")).toBeNull();
  expect(empty?.querySelector(".animate-spin-loader")).toBeNull();
});

test("a title id names the title, so a row inside can be labelled by it", async () => {
  const screen = await render(
    <Callout title='Keep the window open?' titleId='keep-title'>
      <div role='group' aria-labelledby='keep-title'>
        <button type='button'>Keep</button>
      </div>
    </Callout>,
  );
  const group = screen.getByRole("group", { name: "Keep the window open?" });
  await expect.element(group).toBeVisible();
  expect(document.getElementById("keep-title")?.textContent).toBe("Keep the window open?");
});

test("an info callout is a status, not an alert", async () => {
  const screen = await render(<Callout title='Claude Code was not found'>Install it.</Callout>);

  await expect.element(screen.getByRole("status")).toHaveTextContent("Claude Code was not found");
  expect(screen.container.querySelector('[role="alert"]')).toBeNull();
});

test("a callout that is not live has no role, so a line of its own can say its words once", async () => {
  const screen = await render(
    <div>
      <Callout title='Claude Code was not found' live={false}>
        Install it.
      </Callout>
      <Callout tone='error' title='Claude Code could not be read' live={false}>
        It keeps trying.
      </Callout>
    </div>,
  );

  const callouts = [...screen.container.querySelectorAll('[data-slot="callout"]')];
  expect(callouts).toHaveLength(2);
  for (const callout of callouts) expect(callout.getAttribute("role")).toBeNull();
  expect(screen.container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  // It looks the same: only what is announced changes.
  expect(callouts.map((callout) => (callout as HTMLElement).dataset.tone)).toEqual([
    "info",
    "error",
  ]);
});

test.each(["dark", "light"] as const)(
  "in the %s theme info and error differ by edge, icon and role, and neither is warm",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <div>
        <Callout title='Claude Code was not found'>Install it.</Callout>
        <Callout tone='error' title='Claude Code could not be read'>
          It keeps trying.
        </Callout>
      </div>,
    );
    const info = screen.getByRole("status").element();
    const error = screen.getByRole("alert").element();
    const infoStyle = getComputedStyle(info);
    const errorStyle = getComputedStyle(error);

    // Info: a quiet note on the quiet fill, inside a hairline, with a muted icon.
    expect(infoStyle.backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
    expect(infoStyle.boxShadow).toContain(`${rgbOf("var(--hairline)")} 0px 0px 0px 1px inset`);
    expect(infoStyle.boxShadow).not.toContain(" 3px 0px 0px 0px inset");
    expect(getComputedStyle(info.querySelector("svg")!).color).toBe(rgbOf("var(--ink-muted)"));

    // Error: the selected fill inside the strong rule, with a 3px ink edge down its
    // leading side.
    expect(errorStyle.backgroundColor).toBe(rgbOf("var(--fill-selected)"));
    expect(errorStyle.boxShadow).toContain(`${rgbOf("var(--rule-strong)")} 0px 0px 0px 1px inset`);
    expect(errorStyle.boxShadow).toContain(`${rgbOf("var(--ink)")} 3px 0px 0px 0px inset`);
    expect(errorStyle.borderLeftWidth).toBe("0px");
    expect(getComputedStyle(error.querySelector("svg")!).color).toBe(rgbOf("var(--ink)"));

    // A different icon, not the same one in another colour, and the inner corners
    // of something laid on a panel.
    expect(info.querySelector("svg")?.innerHTML).not.toBe(error.querySelector("svg")?.innerHTML);
    for (const box of [infoStyle, errorStyle]) {
      expect(box.borderRadius).toBe("14px");
      expect(box.borderTopWidth).toBe("0px");
    }

    // No red, no amber: the lamp's colour belongs to a session that needs the person.
    expect(warmPaint(screen.container)).toEqual([]);
  },
);
