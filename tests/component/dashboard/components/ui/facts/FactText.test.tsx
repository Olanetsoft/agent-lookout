import { expect, test } from "vitest";
import { render } from "vitest-browser-react";

import { FactText } from "@dashboard/components/ui/facts/FactText";

test("the machine facts in a sentence are set in mono, and the words are not", async () => {
  const screen = await render(
    <p data-testid='sentence' className='text-body'>
      <FactText>
        Listed by claude agents --json, with apps and status times from ~/.claude/sessions.
      </FactText>
    </p>,
  );
  const sentence = screen.getByTestId("sentence").element();
  const facts = [...sentence.querySelectorAll("code")];

  expect(facts.map((fact) => fact.textContent)).toEqual([
    "claude agents --json",
    "~/.claude/sessions",
  ]);
  for (const fact of facts) {
    const style = getComputedStyle(fact);
    expect(style.fontFamily).toMatch(/^"?Atkinson Hyperlegible Mono/);
    // Half a pixel under the 13px words beside it, because the mono sets wide.
    expect(style.fontSize).toBe("12.5px");
    expect(style.letterSpacing).toBe(`${-0.02 * 12.5}px`);
  }
  expect(getComputedStyle(sentence).fontFamily).toMatch(/^"?Atkinson Hyperlegible Next/);
  expect(getComputedStyle(sentence).fontSize).toBe("13px");
  expect(sentence.textContent).toBe(
    "Listed by claude agents --json, with apps and status times from ~/.claude/sessions.",
  );
});
