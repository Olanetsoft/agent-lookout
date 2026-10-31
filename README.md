# Agent Lookout

See every AI coding agent running on your computer on one page, and which one is waiting on you.

[![npm](https://img.shields.io/npm/v/agent-lookout)](https://www.npmjs.com/package/agent-lookout) [![CI](https://img.shields.io/github/actions/workflow/status/Olanetsoft/agent-lookout/ci.yml?branch=main&label=CI)](https://github.com/Olanetsoft/agent-lookout/actions/workflows/ci.yml) [![License](https://img.shields.io/npm/l/agent-lookout)](LICENSE) ![Node.js](https://img.shields.io/node/v/agent-lookout)

It finds your Claude Code, Codex, Antigravity, Antigravity CLI, Mistral Vibe, Gemini CLI, OpenCode, Qwen Code and Hermes Agent sessions on its own, with no setup. It never starts a session, and it stops one or answers a prompt only when you press the button, or by a rule you set.

[Install](#install) · [Download for Mac](https://github.com/Olanetsoft/agent-lookout/releases/latest) · [Guide](docs/GUIDE.md) · [Privacy](#privacy) · [Changelog](CHANGELOG.md) · [Website](https://www.agentlookout.app)

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Olanetsoft/agent-lookout/main/docs/images/dashboard-day.png">
  <img alt="The Overview. In the Needs you panel, checkout-flow, a Claude Code session in Terminal, has waited 4 minutes 12 seconds for permission. Under Asks to run are the whole command, npm test, its description and the Deny and Allow buttons, and a Jump button is beside the timer. Below them are bars of how long sessions waited on you and counts of working, idle and stale sessions. The Last hour chart is beside the panel. Under both are the Sessions list, where billing-migration is marked devbox, the other machine it runs on, and the Events log." src="https://raw.githubusercontent.com/Olanetsoft/agent-lookout/main/docs/images/dashboard-night.png">
</picture>

_A Claude Code session asks to run `npm test`. With the Claude Code plugin, Allow or Deny answers it from the page, and Jump takes you to it in Terminal._

## Install

**With Node.js 22.12 or newer**, on macOS, Linux or Windows:

```sh
npx agent-lookout
```

Then open http://127.0.0.1:4777. Your sessions appear within a few seconds.

**Mac app:** download it from the [latest release](https://github.com/Olanetsoft/agent-lookout/releases/latest) (`arm64` for Apple silicon, `x64` for Intel) and drag it to Applications. It needs macOS 13 or later, and no Node.js. The first time, macOS says it was not opened: press Open Anyway in System Settings › Privacy & Security.

**To answer Claude Code's permission prompts from the page**, add the plugin in Claude Code. The Mac app adds it for you the first time it opens.

```text
/plugin marketplace add Olanetsoft/agent-lookout
/plugin install agent-lookout@agent-lookout
```

[The install guide](docs/INSTALL.md) covers running it in the background, another port, updating, and asking your coding agent to start it for you.

## What it does

- **Needs you:** the sessions waiting for your permission or an answer, longest first, with what a Claude Code session is asking.
- **Sessions:** everything else, by status, by repository or on a board, with folder and branch.
- **Answer and act:** Allow or Deny a Claude Code prompt, jump to its terminal or editor, or stop it after you confirm.
- **Details:** Claude Code, Codex, Antigravity and Qwen Code sessions show what they last said, and all but Qwen Code how many tokens the newest reply took.
- **Notifications:** on your desktop, by email, by webhook or on your phone, when a session waits or finishes. All off until you turn them on.
- **Your own agents:** any agent that writes one small JSON file per session shows up too.

[The guide](docs/GUIDE.md) explains every part of the screen.

## Supported agents and systems

Any other agent can show up by writing one small file per session. [Your own agents](docs/GUIDE.md#your-own-agents) shows how.

<!-- Checked against the adapters by tests/integration/collector/adapters/adapter.test.ts -->

| Agent           | Needs you | Jump   | Quiet for | Tokens | Stop   | Answer |
| --------------- | --------- | ------ | --------- | ------ | ------ | ------ |
| Claude Code     | Yes       | Partly | No        | Partly | Partly | Partly |
| Codex           | No        | No     | Yes       | Yes    | No     | No     |
| Antigravity CLI | Partly    | No     | Yes       | Yes    | No     | No     |
| Antigravity     | Partly    | No     | Yes       | Yes    | No     | No     |
| Mistral Vibe    | No        | No     | Yes       | No     | No     | No     |
| Gemini CLI      | No        | No     | Yes       | No     | No     | No     |
| OpenCode        | No        | No     | No        | No     | No     | No     |
| Qwen Code       | No        | No     | Yes       | No     | No     | No     |
| Hermes Agent    | Partly    | No     | No        | No     | No     | No     |
| Status files    | Partly    | No     | Partly    | No     | No     | No     |

Codex doesn't record when it waits for your approval, so a waiting session shows as working, and after 5 minutes its row says how long it has been quiet. The Antigravity CLI and the Antigravity app show as needing you while they ask you to approve a step, but not what they ask. [What each agent can report](docs/GUIDE.md#what-each-agent-can-report) explains every Partly and No.

Mistral Vibe support was built from Vibe 2.26.1's source and has not yet been checked on a computer running Vibe.

Gemini CLI support was built from its source at v0.64.0 and has not yet been checked on a machine running it.

OpenCode support was built from its source at v1.19.0 and has not yet been checked on a computer running it.

Qwen Code support was built from Qwen Code's source at 0.25.1 and has not yet been checked on a machine running it.

Hermes Agent support was built from its source at v0.22.5 and has not yet been checked on a computer running it.

|                                                    | macOS | Linux | Windows |
| -------------------------------------------------- | ----- | ----- | ------- |
| Dashboard, `status`, `mcp`, email, webhook, pushes | Yes   | Yes   | Yes     |
| Jump to VS Code                                    | Yes   | Yes   | Yes     |
| Jump to a tmux pane                                | Yes   | Yes   | No      |
| Jump to Terminal or iTerm2                         | Yes   | No    | No      |
| Stop, and ending sessions left running             | Yes   | Yes   | No      |
| Allow and Deny, permission rules                   | Yes   | Yes   | No      |
| Resume                                             | Yes   | Yes   | No      |
| Notifications with no tab open                     | Yes   | No    | No      |
| Mac app and menu bar                               | Yes   | No    | No      |

Built and used on macOS. Linux and Windows are tested in CI, but nobody uses them day to day yet. [On Linux](docs/GUIDE.md#on-linux) · [On Windows](docs/GUIDE.md#on-windows)

## In the terminal and for your agents

`npx agent-lookout status` prints who needs you, for a shell prompt or a tmux status line. `agent-lookout mcp` lets an AI agent ask the same thing; it only reads. Add it to Claude Code with:

```sh
claude mcp add --scope user agent-lookout -- npx -y agent-lookout mcp
```

[In the terminal](docs/GUIDE.md#in-the-terminal) and [For your agents](docs/GUIDE.md#for-your-agents) have the details and other apps' setup.

## Privacy

By default Agent Lookout sends nothing anywhere: no telemetry, no analytics, no account. The one exception is the Mac app's daily check on GitHub for a newer version, which Settings turns off. Email, webhooks, phone pushes, pull requests and other machines stay off until you set them up. It listens on this computer only.

[PRIVACY.md](PRIVACY.md) lists every file it reads and every command it runs. [SECURITY.md](SECURITY.md) says what it guards against.

## What it does not do yet

It can't send a session a message, and cloud sessions, browser chats and the Antigravity IDE's own agent don't appear yet. The Mac app isn't signed with an Apple Developer ID yet. [More](docs/GUIDE.md#what-it-does-not-do-yet), and what's planned in the [milestones](https://github.com/Olanetsoft/agent-lookout/milestones).

## Documentation

| I want to                                   | Read                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Install, update or stop it                  | [docs/INSTALL.md](docs/INSTALL.md)                                   |
| Learn the screen                            | [The screen](docs/GUIDE.md#the-screen)                               |
| Change a setting                            | [Settings you can change](docs/GUIDE.md#settings-you-can-change)     |
| Fix a problem                               | [When something goes wrong](docs/GUIDE.md#when-something-goes-wrong) |
| See every file it reads and all it can send | [PRIVACY.md](PRIVACY.md)                                             |
| Call its local API                          | [docs/API.md](docs/API.md)                                           |
| Learn how the code works                    | [docs/TOUR.md](docs/TOUR.md)                                         |
| See what changed                            | [CHANGELOG.md](CHANGELOG.md)                                         |

## For coding agents

To set Agent Lookout up for someone:

- Run `npx --yes agent-lookout` in the background. It is ready when `curl -s http://127.0.0.1:4777/api/health` prints `{"ok":true`.
- `npx agent-lookout status --json` prints the counts and the sessions that need you, and exits with 0 when nothing needs you, 1 when a session does, and 2 when Agent Lookout is not running or not ready.
- `GET /api/sessions` lists every session. All routes answer on this computer only, and [docs/API.md](docs/API.md) lists them.
- Do not use `sudo`, and do not set up email, a webhook, phone pushes, pull requests or other machines unless asked.

To change its code, read [AGENTS.md](AGENTS.md) first and run `npm run check` before you finish. Codex, and Claude Code from version 2.1.277, read AGENTS.md on their own. If you keep your own CLAUDE.md in the clone, put the line `@AGENTS.md` in it.

## Contributing

Bug reports, fixes and support for more agents are welcome. Open an issue first for anything bigger than a fix. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, checks and [adding an agent](CONTRIBUTING.md#adding-an-adapter). Report a security problem privately, as [SECURITY.md](SECURITY.md) describes.

## License

[MIT](LICENSE). The package's `dist/THIRD-PARTY-LICENSES.md` lists the licences of the libraries and fonts it includes. An unofficial project, not affiliated with or endorsed by Anthropic, OpenAI, Google or any other agent maker. See [DISCLAIMER.md](DISCLAIMER.md).
