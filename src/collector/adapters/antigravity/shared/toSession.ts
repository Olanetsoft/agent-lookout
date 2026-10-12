import {
  mapAntigravityStatus,
  type AntigravityLiveness,
} from "../../../../core/mapping/antigravityMapping.ts";
import { projectOf } from "../../../../core/sessions/project.ts";
import type { Session, SourceId, Surface } from "../../../../core/sessions/session.ts";
import { isStale } from "../../../../core/sessions/staleness.ts";
import { sessionName } from "../../../../core/text.ts";
import { plausibleTime } from "../../../../core/time.ts";
import type { TranscriptState } from "./transcriptFile.ts";

/** Which Antigravity product a session is read from, and how it is named and shown. */
export interface AntigravityProfile {
  /** The source its sessions belong to, and the start of each session's id. */
  sourceId: SourceId;
  /** How the Sources card and its sentences name the product. */
  label: string;
  /** Where its sessions run. */
  surface: Surface;
}

/** The Antigravity CLI, `agy`, which runs in a terminal. */
export const CLI_PROFILE: AntigravityProfile = {
  sourceId: "antigravity-cli",
  label: "Antigravity CLI",
  surface: "terminal",
};

/** Antigravity 2.0, Google's desktop app with the Agent Manager, whose chats run in its own window. */
export const APP_PROFILE: AntigravityProfile = {
  sourceId: "antigravity-app",
  label: "Antigravity",
  surface: "desktop",
};

/**
 * A conversation's first step and its later files are written a moment apart.
 * A time this little before the start is the same moment, not a contradiction.
 */
const WRITE_ORDER_SLACK_MS = 1_000;

export interface AntigravitySessionInput {
  /** The product the conversation is read from. */
  profile: AntigravityProfile;
  /** In lower case, from the folder's name. */
  conversationId: string;
  state: TranscriptState;
  live: AntigravityLiveness;
  /**
   * The approval the conversation's program waits for, from its log, when the
   * transcript has no step yet at the one that waits (`waitsForApproval`).
   */
  waiting?: { tool: string; since: number | null } | null;
  /** The title agy gave it, from its annotation file. */
  title?: string | null;
  /** The folder its program works in, from that program's log. */
  folder?: string | null;
  /** The newest modified time of the conversation's transcript, database and database log, from the `lstat`s made this poll. */
  writtenAt: number | null;
  /**
   * Antigravity 2.0 only: whether those files were written in the last few
   * seconds, which keeps a chat whose last step reads as idle working
   * (`mapAntigravityStatus`). The CLI never sets it.
   */
  writing?: boolean;
  now: number;
}

/**
 * One Antigravity conversation in the shared model, for the CLI or for
 * Antigravity 2.0, as the profile says.
 *
 * - The status comes from the transcript's last step and whether a program
 *   may have the conversation open (`mapAntigravityStatus`). A CLI session
 *   needs you, for permission, while its program's log says it waits for
 *   approval, with the tool agy names, such as `RunCommand`, as the detail.
 *   Antigravity 2.0's are never given a wait, and stay working while their
 *   files are written.
 * - The app is the profile's: the terminal for the CLI, the desktop app for
 *   Antigravity 2.0.
 * - It is named by the title Antigravity gave it, else its folder's name, else
 *   its conversation id, which `agy --conversation <id>` takes. The folder is
 *   the one its program's log names for the CLI, and the one the app's own
 *   list of chats names for Antigravity 2.0.
 * - The status time is when the run of steps that say what the last one says
 *   began: a working conversation since its turn's first step, an idle one
 *   since the step that ended its turn, and one that needs you since agy began
 *   to ask. A finished one has been so since its last step. An unknown status
 *   has no time. An Antigravity 2.0 chat kept working by its writes is working
 *   since the time an idle one would have.
 * - The last write is the newest modified time of its transcript, its
 *   database and its database's log.
 * - There is no pid, no `alive`, no link and no Stop: no program is tied to
 *   one conversation surely enough, and Antigravity 2.0 runs all its chats in
 *   one.
 */
export function antigravitySession(input: AntigravitySessionInput): Session {
  const { profile, conversationId, state, live, now } = input;
  const id = `${profile.sourceId}:${conversationId}`;
  const waiting = input.waiting ?? null;
  const status = mapAntigravityStatus({
    last: state.last,
    live,
    asking: waiting !== null,
    writing: input.writing === true,
  });

  const startedAt = plausibleTime(state.firstAt, now);
  let statusSince: number | null = null;
  if (status === "working" || status === "idle" || status === "failed") {
    statusSince = plausibleTime(state.since, now);
  } else if (status === "needs-you") {
    statusSince = plausibleTime(waiting?.since ?? null, now) ?? plausibleTime(state.lastAt, now);
  } else if (status === "finished") {
    statusSince = plausibleTime(state.lastAt, now);
  }
  if (
    statusSince !== null &&
    startedAt !== null &&
    statusSince < startedAt - WRITE_ORDER_SLACK_MS
  ) {
    // A status cannot have begun before the conversation did.
    statusSince = null;
  }

  const cwd = input.folder ?? null;
  const project = projectOf(cwd);
  const session: Session = {
    id,
    source: profile.sourceId,
    surface: profile.surface,
    name: input.title ?? project ?? sessionName(conversationId) ?? id,
    cwd,
    project,
    status,
    startedAt,
    statusSince,
    links: {},
    stale: isStale({ status, statusSince }, now),
  };
  if (status === "needs-you" && waiting !== null) {
    session.waitingReason = "permission";
    session.waitingDetail = waiting.tool;
  }
  const writtenAt = plausibleTime(input.writtenAt, now);
  const beforeStart =
    writtenAt !== null && startedAt !== null && writtenAt < startedAt - WRITE_ORDER_SLACK_MS;
  if (writtenAt !== null && !beforeStart) session.lastWriteAt = writtenAt;
  return session;
}
