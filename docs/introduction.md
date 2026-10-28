---
title: Introduction
description: What Agent Lookout is, who it is for, what it does and what it leaves alone.
---

Agent Lookout is a local dashboard for the coding agent sessions running on your machine. It finds Claude Code and Codex sessions on its own, along with Antigravity, Antigravity CLI, Mistral Vibe, Gemini CLI, OpenCode and Qwen Code, and any agent that writes a [status file](GUIDE.md#your-own-agents). Mistral Vibe, Gemini CLI, OpenCode and Qwen Code support was built from their source and has not yet been checked on a machine running them.

It is for you if you run more than one coding agent at a time and lose track of which one is waiting on you.

- It lists your sessions by status, with each one's folder and branch.
- The Needs you panel shows the sessions waiting for you, longest first, with the reason, such as Waiting for permission or Asked you a question, and what a waiting Claude Code session asks, such as `Run: npm test`. Codex, Mistral Vibe, Gemini CLI, OpenCode and Qwen Code sessions never show there: see [what each agent can report](GUIDE.md#what-each-agent-can-report).
- Jump opens a Claude Code session in VS Code, selects its tmux pane, or brings its Terminal or iTerm2 tab forward on a Mac. See [Jump to a session's window](guide-jump-to-window.md).
- `agent-lookout mcp` is a read-only MCP server: an agent can ask it which sessions are running and which need you.

It never starts a session, and never types into one or sends it a message of yours. It acts on a session only when you press a button, such as Allow, Deny or Stop, which asks you to confirm, or by a permission rule you set in Settings. Allow, Deny and permission rules need its Claude Code plugin. It listens on this machine only, and by default sends nothing off it. The exceptions are the Mac app's daily update check on GitHub, which Settings turns off, the Mac app's one-time plugin install, and Claude Code's own `claude agents` command, which Agent Lookout runs and which may contact Anthropic. Email, webhook posts, phone pushes, pull requests and other machines stay off until you set them up. [PRIVACY.md](../PRIVACY.md) lists everything it reads, runs and sends.

It runs on macOS, Linux and Windows with Node.js 22.12 or newer. The Mac app needs macOS 13 or later and no Node.js. It is built and used on macOS. Linux and Windows are tested in CI, but nobody uses them day to day yet. On Windows, Jump reaches VS Code only, and there is no Stop, Allow, Deny or permission rule. The [README](../README.md#supported-agents-and-systems) has the full table.

Next: [Quickstart](quickstart.md).
