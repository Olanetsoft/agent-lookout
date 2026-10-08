import type { SessionsLayout } from "@dashboard/lib/shell/sessionsLayout";
import type { ViewId } from "@dashboard/lib/shell/view";
import { FINISHED_JOB, MACHINE, WAITING_SESSION, type MomentName } from "@site-tour/feed/hour";

/**
 * The tour of the landing page: twelve scenes, each a moment of the hour and
 * a place in the dashboard, played in order as the page scrolls. A scene is a
 * state, not a sequence of moves, so scrolling back shows the earlier one
 * exactly as it was.
 *
 * The page holds the same names and lines in its own HTML, so they read
 * without script. A test holds the two to each other.
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
  /** The step's name on the page. */
  name: string;
  /** The one line said beside it. */
  line: string;
  moment: MomentName;
  view: ViewId;
  steps: readonly SceneStep[];
  /** Pressed once the scene is in place: the hero's Jump, or Stop in the session's details. */
  press?: "jump" | "stop";
  /** The page shows the notification the wait sent, over the frame. */
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
    line: "Every Claude Code, Codex and Antigravity CLI session on this computer, and your own agents, on one page.",
    moment: "quiet",
    view: "overview",
    steps: [LIST_AT_TOP, { layout: "list", look: "Sessions" }],
  },
  {
    name: "Needs you",
    line: "A Claude Code session stops to ask. The lamp lights, and it moves to the top with what it is asking.",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP],
  },
  {
    name: "Allow or Deny",
    line: "With the Agent Lookout plugin in Claude Code, the whole command is shown, with Deny and Allow.",
    moment: "waiting",
    view: "overview",
    steps: [{ layout: "list", look: "top", point: "answer" }],
  },
  {
    name: "Notification",
    line: "With notifications on, your browser tells you. The Mac app tells you itself, with its window closed too.",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP],
    banner: true,
  },
  {
    name: "Jump",
    line: "Jump takes you to a Claude Code session in VS Code, tmux, Terminal or iTerm2, from the top or its row.",
    moment: "waiting",
    view: "overview",
    steps: [LIST_AT_TOP, { layout: "list", look: "Sessions" }],
    press: "jump",
  },
  {
    name: "Stop",
    line: "With pull requests on, a session’s details show its checks. Stop, which asks first, is for Claude Code only.",
    moment: "waiting",
    view: "overview",
    steps: [{ layout: "list", look: "top", details: WAITING_SESSION }],
    press: "stop",
  },
  {
    name: "Board",
    line: "Each session shows its git branch. Group them by repository, or lay them out as a board.",
    moment: "waiting",
    view: "overview",
    steps: [
      { layout: "repositories", look: "Sessions" },
      { layout: "board", look: "Sessions" },
    ],
  },
  {
    name: "Resume",
    line: "A Claude Code background job that has finished has Resume, which copies the command that continues it.",
    moment: "answered",
    view: "overview",
    steps: [{ layout: "list", look: "top", details: FINISHED_JOB }],
  },
  {
    name: "History",
    line: "The Events log and the charts are kept across restarts. Waits adds up how long sessions waited on you.",
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
    line: "Sources says what is read for each agent, and from another machine over SSH that runs Agent Lookout.",
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
    line: "Time and permission rules, notifications, every channel and pull requests stay off until you set them up.",
    moment: "answered",
    view: "settings",
    steps: [LIST_AT_TOP, { layout: "list", look: "Time rules" }],
    notifications: "off",
    pullRequests: "off",
  },
  {
    name: "Mac app",
    line: "Or use the Mac app. Its menu bar and its Dock icon count the sessions that need you, and it updates itself.",
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

/** The scene and its step at a share of the tour, from 0 to 1. */
export function sceneAt(progress: number): { index: number; step: number } {
  const clamped = Math.min(Math.max(progress, 0), 1);
  const index = Math.min(SCENES.length - 1, Math.floor(clamped * SCENES.length));
  const within = clamped * SCENES.length - index;
  const steps = SCENES[index].steps.length;
  return { index, step: Math.min(steps - 1, Math.floor(within * steps)) };
}
