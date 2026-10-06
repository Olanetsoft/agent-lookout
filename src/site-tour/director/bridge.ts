/**
 * The words the landing page and its dashboard say to each other, over
 * `postMessage`, both ways. Each side takes a message only from the other, at
 * the page's own address, and only in a shape it knows, so neither can be
 * driven by anything else, and neither can throw into the other.
 */

export type Theme = "light" | "dark";
export type Lamp = "quiet" | "waiting";
export type Mode = "tour" | "yours";

/** What the page says to the dashboard. */
export type PageMessage =
  /** Put the dashboard in this scene and step. A lamp set by the page's switch overrides the scene's. */
  | { type: "scene"; index: number; step: number; lamp: Lamp | null }
  | { type: "theme"; theme: Theme }
  /** The visitor pressed the lamp's switch: whatever is showing shows this moment. */
  | { type: "lamp"; lamp: Lamp }
  /** "tour": the page drives it. "yours": the visitor does. */
  | { type: "mode"; mode: Mode }
  /** A tap on the frame, where it landed in the dashboard's own pixels. */
  | { type: "tap"; x: number; y: number };

/** What the dashboard says to the page. */
export type TourMessage =
  /** Drawn and ready to be shown, with the words of the notification a wait sends. */
  | { type: "ready"; notice: { title: string; body: string } }
  /** A scene is on its way to the screen: what changes in it starts to move now. */
  | { type: "drawn"; index: number; step: number }
  /** The tour pressed a Jump, and the dashboard said where it went, in its own words. */
  | { type: "jumped"; words: string }
  /** How many sessions need you now. */
  | { type: "lamp"; waiting: number }
  | { type: "notification"; title: string; body: string }
  | { type: "notification-closed" }
  /** The visitor has started to use the dashboard: a pointer or the keyboard is in it. */
  | { type: "took-over" }
  /** The dashboard's own switches chose a theme. */
  | { type: "theme"; theme: Theme }
  /** Escape with nothing open: the visitor gives the dashboard back. */
  | { type: "leave" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isTheme = (value: unknown): value is Theme => value === "light" || value === "dark";
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

/** A message from the page, or null when it is not one. */
export function readPageMessage(data: unknown): PageMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case "scene":
      return isCount(data.index) &&
        isCount(data.step) &&
        (data.lamp === null || data.lamp === "quiet" || data.lamp === "waiting")
        ? { type: "scene", index: data.index, step: data.step, lamp: data.lamp }
        : null;
    case "theme":
      return isTheme(data.theme) ? { type: "theme", theme: data.theme } : null;
    case "lamp":
      return data.lamp === "quiet" || data.lamp === "waiting"
        ? { type: "lamp", lamp: data.lamp }
        : null;
    case "mode":
      return data.mode === "tour" || data.mode === "yours"
        ? { type: "mode", mode: data.mode }
        : null;
    case "tap":
      return typeof data.x === "number" &&
        typeof data.y === "number" &&
        Number.isFinite(data.x) &&
        Number.isFinite(data.y)
        ? { type: "tap", x: data.x, y: data.y }
        : null;
    default:
      return null;
  }
}

export interface Bridge {
  send(message: TourMessage): void;
}

/**
 * The dashboard's end: hears the page that holds it, and only that page,
 * and answers it at its own address.
 */
export function openBridge(
  onMessage: (message: PageMessage) => void,
  win: Window = window,
): Bridge {
  const page = win.parent;
  const origin = win.location.origin;
  win.addEventListener("message", (event) => {
    if (event.origin !== origin || event.source !== page) return;
    const message = readPageMessage(event.data);
    if (message) onMessage(message);
  });
  return {
    send(message) {
      if (page === win) return;
      page.postMessage(message, origin);
    },
  };
}
