import { expect, test } from "vitest";

import type { GitRepository, Session } from "@core/sessions/session";
import {
  NO_REPOSITORY,
  repositoryBeside,
  repositoryGroups,
} from "@dashboard/lib/sessions/repositories";
import { tableGroups } from "@dashboard/lib/sessions/sessions";
import { makeSession } from "@tests/fixtures/session";

const T = 1_700_000_000_000;
const MINUTE = 60_000;

const STOREFRONT: GitRepository = { id: "9aaa5f0ab35a5f84", name: "storefront" };
const PLATFORM_API: GitRepository = { id: "1c2d3e4f5a6b7c8d", name: "platform-api" };
const DOCS: GitRepository = { id: "7ba69a8b81747824", name: "docs" };

function session(
  name: string,
  project: string | null,
  repository: GitRepository | null,
  overrides: Partial<Session> = {},
): Session {
  return makeSession({
    id: `claude-code:${name}`,
    name,
    project,
    cwd: project === null ? null : `/Users/example/code/${project}`,
    ...(repository ? { git: { branch: name, repository } } : {}),
    ...overrides,
  });
}

const names = (sessions: readonly { name: string }[]) => sessions.map((s) => s.name);

test("the worktrees of one repository are one group under its name, in order of name, and those in none come last", () => {
  const groups = repositoryGroups([
    session("search-indexing", "scratch", null),
    session("checkout-flow", "storefront-checkout", STOREFRONT),
    session("rate-limits", "platform-api", PLATFORM_API),
    session("billing-webhooks", "storefront", STOREFRONT),
    session("docs-site", "docs", DOCS),
    session("mobile-onboarding", null, null),
  ]);

  expect(groups.map((group) => [group.id, group.label, names(group.sessions)])).toEqual([
    [DOCS.id, "docs", ["docs-site"]],
    [PLATFORM_API.id, "platform-api", ["rate-limits"]],
    [STOREFRONT.id, "storefront", ["checkout-flow", "billing-webhooks"]],
    [null, NO_REPOSITORY, ["search-indexing", "mobile-onboarding"]],
  ]);
  expect(NO_REPOSITORY).toBe("No repository");
});

test("a repository named two ways, as a main folder and its git folder kept apart can be, keeps one name whatever the order", () => {
  const main = session("billing-webhooks", "storefront", STOREFRONT);
  const worktree = session("checkout-flow", "storefront-checkout", { ...STOREFRONT, name: "sf" });

  for (const order of [
    [main, worktree],
    [worktree, main],
  ]) {
    const groups = repositoryGroups(order);
    expect(groups.map((group) => [group.label, group.sessions.length])).toEqual([["sf", 2]]);
  }
});

test("given the list's order, each group keeps the order of the status groups", () => {
  const listed = tableGroups([
    session("finished-run", "storefront", STOREFRONT, {
      status: "finished",
      statusSince: T - 5 * MINUTE,
    }),
    session("idle-one", "storefront-search", STOREFRONT, {
      status: "idle",
      statusSince: T - MINUTE,
    }),
    session("working-old", "storefront", STOREFRONT, {
      status: "working",
      statusSince: T - 30 * MINUTE,
    }),
    session("working-new", "storefront-checkout", STOREFRONT, {
      status: "working",
      statusSince: T - 2 * MINUTE,
    }),
  ]).flatMap((group) => group.sessions);

  const [storefront] = repositoryGroups(listed);
  expect(names(storefront!.sessions)).toEqual([
    "working-new",
    "working-old",
    "idle-one",
    "finished-run",
  ]);
});

test("two repositories of one name, in different places, are two groups, always in one order", () => {
  const work: GitRepository = { id: "0f0f0f0f0f0f0f0f", name: "api" };
  const oss: GitRepository = { id: "e1e1e1e1e1e1e1e1", name: "api" };
  const sessions = [session("oss-fix", "api", oss), session("work-fix", "api", work)];

  for (const order of [sessions, [...sessions].reverse()]) {
    expect(repositoryGroups(order).map((group) => group.id)).toEqual([work.id, oss.id]);
  }
});

test("names are in the order a person looks for them: case aside, and numbers by their value", () => {
  const groups = repositoryGroups([
    session("a", "web-10", { id: "aaaaaaaaaaaaaaa1", name: "web-10" }),
    session("b", "Web-2", { id: "aaaaaaaaaaaaaaa2", name: "Web-2" }),
    session("c", "api", { id: "aaaaaaaaaaaaaaa3", name: "api" }),
  ]);

  expect(groups.map((group) => group.label)).toEqual(["api", "Web-2", "web-10"]);
});

test("with no session in a repository there is one group, and with none at all there is none", () => {
  expect(repositoryGroups([session("scratch", "scratch", null)]).map((g) => g.label)).toEqual([
    NO_REPOSITORY,
  ]);
  expect(repositoryGroups([])).toEqual([]);
});

test("a card names the repository before the folder only when the folder's name is another", () => {
  // A worktree, and a folder inside the repository.
  expect(repositoryBeside(session("checkout-flow", "storefront-checkout", STOREFRONT))).toBe(
    "storefront",
  );
  expect(repositoryBeside(session("billing", "billing", PLATFORM_API))).toBe("platform-api");
  // The main folder is named for the repository already.
  expect(repositoryBeside(session("billing-webhooks", "storefront", STOREFRONT))).toBeNull();
  // In no repository, or with no repository sent.
  expect(repositoryBeside(session("scratch", "scratch", null))).toBeNull();
  expect(repositoryBeside(makeSession({ git: { branch: "main" } }))).toBeNull();
});
