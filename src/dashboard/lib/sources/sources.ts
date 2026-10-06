import {
  agentName,
  isRemoteSource,
  type Session,
  type SourceHealth,
  type SourceId,
} from "@core/sessions/session";

/**
 * Where a source looks is said by the collector, in each source's `detail`: it
 * is the only part of the app that knows which command it ran and which folder it
 * read. The dashboard shows that sentence and keeps no description of its own,
 * because a fixed one goes wrong the moment the collector is pointed somewhere else.
 */

/** The source of sessions that status files are: a folder, not an agent tool. */
const STATUS_FILES: SourceId = "status-files";

/**
 * How a source is named inside a sentence: by its label, except the folder of
 * status files, which is no product and so is "status files", in lower case.
 */
function nameInSentence(source: Pick<SourceHealth, "label"> & { id?: SourceId }): string {
  return source.id === STATUS_FILES ? "status files" : source.label;
}

/**
 * "Claude Code", or "Claude Code, Codex and status files", from the sources in
 * a snapshot, to go inside a sentence.
 */
export function sourceNames(
  sources: readonly (Pick<SourceHealth, "label"> & { id?: SourceId })[],
): string {
  const labels = sources.map(nameInSentence);
  if (labels.length === 0) return "your agent tools";
  if (labels.length === 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Whether a source has something to read: it is neither missing nor waiting to be set up. */
function isThere(source: Pick<SourceHealth, "state">): boolean {
  return source.state !== "unavailable" && source.state !== "not-set-up";
}

/**
 * The sources the Overview speaks about. A tool that is not on this computer is
 * not news there, so it is left out, and the Overview of someone who uses one
 * tool looks as it would if Agent Lookout watched only that one. The Sources
 * view still lists it. When no source is found at all, every one of them is
 * kept, since that is the whole story.
 *
 * A source that is not set up is left out always. Nobody has asked for it, so
 * it is never news on the Overview, and the Sources view says how to start.
 */
export function overviewSources<T extends Pick<SourceHealth, "state">>(
  sources: readonly T[],
): readonly T[] {
  const set = sources.filter((source) => source.state !== "not-set-up");
  const found = set.filter(isThere);
  return found.length > 0 ? found : set;
}

/**
 * Whether each session should say which agent it belongs to: only when there
 * is more than one agent to name. With one, every row would say the same thing.
 *
 * The agents are the tools on this computer, and the agents named by the
 * sessions themselves, as status files name theirs. The folder of status files
 * is not an agent, so it counts only through its sessions, and nor is another
 * machine, whose sessions each name the agent they run in there.
 */
export function showsAgents(
  sources: readonly Pick<SourceHealth, "id" | "label" | "state">[],
  sessions: readonly Pick<Session, "agent">[] = [],
): boolean {
  const agents = new Set<string>();
  for (const source of sources) {
    if (isThere(source) && source.id !== STATUS_FILES && !isRemoteSource(source.id)) {
      agents.add(source.label);
    }
  }
  for (const session of sessions) {
    if (session.agent !== undefined) agents.add(session.agent);
  }
  return agents.size > 1;
}

/**
 * The agent a session belongs to, in its own plain name: "Claude Code",
 * "Codex", or the name a status file gives, such as "Night Shift".
 */
export function agentLabel(
  session: Pick<Session, "source" | "agent">,
  sources: readonly Pick<SourceHealth, "id" | "label">[],
): string {
  return agentName(session, sources) ?? session.source;
}

/**
 * The other machines whose sessions are not known now, by why: `away`, not
 * connected for whatever reason, and `connecting`, while ssh signs in the
 * first time. A machine is never news on the Overview for being read, but it
 * is for not being read: its sessions are missing from every count, so the
 * page says so rather than look all clear.
 */
export function unseenMachines<T extends Pick<SourceHealth, "id" | "state">>(
  sources: readonly T[],
): { away: T[]; connecting: T[] } {
  // The card that says why no machine is read is not set up, so it is neither.
  const machines = sources.filter((source) => isRemoteSource(source.id));
  return {
    away: machines.filter((source) => source.state === "unavailable" || source.state === "error"),
    connecting: machines.filter((source) => source.state === "searching"),
  };
}

/**
 * "devbox is not connected, so its sessions are not known.", and the same for
 * a machine still connecting, "gpu is still connecting, so its sessions are
 * not known yet.", for each that is so, or null when every machine is read.
 */
export function unseenSentence(unseen: {
  away: readonly Pick<SourceHealth, "label">[];
  connecting: readonly Pick<SourceHealth, "label">[];
}): string | null {
  const parts: string[] = [];
  if (unseen.away.length > 0) {
    const one = unseen.away.length === 1;
    parts.push(
      `${sourceNames(unseen.away)} ${one ? "is" : "are"} not connected, so ${one ? "its" : "their"} sessions are not known.`,
    );
  }
  if (unseen.connecting.length > 0) {
    const one = unseen.connecting.length === 1;
    parts.push(
      `${sourceNames(unseen.connecting)} ${one ? "is" : "are"} still connecting, so ${one ? "its" : "their"} sessions are not known yet.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
}
