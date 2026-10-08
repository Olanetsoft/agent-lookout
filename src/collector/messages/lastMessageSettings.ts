import type { LastMessageSetting } from "../../core/api.ts";

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
