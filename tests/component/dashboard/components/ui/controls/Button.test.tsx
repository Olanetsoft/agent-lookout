import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Button } from "@dashboard/components/ui/controls/Button";
import {
  assistivePress,
  holdKey,
  middleOf,
  pointAway,
  pressAt,
  startAtTop,
} from "@tests/support/browser/browser";
import { rgbOf, warmPaint } from "@tests/support/browser/colours";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

/** An inset ring of 1px in this colour, as getComputedStyle writes it in a box shadow. */
const ring = (token: string) => `${rgbOf(`var(${token})`)} 0px 0px 0px 1px inset`;
/** A 1px light along the top edge, inside. */
const topLight = (token: string) => `${rgbOf(`var(${token})`)} 0px 1px 0px 0px inset`;

test.each(["dark", "light"] as const)(
  "in the %s theme a quiet button is a capsule of quiet fill with a rim and a top light, and only the needs-you variant is solid",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <div style={{ padding: 40 }}>
        <Button>Try now</Button>
        <Button variant='needs-you'>Jump</Button>
      </div>,
    );
    const quietButton = screen.getByRole("button", { name: "Try now" }).element();
    const quiet = getComputedStyle(quietButton);
    const lit = getComputedStyle(screen.getByRole("button", { name: "Jump" }).element());

    expect(quiet.backgroundColor).toBe(rgbOf("var(--fill-quiet)"));
    expect(quiet.boxShadow).toContain(ring("--control-rim"));
    expect(quiet.boxShadow).toContain(topLight("--control-top"));
    expect(quiet.borderTopWidth).toBe("0px");
    expect(quiet.color).toBe(rgbOf("var(--ink-secondary)"));
    expect(quiet.fontWeight).toBe("500");
    expect(warmPaint(quietButton)).toEqual([]);

    // The lamp's fill inside its edge, a white light along its top, the lamp's
    // glow under it, and dark words.
    expect(lit.backgroundColor).toBe(rgbOf("var(--status-needs-you)"));
    expect(lit.boxShadow).toContain(ring("--status-needs-you-edge"));
    expect(lit.boxShadow).toContain(topLight("--lit-top"));
    expect(lit.boxShadow).toContain(`${rgbOf("var(--glow-needs-you)")} 0px 8px 22px -8px`);
    expect(lit.color).toBe(rgbOf("var(--on-needs-you)"));
    expect(lit.fontWeight).toBe("600");

    // Both are 28px capsules.
    for (const style of [quiet, lit]) {
      expect(style.height).toBe("28px");
      expect(style.borderRadius).toBe("999px");
      expect(style.fontSize).toBe("13px");
    }
  },
);

test("the hero size is a 38px capsule with 14px words, for the Jump of a session that needs the person", async () => {
  const screen = await render(
    <div style={{ padding: 40 }}>
      <Button variant='needs-you' size='hero'>
        Jump
      </Button>
    </div>,
  );
  const style = getComputedStyle(screen.getByRole("button", { name: "Jump" }).element());

  expect(style.height).toBe("38px");
  expect(style.borderRadius).toBe("999px");
  expect(style.fontSize).toBe("14px");
});

test("a quiet button comes up to full strength under the pointer", async () => {
  const screen = await render(
    <div style={{ padding: 40 }}>
      <Button>Jump</Button>
    </div>,
  );
  const button = screen.getByRole("button", { name: "Jump" });
  const style = () => getComputedStyle(button.element());
  expect(style().backgroundColor).toBe(rgbOf("var(--fill-quiet)"));

  await button.hover();
  await vi.waitFor(() => expect(style().backgroundColor).toBe(rgbOf("var(--fill-selected)")));
  await vi.waitFor(() => expect(style().color).toBe(rgbOf("var(--ink)")));
  // Its rim stays: the fill and the words are what come up.
  expect(style().boxShadow).toContain(ring("--control-rim"));
});

test("a button reached by keyboard shows the focus ring, and a quiet one comes up as it does under the pointer", async () => {
  const screen = await render(
    <div style={{ padding: 40 }}>
      <Button>First</Button>
      <Button variant='needs-you'>Second</Button>
    </div>,
  );
  const first = screen.getByRole("button", { name: "First" });
  const second = screen.getByRole("button", { name: "Second" });
  const ringOf = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.outlineStyle, style.outlineWidth, style.outlineOffset, style.outlineColor];
  };
  const focusRing = ["solid", "2px", "2px", rgbOf("var(--focus)")];
  // Nothing is under the pointer, so any change is the keyboard's.
  await pointAway();

  startAtTop();
  await userEvent.tab();
  await expect.element(first).toHaveFocus();
  expect(ringOf(first.element())).toEqual(focusRing);
  await vi.waitFor(() =>
    expect(getComputedStyle(first.element()).backgroundColor).toBe(rgbOf("var(--fill-selected)")),
  );
  await vi.waitFor(() => expect(getComputedStyle(first.element()).color).toBe(rgbOf("var(--ink)")));

  await userEvent.tab();
  await expect.element(second).toHaveFocus();
  expect(ringOf(second.element())).toEqual(focusRing);
  // The one it left is quiet again.
  expect(getComputedStyle(first.element()).outlineStyle).toBe("none");
  await vi.waitFor(() =>
    expect(getComputedStyle(first.element()).backgroundColor).toBe(rgbOf("var(--fill-quiet)")),
  );
});

test("the icon size is a 28px circle", async () => {
  const screen = await render(
    <Button size='icon' aria-label='Close'>
      <span aria-hidden>×</span>
    </Button>,
  );
  const button = screen.getByRole("button", { name: "Close" }).element();
  const box = button.getBoundingClientRect();

  expect([box.width, box.height]).toEqual([28, 28]);
  expect(getComputedStyle(button).borderRadius).toBe("999px");
});

describe("where the next one comes up and takes focus as one is pressed", () => {
  /** Three buttons down a list, each of which leaves it when pressed. */
  function List({ onPress }: { onPress: (name: string) => void }) {
    const [names, setNames] = useState(["First", "Second", "Third"]);
    const list = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      if (names.length < 3) list.current?.querySelector("button")?.focus();
    }, [names]);
    return (
      <div ref={list} className='flex flex-col items-start gap-5'>
        {names.map((name) => (
          <Button
            key={name}
            onClick={() => {
              onPress(name);
              setNames(names.filter((other) => other !== name));
            }}
          >
            {name}
          </Button>
        ))}
      </div>
    );
  }

  async function drawn() {
    const onPress = vi.fn<(name: string) => void>();
    const screen = await render(<List onPress={onPress} />);
    const button = (name: string) => screen.getByRole("button", { name }).element() as HTMLElement;
    return { button, pressed: () => onPress.mock.calls.map(([name]) => name) };
  }

  test("a double click, or three in a row, presses the first, and a press a second later the next", async () => {
    const { button, pressed } = await drawn();
    const [x, y] = middleOf(button("First"));
    await pressAt(x, y, 3);
    expect(document.elementFromPoint(x, y)).toBe(button("Second"));
    expect(pressed()).toEqual(["First"]);

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await pressAt(x, y);
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test.each(["Enter", " "])("%j held, or pressed again, presses the first", async (key) => {
    const { button, pressed } = await drawn();
    button("First").focus();
    await holdKey(key, 10);
    await userEvent.keyboard(key === " " ? key : `{${key}}`);
    expect(pressed()).toEqual(["First"]);
    expect(document.activeElement).toBe(button("Second"));
  });

  test("a key pressed on one that Tab went to is taken at once", async () => {
    const { button, pressed } = await drawn();
    button("First").focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.keyboard("{Enter}");
    expect(pressed()).toEqual(["First", "Third"]);
  });

  test("a press of one that was there all along, or by assistive technology, is taken at once", async () => {
    const { button, pressed } = await drawn();
    await pressAt(...middleOf(button("First")));
    assistivePress(button("Second"));
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test("a press somewhere else is taken at once", async () => {
    const { button, pressed } = await drawn();
    await pressAt(...middleOf(button("Third")));
    await pressAt(...middleOf(button("First")));
    expect(pressed()).toEqual(["Third", "First"]);
  });
});

test("Enter in a form's field presses its button", async () => {
  const submit = vi.fn();
  const screen = await render(
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <input aria-label='Name' />
      <Button type='submit'>Save</Button>
    </form>,
  );
  await userEvent.type(screen.getByRole("textbox"), "a{Enter}");
  expect(submit).toHaveBeenCalledOnce();
});
