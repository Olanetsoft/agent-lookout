import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { HistoryKept, HistoryResponse } from "@core/api";
import { CLEAR_QUESTION, HistoryCard } from "@dashboard/components/settings/HistoryCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import type { ClearOutcome } from "@dashboard/lib/api/keptHistory";
import { pointAway } from "@tests/support/browser/browser";
import { warmPaint } from "@tests/support/browser/colours";

afterEach(() => {
  setApiHost();
  document.documentElement.removeAttribute("data-theme");
});

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

/** Today at this time on the clock. */
function today(hours: number, minutes: number): number {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.getTime();
}

const NOW = today(15, 0);

const ON_DISK: HistoryKept = {
  where: "disk",
  folder: "~/.agent-lookout/history",
  bytes: 1.4 * MB,
  maxBytes: 20 * MB,
  maxAgeMs: 8 * DAY,
  canClear: true,
  problem: null,
};

function history(
  kept: HistoryKept = ON_DISK,
): Pick<HistoryResponse, "startedAt" | "since" | "kept"> {
  return { startedAt: today(14, 0), since: { at: today(9, 5), by: "started" }, kept };
}

type Screen = Awaited<ReturnType<typeof render>>;

const card = (screen: Screen) => screen.getByRole("region", { name: "History" });
const state = (screen: Screen) =>
  card(screen).element().querySelector('[data-part="state"]') as HTMLElement;
const buttons = (screen: Screen) =>
  [...card(screen).element().querySelectorAll("button")].map((button) => button.textContent);
const facts = (screen: Screen) =>
  [...card(screen).element().querySelectorAll('[data-slot="fact-row"]')].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);

/** A clear that answers when the test says. */
function heldClear() {
  let answer: (outcome: ClearOutcome) => void = () => {};
  const clear = vi.fn(
    () =>
      new Promise<ClearOutcome>((resolve) => {
        answer = resolve;
      }),
  );
  return { clear, answer: (outcome: ClearOutcome) => answer(outcome) };
}

test("before the app has answered, the card says nothing and offers nothing", async () => {
  const screen = await render(<HistoryCard history={null} now={NOW} />);
  await expect.element(card(screen)).toBeVisible();
  expect(state(screen).textContent).toBe("");
  expect(buttons(screen)).toEqual([]);
});

test("kept on disk, it says for how long beside Clear history, and gives the folder, the size and since when", async () => {
  const screen = await render(<HistoryCard history={history()} now={NOW} />);
  expect(state(screen).textContent).toBe("History is kept on this computer for 8 days.");
  expect(state(screen).getAttribute("aria-live")).toBe("polite");
  expect(buttons(screen)).toEqual(["Clear history"]);
  expect(facts(screen)).toEqual([
    ["Folder", "~/.agent-lookout/history"],
    ["Holds", "1.4 MB of 20 MB"],
    ["Since", "09:05"],
  ]);
  // The folder is a literal string, in the mono.
  const folder = card(screen).element().querySelector('[data-slot="fact-row"] dd') as HTMLElement;
  expect(getComputedStyle(folder).fontFamily).toMatch(/Mono/);
  const text = card(screen).element().textContent ?? "";
  expect(text).toContain("still there when Agent Lookout starts again");
  expect(text).toContain("8 days after the day ends");
  expect(text).toContain("more than 20 MB");
});

test("a long folder breaks after its slashes inside the card on a phone, and copies whole", async () => {
  const long =
    "/private/tmp/agent-lookout-scratch/-Users-example-Documents-code-lookout-tryout/3f1c2d4e-a0b1-4c2d-9e8f-77a60d75b78d/history";
  const screen = await render(
    <div style={{ width: 343 }}>
      <HistoryCard history={history({ ...ON_DISK, folder: long })} now={NOW} />
    </div>,
  );
  const folder = card(screen).element().querySelector('[data-part="folder"]') as HTMLElement;
  expect(folder.textContent).toBe(long);
  expect(folder.querySelectorAll("wbr")).toHaveLength(long.split("/").length - 1);
  const row = folder.closest('[data-slot="fact-row"]') as HTMLElement;
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
  expect(folder.getBoundingClientRect().right).toBeLessThanOrEqual(
    row.getBoundingClientRect().right + 0.5,
  );
});

test("Clear history asks first, with focus on Cancel, and Cancel puts it back as it was", async () => {
  const { clear } = heldClear();
  const screen = await render(<HistoryCard history={history()} now={NOW} clear={clear} />);
  await userEvent.click(card(screen).getByRole("button", { name: "Clear history" }));

  expect(state(screen).textContent).toBe(CLEAR_QUESTION);
  expect(buttons(screen)).toEqual(["Clear history", "Cancel"]);
  await expect.element(card(screen).getByRole("button", { name: "Cancel" })).toHaveFocus();
  expect(clear).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  expect(state(screen).textContent).toBe("History is kept on this computer for 8 days.");
  await expect.element(card(screen).getByRole("button", { name: "Clear history" })).toHaveFocus();
  expect(clear).not.toHaveBeenCalled();
});

test("answering yes clears it once, says when, tells the page, and gives focus back to the button", async () => {
  const { clear, answer } = heldClear();
  const cleared = vi.fn();
  const screen = await render(
    <HistoryCard history={history()} now={NOW} clear={clear} onCleared={cleared} />,
  );
  await userEvent.click(card(screen).getByRole("button", { name: "Clear history" }));
  const yes = card(screen).getByRole("button", { name: "Clear history" });
  await userEvent.click(yes);
  // While the first is under way the button says it is not to be pressed, and
  // a press that gets through anyway asks nothing more.
  await expect.element(yes).toHaveAttribute("aria-disabled", "true");
  (yes.element() as HTMLButtonElement).click();
  expect(clear).toHaveBeenCalledTimes(1);

  answer({ ok: true, at: today(15, 0) });
  const outcome = card(screen).getByRole("status");
  await expect.element(outcome).toHaveTextContent("History cleared at 15:00.");
  expect(cleared).toHaveBeenCalledTimes(1);
  expect(state(screen).textContent).toBe("History is kept on this computer for 8 days.");
  await expect.element(card(screen).getByRole("button", { name: "Clear history" })).toHaveFocus();
});

test("a clear that does not work says so in a note, and the button stays", async () => {
  const { clear, answer } = heldClear();
  const screen = await render(<HistoryCard history={history()} now={NOW} clear={clear} />);
  await userEvent.click(card(screen).getByRole("button", { name: "Clear history" }));
  await userEvent.click(card(screen).getByRole("button", { name: "Clear history" }));
  answer({ ok: false, reason: "failed", error: "One history file could not be deleted." });

  const note = card(screen).getByRole("status");
  await expect.element(note).toHaveTextContent("The history could not be cleared");
  await expect.element(note).toHaveTextContent("One history file could not be deleted.");
  expect(buttons(screen)).toEqual(["Clear history"]);
});

test("in memory only, it says so, names the setting, and has no button", async () => {
  const screen = await render(
    <HistoryCard
      history={history({ ...ON_DISK, where: "memory", folder: null, bytes: null, canClear: false })}
      now={NOW}
    />,
  );
  expect(state(screen).textContent).toBe("History is kept in memory only.");
  expect(buttons(screen)).toEqual([]);
  expect(facts(screen)).toEqual([]);
  const setting = card(screen).element().querySelector('[data-slot="fact"]');
  expect(setting?.textContent).toBe("AGENT_LOOKOUT_HISTORY");
  expect(card(screen).element().textContent).toContain(
    "start empty each time Agent Lookout starts",
  );
});

test("while another copy writes the files, a note says so and there is no button", async () => {
  const problem =
    "Another copy of Agent Lookout on this computer is writing the history. This one keeps what it sees in memory, and takes over when that one stops.";
  const screen = await render(
    <HistoryCard history={history({ ...ON_DISK, canClear: false, problem })} now={NOW} />,
  );
  expect(state(screen).textContent).toBe("History is kept in memory for now.");
  expect(buttons(screen)).toEqual([]);
  const note = card(screen).getByRole("status");
  await expect.element(note).toHaveTextContent("This copy is not writing history");
  await expect.element(note).toHaveTextContent(problem);
  // What is written, it says of the copy that writes it.
  expect(card(screen).element().textContent).toContain(
    "The copy that writes the history writes the Events log",
  );
});

test("an answer that does not say where it is kept says it could not be read", async () => {
  const screen = await render(<HistoryCard history={{ startedAt: NOW }} now={NOW} />);
  expect(state(screen).textContent).toBe("Where the history is kept could not be read.");
  expect(buttons(screen)).toEqual([]);
});

test("pressed for real, it asks the app through its own seam", async () => {
  const asked: { path: string; init?: RequestInit }[] = [];
  setApiHost(async (path, init) => {
    asked.push({ path, init });
    return new Response(JSON.stringify({ ok: true, clearedAt: NOW }), {
      headers: { "Content-Type": "application/json" },
    });
  });
  const screen = await render(<HistoryCard history={history()} now={NOW} />);
  await userEvent.click(card(screen).getByRole("button", { name: "Clear history" }));
  await userEvent.click(card(screen).getByRole("button", { name: "Clear history" }));
  await expect.element(card(screen).getByRole("status")).toHaveTextContent("History cleared at");
  expect(asked.map((request) => [request.path, request.init?.method])).toEqual([
    ["/api/history/clear", "POST"],
  ]);
});

test.each(["dark", "light"] as const)(
  "in the %s theme nothing in the card is warm, asking or not",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    const screen = await render(
      <HistoryCard history={history()} now={NOW} clear={heldClear().clear} />,
    );
    expect(warmPaint(screen.container)).toEqual([]);
    const button = card(screen).getByRole("button", { name: "Clear history" });
    await userEvent.hover(button);
    expect(warmPaint(screen.container)).toEqual([]);
    await userEvent.click(button);
    expect(warmPaint(screen.container)).toEqual([]);
    await pointAway();
  },
);
