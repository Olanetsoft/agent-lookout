import { afterEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { COPIED_MS, CopyButton } from "@dashboard/components/ui/controls/CopyButton";
import type { CopyOutcome } from "@dashboard/lib/shell/clipboard";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { warmPaint } from "@tests/support/browser/colours";

const TEXT =
  "cd '/Users/example/code/demo' && claude --resume 00000000-0000-4000-8000-000000000001";

/** A copy that answers when the test says. */
function heldCopy() {
  let answer: (outcome: CopyOutcome) => void = () => {};
  const copy = vi.fn(
    () =>
      new Promise<CopyOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  return { copy, answer: (outcome: CopyOutcome) => answer(outcome) };
}

function renderButton(
  copy: (text: string) => Promise<CopyOutcome>,
  onCopied?: (outcome: CopyOutcome) => void,
  tooltip?: string,
) {
  return render(
    <div className='p-10'>
      <CopyButton
        text={TEXT}
        copy={copy}
        onCopied={onCopied}
        aria-label='Copy the command that resumes demo-project'
        copiedSaid='Copied the command that resumes demo-project.'
        refusedSaid='The command was not copied.'
        tooltip={tooltip}
        tooltipMono
      >
        Resume
      </CopyButton>
    </div>,
  );
}

const button = () =>
  page.getByRole("button", { name: "Copy the command that resumes demo-project" });
const said = (root: ParentNode) => root.querySelector<HTMLElement>('[data-part="copy-said"]');
/** The word a sighted person sees on the button: the one of its two that is not hidden. */
const shownWord = (element: Element) =>
  [...element.querySelectorAll("span")].find(
    (span) => getComputedStyle(span).visibility !== "hidden",
  )?.textContent;

afterEach(async () => {
  document.documentElement.removeAttribute("data-theme");
  await pointAway();
});

test("a press puts the text on the clipboard, and the word says Copied for two seconds at the same width", async () => {
  const onCopied = vi.fn();
  const copy = vi.fn(async (): Promise<CopyOutcome> => "copied");
  const screen = await renderButton(copy, onCopied);
  await document.fonts.ready;
  const element = button().element() as HTMLElement;
  const width = element.getBoundingClientRect().width;
  expect(shownWord(element)).toBe("Resume");
  // The status is in the page before there is anything to say, so the change is heard.
  expect(said(screen.container)?.getAttribute("aria-live")).toBe("polite");
  expect(said(screen.container)?.textContent).toBe("");

  await userEvent.click(button());
  expect(copy).toHaveBeenCalledWith(TEXT);
  await expect.poll(() => shownWord(element)).toBe("Copied");
  expect(element.dataset.copied).toBe("true");
  expect(element.getBoundingClientRect().width).toBe(width);
  expect(said(screen.container)?.textContent).toBe("Copied the command that resumes demo-project.");
  expect(onCopied).toHaveBeenCalledWith("copied");
  // Its name stays what it does, whatever its word says.
  expect(element.getAttribute("aria-label")).toBe("Copy the command that resumes demo-project");

  await expect.poll(() => shownWord(element), { timeout: COPIED_MS + 1_000 }).toBe("Resume");
  expect(element.dataset.copied).toBeUndefined();
  expect(element.getBoundingClientRect().width).toBe(width);
});

test("a refused copy leaves the word as it was, says so, and tells what draws it", async () => {
  const onCopied = vi.fn();
  const screen = await renderButton(async () => "refused", onCopied);
  const element = button().element() as HTMLElement;

  await userEvent.click(button());
  await expect.poll(() => said(screen.container)?.textContent).toBe("The command was not copied.");
  expect(onCopied).toHaveBeenCalledWith("refused");
  expect(shownWord(element)).toBe("Resume");
  expect(element.dataset.copied).toBeUndefined();
});

test("a second press while the first is under way does nothing, and the next press is heard again", async () => {
  const held = heldCopy();
  const screen = await renderButton(held.copy);

  await userEvent.click(button());
  await userEvent.click(button());
  expect(held.copy).toHaveBeenCalledOnce();
  held.answer("copied");
  await expect
    .poll(() => said(screen.container)?.textContent)
    .toBe("Copied the command that resumes demo-project.");

  await userEvent.click(button());
  expect(held.copy).toHaveBeenCalledTimes(2);
  // Said again from nothing, so the same words are heard a second time.
  expect(said(screen.container)?.textContent).toBe("");
  held.answer("copied");
  await expect
    .poll(() => said(screen.container)?.textContent)
    .toBe("Copied the command that resumes demo-project.");
});

test("it is pressed from the keyboard, and its tooltip gives the text in the mono on focus", async () => {
  const copy = vi.fn(async (): Promise<CopyOutcome> => "copied");
  await renderButton(copy, undefined, TEXT);
  startAtTop();

  await userEvent.tab();
  expect(document.activeElement).toBe(button().element());
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toHaveTextContent(TEXT);
  const floating = document.querySelector('[data-slot="tooltip"]') as HTMLElement;
  expect(floating.classList.contains("font-mono")).toBe(true);
  // A command is set through Literal, so it breaks only between its words.
  expect(floating.querySelector('[data-slot="literal"]')).not.toBeNull();

  await userEvent.keyboard("{Enter}");
  expect(copy).toHaveBeenCalledWith(TEXT);
  await userEvent.keyboard(" ");
  await expect.poll(() => copy.mock.calls.length).toBe(2);
});

test.each(["dark", "light"] as const)(
  "in the %s theme it is the quiet button, and nothing of it is warm, copied or not",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    await renderButton(async () => "copied");
    const element = button().element() as HTMLElement;
    expect(element.dataset.variant).toBe("quiet");
    expect(warmPaint(element)).toEqual([]);

    await userEvent.click(button());
    await expect.poll(() => element.dataset.copied).toBe("true");
    expect(warmPaint(element)).toEqual([]);
  },
);
