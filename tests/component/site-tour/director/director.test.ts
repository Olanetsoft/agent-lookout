import { createElement } from "react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import App from "@dashboard/App";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  getNotificationSetting,
  resetNotificationSettingForTests,
} from "@dashboard/lib/notifications/notificationSetting";
import { countNeedingYou } from "@dashboard/lib/sessions/sessions";
import { setAddressHost } from "@dashboard/lib/shell/addressHost";
import { resetThemeForTests } from "@dashboard/lib/shell/theme";
import { cardTitled, createDirector, LOOK_MARGIN } from "@site-tour/director/director";
import { createFeed } from "@site-tour/feed/derive";
import { FINISHED_JOB, MACHINE, WAITING_SESSION } from "@site-tour/feed/hour";
import { momentFor, SCENES } from "@site-tour/feed/scenes";
import type { Clock } from "@site-tour/host/clock";
import { createTourApi } from "@site-tour/host/tourApi";
import { createTourNotifications } from "@site-tour/host/tourNotifications";
import { createTourStore } from "@site-tour/host/tourStore";

// The tour drives the real dashboard. When a change to the dashboard breaks a
// scene, this fails, so the landing page can never show a dashboard that is
// not the app's.

const LAYOUT_LABEL = { list: "List", repositories: "Repos", board: "Board" } as const;

/** A clock that only says whether it is held. The real one would hold this page's own. */
function stillClock(): Clock {
  let held = false;
  return {
    now: () => Date.now(),
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
    },
    get held() {
      return held;
    },
  };
}

function setUp({ instant = true } = {}) {
  const store = createTourStore({ feed: createFeed(Date.now()), now: () => Date.now() });
  setApiHost(createTourApi(store, () => Date.now()));
  setNotificationHost(createTourNotifications());
  setAddressHost({
    go(href) {
      location.replace(href);
      return false;
    },
  });
  localStorage.setItem("agent-lookout-notifications", "on");
  const clock = stillClock();
  const drawn: { index: number; step: number }[] = [];
  const jumped: string[] = [];
  const director = createDirector({
    store,
    clock,
    instant: () => instant,
    onDrawn: (index, step) => drawn.push({ index, step }),
    onJumped: (words) => jumped.push(words),
  });
  return { store, clock, director, drawn, jumped };
}

/**
 * In the landing page's frame nothing takes focus while the tour plays, as
 * `frame.ts` has it, so focus going back to what opened a dialog never moves
 * the frame. This page has focus, so here focus is kept from scrolling it.
 */
const focus = HTMLElement.prototype.focus;

beforeEach(async () => {
  await page.viewport(1280, 737);
  history.replaceState(null, "", `${location.pathname}${location.search}#overview`);
  resetNotificationSettingForTests();
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    focus.call(this, { ...options, preventScroll: true });
  };
});

afterEach(() => {
  HTMLElement.prototype.focus = focus;
  setApiHost();
  setNotificationHost();
  setAddressHost();
  localStorage.clear();
  resetThemeForTests();
  resetNotificationSettingForTests();
  document.documentElement.removeAttribute("data-theme");
  delete document.documentElement.dataset.host;
  delete document.documentElement.dataset.still;
  history.replaceState(null, "", `${location.pathname}${location.search}`);
  window.scrollTo(0, 0);
});

/** Every scene and step, in order. */
const ALL = SCENES.flatMap((scene, index) => scene.steps.map((_, step) => ({ index, step })));

// It walks every step of every scene twice, which takes 10 to 12 seconds on CI's runners.
test("every scene and step lands as it says, played forward and then back", async () => {
  const { store, clock, director } = setUp();
  await render(createElement(App, { store }));

  for (const { index, step } of [...ALL, ...ALL.slice().reverse()]) {
    const scene = SCENES[index];
    const part = scene.steps[step];
    await director.apply(index, step, null);
    const label = `${scene.name}, part ${step + 1}`;

    // The view, from its address.
    await expect
      .poll(() => document.querySelector("main")?.dataset.view, { message: label })
      .toBe(scene.view);
    // The moment, and the lamp in the rail's mark with it.
    const waiting = countNeedingYou(store.getState().snapshot?.sessions);
    expect(waiting, label).toBe(momentFor(scene, null) === "waiting" ? 1 : 0);
    await expect
      .poll(() => document.querySelector('[data-slot="rail-mark"]')?.getAttribute("data-lit"), {
        message: label,
      })
      .toBe(String(waiting > 0));
    // The layout of the Sessions card.
    if (scene.view === "overview") {
      await expect
        .poll(
          () =>
            document
              .querySelector('[aria-label="Show sessions as"] [aria-checked="true"]')
              ?.textContent?.trim(),
          { message: label },
        )
        .toBe(LAYOUT_LABEL[part.layout]);
    }
    // Where the frame looks.
    const max = document.documentElement.scrollHeight - innerHeight;
    if (part.look === "top") {
      expect(window.scrollY, label).toBe(0);
    } else if (part.look === "Events") {
      // The row for watching resumed is pointed at, and in sight, with the log.
      const resumed = document.querySelector('[data-slot="event-resumed"]')!;
      expect(resumed.hasAttribute("data-tour-point"), label).toBe(true);
      const box = resumed.getBoundingClientRect();
      expect(box.top >= LOOK_MARGIN && box.bottom <= innerHeight, label).toBe(true);
    } else {
      const card = cardTitled(document, part.look)!;
      const top = card.getBoundingClientRect().top;
      expect(window.scrollY >= max - 1 || Math.abs(top - LOOK_MARGIN) <= 1, label).toBe(true);
    }
    if (part.point === "answer") {
      // The waiting session's request in the hero, whole, with Deny and Allow.
      const asked = document.querySelector('[data-slot="hero"] [data-slot="answer"]')!;
      expect(asked.hasAttribute("data-tour-point"), label).toBe(true);
      expect(asked.querySelector('[data-part="command"]')?.textContent, label).toBe("npm test");
      expect(asked.querySelector('[data-part="deny"]'), label).not.toBeNull();
      expect(asked.querySelector('[data-part="allow"]'), label).not.toBeNull();
    } else if (part.look !== "Events") {
      expect(document.querySelector("[data-tour-point]"), label).toBeNull();
    }
    if (part.details === WAITING_SESSION) {
      // The waiting session's details, with its pull request, and Stop, which only asks.
      await expect
        .poll(() => document.querySelector('[role="dialog"] [data-part="stop"]'), {
          message: label,
        })
        .not.toBeNull();
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.querySelector('[data-part="pull-request"]')?.textContent, label).toContain(
        "#214",
      );
      expect(dialog.querySelector('[data-part="pull-request-state"]')?.textContent, label).toBe(
        "Open, 1 check failing, 5 passing",
      );
      await expect
        .poll(() => dialog.querySelector('[data-part="stop-confirm"]'), { message: label })
        .not.toBeNull();
      expect(store.getState().snapshot?.sessions.some((one) => one.id === WAITING_SESSION)).toBe(
        true,
      );
    } else if (part.details === FINISHED_JOB) {
      // The finished job's details, with the command its Resume copies.
      await expect
        .poll(
          () =>
            document.querySelector('[role="dialog"] [data-part="resume-block"]')?.textContent ?? "",
          { message: label },
        )
        .toContain(`claude --resume ${FINISHED_JOB.slice("claude-code:".length)}`);
      expect(document.querySelector('[role="dialog"] [data-part="resume"]'), label).not.toBeNull();
    } else {
      await expect
        .poll(() => document.querySelector('[role="dialog"]'), { message: label })
        .toBeNull();
    }
    // The other machine's card says it is connected.
    if (part.look === MACHINE.name) {
      expect(cardTitled(document, MACHINE.name)?.textContent, label).toContain("Connected");
    }
    // Notifications as Settings shows them: off in its scene alone.
    expect(getNotificationSetting().choice, label).toBe(scene.notifications ?? "on");
    // The Mac app's window, held still.
    expect(document.documentElement.dataset.host, label).toBe(scene.app ? "app" : undefined);
    expect(clock.held, label).toBe(scene.app === true);
  }
}, 60_000);

test("the Jump scene presses the waiting session's Jump, which says where it went", async () => {
  const { store, director, jumped } = setUp();
  await render(createElement(App, { store }));
  const jump = SCENES.findIndex((scene) => scene.press === "jump");
  await director.apply(jump - 1, 0, null);
  await director.apply(jump, 0, null);
  // Said beside the name, and to assistive technology.
  await expect
    .poll(() => (document.querySelector('[data-slot="hero"]') as HTMLElement | null)?.innerText)
    .toContain("Switched to Terminal");
  expect(
    document
      .querySelector('[data-slot="hero"] [data-part="jump"]')
      ?.hasAttribute("data-tour-pressed"),
  ).toBe(true);
  // And the page is told, in the dashboard's own words.
  await expect.poll(() => jumped).toEqual(["Switched to Terminal"]);
});

test("with motion, a scene that changes the view comes in through a view transition and says when it is drawn", async () => {
  const { store, director, drawn } = setUp({ instant: false });
  await render(createElement(App, { store }));
  await director.apply(0, 0, null);
  const started: unknown[] = [];
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = ((update: ViewTransitionUpdateCallback) => {
    started.push(update);
    return start(update);
  }) as typeof document.startViewTransition;
  try {
    const sources = SCENES.findIndex((scene) => scene.view === "sources");
    await director.apply(sources, 0, null);
    expect(started).toHaveLength(1);
    expect(document.querySelector("main")?.dataset.view).toBe("sources");
    await expect.poll(() => drawn.at(-1)).toEqual({ index: sources, step: 0 });
    // A move of where the frame looks alone is a scroll, not a transition.
    await director.apply(sources, 1, null);
    expect(started).toHaveLength(1);
  } finally {
    document.startViewTransition = start;
  }
});

test("the Mac app's still is held where the wait was last seen, so its timer agrees with the log", async () => {
  const { store, clock, director } = setUp();
  const held: (number | undefined)[] = [];
  clock.hold = (at) => {
    held.push(at);
  };
  await render(createElement(App, { store }));
  await director.apply(1, 0, null);
  const history = SCENES.findIndex((scene) => scene.name === "History");
  await director.apply(history, 0, null);
  const left = store.waitLeftAt();
  expect(left).not.toBeNull();
  await director.apply(SCENES.length - 1, 0, null);
  expect(held.at(-1)).toBe(left);
});

test("a session's details left open are closed by the next scene", async () => {
  const { store, director } = setUp();
  await render(createElement(App, { store }));
  await director.apply(0, 0, null);
  const id = store.getState().snapshot!.sessions[0].id;
  location.replace(`#overview/session/${id}`);
  await expect.poll(() => document.querySelector('[role="dialog"]')).not.toBeNull();
  await director.apply(
    SCENES.findIndex((scene) => scene.view === "sources"),
    0,
    null,
  );
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  expect(location.hash).toBe("#sources");
});

test("the lamp's switch shows a wait over any scene, and puts it out over a waiting one", async () => {
  const { store, director } = setUp();
  await render(createElement(App, { store }));
  await director.apply(
    SCENES.findIndex((scene) => scene.view === "sources"),
    0,
    "waiting",
  );
  expect(countNeedingYou(store.getState().snapshot?.sessions)).toBe(1);
  await director.apply(1, 0, "quiet");
  expect(countNeedingYou(store.getState().snapshot?.sessions)).toBe(0);
});

test("the Stop scene presses Stop in the details, which asks, and nothing is stopped", async () => {
  const { store, director } = setUp();
  await render(createElement(App, { store }));
  const stop = SCENES.findIndex((scene) => scene.press === "stop");
  await director.apply(stop - 1, 0, null);
  await director.apply(stop, 0, null);
  await expect
    .poll(() => document.querySelector('[role="dialog"] [data-part="question"]')?.textContent)
    .toBe("Stop checkout-flow?");
  expect(
    document.querySelector('[role="dialog"] [data-part="stop"]')?.getAttribute("aria-expanded"),
  ).toBe("true");
  expect(store.getState().snapshot?.sessions.some((one) => one.id === WAITING_SESSION)).toBe(true);
  // Played again from the scene after, it asks afresh.
  await director.apply(stop + 1, 0, null);
  await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
  await director.apply(stop, 0, null);
  await expect
    .poll(() => document.querySelector('[role="dialog"] [data-part="stop-confirm"]'))
    .not.toBeNull();
});
