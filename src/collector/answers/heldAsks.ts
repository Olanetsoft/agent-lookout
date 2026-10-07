import { randomBytes } from "node:crypto";

import type {
  AnswerDecision,
  AnsweringStatus,
  PermissionAsk,
  Session,
  SessionsSnapshot,
} from "../../core/sessions/session.ts";
import type { RuleAnswers } from "./ruleAnswers.ts";
import { shownAsk, type ShownAsk } from "./shownAsk.ts";

/**
 * The permission requests Agent Lookout holds, while each session waits, so
 * the person can answer one from the dashboard, and the rules for letting
 * each go.
 *
 * Claude Code runs the plugin's hook as it is about to ask, and draws its own
 * prompt at the same time: in a terminal, in VS Code and in the desktop app
 * alike, whichever answers first wins. So a request is held on every surface,
 * and let go, with no answer, as soon as any of these is true:
 *
 * - The session's registry file no longer says it is waiting for permission,
 *   or says it is waiting in a wait that began after the request was
 *   confirmed: the person answered in the session. A Yes there leaves the
 *   hook running, so the file is the only sign of it. The file is read again every half second
 *   while a request is held, and a request whose session it has not yet said
 *   is waiting is given a moment's grace, since the file is written a moment
 *   after the hook starts.
 * - The hook's connection closes: Claude Code ended the hook, as it does for
 *   a No in the terminal, or the session ended.
 * - It has been held for `AGENT_LOOKOUT_ANSWER_WAIT`.
 * - A newer request of the same session arrives.
 *
 * A request is shown on the dashboard only once the registry has said the
 * session is waiting, and the registry is read again right before an answer
 * is written: it must still say the session waits for permission, in the same
 * wait it was confirmed in. Nothing of a request is kept but what is shown, and that only
 * in memory, for as long as it is held.
 *
 * At that same moment, the moment it would be shown, the request is put to
 * the permission rules, when there are any (`ruleAnswers.ts`). A deny or an
 * allow rule that decides it answers it at once, through `answer`, the one
 * path a press of Deny or Allow takes too, so it makes every check a press
 * makes, and the request is never shown. An ask rule, or none, leaves it held
 * for the person.
 */

/**
 * What the hook is told to print to allow the request. No `updatedInput` and
 * no `updatedPermissions`: nothing is rewritten and no rule is saved.
 */
export const ALLOW_OUTPUT = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
});

/**
 * The words Claude Code is given with a Deny. They say plainly that the person
 * chose it, so the model does not go looking for a hook that is broken.
 * The plugin's hook script holds both outputs letter for letter and prints
 * nothing else, so a change here is a change there too, and the words hold no
 * single quote.
 */
export const DENY_MESSAGE =
  "The person denied this from Agent Lookout. It was their choice, not a problem with a hook or a setting, so do not look for one. Do not try it again unless they ask.";

/** What the hook is told to print to deny the request. Claude carries on without the tool. */
export const DENY_OUTPUT = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: DENY_MESSAGE },
  },
});

/** The output for each answer. */
export function decisionOutput(decision: AnswerDecision): string {
  return decision === "allow" ? ALLOW_OUTPUT : DENY_OUTPUT;
}

/** How often the registry is read again while a request is held. */
export const CHECK_EVERY_MS = 500;

/** How long a request may wait for the registry to say its session is waiting. */
export const GRACE_MS = 3_000;

/** The most requests held at once. Past it, a request is let go at once. */
export const MAX_HELD = 32;

/**
 * How long a Claude Code session waits for permission before Agent Lookout
 * takes it that its request did not reach the socket.
 */
export const MISSED_AFTER_MS = 5_000;

/** How long the moment a session's last request arrived is kept, once it is not waiting. */
const REMEMBER_REQUEST_MS = 60_000;

/** The source a held request's session belongs to. */
const SOURCE = "claude-code";

/** A Claude Code session id, as Claude Code writes it: letters, digits and dashes. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/** The open response to one hook's request. */
export interface HookReply {
  /** Ends the hook's request with this body: an answer, or nothing at all. */
  send(body: string): void;
  /** Whether the hook is still waiting on it. */
  isOpen(): boolean;
  /** Told once, when the hook's connection closes before an answer was sent. */
  onClose(listener: () => void): void;
}

/** What a session's registry file says now, read again with nothing remembered. */
export type RegistryStatus = "waiting" | "not-waiting" | "unknown";

/**
 * A reading of a session's registry file. `waiting` is a wait for permission
 * only, and `wait` tells that wait from any later one: two readings of the
 * same wait have the same `wait`.
 */
export type RegistryReading =
  { status: "waiting"; wait: string } | { status: "not-waiting" | "unknown" };

export interface StatusReader {
  /** Reads the session's registry file again, by the id the collector lists it under. */
  statusOf(sessionId: string): Promise<RegistryReading>;
}

/** What a hook sent, with all but what is shown let go: the session it is for, and what it asks. */
export interface HookRequest {
  /** The id the collector lists the session under: `claude-code:<session_id>`. */
  sessionId: string;
  shown: ShownAsk;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parts of a hook's input that are kept, or null when it is not a
 * permission request: the session, the tool and its input, and whether a
 * subagent asks. Everything else, the transcript's path, the working folder,
 * the scratchpad, the prompt's id, the permission mode and the suggestions,
 * is let go here.
 */
export function readHookRequest(body: string): HookRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.hook_event_name !== "PermissionRequest") return null;
  const id = value.session_id;
  if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
  const shown = shownAsk(value.tool_name, value.tool_input, value.agent_id);
  return shown === null ? null : { sessionId: `${SOURCE}:${id}`, shown };
}

/** What became of an answer the person gave. */
export type AnswerOutcome = "answered" | "no-ask" | "not-allowable" | "gone" | "too-soon";

/** Why a request was let go with no answer, for the tests and nothing else. */
export type DropReason = "left-waiting" | "closed" | "limit" | "newer" | "full" | "stopped";

interface Held {
  requestId: string;
  sessionId: string;
  shown: ShownAsk;
  arrivedAt: number;
  until: number;
  reply: HookReply;
  /** Whether the registry has said the session is waiting since it arrived. */
  confirmed: boolean;
  /** The wait the registry said the session was in when it was confirmed. */
  wait: string | null;
  /** Whether an answer is being written. */
  answering: boolean;
}

export interface HeldAsksOptions {
  status: StatusReader;
  /** How long a request is held. */
  holdMs: number;
  now?: () => number;
  /** Runs `check` every so often while anything is held. Defaults to a timer. Tests pass one that does nothing. */
  every?: (run: () => void, ms: number) => () => void;
  /** Makes Agent Lookout's own id for a request. Defaults to 128 random bits. */
  newId?: () => string;
  /** Told of each request let go with no answer. */
  onDrop?: (reason: DropReason, sessionId: string) => void;
  /**
   * The permission rules, which may answer a request as it is confirmed, and
   * are told of each they answered. Left out, every request waits for the
   * person.
   */
  rules?: Pick<RuleAnswers, "verdictFor" | "answered">;
}

export interface HeldAsks {
  /** Holds a hook's request, letting go of an older one of the same session. */
  receive(request: HookRequest, reply: HookReply): void;
  /** Applies the rules now: reads each held session's registry file again, and lets go of what must go. */
  check(): Promise<void>;
  /** Writes the person's answer to the request the page showed, after reading the registry once more. */
  answer(sessionId: string, requestId: string, decision: AnswerDecision): Promise<AnswerOutcome>;
  /** The snapshot with each session's held request, once confirmed, and whether answering is on. */
  withAsks(snapshot: SessionsSnapshot): SessionsSnapshot;
  /** Told that a request arrived on the socket, for whether the plugin is installed. */
  noteRequest(sessionId: string | null): void;
  /** Told of each poll's sessions, to notice a permission prompt no request arrived for. */
  observe(snapshot: SessionsSnapshot): void;
  /** Whether answering is on, and whether the plugin's requests arrive. */
  status(): AnsweringStatus;
  /** Lets every request go, with no answer, as Agent Lookout stops. */
  dropAll(): void;
  /** How many requests are held. */
  readonly size: number;
}

const realEvery = (run: () => void, ms: number) => {
  const timer = setInterval(run, ms);
  timer.unref?.();
  return () => clearInterval(timer);
};

export function createHeldAsks(options: HeldAsksOptions): HeldAsks {
  const { status: reader, holdMs } = options;
  const now = options.now ?? Date.now;
  const every = options.every ?? realEvery;
  const newId = options.newId ?? (() => randomBytes(16).toString("hex"));
  const startedAt = now();
  const held = new Map<string, Held>();
  /** When a request last arrived for each session, for whether the plugin is installed. */
  const lastRequest = new Map<string, number>();
  let seenAt: number | null = null;
  let missedAt: number | null = null;
  let stopTimer: (() => void) | null = null;
  /** The check under way, if any. */
  let inFlight: Promise<void> | null = null;

  function drop(entry: Held, reason: DropReason): void {
    if (held.get(entry.sessionId) === entry) held.delete(entry.sessionId);
    if (entry.reply.isOpen()) entry.reply.send("");
    options.onDrop?.(reason, entry.sessionId);
    if (held.size === 0 && stopTimer !== null) {
      stopTimer();
      stopTimer = null;
    }
  }

  async function read(sessionId: string): Promise<RegistryReading> {
    try {
      return await reader.statusOf(sessionId);
    } catch {
      return { status: "unknown" };
    }
  }

  async function checkOne(entry: Held, at: number): Promise<void> {
    if (entry.answering) return;
    if (!entry.reply.isOpen()) return drop(entry, "closed");
    if (at >= entry.until) return drop(entry, "limit");
    const reading = await read(entry.sessionId);
    // Gone, or being answered, while the file was read.
    if (held.get(entry.sessionId) !== entry || entry.answering) return;
    if (reading.status === "waiting") {
      if (!entry.confirmed) {
        entry.confirmed = true;
        entry.wait = reading.wait;
        answerByRule(entry);
        return;
      }
      // Answered in the session, and waiting again since, for something else.
      if (reading.wait !== entry.wait) drop(entry, "left-waiting");
      return;
    }
    if (entry.confirmed || at - entry.arrivedAt >= GRACE_MS) drop(entry, "left-waiting");
  }

  /**
   * Applies the rules once, after any check under way has finished, so two
   * checks never read the same file at once and a caller always sees a check
   * made after it asked.
   */
  async function check(): Promise<void> {
    while (inFlight !== null) await inFlight;
    const at = now();
    const run = Promise.all([...held.values()].map((entry) => checkOne(entry, at))).then(() => {});
    inFlight = run;
    try {
      await run;
    } finally {
      if (inFlight === run) inFlight = null;
    }
  }

  /**
   * Writes the person's answer to the request the page showed, after reading
   * the registry once more. A rule's answer takes this same path.
   */
  async function answer(
    sessionId: string,
    requestId: string,
    decision: AnswerDecision,
  ): Promise<AnswerOutcome> {
    const entry = held.get(sessionId);
    // A request not yet shown cannot be answered.
    if (!entry || entry.requestId !== requestId || !entry.confirmed) return "no-ask";
    if (decision === "allow" && !entry.shown.allow) return "not-allowable";
    if (entry.answering) return "too-soon";
    entry.answering = true;
    const reading = await read(sessionId);
    if (held.get(sessionId) !== entry || !entry.reply.isOpen()) {
      if (held.get(sessionId) === entry) drop(entry, "closed");
      return "gone";
    }
    const sameWait = reading.status === "waiting" && reading.wait === entry.wait;
    if (!sameWait || now() >= entry.until) {
      drop(entry, sameWait ? "limit" : "left-waiting");
      return "gone";
    }
    held.delete(sessionId);
    entry.reply.send(decisionOutput(decision));
    if (held.size === 0 && stopTimer !== null) {
      stopTimer();
      stopTimer = null;
    }
    return "answered";
  }

  /**
   * Puts a request just confirmed to the rules, and answers it when a deny or
   * an allow rule decides it. Called before anything can serve it, and
   * `answer` marks it as being answered before it reads the registry again,
   * so the page never shows a request a rule answers.
   */
  function answerByRule(entry: Held): void {
    const rules = options.rules;
    if (rules === undefined) return;
    const request: HookRequest = { sessionId: entry.sessionId, shown: entry.shown };
    let verdict;
    try {
      verdict = rules.verdictFor(request);
    } catch {
      // A rule that cannot be applied answers nothing: the person decides.
      return;
    }
    if (verdict === null) return;
    void answer(entry.sessionId, entry.requestId, verdict.decision).then((outcome) => {
      if (outcome === "answered") rules.answered(request, verdict);
    });
  }

  function status(): AnsweringStatus {
    const plugin =
      seenAt !== null && (missedAt === null || seenAt > missedAt)
        ? "seen"
        : missedAt !== null
          ? "missed"
          : "unknown";
    return { state: "on", plugin, holdMs };
  }

  function toAsk(entry: Held): PermissionAsk {
    return { requestId: entry.requestId, ...entry.shown, until: entry.until };
  }

  return {
    receive(request, reply) {
      const at = now();
      const older = held.get(request.sessionId);
      if (older) drop(older, "newer");
      const entry: Held = {
        requestId: newId(),
        sessionId: request.sessionId,
        shown: request.shown,
        arrivedAt: at,
        until: at + holdMs,
        reply,
        confirmed: false,
        wait: null,
        answering: false,
      };
      if (held.size >= MAX_HELD) {
        drop(entry, "full");
        return;
      }
      held.set(request.sessionId, entry);
      reply.onClose(() => {
        if (held.get(entry.sessionId) === entry && !entry.answering) drop(entry, "closed");
      });
      stopTimer ??= every(() => {
        // A beat that comes while a check is under way is skipped, not queued.
        if (inFlight === null) void check();
      }, CHECK_EVERY_MS);
      void check();
    },

    check,

    answer,

    withAsks(snapshot) {
      const answering = status();
      if (held.size === 0) return { ...snapshot, answering };
      const sessions = snapshot.sessions.map((session: Session) => {
        const entry = held.get(session.id);
        if (!entry || !entry.confirmed || entry.answering || session.status !== "needs-you") {
          return session;
        }
        return { ...session, ask: toAsk(entry) };
      });
      return { ...snapshot, sessions, answering };
    },

    noteRequest(sessionId) {
      const at = now();
      seenAt = at;
      if (sessionId !== null) lastRequest.set(sessionId, at);
    },

    observe(snapshot) {
      const at = snapshot.generatedAt;
      const waitingIds = new Set<string>();
      for (const session of snapshot.sessions) {
        if (session.source !== SOURCE || session.status !== "needs-you") continue;
        if (session.waitingReason !== "permission" || session.alive === false) continue;
        waitingIds.add(session.id);
        const since = session.statusSince;
        // A wait that began before Agent Lookout listened could not have reached it.
        if (since === null || since < startedAt + 1_000) continue;
        if (at - since < MISSED_AFTER_MS) continue;
        const last = lastRequest.get(session.id);
        if (last !== undefined && last >= since - MISSED_AFTER_MS) continue;
        if (missedAt === null || since > missedAt) missedAt = since;
      }
      // What is remembered is only for the waits under way, and for a minute
      // after a request, since a request can come a poll before its wait shows.
      for (const [id, last] of lastRequest) {
        if (!waitingIds.has(id) && !held.has(id) && at - last > REMEMBER_REQUEST_MS) {
          lastRequest.delete(id);
        }
      }
    },

    status,

    dropAll() {
      for (const entry of [...held.values()]) drop(entry, "stopped");
    },

    get size() {
      return held.size;
    },
  };
}
