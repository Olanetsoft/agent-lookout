import type { IncomingMessage } from "node:http";

import {
  JUMP_INTERVAL_MS,
  type JumpFailure,
  type JumpRefusal,
  type JumpResponse,
} from "../core/api.ts";
import type { Session } from "../core/sessions/session.ts";
import { actionRefusalFor, readRequestBody, refusal, type ApiAnswer } from "./handler.ts";
import type { Poller } from "./poller.ts";
import { focusTab } from "./terminal/focusTab.ts";
import type { RunOsascript } from "./terminal/program.ts";
import type { TabFinder } from "./terminal/tabFinder.ts";
import type { TerminalTab } from "./terminal/terminalTabs.ts";
import type { PaneFinder } from "./tmux/paneFinder.ts";
import type { TmuxPane } from "./tmux/panes.ts";
import type { RunTmux } from "./tmux/program.ts";
import { selectPane } from "./tmux/selectPane.ts";

/** The most a request's body may hold. A session id is far shorter. */
export const MAX_JUMP_BODY_BYTES = 1024;

/** What `ACTION_HEADER` says on a request to this route. */
const ACTION = "jump";

/** The longest session id that is looked up, here and by the last message route. */
export const MAX_SESSION_ID_LENGTH = 300;

export interface JumpRouteOptions {
  /** The collector's own latest list of sessions. */
  poller: Pick<Poller, "getSnapshot">;
  /** The panes the collector found for its sessions' processes. */
  panes: Pick<PaneFinder, "paneOf" | "lookAgain">;
  run: RunTmux;
  /** The Terminal and iTerm2 tabs the collector found for its sessions' processes. */
  tabs: Pick<TabFinder, "tabOf" | "forget">;
  /** Runs osascript, to bring a tab forward. */
  osascript: RunOsascript;
  now?: () => number;
}

/** Where the collector found a session: the pane or the tab it acts on. */
type Found = { kind: "tmux"; pane: TmuxPane } | { kind: "terminal"; pid: number; tab: TerminalTab };

/**
 * The pane or the tab the collector found for a session it lists, going by the
 * kind of jump it gave the session, or undefined when it found neither.
 */
function foundFor(
  session: Session | undefined,
  panes: Pick<PaneFinder, "paneOf">,
  tabs: Pick<TabFinder, "tabOf">,
): Found | undefined {
  const pid = session?.pid;
  if (pid === undefined) return undefined;
  if (session?.jump?.kind === "tmux") {
    const pane = panes.paneOf(pid);
    return pane && { kind: "tmux", pane };
  }
  if (session?.jump?.kind === "terminal") {
    const tab = tabs.tabOf(pid);
    return tab && { kind: "terminal", pid, tab };
  }
  return undefined;
}

const failed = (status: number, reason: JumpFailure, error: string, headers = {}): ApiAnswer => ({
  status,
  body: { error, reason } satisfies JumpRefusal,
  headers,
});

/**
 * Why a request to the jump route is refused before its body is read, or null
 * when it may proceed: `actionRefusalFor` in `handler.ts`, with `jump` as the
 * action. This route changes which tmux pane is selected, or which Terminal or
 * iTerm2 tab is in front, so it must be one only the dashboard's own page can
 * send.
 */
export function jumpRefusalFor(req: Pick<IncomingMessage, "method" | "headers">): ApiAnswer | null {
  return actionRefusalFor(req, ACTION, MAX_JUMP_BODY_BYTES);
}

/**
 * The session id a body names, or null when the body is anything but a JSON
 * object with the one field `sessionId`, a string. A body that says more is not
 * read for the part that fits.
 */
export function sessionIdIn(body: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "sessionId") return null;
  const { sessionId } = value as { sessionId: unknown };
  if (typeof sessionId !== "string" || sessionId === "") return null;
  return sessionId.length <= MAX_SESSION_ID_LENGTH ? sessionId : null;
}

/**
 * Answers `POST /api/jump`: selects the tmux pane a session runs in, or brings
 * forward the Terminal or iTerm2 tab it runs in.
 *
 * The request names a session and nothing else. The session is looked up in
 * the collector's own list, and the pane or tab is the one the collector found
 * for that session's process: the pane when it last asked tmux, the tab's
 * terminal when it asked `ps`. So nothing a request holds reaches a command:
 * not a pane, not a terminal, not a name, not an argument. The most a request
 * can do is choose which of the places already found is brought forward.
 *
 * One jump is made a second, and one at a time. A tab's can take as long as a
 * person takes to answer macOS the first time, and no other is made meanwhile.
 */
export function createJumpRoute(options: JumpRouteOptions) {
  const { poller, panes, run, tabs, osascript } = options;
  const now = options.now ?? Date.now;

  let lastAt: number | null = null;
  let underWay = false;

  async function bringForward(pid: number, tab: TerminalTab): Promise<ApiAnswer> {
    const outcome = await focusTab(tab, osascript);
    if (outcome.ok) {
      return {
        status: 200,
        body: { ok: true, kind: "terminal", app: tab.app, place: tab.app } satisfies JumpResponse,
      };
    }
    if (outcome.reason === "tab-gone") {
      // What was found may be out of date, so it is looked for again.
      tabs.forget(pid);
      return failed(409, "tab-gone", "That tab has closed.");
    }
    if (outcome.reason === "not-allowed") {
      return failed(
        403,
        "not-allowed",
        `macOS has not allowed Agent Lookout to control ${tab.app}. Allow it in System Settings, Privacy & Security, Automation.`,
      );
    }
    return failed(500, "failed", `${tab.app} could not be asked to bring the tab forward.`);
  }

  return async function answerJump(req: IncomingMessage): Promise<ApiAnswer> {
    const refused = jumpRefusalFor(req);
    if (refused) {
      req.resume();
      return refused;
    }

    const body = await readRequestBody(req, MAX_JUMP_BODY_BYTES);
    if (!body.ok) {
      req.resume();
      return body.tooLarge
        ? refusal(413, `The body must be no more than ${MAX_JUMP_BODY_BYTES} bytes.`)
        : refusal(400, "The body could not be read.");
    }
    const sessionId = sessionIdIn(body.text);
    if (sessionId === null) {
      return refusal(400, 'The body must name one session and nothing else: {"sessionId": "..."}.');
    }

    const session = poller.getSnapshot().sessions.find((candidate) => candidate.id === sessionId);
    const found = foundFor(session, panes, tabs);
    if (!found) {
      return failed(404, "no-pane", "No tmux pane or terminal tab is known for that session.");
    }

    const at = now();
    const tooSoon = lastAt !== null && at >= lastAt && at - lastAt < JUMP_INTERVAL_MS;
    if (underWay || tooSoon) {
      return failed(429, "too-soon", "One jump is made a second. Try again in a moment.", {
        "Retry-After": "1",
      });
    }

    lastAt = at;
    underWay = true;
    try {
      if (found.kind === "terminal") return await bringForward(found.pid, found.tab);
      const { pane } = found;
      const outcome = await selectPane(pane.id, run);
      if (outcome.ok) {
        return {
          status: 200,
          body: {
            ok: true,
            kind: "tmux",
            place: outcome.place ?? pane.place,
          } satisfies JumpResponse,
        };
      }
      if (outcome.reason === "failed") {
        return failed(500, "failed", "tmux could not be asked to select the pane.");
      }
      // What was found is out of date, so tmux is asked again at the next poll.
      panes.lookAgain();
      return outcome.reason === "pane-gone"
        ? failed(409, "pane-gone", "That pane has closed.")
        : failed(409, "tmux-stopped", "tmux is not running.");
    } finally {
      underWay = false;
    }
  };
}
