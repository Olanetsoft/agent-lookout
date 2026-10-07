import {
  PERMISSION_RULES_PATH,
  SETTINGS_PATH,
  TIME_RULES_PATH,
  type AnswerRefusal,
  type AnswerResponse,
  type CleanUpOutcome,
  type CleanUpResponse,
  type ClearHistoryResponse,
  type EmailStatusResponse,
  type ErrorResponse,
  type EventsResponse,
  type HealthResponse,
  type JumpRefusal,
  type JumpResponse,
  type NtfyStatusResponse,
  type PermissionRulesFailure,
  type PermissionRulesRefusal,
  type PermissionRulesResponse,
  type PullRequestsStatusResponse,
  type PushoverStatusResponse,
  type SettingsResponse,
  type StopRefusal,
  type StopResponse,
  type TimeRulesRefusal,
  type TimeRulesResponse,
  type WaitsResponse,
  type WebhookStatusResponse,
} from "@core/api";
import { applyRulesChange, rulesChangeIn } from "@core/permission-rules/rulesChange";
import type { Session } from "@core/sessions/session";
import { timeRulesIn } from "@core/time-rules/timeRules";
import type { ApiHost } from "@dashboard/lib/api/apiHost";
import { RESUMED_AT } from "@site-tour/feed/hour";
import type { TourStore } from "@site-tour/host/tourStore";

/**
 * The transport the landing page's dashboard is given with `setApiHost`.
 *
 * Every route the dashboard asks for is answered here, inside the page, from
 * the tour's store. Nothing is sent anywhere: there is no `fetch` in it. The
 * routes that act in the app only say what they would have come to. A Jump
 * says where it went, a Stop or an end of the sessions left running takes them
 * out of the store's list, Allow or Deny answers the wait in the store, a
 * change of the time rules puts them in force there, a change of the
 * permission rules is kept there, and clearing the history empties the
 * store's copy, each until the tour moves on.
 */

/** Where the settings file is, as the collector says it. */
const SETTINGS_FILE = "~/.agent-lookout/settings.json";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const notFound = (): Response => answer(404, { error: "Not found" } satisfies ErrorResponse);

/** What each refusal of a change to the permission rules is answered with, as the collector answers it. */
const RULES_STATUS: Record<Exclude<PermissionRulesFailure, "not-saved">, number> = {
  invalid: 400,
  "no-rule": 404,
  full: 409,
  duplicate: 409,
};

/** A new permission rule's id, as Agent Lookout names one: twelve hexadecimal digits. */
function newRuleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A change to the permission rules that was not made, and why. */
function rulesRefused(
  reason: Exclude<PermissionRulesFailure, "not-saved">,
  error: string,
): Response {
  return answer(RULES_STATUS[reason], { error, reason } satisfies PermissionRulesRefusal);
}

/** The body the dashboard wrote, read as JSON, or null. */
function bodyOf(body: RequestInit["body"]): Record<string, unknown> | null {
  if (typeof body !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The session a jump or a stop asks for, from a body the dashboard wrote. */
function sessionAsked(body: RequestInit["body"]): string | null {
  const id = bodyOf(body)?.sessionId;
  return typeof id === "string" ? id : null;
}

/** The sessions a clean-up asks to end, with the moment each one's idle began as the page showed it. */
function sessionsAsked(body: RequestInit["body"]): { sessionId: string; statusSince: number }[] {
  const asked = bodyOf(body)?.sessions;
  if (!Array.isArray(asked)) return [];
  return asked.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { sessionId, statusSince } = entry as Record<string, unknown>;
    return typeof sessionId === "string" && typeof statusSince === "number"
      ? [{ sessionId, statusSince }]
      : [];
  });
}

/** What became of one session a clean-up asked for, as the collector would say it. */
function cleanUpOutcome(session: Session | undefined, statusSince: number): CleanUpOutcome {
  if (!session) return "gone";
  if (!session.stop) return "unsupported";
  if (session.statusSince !== statusSince) return "became-active";
  if (!session.stale) return "not-stale";
  return "ended";
}

export function createTourApi(store: TourStore, now: () => number): ApiHost {
  function route(path: string, init?: RequestInit): Response {
    const url = new URL(path, "http://tour.invalid");
    const method = (init?.method ?? "GET").toUpperCase();
    const at = now();
    const shown = store.shown();

    if (method === "POST") {
      if (url.pathname === "/api/jump") {
        const id = sessionAsked(init?.body);
        const session = store.getState().snapshot?.sessions.find((s) => s.id === id);
        if (!session?.jump) {
          return answer(404, {
            error: "No pane or tab is known for that session.",
            reason: "no-pane",
          } satisfies JumpRefusal);
        }
        return answer(200, { ...session.jump, ok: true } satisfies JumpResponse);
      }
      if (url.pathname === "/api/sessions/stop") {
        const id = sessionAsked(init?.body);
        const session = store.getState().snapshot?.sessions.find((s) => s.id === id);
        if (!session) {
          return answer(404, {
            error: "That session is not running.",
            reason: "gone",
          } satisfies StopRefusal);
        }
        if (!session.stop) {
          return answer(409, {
            error: "Agent Lookout does not stop this session.",
            reason: "unsupported",
          } satisfies StopRefusal);
        }
        store.stop([session], at);
        return answer(200, { ok: true } satisfies StopResponse);
      }
      if (url.pathname === "/api/sessions/clean-up") {
        const sessions = store.getState().snapshot?.sessions ?? [];
        const results = sessionsAsked(init?.body).map(({ sessionId, statusSince }) => ({
          sessionId,
          outcome: cleanUpOutcome(
            sessions.find((s) => s.id === sessionId),
            statusSince,
          ),
        }));
        const ended = results.filter((result) => result.outcome === "ended");
        store.stop(
          sessions.filter((s) => ended.some((result) => result.sessionId === s.id)),
          at,
        );
        return answer(200, { results } satisfies CleanUpResponse);
      }
      if (url.pathname === "/api/history/clear") {
        store.clear(at);
        return answer(200, { ok: true, clearedAt: at } satisfies ClearHistoryResponse);
      }
      if (url.pathname === "/api/permission/answer") {
        const body = bodyOf(init?.body);
        const session = store
          .getState()
          .snapshot?.sessions.find((s) => s.id === body?.sessionId && s.ask !== undefined);
        const decision = body?.decision;
        if (
          !session?.ask ||
          session.ask.requestId !== body?.requestId ||
          (decision !== "allow" && decision !== "deny")
        ) {
          return answer(404, {
            error: "No permission request of that session is held.",
            reason: "no-ask",
          } satisfies AnswerRefusal);
        }
        if (decision === "allow" && !session.ask.allow) {
          return answer(409, {
            error: "Only Deny is offered for this request.",
            reason: "not-allowable",
          } satisfies AnswerRefusal);
        }
        if (!store.answer(decision, at)) {
          return answer(409, {
            error: "The session is no longer waiting.",
            reason: "gone",
          } satisfies AnswerRefusal);
        }
        return answer(200, { ok: true, decision } satisfies AnswerResponse);
      }
      if (url.pathname === TIME_RULES_PATH) {
        const asked = timeRulesIn(bodyOf(init?.body));
        if (!asked.ok) {
          return answer(400, {
            error: asked.problem,
            reason: "invalid",
          } satisfies TimeRulesRefusal);
        }
        store.setTimeRules(asked.rules);
        return answer(200, { ok: true, timeRules: asked.rules } satisfies TimeRulesResponse);
      }
      if (url.pathname === PERMISSION_RULES_PATH) {
        const asked = rulesChangeIn(bodyOf(init?.body));
        if (!asked.ok) return rulesRefused("invalid", asked.problem);
        const made = applyRulesChange(store.permissionRules(), asked.change, newRuleId);
        if (!made.ok) return rulesRefused(made.reason, made.problem);
        store.setPermissionRules(made.rules);
        return answer(200, {
          ok: true,
          permissionRules: made.rules,
        } satisfies PermissionRulesResponse);
      }
      return notFound();
    }

    switch (url.pathname) {
      case "/api/health":
        return answer(200, { ok: true, version: __APP_VERSION__ } satisfies HealthResponse);
      case "/api/sessions":
        return answer(200, store.feed.snapshot(shown, at));
      case "/api/events": {
        const since = Number(url.searchParams.get("since")) || 0;
        const events = store.feed
          .events(shown, store.clearedAt())
          .filter((event) => event.at > since);
        return answer(200, { events } satisfies EventsResponse);
      }
      case "/api/history": {
        const asked = Number(url.searchParams.get("windowMs"));
        const windowMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, SIX_HOURS_MS) : 0;
        return answer(200, store.feed.history(shown, at, windowMs, store.clearedAt()));
      }
      case "/api/waits":
        return answer(200, store.feed.waits(shown, at, store.clearedAt()) satisfies WaitsResponse);
      case SETTINGS_PATH:
        return answer(200, {
          timeRules: store.timeRules(),
          file: SETTINGS_FILE,
          problem: null,
          permissionRules: store.permissionRules(),
          permissionRulesProblem: null,
          // No rule answered a request in the hour. The list begins when Agent Lookout last started.
          ruleAnswers: [],
          ruleAnswersSince: store.feed.t0 + RESUMED_AT,
        } satisfies SettingsResponse);
      case "/api/pull-requests": {
        const on = shown.pullRequests !== false;
        return answer(200, {
          on,
          problem: null,
          gh: on ? "ready" : null,
          last: on ? { at: at - 40_000, ok: true } : null,
        } satisfies PullRequestsStatusResponse);
      }
      case "/api/email":
        return answer(200, {
          on: false,
          to: null,
          events: null,
          afterMs: null,
          asking: null,
          problem: null,
          last: null,
          limitedUntil: null,
        } satisfies EmailStatusResponse);
      case "/api/webhook":
        return answer(200, {
          on: false,
          host: null,
          events: null,
          afterMs: null,
          asking: null,
          problem: null,
          last: null,
          limitedUntil: null,
        } satisfies WebhookStatusResponse);
      case "/api/ntfy":
        return answer(200, {
          on: false,
          host: null,
          tokenSet: null,
          events: null,
          afterMs: null,
          asking: null,
          problem: null,
          last: null,
          limitedUntil: null,
        } satisfies NtfyStatusResponse);
      case "/api/pushover":
        return answer(200, {
          on: false,
          events: null,
          afterMs: null,
          asking: null,
          problem: null,
          last: null,
          limitedUntil: null,
        } satisfies PushoverStatusResponse);
      default:
        return notFound();
    }
  }

  return (path, init) => {
    try {
      return Promise.resolve(route(path, init));
    } catch {
      return Promise.resolve(answer(500, { error: "Something went wrong." }));
    }
  };
}
