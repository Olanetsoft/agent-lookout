import { isPaneId, placeOf } from "./panes.ts";
import type { RunTmux, TmuxResult } from "./program.ts";

// The one thing the collector does to tmux: make a pane the one a person sees
// when they look at their terminal. Every command is fixed. The only values
// that vary are the pane's id, which tmux gave and which is checked to be `%`
// and digits, and a client's name, which tmux gave too.

/** Makes the pane's window the selected window of its session. */
export const selectWindowArgs = (paneId: string) => ["select-window", "-t", paneId];

/** Makes the pane the selected pane of its window. */
export const selectPaneArgs = (paneId: string) => ["select-pane", "-t", paneId];

/** The pane's session, by id, and where the pane is, in the pane's own words. */
const WHERE_FORMAT = "#{session_id} #{window_index} #{pane_index} #{session_name}";

/** Asks where the pane is now. It prints one line and changes nothing. */
export const describePaneArgs = (paneId: string) => [
  "-u",
  "display-message",
  "-p",
  "-t",
  paneId,
  WHERE_FORMAT,
];

/** Every attached client, each with the id of the session it is showing. */
export const LIST_CLIENTS_ARGS = ["list-clients", "-F", "#{session_id} #{client_name}"] as const;

/** Has one client show the pane's session. */
export const switchClientArgs = (client: string, paneId: string) => [
  "switch-client",
  "-c",
  client,
  "-t",
  paneId,
];

const WHERE_LINE = /^(\$\d+) (\d+) (\d+) (.*)$/;
const CLIENT_LINE = /^(\$\d+) (.+)$/;
/** A client's name is its terminal, `/dev/ttys003`, or `client-` and a number. */
const CLIENT_NAME = /^[A-Za-z/][A-Za-z0-9_./-]*$/;

export type SelectFailure = "pane-gone" | "tmux-stopped" | "failed";

export type SelectOutcome =
  | {
      ok: true;
      /** Where the pane is, as tmux said after selecting it. Null when it did not say. */
      place: string | null;
    }
  | { ok: false; reason: SelectFailure };

/** Why a command failed, from what tmux printed about it. */
export function failureOf(result: Extract<TmuxResult, { ok: false }>): SelectFailure {
  if (/^can't find (pane|window|session)/m.test(result.stderr)) return "pane-gone";
  if (/^(no server running|error connecting to|lost server|server exited)/m.test(result.stderr)) {
    return "tmux-stopped";
  }
  return "failed";
}

/** The clients showing another session than this one, from what `list-clients` printed. */
export function clientsElsewhere(stdout: string, sessionId: string): string[] {
  const clients: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = CLIENT_LINE.exec(line);
    if (!match) continue;
    const [, showing, name] = match as unknown as [string, string, string];
    if (showing !== sessionId && CLIENT_NAME.test(name)) clients.push(name);
  }
  return clients;
}

/**
 * Selects a pane: its window in its session, the pane in its window, and its
 * session on every attached client that is showing another one. A client
 * already on that session is left alone.
 *
 * Nothing is run for an id that is not a pane id. When the first command fails
 * nothing has been changed, and what tmux said is the reason. Once the pane is
 * selected, a client that cannot be switched does not undo that.
 */
export async function selectPane(paneId: string, run: RunTmux): Promise<SelectOutcome> {
  if (!isPaneId(paneId)) return { ok: false, reason: "failed" };

  for (const args of [selectWindowArgs(paneId), selectPaneArgs(paneId)]) {
    const result = await run(args);
    if (!result.ok) return { ok: false, reason: failureOf(result) };
  }

  const described = await run(describePaneArgs(paneId));
  const where = described.ok ? WHERE_LINE.exec(described.stdout.split("\n")[0] ?? "") : null;
  if (!where) return { ok: true, place: null };
  const [, sessionId, windowIndex, paneIndex, sessionName] = where as unknown as [
    string,
    string,
    string,
    string,
    string,
  ];

  const clients = await run(LIST_CLIENTS_ARGS);
  if (clients.ok) {
    for (const client of clientsElsewhere(clients.stdout, sessionId)) {
      await run(switchClientArgs(client, paneId));
    }
  }
  return { ok: true, place: placeOf(sessionName, windowIndex, paneIndex) };
}
