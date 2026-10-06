import {
  getNotificationSetting,
  turnOffNotifications,
  turnOnNotifications,
} from "@dashboard/lib/notifications/notificationSetting";
import { sessionFromHash, sessionHref } from "@dashboard/lib/shell/sessionDetails";
import type { SessionsLayout } from "@dashboard/lib/shell/sessionsLayout";
import { viewFromHash } from "@dashboard/lib/shell/view";
import type { Lamp } from "@site-tour/director/bridge";
import { momentFor, SCENES, type Look, type Scene, type SceneStep } from "@site-tour/feed/scenes";
import type { Clock } from "@site-tour/host/clock";
import type { TourStore } from "@site-tour/host/tourStore";

/**
 * Puts the real dashboard into a scene of the tour, the way a person would,
 * and only through what a person can reach: the address of a view or of a
 * session's details, the options of the Sessions card's switch, the switch in
 * Settings, the page's own scroll, the Jump button and the Stop button, which
 * only asks. The moment of the hour, and whether pull requests are on, come
 * from the store.
 *
 * A scene is applied whole each time, so it lands the same from any scene
 * before or after it. A scene that is still being applied when the next one
 * comes is left where it is.
 *
 * When what the dashboard shows changes, and not only where it looks, the
 * change is made inside a view transition: the screen holds the last scene
 * while the next is drawn, then lets it in with a short fade and rise. The
 * work is made in steps, each its own task: the moment, then the view, then
 * the layout and where to look. Under reduced motion every change is made at
 * once.
 */

/** How far above a card the frame stops when it brings the card into view: the header and its inset. */
export const LOOK_MARGIN = 76;

/** Narrower than this the dashboard is drawn as on a phone, and the Mac app is not drawn as a window. */
export const PHONE_WIDTH = 761;

/** How long the tour's press of a button takes to go down, before it lets go. */
const PRESS_MS = 140;

/** How long a scene is seen before its button is pressed. */
const SEEN_MS = 420;

/** The waiting session's request in the hero, with Deny and Allow. */
const ASKED = '[data-slot="hero"] [data-slot="answer"]';

/**
 * What a card draws while it still reads its answer: the loading mark, as
 * Waits has it when it comes into the page, or the empty line a card in
 * Settings says its state on once it has read it.
 */
const READING = 'main [data-slot="loading"], main [data-part="state"]:empty';

/** What each of the Sessions card's options says. */
const LAYOUT_LABEL = { list: "List", repositories: "Repos", board: "Board" } as const;

export interface ApplyOptions {
  /** Applied while nobody sees it, so each view has been drawn once before the tour is shown: at once, and nothing pressed. */
  warm?: boolean;
}

export interface Director {
  /** Puts the dashboard in a scene and step, with the page's lamp over the scene's when it gives one. */
  apply(index: number, step: number, lamp: Lamp | null, options?: ApplyOptions): Promise<void>;
  /** The scene and step last applied, or null before the first. */
  readonly current: { index: number; step: number } | null;
}

export interface DirectorOptions {
  store: TourStore;
  clock: Clock;
  win?: Window & typeof globalThis;
  /** Whether a change is made at once, as under reduced motion. */
  instant?: () => boolean;
  /** Told when a scene starts to reach the screen. */
  onDrawn?: (index: number, step: number) => void;
  /** Told what the dashboard said a Jump the tour pressed came to. */
  onJumped?: (words: string) => void;
}

/** A section card, by its title: the region of that name. */
export function cardTitled(doc: Document, title: string): HTMLElement | null {
  for (const section of doc.querySelectorAll<HTMLElement>("section[aria-labelledby]")) {
    const id = section.getAttribute("aria-labelledby") ?? "";
    const heading = id ? doc.getElementById(id) : null;
    if (heading?.textContent?.trim().startsWith(title)) return section;
  }
  return null;
}

/** The dialogs open in the frame: a session's details, a history, the search or the shortcuts. */
function openDialogs(doc: Document): Element[] {
  return [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
}

/** Whether the scene shows the Mac app's window: on a screen wide enough to show a window. */
function asWindow(scene: Scene, win: Window): boolean {
  return scene.app === true && win.innerWidth >= PHONE_WIDTH;
}

export function createDirector({
  store,
  clock,
  win = window,
  instant = () => win.matchMedia("(prefers-reduced-motion: reduce)").matches,
  onDrawn = () => {},
  onJumped = () => {},
}: DirectorOptions): Director {
  const doc = win.document;
  const root = doc.documentElement;
  let current: { index: number; step: number } | null = null;
  let turn = 0;
  let pressed: Element | null = null;
  let pointed: Element | null = null;

  const frame = () => new Promise<void>((done) => win.requestAnimationFrame(() => done()));
  /** The next task. A view transition holds the frames back, so this never waits for one. */
  const nextTask = () =>
    new Promise<void>((done) => {
      const channel = new win.MessageChannel();
      channel.port1.onmessage = () => done();
      channel.port2.postMessage(null);
    });
  const wait = (ms: number) => new Promise<void>((done) => win.setTimeout(done, ms));

  /** Waits, a task at a time, until `test` holds, for at most `tries` tasks. */
  async function until(test: () => boolean, tries: number): Promise<void> {
    for (let at = 0; at < tries && !test(); at++) await nextTask();
  }

  const viewShown = () => doc.querySelector("main")?.dataset.view;

  function layoutShown(): SessionsLayout | null {
    const checked = doc
      .querySelector('[role="radiogroup"][aria-label="Show sessions as"] [aria-checked="true"]')
      ?.textContent?.trim();
    const found = Object.entries(LAYOUT_LABEL).find(([, label]) => label === checked);
    return found ? (found[0] as SessionsLayout) : null;
  }

  /** Whether this session's details are what is open. */
  const detailsShown = (id: string) =>
    sessionFromHash(win.location.hash) === id && openDialogs(doc).length > 0;

  function closeDialogs(): void {
    for (let tries = 0; tries < 4 && openDialogs(doc).length > 0; tries++) {
      doc.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
      );
    }
  }

  function goTo(view: string, details: string | undefined): void {
    const hash = win.location.hash;
    if (details !== undefined && sessionFromHash(hash) === details) return;
    if (viewFromHash(hash) === view && sessionFromHash(hash) === null && hash !== "") return;
    win.location.replace(`#${view}`);
  }

  function chooseLayout(label: string): void {
    const group = doc.querySelector('[role="radiogroup"][aria-label="Show sessions as"]');
    const option = [...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])].find(
      (radio) => radio.textContent?.trim() === label,
    );
    if (option && option.getAttribute("aria-checked") !== "true") option.click();
  }

  /** Notifications on or off, as the scene has them, through the switch's own functions. */
  function setNotifications(on: boolean): void {
    const chosen = getNotificationSetting().choice === "on";
    if (on && !chosen) void turnOnNotifications();
    else if (!on && chosen) turnOffNotifications();
  }

  function point(at: Element | null): void {
    if (pointed === at) return;
    pointed?.removeAttribute("data-tour-point");
    pointed = at;
    pointed?.setAttribute("data-tour-point", "");
  }

  /** Where the frame's own page is scrolled to so a card's top is under the header. */
  function topOf(card: HTMLElement | null, scrolled: number): number | null {
    const box = card?.getBoundingClientRect();
    return box ? box.top + scrolled - LOOK_MARGIN : null;
  }

  function look(at: Look, behavior: ScrollBehavior, mark?: SceneStep["point"]): void {
    const page = doc.scrollingElement ?? root;
    const scrolled = page.scrollTop;
    let top = 0;
    if (at !== "top") top = topOf(cardTitled(doc, at), scrolled) ?? 0;
    const max = page.scrollHeight - win.innerHeight;
    top = Math.max(0, Math.min(top, max));

    // The Events log scrolls on its own: its row for watching resumed, after the
    // gap the chart hatches, is brought to the middle of the part in sight, and
    // pointed at. Measured before the page moves.
    const resumed = at === "Events" ? doc.querySelector('[data-slot="event-resumed"]') : null;
    const list = resumed?.closest('[data-slot="event-list"]');
    let listTop: number | null = null;
    if (resumed && list instanceof HTMLElement) {
      const box = list.getBoundingClientRect();
      const shift = scrolled - top;
      const seen = Math.max(0, Math.min(box.bottom + shift, win.innerHeight) - (box.top + shift));
      const offset = resumed.getBoundingClientRect().top - box.top + list.scrollTop;
      listTop = Math.max(0, offset - seen / 2 + 16);
    }

    if (Math.abs(scrolled - top) > 1) win.scrollTo({ top, behavior });
    if (listTop !== null && list instanceof HTMLElement) list.scrollTo({ top: listTop, behavior });
    // The waiting session's request in the hero: the whole command, with Deny and Allow.
    const asked = mark === "answer" ? doc.querySelector(ASKED) : null;
    point(resumed ?? asked ?? null);
  }

  function unpress(): void {
    pressed?.removeAttribute("data-tour-pressed");
    pressed?.removeAttribute("data-tour-press");
    pressed = null;
  }

  /** A button, once it is drawn: it can be on its way in. */
  async function drawn(selector: string, mine: number): Promise<HTMLElement | null> {
    for (let waited = 0; waited < 90 && mine === turn; waited++) {
      const button = doc.querySelector<HTMLElement>(selector);
      if (button) return button;
      await frame();
    }
    return null;
  }

  /** Presses a button as a finger would. True once the press has landed. */
  async function press(button: HTMLElement, mine: number, quick: boolean): Promise<boolean> {
    unpress();
    // The ring a key would draw, without taking the keyboard out of the page.
    button.setAttribute("data-tour-pressed", "");
    pressed = button;
    if (!quick) {
      // The scene is seen first. Then the button goes down and comes back, as under a
      // finger, and the press lands as it comes back.
      await wait(SEEN_MS);
      if (mine !== turn) return false;
      button.setAttribute("data-tour-press", "");
      await wait(PRESS_MS);
      if (mine !== turn) return false;
    }
    button.click();
    return true;
  }

  /** Stop, in the details: it asks first, and the question is where the scene ends. */
  async function pressStop(mine: number, quick: boolean): Promise<void> {
    const stop = await drawn('[role="dialog"] [data-part="stop"]', mine);
    if (!stop || mine !== turn) return;
    if (await press(stop, mine, quick)) unpress();
  }

  async function pressJump(mine: number, quick: boolean): Promise<void> {
    // The hero's Jump, once the hero has drawn the waiting session.
    const jump = await drawn('[data-slot="hero"] [data-part="jump"]', mine);
    if (!jump || mine !== turn) return;
    if (!(await press(jump, mine, quick))) return;
    // What the dashboard says it came to, in its own words.
    for (let waited = 0; waited < 90 && mine === turn; waited++) {
      const note = doc.querySelector('[data-slot="hero"] [data-part="jump-note"]');
      const words = note?.textContent?.trim();
      if (words) {
        onJumped(words);
        return;
      }
      await frame();
    }
  }

  /** Whether applying the scene changes what is drawn, and not only where the frame looks. */
  function redraws(scene: Scene, part: SceneStep, moment: string): boolean {
    const { layout } = part;
    return (
      (part.details !== undefined ? !detailsShown(part.details) : openDialogs(doc).length > 0) ||
      (store.shown().pullRequests !== false) !== (scene.pullRequests !== "off") ||
      store.moment() !== moment ||
      viewShown() !== scene.view ||
      (scene.view === "overview" && layoutShown() !== layout) ||
      (root.dataset.host === "app") !== asWindow(scene, win) ||
      clock.held !== (scene.app === true) ||
      (getNotificationSetting().choice === "on") !== (scene.notifications !== "off")
    );
  }

  return {
    get current() {
      return current;
    },

    async apply(index, step, lamp, { warm = false } = {}) {
      const scene = SCENES[Math.min(index, SCENES.length - 1)];
      const part = scene.steps[Math.min(step, scene.steps.length - 1)];
      const mine = ++turn;
      const entering = current?.index !== index;
      const quick = warm || instant();
      const moment = momentFor(scene, lamp);
      const began = win.performance.now();
      current = { index, step };

      /** The scene, in steps, each its own task, so no one task draws it all. */
      const update = async (held: boolean): Promise<void> => {
        if (!(part.details !== undefined && detailsShown(part.details))) closeDialogs();
        if (entering) unpress();
        // The clock first, so the moment is worked out at the time it shows. The Mac app's
        // still is held where the wait was last seen, so its timer says what the log says.
        if (scene.app) clock.hold(store.waitLeftAt() ?? undefined);
        else clock.release();
        store.setPullRequests(scene.pullRequests !== "off");
        store.show(moment);
        if (scene.app) store.refresh();
        // The dashboard's clock reads the time at once, as when a page comes back into
        // sight, so a wait just answered is in the log on the same drawing.
        doc.dispatchEvent(new Event("visibilitychange"));
        await nextTask();
        if (mine !== turn) return;

        setNotifications(scene.notifications !== "off");
        if (asWindow(scene, win)) root.dataset.host = "app";
        else delete root.dataset.host;
        if (scene.app) root.dataset.still = "";
        else delete root.dataset.still;
        goTo(scene.view, part.details);
        await until(() => viewShown() === scene.view, 60);
        if (mine !== turn) return;

        if (scene.view === "overview" && layoutShown() !== part.layout) {
          chooseLayout(LAYOUT_LABEL[part.layout]);
          await nextTask();
          if (mine !== turn) return;
        }
        // The request the scene points at, once the hero has drawn it.
        if (part.point === "answer") {
          await until(() => doc.querySelector(ASKED) !== null, 60);
          if (mine !== turn) return;
        }
        // The cards still reading their answers, as Waits does when it comes into the page,
        // are let finish first, so the frame stops where the card ends up: a card that grows
        // once it has read, as Permission rules in Settings does, changes how far the page
        // can scroll.
        if (part.look !== "top") {
          await until(
            () => cardTitled(doc, part.look) !== null && doc.querySelector(READING) === null,
            60,
          );
          if (mine !== turn) return;
        }
        look(part.look, held || quick ? "instant" : "smooth", part.point);
        // The session's details, opened by their address, as its name's link opens them.
        const details = part.details;
        if (details !== undefined && sessionFromHash(win.location.hash) !== details) {
          win.location.replace(sessionHref(details));
          await until(() => detailsShown(details), 60);
          if (mine !== turn) return;
        }
        // Inside a view transition the new view rises into place as it comes in.
        if (held) root.dataset.tourRise = root.dataset.tourRise === "a" ? "b" : "a";
      };

      const start = (doc as Document & { startViewTransition?: Document["startViewTransition"] })
        .startViewTransition;
      if (!quick && start && redraws(scene, part, moment)) {
        const transition = start.call(doc, () => update(true));
        const drawn = () => {
          if (mine === turn) onDrawn(index, step);
        };
        transition.ready.then(drawn, drawn);
        await transition.updateCallbackDone.catch(() => {});
      } else {
        await update(false);
        if (!warm) {
          await frame();
          if (mine === turn) onDrawn(index, step);
        }
      }
      // How long the scene took to be drawn, for the page's own checks.
      win.performance.measure("tour:scene", { start: began, end: win.performance.now() });
      if (mine !== turn || warm || !entering) return;
      if (scene.press === "jump" && step === 0) await pressJump(mine, quick);
      if (scene.press === "stop" && part.details !== undefined) await pressStop(mine, quick);
    },
  };
}
