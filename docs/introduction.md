---
title: Introduction
description: Agent Lookout shows the coding agent sessions on your machine on one page, with the ones waiting on you first.
---

Agent Lookout is a local dashboard for the coding agent sessions running on your machine.

When you run several coding agents at once, one of them often stops to ask you something while you are looking at another. Agent Lookout reads the sessions on your machine, shows them on one page, and puts the ones waiting on you first.

## Try it

```bash
npx agent-lookout
```

Then open http://127.0.0.1:4777. The [Quickstart](quickstart.md) takes you from there to your first jump.

## How it works

- **One page for every session.** Each shows its status, folder and branch.
- **Waiting sessions first.** The Needs you panel lists the sessions waiting for you, longest wait first, with the reason, such as Waiting for permission. For Claude Code it also shows what the session asks, such as `Run: npm test`.
- **One press to the window.** Jump opens a Claude Code session in VS Code, selects its tmux pane, or brings its Terminal or iTerm2 tab forward on a Mac. [Jump to a session's window](guide-jump-to-window.md) shows how.
- **Read-only access for your agents.** `agent-lookout mcp` is an MCP server that an agent can ask which sessions are running and which need you.

## Supported agents

It finds these with no setup:

| Agent                                                           | Shows when it needs you                  |
| --------------------------------------------------------------- | ---------------------------------------- |
| Claude Code                                                     | Yes                                      |
| Antigravity and the Antigravity CLI                             | Yes, while it asks you to approve a step |
| Codex                                                           | No: a waiting session shows as working   |
| Mistral Vibe, Gemini CLI, OpenCode and Qwen Code                | No                                       |
| Any agent that writes a [status file](GUIDE.md#your-own-agents) | Yes, when it writes that it waits        |

Mistral Vibe, Gemini CLI, OpenCode and Qwen Code support was built from their source and has not yet been checked on a machine running them. [What each agent can report](GUIDE.md#what-each-agent-can-report) has the details.

## Requirements

Node.js 22.12 or newer, on macOS, Linux or Windows. Or the Mac app, on macOS 13 or later, which needs no Node.js.

|                              | macOS | Linux | Windows |
| ---------------------------- | ----- | ----- | ------- |
| Dashboard and the MCP server | Yes   | Yes   | Yes     |
| Jump to VS Code              | Yes   | Yes   | Yes     |
| Jump to a tmux pane          | Yes   | Yes   | No      |
| Jump to Terminal or iTerm2   | Yes   | No    | No      |
| Stop, Allow and Deny         | Yes   | Yes   | No      |
| Mac app                      | Yes   | No    | No      |

It is built and used on macOS. Linux and Windows are tested in CI, but nobody uses them day to day yet.

## Privacy and control

- It never starts a session, types into one or sends it a message of yours.
- It acts on a session only when you press Allow, Deny or Stop, or by a permission rule you set in Settings. Stop asks you to confirm. Allow, Deny and rules need its Claude Code plugin.
- It listens on this machine only, and by default sends nothing off it.

> **What can leave your machine.** The Mac app checks GitHub for a new version about once a day, which Settings turns off, and installs its Claude Code plugin once. Claude Code's own `claude agents` command, which Agent Lookout runs, may contact Anthropic. Email, webhooks, phone pushes, pull requests and other machines stay off until you set them up. [PRIVACY.md](../PRIVACY.md) lists everything it reads, runs and sends.

The [README](../README.md#supported-agents-and-systems) has the full tables. Next: [Quickstart](quickstart.md).
