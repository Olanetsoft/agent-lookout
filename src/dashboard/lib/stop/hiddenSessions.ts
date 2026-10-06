import type { Session } from "@core/sessions/session";

/**
 * The sessions left running that the person has hidden, each until it
 * changes. A session is kept as its id and the moment its idle began, so the
 * first change of status shows it again. Kept in local storage, so it belongs
 * to this browser at this address, and written only when the person hides one.
 * It touches no process and no file.
 */

export const HIDDEN_SESSIONS_STORAGE_KEY = "agent-lookout-hidden-sessions";

/** The most kept. The oldest go first, and by then their sessions have long changed. */
export const MAX_HIDDEN = 100;

/** Hidden on this page while storage could not be written. */
const hiddenHere = new Set<string>();

/** What one hidden session is kept as: its id and the moment its idle began. */
export function hiddenKey(session: Pick<Session, "id" | "statusSince">): string {
  return `${session.statusSince ?? ""} ${session.id}`;
}

/** What storage holds. Nothing, when it cannot be read or holds anything else. */
function stored(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(HIDDEN_SESSIONS_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((key) => typeof key === "string") : [];
  } catch {
    // Storage can be blocked, or hold something else.
    return [];
  }
}

/** Every session hidden on this browser, as `hiddenKey` writes them. */
export function readHidden(): Set<string> {
  return new Set([...stored(), ...hiddenHere]);
}

/** Hides one session until it changes, and gives back every one hidden. */
export function hideSession(session: Pick<Session, "id" | "statusSince">): Set<string> {
  const key = hiddenKey(session);
  const kept = stored().filter((one) => one !== key);
  kept.push(key);
  try {
    localStorage.setItem(HIDDEN_SESSIONS_STORAGE_KEY, JSON.stringify(kept.slice(-MAX_HIDDEN)));
  } catch {
    // Storage can be blocked. It stays hidden on this page instead.
    hiddenHere.add(key);
  }
  return readHidden();
}
