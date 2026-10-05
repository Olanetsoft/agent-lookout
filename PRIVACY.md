# Privacy

Agent Lookout runs on your machine and reads a small amount of metadata about your Claude Code and Codex sessions, and about the sessions of any agent that writes a status file for Agent Lookout to read, and which git branch each session's folder has checked out. By default Agent Lookout itself sends nothing anywhere. Email notifications are off unless you set them up. Once you do, it sends a short email when a session has waited, and, if you choose, when one finishes, fails or ends, through the mail server you name, to the address you name, and nothing else. [Email](#email) says what one holds. Webhook posts are off unless you set an address for them. Once you do, it sends the same notices as short JSON posts to that one address, such as a Slack channel's incoming webhook, and nowhere else. [Webhook](#webhook) says what one holds. It does run Claude Code's own listing command, which may contact Anthropic the way Claude Code normally does.

For Codex, Agent Lookout opens Codex's session files, which hold the whole conversation. It reads them to find when each turn started and ended, and keeps only that and the few fields listed below. It keeps no prompt, reply, command or output.

## What it reads and runs

### Claude Code's session registry

Every 2 seconds Agent Lookout lists the folder `~/.claude/sessions/` and reads each file in it whose name ends in `.json`. Claude Code keeps one small file there for each running session, named `<pid>.json`. Agent Lookout reads only ordinary files of 256 KB or less, and on macOS and Linux it does not follow a link. From each file it keeps these fields and drops the rest: `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, `entrypoint`, `name`, `status`, `waitingFor`, `state`, `statusUpdatedAt` and `procStart`. `entrypoint` says whether the session runs in a terminal, in VS Code or in the desktop app, `statusUpdatedAt` says when its status last changed, and `procStart` says when its process started. It makes no use of when these files were last written.

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

### Terminal and iTerm2

On a Mac, a Claude Code session that runs in a tab of Terminal or iTerm2 gets a Jump button, and for that Agent Lookout has to know which app the session's process runs in and which terminal it has. When a Claude Code session's process appears, it runs:

```sh
ps -A -o pid=,ppid=,tty=,comm=
```

That prints four things about every process on this machine: its ID, its parent's ID, its terminal, such as `ttys004`, and the name its program gives itself, which for an app is the path of its program, such as `/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal`, and for a shell can be `-zsh`. It asks for no other argument, no owner and no environment. Agent Lookout follows each new session's process up through its parents, looking for Terminal's program or iTerm2's, and keeps two things about the session: which of the two apps it is in, and the session's own terminal, such as `/dev/ttys004`. The rest of the list is dropped as soon as that is done. One run covers every session that appeared since the last, and it runs no more than once every 5 seconds. A session is asked about once for as long as its process runs, and once more after a Jump has found its tab closed. With no Claude Code session running, it does not run this.

For a session found in a tab, the dashboard is sent the app's name, `Terminal` or `iTerm2`, to show on the Jump button. The terminal stays in the server, in memory.

When you press Jump on such a session, the page sends the server the session's ID, and the server runs `/usr/bin/osascript` with a script that never changes, one for each app, then `--` and the terminal it found itself. The script asks the app for the tab or pane that shows that terminal, makes it the selected one, brings its window to the front and brings the app to the front. It reads each tab's terminal to find it, and nothing else of any tab: no title, no contents and no command. It sends no keys and no text. It prints `found` or `missing`, and that is all Agent Lookout reads from it, with the error macOS gives when it has not allowed it.

macOS asks you once whether the program Agent Lookout runs in may control the app, and keeps your answer in its own settings, under Privacy & Security, Automation. Agent Lookout does not see or change that setting.

`ps` and `osascript` are started directly, never through a shell, with stdin closed. `ps` is run from `/usr/bin` or `/bin` with a 2 second timeout, and `osascript` by its full path with a timeout of one minute, which leaves time to answer macOS's question. Neither is run on any other system. With `AGENT_LOOKOUT_TERMINAL_JUMP=off`, Agent Lookout runs neither for this.

### Whether a process exists

Agent Lookout asks the operating system whether each Claude Code session's process still exists with a signal-0 check on the process ID, which sends nothing to the process. It does the same for each status file that names a process.

### Codex's files

Agent Lookout reads Codex's folder: the one `AGENT_LOOKOUT_CODEX_HOME` names, otherwise the one Codex's own `CODEX_HOME` names, otherwise `~/.codex`. It runs no Codex program, changes no Codex setting and installs no hook. None of these files is documented by Codex. [docs/adapters/codex.md](docs/adapters/codex.md) records where each one comes from.

When the folder is not there, Agent Lookout looks for it again once a minute, or on every poll when `AGENT_LOOKOUT_CODEX_HOME` names it, and reads nothing else for Codex.

When the folder is there, every 2 seconds Agent Lookout:

- lists `sessions/` and the day folders for today and yesterday, `sessions/YYYY/MM/DD/`. While Codex has a session open whose file is in an older day folder, as a resumed session's can be, it lists every day folder: at most once every 5 seconds when Codex has newly opened such a session, and otherwise at most once every 30 seconds. Listing reads file names only.
- lists `thread-writer-locks/`, where Codex keeps one `<thread id>.lock` file for each session a Codex program has open. It reads the names and never opens these files.
- opens, read-only, each session file named `rollout-*.jsonl` in those day folders. It reads up to the first 2 MiB of a file to find its first `session_meta` line, and up to the last 8 MiB to find the last line that says a turn started or ended. After that it reads only what Codex has added, and only when the file's size or modified time has changed. A file not written to for a day, whose session no Codex program has open, is not opened. The file's modified time, which it already looks up to see whether the file has changed, is also passed to the dashboard as the time Codex last wrote to the session, to say how long a working session has been quiet. A subagent's file is one of these session files too, and its modified time counts as a write by the session that started it.
- opens `session_index.jsonl`, where Codex keeps the names you gave sessions, when its size or modified time has changed, and reads at most its last 4 MiB.

The bytes it reads are held in memory only while the file is read. A line is parsed only when it names `session_meta`, or names `event_msg` and looks like a turn line. From every other line, which includes your prompts, Codex's replies, the commands it ran and their output, Agent Lookout takes only the time the line was written.

From the `session_meta` line it keeps `id`, `timestamp`, `cwd`, `source`, `thread_source`, `parent_thread_id`, `originator` (the program that started the session, such as the Codex desktop app) and `cli_version` (the Codex version), and drops the rest, which includes Codex's instructions, its list of tools, git details and account IDs. From a turn line it keeps the kind of line, such as `task_started` or `task_complete`, its time, and whether its `turn_id` marks a turn the Codex desktop app imported from another agent. From `session_index.jsonl` it keeps `id` and `thread_name`.

A session file or `session_index.jsonl` that is a link, a named pipe or a device is never opened. The Codex folder and the folders inside it are followed when they are links.

### Status files

Any agent can write one small JSON file for each of its sessions into a folder for Agent Lookout to read, as the [guide](docs/GUIDE.md#your-own-agents) describes. The folder is `~/.agent-lookout/sessions`, or the one `AGENT_LOOKOUT_STATUS_DIR` names. Agent Lookout never makes it.

Every 2 seconds Agent Lookout lists that folder and reads each file directly in it whose name ends in `.json` and does not start with a dot: at most 200 files. When there are more, it looks up when each was last written, without opening it, and reads the 200 written most recently. It reads only ordinary files of 16 KB or less, and on macOS and Linux it does not follow a symbolic link in the folder. The folder itself is followed when it is a link. It does not look in folders inside it. When the folder is not there, it lists nothing else.

From each file it keeps these fields and drops the rest: `agent`, `name`, `cwd`, `status`, `reason`, `since` and `pid`. `agent` is the agent's name, `cwd` the folder the session works in, `since` when its status began and `pid` the ID of its process. It also keeps each file's name, which tells one session from another, and the time the file was last written, taken from the file it opened, which says how long a finished session stays and how long a working session has been quiet. The Sources card names the first file it skipped, so you can find it.

For a file that names a `pid`, Agent Lookout asks the operating system whether that process still exists, with the same signal-0 check it makes for Claude Code, which sends nothing to the process. Nothing from a file is run or used as a link. The `cwd` is shown, and is looked in for a git repository as it is for every session, as [Git repositories](#git-repositories) describes. Nothing else in it is read.

### Git repositories

For every session that has a folder, whatever its agent, Agent Lookout finds the git repository the folder is in and reads which branch is checked out there. It runs no git command, and writes nothing in any repository.

It looks for an entry named `.git` in the session's folder, then in each folder above it in turn, and stops at the first it finds. It does not look in your home folder or the root, nor above them, nor in more than 24 folders in all, and it looks nowhere for a folder that does not exist. Looking means asking the system what is at that name, without following a symbolic link: it lists no folder.

- When `.git` is a folder, it reads `.git/HEAD`.
- When `.git` is a file, as in a worktree or a submodule, it reads that file, which names the repository's git folder in one line, `gitdir: <path>`, and then reads `HEAD` in the folder it names.
- When `.git` is anything else, such as a symbolic link, it reads nothing, and the session has no branch.

It reads only ordinary files of 4 KB or less, and on macOS and Linux it does not follow a `HEAD` that is a symbolic link. `HEAD` says either the name of the branch that is checked out, which Agent Lookout keeps, cleaned of control characters and of the characters that change the direction of text, and cut to 200 characters, or the ID of a commit when no branch is, of which it keeps the first seven characters. It keeps nothing else from either file. For each session's folder it reads `HEAD` at most once every 10 seconds, and it forgets a folder when no session is in it.

It reads nothing else in a repository: no other branch or reference, no `packed-refs`, no configuration, no index, no logs, no objects, and none of the files you work on.

### `osascript`

With notifications on, and no dashboard page open to show one, Agent Lookout shows a notification itself when a session starts waiting for you, or, if you chose those too, finishes, fails or ends. On macOS it does that by running `/usr/bin/osascript`, the program macOS provides for running AppleScript. It gives it a script that never changes, which shows a notification, and two arguments for that script: the session's name and the reason, or what happened. The name is handed over as text to be shown. It is never made part of the script, so nothing in a name can run as AppleScript or be read as an option.

`osascript` is started directly, by that full path, never through a shell, with stdin closed and a 5 second timeout. It is not run on any other system, and never while notifications are off. [Terminal and iTerm2](#terminal-and-iterm2) says when it is also run for Jump. While it runs, for a fraction of a second, the name is one of that program's arguments, which other programs on this machine can read from the list of running processes. [Notifications](#notifications) says when notifications are on and what one holds.

### Settings

It reads nineteen settings from the environment: `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CLAUDE_BIN`, `AGENT_LOOKOUT_CLAUDE_FEED`, `AGENT_LOOKOUT_CODEX_HOME`, `AGENT_LOOKOUT_STATUS_DIR`, `AGENT_LOOKOUT_NOTIFICATIONS`, `AGENT_LOOKOUT_TMUX`, `AGENT_LOOKOUT_TERMINAL_JUMP`, `AGENT_LOOKOUT_PORT`, `AGENT_LOOKOUT_HOST`, Codex's own `CODEX_HOME`, the five email settings, `AGENT_LOOKOUT_EMAIL_TO`, `AGENT_LOOKOUT_SMTP_URL`, `AGENT_LOOKOUT_EMAIL_FROM`, `AGENT_LOOKOUT_EMAIL_AFTER` and `AGENT_LOOKOUT_EMAIL_EVENTS`, and the three webhook settings, `AGENT_LOOKOUT_WEBHOOK_URL`, `AGENT_LOOKOUT_WEBHOOK_EVENTS` and `AGENT_LOOKOUT_WEBHOOK_AFTER`. `AGENT_LOOKOUT_CLAUDE_HOME` replaces `~/.claude` in everything above. [Email](#email) says how the email settings are kept, and [Webhook](#webhook) how the webhook's are. The [guide](docs/GUIDE.md#settings-you-can-change) says what each setting does.

## What it never reads

- The `.key` files that sit beside the registry files in `~/.claude/sessions/`.
- Claude Code's transcripts, in `~/.claude/projects/` or anywhere else. For Claude Code, Agent Lookout never sees your prompts, the agent's replies, your code or the output of tools.
- Claude Code's settings, credentials, history and memory files.
- Codex's `auth.json`, `config.toml`, `history.jsonl`, its SQLite files (`*.sqlite`), its `log/` folder, `archived_sessions/` and compressed session files (`*.jsonl.zst`), and the Codex desktop app's `external_agent_session_imports.json` and `.codex-global-state.json`.
- In a git repository, anything but the `.git` file and `HEAD` described under [Git repositories](#git-repositories).
- The files of any other application.

It runs no program but the `claude` binary, `ps`, `tmux` and, on macOS, `osascript`, to show a notification and to bring a tab of Terminal or iTerm2 forward. It runs no git command. It never writes to `~/.claude`, to the Codex folder, to the folder of status files, to any git repository or to any agent tool's files, and it never sends input to a session. It never makes, renames or deletes a status file. The one thing it changes outside itself is which tmux pane, window and session are selected, or which tab of Terminal or iTerm2 is in front, and only when you press Jump.

## Network

With email and the webhook off, which is the default, the only network traffic Agent Lookout's own code makes is between its own server and the dashboard in your browser, or the `agent-lookout status` command, on the same machine. With email set up, it also connects to the mail server you named, once for each email, as [Email](#email) describes. With a webhook address set, it also connects to that address, once for each post, as [Webhook](#webhook) describes. One more connection never leaves the machine either: before `npm start` begins listening, it connects once to its own address and port to see whether another program already answers there, and sends nothing over that connection. There is no telemetry, no analytics, no crash reporting and no update check, and there is no account. Fonts and scripts are bundled, so the page loads nothing from the internet.

The `claude agents` command is Claude Code's own program, and it may contact Anthropic the way it does for anyone who runs it. Agent Lookout sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_AUTOUPDATER` for each run, to ask Claude Code to skip its update check, usage reporting and error reporting, and runs the command seldom. Anything else that program does is governed by Claude Code's settings and terms. To stop Agent Lookout running it, set `AGENT_LOOKOUT_CLAUDE_FEED=off`. Sessions then come from the registry alone, and background jobs whose process has ended are not listed.

`npm start` listens on a loopback address only: `127.0.0.1`, or `::1` if you set `AGENT_LOOKOUT_HOST`. It refuses to start on any other address. `npm run dev` uses Vite's dev server, which listens on localhost unless you pass it `--host`.

The API refuses any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`, any request whose `Origin` header names another site, and any request the browser marks as cross-site. It sends no CORS headers. Together these stop a website you visit from reading your session names and paths through your browser.

Each request the dashboard makes carries one header of Agent Lookout's own, `X-Agent-Lookout-Notifications`, which says which events that page has notifications on for: `off`, `on`, which means a session starting to wait, or `on; events=` followed by the names of the events, such as `on; events=needs-you,finished`. It holds nothing else. It goes to Agent Lookout's own server and nowhere else. [Notifications](#notifications) says what the server does with it. The request the Jump button sends for a session in tmux, Terminal or iTerm2 carries one more, `X-Agent-Lookout-Action: jump`, which names what is asked for.

The local server has no password. While Agent Lookout is running, another program on the same machine can request the same data, and on a shared computer so can another user account. Such a program can also send that header, and so turn the notifications the server shows on or off. It can also ask the server to select a tmux pane, or bring a tab of Terminal or iTerm2 forward, as the Jump button does.

For a session in VS Code, the Jump button opens a `vscode://` address that contains the session ID. Your operating system hands it to VS Code. For a session in tmux, the Jump button sends a request that holds the session's ID to Agent Lookout's own server, which selects the pane as described under [`tmux`](#tmux). For a session in Terminal or iTerm2 it sends the same request, and the server brings the tab forward as described under [Terminal and iTerm2](#terminal-and-iterm2). That request is the only one that changes anything, and the server answers it only for a page served from this machine. [SECURITY.md](SECURITY.md) lists its checks.

## Notifications

Notifications are off until you turn them on in Settings, or start Agent Lookout with `AGENT_LOOKOUT_NOTIFICATIONS=on`, which turns on only the ones the server shows, and only for a session starting to wait. Pressing Turn on notifications is the only thing in Agent Lookout that asks your browser for permission to show them.

Once they are on, Settings lists four events, each with its own switch: a session starting to wait for you, finishing, failing, and ending, which is leaving the list without having finished or failed. The first is on and the other three are off until you change them. A notification is made only for the events switched on.

A notification is made in one of two ways. While a dashboard page is open, the page makes it through your browser. With no page open, the local server shows it on this machine itself. A page that is open shows it and the server does not, unless the page's requests are held up for more than about 4 seconds, when both can show one. The [guide](docs/GUIDE.md#notifications) says when that happens.

### From the dashboard page

With notifications on, when one of the events switched on happens, the dashboard page makes a notification through the browser's Notifications API, and the browser hands it to the operating system to show. It holds:

- the session's name, as its title
- what happened, as its text: for a session that starts waiting, the reason, "Waiting for permission", "Asked you a question" or "Waiting for you", and otherwise "Finished", "Failed" or "Ended"
- a tag that is not shown, which the browser uses to keep one notification for each session: `agent-lookout:claude-code:` followed by the session's ID, or by its job ID or process ID when it has no session ID, for Codex `agent-lookout:codex:` followed by the session's ID, and for a status file `agent-lookout:status-files:` followed by the file's name

It holds no folder path and none of Claude Code's own wording for the wait. No push service, no service worker and no network request is involved. The page that is open in your browser makes the notification, and can do so only while it is open.

The page closes the notification of a wait when its session stops waiting, when you turn notifications or that event off, and when the page is closed or reloaded. It cannot close one if the browser crashes or is forced to quit first. It never closes one that says Finished, Failed or Ended: that stays until you clear it, or until a later notification for the same session takes its place. While Agent Lookout is stopped, or cannot read Claude Code's sessions, the page cannot tell that a session has moved on, so a notification already showing stays. A notification stays in the system's notification list, Notification Centre on macOS, until the page closes it or you clear it. What the browser and the operating system keep of a notification, in memory or on disk, is theirs, and Agent Lookout cannot read it back.

When a dashboard tab is closed or reloaded, it tells the other dashboard tabs open at the same address, in the same browser, which sessions' notifications it closed, so that one of them can show them again. That message holds session IDs, goes over the browser's `BroadcastChannel` and does not leave the browser.

The browser gives its permission to the address, such as `localhost:5173`, not to Agent Lookout. Another program served at the same address later can show notifications without asking, and can read or change the values listed under Storage. To take the permission back, remove it for that address in the browser's site settings.

### From the server

The local server shows notifications on this machine too. When one of the events switched on happens and no dashboard page is open to show it, the server runs `osascript`, as [described above](#osascript), and macOS shows the notification. It holds:

- the session's name, as its title
- what happened, as its text, in the same wordings

It holds no folder path, none of Claude Code's own wording and no tag. No network request is involved. On any system but macOS the server shows nothing.

The server shows them only while notifications are on, and only for the events switched on, and it learns both from the dashboard. Each request a dashboard page makes says, in the `X-Agent-Lookout-Notifications` header, which events are on when that page's choice is on and the browser allows notifications, and `off` otherwise. The server keeps the last thing a page said, in memory, for as long as it runs, and never writes it to disk. Before any page has said anything it is off, unless `AGENT_LOOKOUT_NOTIFICATIONS=on` was set when Agent Lookout started, which turns it on for a session starting to wait. A page that says `off` after that turns it off all the same. The header is listened to only on a request that passes the checks described under [Network](#network), so a page at another address cannot set it.

While a page that has notifications on is open and asking every 2 seconds, the page shows each notification and the server does not. The server holds its own back for a few seconds when such a page has just been asking, and drops it once that page has fetched the sessions.

A notification the server shows differs from the browser's:

- macOS shows it as coming from Script Editor, which is how it labels whatever `osascript` shows. The browser's permission and its notification settings do not apply to it. On macOS 26.5, where this was checked in the system's log, macOS delivered it without first asking whether Script Editor may show notifications.
- It holds nothing that could open the session or the dashboard. What a click on it does has not been checked.
- The server cannot take it down. It stays in Notification Centre after the session stops waiting, and after Agent Lookout stops, until you clear it.

## Email

Email notifications are off until you set them up, and they can be set up only in the environment Agent Lookout starts with: `AGENT_LOOKOUT_EMAIL_TO`, the one address emails go to, and `AGENT_LOOKOUT_SMTP_URL`, the mail server they go through, with the user name and password to sign in with. `AGENT_LOOKOUT_EMAIL_FROM`, the sender's address, `AGENT_LOOKOUT_EMAIL_AFTER`, how long a wait lasts before it is emailed, and `AGENT_LOOKOUT_EMAIL_EVENTS`, what is emailed, can be left out. While either of the first two is unset, no email is sent, the mail library is not loaded and no connection is opened. The same holds when any of the five is set to something Agent Lookout cannot read. The [guide](docs/GUIDE.md#email) says how to set them up and how to turn them off.

### What an email holds

An email is plain text. Its subject is the session's name followed by the reason, in the words the dashboard uses, such as "checkout-flow is waiting for permission", or by what happened, such as "billing-webhooks finished", "billing-webhooks failed" or "billing-webhooks ended". Its body holds:

- that same sentence
- how long the session has waited, and the time on this computer's clock when it began, or the time on that clock when Agent Lookout saw it finish, fail or end
- the name of the session's project folder: the last part of its path, never the path
- the app it runs in, such as VS Code or Terminal
- the agent, such as Claude Code or Codex, or the agent a status file names
- one line saying Agent Lookout sent it and how to stop these emails

It holds no folder path, no prompt, none of Claude Code's own wording for the wait, no link, no image and nothing that reports back when it is opened. Its headers are the ones the mail library writes for every email: From, with the name Agent Lookout and the sender's address, To, Subject, Date, Message-ID, and three that say it is plain text in UTF-8. A session's name and its folder's name are cut to 80 characters, and anything in them that would end a line becomes a space, so nothing in a name can add a header or a recipient.

### Where it goes, and how

Each email goes to the one address in `AGENT_LOOKOUT_EMAIL_TO`, and to no other. It comes from the address in `AGENT_LOOKOUT_EMAIL_FROM`, or from the same address when that is not set. It goes through the mail server in `AGENT_LOOKOUT_SMTP_URL`, which then delivers it the way it delivers any email.

For each email Agent Lookout looks up the server's name, opens a connection to it, signs in with the user name and password from `AGENT_LOOKOUT_SMTP_URL`, hands the email over and closes the connection. It greets the server as `[127.0.0.1]`, not by this computer's name. The server sees the network address the connection comes from, as any server you connect to does. The connection is encrypted with TLS: from the first byte when the address begins `smtps://`, and when it begins `smtp://`, the server must offer to switch to TLS before anything is sent, or nothing is sent. The server's certificate is always checked. Only to a mail server on this machine, at `127.0.0.1` or `localhost`, does `smtp://` go without TLS, since nothing leaves the machine on the way to it.

### When

`AGENT_LOOKOUT_EMAIL_EVENTS` names the events that are emailed, from `needs-you`, `finished`, `failed` and `ended`, and is `needs-you` alone unless you set it. An email is sent for a wait that begins after Agent Lookout started, once it has lasted the delay, which is one minute unless `AGENT_LOOKOUT_EMAIL_AFTER` says otherwise, if the session is still waiting then. A wait answered before then sends nothing, and so does a session that was already waiting when Agent Lookout started. Each wait sends one email at most. With the others set, an email is sent as soon as a session is seen to finish, fail or end, and none for a session that had already finished or failed when Agent Lookout started. An email that could not be sent is not tried again. At most 20 are sent in any hour, whatever they are for. Past that, none goes until the hour has passed. Claude Code sessions and sessions from a status file can be seen waiting; a Codex session never can, so it never sends one for a wait.

The button and the switches for notifications in Settings do not turn emails on or off, or choose what is emailed. To stop them, start Agent Lookout again without `AGENT_LOOKOUT_EMAIL_TO`.

### What is kept

The settings, password included, live in the environment of the Agent Lookout process, as every setting on this page does. Programs running as your user on this machine can read a process's environment. Agent Lookout never writes them to a file, never sends them to the dashboard, and never prints them. When one cannot be read, it prints one line that names the setting and never its value. A setting typed in front of the command can be kept by your shell in its history file. The guide shows how to keep the password out of it.

Through `GET /api/email`, the dashboard learns whether email is on, the address with all but its first letter before the @ hidden, such as `n…@example.com`, the events that are emailed, the delay, and when the last email was tried, with whether it was sent or a short reason why not. It never learns the server, the user name or the password. That, and the times of the emails of the last hour, are held in memory and are gone when Agent Lookout stops.

Once an email has been handed to the mail server, Agent Lookout has no hold on it. The mail server you named and the mailbox it is delivered to keep the email, and whatever they record about it, for as long as their own settings and terms say. Agent Lookout cannot recall or delete it.

## Webhook

Webhook posts are off until you set them up, and they can be set up only in the environment Agent Lookout starts with: `AGENT_LOOKOUT_WEBHOOK_URL`, the one address posts go to. `AGENT_LOOKOUT_WEBHOOK_EVENTS`, what is posted, and `AGENT_LOOKOUT_WEBHOOK_AFTER`, how long a wait lasts before it is posted, can be left out. While the address is unset, nothing is posted and no connection is opened. The same holds when any of the three is set to something Agent Lookout cannot read. The [guide](docs/GUIDE.md#webhook) says how to set it up and how to turn it off.

### What a post holds

A post is one request with a body of JSON, such as:

```json
{
  "text": "checkout-flow is waiting for permission (4m 12s, storefront, VS Code, Claude Code)",
  "event": "needs-you",
  "reason": "permission",
  "session": {
    "name": "checkout-flow",
    "agent": "Claude Code",
    "folder": "storefront",
    "app": "VS Code"
  },
  "at": "2026-10-05T14:01:05.000Z",
  "waitedSeconds": 252
}
```

It holds:

- `text`: one line for a person to read, which is the line Slack shows. It is the session's name and what happened, in the words the dashboard uses, then in brackets how long the session has waited, for a wait, the name of its project folder, its app and its agent, leaving out any that is not known.
- `event`: what happened, `needs-you`, `finished`, `failed` or `ended`.
- `reason`, for a wait only: `permission`, `question` or `other`.
- `session`: the session's name, its agent, such as Claude Code or the agent a status file names, the name of its project folder, which is the last part of its path and never the path, and the app it runs in, such as VS Code. Any of the last three is `null` when it is not known.
- `at`: when it happened, as a time in UTC: when the wait began, or when Agent Lookout saw the session finish, fail or end.
- `waitedSeconds`, for a wait only: how long it had waited when it was posted.

It holds no folder path, no prompt, none of Claude Code's own wording for the wait, no session ID or process ID, and nothing about this computer. Its headers are `Content-Type: application/json`, `Content-Length`, `User-Agent: Agent Lookout/` followed by the version, `Host` and `Connection: close`. It carries no cookie and no other header.

A session's name, its folder's name and its agent's are each cut to 80 characters, and anything in them that would end a line becomes a space. In `text`, `<`, `>` and `&` are written as `&lt;`, `&gt;` and `&amp;`, which Slack shows as the characters themselves, and each `@` is followed by a space of no width, so nothing in a name can mention someone, ping a channel or make a link that shows other words than its address. The JSON is written whole by Node's own writer, so nothing in a name can add a field. Slack does show a web address written out in a name as a link to that address.

### Where it goes, and how

Each post goes to the one address in `AGENT_LOOKOUT_WEBHOOK_URL`, and to no other. For each post Agent Lookout looks up the address's host, opens a connection to it, sends the post, reads the status of the answer and closes the connection. The rest of the answer is read and dropped. A redirect is not followed, and a post is never tried again. The address must begin `https://`, so the connection is encrypted with TLS, and the certificate is always checked. Only to an address on this computer, at `127.0.0.1` or `localhost`, may it begin `http://`, since nothing leaves the machine on the way to it. The service at the address sees the network address the connection comes from, as any server you connect to does.

### When

`AGENT_LOOKOUT_WEBHOOK_EVENTS` names the events that are posted, from `needs-you`, `finished`, `failed` and `ended`, and is `needs-you` alone unless you set it. A post goes for a wait that begins after Agent Lookout started, once it has lasted the delay, which is one minute unless `AGENT_LOOKOUT_WEBHOOK_AFTER` says otherwise, if the session is still waiting then. A wait answered before then sends nothing, and so does a session that was already waiting when Agent Lookout started. Each wait sends one post at most. With the others set, a post goes as soon as a session is seen to finish, fail or end, and none for a session that had already finished or failed when Agent Lookout started. A post that could not be sent is not tried again. At most 20 posts are tried in any hour, whatever they are for, counted apart from emails. Past that, none goes until the hour has passed. These are the rules emails follow, and the two share one copy of them.

The button and the switches for notifications in Settings do not turn posts on or off, or choose what is posted. To stop them, start Agent Lookout again without `AGENT_LOOKOUT_WEBHOOK_URL`.

### What is kept

Anyone who has the address can post to the channel behind it, so it is kept like a password. It lives in the environment of the Agent Lookout process, as every setting on this page does, and programs running as your user on this machine can read a process's environment. Agent Lookout never writes it to a file, never sends it to the dashboard, and never prints it. When a webhook setting cannot be read, it prints one line that names the setting and never its value. A setting typed in front of the command can be kept by your shell in its history file. The guide shows how to keep the address out of it.

Through `GET /api/webhook`, the dashboard learns whether the webhook is on, the host the posts go to and nothing else of the address, such as `hooks.slack.com`, the events that are posted, the delay, and when the last post was tried, with whether it was sent or a short reason why not. That, and the times of the posts of the last hour, are held in memory and are gone when Agent Lookout stops. Settings shows the host in full, so with a service that puts its secret in the host, keep Settings out of screenshots too.

Once a post has been sent, Agent Lookout has no hold on it. The service at the address, such as Slack or Discord, keeps the message, and whatever it records about it, for as long as its own settings and terms say, and shows it to everyone who can read that channel. Agent Lookout cannot recall or delete it.

## Storage

Agent Lookout stores no session data on disk, and its own code writes no files. The latest session list, the last 1,000 events and the last six hours of history are held in memory and are gone when Agent Lookout stops. So are the tmux panes and terminal tabs it last found, the branches it last read, and what the dashboard pages last said about notifications.

With notifications on, each notification holds a session's name, and the operating system keeps it in its notification list, as does the browser for one it made. [Notifications](#notifications) says what it holds and how long it stays. With email set up, each email holds a session's name and its folder's name, and the mail server and the mailbox keep it, as [Email](#email) says. With a webhook set up, each post holds the same, and the service it went to keeps it, as [Webhook](#webhook) says.

The tools that run it write files of their own. None of these holds session data.

- npm keeps a short log of each command it runs in `~/.npm/_logs/`. The log names the command and the project folder. It does not hold the program's output.
- `npm start` and the `agent-lookout` command run through tsx, which keeps compiled copies of Agent Lookout's own source files in the system's temporary directory, in a folder named `tsx-` followed by your user ID.
- `npm run dev` runs through Vite, which keeps pre-bundled copies of the dependencies in `node_modules/.vite/`.
- `npm run build` writes the built dashboard to `dist/` and the type checker's records to `node_modules/.tmp/`.

The dashboard saves five values in your browser's local storage. Your theme choice is under the key `agent-lookout-theme`. Whether notifications are on is under the key `agent-lookout-notifications`, as `on` or `off`, and is written only when you turn them on or off. The events that send one are under the key `agent-lookout-notification-events`, as their names separated by commas, such as `needs-you,finished`, and are written only when you switch one. The apps the page has said macOS will ask about, when you first jumped to a tab of one, are under the key `agent-lookout-automation-note`, as `Terminal`, `iTerm2` or both separated by a comma. The last time the Events log was on screen is under the key `agent-lookout-last-looked`, as a number of milliseconds since 1970, and is written when the page goes out of sight or is closed. It is what the line in the Events log that marks where you left off is drawn from, and while that line still shows, the time kept is the line's own. It holds nothing about any session or event. All four belong to one browser at one address.

## What is on screen

Session names, folder paths and branch names can show what you are working on. Check a screenshot before you share it.

With notifications on, a session's name also appears in a system notification, outside the dashboard: over other apps, in Notification Centre and, depending on your system's settings, on the lock screen and while you mirror, share or record the screen. One the dashboard page made for a wait stays there until the session stops waiting or you clear it, and one that says Finished, Failed or Ended stays until you clear it. One the server showed stays until you clear it. To keep names off those, open Notifications in System Settings on macOS and change what your browser's notifications may show, which does not cover the ones the server shows, or leave notifications off. An email shows the same name, and the folder's, wherever that mailbox is read, including the notifications a phone shows for it. A webhook post shows them to everyone who can read the channel it goes to, and in the notifications their apps show for it.

## Changes

This file lists every command the app runs and every file it reads outside its own folder. A change that adds to either list, stores anything on disk or talks to a network updates this file in the same pull request.
