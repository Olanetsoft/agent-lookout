import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@dashboard/styles/index.css";
import "@site-tour/styles/tour.css";
import { changeNotice } from "@core/notices/waiting";
import App from "@dashboard/App";
import { ErrorBoundary } from "@dashboard/components/ui/feedback/ErrorBoundary";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { AUTOMATION_NOTE_STORAGE_KEY } from "@dashboard/lib/api/automationNote";
import { LAST_LOOKED_STORAGE_KEY } from "@dashboard/hooks/data/useNewSince";
import { setNotificationHost } from "@dashboard/lib/notifications/notificationHost";
import {
  NOTIFICATION_EVENTS_STORAGE_KEY,
  NOTIFICATIONS_STORAGE_KEY,
} from "@dashboard/lib/notifications/notificationSetting";
import { countNeedingYou } from "@dashboard/lib/sessions/sessions";
import { setAddressHost } from "@dashboard/lib/shell/addressHost";
import { SESSIONS_LAYOUT_STORAGE_KEY } from "@dashboard/lib/shell/sessionsLayout";
import {
  getThemeState,
  setThemePreference,
  subscribeToTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@dashboard/lib/shell/theme";
import { openBridge, type Lamp, type PageMessage } from "@site-tour/director/bridge";
import { createDirector } from "@site-tour/director/director";
import { guardFrame } from "@site-tour/director/frame";
import { createFeed } from "@site-tour/feed/derive";
import { momentFor, SCENES } from "@site-tour/feed/scenes";
import { installClock } from "@site-tour/host/clock";
import { installMemoryStorage } from "@site-tour/host/memoryStorage";
import { createTourApi } from "@site-tour/host/tourApi";
import { createTourNotifications } from "@site-tour/host/tourNotifications";
import { createTourStore } from "@site-tour/host/tourStore";

/*
 * The landing page's dashboard: the real one, in a frame of the page, given an
 * hour of its own to show and a host for each thing it would otherwise ask
 * the computer for. The page drives it from its scroll, scene by scene, until
 * the visitor takes it over, and the page takes it back.
 */

/** The theme the page around the frame is in: chosen there, or following the system. */
function pageTheme(): ThemePreference {
  try {
    const chosen = window.parent.document.documentElement.dataset.theme;
    return chosen === "light" || chosen === "dark" ? chosen : "system";
  } catch {
    return "system";
  }
}

const clock = installClock();
const t0 = clock.now();

/** What the dashboard keeps between visits, as a first visit with notifications turned on would have it. */
function seed(theme: ThemePreference): Record<string, string> {
  return {
    [THEME_STORAGE_KEY]: theme,
    [NOTIFICATIONS_STORAGE_KEY]: "on",
    [NOTIFICATION_EVENTS_STORAGE_KEY]: "needs-you",
    [SESSIONS_LAYOUT_STORAGE_KEY]: "list",
    [LAST_LOOKED_STORAGE_KEY]: String(t0),
    [AUTOMATION_NOTE_STORAGE_KEY]: "Terminal,iTerm2",
  };
}

const storage = installMemoryStorage(window, seed(pageTheme()));
document.documentElement.dataset.theme = getThemeState().resolved;
document.documentElement.dataset.mode = "tour";

const feed = createFeed(t0);
const store = createTourStore({ feed, now: clock.now, held: () => clock.held });
const notifications = createTourNotifications();
setApiHost(createTourApi(store, clock.now));
setNotificationHost(notifications);
// The frame's history is the page's, so a move in the dashboard replaces the address.
setAddressHost({
  go(href) {
    window.location.replace(href);
    return false;
  },
});
if (window.location.hash === "") window.location.replace("#overview");

const guards = guardFrame(window);
const director = createDirector({
  store,
  clock,
  onDrawn: (index, step) => bridge.send({ type: "drawn", index, step }),
  onJumped: (words) => bridge.send({ type: "jumped", words }),
});
let mode: "tour" | "yours" = "tour";
let lamp: Lamp | null = null;
let lastScene = { index: 0, step: 0 };

/** The theme the page last said, so a theme the dashboard turns to is not said back. */
let pageSaid = getThemeState().resolved;

const bridge = openBridge((message: PageMessage) => {
  switch (message.type) {
    case "scene":
      lastScene = { index: message.index, step: message.step };
      lamp = message.lamp;
      if (mode === "tour") void director.apply(message.index, message.step, lamp);
      break;
    case "lamp":
      lamp = message.lamp;
      store.show(momentFor(SCENES[Math.min(lastScene.index, SCENES.length - 1)], lamp));
      break;
    case "theme":
      pageSaid = message.theme;
      if (getThemeState().resolved !== message.theme) setThemePreference(message.theme);
      break;
    case "mode":
      setMode(message.mode);
      break;
    case "tap":
      tap(message.x, message.y);
      break;
  }
});

function setMode(next: "tour" | "yours"): void {
  if (next === mode) return;
  mode = next;
  document.documentElement.dataset.mode = next;
  guards.setYours(next === "yours");
  if (next === "tour") {
    lamp = null;
    // Picking the tour up again starts the dashboard afresh, in the theme the visitor chose.
    storage.fill(seed(getThemeState().preference));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    void director.apply(lastScene.index, lastScene.step, lamp);
  }
}

/** A tap the page passed in: pressed where it landed, as the tap itself would have. */
function tap(x: number, y: number): void {
  const target = document.elementFromPoint(x, y);
  if (!(target instanceof Element)) return;
  const control = target.closest<HTMLElement>(
    'a[href], button, [role="radio"], [role="button"], [tabindex]',
  );
  (control ?? (target as HTMLElement)).focus?.({ preventScroll: true });
  if (control) control.click();
  else target.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: x, clientY: y }));
}

// The visitor's hand in the frame, or the keyboard coming into it from the page, makes it theirs.
// A move of focus inside it does not: the dashboard moves focus itself as a scene is applied.
const takeOver = () => {
  if (mode === "tour") bridge.send({ type: "took-over" });
};
window.addEventListener("pointerdown", takeOver, { capture: true });
window.addEventListener("focus", takeOver);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented || mode !== "yours") return;
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
  bridge.send({ type: "leave" });
});

notifications.onShown(({ title, body }) => bridge.send({ type: "notification", title, body }));
notifications.onGone(() => bridge.send({ type: "notification-closed" }));

let saidWaiting = -1;
store.subscribe(() => {
  const waiting = countNeedingYou(store.getState().snapshot?.sessions);
  if (waiting === saidWaiting) return;
  saidWaiting = waiting;
  bridge.send({ type: "lamp", waiting });
});

subscribeToTheme(() => {
  const { resolved } = getThemeState();
  if (resolved === pageSaid) return;
  pageSaid = resolved;
  bridge.send({ type: "theme", theme: resolved });
});

const container = document.getElementById("root");
if (!container) throw new Error("The tour's page has no #root element to render into.");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App store={store} />
    </ErrorBoundary>
  </StrictMode>,
);

/** The words of the notification the wait sends, as the dashboard's notifier writes them. */
function waitWords(): { title: string; body: string } {
  const session = feed
    .snapshot({ moment: "waiting" }, clock.now())
    .sessions.find((one) => one.status === "needs-you");
  return session ? changeNotice({ event: "needs-you", session }) : { title: "", body: "" };
}

/**
 * Each view, moment and layout the tour shows, drawn once while the frame is
 * still hidden behind the page's picture, so no scene is drawn for the first
 * time while somebody watches: its code has run and its parts are fetched.
 */
const WARM: readonly (readonly [number, number])[] = [
  [1, 0],
  [5, 0],
  [6, 0],
  [6, 1],
  [7, 0],
  [8, 1],
  [8, 2],
  [9, 1],
  [9, 2],
  [10, 1],
  [11, 0],
  [0, 0],
];

/** When the browser has nothing else to do, or soon. */
const idle = () =>
  new Promise<void>((done) => {
    if (typeof requestIdleCallback === "function")
      requestIdleCallback(() => done(), { timeout: 400 });
    else setTimeout(done, 40);
  });

async function warmUp(): Promise<void> {
  await director.apply(0, 0, null, { warm: true });
  await document.fonts.ready;
  for (const [index, step] of WARM) {
    await idle();
    if (mode !== "tour") break;
    await director.apply(index, step, null, { warm: true });
  }
  // The visit starts afresh: nothing has waited yet, and the dashboard is as it was given.
  store.restart();
  storage.fill(seed(getThemeState().preference));
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  await director.apply(lastScene.index, lastScene.step, lamp, { warm: true });
}

void warmUp().then(() => {
  requestAnimationFrame(() => bridge.send({ type: "ready", notice: waitWords() }));
});
