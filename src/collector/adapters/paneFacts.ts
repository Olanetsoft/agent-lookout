import type { SourceFact } from "../../core/sessions/session.ts";
import { PS_PARENTS_ARGS } from "../processes/processParents.ts";
import { PANE_LOOK_INTERVAL_MS, type PaneAsker } from "../tmux/paneFinder.ts";
import { LIST_PANES_ARGS } from "../tmux/panes.ts";
import { every } from "./words.ts";

/** An argument as it is typed: one with a space in it is quoted. */
const typed = (arg: string) => (arg.includes(" ") ? `'${arg}'` : arg);

/**
 * What the card of an adapter that looks for its sessions in tmux panes says
 * of tmux and the `ps` that goes with it: what is run, and how often, or "not
 * run" until the finder has asked for one of this adapter's sessions. One look
 * serves every adapter, so a run for another's sessions alone leaves this card
 * at "not run", and a run for both shows on both. Saying so runs nothing: the
 * asker says what it has seen.
 *
 * - tmux is run on the finder's beat while a session's process runs, whether
 *   or not a tmux server is there to answer.
 * - `ps` is asked only by a look at which tmux lists a pane.
 *
 * Where tmux is never run there is nothing to say: on Windows, without tmux,
 * and with `AGENT_LOOKOUT_TMUX` off. `AGENT_LOOKOUT_TERMINAL_JUMP` is for tabs
 * alone: tmux and this `ps` run with it off, so the card still says so.
 */
export function paneFacts(panes: PaneAsker | undefined, platform: NodeJS.Platform): SourceFact[] {
  if (platform === "win32" || !panes?.installed()) return [];
  return [
    { label: "Pane check", value: `tmux ${LIST_PANES_ARGS.map(typed).join(" ")}` },
    {
      label: "Pane check run",
      value: panes.asked()
        ? `${every(PANE_LOOK_INTERVAL_MS)} while a session's process runs, and sooner when another appears or a Jump finds its pane gone`
        : "not run",
    },
    { label: "Pane parent check", value: `ps ${PS_PARENTS_ARGS.join(" ")}` },
    {
      label: "Pane parent check run",
      value: panes.parentsAsked() ? "with each pane check while tmux lists a pane" : "not run",
    },
  ];
}
