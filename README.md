# Agent Lookout

Agent Lookout shows the AI agent sessions on your Mac, Linux or Windows computer in one browser page, and which need you.

It finds Claude Code and Codex sessions with no setup, and the sessions of any other agent that writes a small status file. It never starts a session. It stops one only when you press Stop and confirm, and answers a Claude Code permission prompt only when you press Allow or Deny, or by a permission rule you set, with its Claude Code plugin installed: it never acts on its own. By default Agent Lookout itself sends nothing anywhere. Start it with `npx agent-lookout`, or download the [Mac app](#mac-app).

[Install](#install) · [Guide](docs/GUIDE.md) · [Privacy](#privacy) · [Roadmap](https://github.com/Olanetsoft/agent-lookout/milestones) · [Website](https://agent-lookout.vercel.app)

<picture>
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Olanetsoft/agent-lookout/main/docs/images/dashboard-day.png">
  <img alt="The Overview. One session waits for permission in the Needs you panel, beside the Last hour chart. Below are the Sessions list, Events and Timeline." src="https://raw.githubusercontent.com/Olanetsoft/agent-lookout/main/docs/images/dashboard-night.png">
</picture>

## What it does

| Part                                                              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Needs you](docs/GUIDE.md#needs-you)                              | Lists the sessions waiting for permission or for an answer, longest wait first, each with a timer. For Claude Code it also says what the session is asking, such as `Run: npm test`.                                                                                                                                                                                                                                                                                                                                           |
| [Sessions](docs/GUIDE.md#sessions)                                | Lists the other sessions by status, by repository or on a board, each with its folder and git branch. Click one to see its details.                                                                                                                                                                                                                                                                                                                                                                                            |
| [Jump](docs/GUIDE.md#jump)                                        | Takes you to a Claude Code session. It opens it in VS Code, selects its tmux pane, or on a Mac brings its Terminal or iTerm2 tab to the front.                                                                                                                                                                                                                                                                                                                                                                                 |
| [Stop](docs/GUIDE.md#stop-a-session)                              | Ends a Claude Code session's process when you press Stop in its details and confirm. The conversation is kept. Sessions left running, idle for a day or more, can be ended together after a confirmation.                                                                                                                                                                                                                                                                                                                      |
| [Resume](docs/GUIDE.md#resume-a-session)                          | Copies the command that continues a Claude Code session that has ended, `cd` to its folder and `claude --resume` with its ID, for you to run in a terminal. It runs nothing itself.                                                                                                                                                                                                                                                                                                                                            |
| [Allow and Deny](docs/GUIDE.md#answer-a-permission-prompt)        | Answers a Claude Code permission prompt from the dashboard, with the Agent Lookout plugin installed in Claude Code. It shows the whole command first, and the prompt in the session still works.                                                                                                                                                                                                                                                                                                                               |
| [Permission rules](docs/GUIDE.md#permission-rules)                | Decide once how a Claude Code permission prompt is answered: always allow, always ask or always deny, by tool and, for Bash, by command, such as `npm test:*`. An allow rule answers only one plain command you could allow by hand, and never one that begins with `sudo`, `env`, `sh`, `bash` or another program on [the list](docs/GUIDE.md#permission-rules) that runs a command. A prefix trusts every word after its own, so `npm:*` also allows `npm exec`. The Events log records each answer. None until you add one. |
| [Notifications](docs/GUIDE.md#notifications)                      | Tell you when a session starts waiting and, if you choose, when one finishes, fails or ends. Off until you turn them on. On a Mac they keep coming after you close the tab, once a page with them on has been open.                                                                                                                                                                                                                                                                                                            |
| [Time rules](docs/GUIDE.md#time-rules)                            | Remind you of a long wait, set how long a session is idle before it is stale, and hold everything back during quiet hours, with one summary when they end. Off until you turn them on.                                                                                                                                                                                                                                                                                                                                         |
| [Pull requests](docs/GUIDE.md#pull-requests)                      | Shows a session's pull request on github.com and its checks, through your own `gh`, and marks a branch whose checks are failing. Off until you turn it on.                                                                                                                                                                                                                                                                                                                                                                     |
| [Email](docs/GUIDE.md#email) and [webhook](docs/GUIDE.md#webhook) | Send the same events to one email address, or to one webhook such as a Slack channel's, for when you are away. Off until you set them up.                                                                                                                                                                                                                                                                                                                                                                                      |
| [`agent-lookout status`](docs/GUIDE.md#in-the-terminal)           | Prints which sessions need you, for a terminal, a tmux status line or a script.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [`agent-lookout mcp`](docs/GUIDE.md#for-your-agents)              | Lets an AI agent ask which sessions need you. Its tools only read.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [Status files](docs/GUIDE.md#your-own-agents)                     | Show any other agent, including one you wrote, when it writes one small JSON file for each session.                                                                                                                                                                                                                                                                                                                                                                                                                            |

The Overview also has a chart of the last hour, a log of events, a timeline, and how long sessions waited on you today and over the last 7 days, day by day, with the sessions that waited longest. What they show is kept on this computer for 8 days, so a restart does not empty them. Press `/` to search every session. Sources says what Agent Lookout reads for each agent. [The screen](docs/GUIDE.md#the-screen) covers each part.

## Supported agents and systems

| Agent           | Setup                                                    | How it finds sessions                                                                                                                  | Shows when it needs you      | Jump                                                         |
| --------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Claude Code     | None                                                     | Reads `~/.claude/sessions` every 2 seconds, runs `claude agents` every 30 seconds, and reads the end of a waiting session's transcript | Yes                          | In VS Code, in tmux, or in a Terminal or iTerm2 tab on a Mac |
| Codex           | None                                                     | Reads `sessions`, `thread-writer-locks` and `session_index.jsonl` in `~/.codex` every 2 seconds, and runs nothing                      | No                           | No                                                           |
| Any other agent | It writes a [status file](docs/GUIDE.md#your-own-agents) | Reads `~/.agent-lookout/sessions` every 2 seconds                                                                                      | When its file says `waiting` | No                                                           |

Claude Code sessions are found whether they run in a terminal, in VS Code or in the desktop app.

A Codex session never shows as needing you. Codex's files do not record when it is waiting for your approval, so one that is waiting for you shows as working. Once it has written nothing for 5 minutes, its row says how long it has been quiet, which is the sign to look. Codex support has been checked with the Codex desktop app, and not yet with the Codex CLI or its IDE extension. [What each agent can report](docs/GUIDE.md#what-each-agent-can-report) has the full table.

Agent Lookout is developed and tested on macOS. On Linux, CI runs every test and starts the app there. On Windows, it runs the tests, less those of what Windows does not have, such as POSIX signals and Unix sockets, and starts the app there. No one has used it on a Linux or Windows desktop yet. Two things are macOS only: notifications with no dashboard tab open, and Jump to a Terminal or iTerm2 tab. On Windows, Stop, Allow and Deny, the permission rules, Resume and Jump to a tmux pane are not there either. [On Linux](docs/GUIDE.md#on-linux) and [On Windows](docs/GUIDE.md#on-windows) have the rest.

## Install

### Mac app

Download the disk image for your Mac from the [latest release](https://github.com/Olanetsoft/agent-lookout/releases/latest): the one that ends in `mac-arm64.dmg` for Apple silicon, or `mac-x64.dmg` for Intel. Open it and drag Agent Lookout to Applications. The app needs no Node.js.

It is not signed with an Apple Developer ID yet, so the first time you open it, macOS says “Agent Lookout” Not Opened. Press Done, then open System Settings › Privacy & Security and press Open Anyway. [Desktop app](docs/GUIDE.md#desktop-app) has the steps.

Its icon in the menu bar shows how many sessions need you, with the window open or closed, and a click lists them: choose one to open it.

Kept in Applications, it updates itself: about once a day it asks GitHub whether a newer version is out, and installs it when you press Install and Restart. Settings turns the daily check off. The app opens no port, so `agent-lookout status` and `agent-lookout mcp` cannot reach it. For those, start it with npx as well, and turn notifications on in only one of the two, or you get each one twice.

### With npx

1. Check what you have.

   ```sh
   node --version
   claude --version
   claude agents --help
   codex --version
   ```

   `node --version` prints `v22.12.0` or later. `claude --version` prints a version number followed by `(Claude Code)`, and `claude agents --help` prints a line that starts with `Usage: claude agents`. `codex --version` prints `codex-cli` followed by a version number.

   You need Node.js, and Claude Code, Codex or both. A command for a program you do not use prints `command not found`: carry on. Agent Lookout never runs `codex`, so the Codex desktop app needs no CLI. Without `claude agents` the rest works, but Claude Code's finished and failed background jobs are not listed.

2. Start it. It keeps running until you press Ctrl+C, so leave this terminal open.

   ```sh
   npx agent-lookout
   ```

   The first time, npm names the package and asks `Ok to proceed? (y)`. Press Enter. npm downloads under 2 MB and keeps it in its cache. Then Agent Lookout prints:

   ```text
   Agent Lookout is running at http://127.0.0.1:4777
   It listens on this machine only. Press Ctrl+C to stop.
   ```

   To run it in the background instead, run `nohup npx --yes agent-lookout > agent-lookout.log 2>&1 &`. What it prints then goes to `agent-lookout.log`.

   If it prints `Port 4777 is already in use`, another program has that port. Run `npx agent-lookout --port 4778` instead, and use 4778 in the next two steps. `agent-lookout status` and `agent-lookout mcp` then need `--url http://127.0.0.1:4778`, as [In the terminal](#in-the-terminal) says.

3. Check that it answers. If `npx agent-lookout` holds your terminal, use a second one.

   ```sh
   curl -s http://127.0.0.1:4777/api/health
   ```

   It prints `{"ok":true,"version":"0.2.1"}`, or a later version number.

4. Open <http://127.0.0.1:4777>. Your sessions appear within a few seconds. If none do, see [No sessions appear](docs/GUIDE.md#no-sessions-appear). If you used `npm run dev` before, turn notifications on again here: the browser keeps them for each address. To update later, run `npx agent-lookout@latest`, which also makes sure npx does not reuse an older copy it keeps.

If a step prints something else, [When something goes wrong](docs/GUIDE.md#when-something-goes-wrong) says what to do for the common problems.

To stop it, press Ctrl+C in its terminal. If it runs in the background, `lsof -nP -iTCP:4777 -sTCP:LISTEN` shows its process ID under `PID`, on macOS or on Linux with `lsof` installed. Put your port in place of 4777 if you chose another. `kill` followed by that number stops it. On Windows, `netstat -ano | findstr :4777` shows the process ID in its last column, and `taskkill /F /PID` followed by that number stops it.

To start it again, run `npx agent-lookout`. `npx agent-lookout --open` also opens the page in your browser, and `--port` chooses another port. [Start it with one command](docs/GUIDE.md#start-it-with-one-command) has the options.

Each time, npx asks npm's registry whether a newer version is out, as it does for any package it runs. To start it without that, install it once and run it by name:

```sh
npm install -g agent-lookout
agent-lookout
```

### From the repository

To run it from a clone, as you would to work on its code:

```sh
git clone https://github.com/Olanetsoft/agent-lookout.git
cd agent-lookout
npm install
npm run build
npm start
```

`npm start` prints the same two lines as `npx agent-lookout`. After a `git pull`, run `npm install` and `npm run build` again. `npm run dev` starts it at <http://localhost:5173> with the development tools used to work on its code, as [CONTRIBUTING.md](CONTRIBUTING.md) describes.

## Install with your agent

A coding agent such as Claude Code or Codex can start it for you. Give it this prompt:

```text
Start Agent Lookout on this computer. First check that node --version
prints v22.12.0 or later. Then run npx --yes agent-lookout in the
background and leave it running.
It should print "Agent Lookout is running at http://127.0.0.1:4777".
If it prints anything else, or says the port is in use, stop and tell
me what it printed.

Do not use sudo, and do not set up email or a webhook. You are done
when curl -s http://127.0.0.1:4777/api/health prints {"ok":true and a
version number. Tell me what it printed.
```

An agent's background command can end when its session does. If the page then says Agent Lookout has stopped updating, run `npx agent-lookout` yourself.

## In the terminal

`agent-lookout status` prints which sessions need you, from the Agent Lookout that is running, without opening the browser:

```sh
npx agent-lookout status
```

It prints, for example:

```text
2 need you · 3 working · 2 idle
checkout-flow    Waiting for permission  4m 12s
search-indexing  Asked you a question    31s
```

It exits with 0 when nothing needs you, and 1 when a session does. It exits with 2 when Agent Lookout is not running, cannot be read or has read no agent yet, as in its first seconds. A mistyped command also exits with 2. It takes `--count` for the number alone and `--json` for JSON. A tmux status line or a shell prompt runs it every few seconds, so for those install it with `npm install -g agent-lookout` and run `agent-lookout status`: npm then does not ask its registry each time. In a clone, run `npm run --silent status`.

It asks `http://127.0.0.1:4777`, then `http://localhost:5173`. If Agent Lookout runs on another port, give its address with `--url`, as in `npx agent-lookout status --url http://127.0.0.1:4778`, or set `AGENT_LOOKOUT_URL`. [In the terminal](docs/GUIDE.md#in-the-terminal) shows it in a tmux status line and a shell prompt.

## For your agents

`agent-lookout mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server. It lets an AI agent ask which sessions are running and which need you, so one agent can keep track of the others. Its three tools, `list_sessions`, `sessions_needing_you` and `sources`, only read: none of them can stop a session. It asks the Agent Lookout that is running, and starts nothing.

To add it to Claude Code for all your folders, run this once:

```sh
claude mcp add --scope user agent-lookout -- npx -y agent-lookout mcp
```

`-y` lets npx start it without asking, since the app gives it no terminal to answer in. Each time the app starts the server, npx asks npm's registry whether a newer version is out. To avoid that, install it once with `npm install -g agent-lookout`, and use `agent-lookout mcp` in place of `npx -y agent-lookout mcp`. In a clone, run the command in the `agent-lookout` folder with `"$PWD/bin/agent-lookout.mjs" mcp` in place of it.

`claude mcp list` then lists `agent-lookout`. Codex, and any other app that takes MCP servers, can start the same command, `npx -y agent-lookout mcp`. If Agent Lookout runs on another port, put `--url http://127.0.0.1:4778` after `mcp`. [For your agents](docs/GUIDE.md#for-your-agents) has the JSON form, and what to do when the app cannot find Node, as when Node was installed with nvm. [Privacy](#privacy) says where its answers go.

## Settings you can change

Settings are environment variables. Put one in front of the command it applies to:

```sh
AGENT_LOOKOUT_CLAUDE_FEED=off npx agent-lookout
```

| Setting                          | What it does                                                                                                                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_LOOKOUT_PORT`             | The port `npx agent-lookout`, `agent-lookout` and `npm start` listen on, 4777 unless set. `agent-lookout --port` does the same. It does not change where `status` and `mcp` look. |
| `AGENT_LOOKOUT_URL`              | The address `agent-lookout status` and `agent-lookout mcp` ask, such as `http://127.0.0.1:4778`. Set it where those commands run, not where Agent Lookout starts.                 |
| `AGENT_LOOKOUT_NOTIFICATIONS=on` | On a Mac, shows notifications of waits from the moment it starts, with no dashboard tab open.                                                                                     |
| `AGENT_LOOKOUT_CLAUDE_FEED=off`  | Never runs the `claude` command. Sessions come from Claude Code's session files alone.                                                                                            |
| `AGENT_LOOKOUT_WAITING_TEXT=off` | Never opens a Claude Code transcript. A waiting session shows its reason alone, here and on another machine read over SSH.                                                        |
| `AGENT_LOOKOUT_HISTORY=off`      | Keeps the Events log and the charts in memory only, so they start empty each time. Nothing is written to `~/.agent-lookout/history`.                                              |
| `AGENT_LOOKOUT_STOP=off`         | Takes away Stop and the ending of sessions left running. No session is ever stopped from Agent Lookout.                                                                           |
| `AGENT_LOOKOUT_ANSWER=off`       | Takes away Allow and Deny and the permission rules. No socket is opened for the plugin, and no permission prompt is answered from Agent Lookout.                                  |

[The guide](docs/GUIDE.md#settings-you-can-change) lists every setting, those for [email](docs/GUIDE.md#email) and the [webhook](docs/GUIDE.md#webhook) among them. The theme and the page's notifications are in the dashboard's Settings view.

## Privacy

By default Agent Lookout itself sends nothing anywhere: no telemetry, no analytics, no crash reports and no account. The one exception is the Mac app, which asks GitHub about once a day whether a newer version of it is out and sends nothing about your sessions: Settings turns that off, [Updates (Mac app only)](PRIVACY.md#updates-mac-app-only) says what it sends, and `npx agent-lookout` and the repository never check. Its fonts and scripts are bundled, so the page loads nothing from the internet. It keeps the Events log and the counts behind the charts on this computer, in `~/.agent-lookout/history`, so they are still there after a restart: for 8 days and up to 20 MB, with each session's name and status changes and no folder path, prompt or anything a waiting session is asking. Clear history in Settings deletes them, and `AGENT_LOOKOUT_HISTORY=off` keeps them in memory only. [PRIVACY.md](PRIVACY.md) lists everything it reads, runs, keeps and can send.

- Pull requests are off until you start Agent Lookout with `AGENT_LOOKOUT_PULL_REQUESTS=on`. Then it runs your own GitHub CLI, `gh`, which sends GitHub the owner and name of a session's repository and the name of its branch, with `gh`'s own login, so Agent Lookout never sees a token. It asks at most once every 2 minutes for each repository and branch, only for a remote on github.com and never about the default branch. [`gh`](PRIVACY.md#gh) says what it reads and keeps.
- Email and the webhook are off until you set them up. Then each goes only to the one address you name, and email goes through the mail server you name. A message holds the session's name, what happened and when, how long a wait has lasted, and the names of its folder, app and agent. It holds no path and no prompt, unless you also turn on what a waiting session is asking, below.
- Started with `npx agent-lookout`, npm contacts its registry: to download the package the first time, and each time after to ask whether a newer version is out. That is npm's own traffic, not Agent Lookout's. Installed with `npm install -g agent-lookout` and started as `agent-lookout`, npm is not involved.
- It runs Claude Code's own `claude agents` command, which may contact Anthropic the way Claude Code normally does. `AGENT_LOOKOUT_CLAUDE_FEED=off` stops it running that command.
- While a Claude Code session waits for you, it reads the end of its transcript to show what it asks, such as `Run: npm test`. It forgets that line when the wait ends. The line stays on this machine unless you start Agent Lookout with `AGENT_LOOKOUT_EMAIL_ASKING=on` or `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, which put it in the email or post for that wait, or another computer names this one in `AGENT_LOOKOUT_REMOTES` and reads its sessions over SSH. It can hold a command, a web address or a file's full path. No answer of `agent-lookout mcp` holds it. `AGENT_LOOKOUT_WAITING_TEXT=off` turns it off.
- Codex's session files hold your conversations. Agent Lookout reads them for when each turn started and ended, and for a few details such as the session's folder. It keeps none of your prompts, Codex's replies or the commands Codex ran.
- With the [Agent Lookout plugin](docs/GUIDE.md#answer-a-permission-prompt) installed in Claude Code, each permission request, the tool and its input, which for a new file is the whole file, goes from Claude Code to Agent Lookout over a socket in `~/.agent-lookout` that only you can open. Agent Lookout keeps what it shows of it in memory until the prompt is answered, and never writes it down or sends it on. The [permission rules](docs/GUIDE.md#permission-rules) you add are kept in `~/.agent-lookout/settings.json`, and the Events log keeps, for each request a rule answered, the tool and the rule, never the command.
- `agent-lookout mcp` does nothing until you add it to an agent's app. That app usually hands its answers, with your session names, folders and branches, to its model, which for most agents runs on the vendor's servers. [The MCP server](PRIVACY.md#the-mcp-server) says what an answer holds.
- Other machines are read only once you name them in `AGENT_LOOKOUT_REMOTES`. Then it runs your own `ssh` to each, which signs in with your config and agent, and asks the Agent Lookout running there for its sessions, sending nothing of this computer's. While it is connected, other programs and user accounts on this computer can reach Agent Lookout there through its tunnel, as they can reach it here. [Another machine over SSH](PRIVACY.md#another-machine-over-ssh) says what is read.
- Jump to a Terminal or iTerm2 tab needs macOS to let the program you start Agent Lookout from control that app. macOS asks once, and what you allow covers anything else you run from that program. Choose Don't Allow and only that Jump stops working. `AGENT_LOOKOUT_TERMINAL_JUMP=off` turns it off.

It listens on a loopback address only, `127.0.0.1`, or `::1` if you set `AGENT_LOOKOUT_HOST`, and refuses any other, so other computers cannot reach it. It turns away requests from websites open in your browser. It has no password. While it runs, other programs and other user accounts on this computer can read it. They can also turn the notifications it shows on or off, change the time rules and the permission rules, do what the Jump button does, clear the history, stop a Claude Code session as the Stop button does, and answer a permission prompt it is holding as Allow and Deny do. The Mac app opens no port, so there only its own window can. A program running as you can still change its rules, by writing `~/.agent-lookout/settings.json`, which the app takes up at its next poll. It writes to no agent's files. It changes three things outside itself, and only when you ask. When you press Jump, it brings a tmux pane, or a Terminal or iTerm2 tab, to the front. When you press Stop and confirm, it ends that Claude Code session's process. When you press Allow or Deny, or a permission rule you added matches, it answers that one permission prompt, and rewrites nothing and saves no rule in Claude Code. `AGENT_LOOKOUT_STOP=off` takes Stop away, and `AGENT_LOOKOUT_ANSWER=off` takes Allow, Deny and the permission rules away.

## What it does not do yet

- It does not resume a session itself: Resume copies the command that does, for a Claude Code session that has ended, on macOS and Linux. It cannot send a session a message. It stops a Claude Code session only when you press Stop and confirm, and not one in the desktop app or on Windows. It answers a permission prompt only with the plugin installed, and not on Windows, and offers Deny alone for an edit, since it does not show the change, for a plan or a question, and for a request it cannot show whole and as it is. A permission rule answers Claude Code's prompts only, and an allow rule never allows what you could not allow by hand, or a Bash line of more than one plain command. An agent using `agent-lookout mcp` can do none of these.
- It shows sessions on this computer, and on [another machine](docs/GUIDE.md#another-machine-over-ssh) running Agent Lookout that you reach over SSH. Cloud sessions, Codex cloud tasks and chats in a browser tab do not appear.
- Claude Code's session files and Codex's files are not documented by their makers. An update to either can make Agent Lookout show less, or nothing, until it is updated. [docs/adapters/codex.md](docs/adapters/codex.md#what-breaks-when-codex-changes) lists what breaks when Codex changes.
- The Mac app is not signed with an Apple Developer ID yet, so the first time it is opened, macOS does not open it until you allow it in Privacy & Security. There is no app for Linux or Windows. Support for more agents is planned in the [milestones](https://github.com/Olanetsoft/agent-lookout/milestones).

[What it does not do yet](docs/GUIDE.md#what-it-does-not-do-yet) has the details.

## Documentation

| To                                                                 | Read                                                                 |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Learn each part of the screen, every setting and every fix         | [docs/GUIDE.md](docs/GUIDE.md)                                       |
| See every file it reads, every command it runs and all it can send | [PRIVACY.md](PRIVACY.md)                                             |
| Call its local HTTP API                                            | [docs/API.md](docs/API.md)                                           |
| See how the parts fit together                                     | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                         |
| See what it reads from Codex, and what breaks when Codex changes   | [docs/adapters/codex.md](docs/adapters/codex.md)                     |
| Add another agent, or send a fix                                   | [CONTRIBUTING.md](CONTRIBUTING.md)                                   |
| See what changed                                                   | [CHANGELOG.md](CHANGELOG.md)                                         |
| See what is planned                                                | [Milestones](https://github.com/Olanetsoft/agent-lookout/milestones) |

## Contributing

Bug reports, fixes and support for other agents are welcome. For anything larger than a fix, open an issue first. [CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the checks to run and how to add another agent. Report a security problem privately, as [SECURITY.md](SECURITY.md) describes, and not in a public issue.

## License

Agent Lookout is [MIT licensed](LICENSE). The package's `dist/THIRD-PARTY-LICENSES.md` lists the licences of the libraries and fonts the dashboard and the command include. It is an unofficial project, not affiliated with or endorsed by Anthropic, OpenAI or any other agent maker. See [DISCLAIMER.md](DISCLAIMER.md).
