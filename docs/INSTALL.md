# Install

Agent Lookout runs with npx, as a Mac app, or from a clone of the repository. The Claude Code plugin adds Allow and Deny to any of them. [The README](../README.md) says what it does.

## Requirements

- macOS, Linux or Windows. Agent Lookout is developed and used on macOS. On Linux and Windows, CI runs the tests and starts it, and no one has used it on those desktops yet. [On Linux](GUIDE.md#on-linux) and [On Windows](GUIDE.md#on-windows) say what differs there.
- Node.js 22.12 or newer. The [Mac app](#mac-app) needs no Node.js, and macOS 13 Ventura or later.
- Claude Code, Codex, Antigravity, the Antigravity CLI (`agy`), Mistral Vibe, Gemini CLI, OpenCode, Qwen Code, Hermes Agent, Cline, Goose, Pi, Kimi Code, Continue, Crush, Kilo Code, MiMo Code, Kimchi, Prime Agent, fx, Unreal Agent, Autohand Code, DeepSeek Harness, Droid, Grok Build, Oh My Pi, Muse Code, Copilot CLI or Kiro CLI. None needs any setup. Any other agent can appear too, by writing a [status file](GUIDE.md#your-own-agents).
- For Claude Code, a version that has the `claude agents` command. Without it, Agent Lookout still reads the session files, but cannot list background jobs that have finished or failed.
- For Codex, version 0.155 or later, so that Agent Lookout can tell a session that has ended from one that is idle.
- For the Antigravity CLI, version 1.3.1 is the one Agent Lookout was written from, and it was checked against one conversation; parts, such as `/resume`, are not yet checked. The Antigravity IDE's conversations do not appear yet, and Sources says when its folder is there.
- For Antigravity, the desktop app Google calls Antigravity 2.0, Agent Lookout was written from the layout of its files on one Mac. Its chats show as working, idle or failed, as needing you while the app asks you to approve a step, except on Windows, and on a Mac as finished once the app is closed. Each chat's folder, and whether it waits for you, are read with the system's `sqlite3`, which macOS has.
- For Mistral Vibe, Agent Lookout was built from the source of Vibe 2.26.1, 3.0.4 and 3.1.4 and has not yet been checked on a computer running Vibe. Its sessions show as needing you, working, idle, finished or failed. A session whose subagent waits for you shows as working, and sessions Vibe ran on its older engine, the default before 2.26.0, do not appear.
- For Gemini CLI, version 0.39 or later, which saves sessions in the format Agent Lookout reads. Agent Lookout was built from Gemini CLI 0.64.0's source and has not yet been checked on a machine running it. Its sessions show as working, idle, failed or unknown, never as needing you or finished. A session shows as failed only when a request ends on an error Gemini CLI records.
- For OpenCode, a version that keeps its sessions in its `opencode.db` database, as OpenCode does from 1.2 on, on macOS or Linux, and the system's `sqlite3`, which macOS has, and which Ubuntu and Debian install with `sudo apt install sqlite3`. Agent Lookout was built from OpenCode's source at v1.19.0 and v2.2.5 and has not yet been checked on a computer running it. Its sessions show as working, idle, failed or finished, and as needing you only while OpenCode 1.x asks you a question or to approve a plan. A wait for a tool's approval, and every wait of OpenCode 2's, shows as working, and nothing of OpenCode's is read on Windows.
- For Qwen Code, version 0.21.14 or later, which lists its running sessions where Agent Lookout reads them. Agent Lookout was built from Qwen Code's source at 0.28.3 and has not yet been checked on a machine running it. Only sessions in a terminal appear.
- For Hermes Agent, version 0.21.6 or later, on macOS or Linux, and the system's `sqlite3`, which macOS has, and which Ubuntu and Debian install with `sudo apt install sqlite3`. While Hermes Agent has commits in a database's `-wal`, that database is read only with a `sqlite3` of 3.51.3 or newer, or one of the few older ones Hermes Agent itself trusts: on a Mac, `brew install sqlite` gives one, and on Linux you can put one at `/usr/local/bin/sqlite3`. Agent Lookout was built from Hermes Agent's source at v0.23.3 and has not yet been checked on a computer running it. Its sessions show as working, idle, needing you, failed or finished, and nothing of Hermes Agent's is read on Windows.
- For Cline, its newer runtime, which its CLI and desktop app use and which keeps a session's files in `~/.cline/data/sessions`. Agent Lookout was built from Cline's source at cli-v3.0.75 and has not yet been checked on a computer running it. The older VS Code extension's tasks do not appear.
- For Goose, version 1.34.0 or later, on macOS or Linux, and the system's `sqlite3`, which macOS has, and which Ubuntu and Debian install with `sudo apt install sqlite3`. Agent Lookout was built from Goose's source at v1.60.2 and has not yet been checked on a computer running it. Its sessions show as unknown while a Goose program runs and as finished once none does, never as working, idle or needing you, and are named after their folder unless you named them.
- For Pi, nothing more, on macOS, Linux or Windows. Agent Lookout was built from Pi's source at v1.6.0 and has not yet been checked on a computer running it. Its sessions show as unknown while a `pi` program runs and as finished once none does, on Windows always as unknown, never as working, idle or needing you, and are named after their folder unless they were given a name.
- For Kimi Code, version 2.3.0 or later, whose sessions keep a lock while they are busy. An older one shows every session as finished or failed. Agent Lookout was built from Kimi Code's source at 2.7.2 and has not yet been checked on a computer running it. A session shows as idle only once Agent Lookout has seen its lock, which from 2.6.0 Kimi Code also takes for a few seconds after a process opens a session. It is named after its folder unless you or Kimi Code's model named it.
- For Continue, nothing more, on macOS, Linux or Windows. Agent Lookout needs no program of Continue's, and reads what its `cn` command and its VS Code and JetBrains extensions write to `~/.continue/sessions`. It was built from Continue's source at v1.5.45 and has not yet been checked on a computer running it, and no older version was read, so no oldest version is named. Its sessions always show as unknown, never as working, idle, needing you or finished, and are named after their folder.
- For Prime Agent, its `prime-agent` command, on macOS, Linux or Windows, and nothing more. Agent Lookout was built from Prime Agent's source at v0.10.3 and has not yet been checked on a computer running it. Its sessions show as working or idle from their workers' journals while a running `prime-agent` holds them, on macOS and Linux, or as unknown when a journal cannot say, and as finished once none does. On Windows a session that a process holds shows as unknown. A session never shows as needing you.
- For fx, its `fx` command, version 0.0.15 or later, which keeps every session in `~/.fx/sessions/v2`, on macOS or Linux. Agent Lookout was built from fx's source at v0.0.17 and has not yet been checked on a computer running it. Its sessions show as working while a turn is open and an fx program that could be writing it runs, for up to 30 minutes without a write, as failed when fx ends a turn as failed, and as finished once no such program runs, never as idle or needing you, and are named after their folder. Nothing of fx's is read on Windows.
- For Unreal Agent, its terminal app `unreal-agent-tui`, which Homebrew also links as `unreal-agent` and `uat`, or its runner `unreal-agent-runner`, version 0.2.0 or later, which keeps every session in `~/.local/state/unreal-agent/sessions`, or under `XDG_STATE_HOME` when that is an absolute path, on macOS or Linux. Agent Lookout was built from Unreal Agent's source at v0.3.1 and has not yet been checked on a computer running it. Its sessions show as working, idle, failed or finished from their files and from when each Unreal Agent program started, never as needing you, and are named after the folder their commands run in. Nothing of Unreal Agent's is read on Windows.
- For Autohand Code, its command `autohand`, version 0.9.3 or later, which writes a heartbeat for each running session in `~/.autohand/active-agents` and keeps each session in `~/.autohand/sessions`, or in the folder `AUTOHAND_HOME` names. Agent Lookout was built from Autohand Code's source at v0.9.11 and has not yet been checked on a computer running it. Its sessions show as working, idle or needing you from a fresh heartbeat, as finished or failed once they end, or as failed at once when one with no heartbeat crashed, and as unknown when their files cannot tell, as for a run with `--no-daemon` once it saves. A run with `--ephemeral` is left out.
- For DeepSeek Harness, `dsh`, its web page, its desktop app or a headless run, version 0.2.0 or later, which keeps each session's event log in `~/.dsh/sessions`, or in `sessions` in the folder `DSH_HOME` names. It compresses each log with Zstandard, which Agent Lookout reads only on Node.js 22.15 or later, or in the Mac app. Agent Lookout was built from DeepSeek Harness's source at dsh-v0.2.2-rc.3 and has not yet been checked on a computer running it. Its sessions show as working, needing you, idle or failed from their logs, as finished when DeepSeek Harness closed them mid-turn or no program that could write them runs, and as unknown when a log cannot tell, as after 30 quiet minutes in a turn of its own.
- For Droid, its `droid` command, on macOS, Linux or Windows, and nothing more. Agent Lookout was built from Factory's documentation and its Droid SDKs, droid-sdk 0.5.0 and @factory/droid-sdk 0.11.0, not from Droid's own program, and has not yet been checked on a computer running it, so no oldest version is named. Its sessions show as unknown while a `droid` program runs and as finished once `ps` finds none, 2 seconds or more after any session was last written, or at or after it when the clock was just set back, on Windows always as unknown, never as working, idle or needing you, and are named after their folder.
- For Grok Build, its command `grok`, on macOS, Linux or Windows, which lists the sessions its terminal app has open in `~/.grok/active_sessions.json`, or in the folder `GROK_HOME` names. Agent Lookout was built from Grok Build's source at 1.0.45, while released builds are at 1.0.89, and has not yet been checked on a computer running it, so no oldest version is named. Its sessions show as working, idle, failed, finished or needing you while it asks a question or waits for you to approve a plan, and as unknown when their event log cannot tell. A session an editor runs over ACP is not listed.
- For Oh My Pi, its command `omp`, on macOS, Linux or Windows, which keeps its sessions in `~/.omp/agent/sessions`, or in the folder its profiles, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_CONFIG_DIR` or `XDG_DATA_HOME` give. Agent Lookout was built from Oh My Pi's source at v19.0.0, with its approval lines read at v19.1.1, and has not yet been checked on a computer running it, so no oldest version is named. Its sessions show as finished or failed once Oh My Pi writes that it stopped, unless a later line shows it went on, and on macOS and Linux as working while a turn is open, as needing you while its `ask` tool or, from Oh My Pi 19.1.0, a tool's approval waits, but not one an editor asks for over ACP, and as finished once no `omp` that could have written it runs, and as unknown otherwise. On a Mac, an `omp` installed with `bun install -g` runs as `bun`, which `ps` cannot tell from any other `bun`, so its sessions do not show as working or needing you, and while any `bun` runs, a session Oh My Pi did not write that it stopped can show as unknown instead of finished.
- For Muse Code, Meta's command `muse`, on macOS, Linux or Windows, which keeps its sessions in `~/.local/share/muse/sessions`, or `muse/sessions` in `XDG_DATA_HOME`. Agent Lookout was built from Meta's documentation, its MIT-licensed Muse Code SDK and protocol schema at 1.4.24 and its cookbook, and from open-source readers of Muse Code's files, and has not yet been checked on a computer running it, so no oldest version is named. Its sessions show as failed or finished once Muse Code writes so, and on macOS and Linux as working, idle or needing you while a Muse Code that started no later than a minute after its newest status record runs, by `ps`. On Windows the folder is assumed, and a session shows as unknown unless Muse Code wrote that it failed or let it go.
- For Copilot CLI, GitHub's command `copilot`, on macOS, Linux or Windows, which keeps its sessions in `~/.copilot/session-state`, or in `session-state` in the folder `COPILOT_HOME` names. Agent Lookout was built from GitHub's docs, the MIT Copilot SDK v2.0.1 and open-source readers, never checked on a computer running Copilot CLI, so no oldest version is named. Its sessions show as working, idle, needing you for a permission prompt or an `ask_user` question, failed when Copilot writes that a session shut down on an error, and finished when it writes that it shut down or no process holds the session's lock. Sessions of Copilot's app and of VS Code's agent host, which use the same folder, show too.
- For Kiro CLI, its command `kiro-cli`, on macOS, Linux or Windows, which keeps its sessions in `~/.kiro/sessions`, or `sessions` in the folder `KIRO_HOME` names. Agent Lookout reads Kiro's V3 store, the default for chat from Kiro CLI 3.0.0, and its V2 store side by side. It was built from Kiro's documentation and open-source readers of its files, not from Kiro CLI's own program, and has not yet been checked on a computer running it, so no oldest version is named. Its sessions show as finished once their lock is gone or names a process that has ended, and while open as working or idle, and in V3 as needing you while Kiro waits for your approval or an answer. A V2 session waiting for your approval shows as working. Set `KIRO_HOME` where Agent Lookout starts too, not only in your shell's profile, or set `AGENT_LOOKOUT_KIRO_HOME`.
- For Crush, version 0.25.0 or later, which keeps the list of projects Agent Lookout reads, on macOS or Linux, and the system's `sqlite3`, which macOS has, and which Ubuntu and Debian install with `sudo apt install sqlite3`. Agent Lookout was built from Crush's source at v0.99.0 and has not yet been checked on a computer running it. Its sessions show as unknown while a Crush program runs and as finished once none does, never as working, idle or needing you, and each takes its folder's name. The sessions of the newest 20 projects are read, from `.crush` in each project's folder.
- For Kilo Code, its `kilo` command or its VS Code or JetBrains extension, in a version that keeps its sessions in `kilo.db`, as Kilo Code's changelog says it does from 7.0.26 on, on macOS or Linux, and the system's `sqlite3`, which macOS has, and which Ubuntu and Debian install with `sudo apt install sqlite3`. Agent Lookout was built from Kilo Code's source at v7.8.27 and has not yet been checked on a computer running it. Its sessions show as working, idle, failed or finished, and as needing you only while Kilo Code asks you a question. A pre-release or a build from source keeps its sessions in another file, which Agent Lookout reads when `KILO_DB` names it, and nothing of Kilo Code's is read on Windows.
- For MiMo Code, its `mimo` command, in a version whose database has the tables 0.1.17's has, on macOS or Linux, and the system's `sqlite3`, which macOS has, and which Ubuntu and Debian install with `sudo apt install sqlite3`. Agent Lookout was built from MiMo Code's source at v0.1.17 and has not yet been checked on a computer running it. Its sessions show as working, idle, failed or finished, and as needing you only while MiMo Code's main agent asks you a question or to approve a plan. A database laid out another way shows on its card as a version Agent Lookout does not read, and nothing of MiMo Code's is read on Windows.
- For Kimchi, its `kimchi` command, on macOS, Linux or Windows, and nothing more. Agent Lookout was built from Kimchi's source at v1.35.0 and has not yet been checked on a computer running it. Its sessions show as unknown while a `kimchi` program runs and as finished once none does, on Windows always as unknown, never as working, idle or needing you, and are named after their folder.

Check what you have:

```sh
node --version
claude --version
claude agents --help
codex --version
agy --version
gemini --version
qwen --version
hermes --version
cline --version
goose --version
pi --version
kimi --version
cn --version
crush --version
kilo --version
mimo --version
```

`node --version` prints `v22.12.0` or later. `claude --version` prints a version number followed by `(Claude Code)`, and `claude agents --help` prints a line that starts with `Usage: claude agents`. `codex --version` prints `codex-cli` followed by a version number, `agy --version` a version number such as `1.3.1`, `gemini --version` a version number such as `0.64.0`, `qwen --version` one such as `0.25.1`, and `hermes --version` a first line that starts with `Hermes Agent v` and a version such as `0.22.5`, and also checks for an update of itself, and `cline --version` a version number such as `3.0.75`, and, by default, as any start of Cline does, also checks for an update of itself, which it can install as it exits, and sends Cline's start-up telemetry, `goose --version` a version number such as `1.60.2`, `pi --version` a version number such as `1.6.0`, `kimi --version` one such as `2.7.2`, `cn --version` one such as `1.5.45`, `crush --version` a line that ends in one such as `0.99.0`, `kilo --version` one such as `7.8.27`, and `mimo --version` its version, such as `0.1.17`. A command for a program you do not use prints `command not found`: carry on. Agent Lookout never runs `codex`, `agy`, `gemini`, `qwen`, `hermes`, `cline`, `goose`, `pi`, `kimi`, `cn`, `crush`, `kilo` or `mimo`, so the Codex desktop app needs no CLI.

## With npx

### Start it

```sh
npx agent-lookout
```

The first time, npm names the package and asks `Ok to proceed? (y)`. Press Enter. npm downloads under 2 MB, about 4 MB once installed, and keeps it in its cache. The package holds the built dashboard and the collector as plain JavaScript, so it needs Node.js and nothing else. Then Agent Lookout prints:

```text
Agent Lookout is running at http://127.0.0.1:4777
It listens on this machine only. Press Ctrl+C to stop.
```

Open <http://127.0.0.1:4777>. Your sessions appear within a few seconds. If none do, see [No sessions appear](GUIDE.md#no-sessions-appear). It keeps running until you press Ctrl+C, so leave that terminal open. If you used `npm run dev` before, turn notifications on again here: the browser keeps them for each address.

| Option            | What it does                                                                                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port <number>` | Listens on this port in place of 4777, such as `--port 4778`. `AGENT_LOOKOUT_PORT` does the same, and `--port` wins when both are given                                                                               |
| `--open`          | Opens the address in your default browser once it is listening, with `open` on macOS, `xdg-open` on Linux or `rundll32.exe` on Windows. If that cannot be done, it prints one line with the address and keeps running |
| `--help`          | Prints the options of `agent-lookout`, `agent-lookout status` and `agent-lookout mcp`                                                                                                                                 |
| `--version`       | Prints the version of Agent Lookout and nothing else                                                                                                                                                                  |

`agent-lookout start` does the same as `agent-lookout`. Every setting under [Settings you can change](GUIDE.md#settings-you-can-change) works with it. It ends with 0 when you press Ctrl+C, and with 1 when it cannot start, such as when the port is in use. Under `npx agent-lookout`, the shell reports the interrupt instead, as exit code 130.

### Run it in the background

```sh
nohup npx --yes agent-lookout > agent-lookout.log 2>&1 &
```

`--yes` stops npm asking `Ok to proceed?`, since nothing would answer. What Agent Lookout prints goes to `agent-lookout.log`.

### Another port

If it prints `Port 4777 is already in use`, another program has that port. Choose another:

```sh
npx agent-lookout --port 4778
```

Use the new port in the address you open and in the check below. `agent-lookout status` and `agent-lookout mcp` then need `--url http://127.0.0.1:4778`, or `AGENT_LOOKOUT_URL` set to that address, as [In the terminal](GUIDE.md#in-the-terminal) says. [The port is in use](GUIDE.md#the-port-is-in-use) shows how to find which program holds a port.

### Check that it answers

If `npx agent-lookout` holds your terminal, use a second one:

```sh
curl -s http://127.0.0.1:4777/api/health
```

It prints `{"ok":true,"version":"…"}`, with the version you are running. If a step prints something else, [When something goes wrong](GUIDE.md#when-something-goes-wrong) says what to do for the common problems.

### Stop it

Press Ctrl+C in its terminal. If it runs in the background, find its process ID and end it. On macOS, or on Linux with `lsof` installed, `lsof -nP -iTCP:4777 -sTCP:LISTEN` shows the process ID under `PID`, and `kill` followed by that number stops it. On Windows, `netstat -ano | findstr :4777` shows the process ID in its last column, and `taskkill /F /PID` followed by that number stops it. Put your port in place of 4777 if you chose another.

### Update it

```sh
npx agent-lookout@latest
```

This also makes sure npx does not reuse an older copy it keeps. Each time npx starts it, npx asks npm's registry whether a newer version is out, as it does for any package it runs.

### Install it once

To start it without npx asking the registry each time, install it once and run it by name:

```sh
npm install -g agent-lookout
agent-lookout
```

`agent-lookout status` and `agent-lookout mcp` then start without npm asking its registry each time, which suits a tmux status line or a shell prompt that runs them every few seconds. Run `npm install -g agent-lookout` again to update it, and `npm uninstall -g agent-lookout` to take it away.

## Mac app

Download the disk image for your Mac from the [latest release](https://github.com/Olanetsoft/agent-lookout/releases/latest): `Agent-Lookout-<version>-mac-arm64.dmg` for Apple silicon, or `Agent-Lookout-<version>-mac-x64.dmg` for Intel. About This Mac, in the Apple menu, shows which you have: a chip such as Apple M1 is Apple silicon, and a processor named Intel is Intel. Open the disk image and drag Agent Lookout to Applications. Keep it there: the app updates itself only from a folder it can change. It needs macOS 13 Ventura or later, and no Node.js. On macOS 11 or 12, run it [with npx](#with-npx) instead.

The app is not yet signed with an Apple Developer ID, so the first time a downloaded copy is opened, macOS does not open it. Its message is titled “Agent Lookout” Not Opened and says that Apple could not verify “Agent Lookout” is free of malware. To open it anyway:

1. Press Done. Do not press Move to Bin, or Move to Trash, which deletes the app.
2. Open System Settings › Privacy & Security.
3. Under Security, next to the line that says Agent Lookout was blocked, press Open Anyway, and confirm with your password or Touch ID. The button is there for about an hour after macOS stopped the app. If it has gone, open the app again, press Done, and go back to Privacy & Security.

macOS remembers the choice.

Notifications are off until you turn them on in the app, and the app's setting is apart from a browser's. Until they are on, the Overview asks "Get a notification when a session needs you?" Press Turn on, and allow Agent Lookout to show notifications if macOS asks. After Not now it asks again about a day later, then 3 days later, then a week later. You can also turn them on later under Notifications in the app's Settings, where Send a test says whether macOS shows them. [Notifications in the Mac app](GUIDE.md#notifications-in-the-mac-app) has more.

The first time it opens, it installs Agent Lookout's Claude Code plugin, so Allow and Deny work from the page: [Claude Code plugin](#claude-code-plugin) says how to stop it, or undo it.

[Desktop app](GUIDE.md#desktop-app) says how the app behaves, [Menu bar](GUIDE.md#menu-bar) what its icon in the menu bar lists, and [Updates](GUIDE.md#updates) how it checks for a newer version and installs it.

### Build it yourself

From a clone, on a Mac:

```sh
npm install
npm run dist:mac
```

It takes a minute or two, and the first time it downloads Electron for each kind of Mac. It puts a disk image and a zip for each in `release/`, with the same names as on the release. Open the disk image for your Mac and drag Agent Lookout to Applications. A copy you built yourself on this Mac opens without the steps above.

### Mac app and npx together

The app opens no port, so `agent-lookout status`, `agent-lookout mcp` and a [tmux status line](GUIDE.md#in-a-tmux-status-line) cannot reach it. For those, run `npx agent-lookout` as well. The two keep their history in the same folder, so the Events log and the charts carry over, and their time rules and permission rules in the same settings file. Turn notifications on in only one of the two, or you get each one twice.

## Claude Code plugin

With Agent Lookout running, the plugin lets you answer a Claude Code permission prompt from the page, with Allow or Deny.

The [Mac app](#mac-app) installs it the first time it opens, when it finds Claude Code and the plugin is not installed, once and never again. It checks with Claude Code's own `claude plugin list`, and only when the plugin is not there runs the two commands below. The Overview says so, or gives the commands when it could not. A new Claude Code session picks it up. To keep it from happening, open the app the first time with `open -a "Agent Lookout" --env AGENT_LOOKOUT_PLUGIN_INSTALL=off`. A downloaded copy first opens through Open Anyway, which passes no setting, so there remove the plugin afterwards: run `claude plugin uninstall agent-lookout@agent-lookout`, and it stays removed.

With `npx agent-lookout`, or to do it yourself, in Claude Code, run:

```text
/plugin marketplace add Olanetsoft/agent-lookout
/plugin install agent-lookout@agent-lookout
```

From a shell, `claude plugin marketplace add Olanetsoft/agent-lookout` and `claude plugin install agent-lookout@agent-lookout` do the same. To remove it, run `/plugin uninstall agent-lookout@agent-lookout`, or `claude plugin uninstall agent-lookout@agent-lookout` from a shell. The hook needs `curl`, which macOS has, and most Linux systems do. On Windows the plugin does nothing, and Claude Code asks as usual. [plugins/agent-lookout/README.md](../plugins/agent-lookout/README.md) says what the hook does, and [Answer a permission prompt](GUIDE.md#answer-a-permission-prompt) what the page shows.

## From the repository

To run it from a clone, as you would to work on its code:

```sh
git clone https://github.com/Olanetsoft/agent-lookout.git
cd agent-lookout
npm install
npm run build
npm start
```

`npm start` prints the same two lines as `npx agent-lookout`, at the same address, and takes another port as `AGENT_LOOKOUT_PORT=4778 npm start`. Run before `npm run build`, it stops and tells you to build first. After a `git pull`, run `npm install` and `npm run build` again.

`npm link`, run once in the folder after `npm run build`, puts `agent-lookout` on your `PATH`, pointing at the clone, so it starts from any folder. It serves the same built page, so a pull needs the same `npm install` and `npm run build`.

`npm run dev` starts it at <http://localhost:5173> with the development tools used to work on its code, as [CONTRIBUTING.md](../CONTRIBUTING.md) describes.

## With your coding agent

A coding agent such as Claude Code or Codex can start it for you. Give it this prompt:

```text
Start Agent Lookout on this computer. First check that node --version
prints v22.12.0 or later. Then run npx --yes agent-lookout in the
background and leave it running.
It should print "Agent Lookout is running at http://127.0.0.1:4777".
If it prints anything else, or says the port is in use, stop and tell
me what it printed.

Do not use sudo, and do not set up email, a webhook, phone pushes,
pull requests or other machines. You are done when
curl -s http://127.0.0.1:4777/api/health prints {"ok":true and a
version number. Tell me what it printed.
```

An agent's background command can end when its session does. If the page then says Agent Lookout has stopped updating, run `npx agent-lookout` yourself.
