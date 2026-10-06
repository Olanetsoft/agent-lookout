import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ACTION_HEADER, PERMISSION_RULES_PATH, SETTINGS_PATH, TIME_RULES_PATH } from "@core/api";
import { DEFAULT_TIME_RULES } from "@core/time-rules/timeRules";
import {
  readEmailStatus,
  readHistory,
  readPullRequestsStatus,
  readSettings,
  readSnapshot,
  readWaits,
  readWebhookStatus,
} from "@dashboard/lib/api/readApi";
import { requestAnswer } from "@dashboard/lib/answer/answerRequest";
import { setApiHost } from "@dashboard/lib/api/apiHost";
import { fetchSettings, requestTimeRules } from "@dashboard/lib/time-rules/timeRulesApi";
import { requestRulesChange } from "@dashboard/lib/permission-rules/permissionRulesApi";
import { createFeed } from "@site-tour/feed/derive";
import { RESUMED_AT, WAITING_SESSION } from "@site-tour/feed/hour";
import { createTourApi } from "@site-tour/host/tourApi";
import { createTourStore, type TourStore } from "@site-tour/host/tourStore";

const T0 = Date.UTC(2026, 9, 5, 8, 12, 0);
let now = T0;
let store: TourStore;
let api: ReturnType<typeof createTourApi>;
const fetched = vi.fn();

beforeEach(() => {
  now = T0 + 5_000;
  store = createTourStore({ feed: createFeed(T0), now: () => now });
  api = createTourApi(store, () => now);
  fetched.mockReset();
  vi.stubGlobal("fetch", fetched);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = async (path: string, init?: RequestInit) => {
  const response = await api(path, init);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const jump = (sessionId: string) =>
  json("/api/jump", {
    method: "POST",
    headers: { [ACTION_HEADER]: "jump" },
    body: JSON.stringify({ sessionId }),
  });

test("every route the dashboard reads is answered, in a shape it reads", async () => {
  expect(await json("/api/health")).toMatchObject({ status: 200, body: { ok: true } });
  expect(readSnapshot((await json("/api/sessions")).body)).not.toBeNull();
  expect((await json(`/api/events?since=0`)).body.events).toEqual(store.getState().events);
  expect(readHistory((await json("/api/history?windowMs=21600000")).body)).not.toBeNull();
  expect(readEmailStatus((await json("/api/email")).body)).toMatchObject({ on: false });
  expect(readWebhookStatus((await json("/api/webhook")).body)).toMatchObject({ on: false });
  expect(readWaits((await json("/api/waits")).body)).not.toBeNull();
  expect(readPullRequestsStatus((await json("/api/pull-requests")).body)).toMatchObject({
    on: true,
    gh: "ready",
  });
  expect(readSettings((await json(SETTINGS_PATH)).body)).toEqual({
    timeRules: DEFAULT_TIME_RULES,
    file: "~/.agent-lookout/settings.json",
    problem: null,
    permissionRules: [],
    permissionRulesProblem: null,
    ruleAnswers: [],
    ruleAnswersSince: T0 + RESUMED_AT,
  });
});

/** The request held for the waiting session, as the dashboard last read it. */
const heldAsk = () =>
  store.getState().snapshot!.sessions.find((session) => session.id === WAITING_SESSION)!.ask!;

test("Allow answers the wait from the dashboard: it goes back to work, and the log says so", async () => {
  store.show("waiting");
  setApiHost(api);
  now += 30_000;
  expect(await requestAnswer(WAITING_SESSION, heldAsk().requestId, "allow")).toBe("allowed");
  const session = store.getState().snapshot!.sessions.find((one) => one.id === WAITING_SESSION)!;
  expect(session).toMatchObject({ status: "working", statusSince: now });
  expect(session.ask).toBeUndefined();
  expect(store.getState().events[1]).toMatchObject({
    kind: "answered",
    decision: "allow",
    at: now,
  });
  // Answered, it cannot be answered again.
  expect(await requestAnswer(WAITING_SESSION, "a7c41e095b2d4f869e1360d8b2c4f7a5", "deny")).toBe(
    "no-ask",
  );
  // The tour moving on, and back to the wait, forgets the answer.
  store.show("waiting");
  expect(heldAsk()).toBeDefined();
  expect(fetched).not.toHaveBeenCalled();
});

test("Deny answers the wait too, and a request the page did not show is not answered", async () => {
  store.show("waiting");
  setApiHost(api);
  expect(await requestAnswer(WAITING_SESSION, "0".repeat(32), "deny")).toBe("no-ask");
  expect(await requestAnswer(WAITING_SESSION, heldAsk().requestId, "deny")).toBe("denied");
  expect(store.getState().events[1]).toMatchObject({ kind: "answered", decision: "deny" });
});

test("the time rules the visitor sets are put in force, until the tour moves on", async () => {
  setApiHost(api);
  const rules = { ...DEFAULT_TIME_RULES, longWait: { on: true, minutes: 15 } };
  expect(await requestTimeRules(rules)).toEqual({ ok: true, rules });
  expect((await fetchSettings())?.timeRules).toEqual(rules);
  expect(store.getState().snapshot!.timeRules).toEqual(rules);
  const wrong = await json(TIME_RULES_PATH, { method: "POST", body: JSON.stringify({ idle: 3 }) });
  expect(wrong).toMatchObject({ status: 400, body: { reason: "invalid" } });
  store.show("waiting");
  expect(store.getState().snapshot!.timeRules).toEqual(DEFAULT_TIME_RULES);
});

test("the permission rules the visitor sets are kept, until the tour moves on", async () => {
  setApiHost(api);
  const added = await requestRulesChange({ add: { decision: "deny", tool: "WebFetch" } });
  expect(added).toMatchObject({ ok: true, rules: [{ decision: "deny", tool: "WebFetch" }] });
  const [rule] = added.ok ? added.rules : [];
  expect(rule.id).toMatch(/^[0-9a-f]{12}$/);
  await requestRulesChange({ add: { decision: "allow", tool: "Bash", command: "git status" } });
  const moved = await requestRulesChange({ move: { id: rule.id, to: "down" } });
  expect(moved.ok && moved.rules.map((one) => one.tool)).toEqual(["Bash", "WebFetch"]);
  expect((await fetchSettings())?.permissionRules).toEqual(moved.ok ? moved.rules : null);
  // Refused as the collector refuses it.
  expect(await requestRulesChange({ add: { decision: "deny", tool: "WebFetch" } })).toMatchObject({
    ok: false,
    reason: "duplicate",
  });
  expect(await requestRulesChange({ remove: { id: "0".repeat(12) } })).toMatchObject({
    ok: false,
    reason: "no-rule",
  });
  const wrong = await json(PERMISSION_RULES_PATH, {
    method: "POST",
    body: JSON.stringify({ add: { decision: "allow" } }),
  });
  expect(wrong).toMatchObject({ status: 400, body: { reason: "invalid" } });
  expect(await requestRulesChange({ remove: { id: rule.id } })).toMatchObject({ ok: true });
  expect((await fetchSettings())?.permissionRules).toHaveLength(1);
  // The tour moving on forgets them.
  store.show("waiting");
  expect((await fetchSettings())?.permissionRules).toEqual([]);
  expect(fetched).not.toHaveBeenCalled();
});

test("pull requests are off while the scene has them off, and the branch has none then", async () => {
  store.setPullRequests(false);
  expect(readPullRequestsStatus((await json("/api/pull-requests")).body)).toMatchObject({
    on: false,
    gh: null,
  });
  const sessions = readSnapshot((await json("/api/sessions")).body)!.sessions;
  expect(sessions.some((one) => one.git?.pullRequest)).toBe(false);
});

const stop = (sessionId: string) =>
  json("/api/sessions/stop", {
    method: "POST",
    headers: { [ACTION_HEADER]: "stop" },
    body: JSON.stringify({ sessionId }),
  });

test("Stop takes the session out of the list until the tour moves on, and nothing is run", async () => {
  store.show("waiting");
  const checkout = store.getState().snapshot!.sessions.find((s) => s.name === "checkout-flow")!;
  expect(await stop(checkout.id)).toEqual({ status: 200, body: { ok: true } });
  expect(store.getState().snapshot!.sessions.some((s) => s.id === checkout.id)).toBe(false);
  expect(store.getState().events[1]).toMatchObject({ kind: "stopped", sessionId: checkout.id });
  expect((await stop(checkout.id)).body).toMatchObject({ reason: "gone" });
  store.show("answered");
  expect(store.getState().snapshot!.sessions.some((s) => s.id === checkout.id)).toBe(true);
});

test("Stop is refused for a session Agent Lookout does not stop", async () => {
  const codex = store.getState().snapshot!.sessions.find((s) => s.source === "codex")!;
  expect(await stop(codex.id)).toMatchObject({ status: 409, body: { reason: "unsupported" } });
  const desktop = store.getState().snapshot!.sessions.find((s) => s.surface === "desktop")!;
  expect((await stop(desktop.id)).body).toMatchObject({ reason: "unsupported" });
});

test("ending the sessions left running ends the stale one asked for, and says why the others were left", async () => {
  const sessions = store.getState().snapshot!.sessions;
  const stale = sessions.find((s) => s.stale)!;
  const working = sessions.find((s) => s.stop && !s.stale)!;
  const { status, body } = await json("/api/sessions/clean-up", {
    method: "POST",
    headers: { [ACTION_HEADER]: "clean-up" },
    body: JSON.stringify({
      sessions: [
        { sessionId: stale.id, statusSince: stale.statusSince },
        { sessionId: working.id, statusSince: working.statusSince },
      ],
    }),
  });
  expect(status).toBe(200);
  expect(body.results).toEqual([
    { sessionId: stale.id, outcome: "ended" },
    { sessionId: working.id, outcome: "not-stale" },
  ]);
  expect(store.getState().snapshot!.sessions.some((s) => s.id === stale.id)).toBe(false);
});

test("events since a moment are only the later ones", async () => {
  const all = store.getState().events;
  const { body } = await json(`/api/events?since=${all[1].at}`);
  expect(body.events).toEqual(all.filter((event) => event.at > all[1].at));
});

test("a Jump to a session with a place says where it went, and nothing is run", async () => {
  store.show("waiting");
  const checkout = store.getState().snapshot!.sessions.find((s) => s.name === "checkout-flow")!;
  expect(await jump(checkout.id)).toEqual({
    status: 200,
    body: { kind: "terminal", app: "Terminal", place: "Terminal", ok: true },
  });
  const docs = store.getState().snapshot!.sessions.find((s) => s.name === "docs-site")!;
  expect((await jump(docs.id)).body).toMatchObject({ ok: true, kind: "tmux" });
});

test("a Jump to a session with no place is refused as the collector refuses it", async () => {
  const codex = store.getState().snapshot!.sessions.find((s) => s.source === "codex")!;
  expect(await jump(codex.id)).toMatchObject({ status: 404, body: { reason: "no-pane" } });
  expect(await jump("claude-code:nobody")).toMatchObject({ status: 404 });
  expect((await json("/api/jump", { method: "POST", body: "not json" })).status).toBe(404);
});

test("clearing the history empties the store's copy, until the tour moves on", async () => {
  const { status, body } = await json("/api/history/clear", { method: "POST", body: "{}" });
  expect(status).toBe(200);
  expect(body).toEqual({ ok: true, clearedAt: now });
  expect(store.getState().events).toEqual([]);
  expect(store.getState().history?.since).toEqual({ at: now, by: "cleared" });
  store.show("answered");
  expect(store.getState().events.length).toBeGreaterThan(0);
});

test("anything else is not found, and the Mac app's own route is not here", async () => {
  expect((await json("/api/app/update")).status).toBe(404);
  expect((await json("/api/elsewhere")).status).toBe(404);
  expect((await json("/api/sessions", { method: "POST" })).status).toBe(404);
});

test("nothing is fetched: every answer is made in the page", async () => {
  await json("/api/sessions");
  await json("/api/history?windowMs=900000");
  await jump("claude-code:nobody");
  expect(fetched).not.toHaveBeenCalled();
});
