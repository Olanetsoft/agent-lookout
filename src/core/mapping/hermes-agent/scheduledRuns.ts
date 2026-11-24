// The title Hermes Agent's scheduler gives a run, told by its form alone.
//
// Every version of Hermes Agent that titles a scheduled run, v2026.6.19 to
// v0.23.4, titles it `<job name> · <date>`, with the date as
// `strftime("%b %d %H:%M")` gives it, and ` #2` and so on after it when the
// title is taken (`_set_cron_session_title` and `_finalize_cron_session`,
// `cron/scheduler.py`). A copy of it on a branch has ` #2` or ` fork` after it
// (`next_title_in_lineage`, `persistence/sqlite/_schema.py`; the fork in
// `gateway/platforms/api_server.py`). A job made with no name takes the first
// 50 characters of its prompt as its name, so such a title can hold a prompt,
// and it is marked as one a person typed.
//
// The form says that a title can be the scheduler's. It does not say that one
// is not, so it is only ever a reason to leave a title out. A run's own row is
// told by its marks instead (`sessionRows.ts` in the adapter). The form is for
// what those marks do not reach: a branch whose run Hermes Agent has deleted,
// a name in the history, and a name an Agent Lookout on another computer sends,
// which an earlier version kept or sends as it was.

/**
 * The date as the scheduler writes it, after the middle dot between spaces, as
 * a SQLite GLOB pattern: a word or words for the month, which another locale
 * can write in any way, and the day, hour and minute in digits.
 */
const DATE = " · * [0-9][0-9] [0-9][0-9]:[0-9][0-9]";

/**
 * The form, as SQLite GLOB patterns, any of which is it: the date at the
 * title's end, or with ` #` and a number, or ` fork`, after it. No other word
 * is ever put there by Hermes Agent.
 */
export const SCHEDULED_TITLE_GLOBS: readonly string[] = [
  `*${DATE}`,
  `*${DATE} #[0-9]*`,
  `*${DATE} fork*`,
];

/** The same form as a regular expression. */
const SCHEDULED_TITLE = / · .* \d\d \d\d:\d\d(?:$| #\d| fork)/su;

/** The id of a Hermes Agent session, on this computer or on one read over SSH: its own id is in the group. */
const HERMES_AGENT_ID = /^(?:remote:[^:]+:)?(hermes-agent:.+)$/su;

/**
 * The own id of the Hermes Agent session with this id, when this name of its
 * can be the title the scheduler gave a run, by its form. Null for any other
 * name, and for another agent's session.
 */
function scheduledId(sessionId: string, name: string): string | null {
  if (!SCHEDULED_TITLE.test(name)) return null;
  return HERMES_AGENT_ID.exec(sessionId)?.[1] ?? null;
}

/** Whether a session is Hermes Agent's and this name of its can be the title the scheduler gave a run. */
export function canBeScheduledTitle(sessionId: string, name: string): boolean {
  return scheduledId(sessionId, name) !== null;
}

/**
 * A session's name as the history kept it, or, for a Hermes Agent session whose
 * kept name has the form of a title the scheduler gives a run, the session's
 * own id, which is what a session with no title and no folder is named. An
 * earlier version kept those titles as they were. A model's title of that form,
 * which this version shows and keeps, is read back as the id too, since the
 * history does not say who wrote a name. Any other name is as it was.
 */
export function keptName(sessionId: string, name: string): string {
  return scheduledId(sessionId, name) ?? name;
}
