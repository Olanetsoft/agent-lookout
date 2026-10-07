# Agent Lookout plugin for Claude Code

This plugin lets you answer a Claude Code permission prompt from the [Agent Lookout](https://github.com/Olanetsoft/agent-lookout) dashboard, with Allow or Deny. The prompt in the session still works, and whichever you answer first wins.

It is one `PermissionRequest` hook, `hooks/ask-agent-lookout.sh`. Claude Code runs it as it is about to ask you for permission, with the request on stdin. The script sends the request with `curl` to Agent Lookout's socket on this computer, `~/.agent-lookout/answer.sock`, or the one `AGENT_LOOKOUT_ANSWER_SOCKET` names, and prints the answer when you press Allow or Deny, or when a [permission rule](../../docs/GUIDE.md#permission-rules) you added in Agent Lookout decides it. With no socket there, as when Agent Lookout is not running, it exits at once and prints nothing, and Claude Code asks as usual. It sends nothing anywhere else and changes nothing on this computer. `AGENT_LOOKOUT_HOOK_MAX_TIME` sets how many seconds `curl` waits, 580 unless set, under the 600 seconds Claude Code gives the hook.

## Install

In Claude Code:

```text
/plugin marketplace add Olanetsoft/agent-lookout
/plugin install agent-lookout@agent-lookout
```

To remove it, run `/plugin uninstall agent-lookout@agent-lookout`.

[Answer a permission prompt](../../docs/GUIDE.md#answer-a-permission-prompt) in the guide says what the dashboard shows and when it offers Allow, and [PRIVACY.md](../../PRIVACY.md#the-claude-code-plugin-and-permission-prompts) what the hook sends and what Agent Lookout keeps.
