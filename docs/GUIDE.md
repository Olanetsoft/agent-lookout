# Guide

## Requirements

- macOS. Agent Lookout is developed and tested there. Linux and Windows are untested.
- Node.js 20.19 or newer. On Node 22 it needs 22.12 or newer.
- Claude Code, Codex or both. Neither needs any setup. Any other agent can appear too, by writing a status file: see [Your own agents](#your-own-agents).
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

The Needs you panel holds the sessions that are waiting for you. For each one it gives the session's name, the reason, and where it runs: the project folder, the app, and the agent once more than one is found. The reason is waiting for permission, asked you a question or, for anything else, waiting for you. When Claude Code's own words say more than the reason, hover over the reason or move to it with Tab to read them. The folder's full path is shown the same way. A timer says how long the session has waited, and a Claude Code session that runs in VS Code or inside tmux has a Jump button. [Jump](#jump) says what it does for each. With more than one waiting, the longest wait comes first and the others are listed under it.

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
- the agent it belongs to, such as Claude Code, Codex or the name a [status file](#your-own-agents) gives, once there is more than one
- its project folder
- the app it runs in: Terminal, VS Code or Desktop app
- its status, and how long it has had that status

When the list is too narrow for every column, the app is left out first and then the folder, so names keep their room. In a narrow window both are left out and the status moves under the name.

A Claude Code session in VS Code or inside tmux has a Jump button here too.

#### Events

The Events log records each session appearing, changing status and ending, newest first. When a wait ends, it says how long the wait lasted if it saw the wait begin. When Agent Lookout measured nothing for a while in the last hour, such as while the computer was asleep, a row says when watching resumed and how long was not measured. While the log still holds everything since Agent Lookout started, it ends with Started watching.

#### Timeline

The Timeline draws each session's status over the last hour, one row for each session. Hatched stretches are time Agent Lookout did not measure, such as the time before it started. The legend at the top of the card names each mark.

### Sources

![The Sources view in the Night theme. A card for Claude Code and a card for Codex, each marked Watching, list what Agent Lookout reads and runs and how often, how many sessions it found and when it last checked. A third card, About sources, says what a source is.](images/sources-night.png)

Sources has a card for Claude Code, one for Codex and one for status files. Each says whether the agent was found: Watching, Searching, Not found or Not working. Under that, a short note says how its sessions are being read right now, then rows give what Agent Lookout reads and runs.

For Claude Code the rows give the folder of session files it reads, normally `~/.claude/sessions`, how often it reads that folder, the Claude Code command it runs to list sessions, and how often it runs it, or "not run". For Codex they give the folder where Codex saves its sessions, normally `~/.codex/sessions`, how often it reads them, the folder where Codex marks the sessions it has open, normally `~/.codex/thread-writer-locks`, and the file where Codex keeps the names you give sessions, normally `~/.codex/session_index.jsonl`. Both cards end with Sessions found and Last checked.

The note on Codex's card also gives the limits of what Codex's files can show, which are described under [What it does not do yet](#what-it-does-not-do-yet).

The card for status files gives the folder it reads, normally `~/.agent-lookout/sessions`, how often it reads it, and how many files it read and skipped. Until that folder exists, the card says Not set up, with one sentence on how to start, and nothing else on the screen mentions it. [Your own agents](#your-own-agents) has the rest.

When an agent is not on this computer, its card says Not found, and after the first few seconds the Overview does not mention it, unless neither is found.

### Settings

Settings has three cards. Theme chooses Night, which is the default, Day, or System, which follows your computer's setting. Notifications turns notifications on and off, for the dashboard page and for Agent Lookout itself. This copy shows the version you are running.

#### Notifications

With notifications on, your browser shows a system notification each time a Claude Code session, or a session from a [status file](#your-own-agents), starts waiting for you. Its title is the session's name. Its text is the reason, in the words the Needs you panel uses: Waiting for permission, Asked you a question or Waiting for you. It appears within a few seconds, whether or not the dashboard is in view, and is cleared when the session stops waiting. Clicking it brings the dashboard forward. It does not open the session.

Notifications are off until you turn them on. The card says "Notifications are off." beside a button, Turn on notifications. Press it and your browser asks whether this address may show notifications. Agent Lookout asks only when you press that button, never when a page loads. Once you allow it, the card says "Notifications are on." and the button reads Turn off notifications. If the browser already allows notifications from this address, they turn on without a question.

If you refuse, the card shows Notifications are blocked and they stay off. Allow notifications for this address in the browser's site settings, then press the button again. In a browser with no way to show them, the card says This browser cannot show notifications and has no button.

Nothing is sent for a session that was already waiting when you opened or reloaded the page, when you turned notifications on, or when Agent Lookout started. Each wait that begins after that sends one notification, and a session that is answered and later waits again sends another. A Codex session never sends one, because a Codex session never shows as needing you.

While a dashboard tab is open, the page makes each notification. Closing or reloading the page clears the notifications it showed, and a wait that is still open is not announced again. If Agent Lookout stops while a notification is showing, or can no longer read Claude Code's sessions (Sources then shows Claude Code as Not found or Not working), the page cannot tell when the session moves on. The notification then stays until you clear it, close the page, turn notifications off, or start Agent Lookout again and it finds the session no longer waiting.

Your choice and the browser's permission belong to one browser at one address. `http://localhost:5173` and `http://127.0.0.1:4777` are different addresses, so notifications turned on at one are still off at the other. Two tabs at the same address share one notification for a wait. When you close one of them, the other shows the notification again, so it can appear a second time. With notifications on at two addresses, or in two browsers, each sends its own.

With no dashboard tab open, Agent Lookout shows the notification itself, on a Mac. It checks the sessions every 2 seconds for as long as it runs, with a page open or not. When a wait begins and no page is there to show it, Agent Lookout runs `osascript`, a program that is part of macOS, to show a notification with the same title and text. Nothing is sent anywhere for this.

The button in Settings covers these too. Every request a dashboard page makes tells Agent Lookout whether that page has notifications on, and Agent Lookout goes by the last thing a page said. Turn notifications off in Settings and Agent Lookout's own are off within a couple of seconds. If pages that are open at once disagree, it goes by whichever asked last. It keeps what it was told in memory only. Each time Agent Lookout starts, its own notifications are off until a dashboard page that has notifications on has been open once.

To have them from the moment it starts, without opening the dashboard, start Agent Lookout with `AGENT_LOOKOUT_NOTIFICATIONS=on`:

```sh
AGENT_LOOKOUT_NOTIFICATIONS=on npm start
```

A dashboard page still has the last word. Opening one that has notifications off turns Agent Lookout's own off too, until a page says they are on or Agent Lookout is started again.

One wait sends one notification. While a tab with notifications on is open, the page shows each wait and Agent Lookout shows nothing. To make sure of that, when such a page has asked Agent Lookout for anything in the last 5 seconds, Agent Lookout holds its own notification back. If the page then fetches the sessions, the page has the wait and shows it, and Agent Lookout drops its own. If it does not, Agent Lookout shows the notification itself a few seconds later, at most about 6 seconds after the wait began. A wait that ends before then is not announced. Nor is a wait that begins in the couple of seconds around a reload of the page: the page that loads takes the session as already waiting, and Agent Lookout drops its own because a page has fetched the sessions. Two can still arrive for one wait when a page goes more than about 4 seconds between two fetches of the sessions, as when a browser slows a background tab down or the Mac has just woken.

A notification that Agent Lookout shows itself is not the browser's, and differs from it:

- macOS shows it as coming from Script Editor, which is how it labels whatever `osascript` shows.
- It holds the session's name and the reason, and nothing that could open the session or bring the dashboard forward.
- Agent Lookout cannot take it down. It stays in Notification Centre after the session moves on, until you clear it.

These were checked on macOS 26.5 in the system's log, with the screen locked. There macOS filed each one under Script Editor and kept it in Notification Centre, without first asking whether Script Editor may show notifications. How one looks on screen, and what a click on it does, have not been checked. On any other system Agent Lookout shows none itself, and the browser's notifications work as described above.

Notifications have been checked in Chrome 154 on macOS. There one arrived within a few seconds of a session starting to wait, with the tab in view and with it hidden for more than six minutes. Safari and Firefox have not been checked. A browser that puts a background tab to sleep, or unloads it to save memory, can delay notifications or stop them until you open the tab again.

A notification shows the session's name outside the dashboard: over other apps, in Notification Centre and, depending on your Mac's settings, on the lock screen and while you share or record the screen. To keep names off those, open Notifications in System Settings and change what your browser's notifications may show, or leave notifications off. The ones Agent Lookout shows itself are Script Editor's as far as macOS is concerned, so what you set there for your browser does not cover them.

The browser gives its permission to the address, not to Agent Lookout. Another program you later serve at the same address, such as another project's dev server on `localhost:5173`, can show notifications without asking. To take the permission back, remove it for that address in the browser's site settings. `npm start` serves Agent Lookout at `127.0.0.1:4777`, an address other tools are less likely to use. [PRIVACY.md](../PRIVACY.md#notifications) says what a notification holds and where it is kept.

## Jump

A Jump button takes you to a session. A Claude Code session has one when it runs in VS Code, or when its process runs inside a tmux pane. The button is in the Needs you panel and in the Sessions list. No other session has one.

### A session in VS Code

Jump is a link. Your browser opens a `vscode://` address that holds the session's ID, and VS Code opens the session. Agent Lookout's server takes no part in it. VS Code finds the session only when its folder is open in the VS Code window that has focus. Otherwise it starts a new conversation.

### A session in tmux

Jump is a button. Point at it, or move to it with Tab, to read where it goes, such as `tmux, work:2.1`: the tmux session's name, then the window's number and the pane's.

Press it, and the page asks Agent Lookout to select that pane. Agent Lookout runs `tmux` to do three things:

1. make the pane's window the selected window of its tmux session
2. make the pane the selected pane of that window
3. switch each terminal that is attached to tmux and showing another tmux session over to this one

A terminal already showing the session is not switched. It shows the window and pane just selected, as tmux does for every terminal on a session.

The session's row then says what happened, by its name, for a few seconds. A second press of the same button within a second does nothing.

| It says               | What happened                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| Selected in tmux      | The pane is selected.                                                                                   |
| That pane has closed  | tmux no longer has that pane. Nothing was changed, and the button goes within a few seconds.            |
| tmux has stopped      | No tmux server answered. Nothing was changed, and the button goes within a few seconds.                 |
| No tmux pane found    | The session has ended, or has left tmux, since the page last heard of it.                               |
| Try again in a moment | Another Jump was pressed less than a second before. Agent Lookout makes one jump a second.              |
| Jump did not work     | Agent Lookout did not answer, or could not run tmux. The page says so too if it has stopped altogether. |

Jump for tmux has these limits.

- It does not bring your terminal to the front. Jump selects the pane, and you switch to the terminal yourself. With no terminal attached to tmux, the pane is the one you see when you next attach to that tmux session.
- It sends nothing to the session: no keys and no text.
- If another pane of the window was zoomed, tmux ends the zoom when the selected pane changes.
- It knows one tmux server: the one the `tmux` command reaches from where Agent Lookout was started. That is the default server, or the one Agent Lookout was itself started inside. A session in another tmux server, such as one started with `tmux -L`, gets no button.
- It asks tmux where its panes are when it first finds a Claude Code session, then every 30 seconds, and within about 5 seconds of a new session appearing. So a session that has just started can be a few seconds without its button. After you move a pane, the place named on the button can be up to 30 seconds out of date. The press still selects the right pane, because it goes by the pane's own ID.
- When a window is linked into more than one tmux session, tmux chooses which of them is switched to.
- It is for Claude Code sessions. A session in a terminal that is not running tmux has no button: Jump does not reach a tab of iTerm2 or Terminal.
- It needs the `tmux` program, on your `PATH` or at `/opt/homebrew/bin`, `/usr/local/bin`, `/opt/local/bin` or `/usr/bin`. Without it, or while no tmux server is running, no session has the button and nothing else changes.

To stop Agent Lookout running tmux at all, start it with `AGENT_LOOKOUT_TMUX=off`. [PRIVACY.md](../PRIVACY.md#tmux) lists each command it runs and what it reads from tmux.

## Your own agents

Agent Lookout shows any other agent, including one you wrote yourself, when the agent writes one small JSON file for each of its sessions into a folder: `~/.agent-lookout/sessions`. Nothing is installed into the agent, it needs no library, and nothing goes over the network. Agent Lookout reads the folder every 2 seconds, so a session appears, changes and goes within about 2 seconds of the file doing so.

Paste this into a terminal while Agent Lookout is running. It makes the folder, writes a file for a working session, changes it to waiting, then deletes it:

```sh
dir=~/.agent-lookout/sessions
mkdir -p "$dir"
echo "Working: look at Sessions"
printf '{"agent": "my-agent", "name": "docs-site", "status": "working", "pid": %d}\n' $$ > "$dir/my-agent.json"
sleep 8
echo "Waiting: look at Needs you"
printf '{"agent": "my-agent", "name": "docs-site", "status": "waiting", "reason": "question", "pid": %d}\n' $$ > "$dir/my-agent.json"
sleep 8
rm "$dir/my-agent.json"
echo "Deleted: the session has gone"
```

The session appears in Sessions as `docs-site`, moves to Needs you as Asked you a question, and leaves the list when the file is deleted. Once there is more than one agent on the screen, each row names its own, here `my-agent`. If you set `AGENT_LOOKOUT_STATUS_DIR`, put that folder in the first line instead.

| Field    | Needed | What it holds                                                                                                                                                                                                                                                                                                         |
| -------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`  | Yes    | The agent's name, shown wherever the agent is named, such as `my-agent`. Up to 40 characters are kept.                                                                                                                                                                                                                |
| `status` | Yes    | `working`, `waiting`, `idle`, `finished` or `failed`. `waiting` means it needs you. Any other word shows as Unknown.                                                                                                                                                                                                  |
| `name`   | No     | The session's name. Without it, the last part of `cwd` is used, then the file's name. Up to 200 characters are kept.                                                                                                                                                                                                  |
| `cwd`    | No     | The folder the session works in, as a full path.                                                                                                                                                                                                                                                                      |
| `reason` | No     | For `waiting` only: `permission` or `question`. Anything else is shown as Waiting for you.                                                                                                                                                                                                                            |
| `since`  | No     | When this status began: an ISO 8601 time such as `2026-10-05T14:30:00Z`, or a whole number of milliseconds since 1970. Not seconds: `date +%s` gives seconds, and `date -u +%Y-%m-%dT%H:%M:%SZ` gives a time Agent Lookout reads. Leave it alone while the status stays the same, or each change reads as a new wait. |
| `pid`    | No     | The ID of the agent's process, as a number, not in quotes.                                                                                                                                                                                                                                                            |

- One file is one session. Its name can be anything that ends in `.json`, and it is what tells one session from another, so keep it for as long as the session lasts.
- When the process named by `pid` has gone, a session that is working, waiting or idle is not shown, because its agent stopped without deleting the file. A finished or failed session is expected to have no process, and stays. Without `pid`, a session stays until its file is deleted.
- A finished or failed session stays for 24 hours after its `since`, or after its file was last written.
- Without `since`, the time is when Agent Lookout first saw that status. For a file that was already there when Agent Lookout started, it is not known until the status changes, and a dash is shown.
- A name that starts with a dot is not read. To change a file without Agent Lookout ever reading half of it, write the new one under such a name and rename it over the old one with `mv`. A file caught half written is shown as it was for one more read.
- Agent Lookout reads at most 200 files, each 16 KB or less, directly in the folder. When there are more, it reads the 200 written most recently. It does not follow a symbolic link in the folder, and it does not look in folders inside it. A file over a limit, or one that is not JSON with an `agent` and a `status`, is skipped, and the Sources card counts it and names the first one, with why. Fields it does not know are ignored.
- Everything in a file is shown as plain text. Nothing in it is used as a link, so these sessions have no Jump button.
- A waiting session sends a [notification](#notifications) like any other.

Agent Lookout only reads the folder. It never makes it, and never writes, renames or deletes anything in it. When a session ends, delete its file, or write `finished` or `failed` to keep it on screen for a day and delete the file after that, for example the next time the agent starts. A file that is no longer shown still takes one of the 200 places until it is deleted. Any program that can write in the folder can put a session on the dashboard. Under your home folder, that means programs you run.

## What it does not do yet

It cannot stop, resume or answer a session. It covers Claude Code and Codex, and any agent that writes a [status file](#your-own-agents), and only sessions on this computer. Cloud sessions, Codex cloud tasks and browser chats do not appear.

A notification is sent only when a Claude Code session, or a session from a status file, starts waiting. Nothing is sent when a session finishes or fails. With no dashboard tab open, notifications are shown on a Mac only. Those come from Script Editor, cannot open the session, and are not cleared when the session moves on.

A Codex session never shows as needing you. Codex's session files do not record when it is waiting for your approval, so a Codex session that is waiting for you shows as working. A Codex session also appears only once its first prompt is sent, because Codex creates its file then. Past sessions the Codex desktop app imports from another agent appear only once you use them in Codex. A session from the Codex desktop app is named after its folder, because the app does not keep the titles it shows in the names file Agent Lookout reads.

A Claude Code background job is shown as finished or failed, and its row stays for 24 hours. A Codex session is shown as finished once no Codex program has it open, and its row stays until 24 hours after Codex last wrote to it. A session started by a Codex older than 0.155 is never shown as finished. Any other session that ends leaves the list. The Events log records that it ended, without saying whether it finished or failed.

Codex sessions and sessions from status files have no Jump button. Nor do Claude Code sessions in the desktop app, or in a terminal that is not running tmux. A session from a status file has no app either, so its app is shown as Unknown app. For a session in tmux, Jump selects its pane and leaves you to switch to your terminal. For a VS Code session, Jump finds the session only when its folder is open in the VS Code window that has focus. [Jump](#jump) has the rest.

The Events log, the charts and the Timeline are kept in memory. They start empty each time Agent Lookout starts.

The [milestones](https://github.com/Olanetsoft/agent-lookout/milestones) list what is planned.

## Settings you can change

Put a setting in front of the command that starts Agent Lookout:

```sh
AGENT_LOOKOUT_CLAUDE_FEED=off npm run dev
```

| Setting                       | What it does                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_LOOKOUT_PORT`          | The port `npm start` uses. The default is 4777.                                                                                                                    |
| `AGENT_LOOKOUT_HOST`          | The address `npm start` uses: `127.0.0.1`, which is the default, `localhost` or `::1`. Anything else is refused, so other computers cannot reach it.               |
| `AGENT_LOOKOUT_CLAUDE_BIN`    | The full path of the `claude` program. When set, it is the only place Agent Lookout looks.                                                                         |
| `AGENT_LOOKOUT_CLAUDE_HOME`   | A folder to read in place of `~/.claude`. When set, the `claude` command is not run unless `AGENT_LOOKOUT_CLAUDE_BIN` is set too.                                  |
| `AGENT_LOOKOUT_CLAUDE_FEED`   | Set to `off` and Agent Lookout never runs the `claude` command. Sessions come from the session files alone, and finished or failed background jobs are not listed. |
| `AGENT_LOOKOUT_CODEX_HOME`    | A folder to read in place of the Codex folder. A folder with no `sessions` folder in it shows no Codex sessions.                                                   |
| `CODEX_HOME`                  | Codex's own setting for where it keeps its files. When it is set, Agent Lookout reads that folder too, unless `AGENT_LOOKOUT_CODEX_HOME` is set.                   |
| `AGENT_LOOKOUT_STATUS_DIR`    | A folder of [status files](#your-own-agents) to read in place of `~/.agent-lookout/sessions`.                                                                      |
| `AGENT_LOOKOUT_NOTIFICATIONS` | Set to `on` and, on a Mac, Agent Lookout shows notifications itself from the moment it starts. A dashboard page that has notifications off turns them off again.   |
| `AGENT_LOOKOUT_TMUX`          | Set to `off` and Agent Lookout never runs `tmux`. Sessions in tmux are still listed, without a Jump button.                                                        |

To see the empty screen, set both `AGENT_LOOKOUT_CLAUDE_HOME` and `AGENT_LOOKOUT_CODEX_HOME` to an empty folder. With only the first set, Codex sessions still appear.

The Claude Code, Codex, status file, notification and tmux settings work with `npm run dev` and `npm start`. The port and address settings apply to `npm start` only. To choose the port for `npm run dev`, pass it after `--`:

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
4. With a dashboard tab open, check that the page does not say Agent Lookout has stopped updating.
5. With no dashboard tab open, Agent Lookout shows notifications itself on a Mac only, and only once a page that has notifications on has been open since Agent Lookout started, or when it was started with `AGENT_LOOKOUT_NOTIFICATIONS=on`. Those arrive as Script Editor's notifications, not your browser's.
6. A session that was already waiting when you opened the page, or when Agent Lookout started, sends nothing. Wait for the next one, or check the Needs you panel.

### The page says Agent Lookout has stopped updating

The program serving the page has stopped. The page keeps the last thing it saw, under a notice that says how old it is, and its timers stop at the last moment it heard from Agent Lookout. Start it again with `npm run dev` or `npm start`, and the page catches up on its own.

## How it finds sessions

For Claude Code, Agent Lookout reads the small file Claude Code keeps for each running session in `~/.claude/sessions/`, every 2 seconds. That starts no program and uses no network. When it starts, and every 30 seconds after that, it also runs `claude agents --json --all`, the command Claude Code [documents](https://code.claude.com/docs/en/agent-view) for listing its sessions. That answer decides which sessions exist, and it adds background jobs that have finished or failed. If the command cannot be found or fails, Agent Lookout uses the files alone.

For Codex it runs nothing. Every 2 seconds it reads what Codex has added to the session files under `~/.codex/sessions/` and finds the last line that says a turn started or ended: a session with a turn under way is working, and one whose last turn ended is idle. A session that no Codex program has open is finished. Those files hold your conversations with Codex. Agent Lookout keeps only when each turn started and ended and a few details, such as the session's folder. Codex documents none of these files, so a new Codex version can change them.

For any other agent it reads the folder `~/.agent-lookout/sessions` every 2 seconds, when that folder exists. Each file in it is one session, written by the agent itself, as [Your own agents](#your-own-agents) describes.

While a Claude Code session is running, Agent Lookout also asks tmux, if it is installed, which panes it has, about every 30 seconds. A session whose process runs inside one of them gets a [Jump](#jump) button.

Agent Lookout never writes to `~/.claude`, `~/.codex` or `~/.agent-lookout`. [PRIVACY.md](../PRIVACY.md) lists every file it reads and every command it runs, and what it keeps from each. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the files and the command are checked against each other.

## For contributors

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the parts fit together, and [CONTRIBUTING.md](../CONTRIBUTING.md) covers setup and the checks to run.
