import type { SessionsLayout } from "@dashboard/lib/shell/sessionsLayout";
import type { ViewId } from "@dashboard/lib/shell/view";
import { FINISHED_JOB, MACHINE, WAITING_SESSION, type MomentName } from "@site-tour/feed/hour";

/**
 * The scenes of the landing page's dashboard: twelve states, each a moment of
 * the hour and a place in the dashboard, that the page's frame and the scripts
 * that take its pictures put the dashboard in. The frame shows the first two,
 * with nothing waiting and with a session waiting; the pictures show those and
 * the others. A scene is a state, not a sequence of moves, so it lands the same
 * from any scene before or after it.
 */

/** What the frame shows of the view: its top, or one card brought to the top. */
export type Look =
  | "top"
  | "Sessions"
  | "Last hour"
  | "Events"
  | "Waits"
  | typeof MACHINE.name
  | "What each agent can report"
  | "Time rules";

/** One part of a scene. Most scenes have one; a scene of two halves has two. */
export interface SceneStep {
  layout: SessionsLayout;
  look: Look;
  /** The details of this session are open over the Overview. */
  details?: string;
  /** The part of the screen the scene is about, marked as the History scene marks its row. */
  point?: "answer";
}

export interface Scene {
  /** The scene's name, by which the picture scripts find it. */
  name: string;
  moment: MomentName;
  view: ViewId;
  steps: readonly SceneStep[];
  /** Pressed once the scene is in place: the hero's Jump, or Stop in the session's details. */
  press?: "jump" | "stop";
  /** The scene is of the notification the wait sends, which the dashboard itself does not draw. */
  banner?: true;
  /** Drawn as the Mac app's window, and held still. */
  app?: true;
  /** Notifications as Settings shows them: on, as the visitor in the tour has turned them, unless this says off. */
  notifications?: "off";
  /** Pull requests, the same: on, unless this says off. */
  pullRequests?: "off";
}

const LIST_AT_TOP: SceneStep = { layout: "list", look: "top" };

export const SCENES: readonly Scene[] = [
  {
    name: "One screen",
    moment: "quiet",
    view: "overview",
    steps: [LIST_AT_TOP, { layout: "list", look: "Sessions" }],
  },
  {
    name: "Needs you",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP],
  },
  {
    name: "Allow or Deny",
    moment: "waiting",
    view: "overview",
    steps: [{ layout: "list", look: "top", point: "answer" }],
  },
  {
    name: "Notification",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP],
    banner: true,
  },
  {
    name: "Jump",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP, { layout: "list", look: "Sessions" }],
    press: "jump",
  },
  {
    name: "Stop",
    moment: "waiting",
    view: "overview",
    steps: [{ layout: "list", look: "top", details: WAITING_SESSION }],
    press: "stop",
  },
  {
    name: "Board",
    moment: "waiting",
    view: "overview",
    steps: [
      { layout: "repositories", look: "Sessions" },
      { layout: "board", look: "Sessions" },
    ],
  },
  {
    name: "Resume",
    moment: "answered",
    view: "overview",
    steps: [{ layout: "list", look: "top", details: FINISHED_JOB }],
  },
  {
    name: "History",
    moment: "answered",
    view: "overview",
    steps: [
      { layout: "list", look: "Last hour" },
      { layout: "list", look: "Events" },
      { layout: "list", look: "Waits" },
    ],
  },
  {
    name: "Sources",
    moment: "answered",
    view: "sources",
    steps: [
      LIST_AT_TOP,
      { layout: "list", look: MACHINE.name },
      { layout: "list", look: "What each agent can report" },
    ],
  },
  {
    name: "Settings",
    moment: "answered",
    view: "settings",
    steps: [LIST_AT_TOP, { layout: "list", look: "Time rules" }],
    notifications: "off",
    pullRequests: "off",
  },
  {
    name: "Mac app",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP],
    app: true,
  },
];

/** Whether a session needs you in a scene: the lamp is lit. */
export function lampLit(scene: Scene): boolean {
  return scene.moment === "waiting";
}

/** The moment a scene shows, with the lamp switch's say over it. */
export function momentFor(scene: Scene, lamp: "quiet" | "waiting" | null): MomentName {
  if (lamp === "waiting") return "waiting";
  if (lamp === "quiet" && scene.moment === "waiting") return "answered";
  return scene.moment;
}
