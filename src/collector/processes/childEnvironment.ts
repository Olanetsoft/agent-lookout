/**
 * Agent Lookout's own settings, `AGENT_LOOKOUT_*`. Some are secrets: the mail
 * server's password in `AGENT_LOOKOUT_SMTP_URL`, the webhook's address, the
 * ntfy topic and token and the Pushover token and key. No program Agent
 * Lookout starts has any use for them.
 */
const OWN_SETTING = /^AGENT_LOOKOUT_/i;

/**
 * The environment a program Agent Lookout starts is given: the one it was
 * handed, without Agent Lookout's own settings, so a program it starts, such
 * as `claude`, `tmux`, `ssh`, `osascript` or the browser, never holds a
 * password or a token of Agent Lookout's, nor passes one on to what it starts.
 * Matched without regard to case, as Windows names variables.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const given: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!OWN_SETTING.test(name)) given[name] = value;
  }
  return given;
}
