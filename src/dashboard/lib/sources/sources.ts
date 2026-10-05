import type { Session, SourceHealth } from "@core/sessions/session";

/**
 * Where a source looks is said by the collector, in each source's `detail`: it
 * is the only part of the app that knows which command it ran and which folder it
 * read. The dashboard shows that sentence and keeps no description of its own,
 * because a fixed one goes wrong the moment the collector is pointed somewhere else.
 */

/** "Claude Code", or "Claude Code and Codex", from the sources in a snapshot. */
export function sourceNames(sources: readonly Pick<SourceHealth, "label">[]): string {
  const labels = sources.map((source) => source.label);
  if (labels.length === 0) return "your agent tools";
  if (labels.length === 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The sources the Overview speaks about. A tool that is not on this computer is
 * not news there, so it is left out, and the Overview of someone who uses one
 * tool looks as it would if Agent Lookout watched only that one. The Sources
 * view still lists it. When no source is found at all, every one of them is
 * kept, since that is the whole story.
 */
export function overviewSources<T extends Pick<SourceHealth, "state">>(
  sources: readonly T[],
): readonly T[] {
  const found = sources.filter((source) => source.state !== "unavailable");
  return found.length > 0 ? found : sources;
}

/**
 * Whether each session should say which tool it belongs to: only when more than
 * one tool is on this computer. With one, every row would say the same thing.
 */
export function showsAgents(sources: readonly Pick<SourceHealth, "state">[]): boolean {
  return sources.filter((source) => source.state !== "unavailable").length > 1;
}

/** The tool a session belongs to, in its own plain name: "Claude Code", "Codex". */
export function agentLabel(
  session: Pick<Session, "source">,
  sources: readonly Pick<SourceHealth, "id" | "label">[],
): string {
  return sources.find((source) => source.id === session.source)?.label ?? session.source;
}
