import { expect, test } from "vitest";

import { boardOf } from "@dashboard/lib/sessions/board";
import { makeSession } from "@tests/fixtures/session";

const T = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function session(name: string, overrides: Parameters<typeof makeSession>[0] = {}) {
  return makeSession({ id: `claude-code:${name}`, name, ...overrides });
}

const names = (sessions: readonly { name: string }[]) => sessions.map((s) => s.name);

test("there are always four columns, in the order Needs you, Working, Idle, Finished or failed", () => {
  for (const sessions of [[], [session("docs-site", { status: "idle" })]]) {
    const { columns } = boardOf(sessions);
    expect(columns.map((column) => column.id)).toEqual(["needs-you", "working", "idle", "ended"]);
    expect(columns.map((column) => column.label)).toEqual([
      "Needs you",
      "Working",
      "Idle",
      "Finished or failed",
    ]);
  }
});

test("an empty column holds nothing, counts zero and has its own quiet line", () => {
  const { columns, unknown } = boardOf([]);

  expect(columns.map((column) => [column.sessions, column.count, column.stale])).toEqual([
    [[], 0, 0],
    [[], 0, 0],
    [[], 0, 0],
    [[], 0, 0],
  ]);
  expect(columns.map((column) => column.empty)).toEqual([
    "Nothing waiting",
    "Nothing working",
    "Nothing idle",
    "Nothing finished or failed",
  ]);
  expect(unknown).toEqual([]);
});

test("Needs you has the longest wait first, as the hero does", () => {
  const [needsYou] = boardOf([
    session("api-rate-limits", { status: "needs-you", statusSince: T - MINUTE }),
    session("checkout-flow", { status: "needs-you", statusSince: T - 30 * MINUTE }),
    session("docs-site", { status: "needs-you", statusSince: null }),
    session("search-indexing", { status: "needs-you", statusSince: T - 5 * MINUTE }),
  ]).columns;

  expect(names(needsYou!.sessions)).toEqual([
    "checkout-flow",
    "search-indexing",
    "api-rate-limits",
    "docs-site",
  ]);
  expect(needsYou!.count).toBe(4);
});

test("every other column has the most recent change first, as the list does", () => {
  const { columns } = boardOf([
    session("billing-webhooks", { status: "working", statusSince: T - 40 * MINUTE }),
    session("search-indexing", { status: "working", statusSince: T - MINUTE }),
    session("docs-site", { status: "idle", statusSince: T - 2 * MINUTE }),
    session("email-templates", { status: "idle", statusSince: T - 9 * MINUTE }),
  ]);

  expect(names(columns[1]!.sessions)).toEqual(["search-indexing", "billing-webhooks"]);
  expect(names(columns[2]!.sessions)).toEqual(["docs-site", "email-templates"]);
});

test("stale sessions sit in Idle, below the idle ones, and are counted apart", () => {
  const idle = boardOf([
    session("mobile-onboarding", { status: "idle", stale: true, statusSince: T - 3 * DAY }),
    session("docs-site", { status: "idle", statusSince: T - 26 * MINUTE }),
  ]).columns[2]!;

  expect(names(idle.sessions)).toEqual(["docs-site", "mobile-onboarding"]);
  expect(idle.count).toBe(1);
  expect(idle.stale).toBe(1);
  // Only stale ones: the column is still Idle, and counts none that are not stale.
  const staleOnly = boardOf([session("mobile-onboarding", { status: "idle", stale: true })])
    .columns[2]!;
  expect([staleOnly.label, staleOnly.count, staleOnly.stale]).toEqual(["Idle", 0, 1]);
});

test("finished and failed share one column, a failure first, as the list orders them", () => {
  const ended = boardOf([
    session("infra-terraform", { status: "finished", statusSince: T - MINUTE }),
    session("email-templates", { status: "failed", statusSince: T - 41 * MINUTE }),
  ]).columns[3]!;

  expect(names(ended.sessions)).toEqual(["email-templates", "infra-terraform"]);
  expect([ended.label, ended.count]).toEqual(["Finished or failed", 2]);
});

test("a session whose status is not known has no column, and is handed back rather than dropped", () => {
  const board = boardOf([
    session("docs-site", { status: "unknown" }),
    session("checkout-flow", { status: "working" }),
  ]);

  expect(names(board.unknown)).toEqual(["docs-site"]);
  expect(board.columns.flatMap((column) => names(column.sessions))).toEqual(["checkout-flow"]);
});

test("every session is in one column or among the unknown, and the counts add up to all of them", () => {
  const sessions = [
    session("checkout-flow", { status: "needs-you" }),
    session("billing-webhooks", { status: "working" }),
    session("docs-site", { status: "idle" }),
    session("mobile-onboarding", { status: "idle", stale: true }),
    session("infra-terraform", { status: "finished" }),
    session("email-templates", { status: "failed" }),
    session("search-indexing", { status: "unknown" }),
  ];
  const { columns, unknown } = boardOf(sessions);

  const placed = columns.flatMap((column) => column.sessions).length + unknown.length;
  expect(placed).toBe(sessions.length);
  const counted =
    columns.reduce((sum, column) => sum + column.count + column.stale, 0) + unknown.length;
  expect(counted).toBe(sessions.length);
});
