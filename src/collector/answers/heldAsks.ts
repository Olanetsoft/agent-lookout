import { randomBytes } from "node:crypto";

import type {
  AnswerDecision,
  AnsweringStatus,
  PermissionAsk,
  Session,
  SessionsSnapshot,
} from "../../core/sessions/session.ts";
import { answeredNow, inAnsweredWait, type AnsweredWait } from "../../core/waits/answeredWaits.ts";
import type { AutoAnswer, RuleAnswers } from "./ruleAnswers.ts";
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
 *   or says it is waiting in another wait than the request was confirmed in:
 *   the person answered in the session. A Yes there leaves the hook running,
 *   so the file is the only sign of it. The file is read again every half
 *   second while a request is held, and a request whose session it has not yet
 *   said is waiting is given a moment's grace, since the file is written a
 *   moment after the hook starts. So is one confirmed in a wait that was just
 *   answered, or began more than a second before it arrived, since the file
 *   says the wait before for a second or two after that one's answer: within
 *   the same grace, it moves to a wait that began since, and from there to
 *   its own when that one was answered too. It is not shown while the file
 *   says none, and is a new request, by its id, once it is shown again.
 * - The hook's connection closes: Claude Code ended the hook, as it does for
 *   a No in the terminal, or the session ended.
 * - It has been held for `AGENT_LOOKOUT_ANSWER_WAIT`.
 * - A newer request of the same session arrives, unless a permission rule
 *   answers this one. Then it is kept aside until its wait is confirmed, so
 *   each of several requests that arrive at once is put to the rules, and only
 *   the newest is ever shown.
 *
 * A request is shown on the dashboard only once the registry has said the
 * session is waiting, and the registry is read again right before an answer
 * is written: it must still say the session waits for permission, in the same
 * wait it was confirmed in, or in its own when that was the wait before. Nothing
 * of a request is kept but what is shown, and that only in memory, for as long
 * as it is held.
 *
 * At that same moment, the moment it would be shown, the request is put to
 * the permission rules, when there are any (`ruleAnswers.ts`). A deny or an
 * allow rule that decides it answers it at once, through `answer`, the one
 * path a press of Deny or Allow takes too, so it makes every check a press
 * makes, and the request is never shown. An ask rule, or none, leaves it held
 * for the person.
 *
 * Claude Code rewrites its registry file a second or two after it has an
 * answer, so the polls in that time still read the session as waiting, in
 * the same wait. Each request answered is remembered, by its session and the
 * status time of its wait, until a poll finds the session in any other
 * status or wait, or for `ANSWER_HOLDS_MS` at most, ten seconds, past which a
 * session still in that wait needs the person again. A request answered in
 * the wait before its own is remembered for its own too, when that began by
 * the answer, and for all of that time. Every poll is told which
 * of its sessions are still in a wait that was answered, or that a rule is
 * answering: one a rule will answer at its next check, or is answering now.
 * The poll marks them, and nothing announces or counts such a wait
 * (`answeredWaits.ts` in the core). A newer request of the session is a new
 * prompt, and the answer is forgotten. A wait in which another request of the
 * session is held for the person is never taken as answered, and nor is one
 * in which another was let go with its prompt still open, as for a newer one,
 * when the two arrived together. Had they not, the first may have been
 * answered in the session, where the file has yet to say so, and the wait is
 * taken as answered for `GRACE_MS` and no longer.
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

/** Requests that arrive closer than this are up at once: nobody has answered the first so soon. */
export const TOGETHER_MS = 300;

/** How long before its request arrives a prompt's own wait can have begun. */
export const OWN_WAIT_MS = 1_000;

/** The most requests held at once. Past it, a request is let go at once. */
export const MAX_HELD = 32;

/**
 * How long a Claude Code session waits for permission before Agent Lookout
 * takes it that its request did not reach the socket.
 */
export const MISSED_AFTER_MS = 5_000;

/** How long the moment a session's last request arrived is kept, once it is not waiting. */
const REMEMBER_REQUEST_MS = 60_000;

/** The reasons a request is let go for that leave its prompt open in the session. */
const PROMPT_LEFT_OPEN: readonly DropReason[] = ["newer", "full", "limit"];

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
  | {
      status: "waiting";
      wait: string;
      /** When the wait began, as the file gives it. Left out when it gives no time. */
      since?: number;
      /** The process that waits. Two can have one session open. */
      pid?: number;
    }
  | { status: "not-waiting" | "unknown" };

/** A held request, as much as says whose wait it is in. */
export interface HeldWait {
  arrivedAt: number;
  /** The process it was confirmed in the wait of, when the reading named one. */
  pid?: number;
  /** When that wait began, as the registry said, or null when it did not say. */
  since: number | null;
}

export interface StatusReader {
  /**
   * Reads the session's registry file again, by the id the collector lists it
   * under. Of two processes that have it open, that is the one it lists, unless
   * the request was confirmed in the other's wait and the one listed is not in
   * the request's own.
   */
  statusOf(sessionId: string, request?: HeldWait): Promise<RegistryReading>;
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

interface Held extends HeldWait {
  requestId: string;
  sessionId: string;
  shown: ShownAsk;
  until: number;
  reply: HookReply;
  /** Whether the registry has said the session is waiting since it arrived. */
  confirmed: boolean;
  /** The wait the registry said the session was in when it was confirmed. */
  wait: string | null;
  /** The answer given to the session just before, if one was, whose wait the file may still say. */
  before?: AnsweredWait;
  /** Whether an answer is being written. */
  answering: boolean;
  /** Whether that answer is a rule's. */
  byRule: boolean;
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
  /** Holds a hook's request, letting go of an older one of the same session that no rule answers. */
  receive(request: HookRequest, reply: HookReply): void;
  /** Applies the rules now: reads each held session's registry file again, and lets go of what must go. */
  check(): Promise<void>;
  /** Writes the person's answer to the request the page showed, after reading the registry once more. */
  answer(sessionId: string, requestId: string, decision: AnswerDecision): Promise<AnswerOutcome>;
  /** The snapshot with each session's held request, once confirmed, and whether answering is on. */
  withAsks(snapshot: SessionsSnapshot): SessionsSnapshot;
  /**
   * Of one poll's sessions, the ids of those still in a wait whose request
   * was answered, or that a permission rule is answering. Asked once for each
   * poll, as its snapshot is made. An answer given `ANSWER_HOLDS_MS` ago is
   * forgotten, and so is one whose wait that poll finds over, unless it was
   * given in the wait before its own, which may be yet to show.
   */
  answeredIn(snapshot: Pick<SessionsSnapshot, "sources" | "sessions">): Set<string>;
  /** Told that a request arrived on the socket, for whether the plugin is installed. */
  noteRequest(sessionId: string | null): void;
  /** Told that the socket has only now opened, so a wait from before could not have reached it. */
  listensNow(): void;
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
  let startedAt = now();
  const held = new Map<string, Held>();
  /** The requests answered whose session may still read as waiting in that wait, by session id. */
  let answers = new Map<string, AnsweredWait>();
  /** Requests a newer one of their session came after, kept for the rule that answers them. */
  const aside = new Set<Held>();
  /** Each session's newest prompt let go unanswered: its wait, null until it is known, and when. */
  const leftOpen = new Map<string, { wait: string | null; at: number; arrivedAt: number }>();
  /** When a request last arrived for each session, for whether the plugin is installed. */
  const lastRequest = new Map<string, number>();
  let seenAt: number | null = null;
  let missedAt: number | null = null;
  let stopTimer: (() => void) | null = null;
  /** The check under way, if any. */
  let inFlight: Promise<void> | null = null;

  const all = () => [...held.values(), ...aside];
  const isHeld = (entry: Held) => held.get(entry.sessionId) === entry || aside.has(entry);

  function release(entry: Held): void {
    if (held.get(entry.sessionId) === entry) held.delete(entry.sessionId);
    aside.delete(entry);
    if (held.size + aside.size === 0 && stopTimer !== null) {
      stopTimer();
      stopTimer = null;
    }
  }

  /** The earliest the wait of a request can have begun, or that of one answered just before it. */
  const earliest = ({ before, arrivedAt }: Held) => before?.from ?? arrivedAt - OWN_WAIT_MS;

  /** Whether the wait a request was confirmed in may be one before its own. */
  const early = ({ since, before, arrivedAt }: Held) =>
    since !== null && (since < arrivedAt - OWN_WAIT_MS || since <= (before?.at ?? 0));

  /** Whether the file may have yet to say a request's own wait: so soon after it arrived, or an answer before it. */
  const mayLag = ({ before, arrivedAt }: Held, at: number) =>
    at - Math.max(arrivedAt, before?.at ?? 0) < GRACE_MS;

  function drop(entry: Held, reason: DropReason): void {
    release(entry);
    if (PROMPT_LEFT_OPEN.includes(reason) && entry.reply.isOpen()) {
      const { sessionId, arrivedAt } = entry;
      leftOpen.set(sessionId, { wait: early(entry) ? null : entry.wait, at: now(), arrivedAt });
      answers.delete(entry.sessionId);
    }
    if (entry.reply.isOpen()) entry.reply.send("");
    options.onDrop?.(reason, entry.sessionId);
  }

  async function read(entry: Held): Promise<RegistryReading> {
    try {
      return await reader.statusOf(entry.sessionId, entry);
    } catch {
      return { status: "unknown" };
    }
  }

  function confirm(entry: Held, reading: RegistryReading & { status: "waiting" }): void {
    entry.confirmed = true;
    entry.wait = reading.wait;
    entry.since = reading.since ?? null;
    entry.pid = reading.pid;
    const open = leftOpen.get(entry.sessionId);
    if (open && !early(entry)) open.wait ??= reading.wait;
  }

  /**
   * Where a confirmed request is, by a new reading of its session's file: in
   * its wait, which it moves to when it was confirmed in one before; between
   * two, when it waits to be confirmed again, under another id, so a page that
   * shows it again offers it afresh; or out of it. It stays with the process it
   * was confirmed in the wait of, so another's older wait never takes it up.
   */
  function follow(entry: Held, reading: RegistryReading, at: number): "in" | "between" | "out" {
    // Confirmed in the wait of another process that has the session open.
    if (reading.status === "waiting" && reading.pid !== entry.pid) confirm(entry, reading);
    if (reading.status === "waiting" && reading.wait === entry.wait) return "in";
    if (!early(entry) || !mayLag(entry, at)) return "out";
    if (reading.status === "waiting") {
      if ((reading.since ?? 0) < earliest(entry)) return "out";
      confirm(entry, reading);
      return "in";
    }
    Object.assign(entry, {
      requestId: newId(),
      confirmed: false,
      wait: null,
      since: null,
    });
    return "between";
  }

  async function checkOne(entry: Held, at: number): Promise<void> {
    if (entry.answering) return;
    if (!entry.reply.isOpen()) return drop(entry, "closed");
    if (at >= entry.until) return drop(entry, "limit");
    const reading = await read(entry);
    // Gone, or being answered, while the file was read.
    if (!isHeld(entry) || entry.answering) return;
    if (entry.confirmed) {
      // Answered in the session, and perhaps waiting again since, for something else.
      if (follow(entry, reading, at) === "out") drop(entry, "left-waiting");
    } else if (reading.status === "waiting") {
      confirm(entry, reading);
      answerByRule(entry);
      // The rule it was kept for is gone.
      if (aside.has(entry) && !entry.answering) drop(entry, "newer");
    } else if (!mayLag(entry, at)) drop(entry, "left-waiting");
  }

  /**
   * Applies the rules once, after any check under way has finished, so two
   * checks never read the same file at once and a caller always sees a check
   * made after it asked.
   */
  async function check(): Promise<void> {
    while (inFlight !== null) await inFlight;
    const at = now();
    const run = Promise.all(all().map((entry) => checkOne(entry, at))).then(() => {});
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
    const entry = all().find((one) => one.sessionId === sessionId && one.requestId === requestId);
    // A request not yet shown cannot be answered.
    if (!entry?.confirmed) return "no-ask";
    if (decision === "allow" && !entry.shown.allow) return "not-allowable";
    if (entry.answering) return "too-soon";
    entry.answering = true;
    const reading = await read(entry);
    if (!isHeld(entry) || !entry.reply.isOpen()) {
      if (isHeld(entry)) drop(entry, "closed");
      return "gone";
    }
    const at = now();
    const where = follow(entry, reading, at);
    if (where === "between") {
      entry.answering = false;
      return "gone";
    }
    if (where === "out" || at >= entry.until) {
      drop(entry, where === "out" ? "left-waiting" : "limit");
      return "gone";
    }
    release(entry);
    entry.reply.send(decisionOutput(decision));
    // The wait is over now, though the registry may say otherwise for a moment,
    // unless another prompt of the session is still open in it.
    const open = leftOpen.get(sessionId);
    const moves = early(entry) || (open !== undefined && mayShare(entry, open.wait));
    const given: AnsweredWait = {
      source: SOURCE,
      since: entry.since,
      // In a wait before its own, it may be in another process's.
      ...(!early(entry) && entry.pid !== undefined && { pid: entry.pid }),
      at,
      ...(moves && { from: Math.max(earliest(entry), open?.arrivedAt ?? 0) }),
      ...(open && { until: at + GRACE_MS }),
    };
    // One read before an answer to a newer wait was given says nothing of that wait.
    const last = answers.get(sessionId)?.since ?? null;
    const late = last !== null && entry.since !== null && last > entry.since;
    if (!late && !othersOpen(entry)) answers.set(sessionId, given);
    // The file can move on from this wait to that of one still held.
    for (const other of all()) {
      if (other.sessionId === sessionId && !other.answering) other.before = given;
    }
    return "answered";
  }

  /** Whether a request may be in this wait, null for one not known. */
  const mayShare = (entry: Held, wait: string | null) =>
    !entry.confirmed || wait === null || entry.wait === wait;

  /** Whether a prompt of the session but this one waits for the person in the wait this one is in. */
  function othersOpen(entry: Held): boolean {
    const { sessionId, arrivedAt } = entry;
    const open = leftOpen.get(sessionId);
    if (open && mayShare(entry, open.wait) && arrivedAt - open.arrivedAt < TOGETHER_MS) return true;
    return all().some((other) => other.sessionId === sessionId && !answeringByRule(other));
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
    const verdict = verdictOf(entry);
    entry.byRule = verdict !== null;
    if (verdict === null) return;
    void answer(entry.sessionId, entry.requestId, verdict.decision).then((outcome) => {
      if (outcome === "answered") rules.answered(request, verdict);
    });
  }

  /** The rule that answers a held request, or null when none does or the rules cannot be applied. */
  function verdictOf(entry: Held): AutoAnswer | null {
    if (options.rules === undefined) return null;
    try {
      return options.rules.verdictFor({ sessionId: entry.sessionId, shown: entry.shown });
    } catch {
      // A rule that cannot be applied answers nothing: the person decides.
      return null;
    }
  }

  /**
   * Whether a rule is answering a held request: one it is answering now, or
   * one not yet confirmed that it will answer at the check that confirms it.
   */
  function answeringByRule(entry: Held): boolean {
    if (!entry.reply.isOpen()) return false;
    if (entry.confirmed) return entry.answering && entry.byRule;
    return verdictOf(entry) !== null;
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
      if (older && answeringByRule(older)) {
        held.delete(older.sessionId);
        aside.add(older);
      } else if (older) drop(older, "newer");
      const before = answers.get(request.sessionId) ?? older?.before;
      // A new prompt: whatever was answered before it is over.
      answers.delete(request.sessionId);
      const entry: Held = {
        requestId: newId(),
        sessionId: request.sessionId,
        shown: request.shown,
        arrivedAt: at,
        until: at + holdMs,
        reply,
        confirmed: false,
        wait: null,
        since: null,
        ...(before && { before }),
        answering: false,
        byRule: false,
      };
      if (all().length >= MAX_HELD) {
        drop(entry, "full");
        return;
      }
      held.set(request.sessionId, entry);
      reply.onClose(() => {
        if (isHeld(entry) && !entry.answering) drop(entry, "closed");
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
        // Its own process waits, but another is the one listed.
        if (entry.pid !== undefined && entry.pid !== session.pid) return session;
        return { ...session, ask: toAsk(entry) };
      });
      return { ...snapshot, sessions, answering };
    },

    answeredIn(snapshot) {
      const { ids, kept } = answeredNow(answers, snapshot, now());
      answers = kept;
      for (const [id, { at }] of leftOpen) {
        const session = snapshot.sessions.find((listed) => listed.id === id);
        const over = !session || !inAnsweredWait(session, { since: null });
        if (over && now() - at >= GRACE_MS) leftOpen.delete(id);
      }
      for (const entry of all()) {
        if (!answeringByRule(entry) || othersOpen(entry)) continue;
        const session = snapshot.sessions.find((listed) => listed.id === entry.sessionId);
        // Before it is confirmed, the wait's time is not known yet.
        const since = entry.confirmed ? entry.since : null;
        if (session && inAnsweredWait(session, { since })) ids.add(entry.sessionId);
      }
      return ids;
    },

    noteRequest(sessionId) {
      const at = now();
      seenAt = at;
      if (sessionId !== null) lastRequest.set(sessionId, at);
    },

    listensNow() {
      startedAt = now();
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
      for (const entry of all()) drop(entry, "stopped");
    },

    get size() {
      return all().length;
    },
  };
}
