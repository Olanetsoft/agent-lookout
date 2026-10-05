# Guide

## Requirements

- macOS. Agent Lookout is developed and tested there. Linux and Windows are untested.
- Node.js 20.19 or newer. On Node 22 it needs 22.12 or newer.
- Claude Code, Codex or both. Neither needs any setup.
- For Claude Code, a version that has the `claude agents` command. `claude agents --help` should print `Usage: claude agents`. Without that command Agent Lookout still reads the session files, but cannot list background jobs that have finished or failed.
- For Codex, version 0.155 or later, so that Agent Lookout can tell a session that has ended from one that is idle.

The [README](../README.md#install) has the steps to install and start it.

## The screen

![The Overview in the Night theme with one session waiting. A rail on the left links to Overview, Sources and Settings. The header says 8 sessions are watched from Claude Code and Codex. The Needs you panel shows a session that has waited just over 4 minutes for permission, with a Jump button, two bars of how long sessions waited on you, and counts of working, idle and stale sessions. The Last hour chart is beside it. Below are the Sessions list, the Events log and the Timeline.](images/dashboard-night.png)

A rail down the left edge moves between three views: Overview, Sources and Settings. The mark at the top of the rail lights up while any session needs you, so you can see it from every view. The browser tab's title gives the number that need you, as in `(2) Agent Lookout`.

The header over each view says how many sessions are being watched and, in a wide window, when they were last checked. Click that line to open Sources. The switch on the right moves between the Night and Day themes.

### Overview

The Overview has five parts. The Needs you panel and the Last hour chart share the top row, the Sessions list and the Events log share the next, and the Timeline runs under both. In a narrower window they are one column in that order.

#### Needs you

The Needs you panel holds the sessions that are waiting for you. For each one it gives the session's name, the reason, and where it runs: the project folder, the app, and the agent once both Claude Code and Codex are found. The reason is waiting for permission, asked you a question or, for anything else, waiting for you. When Claude Code's own words say more than the reason, hover over the reason or move to it with Tab to read them. The folder's full path is shown the same way. A timer says how long the session has waited, and a Claude Code session in VS Code has a Jump button that opens it there. With more than one waiting, the longest wait comes first and the others are listed under it.

Under the sessions, Waited on you has a bar for each session that waited, longest first. A wait that is still open is a filled amber bar that grows each second. A wait that was answered is an outlined bar. The bars reach back no further than the last hour, nor before Agent Lookout started, and the heading says from when. The line under them says how much of that time Agent Lookout did not measure. When no session waited in that time, the bars are left out.

The panel ends with four counts.

| Count    | What it counts                                                          |
| -------- | ----------------------------------------------------------------------- |
| Working  | Sessions busy with a task, and how long the longest has been busy       |
| Idle     | Sessions ready for a new prompt, and how long the longest has been idle |
| Stale    | Sessions idle for 24 hours or more without a break                      |
| Sessions | Every session found, split into open, finished and failed               |

Each session is counted once. A stale session is counted under Stale and not under Idle. A dash in place of a number means nothing could be counted, because no agent could be read yet. It does not mean zero.

Click Working or Idle to open a chart of how many sessions had that status over the last 15 minutes, hour or 6 hours. Click the panel's heading for the same chart of the sessions that needed you.

When nothing needs you, the panel says Nothing needs you and shows the last wait that ended in the last hour: how long it lasted, the session, and when it was answered or ended. If none did, it says so. The bars of earlier waits and the counts stay under it.

![The top of the Overview with nothing waiting. The panel says Nothing needs you and gives the last wait, 3 minutes 30 seconds, and when it was answered. Its two bars of earlier waits are outlined, and the Last hour chart beside it has no amber.](images/quiet-night.png)

#### Last hour

The Last hour chart has a bar for each five minutes of the last hour, on the clock's five-minute marks. Each bar shows how many sessions were waiting on you, working and idle in those five minutes, on average: waiting at the bottom, working above it, and idle as the empty part at the top. A wait still open is amber and a wait already answered is outlined. Hatched stretches were not measured, and five minutes with nothing measured have no bar. Point at a bar, or select the chart and press the arrow keys, to read its numbers. The line above the chart says how long sessions waited on you in all.

#### Sessions

The Sessions list holds every session that is not waiting for you, grouped in this order: Working, Idle, then sessions that finished or failed, then any whose status is unknown. Stale sessions are listed under Idle and counted beside it. The number by the list's title counts every session, including those in the Needs you panel. Each row gives:

- the session's name
- the agent it belongs to, Claude Code or Codex, once both are found on this computer
- its project folder
- the app it runs in: Terminal, VS Code or Desktop app
- its status, and how long it has had that status

When the list is too narrow for every column, the app is left out first and then the folder, so names keep their room. In a narrow window both are left out and the status moves under the name.

A Claude Code session in VS Code has a Jump button here too.

#### Events

The Events log records each session appearing, changing status and ending, newest first. When a wait ends, it says how long the wait lasted if it saw the wait begin. When Agent Lookout measured nothing for a while in the last hour, such as while the computer was asleep, a row says when watching resumed and how long was not measured. While the log still holds everything since Agent Lookout started, it ends with Started watching.

#### Timeline

The Timeline draws each session's status over the last hour, one row for each session. Hatched stretches are time Agent Lookout did not measure, such as the time before it started. The legend at the top of the card names each mark.

### Sources

![The Sources view in the Night theme. A card for Claude Code and a card for Codex, each marked Watching, list what Agent Lookout reads and runs and how often, how many sessions it found and when it last checked. A third card, About sources, says what a source is.](images/sources-night.png)

Sources has a card for Claude Code and one for Codex. Each says whether the agent was found: Watching, Searching, Not found or Not working. Under that, a short note says how its sessions are being read right now, then rows give what Agent Lookout reads and runs.

For Claude Code the rows give the folder of session files it reads, normally `~/.claude/sessions`, how often it reads that folder, the Claude Code command it runs to list sessions, and how often it runs it, or "not run". For Codex they give the folder where Codex saves its sessions, normally `~/.codex/sessions`, how often it reads them, the folder where Codex marks the sessions it has open, normally `~/.codex/thread-writer-locks`, and the file where Codex keeps the names you give sessions, normally `~/.codex/session_index.jsonl`. Both cards end with Sessions found and Last checked.

The note on Codex's card also gives the limits of what Codex's files can show, which are described under [What it does not do yet](#what-it-does-not-do-yet).

When an agent is not on this computer, its card says Not found, and after the first few seconds the Overview does not mention it, unless neither is found.

### Settings

Settings has three cards. Theme chooses Night, which is the default, Day, or System, which follows your computer's setting. Notifications turns notifications on and off. This copy shows the version you are running.

#### Notifications

With notifications on, your browser shows a system notification each time a Claude Code session starts waiting for you. Its title is the session's name. Its text is the reason, in the words the Needs you panel uses: Waiting for permission, Asked you a question or Waiting for you. It appears within a few seconds, whether or not the dashboard is in view, and is cleared when the session stops waiting. Clicking it brings the dashboard forward. It does not open the session.

Notifications are off until you turn them on. The card says "Notifications are off." beside a button, Turn on notifications. Press it and your browser asks whether this address may show notifications. Agent Lookout asks only when you press that button, never when a page loads. Once you allow it, the card says "Notifications are on." and the button reads Turn off notifications. If the browser already allows notifications from this address, they turn on without a question.

If you refuse, the card shows Notifications are blocked and they stay off. Allow notifications for this address in the browser's site settings, then press the button again. In a browser with no way to show them, the card says This browser cannot show notifications and has no button.

Nothing is sent for a session that was already waiting when you opened or reloaded the page, when you turned notifications on, or when Agent Lookout started. Each wait that begins after that sends one notification, and a session that is answered and later waits again sends another. A Codex session never sends one, because a Codex session never shows as needing you.

The dashboard page makes each notification, so a dashboard tab has to stay open and Agent Lookout has to keep running. Closing or reloading the page clears the notifications it showed, and a wait that is still open is not announced again. If Agent Lookout stops while a notification is showing, or can no longer read Claude Code's sessions (Sources then shows Claude Code as Not found or Not working), the page cannot tell when the session moves on. The notification then stays until you clear it, close the page, turn notifications off, or start Agent Lookout again and it finds the session no longer waiting.

Your choice and the browser's permission belong to one browser at one address. `http://localhost:5173` and `http://127.0.0.1:4777` are different addresses, so notifications turned on at one are still off at the other. Two tabs at the same address share one notification for a wait. When you close one of them, the other shows the notification again, so it can appear a second time. With notifications on at two addresses, or in two browsers, each sends its own.

Notifications have been checked in Chrome 154 on macOS. There one arrived within a few seconds of a session starting to wait, with the tab in view and with it hidden for more than six minutes. Safari and Firefox have not been checked. A browser that puts a background tab to sleep, or unloads it to save memory, can delay notifications or stop them until you open the tab again.

A notification shows the session's name outside the dashboard: over other apps, in Notification Centre and, depending on your Mac's settings, on the lock screen and while you share or record the screen. To keep names off those, open Notifications in System Settings and change what your browser's notifications may show, or leave notifications off.

The browser gives its permission to the address, not to Agent Lookout. Another program you later serve at the same address, such as another project's dev server on `localhost:5173`, can show notifications without asking. To take the permission back, remove it for that address in the browser's site settings. `npm start` serves Agent Lookout at `127.0.0.1:4777`, an address other tools are less likely to use. [PRIVACY.md](../PRIVACY.md#notifications) says what a notification holds and where it is kept.

## What it does not do yet

It cannot stop, resume or answer a session. It covers Claude Code and Codex, and only sessions on this computer. Cloud sessions, Codex cloud tasks and browser chats do not appear.

A notification is sent only when a Claude Code session starts waiting, and only while the dashboard is open in a browser tab. Nothing is sent when a session finishes or fails.

A Codex session never shows as needing you. Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working. A Codex session also appears only once its first prompt is sent, because Codex creates its file then. Past sessions the Codex desktop app imports from another agent appear only once you use them in Codex. A session from the Codex desktop app is named after its folder, because the app does not keep the titles it shows in the names file Agent Lookout reads.

A Claude Code background job is shown as finished or failed, and its row stays for 24 hours. A Codex session is shown as finished once no Codex program has it open, and its row stays until 24 hours after Codex last wrote to it. A session started by a Codex older than 0.155 is never shown as finished. Any other session that ends leaves the list. The Events log records that it ended, without saying whether it finished or failed.

Codex sessions, and Claude Code sessions in a terminal or the desktop app, have no Jump button. For a VS Code session, Jump finds the session only when its folder is open in the VS Code window that has focus. Otherwise VS Code starts a new conversation.

The Events log, the charts and the Timeline are kept in memory. They start empty each time Agent Lookout starts.

The [milestones](https://github.com/Olanetsoft/agent-lookout/milestones) list what is planned.

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
2. If the Sessions list says "No agents are running", Agent Lookout is working and sees no session on this computer. Sessions in the cloud or in a browser tab do not appear.
3. Open Sources. It says whether Claude Code and Codex were found and where Agent Lookout looked.
4. If Claude Code's card says Not found, or says the `claude` command was not found, check that `claude --version` works in a terminal. If `claude` is installed somewhere unusual, set `AGENT_LOOKOUT_CLAUDE_BIN` to its full path.
5. If Codex's card says Not found, check that the folder it names exists. If you keep Codex's files elsewhere with `CODEX_HOME`, set it in the terminal that starts Agent Lookout too.
6. Check that `AGENT_LOOKOUT_CLAUDE_HOME` and `AGENT_LOOKOUT_CODEX_HOME` are not set in your shell. When one is, Agent Lookout reads only that folder for that agent.

To see what Agent Lookout sees without opening a browser:

```sh
curl -s http://localhost:5173/api/sessions
```

Use port 4777 if you started it with `npm start`. It prints the sessions it found and, under `sources`, whether Claude Code and Codex could be read. The output holds your session names and folder paths, so check it before you share it.

### No notification appears

1. Open Settings in the same browser, at the same address, where you turned notifications on. If the card says "Notifications are off.", press Turn on notifications. If it shows Notifications are blocked, allow notifications for this address in the browser's site settings first.
2. If the card says "Notifications are on.", your browser is allowed to show them, and macOS may be holding them back. The card reads the browser's permission and cannot see the system's. Open System Settings, then Notifications, choose your browser and check that Allow notifications is on.
3. Check Focus. While a Focus such as Do Not Disturb is on, notifications go to Notification Centre without appearing on screen.
4. Check that a dashboard tab is still open and that the page does not say Agent Lookout has stopped updating.
5. A session that was already waiting when you opened the page sends nothing. Wait for the next one, or check the Needs you panel.

### The page says Agent Lookout has stopped updating

The program serving the page has stopped. The page keeps the last thing it saw, under a notice that says how old it is, and its timers stop at the last moment it heard from Agent Lookout. Start it again with `npm run dev` or `npm start`, and the page catches up on its own.

## How it finds sessions

For Claude Code, Agent Lookout reads the small file Claude Code keeps for each running session in `~/.claude/sessions/`, every 2 seconds. That starts no program and uses no network. When it starts, and every 30 seconds after that, it also runs `claude agents --json --all`, the command Claude Code [documents](https://code.claude.com/docs/en/agent-view) for listing its sessions. That answer decides which sessions exist, and it adds background jobs that have finished or failed. If the command cannot be found or fails, Agent Lookout uses the files alone.

For Codex it runs nothing. Every 2 seconds it reads what Codex has added to the session files under `~/.codex/sessions/` and finds the last line that says a turn started or ended: a session with a turn under way is working, and one whose last turn ended is idle. A session that no Codex program has open is finished. Those files hold your conversations with Codex. Agent Lookout keeps only when each turn started and ended and a few details, such as the session's folder. Codex documents none of these files, so a new Codex version can change them.

Agent Lookout never writes to `~/.claude` or `~/.codex`. [PRIVACY.md](../PRIVACY.md) lists every file it reads and every command it runs, and what it keeps from each. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the files and the command are checked against each other.

## For contributors

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the parts fit together, and [CONTRIBUTING.md](../CONTRIBUTING.md) covers setup and the checks to run.
