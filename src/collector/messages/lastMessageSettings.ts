import type { LastMessageSetting } from "../../core/api.ts";
import {
  WAITING_TEXT_ENV,
  waitingTextOff,
} from "../adapters/claude-code/transcript/waitingTexts.ts";

/**
 * The setting that, set to `off`, stops a session's last message being read
 * when its details are open. On when it is left out, as it is by default.
 * `AGENT_LOOKOUT_WAITING_TEXT=off` stops it too, as it stops every transcript
 * being read.
 */
export const LAST_MESSAGE_ENV = "AGENT_LOOKOUT_LAST_MESSAGE" satisfies LastMessageSetting;

/** Whether the environment turns last messages off: `off`, in any case and with spaces around it. */
export function lastMessageOff(env: NodeJS.ProcessEnv): boolean {
  return env[LAST_MESSAGE_ENV]?.trim().toLowerCase() === "off";
}

/**
 * The setting that stops last messages being read, or null while none does.
 * `AGENT_LOOKOUT_WAITING_TEXT=off`, which says no transcript is read at all,
 * is named before `AGENT_LOOKOUT_LAST_MESSAGE=off` when both are set.
 */
export function lastMessageStoppedBy(env: NodeJS.ProcessEnv): LastMessageSetting | null {
  if (waitingTextOff(env)) return WAITING_TEXT_ENV;
  if (lastMessageOff(env)) return LAST_MESSAGE_ENV;
  return null;
}
