import type { SourceFact } from "../../core/sessions/session.ts";
import { PS_TABLE_ARGS } from "../processes/processTable.ts";
import { TAB_LOOK_SOONEST_MS, type TabAsker } from "../terminal/tabFinder.ts";
import { every } from "./words.ts";

/**
 * What the card of an adapter that looks for its sessions in tabs of Terminal
 * and iTerm2 says of the `ps` that finds them: what is run, and how often, or
 * "not run" until the finder has asked for one of this adapter's sessions. One
 * look serves every adapter, so a run for another's sessions alone leaves this
 * card at "not run", and a run for both shows on both. Saying so runs nothing:
 * the asker says what it has seen.
 *
 * Only a Mac has Terminal or iTerm2, and `ps` is asked for them nowhere else,
 * so anywhere else there is nothing to say. With `AGENT_LOOKOUT_TERMINAL_JUMP`
 * off the finder never asks, so the card says "not run".
 */
export function tabFacts(tabs: TabAsker | undefined, platform: NodeJS.Platform): SourceFact[] {
  if (platform !== "darwin" || !tabs) return [];
  return [
    { label: "Tab check", value: `ps ${PS_TABLE_ARGS.join(" ")}` },
    {
      label: "Tab check run",
      value: tabs.asked()
        ? `once for each new process, ${every(TAB_LOOK_SOONEST_MS)} at most`
        : "not run",
    },
  ];
}
