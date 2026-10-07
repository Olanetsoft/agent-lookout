# Install

Agent Lookout runs with npx, as a Mac app, or from a clone of the repository. The Claude Code plugin adds Allow and Deny to any of them. [The README](../README.md) says what it does.

## Requirements

- macOS, Linux or Windows. Agent Lookout is developed and used on macOS. On Linux and Windows, CI runs the tests and starts it, and no one has used it on those desktops yet. [On Linux](GUIDE.md#on-linux) and [On Windows](GUIDE.md#on-windows) say what differs there.
- Node.js 22.12 or newer. The [Mac app](#mac-app) needs no Node.js.
- Claude Code, Codex or both. Neither needs any setup. Any other agent can appear too, by writing a [status file](GUIDE.md#your-own-agents).
- For Claude Code, a version that has the `claude agents` command. Without it, Agent Lookout still reads the session files, but cannot list background jobs that have finished or failed.
- For Codex, version 0.155 or later, so that Agent Lookout can tell a session that has ended from one that is idle.

Check what you have:

```sh
node --version
claude --version
claude agents --help
codex --version
```

`node --version` prints `v22.12.0` or later. `claude --version` prints a version number followed by `(Claude Code)`, and `claude agents --help` prints a line that starts with `Usage: claude agents`. `codex --version` prints `codex-cli` followed by a version number. A command for a program you do not use prints `command not found`: carry on. Agent Lookout never runs `codex`, so the Codex desktop app needs no CLI.

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

Download the disk image for your Mac from the [latest release](https://github.com/Olanetsoft/agent-lookout/releases/latest): `Agent-Lookout-<version>-mac-arm64.dmg` for Apple silicon, or `Agent-Lookout-<version>-mac-x64.dmg` for Intel. About This Mac, in the Apple menu, shows which you have: a chip such as Apple M1 is Apple silicon, and a processor named Intel is Intel. Open the disk image and drag Agent Lookout to Applications. Keep it there: the app updates itself only from a folder it can change. It needs no Node.js.

The app is not yet signed with an Apple Developer ID, so the first time a downloaded copy is opened, macOS does not open it. Its message is titled “Agent Lookout” Not Opened and says that Apple could not verify “Agent Lookout” is free of malware. To open it anyway:

1. Press Done. Do not press Move to Bin, or Move to Trash, which deletes the app.
2. Open System Settings › Privacy & Security.
3. Under Security, next to the line that says Agent Lookout was blocked, press Open Anyway, and confirm with your password or Touch ID. The button is there for about an hour after macOS stopped the app. If it has gone, open the app again, press Done, and go back to Privacy & Security.

macOS remembers the choice. [Desktop app](GUIDE.md#desktop-app) says how the app behaves, [Menu bar](GUIDE.md#menu-bar) what its icon in the menu bar lists, and [Updates](GUIDE.md#updates) how it checks for a newer version and installs it.

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

With Agent Lookout running, the plugin lets you answer a Claude Code permission prompt from the page, with Allow or Deny. In Claude Code, run:

```text
/plugin marketplace add Olanetsoft/agent-lookout
/plugin install agent-lookout@agent-lookout
```

From a shell, `claude plugin marketplace add Olanetsoft/agent-lookout` and `claude plugin install agent-lookout@agent-lookout` do the same. To remove it, run `/plugin uninstall agent-lookout@agent-lookout`. The hook needs `curl`, which macOS has, and most Linux systems do. On Windows the plugin does nothing, and Claude Code asks as usual. [plugins/agent-lookout/README.md](../plugins/agent-lookout/README.md) says what the hook does, and [Answer a permission prompt](GUIDE.md#answer-a-permission-prompt) what the page shows.

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

Do not use sudo, and do not set up email, a webhook, pull requests
or other machines. You are done when
curl -s http://127.0.0.1:4777/api/health prints {"ok":true and a
version number. Tell me what it printed.
```

An agent's background command can end when its session does. If the page then says Agent Lookout has stopped updating, run `npx agent-lookout` yourself.
