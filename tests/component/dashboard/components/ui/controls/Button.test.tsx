import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
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

  /** Waits until so long after it was made. */
  function clock() {
    const began = performance.now();
    return (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, began + ms - performance.now()));
  }

  test("a double click, or three in a row, presses the first", async () => {
    const { button, pressed } = await drawn();
    const [x, y] = middleOf(button("First"));
    await pressAt(x, y, 3);
    expect(document.elementFromPoint(x, y)).toBe(button("Second"));
    expect(pressed()).toEqual(["First"]);
  });

  test("a press some pixels off and most of a second later presses nothing, and one a second after the first presses the next", async () => {
    const { button, pressed } = await drawn();
    const [x, y] = middleOf(button("First"));
    const until = clock();
    await pressAt(x, y);
    await until(650);
    await pressAt(x + 12, y + 6);
    expect(pressed()).toEqual(["First"]);
    // Counted from the press that was taken, not from the one that was not.
    await until(1_300);
    await pressAt(x, y);
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test("one held for more than a second is the rest of the first still, and one on its own is taken", async () => {
    const { button, pressed } = await drawn();
    const [x, y] = middleOf(button("First"));
    await pressAt(x, y);
    await pressAt(x, y, 1, 1_200);
    expect(pressed()).toEqual(["First"]);
    await pressAt(x, y, 1, 1_200);
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test("Space held for more than a second, and let go, is the rest of the first still", async () => {
    const { button, pressed } = await drawn();
    button("First").focus();
    await userEvent.keyboard("{Enter}");
    await holdKey(" ", 0, 1_200);
    expect(pressed()).toEqual(["First"]);
    await holdKey(" ", 0, 1_200);
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test("the same goes for a key", async () => {
    const { button, pressed } = await drawn();
    button("First").focus();
    const until = clock();
    await userEvent.keyboard("{Enter}");
    await until(650);
    await userEvent.keyboard("{Enter}");
    expect(pressed()).toEqual(["First"]);
    await until(1_300);
    await userEvent.keyboard("{Enter}");
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test.each(["Enter", " "] as const)(
    "%j held, or pressed again, presses the first",
    async (key) => {
      const { button, pressed } = await drawn();
      button("First").focus();
      await holdKey(key, 10);
      await userEvent.keyboard(key === " " ? key : `{${key}}`);
      expect(pressed()).toEqual(["First"]);
      expect(document.activeElement).toBe(button("Second"));
    },
  );

  test("Enter held on a keyboard that waits longer than a second to repeat it presses the first", async () => {
    const { button, pressed } = await drawn();
    button("First").focus();
    await holdKey("Enter", 10, 1_200);
    expect(pressed()).toEqual(["First"]);

    // Let go, and pressed anew.
    await userEvent.keyboard("{Enter}");
    expect(pressed()).toEqual(["First", "Second"]);
  });

  test("what the page itself presses is taken, though a key is held", async () => {
    const { button, pressed } = await drawn();
    button("First").focus();
    await holdKey("Enter", 2);
    expect(document.activeElement).toBe(button("Second"));
    button("Second").click();
    expect(pressed()).toEqual(["First", "Second"]);
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

describe("a press soon after another, with nothing in the first one's place", () => {
  test("one beside what the first was on, which is still there, is taken", async () => {
    const got: string[] = [];
    const screen = await render(
      <div className='flex gap-1'>
        <Button onClick={() => got.push("One")}>One</Button>
        <Button onClick={() => got.push("Two")}>Two</Button>
      </div>,
    );
    const box = screen.getByRole("button", { name: "Two" }).element().getBoundingClientRect();
    const y = box.top + box.height / 2;
    // On the one before it, on the gap between them, and on it, a few pixels apart.
    await pressAt(box.left - 8, y);
    await pressAt(box.left - 2, y);
    await pressAt(box.left + 8, y);
    expect(got).toEqual(["One", "Two"]);
  });

  test.each(["button", "link"])(
    "one of the same %s is taken, though what was drawn in it has gone",
    async (kind) => {
      const press = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
      function Said() {
        const [presses, setPresses] = useState(0);
        const said = <span key={presses}>Pressed {presses}</span>;
        return (
          <Button
            asChild={kind === "link"}
            onClick={(event) => {
              press(event);
              setPresses((count) => count + 1);
            }}
          >
            {kind === "link" ? <a href='#pressed'>{said}</a> : said}
          </Button>
        );
      }
      const screen = await render(<Said />);
      await pressAt(...middleOf(screen.getByRole(kind).element()), 2);
      expect(press).toHaveBeenCalledTimes(2);
    },
  );

  test.each([
    ["a button", <Button key='first'>One</Button>],
    ["plain words", <span key='first'>Some words</span>],
  ])("one of what the person scrolled to where %s was pressed is taken", async (_, above) => {
    await page.viewport(1280, 900);
    const press = vi.fn();
    const screen = await render(
      <div style={{ height: 3000 }}>
        <div data-testid='first' style={{ height: 100 }}>
          {above}
        </div>
        <Button onClick={press}>Two</Button>
      </div>,
    );
    onTestFinished(() => window.scrollTo({ top: 0 }));
    const two = screen.getByRole("button", { name: "Two" });
    const [x, y] = middleOf(two.element());
    await pressAt(x, y - 100);
    await userEvent.wheel(screen.getByTestId("first").element(), { delta: { y: 100 } });
    await expect.poll(() => document.elementFromPoint(x, y - 100)).toBe(two.element());
    await pressAt(x, y - 100);
    expect(press).toHaveBeenCalledOnce();
  });

  test.each([
    ["a little", 3],
    ["where there is nothing more to scroll", 120],
  ])("a wheel turned %s between the halves of a double click does not part them", async (_, y) => {
    const press = vi.fn();
    function Two() {
      const [gone, setGone] = useState(false);
      return (
        <div>
          {!gone && (
            <Button key='one' onClick={() => setGone(true)}>
              One
            </Button>
          )}
          <Button key='two' onClick={press}>
            Two
          </Button>
        </div>
      );
    }
    const screen = await render(<Two />);
    const point = middleOf(screen.getByRole("button", { name: "One" }).element());
    await pressAt(...point);
    await userEvent.wheel(screen.getByRole("button", { name: "Two" }).element(), {
      delta: { y },
    });
    await pressAt(...point);
    expect(press).not.toHaveBeenCalled();
  });
});

test("the second half of a double click presses nothing that came down as the page got shorter at its end", async () => {
  await page.viewport(1280, 900);
  const press = vi.fn();
  function Rows() {
    const [gone, setGone] = useState(false);
    return (
      <div style={{ paddingTop: 3000 }}>
        <div style={{ height: 100 }}>
          <Button onClick={press}>One</Button>
        </div>
        {!gone && (
          <div style={{ height: 100 }}>
            <Button onClick={() => setGone(true)}>Two</Button>
          </div>
        )}
      </div>
    );
  }
  const screen = await render(<Rows />);
  onTestFinished(() => window.scrollTo({ top: 0 }));
  window.scrollTo({ top: document.documentElement.scrollHeight });
  const point = middleOf(screen.getByRole("button", { name: "Two" }).element());
  await pressAt(...point);
  expect(document.elementFromPoint(...point)).toBe(
    screen.getByRole("button", { name: "One" }).element(),
  );
  await pressAt(...point);
  expect(press).not.toHaveBeenCalled();
});

test.each(["link", "button"])(
  "the second half of a double click follows no link and sends no form: a %s",
  async (kind) => {
    const was = location.hash;
    const submit = vi.fn();
    function Two() {
      const [gone, setGone] = useState(false);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          {!gone && (
            <Button key='one' onClick={() => setGone(true)}>
              Hide
            </Button>
          )}
          {kind === "link" ? (
            <Button key='two' asChild>
              <a href='#followed'>Open</a>
            </Button>
          ) : (
            <Button key='two' type='submit'>
              Send
            </Button>
          )}
        </form>
      );
    }
    const screen = await render(<Two />);
    const point = middleOf(screen.getByRole("button", { name: "Hide" }).element());
    await pressAt(...point, 2);
    expect(document.elementFromPoint(...point)).toBe(screen.getByRole(kind).element());
    expect([location.hash, submit.mock.calls.length]).toEqual([was, 0]);
  },
);

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
