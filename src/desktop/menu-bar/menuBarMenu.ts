// What the app's item in the menu bar says: beside its icon, how many sessions
// need you, and nothing when none do; and in its menu, those sessions, the
// longest wait first, each with how long it has waited, its reason and what it
// is asking when that is known, cut short. Choosing one opens its details in
// the window. The menu ends with Open Agent Lookout, Check for Updates…,
// Settings… and Quit Agent Lookout.
//
// The count is the Dock badge's, by the same rule that lights the lamp in the
// page, `needsYou`: a prompt already answered, by Allow, Deny or a permission
// rule, is neither counted nor listed. A session's name and what it is asking are shown on this computer
// only, as a notification shows them. Two sessions listed under one name are
// told apart by their agent, project, branch or app, in brackets after it.
//
// It imports only types from Electron, so it is tested in plain Node.
// `menuBar.ts` builds the menu from it on each poll.

import type { MenuItemConstructorOptions } from "electron";

import { formatDuration } from "../../core/duration.ts";
import { sessionTitle, waitNotice } from "../../core/notices/waiting.ts";
import {
  agentName,
  surfaceLabel,
  type Session,
  type SourceHealth,
} from "../../core/sessions/session.ts";
import { sortSessions } from "../../core/sessions/sorting.ts";
import { MAX_NOTICE_TEXT_LENGTH, oneLine } from "../../core/text.ts";
import { needsYou } from "../../core/waits/answeredWaits.ts";

/** The longest a session's name runs in the menu, in characters. A longer one is cut. */
export const MAX_MENU_NAME_LENGTH = 40;

/** The longest the line under a name runs: the reason, and what the session is asking. */
export const MAX_MENU_DETAIL_LENGTH = 60;

/** The longest the part in brackets runs that tells two sessions of one name apart. */
export const MAX_MENU_TELLING_LENGTH = 24;

/** The most sessions the menu lists. The rest are counted under them. */
export const MAX_MENU_SESSIONS = 10;

/** What the menu needs of a session. */
export type MenuBarSession = Pick<
  Session,
  | "id"
  | "source"
  | "agent"
  | "surface"
  | "name"
  | "project"
  | "git"
  | "status"
  | "statusSince"
  | "waitingReason"
  | "waitingText"
  | "answered"
>;

/** What the menu needs of a poll's snapshot. */
export interface MenuBarSnapshot {
  sessions: readonly MenuBarSession[];
  sources: readonly Pick<SourceHealth, "id" | "label" | "state">[];
}

/** What the menu's items do. `main.ts` gives each its part of the app. */
export interface MenuBarActions {
  /** Opens the window on a session's details. */
  openSession: (sessionId: string) => void;
  /** Opens the window, or brings it forward. */
  openApp: () => void;
  checkForUpdates: () => void;
  openSettings: () => void;
  quit: () => void;
}

/**
 * The sessions that need you, the longest wait first, and one whose start is
 * not known last. One in a wait that was answered needs nobody.
 */
export function waitingSessions<T extends MenuBarSession>(sessions: readonly T[]): T[] {
  return sortSessions(sessions.filter(needsYou));
}

/**
 * Whether the snapshot is a count. Until an agent has been read, or a session
 * found, nothing was counted, and "Nothing needs you" would claim what was
 * never measured. `agent-lookout status` keeps to the same rule.
 */
function counted(snapshot: MenuBarSnapshot): boolean {
  return snapshot.sessions.length > 0 || snapshot.sources.some((source) => source.state === "ok");
}

/** What is shown beside the icon: the count that needs you, or nothing at zero. */
export function menuBarTitle(snapshot: MenuBarSnapshot | null): string {
  const count = snapshot === null ? 0 : waitingSessions(snapshot.sessions).length;
  return count > 0 ? String(count) : "";
}

function needYou(count: number): string {
  return count === 1 ? "1 session needs you" : `${count} sessions need you`;
}

/** The menu's first line, which says where things stand. */
export function menuBarHeadline(snapshot: MenuBarSnapshot | null): string {
  if (snapshot === null) return "Looking for agents…";
  if (!counted(snapshot)) {
    return snapshot.sources.some((source) => source.state === "searching")
      ? "Looking for agents…"
      : "No agent tool could be read";
  }
  const count = waitingSessions(snapshot.sessions).length;
  return count === 0 ? "Nothing needs you" : needYou(count);
}

/** What the icon says when the pointer rests on it. */
export function menuBarToolTip(snapshot: MenuBarSnapshot | null): string {
  const count = snapshot === null ? 0 : waitingSessions(snapshot.sessions).length;
  return count === 0 ? "Agent Lookout" : `Agent Lookout: ${needYou(count)}`;
}

type Sources = MenuBarSnapshot["sources"];

/** Something a session has that can tell it from another of the same name, or null when it is not known. */
type Telling = (session: MenuBarSession, sources: Sources) => string | null | undefined;

/** What can tell two sessions of one name apart, in the order each is tried. */
const TELLINGS: readonly Telling[] = [
  (session, sources) => agentName(session, sources),
  (session) => session.project,
  (session) => session.git?.branch ?? session.git?.commit,
  (session) => surfaceLabel(session.surface),
];

/** What a telling says of a session, on one line and cut short, or null. */
function told(telling: Telling, session: MenuBarSession, sources: Sources): string | null {
  const value = telling(session, sources);
  return value ? oneLine(value, MAX_MENU_TELLING_LENGTH) || null : null;
}

/**
 * What tells the sessions of one name apart: the first that gives each of them
 * its own, or failing that the first that gives any two different ones, or
 * null when nothing does.
 */
function tellingFor(group: readonly MenuBarSession[], sources: Sources): Telling | null {
  const values = (telling: Telling) => group.map((session) => told(telling, session, sources));
  return (
    TELLINGS.find((telling) => {
      const each = values(telling);
      return each.every((value) => value !== null) && new Set(each).size === group.length;
    }) ??
    TELLINGS.find((telling) => new Set(values(telling)).size > 1) ??
    null
  );
}

/**
 * The name each listed session goes by in the menu, cut short, and with what
 * tells it apart in brackets when another listed session goes by the same:
 * "checkout-flow (Codex)".
 */
function menuNames(listed: readonly MenuBarSession[], sources: Sources): string[] {
  const names = listed.map((session) => oneLine(sessionTitle(session), MAX_MENU_NAME_LENGTH));
  return names.map((name, index) => {
    const group = listed.filter((_, other) => names[other] === name);
    const session = listed[index];
    if (group.length < 2 || session === undefined) return name;
    const telling = tellingFor(group, sources);
    const apart = telling === null ? null : told(telling, session, sources);
    return apart === null ? name : `${name} (${apart})`;
  });
}

/** A listed session as the menu shows it, all but how long it has waited, which moves with the clock. */
interface MenuBarListing {
  id: string;
  name: string;
  statusSince: number | null;
  /** The reason, and what the session is asking, cut short. */
  sublabel: string;
  /** The same, whole, for a Mac that does not show the line under a name. */
  toolTip: string;
}

/** What the menu shows of a snapshot, all but the times. */
interface MenuBarList {
  headline: string;
  listed: MenuBarListing[];
  /** How many more need you than are listed. */
  more: number;
}

function menuBarList(snapshot: MenuBarSnapshot | null): MenuBarList {
  const waiting = snapshot === null ? [] : waitingSessions(snapshot.sessions);
  const listed = waiting.slice(0, MAX_MENU_SESSIONS);
  const names = menuNames(listed, snapshot?.sources ?? []);
  return {
    headline: menuBarHeadline(snapshot),
    listed: listed.map((session, index) => {
      const { body } = waitNotice(session);
      return {
        id: session.id,
        name: names[index] ?? sessionTitle(session),
        statusSince: session.statusSince,
        sublabel: oneLine(body, MAX_MENU_DETAIL_LENGTH),
        toolTip: oneLine(body, MAX_NOTICE_TEXT_LENGTH),
      };
    }),
    more: waiting.length - listed.length,
  };
}

/**
 * What the menu for a snapshot shows, all but the times, as one string: two
 * snapshots with the same make the same menu, at the same moment.
 */
export function menuBarKey(snapshot: MenuBarSnapshot | null): string {
  return JSON.stringify(menuBarList(snapshot));
}

/** Whether the menu for a snapshot shows how long a session has waited, which moves with the clock. */
export function menuBarHasTimes(snapshot: MenuBarSnapshot | null): boolean {
  return menuBarList(snapshot).listed.some((listing) => listing.statusSince !== null);
}

/**
 * A session's item: its name and how long it has waited, "checkout-flow ·
 * 4m 12s", with the reason and what it is asking under it, cut short, and the
 * whole of that when the pointer rests on it, for a Mac that does not show the
 * line under a name. A wait whose start is not known gives no time.
 */
function sessionItem(
  listing: MenuBarListing,
  now: number,
  actions: MenuBarActions,
): MenuItemConstructorOptions {
  const waited = listing.statusSince === null ? null : formatDuration(now - listing.statusSince);
  return {
    label: waited === null ? listing.name : `${listing.name} · ${waited}`,
    sublabel: listing.sublabel,
    toolTip: listing.toolTip,
    click: () => actions.openSession(listing.id),
  };
}

/**
 * The menu for a snapshot, at a moment: the headline, the sessions that need
 * you, and the app's own items. The snapshot is null before the first poll.
 */
export function menuBarTemplate(
  snapshot: MenuBarSnapshot | null,
  now: number,
  actions: MenuBarActions,
): MenuItemConstructorOptions[] {
  const { headline, listed, more } = menuBarList(snapshot);
  return [
    { label: headline, enabled: false },
    ...listed.map((listing) => sessionItem(listing, now, actions)),
    ...(more > 0 ? [{ label: `And ${more} more`, enabled: false }] : []),
    { type: "separator" },
    { label: "Open Agent Lookout", click: () => actions.openApp() },
    { label: "Check for Updates…", click: () => actions.checkForUpdates() },
    { label: "Settings…", click: () => actions.openSettings() },
    { type: "separator" },
    { label: "Quit Agent Lookout", click: () => actions.quit() },
  ];
}
