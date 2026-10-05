import { afterEach, expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { Badge } from "@dashboard/components/ui/status/Badge";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

test.each(["dark", "light"] as const)(
  "in the %s theme a badge is a capsule: a fact on the quiet fill inside the control rim, or a caution inside the strong rule alone",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <div>
        <Badge data-testid='neutral'>VS Code</Badge>
        <Badge data-testid='outline' tone='outline'>
          Process ended
        </Badge>
      </div>,
    );
    const neutral = getComputedStyle(screen.getByTestId("neutral").element());
    const outline = getComputedStyle(screen.getByTestId("outline").element());

    for (const style of [neutral, outline]) {
      expect(style.borderRadius).toBe("999px");
      expect(style.height).toBe("20px");
      expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
      expect(style.fontSize).toBe("12px");
      expect(style.fontWeight).toBe("500");
      expect(style.color).toBe(rgbOf("var(--ink-secondary)"));
      // Its edge is drawn inside it, not as a border.
      expect(style.borderTopWidth).toBe("0px");
    }
    expect(neutral.backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
    expect(neutral.boxShadow).toContain(`${rgbOf("var(--control-rim)")} 0px 0px 0px 1px inset`);
    expect(outline.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(outline.boxShadow).toContain(`${rgbOf("var(--rule-strong)")} 0px 0px 0px 1px inset`);
    // Neither tone borrows the lamp's colour.
    expect(warmPaint(screen.container)).toEqual([]);
  },
);
