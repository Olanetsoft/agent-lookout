import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ACTION_HEADER } from "@core/api";
import type { AppUpdateStatus, UpdatePhase } from "@core/appUpdate";
import { UpdatesCard } from "@dashboard/components/settings/UpdatesCard";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { warmPaint } from "@tests/support/browser/colours";

const RELEASES = "https://github.com/Olanetsoft/agent-lookout/releases";
const NOTES = `${RELEASES}/tag/v0.2.1`;

/** What the app says, as `GET /api/app/update` would, and what each POST changes it to. */
let current: AppUpdateStatus;
let afterCheck: UpdatePhase;
let afterInstall: UpdatePhase;
/** Each request the card made: its path, method, action and body. */
let asked: { path: string; method: string; action: string | null; body: string | null }[];
/** Whether the app answers at all. */
let answering: boolean;
/** When set, the answer to a check waits for it, as GitHub can. */
let checkHeld: Promise<void> | null;

const status = (update: UpdatePhase, change: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  version: "0.2.0",
  automatic: true,
  lastCheckedAt: null,
  releasesUrl: RELEASES,
  update,
  ...change,
});

beforeEach(() => {
  current = status({ phase: "idle" });
  afterCheck = { phase: "up-to-date" };
  afterInstall = { phase: "installing", version: "0.2.1", notesUrl: NOTES };
  asked = [];
  answering = true;
  checkHeld = null;
  setApiHost(async (path, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? init.body : null;
    asked.push({ path, method: init?.method ?? "GET", action: headers.get(ACTION_HEADER), body });
    if (!answering) throw new TypeError("Failed to fetch");
    if (path === "/api/app/update/check") {
      if (checkHeld !== null) await checkHeld;
      current = { ...current, update: afterCheck, lastCheckedAt: Date.now() };
    }
    if (path === "/api/app/update/install") current = { ...current, update: afterInstall };
    if (path === "/api/app/update/setting") {
      current = {
        ...current,
        automatic: (JSON.parse(body ?? "{}") as { automatic: boolean }).automatic,
      };
    }
    return new Response(JSON.stringify(current), {
      headers: { "Content-Type": "application/json" },
    });
  });
});

afterEach(() => {
  setApiHost();
  history.replaceState(null, "", location.pathname);
});

const card = (screen: Awaited<ReturnType<typeof render>>) =>
  screen.getByRole("region", { name: "Updates" });

const stateOf = (screen: Awaited<ReturnType<typeof render>>) =>
  card(screen).element().querySelector('[data-part="state"]') as HTMLElement;

const facts = (screen: Awaited<ReturnType<typeof render>>) =>
  [...card(screen).element().querySelectorAll('[data-slot="fact-row"]')].map((row) => [
    row.querySelector("dt")?.textContent,
    row.querySelector("dd")?.textContent,
  ]);

test("shows the version, the switch on, when it last checked, and Check for Updates…", async () => {
  const screen = await render(<UpdatesCard />);
  await expect
    .element(card(screen).getByRole("button", { name: "Check for Updates…" }))
    .toBeVisible();

  expect(stateOf(screen).textContent).toBe("Agent Lookout checks about once a day.");
  expect(stateOf(screen).getAttribute("aria-live")).toBe("polite");
  await expect
    .element(screen.getByRole("radiogroup", { name: "Check for updates automatically" }))
    .toBeVisible();
  await expect.element(screen.getByRole("radio", { name: "On" })).toBeChecked();
  expect(facts(screen)).toEqual([
    ["Version", "v0.2.0"],
    ["Last checked", "Not yet"],
  ]);
  // Its explanation says what is sent, and that nothing installs without the button.
  expect(card(screen).element().textContent).toContain("It sends nothing about your sessions");
  expect(card(screen).element().textContent).toContain(
    "installed only when you press Install and Restart",
  );
  expect(asked).toEqual([{ path: "/api/app/update", method: "GET", action: null, body: null }]);
});

test("Check for Updates… asks the app, and says it is up to date", async () => {
  const screen = await render(<UpdatesCard />);
  await card(screen).getByRole("button", { name: "Check for Updates…" }).click();

  await vi.waitFor(() => expect(stateOf(screen).textContent).toBe("You're up to date."));
  expect(asked).toContainEqual({
    path: "/api/app/update/check",
    method: "POST",
    action: "check-for-updates",
    body: "{}",
  });
  expect(facts(screen)[1]?.[1]).toMatch(/^\d\d:\d\d$/);
  expect(card(screen).element().querySelector('[data-slot="callout"]')).toBeNull();
});

test("says it is checking as soon as Check for Updates… is pressed, before GitHub answers", async () => {
  let answer = () => {};
  checkHeld = new Promise((resolve) => {
    answer = resolve;
  });
  const screen = await render(<UpdatesCard />);
  await card(screen).getByRole("button", { name: "Check for Updates…" }).click();

  await vi.waitFor(() => expect(stateOf(screen).textContent).toBe("Checking for updates…"));
  expect(card(screen).getByRole("button", { name: "Check for Updates…" }).element()).toHaveProperty(
    "disabled",
    true,
  );
  answer();
  await vi.waitFor(() => expect(stateOf(screen).textContent).toBe("You're up to date."));
});

test("a latest release with no Mac app reads as an answer, never as an error", async () => {
  afterCheck = { phase: "no-release" };
  const screen = await render(<UpdatesCard />);
  await card(screen).getByRole("button", { name: "Check for Updates…" }).click();

  await vi.waitFor(() =>
    expect(stateOf(screen).textContent).toBe("The latest release has no Mac app yet."),
  );
  expect(card(screen).element().querySelector('[data-slot="callout"]')).toBeNull();
  expect(card(screen).element().querySelector('[role="alert"]')).toBeNull();
});

test("a version found and ready offers Install and Restart and its release notes, and installs only when pressed", async () => {
  afterCheck = { phase: "ready", version: "0.2.1", notesUrl: NOTES };
  const screen = await render(<UpdatesCard />);
  await card(screen).getByRole("button", { name: "Check for Updates…" }).click();

  await expect
    .element(card(screen).getByRole("button", { name: "Install and Restart" }))
    .toBeVisible();
  expect(stateOf(screen).textContent).toBe("Version 0.2.1 is available.");
  const notes = card(screen).getByRole("link", { name: "Release notes" }).element();
  expect(notes.getAttribute("href")).toBe(NOTES);
  expect(asked.some((request) => request.path === "/api/app/update/install")).toBe(false);

  await card(screen).getByRole("button", { name: "Install and Restart" }).click();
  await vi.waitFor(() => expect(stateOf(screen).textContent).toBe("Installing version 0.2.1…"));
  expect(asked).toContainEqual({
    path: "/api/app/update/install",
    method: "POST",
    action: "install-update",
    body: "{}",
  });
  // While it installs, there is nothing to press.
  expect(card(screen).getByRole("button", { name: "Check for Updates…" }).element()).toHaveProperty(
    "disabled",
    true,
  );
});

test("while a version downloads, it says how far it has got", async () => {
  current = status({
    phase: "downloading",
    version: "0.2.1",
    notesUrl: NOTES,
    received: 20 * 1024 * 1024,
    total: 100 * 1024 * 1024,
  });
  const screen = await render(<UpdatesCard />);
  await vi.waitFor(() =>
    expect(card(screen).element().querySelector('[data-part="found"]')?.textContent).toBe(
      "Downloading it: 20 MB of 100 MB. Release notes",
    ),
  );
  expect(card(screen).getByRole("button", { name: "Install and Restart" }).elements()).toHaveLength(
    0,
  );
});

test("a version it cannot install where it runs says why and what to do, with its release page", async () => {
  current = status({
    phase: "cannot-install",
    version: "0.2.1",
    notesUrl: NOTES,
    refusal: "disk-image",
  });
  const screen = await render(<UpdatesCard />);
  const note = card(screen).getByRole("status");
  await expect.element(note).toBeVisible();
  expect(note.element().textContent).toContain("Agent Lookout cannot update itself here");
  expect(note.element().textContent).toContain("Drag Agent Lookout to the Applications folder");
  expect(note.getByRole("link", { name: "Release page" }).element().getAttribute("href")).toBe(
    NOTES,
  );
  // That link is the one way to the release, said once.
  expect(card(screen).getByRole("link").elements()).toHaveLength(1);
  expect(note.element().textContent).not.toMatch(/download it from/i);
  expect(card(screen).getByRole("button", { name: "Install and Restart" }).elements()).toHaveLength(
    0,
  );
});

test("the switch turns the automatic check off, and the app is told", async () => {
  const screen = await render(<UpdatesCard />);
  await screen.getByRole("radio", { name: "Off" }).click();

  await vi.waitFor(() =>
    expect(stateOf(screen).textContent).toBe("Agent Lookout checks only when you ask."),
  );
  await expect.element(screen.getByRole("radio", { name: "Off" })).toBeChecked();
  expect(asked).toContainEqual({
    path: "/api/app/update/setting",
    method: "POST",
    action: "update-setting",
    body: '{"automatic":false}',
  });
});

test("an app that does not answer is said plainly, with nothing to press", async () => {
  answering = false;
  const screen = await render(<UpdatesCard />);
  await vi.waitFor(() =>
    expect(stateOf(screen).textContent).toBe("Whether a newer version is out could not be read."),
  );
  expect(card(screen).getByRole("button").elements()).toHaveLength(0);
});

test("the app menu's address brings the card into view", async () => {
  history.replaceState(null, "", "#settings/updates");
  const scrolled = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  await render(<UpdatesCard />);
  expect(scrolled).toHaveBeenCalledWith({ block: "nearest" });
  scrolled.mockRestore();
});

test.each(["dark", "light"] as const)(
  "in the %s theme nothing in it is warm, a version found included",
  async (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    current = status({ phase: "ready", version: "0.2.1", notesUrl: NOTES });
    const screen = await render(<UpdatesCard />);
    await expect
      .element(card(screen).getByRole("button", { name: "Install and Restart" }))
      .toBeVisible();
    expect(warmPaint(screen.container)).toEqual([]);
    document.documentElement.removeAttribute("data-theme");
  },
);
