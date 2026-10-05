# Privacy

Agent Lookout runs on your machine and reads a small amount of metadata about your Claude Code and Codex sessions, and about the sessions of any agent that writes a status file for Agent Lookout to read. Agent Lookout itself sends nothing anywhere. It does run Claude Code's own listing command, which may contact Anthropic the way Claude Code normally does.

For Codex, Agent Lookout opens Codex's session files, which hold the whole conversation. It reads them to find when each turn started and ended, and keeps only that and the few fields listed below. It keeps no prompt, reply, command or output.

## What it reads and runs

### Claude Code's session registry

Every 2 seconds Agent Lookout lists the folder `~/.claude/sessions/` and reads each file in it whose name ends in `.json`. Claude Code keeps one small file there for each running session, named `<pid>.json`. Agent Lookout reads only ordinary files of 256 KB or less, and on macOS and Linux it does not follow a link. From each file it keeps these fields and drops the rest: `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, `entrypoint`, `name`, `status`, `waitingFor`, `state`, `statusUpdatedAt` and `procStart`. `entrypoint` says whether the session runs in a terminal, in VS Code or in the desktop app, `statusUpdatedAt` says when its status last changed, and `procStart` says when its process started.

### `claude agents --json --all`

This is the session listing command that Claude Code documents for outside tools. Agent Lookout runs it once when it starts and every 30 seconds after that, and checks the registry against its answer. While the registry cannot be relied on, it runs the command every 5 seconds instead. That happens when the folder cannot be read, when a file in it has a status Agent Lookout does not know, or when the command lists a running session that the folder lacks. A Claude Code too old to know `--all` refuses it, and is then asked with `claude agents --json`.

From each entry it keeps these fields and drops the rest: `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`, `waitingFor`, `id` and `state`.

The command is started directly, with no shell, with stdin closed and a 5 second timeout. It is not run at all when `AGENT_LOOKOUT_CLAUDE_FEED` is `off`, or when `AGENT_LOOKOUT_CLAUDE_HOME` is set and `AGENT_LOOKOUT_CLAUDE_BIN` is not.

To find the `claude` binary, Agent Lookout reads the `PATH` environment variable and checks whether a program named `claude` exists in each `PATH` directory, then at `~/.local/bin/claude`, `/opt/homebrew/bin/claude` and `/usr/local/bin/claude`. When `AGENT_LOOKOUT_CLAUDE_BIN` is set, it checks that path and nothing else.

### `ps`

A registry file can outlive a crashed session, and the system can later give its process ID to another program. To catch that, Agent Lookout runs `ps -o pid=,lstart= -p <pids>`, which prints when each of those processes started, and compares the answer with the `procStart` that the registry file recorded. A file whose process started at another time is not shown as a session. One run covers several processes, and each process is asked about at most once every 30 seconds. `ps` is run directly from `/usr/bin` or `/bin`, never through a shell, and never on Windows.

### `tmux`

A Claude Code session that runs inside tmux gets a Jump button, and for that Agent Lookout has to know which pane the session's process is in. While at least one Claude Code session is running, it runs:

```sh
tmux -u list-panes -a -F '#{pane_pid} #{pane_id} #{window_index} #{pane_index} #{session_name}'
```

It runs this when it first has a session to ask about and every 30 seconds after that. It runs it sooner when a new session's process appears, though never within 5 seconds of the last run, and once more after a Jump has found its pane gone or tmux stopped. For every pane of the tmux server it reads five things: the ID of the process tmux started in the pane, the pane's ID, the numbers of its window and of the pane, and the name of its tmux session. It reads nothing a pane shows, and no pane's title, command or folder. With no Claude Code session running, it does not run tmux.

When tmux lists at least one pane, Agent Lookout also runs `ps -A -o pid=,ppid=`, which prints the ID of every process on this machine and the ID of its parent, and nothing else about any of them. It follows each session's process up through its parents until it reaches a pane's process. The list of processes is dropped as soon as that is done.

For a session found in a pane, the dashboard is sent the tmux session's name with the window and pane numbers, such as `work:2.1`, to show on the Jump button. The pane's ID stays in the server, in memory.

When you press Jump on such a session, the page sends the server the session's ID, and the server runs these, each with the pane's ID that it found itself:

- `tmux select-window -t <pane ID>` and `tmux select-pane -t <pane ID>`, which select the pane and its window
- `tmux -u display-message -p -t <pane ID> '#{session_id} #{window_index} #{pane_index} #{session_name}'`, which prints where the pane is and changes nothing
- `tmux list-clients -F '#{session_id} #{client_name}'`, which prints each terminal attached to tmux and the ID of the tmux session it is showing
- `tmux switch-client -c <terminal> -t <pane ID>`, once for each terminal that is showing another tmux session

These change which pane, window and tmux session are selected, and nothing else. No keys and no text are sent to any pane.

tmux is started directly, never through a shell, with stdin closed and a 2 second timeout, and never on Windows. Agent Lookout looks for it in each `PATH` directory, then at `/opt/homebrew/bin/tmux`, `/usr/local/bin/tmux`, `/opt/local/bin/tmux` and `/usr/bin/tmux`, and runs nothing when it is not there. tmux is given the environment Agent Lookout was started with, so it reaches the tmux server the `tmux` command would reach from there. None of these commands starts a tmux server. When the folder tmux keeps its sockets in is not there yet, `/tmp/tmux-` followed by your user number, tmux itself makes it, empty, the first time it is asked. With `AGENT_LOOKOUT_TMUX=off`, Agent Lookout runs neither tmux nor that `ps`.

### Whether a process exists

Agent Lookout asks the operating system whether each Claude Code session's process still exists with a signal-0 check on the process ID, which sends nothing to the process. It does the same for each status file that names a process.

### Codex's files

Agent Lookout reads Codex's folder: the one `AGENT_LOOKOUT_CODEX_HOME` names, otherwise the one Codex's own `CODEX_HOME` names, otherwise `~/.codex`. It runs no Codex program, changes no Codex setting and installs no hook. None of these files is documented by Codex. [docs/adapters/codex.md](docs/adapters/codex.md) records where each one comes from.

When the folder is not there, Agent Lookout looks for it again once a minute, or on every poll when `AGENT_LOOKOUT_CODEX_HOME` names it, and reads nothing else for Codex.

When the folder is there, every 2 seconds Agent Lookout:

- lists `sessions/` and the day folders for today and yesterday, `sessions/YYYY/MM/DD/`. While Codex has a session open whose file is in an older day folder, as a resumed session's can be, it lists every day folder: at most once every 5 seconds when Codex has newly opened such a session, and otherwise at most once every 30 seconds. Listing reads file names only.
- lists `thread-writer-locks/`, where Codex keeps one `<thread id>.lock` file for each session a Codex program has open. It reads the names and never opens these files.
- opens, read-only, each session file named `rollout-*.jsonl` in those day folders. It reads up to the first 2 MiB of a file to find its first `session_meta` line, and up to the last 8 MiB to find the last line that says a turn started or ended. After that it reads only what Codex has added, and only when the file's size or modified time has changed. A file not written to for a day, whose session no Codex program has open, is not opened.
- opens `session_index.jsonl`, where Codex keeps the names you gave sessions, when its size or modified time has changed, and reads at most its last 4 MiB.

The bytes it reads are held in memory only while the file is read. A line is parsed only when it names `session_meta`, or names `event_msg` and looks like a turn line. From every other line, which includes your prompts, Codex's replies, the commands it ran and their output, Agent Lookout takes only the time the line was written.

From the `session_meta` line it keeps `id`, `timestamp`, `cwd`, `source`, `thread_source`, `parent_thread_id`, `originator` (the program that started the session, such as the Codex desktop app) and `cli_version` (the Codex version), and drops the rest, which includes Codex's instructions, its list of tools, git details and account IDs. From a turn line it keeps the kind of line, such as `task_started` or `task_complete`, its time, and whether its `turn_id` marks a turn the Codex desktop app imported from another agent. From `session_index.jsonl` it keeps `id` and `thread_name`.

A session file or `session_index.jsonl` that is a link, a named pipe or a device is never opened. The Codex folder and the folders inside it are followed when they are links.

### Status files

Any agent can write one small JSON file for each of its sessions into a folder for Agent Lookout to read, as the [guide](docs/GUIDE.md#your-own-agents) describes. The folder is `~/.agent-lookout/sessions`, or the one `AGENT_LOOKOUT_STATUS_DIR` names. Agent Lookout never makes it.

Every 2 seconds Agent Lookout lists that folder and reads each file directly in it whose name ends in `.json` and does not start with a dot: at most 200 files. When there are more, it looks up when each was last written, without opening it, and reads the 200 written most recently. It reads only ordinary files of 16 KB or less, and on macOS and Linux it does not follow a symbolic link in the folder. The folder itself is followed when it is a link. It does not look in folders inside it. When the folder is not there, it lists nothing else.

From each file it keeps these fields and drops the rest: `agent`, `name`, `cwd`, `status`, `reason`, `since` and `pid`. `agent` is the agent's name, `cwd` the folder the session works in, `since` when its status began and `pid` the ID of its process. It also keeps each file's name, which tells one session from another, and the time the file was last written, which says how long a finished session stays. The Sources card names the first file it skipped, so you can find it.

For a file that names a `pid`, Agent Lookout asks the operating system whether that process still exists, with the same signal-0 check it makes for Claude Code, which sends nothing to the process. Nothing from a file is run, opened or followed: the `cwd` is shown, never read, and nothing in a file is used as a link.

### `osascript`

With notifications on, and no dashboard page open to show one, Agent Lookout shows a notification itself when a Claude Code session, or a session from a status file, starts waiting for you. On macOS it does that by running `/usr/bin/osascript`, the program macOS provides for running AppleScript. It gives it a script that never changes, which shows a notification, and two arguments for that script: the session's name and the reason. The name is handed over as text to be shown. It is never made part of the script, so nothing in a name can run as AppleScript or be read as an option.

`osascript` is started directly, by that full path, never through a shell, with stdin closed and a 5 second timeout. It is not run on any other system, and never while notifications are off. While it runs, for a fraction of a second, the name is one of that program's arguments, which other programs on this machine can read from the list of running processes. [Notifications](#notifications) says when notifications are on and what one holds.

### Settings

It reads ten settings from the environment: `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CLAUDE_BIN`, `AGENT_LOOKOUT_CLAUDE_FEED`, `AGENT_LOOKOUT_CODEX_HOME`, `AGENT_LOOKOUT_STATUS_DIR`, `AGENT_LOOKOUT_NOTIFICATIONS`, `AGENT_LOOKOUT_TMUX`, `AGENT_LOOKOUT_PORT`, `AGENT_LOOKOUT_HOST` and Codex's own `CODEX_HOME`. `AGENT_LOOKOUT_CLAUDE_HOME` replaces `~/.claude` in everything above. The [guide](docs/GUIDE.md#settings-you-can-change) says what each setting does.

## What it never reads

- The `.key` files that sit beside the registry files in `~/.claude/sessions/`.
- Claude Code's transcripts, in `~/.claude/projects/` or anywhere else. For Claude Code, Agent Lookout never sees your prompts, the agent's replies, your code or the output of tools.
- Claude Code's settings, credentials, history and memory files.
- Codex's `auth.json`, `config.toml`, `history.jsonl`, its SQLite files (`*.sqlite`), its `log/` folder, `archived_sessions/` and compressed session files (`*.jsonl.zst`), and the Codex desktop app's `external_agent_session_imports.json` and `.codex-global-state.json`.
- The files of any other application.

It runs no program but the `claude` binary, `ps`, `tmux` and, to show a notification on macOS, `osascript`. It never writes to `~/.claude`, to the Codex folder, to the folder of status files or to any agent tool's files, and it never sends input to a session. It never makes, renames or deletes a status file. The one thing it changes outside itself is which tmux pane, window and session are selected, and only when you press Jump.

## Network

The only network traffic Agent Lookout's own code makes is between the dashboard in your browser and its own server on the same machine. One more connection never leaves the machine either: before `npm start` begins listening, it connects once to its own address and port to see whether another program already answers there, and sends nothing over that connection. There is no telemetry, no analytics, no crash reporting and no update check, and there is no account. Fonts and scripts are bundled, so the page loads nothing from the internet.

The `claude agents` command is Claude Code's own program, and it may contact Anthropic the way it does for anyone who runs it. Agent Lookout sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_AUTOUPDATER` for each run, to ask Claude Code to skip its update check, usage reporting and error reporting, and runs the command seldom. Anything else that program does is governed by Claude Code's settings and terms. To stop Agent Lookout running it, set `AGENT_LOOKOUT_CLAUDE_FEED=off`. Sessions then come from the registry alone, and background jobs whose process has ended are not listed.

`npm start` listens on a loopback address only: `127.0.0.1`, or `::1` if you set `AGENT_LOOKOUT_HOST`. It refuses to start on any other address. `npm run dev` uses Vite's dev server, which listens on localhost unless you pass it `--host`.

The API refuses any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`, any request whose `Origin` header names another site, and any request the browser marks as cross-site. It sends no CORS headers. Together these stop a website you visit from reading your session names and paths through your browser.

Each request the dashboard makes carries one header of Agent Lookout's own, `X-Agent-Lookout-Notifications`, which says `on` or `off`: whether that page has notifications on. It goes to Agent Lookout's own server and nowhere else. [Notifications](#notifications) says what the server does with it. The request the Jump button sends for a session in tmux carries one more, `X-Agent-Lookout-Action: jump`, which names what is asked for.

The local server has no password. While Agent Lookout is running, another program on the same machine can request the same data, and on a shared computer so can another user account. Such a program can also send that header, and so turn the notifications the server shows on or off. It can also ask the server to select a tmux pane, as the Jump button does.

For a session in VS Code, the Jump button opens a `vscode://` address that contains the session ID. Your operating system hands it to VS Code. For a session in tmux, the Jump button sends a request that holds the session's ID to Agent Lookout's own server, which selects the pane as described under [`tmux`](#tmux). That request is the only one that changes anything, and the server answers it only for a page served from this machine. [SECURITY.md](SECURITY.md) lists its checks.

## Notifications

Notifications are off until you turn them on in Settings, or start Agent Lookout with `AGENT_LOOKOUT_NOTIFICATIONS=on`, which turns on only the ones the server shows. Pressing Turn on notifications is the only thing in Agent Lookout that asks your browser for permission to show them.

A notification is made in one of two ways. While a dashboard page is open, the page makes it through your browser. With no page open, the local server shows it on this machine itself. A page that is open shows the wait and the server does not, unless the page's requests are held up for more than about 4 seconds, when both can show one. The [guide](docs/GUIDE.md#notifications) says when that happens.

### From the dashboard page

With notifications on, when a Claude Code session, or a session from a status file, starts waiting for you, the dashboard page makes a notification through the browser's Notifications API, and the browser hands it to the operating system to show. It holds:

- the session's name, as its title
- the reason, as its text: "Waiting for permission", "Asked you a question" or "Waiting for you"
- a tag that is not shown, which the browser uses to keep one notification for each session: `agent-lookout:claude-code:` followed by the session's ID, or by its job ID or process ID when it has no session ID, and for a status file `agent-lookout:status-files:` followed by the file's name

It holds no folder path and none of Claude Code's own wording for the wait. No push service, no service worker and no network request is involved. The page that is open in your browser makes the notification, and can do so only while it is open.

The page closes a notification when its session stops waiting, when you turn notifications off, and when the page is closed or reloaded. It cannot close one if the browser crashes or is forced to quit first. While Agent Lookout is stopped, or cannot read Claude Code's sessions, the page cannot tell that a session has moved on, so a notification already showing stays. A notification stays in the system's notification list, Notification Centre on macOS, until the page closes it or you clear it. What the browser and the operating system keep of a notification, in memory or on disk, is theirs, and Agent Lookout cannot read it back.

When a dashboard tab is closed or reloaded, it tells the other dashboard tabs open at the same address, in the same browser, which sessions' notifications it closed, so that one of them can show them again. That message holds session IDs, goes over the browser's `BroadcastChannel` and does not leave the browser.

The browser gives its permission to the address, such as `localhost:5173`, not to Agent Lookout. Another program served at the same address later can show notifications without asking, and can read or change the two values listed under Storage. To take the permission back, remove it for that address in the browser's site settings.

### From the server

The local server shows notifications on this machine too. When a Claude Code session, or a session from a status file, starts waiting for you and no dashboard page is open to show it, the server runs `osascript`, as [described above](#osascript), and macOS shows the notification. It holds:

- the session's name, as its title
- the reason, as its text, in the same three wordings

It holds no folder path, none of Claude Code's own wording and no tag. No network request is involved. On any system but macOS the server shows nothing.

The server shows them only while notifications are on, and it learns that from the dashboard. Each request a dashboard page makes says, in the `X-Agent-Lookout-Notifications` header, `on` when that page's choice is on and the browser allows notifications, and `off` otherwise. The server keeps the last thing a page said, in memory, for as long as it runs, and never writes it to disk. Before any page has said anything it is off, unless `AGENT_LOOKOUT_NOTIFICATIONS=on` was set when Agent Lookout started. A page that says `off` after that turns it off all the same. The header is listened to only on a request that passes the checks described under [Network](#network), so a page at another address cannot set it.

While a page that has notifications on is open and asking every 2 seconds, the page shows each notification and the server does not. The server holds its own back for a few seconds when such a page has just been asking, and drops it once that page has fetched the sessions.

A notification the server shows differs from the browser's:

- macOS shows it as coming from Script Editor, which is how it labels whatever `osascript` shows. The browser's permission and its notification settings do not apply to it. On macOS 26.5, where this was checked in the system's log, macOS delivered it without first asking whether Script Editor may show notifications.
- It holds nothing that could open the session or the dashboard. What a click on it does has not been checked.
- The server cannot take it down. It stays in Notification Centre after the session stops waiting, and after Agent Lookout stops, until you clear it.

## Storage

Agent Lookout stores no session data on disk, and its own code writes no files. The latest session list, the last 1,000 events and the last six hours of history are held in memory and are gone when Agent Lookout stops. So are the tmux panes it last found, and what the dashboard pages last said about notifications.

With notifications on, each notification holds a session's name, and the operating system keeps it in its notification list, as does the browser for one it made. [Notifications](#notifications) says what it holds and how long it stays.

The tools that run it write files of their own. None of these holds session data.

- npm keeps a short log of each command it runs in `~/.npm/_logs/`. The log names the command and the project folder. It does not hold the program's output.
- `npm start` runs through tsx, which keeps compiled copies of Agent Lookout's own source files in the system's temporary directory, in a folder named `tsx-` followed by your user ID.
- `npm run dev` runs through Vite, which keeps pre-bundled copies of the dependencies in `node_modules/.vite/`.
- `npm run build` writes the built dashboard to `dist/` and the type checker's records to `node_modules/.tmp/`.

The dashboard saves two values in your browser's local storage. Your theme choice is under the key `agent-lookout-theme`. Whether notifications are on is under the key `agent-lookout-notifications`, as `on` or `off`, and is written only when you turn them on or off. Both belong to one browser at one address.

## What is on screen

Session names and folder paths can show what you are working on. Check a screenshot before you share it.

With notifications on, a session's name also appears in a system notification, outside the dashboard: over other apps, in Notification Centre and, depending on your system's settings, on the lock screen and while you mirror, share or record the screen. One the dashboard page made stays there until the session stops waiting or you clear it. One the server showed stays until you clear it. To keep names off those, open Notifications in System Settings on macOS and change what your browser's notifications may show, which does not cover the ones the server shows, or leave notifications off.

## Changes

This file lists every command the app runs and every file it reads outside its own folder. A change that adds to either list, stores anything on disk or talks to a network updates this file in the same pull request.
