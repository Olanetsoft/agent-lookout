import type { IncomingMessage } from "node:http";

import type { RuleAnswer } from "../../core/api.ts";
import type { PermissionRule } from "../../core/permission-rules/permissionRules.ts";
import type {
  AnswerDecision,
  AnsweringStatus,
  SessionsSnapshot,
} from "../../core/sessions/session.ts";
import type { EventStore } from "../eventStore.ts";
import { refusal, type ApiAnswer } from "../handler.ts";
import type { Poller } from "../poller.ts";
import { answerRefusalFor, createAnswerer, createAnswerRoute } from "./answerRoute.ts";
import { readAnswerSetup } from "./answerSettings.ts";
import {
  createHeldAsks,
  type AnswerOutcome,
  type HeldAsks,
  type StatusReader,
} from "./heldAsks.ts";
import { createHookSocket, type HookSocket } from "./hookSocket.ts";
import { createRegistryStatus } from "./registryStatus.ts";
import { createRuleAnswers } from "./ruleAnswers.ts";

/**
 * What became of an answer given in the host's own process, as the Mac app
 * gives one: what the route would say, or `unavailable` while the socket
 * could not be opened, so nothing is held.
 */
export type InProcessOutcome = AnswerOutcome | "unavailable";

/**
 * Answering permission prompts from the dashboard, in one piece: the socket
 * the plugin's hook sends to, the requests held, the permission rules that
 * may answer them, the route the page answers through, and the same answer
 * in-process for the Mac app, which has no route of its own for it. With
 * `AGENT_LOOKOUT_ANSWER=off` there is none of it, and no rule answers
 * anything.
 */
export interface Answering {
  /** Opens the socket. Resolves once it listens, or has said why it cannot. */
  start(): Promise<void>;
  /** Lets every held request go and closes the socket. */
  stop(): Promise<void>;
  /** The snapshot as the page is sent it: each held request, and whether answering is on. */
  serve(snapshot: SessionsSnapshot): SessionsSnapshot;
  /** Told of each poll's sessions. */
  observe(snapshot: SessionsSnapshot): void;
  /**
   * Of one poll's sessions, the ids of those still in a wait whose permission
   * request was answered, or that a rule is answering, as the poll's snapshot
   * is made. None while answering is off.
   */
  answeredIn(snapshot: Pick<SessionsSnapshot, "sources" | "sessions">): ReadonlySet<string>;
  /**
   * Answers `POST /api/permission/answer`, or undefined while answering is
   * off. While the socket could not be opened, a POST that passes the route's
   * checks gets 405, as it would with no route.
   */
  route?: (req: IncomingMessage) => Promise<ApiAnswer>;
  /**
   * Answers a held request from the host's own process, through the path the
   * route takes, with every check it makes, and an event of it in the Events
   * log. Undefined while answering is off.
   */
  answer?: (
    sessionId: string,
    requestId: string,
    decision: AnswerDecision,
  ) => Promise<InProcessOutcome>;
  /**
   * Reads each held request's registry file again now, as the half-second
   * check does, so a request whose wait a poll has just seen is shown at once.
   */
  check(): Promise<void>;
  /** The requests the permission rules answered since start, newest first. None while answering is off. */
  ruleAnswers(): RuleAnswer[];
}

export interface AnsweringOptions {
  env: NodeJS.ProcessEnv;
  poller: Pick<Poller, "getSnapshot" | "pollOnce">;
  events: Pick<EventStore, "add">;
  now?: () => number;
  homeDir?: string;
  platform?: NodeJS.Platform;
  /** Reads a session's registry file again. Tests pass their own. */
  status?: StatusReader;
  /** Where the line goes that says answering could not be turned on. */
  warn?: (line: string) => void;
  /** Runs the held requests' checks. Tests pass one that does nothing. */
  every?: (run: () => void, ms: number) => () => void;
  /** The permission rules in force, read again for each request. Left out, there are none. */
  rules?: () => readonly PermissionRule[];
  /** The settings file the rules are kept in, which no command a rule allows may name. */
  settingsFile?: string;
}

export function createAnswering(options: AnsweringOptions): Answering {
  const { env, poller, events } = options;
  const setup = readAnswerSetup(env, options.homeDir, options.platform);
  if (!setup.on) {
    if (setup.problem !== null && !setup.quiet) options.warn?.(setup.problem);
    const off: AnsweringStatus =
      setup.problem === null
        ? { state: "off", plugin: "unknown", holdMs: setup.holdMs }
        : { state: "unavailable", plugin: "unknown", problem: setup.problem, holdMs: setup.holdMs };
    return {
      start: async () => {},
      stop: async () => {},
      serve: (snapshot) => ({ ...snapshot, answering: off }),
      observe: () => {},
      answeredIn: () => new Set(),
      check: async () => {},
      ruleAnswers: () => [],
    };
  }

  const ruleAnswers = createRuleAnswers({
    rules: options.rules ?? (() => []),
    // A command that names the settings file or the socket could change the
    // rules or answer prompts, so no rule allows it, wherever they are.
    ownPaths: [options.settingsFile ?? "", setup.socketPath],
    poller,
    events,
    now: options.now,
  });

  const asks: HeldAsks = createHeldAsks({
    status: options.status ?? createRegistryStatus({ snapshot: poller.getSnapshot, env }),
    holdMs: setup.holdMs,
    now: options.now,
    every: options.every,
    rules: ruleAnswers,
  });
  const socket: HookSocket = createHookSocket({
    socketPath: setup.socketPath,
    asks,
    ownFolder: setup.ownFolder,
  });
  let problem: string | null = null;
  let listening = false;
  const answerRoute = createAnswerRoute({ poller, events, asks, now: options.now });
  const answer = createAnswerer({ poller, events, asks, now: options.now });

  return {
    async start() {
      const started = await socket.start();
      listening = started.ok;
      problem = started.ok ? null : started.problem;
      if (problem !== null) options.warn?.(problem);
    },
    async stop() {
      listening = false;
      await socket.close();
    },
    serve(snapshot) {
      if (problem !== null) {
        return {
          ...snapshot,
          answering: { state: "unavailable", plugin: "unknown", holdMs: setup.holdMs, problem },
        };
      }
      return asks.withAsks(snapshot);
    },
    observe(snapshot) {
      if (listening) asks.observe(snapshot);
    },
    answeredIn: (snapshot) => asks.answeredIn(snapshot),
    // A socket that could not be opened holds no request, so there is nothing
    // to answer. Past the route's own checks, a POST is told what it would be
    // told with answering off, where there is no such route.
    async route(req) {
      if (problem === null) return answerRoute(req);
      req.resume();
      return (
        answerRefusalFor(req) ??
        refusal(405, "This address only answers GET requests.", { Allow: "GET" })
      );
    },
    // The same answer, from the host's own process. With no socket nothing is held.
    answer: async (sessionId, requestId, decision) =>
      problem === null ? answer(sessionId, requestId, decision) : "unavailable",
    check: () => asks.check(),
    ruleAnswers: () => ruleAnswers.recent(),
  };
}
