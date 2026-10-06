import type { Session } from "@core/sessions/session";

/** One group of the list by repository. */
export interface RepositoryGroup {
  /** The repository's id, or null for the sessions in no repository. */
  id: string | null;
  /** The repository's name, or "No repository". */
  label: string;
  /** Its sessions, in the order they were given. */
  sessions: Session[];
}

export const NO_REPOSITORY = "No repository";

/** Names in the order a person would look for them: "api-2" before "api-10", and case aside. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The sessions in a group for each repository their folders belong to, as the
 * collector told them: the worktrees of one repository together, under its
 * name. The groups are in order of name, so one stays where it is as its
 * sessions change, and two of one name, in different places, are in the order
 * of their ids. The sessions in no repository come last, under "No
 * repository". A group has at least one session.
 *
 * Inside each group the sessions keep the order they came in, so a list in
 * the order of the status groups stays in that order in each.
 */
export function repositoryGroups(sessions: readonly Session[]): RepositoryGroup[] {
  const groups = new Map<string, RepositoryGroup & { id: string }>();
  const none: Session[] = [];
  for (const session of sessions) {
    const repository = session.git?.repository;
    if (repository === undefined) {
      none.push(session);
      continue;
    }
    const group = groups.get(repository.id);
    if (group) {
      group.sessions.push(session);
      // The collector names a worktree's repository from its shared git folder,
      // which can be named otherwise than the main folder: the group keeps the
      // name first in order, so it does not change as its sessions move about.
      if (byName.compare(repository.name, group.label) < 0) group.label = repository.name;
    } else {
      groups.set(repository.id, { id: repository.id, label: repository.name, sessions: [session] });
    }
  }
  const named: RepositoryGroup[] = [...groups.values()].sort(
    (a, b) => byName.compare(a.label, b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return none.length > 0 ? [...named, { id: null, label: NO_REPOSITORY, sessions: none }] : named;
}

/**
 * The repository's name where a card names it before the folder: when the
 * folder's own name is another, as a worktree's or a folder inside the
 * repository's is. Null when the folder is named for the repository already,
 * or is in none.
 */
export function repositoryBeside(session: Pick<Session, "project" | "git">): string | null {
  const name = session.git?.repository?.name;
  return name !== undefined && name !== session.project ? name : null;
}
