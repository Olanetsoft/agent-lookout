# Guide

## Requirements

- macOS. Agent Lookout is developed and tested there. Linux and Windows are untested.
- Node.js 20.19 or newer. On Node 22 it needs 22.12 or newer.
- Claude Code, Codex or both. Neither needs any setup.
- For Claude Code, a version that has the `claude agents` command. `claude agents --help` should print `Usage: claude agents`. Without that command Agent Lookout still reads the session files, but cannot list background jobs that have finished or failed.
- For Codex, version 0.155 or later, so that Agent Lookout can tell a session that has ended from one that is idle. A session started by an older Codex is never shown as finished.

## The screen

A rail down the left edge moves between three views: Overview, Sources and Settings. The mark at the top of the rail lights up while any session needs you, so you can see it from every view.

The header over each view says how many sessions are being watched and, in a wide window, when they were last checked. Click that line to open Sources. The switch on the right moves between the Night and Day themes.

### Overview

The Needs you panel at the top left holds the sessions that are waiting for you. For each one it gives the session's name, the reason, waiting for permission or asked you a question, and where it runs: the project folder, the app, and the agent once both Claude Code and Codex are found. When Claude Code's own words say more than the reason, hover over the reason or move to it with Tab to read them. The folder's full path is shown the same way. A timer says how long the session has waited, and a Claude Code session in VS Code has a Jump button that opens it there. With more than one waiting, the longest wait comes first and the others are listed under it.

When nothing needs you, the panel says Nothing needs you and shows the last wait that ended in the last hour: how long it lasted, the session, and when it was answered or ended. If none did, it says so.

Under that, a bar for each session that waited shows how long it waited on you, longest first. A wait that is still open is a filled amber bar that grows each second. A wait that was answered is an outlined bar. The bars reach back no further than the last hour, nor before Agent Lookout started, and the heading says from when. The line under them says how much of that time Agent Lookout did not measure.

The panel ends with four counts.

| Count    | What it counts                                                          |
| -------- | ----------------------------------------------------------------------- |
| Working  | Sessions busy with a task, and how long the longest has been busy       |
| Idle     | Sessions ready for a new prompt, and how long the longest has been idle |
| Stale    | Sessions idle for 24 hours or more without a break                      |
| Sessions | Every session found, split into open, finished and failed               |

Each session is counted once. A stale session is counted under Stale and not under Idle. A dash in place of a number means nothing could be counted, because no agent tool could be read yet. It does not mean zero.

Click Working or Idle to open a chart of how many sessions had that status over the last 15 minutes, hour or 6 hours. Click the panel's heading for the same chart of the sessions that needed you.

Last hour, beside the panel, has a bar for each five minutes of the last hour, on the clock's five-minute marks. Each bar shows how many sessions were waiting on you, working and idle in those five minutes, on average: waiting at the bottom, working above it, and idle as the empty part at the top. A wait still open is amber and a wait already answered is outlined. Hatched stretches were not measured, and five minutes with nothing measured have no bar. Point at a bar, or select the chart and press the arrow keys, to read its numbers. The line above the chart says how long sessions waited on you in all.

The Sessions list holds every other session, grouped in this order: Working, Idle, then sessions that finished or failed, then any whose status is unknown. Stale sessions are listed under Idle and counted beside it. The number by the list's title counts every session, including those in the Needs you panel. Each row gives:

- the session's name
- the agent it belongs to, Claude Code or Codex, once both are found on this computer
- its project folder
- the app it runs in: Terminal, VS Code or Desktop app
- its status, and how long it has had that status

When the list is too narrow for every column, the app is left out first and then the folder, so names keep their room. In a narrow window both are left out and the status moves under the name.

A Claude Code session in VS Code has a Jump button here too.

The Events log, beside the list, records each session appearing, changing status and ending, newest first. When a wait ends, it says how long the wait lasted if it saw the wait begin. When Agent Lookout measured nothing for a while in the last hour, such as while the computer was asleep, a row says when watching resumed and how long was not measured. While the log still holds everything since Agent Lookout started, it ends with Started watching.

The Timeline, under both, draws each session's status over the last hour. Hatched stretches are time Agent Lookout did not measure, such as the time before it started. The legend at the top of the card names each mark.

In a narrower window the Overview is one column, with the Needs you panel first.

If Agent Lookout stops while the page is open, the page keeps the last thing it saw and shows a notice that says how old it is. Its timers stop at the last moment it heard from Agent Lookout. It keeps trying, and catches up once Agent Lookout is running again.

### Sources

Sources has a card for Claude Code and one for Codex. Each says whether the tool was found: Watching, Searching, Not found or Not working. Under that, a short note says how sessions are being read right now, then a row for each thing Agent Lookout reads and runs.

For Claude Code:

- Registry folder: the folder of session files it reads, normally `~/.claude/sessions`
- Registry read: how often it reads that folder
- Command: the Claude Code command it runs to list sessions
- Command run: how often it runs that command, or "not run"

For Codex:

- Sessions folder: where Codex saves its sessions, normally `~/.codex/sessions`
- Read: how often it reads them
- Open-sessions folder: where Codex marks the sessions it has open, normally `~/.codex/thread-writer-locks`
- Names file: where Codex keeps the names you give sessions, normally `~/.codex/session_index.jsonl`

Both end with Sessions found and Last checked.

When Codex is found, its card also says that Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working. When it cannot tell a session that has ended from one that is idle, as with sessions started by a Codex older than 0.155, it says that too.

When a tool is not on this computer, its card says Not found, and after the first few seconds the Overview does not mention it, unless neither tool is found.

### Settings

Settings chooses the theme: Night, which is the default, Day, or System, which follows your computer's setting. It also shows the version you are running.

## What it does not do yet

It cannot stop, resume or answer a session, and it sends no notifications. It covers Claude Code and Codex, and only sessions on this computer. Cloud sessions, Codex cloud tasks and browser chats do not appear.

A Codex session never shows as needing you. Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working. A Codex session also appears only once its first prompt is sent, because Codex creates its file then. Past sessions the Codex desktop app imports from another agent appear only once you use them in Codex. A session from the Codex desktop app is named after its folder, because the app does not keep the titles it shows in the names file Agent Lookout reads.

A Claude Code background job is shown as finished or failed, and its row stays for 24 hours. A Codex session is shown as finished once no Codex program has it open, and its row stays until 24 hours after Codex last wrote to it. Any other session that ends leaves the list. The Events log records that it ended, without saying whether it finished or failed.

Codex sessions, and Claude Code sessions in a terminal or the desktop app, have no Jump button. For a VS Code session, Jump finds the session only when its folder is open in the VS Code window that has focus. Otherwise VS Code starts a new conversation.

The Events log, the charts and the Timeline are kept in memory. They start empty each time Agent Lookout starts.

## Settings you can change

Put a setting in front of the command that starts Agent Lookout:

```sh
AGENT_LOOKOUT_CLAUDE_FEED=off npm run dev
```

| Setting                     | What it does                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_LOOKOUT_PORT`        | The port `npm start` uses. The default is 4777.                                                                                                                    |
| `AGENT_LOOKOUT_HOST`        | The address `npm start` uses: `127.0.0.1`, which is the default, `localhost` or `::1`. Anything else is refused, so other computers cannot reach it.               |
| `AGENT_LOOKOUT_CLAUDE_BIN`  | The full path of the `claude` program. When set, it is the only place Agent Lookout looks.                                                                         |
| `AGENT_LOOKOUT_CLAUDE_HOME` | A folder to read in place of `~/.claude`. When set, the `claude` command is not run unless `AGENT_LOOKOUT_CLAUDE_BIN` is set too.                                  |
| `AGENT_LOOKOUT_CLAUDE_FEED` | Set to `off` and Agent Lookout never runs the `claude` command. Sessions come from the session files alone, and finished or failed background jobs are not listed. |
| `AGENT_LOOKOUT_CODEX_HOME`  | A folder to read in place of the Codex folder. A folder with no `sessions` folder in it shows no Codex sessions.                                                   |
| `CODEX_HOME`                | Codex's own setting for where it keeps its files. When it is set, Agent Lookout reads that folder too, unless `AGENT_LOOKOUT_CODEX_HOME` is set.                   |

To see the empty screen, set both `AGENT_LOOKOUT_CLAUDE_HOME` and `AGENT_LOOKOUT_CODEX_HOME` to an empty folder. With only the first set, Codex sessions still appear.

The Claude Code and Codex settings work with `npm run dev` and `npm start`. The port and address settings apply to `npm start` only. To choose the port for `npm run dev`, pass it after `--`:

```sh
npm run dev -- --port 5180
```

One more variable, `AGENT_LOOKOUT_CHECK_REAL_CLAUDE`, is read only by the tests, as CONTRIBUTING.md describes.

## Run the built version

`npm run dev` runs Agent Lookout with its development tools. To run it from built files instead:

```sh
npm run build
npm start
```

`npm start` prints `Agent Lookout is running at http://127.0.0.1:4777`. Open that address. To check it from a terminal:

```sh
curl -s http://127.0.0.1:4777/api/health
```

It prints `{"ok":true,"version":"0.1.0"}`, or a later version number. If you run `npm start` before `npm run build`, it stops and tells you to build first. After you pull new code, run `npm run build` again.

## When something goes wrong

### The port is in use

`npm run dev` moves to the next free number and prints the address it chose. To pick one yourself, run `npm run dev -- --port 5180`.

`npm start` stops with `Port 4777 is already in use`. Choose another port:

```sh
AGENT_LOOKOUT_PORT=4778 npm start
```

To see which program holds a port on macOS:

```sh
lsof -nP -iTCP:4777 -sTCP:LISTEN
```

### No sessions appear

1. Start a session and wait a few seconds. For Claude Code, run `claude` in a terminal. For Codex, run `codex` and send a prompt: a Codex session appears once its first prompt is sent.
2. Open Sources. It says whether Claude Code and Codex were found and where Agent Lookout looked.
3. If the list says "No agents are running", Agent Lookout is working and sees no session on this computer. Sessions in the cloud or in a browser tab do not appear.
4. If it says Claude Code was not found, check that `claude --version` works in a terminal. If `claude` is installed somewhere unusual, set `AGENT_LOOKOUT_CLAUDE_BIN` to its full path.
5. If it says Codex was not found, check that the folder it names exists. If you keep Codex's files elsewhere with `CODEX_HOME`, set it in the terminal that starts Agent Lookout too.
6. Check that `AGENT_LOOKOUT_CLAUDE_HOME` and `AGENT_LOOKOUT_CODEX_HOME` are not set in your shell. When one is, Agent Lookout reads only that folder for that tool.

To see what Agent Lookout sees without opening a browser:

```sh
curl -s http://localhost:5173/api/sessions
```

Use port 4777 if you started it with `npm start`. It prints the sessions it found and, under `sources`, whether Claude Code and Codex could be read. The output holds your session names and folder paths, so check it before you share it.

### The page says Agent Lookout has stopped updating

The program serving the page has stopped. Start it again with `npm run dev` or `npm start`, and the page catches up on its own.

## How it finds sessions

Claude Code keeps one small file for each running session in `~/.claude/sessions/`. Every 2 seconds Agent Lookout reads those files. That starts no program and uses no network.

When it starts, and every 30 seconds after that, it runs `claude agents --json --all`, the command Claude Code [documents](https://code.claude.com/docs/en/agent-view) for listing its sessions. That answer decides which sessions exist, and it adds background jobs that have finished or failed. If the files and the command disagree, or the files cannot be read, it runs the command every 5 seconds until they agree. If the command cannot be found or fails, it uses the files alone.

A file can outlive a session that crashed. Agent Lookout checks that each session's process still exists, and runs `ps` to make sure the process is the same one the file describes.

It looks for the `claude` program on your `PATH`, then at `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and `/usr/local/bin/claude`.

It never writes to `~/.claude`. It never opens your Claude Code transcripts, your settings or the `.key` files beside the session files.

Codex keeps each session in a file under `~/.codex/sessions/`, in a folder for the day it began. Every 2 seconds Agent Lookout checks the files for today and yesterday, reads what Codex has added to them, and finds the last line that says a turn started or ended: a turn under way is Working, and a finished one is Idle. It also lists `~/.codex/thread-writer-locks/`, where Codex marks the sessions it has open, so that a session no Codex program has open shows as Finished. It reads `~/.codex/session_index.jsonl` for the names you give sessions. Codex documents none of these files, so a new Codex version can change them; [adapters/codex.md](adapters/codex.md) records what was checked. It runs no Codex program and changes no Codex setting.

Codex's session files are its transcripts. Agent Lookout opens them only to read each session's details, such as its folder, and when each turn started and ended, and keeps nothing from the conversation. It never writes to `~/.codex`. [PRIVACY.md](../PRIVACY.md) lists exactly what it reads and runs, and what the tools it runs on write to disk.

## For contributors

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the parts fit together, and [CONTRIBUTING.md](../CONTRIBUTING.md) covers setup and the checks to run.
