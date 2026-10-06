import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { Session } from "@core/sessions/session";
import { ResumeBlock, ResumeButton, ResumeNote } from "@dashboard/components/resume/Resume";
import { useResume } from "@dashboard/hooks/actions/useResume";
import { pointAway, startAtTop } from "@tests/support/browser/browser";
import { warmPaint } from "@tests/support/browser/colours";
import { makeSession } from "@tests/fixtures/session";

const UUID = "00000000-0000-4000-8000-000000000001";
const FOLDER = "/Users/example/code/demo";
const COMMAND = `cd '${FOLDER}' && claude --resume ${UUID}`;

/** A background job Claude Code reports as finished, its process gone. */
function finished(overrides: Partial<Session> = {}): Session {
  return makeSession({
    id: `claude-code:${UUID}`,
    name: "nightly-report",
    status: "finished",
    alive: false,
    cwd: FOLDER,
    ...overrides,
  });
}

/** One session as a row draws it: its name with the line under it, and its Resume at the right. */
function Row({ session, ended, width }: { session: Session; ended?: boolean; width: number }) {
  const resume = useResume(session, ended);
  return (
    <div data-slot='row' style={{ width }} className='flex items-start gap-3 p-2.5'>
      <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-px'>
        <span data-part='name'>{session.name}</span>
        <ResumeNote resume={resume} />
      </div>
      <ResumeButton session={session} resume={resume} />
    </div>
  );
}

/** The part of a session's details that holds the command, with the head's Resume. */
function Details({ session, ended }: { session: Session; ended?: boolean }) {
  const resume = useResume(session, ended);
  return (
    <div>
      <header className='flex items-start justify-between gap-4'>
        <h2>{session.name}</h2>
        <ResumeButton session={session} resume={resume} tooltip={false} />
      </header>
      <ResumeBlock resume={resume} className='mt-3' />
    </div>
  );
}

const resumeButton = (name = "nightly-report") =>
  page.getByRole("button", { name: `Copy the command that resumes ${name}` });

/**
 * That both of the button's words, "Resume" and "Copied", which share one
 * place, are drawn inside it and clear of its padding, so neither runs out of
 * the capsule. The button's own scroll width cannot say so: a word that runs
 * out of a 64px button still leaves it reporting 64.
 */
function expectWordsInside(button: HTMLElement) {
  const box = button.getBoundingClientRect();
  const style = getComputedStyle(button);
  const left = box.left + Number.parseFloat(style.paddingLeft) - 0.5;
  const right = box.right - Number.parseFloat(style.paddingRight) + 0.5;
  const words = [...button.querySelectorAll<HTMLElement>(":scope > span")];
  expect(words.map((word) => word.textContent)).toEqual(["Resume", "Copied"]);
  for (const word of words) {
    const drawn = word.getBoundingClientRect();
    expect(drawn.left, word.textContent!).toBeGreaterThanOrEqual(left);
    expect(drawn.right, word.textContent!).toBeLessThanOrEqual(right);
  }
}

let written: string[] = [];

beforeEach(async () => {
  await page.viewport(1280, 800);
  written = [];
  // A stand-in for the clipboard, so no test writes to the real one.
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(async (text) => {
    written.push(text);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-theme");
  await pointAway();
});

/** Makes the next write to the clipboard fail, as a browser that refuses does. */
function refuseTheClipboard() {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Write permission denied.", "NotAllowedError"),
  );
}

test.each(["finished", "failed"] as const)(
  "a Claude Code session that %s, with its process gone, has Resume, which copies the command that resumes it",
  async (status) => {
    const screen = await render(<Row session={finished({ status })} width={640} />);
    const button = resumeButton();
    await expect.element(button).toBeVisible();
    const element = button.element() as HTMLElement;
    expect(element.textContent).toContain("Resume");
    // As wide as a Jump, so a column of them lines up.
    await document.fonts.ready;
    expect(element.getBoundingClientRect().width).toBe(64);
    expectWordsInside(element);

    await userEvent.click(button);
    expect(written).toEqual([COMMAND]);
    await expect
      .poll(() => screen.container.querySelector('[data-part="copy-said"]')?.textContent)
      .toBe("Copied the command that resumes nightly-report. Paste it in a terminal.");
    expect(element.dataset.copied).toBe("true");
    // Nothing is said under the name once it has copied.
    expect(screen.container.querySelector('[data-part="resume-line"]')).toBeNull();
  },
);

test("the command is one hover or one Tab away, in the mono, as it is copied", async () => {
  await render(<Row session={finished()} width={640} />);
  startAtTop();
  await userEvent.tab();
  expect(document.activeElement).toBe(resumeButton().element());
  await expect.element(page.getByRole("tooltip")).toHaveTextContent(COMMAND);
  const tooltip = document.querySelector('[data-slot="tooltip"]') as HTMLElement;
  expect(tooltip.classList.contains("font-mono")).toBe(true);
});

test.each([
  ["working", { status: "working", alive: true, pid: 4241 }],
  ["idle", { status: "idle", alive: true, pid: 4241 }],
  ["waiting for the person", { status: "needs-you", alive: true, pid: 4241 }],
  ["finished with its process still running", { status: "finished", alive: true, pid: 4241 }],
  ["of a status that is not known", { status: "unknown" }],
  ["from Codex", { id: `codex:${UUID}`, source: "codex" }],
  ["from a status file", { id: `status-files:${UUID}`, source: "status-files" }],
  ["named by its job's short id", { id: "claude-code:job-0001" }],
  ["named by its process ID", { id: "claude-code:4241" }],
  ["with no folder", { cwd: null }],
  ["with a folder that is not a whole path", { cwd: "~/code/demo" }],
  ["with a folder holding a newline", { cwd: "/Users/example/code\ndemo" }],
] as [string, Partial<Session>][])(
  "a session %s has no Resume and nothing under its name",
  async (_name, overrides) => {
    const screen = await render(<Row session={finished(overrides)} width={640} />);
    await expect.element(page.getByText("nightly-report")).toBeVisible();
    expect(screen.container.querySelector('[data-part="resume"]')).toBeNull();
    expect(screen.container.querySelector('[data-part="resume-line"]')).toBeNull();
    expect(screen.container.querySelector("button")).toBeNull();
  },
);

test("a session Agent Lookout saw end has Resume, whatever the list last said of it", async () => {
  const screen = await render(
    <Row session={finished({ status: "idle", alive: true, pid: 4241 })} ended width={640} />,
  );
  await expect.element(resumeButton()).toBeVisible();
  await userEvent.click(resumeButton());
  expect(written).toEqual([COMMAND]);
  expect(screen.container.querySelector('[data-part="resume-line"]')).toBeNull();
});

test("a folder with spaces, quotes, dollars, backticks and other scripts is copied quoted, and read back exactly", async () => {
  const folder = "/Users/example/My  Projects/it's $HOME `x` código";
  await render(<Row session={finished({ cwd: folder })} width={640} />);
  await userEvent.click(resumeButton());
  expect(written).toEqual([
    `cd '/Users/example/My  Projects/it'\\''s $HOME \`x\` código' && claude --resume ${UUID}`,
  ]);
});

test.each([1280, 375])(
  "at %ipx, when the clipboard is refused the row says so under the name and leaves the command to select by hand",
  async (width) => {
    await page.viewport(width, 800);
    refuseTheClipboard();
    const folder = "/Users/example/My  Projects/a-folder-with-a-long-name/storefront-checkout";
    const command = `cd '${folder}' && claude --resume ${UUID}`;
    const rowWidth = width === 375 ? 375 - 32 : 640;
    const screen = await render(<Row session={finished({ cwd: folder })} width={rowWidth} />);

    await userEvent.click(resumeButton());
    await expect
      .poll(() => screen.container.querySelector('[data-part="resume-line"]'))
      .not.toBeNull();
    const shown = screen.container.querySelector('[data-part="resume-line"]') as HTMLElement;
    expect(shown.textContent).toBe(`Not copied. Select the command to copy it: ${command}`);
    expect(screen.container.querySelector('[data-part="copy-said"]')?.textContent).toBe(
      "The command was not copied. It is shown on the page, to select and copy.",
    );
    // The button's word is what it was.
    expect(resumeButton().element().getAttribute("data-copied")).toBeNull();

    // In the mono, a Tab stop, and one press selects the whole of it, every space kept.
    const code = shown.querySelector<HTMLElement>('[data-part="resume-command"]')!;
    expect(code.tabIndex).toBe(0);
    expect(getComputedStyle(code).userSelect).toBe("all");
    expect(getComputedStyle(code).whiteSpace).toBe("pre-wrap");
    window.getSelection()?.selectAllChildren(code);
    expect(window.getSelection()?.toString()).toBe(command);
    window.getSelection()?.removeAllRanges();

    // Nothing runs past the row or the page, and the button keeps its place and size.
    const row = screen.container.querySelector('[data-slot="row"]') as HTMLElement;
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(resumeButton().element().getBoundingClientRect().width).toBe(64);
    await document.fonts.ready;
    expectWordsInside(resumeButton().element() as HTMLElement);
    // A flag is never split at its dashes.
    const words = [...code.querySelectorAll('[data-part="word"]')].map((word) => word.textContent);
    expect(words).toContain("--resume");
  },
);

test("a press that copies after a refusal takes the command away from under the name", async () => {
  refuseTheClipboard();
  const screen = await render(<Row session={finished()} width={640} />);
  await userEvent.click(resumeButton());
  await expect
    .poll(() => screen.container.querySelector('[data-part="resume-line"]'))
    .not.toBeNull();

  vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await userEvent.click(resumeButton());
  await expect.poll(() => screen.container.querySelector('[data-part="resume-line"]')).toBeNull();
});

test.each([712, 375 - 32 - 48])(
  "in %ipx of details the command is shown whole under the lead, as the head's Resume copies it",
  async (width) => {
    await page.viewport(width === 712 ? 1280 : 375, 800);
    const screen = await render(
      <div style={{ width }}>
        <Details session={finished()} />
      </div>,
    );
    const block = screen.container.querySelector('[data-part="resume-block"]') as HTMLElement;
    expect(block.querySelector("p")?.textContent).toBe(
      "Resume copies this command, which goes to the session's folder and opens its conversation again. Paste it in a terminal.",
    );
    const code = block.querySelector('[data-part="resume-command"]') as HTMLElement;
    expect(code.textContent).toBe(COMMAND);
    expect(code.querySelector('[data-slot="literal"]')).not.toBeNull();
    expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);

    // The head's Resume needs no tooltip: the command is on the page.
    startAtTop();
    await userEvent.tab();
    expect(document.activeElement).toBe(resumeButton().element());
    expect(document.querySelector('[data-slot="tooltip"]')).toBeNull();
    await userEvent.keyboard("{Enter}");
    expect(written).toEqual([COMMAND]);
    expect(block.querySelector('[data-part="resume-refused"]')).toBeNull();
  },
);

test("in the details a refused copy says so under the command", async () => {
  refuseTheClipboard();
  const screen = await render(
    <div style={{ width: 712 }}>
      <Details session={finished()} />
    </div>,
  );
  await userEvent.click(resumeButton());
  await expect
    .poll(() => screen.container.querySelector('[data-part="resume-refused"]')?.textContent)
    .toBe("Not copied. Select the command and copy it.");
});

test("a session with no command has no block in its details", async () => {
  const screen = await render(<Details session={finished({ status: "idle", alive: true })} />);
  expect(screen.container.querySelector('[data-part="resume-block"]')).toBeNull();
  expect(screen.container.querySelector("button")).toBeNull();
});

test.each(["dark", "light"] as const)(
  "in the %s theme nothing of Resume is warm, before or after a refusal",
  async (theme) => {
    document.documentElement.dataset.theme = theme;
    refuseTheClipboard();
    const screen = await render(<Row session={finished()} width={640} />);
    expect(warmPaint(screen.container)).toEqual([]);
    await userEvent.click(resumeButton());
    await expect
      .poll(() => screen.container.querySelector('[data-part="resume-line"]'))
      .not.toBeNull();
    expect(warmPaint(screen.container)).toEqual([]);
  },
);
