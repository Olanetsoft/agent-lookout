import { expect, test } from "vitest";

import type { Session } from "@core/sessions/session";
import { searchSessions, searchWords } from "@dashboard/lib/sessions/search";
import { tableGroups, waitingSessions } from "@dashboard/lib/sessions/sessions";
import { makeSession } from "@tests/fixtures/session";

const T = 1_700_000_000_000;
const MINUTE = 60_000;

function session(name: string, overrides: Partial<Session> = {}): Session {
  return makeSession({ id: `claude-code:${name}`, name, ...overrides });
}

/** Each session's agent, as the page names it: a status file's own, or the tool's. */
const agentOf = (s: Session) => s.agent ?? (s.source === "codex" ? "Codex" : "Claude Code");

const names = (sessions: readonly Session[]) => sessions.map((s) => s.name);
const find = (sessions: readonly Session[], query: string) =>
  names(searchSessions(sessions, query, agentOf));

/** A mixed page: two waits, work, rest, endings and an unknown, given out of order. */
const PAGE: Session[] = [
  session("docs-site", { status: "idle", statusSince: T - 60 * MINUTE }),
  session("billing-webhooks", { status: "working", statusSince: T - 12 * MINUTE }),
  session("search-indexing", {
    status: "needs-you",
    waitingReason: "question",
    statusSince: T - MINUTE,
  }),
  session("mobile-onboarding", { status: "finished", statusSince: T - 120 * MINUTE }),
  session("infra-terraform", { status: "failed", statusSince: T - 90 * MINUTE }),
  session("api-rate-limits", { status: "working", statusSince: T - 3 * MINUTE }),
  session("email-templates", { status: "unknown", statusSince: null }),
  session("checkout-flow", {
    status: "needs-you",
    waitingReason: "permission",
    statusSince: T - 4 * MINUTE,
  }),
];

test("an empty search finds every session: those that need you first, longest wait first, then the Sessions list's order", () => {
  const found = searchSessions(PAGE, "", agentOf);

  expect(names(found)).toEqual([
    "checkout-flow",
    "search-indexing",
    "api-rate-limits",
    "billing-webhooks",
    "docs-site",
    "infra-terraform",
    "mobile-onboarding",
    "email-templates",
  ]);
  // The same order as the Needs you panel, then the Sessions table.
  expect(found).toEqual([
    ...waitingSessions(PAGE),
    ...tableGroups(PAGE).flatMap((group) => group.sessions),
  ]);
  // Spaces alone are no search either.
  expect(find(PAGE, "   \t ")).toEqual(names(found));
});

test("a session that needs you comes first whatever else the search finds", () => {
  const sessions = [
    session("api-gateway", { status: "working", statusSince: T - MINUTE }),
    session("api-rate-limits", { status: "idle", statusSince: T - MINUTE }),
    session("api-docs", {
      status: "needs-you",
      waitingReason: "permission",
      statusSince: T - 2 * MINUTE,
    }),
    session("api-search", {
      status: "needs-you",
      waitingReason: "question",
      statusSince: T - 9 * MINUTE,
    }),
  ];

  expect(find(sessions, "api")).toEqual([
    "api-search",
    "api-docs",
    "api-gateway",
    "api-rate-limits",
  ]);
});

test("it finds a session by its name, its folder's name, its branch, the commit in the branch's place, or its agent", () => {
  const sessions = [
    session("checkout-flow", {
      status: "working",
      cwd: "/Users/example/code/storefront",
      project: "storefront",
      git: { branch: "feature/payments-v2" },
    }),
    session("docs-site", {
      status: "idle",
      cwd: "/Users/example/code/handbook",
      project: "handbook",
      git: { commit: "3f9a2c1" },
    }),
    session("search-indexing", { status: "idle", source: "codex", project: null, cwd: null }),
    session("email-templates", { status: "idle", source: "status-files", agent: "Night Shift" }),
  ];

  expect(find(sessions, "checkout")).toEqual(["checkout-flow"]);
  expect(find(sessions, "storefront")).toEqual(["checkout-flow"]);
  expect(find(sessions, "payments-v2")).toEqual(["checkout-flow"]);
  expect(find(sessions, "feature/")).toEqual(["checkout-flow"]);
  expect(find(sessions, "3f9a")).toEqual(["docs-site"]);
  expect(find(sessions, "handbook")).toEqual(["docs-site"]);
  expect(find(sessions, "codex")).toEqual(["search-indexing"]);
  expect(find(sessions, "night shift")).toEqual(["email-templates"]);
  expect(find(sessions, "claude")).toEqual(["checkout-flow", "docs-site"]);
});

test("it does not look in what the page does not show as one of those: the whole path, the status or the app", () => {
  const sessions = [
    session("checkout-flow", {
      status: "working",
      surface: "vscode",
      cwd: "/Users/example/code/storefront",
      project: "storefront",
    }),
  ];

  expect(find(sessions, "example")).toEqual([]);
  expect(find(sessions, "users")).toEqual([]);
  expect(find(sessions, "working")).toEqual([]);
  expect(find(sessions, "vs")).toEqual([]);
});

test("every word must appear, in any order, each anywhere in the four", () => {
  const sessions = [
    session("checkout-flow", { status: "working", project: "storefront", git: { branch: "main" } }),
    session("checkout-tests", { status: "working", project: "storefront", git: { branch: "ci" } }),
    session("billing-webhooks", { status: "idle", project: "payments", git: { branch: "main" } }),
  ];

  expect(find(sessions, "checkout main")).toEqual(["checkout-flow"]);
  expect(find(sessions, "main checkout")).toEqual(["checkout-flow"]);
  expect(find(sessions, "store  main")).toEqual(["checkout-flow"]);
  expect(find(sessions, "main")).toEqual(["checkout-flow", "billing-webhooks"]);
  expect(find(sessions, "checkout payments")).toEqual([]);
  // The same word twice asks no more than once.
  expect(find(sessions, "flow flow")).toEqual(["checkout-flow"]);
});

test("a word is never found across two of them", () => {
  const sessions = [session("check", { status: "idle", project: "out", git: { branch: "flow" } })];

  expect(find(sessions, "checkout")).toEqual([]);
  expect(find(sessions, "check out flow")).toEqual(["check"]);
});

test("case and accents are set aside, in the search and in what it looks in", () => {
  const sessions = [
    session("Café-Menu", { status: "idle", project: "Résumé" }),
    session("docs-site", { status: "idle", project: "docs" }),
  ];

  expect(find(sessions, "cafe")).toEqual(["Café-Menu"]);
  expect(find(sessions, "CAFÉ")).toEqual(["Café-Menu"]);
  expect(find(sessions, "resume")).toEqual(["Café-Menu"]);
  expect(find(sessions, "DOCS-SITE")).toEqual(["docs-site"]);
});

test("odd characters are matched as themselves, never as a pattern", () => {
  const sessions = [
    session("fix (urgent) [v2]", { status: "idle" }),
    session("a.b*c", { status: "idle" }),
    session("back\\slash $HOME", { status: "idle" }),
    session('quote "it\'s" 🚀 done', { status: "idle" }),
    session("plain", { status: "idle" }),
  ];

  expect(find(sessions, "(urgent)")).toEqual(["fix (urgent) [v2]"]);
  expect(find(sessions, "[v2]")).toEqual(["fix (urgent) [v2]"]);
  expect(find(sessions, "a.b*c")).toEqual(["a.b*c"]);
  expect(find(sessions, ".*")).toEqual([]);
  expect(find(sessions, "back\\slash")).toEqual(["back\\slash $HOME"]);
  expect(find(sessions, "$home")).toEqual(["back\\slash $HOME"]);
  expect(find(sessions, '"it\'s"')).toEqual(['quote "it\'s" 🚀 done']);
  expect(find(sessions, "🚀")).toEqual(['quote "it\'s" 🚀 done']);
  expect(find(sessions, "^plain$")).toEqual([]);
});

test("the words of a search are folded and split on any run of spaces", () => {
  expect(searchWords("  Checkout\tFLOW\n main ")).toEqual(["checkout", "flow", "main"]);
  expect(searchWords("Crème brûlée")).toEqual(["creme", "brulee"]);
  expect(searchWords("")).toEqual([]);
  expect(searchWords("   ")).toEqual([]);
});

test("nothing is found among no sessions, and the sessions given are not changed", () => {
  expect(find([], "")).toEqual([]);
  expect(find([], "checkout")).toEqual([]);
  const before = names(PAGE);
  searchSessions(PAGE, "a", agentOf);
  expect(names(PAGE)).toEqual(before);
});
