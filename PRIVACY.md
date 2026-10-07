# Privacy

Agent Lookout runs on your machine and reads a small amount of metadata about your Claude Code, Codex and Antigravity CLI sessions, and about the sessions of any agent that writes a status file for Agent Lookout to read, and which git branch each session's folder has checked out. By default Agent Lookout itself sends nothing anywhere. Email notifications are off unless you set them up. Once you do, it sends a short email when a session has waited, and, if you choose, when one finishes, fails or ends, through the mail server you name, to the address you name, and nothing else. [Email](#email) says what one holds. Webhook posts are off unless you set an address for them. Once you do, it sends the same notices as short JSON posts to that one address, such as a Slack channel's incoming webhook, and nowhere else. [Webhook](#webhook) says what one holds. Pushes to your phone, through ntfy or Pushover, are off unless you set one up. Once you do, it sends the same notices as short pushes through that service, to the one topic or the one user you name, and nowhere else. [ntfy](#ntfy) and [Pushover](#pushover) say what one holds. The Mac app, and only the Mac app, asks GitHub about once a day whether a newer version of it has been released, unless you turn that off in Settings. It sends nothing about your sessions: [Updates (Mac app only)](#updates-mac-app-only) says what it sends. The npm package, `npx agent-lookout` and the repository never check for anything. Pull requests are off unless you start Agent Lookout with `AGENT_LOOKOUT_PULL_REQUESTS=on`. Then it runs your own GitHub CLI, `gh`, which sends GitHub the owner and name of a session's repository and the name of its branch, with `gh`'s own login, which Agent Lookout never reads: [`gh`](#gh) says what it sends and when. Other machines are read only once you name them in `AGENT_LOOKOUT_REMOTES`. Then it runs your own `ssh` to each and asks the Agent Lookout running there for its sessions, and sends nothing of this computer's: [Another machine over SSH](#another-machine-over-ssh) says what is read. It does run Claude Code's own listing command, which may contact Anthropic the way Claude Code normally does. Its MCP server, `agent-lookout mcp`, runs only once you add it to an agent's app, and answers that app and nothing else. That app may pass what it learns to its model: [The MCP server](#the-mcp-server) says what an answer holds.

For a Claude Code session that is waiting for you, Agent Lookout reads the last message of its transcript, to show what the session is asking, such as the command it wants to run or the question it put to you. It reads nothing of a transcript while the session is not waiting, and keeps nothing of it once the wait ends. It sends that line off the machine only if you turn it on for email, with `AGENT_LOOKOUT_EMAIL_ASKING=on`, for the webhook, with `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, or for a push, with `AGENT_LOOKOUT_NTFY_ASKING=on` or `AGENT_LOOKOUT_PUSHOVER_ASKING=on`, and then only in the email, post or push for that wait and its reminders. It also goes to another computer that names this one in `AGENT_LOOKOUT_REMOTES` and reads its sessions over SSH. That computer shows it, and its own email, webhook and push settings decide whether it is sent on, as [Another machine over SSH](#another-machine-over-ssh) says. `AGENT_LOOKOUT_WAITING_TEXT=off` on this computer keeps it from there too. No answer of `agent-lookout mcp` holds it. [Claude Code's transcripts](#claude-codes-transcripts) says exactly what is read, and `AGENT_LOOKOUT_WAITING_TEXT=off` turns it off.

For Codex, Agent Lookout opens Codex's session files, which hold the whole conversation. It reads them to find when each turn started and ended, and keeps only that and the few fields listed below. It keeps no prompt, reply, command or output.

For the Antigravity CLI, `agy`, Agent Lookout opens the transcripts agy keeps, which hold the whole conversation. It reads the end of each to find the conversation's last step, and keeps only that step's kind, its status, whether it asks for a tool and its time. It keeps no prompt, reply, command or output. It also reads the command lines of the `agy` programs that are running, which can hold a prompt given with `-p`, only to tell a session from one of agy's own commands and to find the conversation one names, and keeps nothing else of them. [The Antigravity CLI's files](#the-antigravity-clis-files) says exactly what is read.

Agent Lookout stops a Claude Code session only when you press Stop in its details and confirm, or end the sessions left running after a confirmation that lists each one. It answers a Claude Code permission prompt only when you press Allow or Deny, or when a [permission rule](#permission-rules) you added in Settings decides it, and only with its Claude Code plugin installed. It never acts on a session on its own. [Stopping a session](#stopping-a-session) and [The Claude Code plugin and permission prompts](#the-claude-code-plugin-and-permission-prompts) say what it checks first and what it runs.

## What it reads and runs

### Claude Code's session registry

Every 2 seconds Agent Lookout lists the folder `~/.claude/sessions/` and reads each file in it whose name ends in `.json`. Claude Code keeps one small file there for each running session, named `<pid>.json`. Agent Lookout reads only ordinary files of 256 KB or less, and it does not follow a link. Windows has no way to open a file without following a link at its name, so there Agent Lookout looks at the name first, opens only an ordinary file, and reads nothing unless the file it opened is the one it looked at. Each file this page says is read without following a link is opened that way on Windows. From each file it keeps these fields and drops the rest: `pid`, `sessionId`, `cwd`, `startedAt`, `kind`, `entrypoint`, `name`, `status`, `waitingFor`, `state`, `statusUpdatedAt` and `procStart`. `entrypoint` says whether the session runs in a terminal, in VS Code or in the desktop app, `statusUpdatedAt` says when its status last changed, and `procStart` says when its process started. It makes no use of when these files were last written.

### Claude Code's transcripts

Claude Code keeps each session's conversation in a transcript, `~/.claude/projects/<folder>/<session ID>.jsonl`, where the folder is named after the session's folder. Agent Lookout reads one only while its session is waiting for you, as the registry or the `claude` command says, and reads nothing of any transcript otherwise.

For a waiting session it looks for the file in the folder named after the session's folder, and, when it is not there, in each folder in `~/.claude/projects/`, by name, which lists those folders. It uses the session ID only once it has checked that it is an ID, and opens only an ordinary file: it does not follow the transcript file when it is a link, and it never reads a named pipe or a device. The folders above the file are followed when they are links: a folder in `~/.claude/projects/` that is a link, or `projects` itself. It reads at most the last 256 KB of the file, by position, and reads it again only when the file's size or modified time has changed. While a wait goes on it does not look for a file again, except every 10 seconds when none was found.

From those bytes it takes the last tool the session asked to use that has no answer yet, leaving out the lines of the session's subagents, and keeps one line of plain text of at most 200 characters about it, cleaned of control characters:

- for a question the session put to you, the first question, and how many more there are
- for a command, `Run:` and the command's first line
- for a file it would edit, write or read, `Edit:`, `Write:` or `Read:` and the file's path, relative to the session's folder when it is inside it
- for a web page or a search, `Fetch:` and the address, or `Search:` and the words
- for a plan, "Approve the plan"
- for any other tool, `Use:` and the tool's name, except a tool that starts a subagent, for which there is no line

Everything else in those bytes, which can include your prompts, the agent's replies, the code it wrote and the output of tools, is dropped as soon as the line is made. When nothing in the end of the file fits, there is no line, and nothing is guessed.

That line is shown in the Needs you panel and in the session's details, is put in the notification of that wait that the dashboard page or the server shows on this machine, in the Mac app is in the menu that its icon in the menu bar opens, and is in the session list the API serves on this computer. It is kept in memory beside the place of the file and its size and modified time, only while the session waits, and is forgotten on the first poll after the wait ends. It is not written to disk, not kept in the event log or the history, and not put in an answer of `agent-lookout mcp`. It is put in an email, a webhook post or a push only when you turn that on, as [Email](#email), [Webhook](#webhook), [ntfy](#ntfy) and [Pushover](#pushover) say. It also goes to another computer that names this one in `AGENT_LOOKOUT_REMOTES` and reads its sessions over SSH, which shows it, and whose own email, webhook and push settings decide whether it is sent on, as [Another machine over SSH](#another-machine-over-ssh) says. Set `AGENT_LOOKOUT_WAITING_TEXT=off` and no transcript is opened at all, so there is no line to send either.

### `claude agents --json --all`

This is the session listing command that Claude Code documents for outside tools. Agent Lookout runs it once when it starts and every 30 seconds after that, and checks the registry against its answer. While the registry cannot be relied on, it runs the command every 5 seconds instead. That happens when the folder cannot be read, when a file in it has a status Agent Lookout does not know, or when the command lists a running session that the folder lacks. A Claude Code too old to know `--all` refuses it, and is then asked with `claude agents --json`.

From each entry it keeps these fields and drops the rest: `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`, `waitingFor`, `id` and `state`.

The command is started directly, with no shell, with stdin closed and a 5 second timeout. It is not run at all when `AGENT_LOOKOUT_CLAUDE_FEED` is `off`, or when `AGENT_LOOKOUT_CLAUDE_HOME` is set and `AGENT_LOOKOUT_CLAUDE_BIN` is not.

To find the `claude` binary, Agent Lookout reads the `PATH` environment variable and checks whether a program named `claude` exists in each `PATH` directory, then at `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.npm-global/bin/claude` and `/usr/bin/claude`. On Windows it checks each `PATH` directory for `claude.com` and `claude.exe`, and then for `node_modules\@anthropic-ai\claude-code\bin\claude.exe` under it, where npm keeps the program that its `claude.cmd` runs, then `%USERPROFILE%\.local\bin\claude.exe` and that npm path under `%APPDATA%\npm`. It never runs a `.cmd` or a `.bat`, which only a shell can run. When `AGENT_LOOKOUT_CLAUDE_BIN` is set, it checks that path and nothing else.

### `ps`

A registry file can outlive a crashed session, and the system can later give its process ID to another program. To catch that, Agent Lookout runs `ps -o pid=,lstart= -p <pids>`, which prints when each of those processes started, and compares the answer with the `procStart` that the registry file recorded. A file whose process started at another time is not shown as a session. One run covers several processes, and each process is asked about at most once every 30 seconds. `ps` is run directly from `/usr/bin` or `/bin`, never through a shell, and never on Windows. On Windows, which has no `ps` and where Claude Code records no start time Agent Lookout can compare, nothing is compared: a file whose process ID has been given to another program shows as a session until that program ends.

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

### Stopping a session

A Claude Code session in a terminal or in VS Code, and a Claude Code background job, has a Stop button in its details, when its registry file names its kind, `interactive` or `bg`, and records its process's start time. A session in Claude Code's desktop app has none, since that app looks after its own processes, and nor does a session whose kind or app is not known, a Codex session or a session from a status file. A background job has one only while Agent Lookout may run the `claude` command, as [`claude agents --json --all`](#claude-agents---json---all) says. The dashboard is told only that a session can be stopped, and whether by a signal or by `claude stop`: the process ID it already shows, the start time and the job's ID stay in the server, in memory.

Nothing is done until you press Stop and then Stop session. The page then sends the server the session's ID and nothing else, and the server makes every check again at that moment, remembering nothing from before:

- It reads the session's registry file, `~/.claude/sessions/<pid>.json`, again, as an ordinary file of 256 KB or less, following no link. It must still name that session and that process, be of the same kind, and record the same start time.
- It runs `ps -o pid=,lstart= -p <pid>` again, for that one process, and goes on only when `ps` gives the same start time the file recorded, to the second. When `ps` gives none, or one it cannot compare, nothing is done.
- It never stops the first process, its own process, the process it was started from or any process above that, such as the Claude Code session whose terminal started it. To find those, it runs `ps -A -o pid=,ppid=`, which prints the ID of every process and of its parent, and nothing else, follows its own process up through its parents, and drops the list. It stops no process of another user's.

Then, for a session in a terminal or in VS Code, it sends SIGTERM to that one process, by the system call, as `kill -TERM <pid>` would, and looks every 200 milliseconds, for up to 10 seconds, whether it has ended. If it is still running, the page says so. It never sends SIGKILL to a session, and it signals no other session. For a background job, it runs the `claude` binary it found for `claude agents`, as `claude stop <id>`, with the job's ID that `claude agents` gave it and nothing else, started directly, never through a shell, with stdin closed, a 10 second timeout and the same two variables as `claude agents`. If `claude stop` runs past its 10 seconds, Agent Lookout ends that command, and anything it started, with SIGTERM and then SIGKILL, as it does `claude agents` when that runs past its time: that command is Agent Lookout's own, not the session. It never signals a background job's process, which Claude Code's supervisor would start again. Once `claude stop` has answered, it looks the same way, for up to 10 seconds, whether the job's process has ended, since the supervisor can end it a moment later, and then runs `claude agents --json --all` once more at the next poll, so the job shows as stopped.

The sessions left running are the Claude Code sessions that have been idle for 24 hours or more, or as long as the [idle rule](docs/GUIDE.md#time-rules) says while it is on, by their registry file's status time, whose process still runs and which can be stopped. The Sessions card says how many there are, and lists them when you press Review…. End all… lists each one again, up to 20 at a time, and ending them sends the server each session's ID and the moment its idle began, as the page showed it. The server makes every check above for each one, and also checks that its registry file, and its own latest list of sessions, still say it is idle, since that same moment, and that this was 24 hours or more ago, or as long ago as the idle rule says. A session that has done anything since is left running.

Stopping keeps the conversation: it touches no transcript and no file under `~/.claude`, and a registry file left behind is not deleted. The Events log keeps one event for each session stopped, with its ID, its name, the status it had and that Agent Lookout stopped it, as [The history](#the-history) says. With `AGENT_LOOKOUT_STOP=off`, nothing is offered Stop, and the server answers no request to stop a session. On Windows it is the same whatever the setting, since there is no `ps` to confirm a process's start time and no POSIX signal to send.

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

### The Antigravity CLI's files

Agent Lookout reads the Antigravity CLI's folder: the one `AGENT_LOOKOUT_ANTIGRAVITY_HOME` names, otherwise `~/.gemini/antigravity-cli`. It runs no agy program, changes no agy setting and installs no hook or status line. agy documents the transcript's place and format for its own agents and hooks, not for other programs, and the rest of what is listed here is not documented. [docs/adapters/antigravity.md](docs/adapters/antigravity.md) records where each comes from. It was written from agy 1.3.1's documentation and program, and has not yet been checked against a running conversation.

When the folder is not there, Agent Lookout looks for it again once a minute, or on every poll when `AGENT_LOOKOUT_ANTIGRAVITY_HOME` names it, and reads nothing else for the Antigravity CLI and runs no `ps` for it.

When the folder is there, every 2 seconds Agent Lookout:

- lists `brain/`, where agy keeps one folder for each conversation, named by the conversation's ID, and `conversations/`, where it keeps each conversation's SQLite database, `<conversation ID>.db`, and its write-ahead log, `<conversation ID>.db-wal`. Listing reads names only.
- looks up, without opening them, when three files of each conversation were last changed: its transcript, `brain/<conversation ID>/.system_generated/logs/transcript.jsonl`, its database and its database's log. For a conversation not changed for a day, which no agy program could have open, it looks them up again only every 30 seconds. The newest of the three times is passed to the dashboard as the time agy last wrote to the session, to say how long a working session has been quiet.
- opens, read-only, the transcript of each conversation whose transcript changed in the last day or that an agy program could have open. It reads up to the first 256 KiB to find the end of its first line, the first 4 KiB again to notice when agy has rewritten the file, as it does when it compacts a conversation, and up to the last 2 MiB to find the last steps. After that it reads only what agy has added, and only when the file's size or modified time has changed.

Each line of a transcript is one step. Agent Lookout parses each line it reads and keeps four of its fields, `type`, `status`, `step_index` and `created_at`, and whether its `tool_calls` list is empty, and drops the rest at once: `content`, which holds your prompts, the agent's replies and what tools returned, `thinking`, `media`, `source`, the tool calls and their arguments. Of the steps it keeps, it holds only the last that says how the conversation stands, when the steps before it that say the same began, when the last step of any kind was made, and when the first step was made. The bytes it reads are held in memory only while the file is read.

It never opens a conversation's database or its log, `conversation_summaries.db`, `transcript_full.jsonl` or anything else in the folder. A transcript that is a link, a named pipe or a device is never opened. The folder and the folders inside it are followed when they are links.

To tell a conversation agy has open from one that has ended, while there is a conversation to show, Agent Lookout runs `ps -A -o pid=,ppid=,lstart=,comm=`, in UTC, at most every 10 seconds, and sooner, though not within 2 seconds of the last run, when a conversation is written that no agy program it knows of could have open. It prints four things about every process on this machine: its ID, its parent's ID, when it started and the name its program gives itself, and nothing else. Agent Lookout keeps only the processes whose program is named `agy`, and drops the rest as it reads them. When it finds an agy program it has not seen before, it runs `ps -o pid=,args= -p <their IDs>`, which prints the command lines of those programs and of no other. A command line can hold a prompt, given with `-p`. Agent Lookout reads each only to tell whether the program is one of agy's own commands, such as `agy remote-control`, which is not a session, and which conversation it names with `--conversation`, keeps only those two things for as long as the program runs, and drops the line at once. It keeps when each agy program started, by its process ID. `ps` is run directly from `/usr/bin` or `/bin`, never through a shell, with a 2 second timeout, and never on Windows, where no Antigravity CLI conversation is shown as finished.

### Status files

Any agent can write one small JSON file for each of its sessions into a folder for Agent Lookout to read, as the [guide](docs/GUIDE.md#your-own-agents) describes. The folder is `~/.agent-lookout/sessions`, or the one `AGENT_LOOKOUT_STATUS_DIR` names. Agent Lookout never makes it.

Every 2 seconds Agent Lookout lists that folder and reads each file directly in it whose name ends in `.json` and does not start with a dot: at most 200 files. When there are more, it looks up when each was last written, without opening it, and reads the 200 written most recently. It reads only ordinary files of 16 KB or less, and it does not follow a symbolic link in the folder. The folder itself is followed when it is a link. It does not look in folders inside it. When the folder is not there, it lists nothing else.

From each file it keeps these fields and drops the rest: `agent`, `name`, `cwd`, `status`, `reason`, `since`, `pid` and `app`. `agent` is the agent's name, `cwd` the folder the session works in, `since` when its status began, `pid` the ID of its process and `app` the app the session runs in. It also keeps each file's name, which tells one session from another, and the time the file was last written, taken from the file it opened, which says how long a finished session stays and how long a working session has been quiet. The Sources card names the first file it skipped, so you can find it.

For a file that names a `pid`, Agent Lookout asks the operating system whether that process still exists, with the same signal-0 check it makes for Claude Code, which sends nothing to the process. Nothing from a file is run or used as a link. The `cwd` is shown, and is looked in for a git repository as it is for every session, as [Git repositories](#git-repositories) describes. Nothing else in it is read.

### Git repositories

For every session that has a folder, whatever its agent, Agent Lookout finds the git repository the folder is in and reads which branch is checked out there. It runs no git command, and writes nothing in any repository.

It looks for an entry named `.git` in the session's folder, then in each folder above it in turn, and stops at the first it finds. It does not look in your home folder or the root, nor above them, nor in more than 24 folders in all, and it looks nowhere for a folder that does not exist. Looking means asking the system what is at that name, without following a symbolic link: it lists no folder.

- When `.git` is a folder, it reads `.git/HEAD`.
- When `.git` is a file, as in a worktree or a submodule, it reads that file, which names the repository's git folder in one line, `gitdir: <path>`, then reads `HEAD` in the folder it names, and `commondir` beside it when there is one. A worktree's git folder has a `commondir`, one line naming the git folder of the repository the worktree was made from. A submodule's has none.
- When `.git` is anything else, such as a symbolic link, it reads nothing, and the session has no branch.

It reads only ordinary files of 4 KB or less, and it does not follow a `HEAD` or a `commondir` that is a symbolic link. `HEAD` says either the name of the branch that is checked out, which Agent Lookout keeps, cleaned of control characters and of the characters that change the direction of text, and cut to 200 characters, or the ID of a commit when no branch is, of which it keeps the first seven characters. It keeps nothing else from these files. For each session's folder it reads them at most once every 10 seconds, and it forgets a folder when no session is in it.

With the branch it keeps which repository the folder belongs to, so the dashboard can group the worktrees of one repository together. A repository is known by its own git folder, which all its worktrees share: a `.git` folder is its own, a worktree's `commondir` names it, and any other `.git` file, such as a submodule's, names it in its one line. Agent Lookout reads nothing more for this. It keeps two things about the repository: its name, cleaned and cut as a branch is, and an id to tell repositories apart, the first 16 characters of the SHA-256 hash of the git folder's path. The name is that of the folder that holds `.git`, such as `storefront`, and for a worktree the one its repository's git folder gives: `storefront` for `storefront/.git`, `storefront/.bare` or `storefront.git`. Both are in the session list the API serves on this computer, beside the branch, and nowhere else: no email, post, notification or answer of `agent-lookout mcp` holds them. The path itself is not sent. The id is never shown, and holds no part of the path, though someone who guessed a path could check the guess against it.

It reads nothing else in a repository: no other branch or reference, no `packed-refs`, no configuration, no index, no logs, no objects, and none of the files you work on. The one exception is with `AGENT_LOOKOUT_PULL_REQUESTS=on`, when it also reads the repository's `config` and its remote's `HEAD`, as [`gh`](#gh) describes.

### `gh`

Only with `AGENT_LOOKOUT_PULL_REQUESTS=on`, Agent Lookout shows each session's pull request on github.com and its checks. It asks your own GitHub CLI, `gh`, for them. With the setting left out or `off`, which is the default, it reads none of the files below, never looks for `gh` and never runs it. Any other value leaves it off too, and Agent Lookout prints one line at start that names the setting.

To know where to look, it reads two more files in the git folder of each repository a session is in, the one [Git repositories](#git-repositories) finds, and writes nothing:

- `config`, of at most 64 KB, an ordinary file it does not follow as a link. From it, it keeps each remote's name and first `url`, the `gh-resolved` line that `gh repo set-default` writes, each branch's `remote` and `pushRemote`, and `remote.pushDefault`, and drops the rest of the file. Of a remote's address it keeps only the owner and the name of a repository on github.com, never the address itself, and never a user name, password or token written in it. It does not read your global git configuration.
- `refs/remotes/<remote>/HEAD`, of at most 4 KB, which names the remote's default branch.

It asks only about a branch of a repository whose remote is on github.com, and never about the default branch, the one that `HEAD` names, or `main` or `master` when it was never written. A remote on any other host, such as a GitHub Enterprise server, is never asked about. Nor is a branch whose name is only digits, with or without a `#` before them, such as `51` or `#51`, since `gh` would read it as the number of a pull request rather than as a branch.

For each repository and branch your sessions are on, it runs, at most once every 2 minutes and never on every poll:

```sh
gh pr view --repo github.com/<owner>/<repository> --json number,title,state,isDraft,statusCheckRollup -- <branch>
```

where `<branch>` is the branch's name, or `<owner>:<branch>` for a branch pushed to a fork. `gh` is found on `PATH`, then at `/opt/homebrew/bin/gh`, `/usr/local/bin/gh`, `/opt/local/bin/gh` and `/usr/bin/gh`, and is started directly, by that full path, never through a shell, with stdin closed and a 15 second timeout, one question at a time. It is given the environment Agent Lookout was started with, less Agent Lookout's own settings, so it signs in with its own login, as it does in your terminal, with `GH_PROMPT_DISABLED`, `GH_NO_UPDATE_NOTIFIER`, `GH_NO_EXTENSION_UPDATE_NOTIFIER`, `GH_SPINNER_DISABLED` and `NO_COLOR` set, and `GH_FORCE_TTY`, `GH_DEBUG`, `DEBUG`, `GH_PAGER` and `PAGER` taken out. Agent Lookout never reads, keeps or passes on a token, and never reads `gh`'s own configuration or login.

`gh` then asks GitHub's API, over HTTPS, for that one pull request. What goes to GitHub is the repository's owner and name and the branch's name, with your login, as when you run the command yourself. Nothing about your sessions, their names, folders or what they are asking goes. What GitHub keeps of the request is governed by GitHub's terms, and what `gh` does besides by its own settings.

From the answer it keeps the pull request's number, its title, whether it is open, a draft, merged or closed, and how many of its checks are failing, pending and passing. It keeps no check's name, link or log, no body, comment, author or review. The title is cleaned of control characters and of the characters that change the direction of text, and cut to 200 characters. The link to the pull request is made from the repository and the number, not taken from GitHub's answer. All of it is kept in memory only, for as long as a session is on that branch, and is never written to disk, to the history or to the Events log. When `gh` is not there, is not signed in, or does not answer, nothing of what it printed is kept or shown: Settings says which, in words of Agent Lookout's own.

The pull request is in the session list the API serves on this computer, and so on the dashboard, and in answers of `agent-lookout mcp` and `agent-lookout status --json` as its number and how its checks stand, never its title, as [The MCP server](#the-mcp-server) says. No email, webhook post, push or notification holds it.

### `osascript`

With notifications on, and no dashboard page open to show one, Agent Lookout shows a notification itself when a session starts waiting for you, or, if you chose those too, finishes, fails or ends. On macOS it does that by running `/usr/bin/osascript`, the program macOS provides for running AppleScript, except in the Mac app, which shows them as its own, as [From the server](#from-the-server) says. It gives it a script that never changes, which shows a notification, and two arguments for that script: the session's name and the reason, with what the session is asking when that is known, or what happened. The name is handed over as text to be shown. It is never made part of the script, so nothing in a name can run as AppleScript or be read as an option.

`osascript` is started directly, by that full path, never through a shell, with stdin closed and a 5 second timeout. It is not run on any other system, and never while notifications are off. [Terminal and iTerm2](#terminal-and-iterm2) says when it is also run for Jump. While it runs, for a fraction of a second, the name is one of that program's arguments, which other programs on this machine can read from the list of running processes. [Notifications](#notifications) says when notifications are on and what one holds.

### `open`, `xdg-open` and `rundll32.exe`

Only when you start it with `agent-lookout --open`, Agent Lookout runs `/usr/bin/open` on macOS, `xdg-open` on Linux, or on Windows `rundll32.exe url.dll,FileProtocolHandler` from `System32` in the Windows folder, once, to open its own address in your default browser. It gives it one argument, the address it listens on, such as `http://127.0.0.1:4777`, and nothing else. The program is started directly, never through a shell, with nothing connected to its input or output. Agent Lookout waits up to 10 seconds for it to end, to tell whether it worked, and never stops it: `xdg-open` can keep running until the browser it started is closed. Without `--open`, none of them is ever run.

### The Claude Code plugin and permission prompts

Agent Lookout can answer a Claude Code permission prompt only once you install its plugin in Claude Code, which you do yourself, in Claude Code, with `/plugin marketplace add Olanetsoft/agent-lookout` and `/plugin install agent-lookout@agent-lookout`. Claude Code records that in its own settings. Agent Lookout writes nothing under `~/.claude`, and `/plugin uninstall agent-lookout@agent-lookout` takes the plugin away again.

The plugin is one hook, a short `sh` script, which Claude Code runs as it is about to ask you for permission, while it shows its own prompt. The script checks for Agent Lookout's socket, `~/.agent-lookout/answer.sock`, or the one `AGENT_LOOKOUT_ANSWER_SOCKET` names, and with none there it exits at once and prints nothing. Otherwise it runs `curl` once, which sends the request over that socket, on this computer and nowhere else, and prints the answer, if there is one. On Windows Agent Lookout opens no socket, so the hook always finds none. What Claude Code hands the hook, and so what the request holds, is the session's ID, the path of its transcript, its working folder, its scratchpad folder, the ID of the prompt being answered, its permission mode, the tool's name, the tool's input, which is the whole command for a shell command and the whole file for a new file, and the permission rules Claude Code suggests. Agent Lookout reads it as it arrives, keeps the session's ID, the tool's name, what it shows of the input, and whether a subagent asks, and lets the rest go at once. It takes no request larger than 1 MiB. A request is held only once the registry file of a session Agent Lookout lists says it waits for permission, which it must say within 3 seconds, so a request for any other session is let go then, answering nothing, and is never shown.

Agent Lookout listens on that socket while it runs, unless you start it with `AGENT_LOOKOUT_ANSWER=off`, or with `AGENT_LOOKOUT_CLAUDE_HOME` set and `AGENT_LOOKOUT_ANSWER_SOCKET` not. It makes the folder with mode 700 if it is not there, and gives its own folder, `~/.agent-lookout`, mode 700 if others could open it. A folder that `AGENT_LOOKOUT_ANSWER_SOCKET` names, which it did not make, it never changes: if others can open it, answering is off, and Settings says why. It gives the socket mode 600, so only your user can connect. A browser cannot reach a socket. It removes the socket when it stops, and one left by a copy that crashed is replaced. A second copy that finds the first answering there leaves it be, and its Settings say so.

While the session waits, Agent Lookout holds the request. It reads the session's registry file, `~/.claude/sessions/<pid>.json`, again every half second, as an ordinary file it opens without following a link, and lets the request go, answering nothing, as soon as the file no longer says the session is waiting for permission, or says it is waiting again in a later wait, which is what happens when you answer in the session. It also lets it go when the hook's connection closes, when a newer request of the same session arrives, and after `AGENT_LOOKOUT_ANSWER_WAIT` seconds, 300 unless you set it. The prompt in the session then decides, as it would without the plugin. What it shows of the request, the whole command or the tool and its inputs, is held in memory while the request is held. It goes to the dashboard in the session list, and, in the Mac app, to the app's own notification of the wait and to its menu bar, and nowhere else: it is never written to disk and never put in an event, the history, the page's notifications, an email, a webhook post, a push, `agent-lookout status` or an answer of `agent-lookout mcp`. The browser and `npx agent-lookout` show it on the dashboard alone.

It answers when you press Allow or Deny on the dashboard, or in the Mac app on its notification of the wait or in its menu bar, or when a [permission rule](#permission-rules) you added decides. The page sends the session's ID, Agent Lookout's own ID for the request, and the answer, and the Mac app hands the same three to the same answer in its own process, with no request at all. Agent Lookout reads the registry file once more, and answers only if it still says the session is waiting for permission, in the same wait the request was shown in. The answer is one of two fixed texts, allow, or deny with a fixed sentence that says you denied it from Agent Lookout. It never changes the command or the tool's input, and never saves a permission rule, so each Allow allows that one request. Allow is offered only when the whole of what it allows is shown, and not for an edit or a new file, a plan or a question, a request too long to show whole or with more than two blank lines in a row, one with characters that cannot be shown as they are, or a command with right-to-left letters. The Events log keeps one event for each answer, with the session's ID and name, and whether it was allowed or denied, and nothing of what was asked. Claude Code's registry file can say the session waits for a second or two after the answer, so Agent Lookout keeps the session's ID, when that wait began and when it answered, in memory only, until the file says the session has moved on or for 10 seconds at most, and takes the wait as over from the answer.

#### In the Mac app

The Mac app's own notification of a wait, or of a reminder of one, which it shows while its window is closed, holds what Agent Lookout shows of a held request: for one short shell command on one line, the whole command as its text, under "Asks to run", with Deny and Allow, and for anything else the start of it, its first line, cut, with Deny. The menu bar's menu holds the same in a session's submenu, every line of the command and each other input, cut only when Allow is not offered. macOS keeps a notification in Notification Centre, and can show it on the lock screen, until you clear it or the app takes it down, which it does once a button on it is pressed, or once the request has been answered or let go. Before a press is answered, the app asks macOS whether the screen is locked, with `powerMonitor`, which reads it from macOS and sends nothing anywhere, and answers nothing while it is. [What is on screen](#what-is-on-screen) says how to keep these off the lock screen.

#### Permission rules

The [permission rules](docs/GUIDE.md#permission-rules) are rules you add in Settings, none until you do. A request Agent Lookout holds is put to them once the session's registry file says it waits for permission. A deny or an allow rule that decides it answers it at once, through the same path as a press, with the same checks and the same two fixed answers: it reads the registry file once more, answers only in the same wait, allows only what Allow would be offered for, and for Bash only one plain command. An ask rule, or none, leaves it held for you. The rules read only what Agent Lookout already holds of a request, the tool's name, the command and the names of the other inputs, in memory, and write none of it anywhere.

For each request a rule answers, Agent Lookout keeps the session's ID and name, the tool's name, whether it was allowed or denied, the rule as you wrote it, its tool and for Bash its command, and the time: as an event in the Events log, which the history keeps on disk with the other events, and in a list of the last 100 kept in memory for Settings, gone when Agent Lookout stops. Neither holds the command the session asked to run, or anything else of the request. The rules themselves are kept in [the settings file](#the-settings-file). With `AGENT_LOOKOUT_ANSWER=off` no rule answers anything.

Settings says whether a request has reached Agent Lookout. To tell, it notes when a Claude Code session waiting for permission sent no request within 5 seconds, which is what a session without the plugin does, and keeps that time and the time of the last request, in memory only.

### Another machine over SSH

Only when `AGENT_LOOKOUT_REMOTES` names other machines, Agent Lookout reads the sessions of the Agent Lookout running on each, through an SSH tunnel it opens with your own `ssh`. Unset, it never looks for `ssh`.

For each machine it runs `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ControlMaster=no -o ControlPath=none -L 127.0.0.1:<a free port>:127.0.0.1:<its port> -- <target>`, with the target you named, such as `dev@devbox.local`, after `--`, and with the port Agent Lookout listens on there, 4777 unless you give another. `ssh` is the one on your `PATH`, or in `/usr/bin`, `/opt/homebrew/bin` or `/usr/local/bin`, or the one `AGENT_LOOKOUT_SSH_BIN` names. It is started directly, by its full path, never through a shell, with nothing on its input, and given the environment Agent Lookout was started with, so it uses your `~/.ssh/config` and your ssh agent as it does in a terminal. With BatchMode it asks nothing, so Agent Lookout never sees, types or keeps a password, a passphrase or a key, and never answers a question about a host key. ssh runs no command on the other machine: it forwards one port on this computer's `127.0.0.1` to Agent Lookout's port on that machine's own `127.0.0.1`. With `ControlMaster=no` and `ControlPath=none` it makes a connection of its own every time, even when your ssh config shares connections, so it never joins an ssh you have open and never leaves one running in the background: the forward ends when that ssh ends. Agent Lookout keeps the last lines ssh writes about a failure, in memory, and shows the last of them on the machine's card in Sources, such as `Permission denied (publickey).` When ssh ends, it is started again after a wait, and when Agent Lookout stops, it ends it.

Through that port, every 2 seconds, it sends two requests and no others: `GET /api/health`, whose answer is the version of Agent Lookout there, and `GET /api/sessions`, whose answer is that machine's sessions and sources, as [docs/API.md](docs/API.md#get-apisessions) describes. The requests carry nothing of this computer's: no session, no setting, and not the `X-Agent-Lookout-Notifications` header, so they change nothing that machine's Agent Lookout believes about its own pages. Of the answer it keeps, in memory, what this computer shows of its own sessions: each session's name, folder, status, reason, the vendor's wording of a wait, its times, its app, its branch and repository name, its agent's name and whether its process still runs. It drops each session's process ID, Jump, Stop and links, and any permission request that machine holds for it, with what the request would run, as the answer is read, so nothing about a session there can act on this computer. It keeps each source there by its name and its state, and what each of its agents can report. It does not take that machine's time rules, or its word on whether it is in quiet hours: this computer's own decide when a session there is stale, and when a wait there is reminded of or held back here.

That includes what a waiting session there is asking, such as `Run: npm test`, when that machine's Agent Lookout sends it, which it does unless `AGENT_LOOKOUT_WAITING_TEXT=off` is set there. With `AGENT_LOOKOUT_WAITING_TEXT=off` set on this computer, it is dropped as it arrives, and a waiting session there shows its reason alone, as one here does. Otherwise it is shown here as a waiting session's is, and in the notifications on this computer, and is kept no longer than the wait, as here. Like a session's on this computer, a session there and its events go into the history kept on this computer, without what it is asking, and into an email, a webhook post or a push as the settings for those say.

### Settings

It reads forty-three settings from the environment: `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CLAUDE_BIN`, `AGENT_LOOKOUT_CLAUDE_FEED`, `AGENT_LOOKOUT_WAITING_TEXT`, `AGENT_LOOKOUT_CODEX_HOME`, `AGENT_LOOKOUT_ANTIGRAVITY_HOME`, `AGENT_LOOKOUT_STATUS_DIR`, `AGENT_LOOKOUT_HISTORY`, `AGENT_LOOKOUT_HISTORY_DIR`, `AGENT_LOOKOUT_SETTINGS_FILE`, `AGENT_LOOKOUT_NOTIFICATIONS`, `AGENT_LOOKOUT_TMUX`, `AGENT_LOOKOUT_TERMINAL_JUMP`, `AGENT_LOOKOUT_STOP`, `AGENT_LOOKOUT_PULL_REQUESTS`, `AGENT_LOOKOUT_ANSWER`, `AGENT_LOOKOUT_ANSWER_SOCKET`, `AGENT_LOOKOUT_ANSWER_WAIT`, `AGENT_LOOKOUT_PORT`, `AGENT_LOOKOUT_HOST`, `AGENT_LOOKOUT_REMOTES`, `AGENT_LOOKOUT_SSH_BIN`, Codex's own `CODEX_HOME`, the six email settings, `AGENT_LOOKOUT_EMAIL_TO`, `AGENT_LOOKOUT_SMTP_URL`, `AGENT_LOOKOUT_EMAIL_FROM`, `AGENT_LOOKOUT_EMAIL_AFTER`, `AGENT_LOOKOUT_EMAIL_EVENTS` and `AGENT_LOOKOUT_EMAIL_ASKING`, the four webhook settings, `AGENT_LOOKOUT_WEBHOOK_URL`, `AGENT_LOOKOUT_WEBHOOK_EVENTS`, `AGENT_LOOKOUT_WEBHOOK_AFTER` and `AGENT_LOOKOUT_WEBHOOK_ASKING`, the five ntfy settings, `AGENT_LOOKOUT_NTFY_URL`, `AGENT_LOOKOUT_NTFY_TOKEN`, `AGENT_LOOKOUT_NTFY_EVENTS`, `AGENT_LOOKOUT_NTFY_AFTER` and `AGENT_LOOKOUT_NTFY_ASKING`, and the five Pushover settings, `AGENT_LOOKOUT_PUSHOVER_TOKEN`, `AGENT_LOOKOUT_PUSHOVER_USER`, `AGENT_LOOKOUT_PUSHOVER_EVENTS`, `AGENT_LOOKOUT_PUSHOVER_AFTER` and `AGENT_LOOKOUT_PUSHOVER_ASKING`. The `agent-lookout` command reads one more, `AGENT_LOOKOUT_URL`, the address of the Agent Lookout to ask, and `agent-lookout status` reads tmux's own `TMUX`, only to tell whether tmux is running it. `AGENT_LOOKOUT_CLAUDE_HOME` replaces `~/.claude` in everything above, and `AGENT_LOOKOUT_ANTIGRAVITY_HOME` replaces `~/.gemini/antigravity-cli`. [Email](#email) says how the email settings are kept, [Webhook](#webhook) how the webhook's are, and [ntfy](#ntfy) and [Pushover](#pushover) how theirs are. The time rules and the permission rules are not in the environment: Agent Lookout keeps them in a file of its own, as [The settings file](#the-settings-file) says. The [guide](docs/GUIDE.md#settings-you-can-change) says what each setting does.

## What it never reads

- The `.key` files that sit beside the registry files in `~/.claude/sessions/`.
- Claude Code's transcripts, in `~/.claude/projects/` or anywhere else, beyond the end of a waiting session's own, as [Claude Code's transcripts](#claude-codes-transcripts) describes. Of what it reads there, it keeps one line about the tool the session is asking to use, and none of your prompts, the agent's replies, your code or the output of tools.
- Claude Code's settings, credentials, history and memory files.
- Codex's `auth.json`, `config.toml`, `history.jsonl`, its SQLite files (`*.sqlite`), its `log/` folder, `archived_sessions/` and compressed session files (`*.jsonl.zst`), and the Codex desktop app's `external_agent_session_imports.json` and `.codex-global-state.json`.
- In `~/.gemini`: `oauth_creds.json`, `google_accounts.json`, `settings.json`, `config/hooks.json`, `history/` and any `history.jsonl`, and in the Antigravity CLI's folder its SQLite files, `conversation_summaries.db` and `conversations/*.db` with their `-wal` and `-shm` files, which are only looked up for when they were last changed, `transcript_full.jsonl`, `cli.log` and `log/`, `jetski_state.pbtxt`, `jetbox_summaries_proto.pb`, `installation_id`, `updater/`, `presence/`, `annotations/`, `implicit/`, `crashes/` and the other files in each conversation's folder. Nor the Antigravity desktop app's folder, `~/.gemini/antigravity`, or the Antigravity IDE's.
- In a git repository, anything but the `.git` file, `HEAD` and a worktree's `commondir` described under [Git repositories](#git-repositories), and with `AGENT_LOOKOUT_PULL_REQUESTS=on`, the `config` and the remote's `HEAD` described under [`gh`](#gh).
- `gh`'s configuration, its login and any token, and your global git configuration.
- Your `~/.ssh` folder: keys, `known_hosts` and ssh config. For the machines `AGENT_LOOKOUT_REMOTES` names, `ssh` reads them itself, as it does in a terminal.
- The files of any other application.

It runs no program but the `claude` binary, for `claude agents` and, only when you stop a background job, `claude stop`, `ps`, `tmux`, on macOS `osascript`, to show a notification and to bring a tab of Terminal or iTerm2 forward, only for `--open`, `open`, `xdg-open` or `rundll32.exe`, only with `AGENT_LOOKOUT_PULL_REQUESTS=on`, `gh`, and, only for the machines `AGENT_LOOKOUT_REMOTES` names, `ssh`, as [Another machine over SSH](#another-machine-over-ssh) describes. The Mac app also runs `ditto` and `plutil` to unpack and check a newer version of itself, and, only when you press Install and Restart, a short `sh` script that puts it in place, as [Updates (Mac app only)](#updates-mac-app-only) describes. It runs no git command. The plugin's hook, which Claude Code runs and not Agent Lookout, runs `curl`. It never writes to `~/.claude`, to the Codex folder, to `~/.gemini`, to the folder of status files, to any git repository or to any agent tool's files, and it never sends input to a session. It never makes, renames or deletes a status file. It changes three things outside itself, and each only when you ask: which tmux pane, window and session are selected, or which tab of Terminal or iTerm2 is in front, when you press Jump, when you press Stop and confirm, whether a Claude Code session's process runs, as [Stopping a session](#stopping-a-session) describes, and, when you press Allow or Deny, or a [permission rule](#permission-rules) you added decides it, the answer to that one permission prompt, as [The Claude Code plugin and permission prompts](#the-claude-code-plugin-and-permission-prompts) describes. It never sends a session anything else.

## Network

With email, the webhook, ntfy, Pushover and other machines off, which is the default, the only network traffic Agent Lookout's own code makes is between its own server and the dashboard in your browser, or the `agent-lookout status` and `agent-lookout mcp` commands, on the same machine. With email set up, it also connects to the mail server you named, once for each email, as [Email](#email) describes. With a webhook address set, it also connects to that address, once for each post, as [Webhook](#webhook) describes. With an ntfy topic set, it also connects to that topic's server, once for each push, as [ntfy](#ntfy) describes, and with a Pushover token and key set, to `api.pushover.net`, once for each push, as [Pushover](#pushover) describes. A push that Send a test in Settings asks for is one more of these. With `AGENT_LOOKOUT_PULL_REQUESTS=on`, it runs `gh`, which connects to GitHub, at most once every 2 minutes for each repository and branch your sessions are on, as [`gh`](#gh) describes. With other machines named in `AGENT_LOOKOUT_REMOTES`, your own `ssh` connects to each, and Agent Lookout sends its two requests to Agent Lookout there through that connection, as [Another machine over SSH](#another-machine-over-ssh) describes. Agent Lookout itself connects only to the end of the tunnel on this computer's `127.0.0.1`. One more connection never leaves the machine either: before `npm start` or `agent-lookout` begins listening, it connects once to its own address and port to see whether another program already answers there, and sends nothing over that connection. There is no telemetry, no analytics, no crash reporting and no account. There is no update check either, except in the Mac app, which asks GitHub about once a day whether a newer version of it is out, as [Updates (Mac app only)](#updates-mac-app-only) describes. Fonts and scripts are bundled, so the page loads nothing from the internet.

Started with `npx agent-lookout`, npm itself contacts its registry: to download the package the first time, and each time after to ask whether a newer version is out, as it does for any package it runs. That is npm's own traffic, not Agent Lookout's. Installed with `npm install -g agent-lookout` and started as `agent-lookout`, npm is not involved.

The `claude agents` command is Claude Code's own program, and it may contact Anthropic the way it does for anyone who runs it. Agent Lookout sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_AUTOUPDATER` for each run, to ask Claude Code to skip its update check, usage reporting and error reporting, and runs the command seldom. Anything else that program does is governed by Claude Code's settings and terms. To stop Agent Lookout running it, set `AGENT_LOOKOUT_CLAUDE_FEED=off`. Sessions then come from the registry alone, and background jobs whose process has ended are not listed.

`npm start` and `agent-lookout` listen on a loopback address only: `127.0.0.1`, or `::1` if you set `AGENT_LOOKOUT_HOST`. They refuse to start on any other address. `npm run dev` uses Vite's dev server, which listens on localhost unless you pass it `--host`.

The API refuses any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`, any request whose `Origin` header names another site, and any request the browser marks as cross-site. It sends no CORS headers. Together these stop a website you visit from reading your session names and paths through your browser.

Each request the dashboard makes carries one header of Agent Lookout's own, `X-Agent-Lookout-Notifications`, which says which events that page has notifications on for: `off`, `on`, which means a session starting to wait, or `on; events=` followed by the names of the events, such as `on; events=needs-you,finished`. It holds nothing else. It goes to Agent Lookout's own server and nowhere else. [Notifications](#notifications) says what the server does with it. The request the Jump button sends for a session in tmux, Terminal or iTerm2 carries one more, `X-Agent-Lookout-Action: jump`, which names what is asked for, and the request the Clear history button in Settings sends carries `X-Agent-Lookout-Action: clear-history`, with an empty body. The request Stop session sends carries `X-Agent-Lookout-Action: stop` and the session's ID, and the one that ends the sessions left running carries `X-Agent-Lookout-Action: clean-up`, with each session's ID and the moment its idle began. The one Allow and Deny send carries `X-Agent-Lookout-Action: answer`, with the session's ID, Agent Lookout's own ID for the request and the answer. The one the Time rules card sends carries `X-Agent-Lookout-Action: time-rules`, with the three rules, and the one the Permission rules card sends carries `X-Agent-Lookout-Action: permission-rules`, with one change to the rules. Send a test, on the ntfy and Pushover cards, sends `X-Agent-Lookout-Action: phone-test`, with `{"channel": "ntfy"}` or `{"channel": "pushover"}`. In the Mac app, the Updates card also sends `X-Agent-Lookout-Action: check-for-updates` and `install-update`, each with the body `{}`, and `update-setting`, with `{"automatic": true}` or `false`. The Menu bar card sends `menu-bar-setting`, with `{"show": true}` or `false`.

The local server has no password. While Agent Lookout is running, another program on the same machine can request the same data, and on a shared computer so can another user account. Such a program can also send that header, and so turn the notifications the server shows on or off. It can also ask the server to select a tmux pane, or bring a tab of Terminal or iTerm2 forward, as the Jump button does, to clear the history, as the Clear history button does, to stop a Claude Code session, or end the sessions left running, as Stop and End all… do, with every check of [Stopping a session](#stopping-a-session), to answer a permission prompt Agent Lookout is holding, as Allow and Deny do, to change the time rules or the permission rules, as Settings does, which includes adding an allow rule that then answers prompts without a press, and to send a test push, as Send a test does, which counts toward the hour's 20 for that channel. A program that can do that can already type into your terminal, but on a shared computer another account could not. The Mac app opens no port, so there only its own window can ask any of this. It shares the settings file, though. A program running as you can write `~/.agent-lookout/settings.json`, or start `npx agent-lookout` beside the app and ask that copy to change a rule, and the Mac app puts the time rules and permission rules the file then holds in force at its next poll, an allow rule included. `AGENT_LOOKOUT_STOP=off` takes stopping away, and `AGENT_LOOKOUT_ANSWER=off` takes answering away.

For a session in VS Code, the Jump button opens a `vscode://` address that contains the session ID. Your operating system hands it to VS Code. For a session in tmux, the Jump button sends a request that holds the session's ID to Agent Lookout's own server, which selects the pane as described under [`tmux`](#tmux). For a session in Terminal or iTerm2 it sends the same request, and the server brings the tab forward as described under [Terminal and iTerm2](#terminal-and-iterm2). That request, the one Clear history sends, the ones Stop session and End send, the one Allow and Deny send, the ones the Time rules and Permission rules cards send and the one Send a test sends are the eight that change anything, with the Mac app's four for its updates and its menu bar. The server refuses them from any website, though not from another program on this machine, as the paragraph above says, and the Mac app answers its four only for its own window. [SECURITY.md](SECURITY.md) lists its checks.

## Notifications

Notifications are off until you turn them on in Settings, or start Agent Lookout with `AGENT_LOOKOUT_NOTIFICATIONS=on`, which turns on only the ones the server shows, and only for a session starting to wait. Pressing Turn on notifications is the only thing in Agent Lookout that asks your browser for permission to show them.

Once they are on, Settings lists four events, each with its own switch: a session starting to wait for you, finishing, failing, and ending, which is leaving the list without having finished or failed. The first is on and the other three are off until you change them. A notification is made only for the events switched on.

A notification is made in one of two ways. While a dashboard page is open, the page makes it through your browser. With no page open, the local server shows it on this machine itself. A page that is open shows it and the server does not, unless the page's requests are held up for more than about 4 seconds, when both can show one. The [guide](docs/GUIDE.md#notifications) says when that happens.

### From the dashboard page

With notifications on, when one of the events switched on happens, the dashboard page makes a notification through the browser's Notifications API, and the browser hands it to the operating system to show. It holds:

- the session's name, as its title, followed by "on" and the machine's name for a session on another machine
- what happened, as its text: for a session that starts waiting, the reason, "Waiting for permission", "Asked you a question" or "Waiting for you", followed, for a Claude Code session, by what it is asking when its transcript says, as in "Waiting for permission: Run: npm test", and otherwise "Finished", "Failed" or "Ended"
- a tag that is not shown, which the browser uses to keep one notification for each session: `agent-lookout:claude-code:` followed by the session's ID, or by its job ID or process ID when it has no session ID, for Codex `agent-lookout:codex:` followed by the session's ID, for a status file `agent-lookout:status-files:` followed by the file's name, and for a session on another machine `agent-lookout:remote:` followed by the machine's name and the session's own tag there

It holds none of Claude Code's own wording for the wait, and not the session's folder. What a session is asking can hold a command, which can name any path, a web address, or a file: relative to the session's folder when the file is inside it, and the file's full path when it is outside it, which can name your home folder. No push service, no service worker and no network request is involved. The page that is open in your browser makes the notification, and can do so only while it is open.

The page closes the notification of a wait when its session stops waiting, when you turn notifications or that event off, and when the page is closed or reloaded. It cannot close one if the browser crashes or is forced to quit first. It never closes one that says Finished, Failed or Ended: that stays until you clear it, or until a later notification for the same session takes its place. While Agent Lookout is stopped, or cannot read Claude Code's sessions, the page cannot tell that a session has moved on, so a notification already showing stays. A notification stays in the system's notification list, Notification Centre on macOS, until the page closes it or you clear it. What the browser and the operating system keep of a notification, in memory or on disk, is theirs, and Agent Lookout cannot read it back.

When a dashboard tab is closed or reloaded, it tells the other dashboard tabs open at the same address, in the same browser, which sessions' notifications it closed, so that one of them can show them again. That message holds session IDs, goes over the browser's `BroadcastChannel` and does not leave the browser.

The browser gives its permission to the address, such as `localhost:5173`, not to Agent Lookout. Another program served at the same address later can show notifications without asking, and can read or change the values listed under Storage. To take the permission back, remove it for that address in the browser's site settings.

### From the server

The local server shows notifications on this machine too. When one of the events switched on happens and no dashboard page is open to show it, the server runs `osascript`, as [described above](#osascript), and macOS shows the notification. It holds:

- the session's name, as its title, with the machine's name for a session on another machine
- what happened, as its text, in the same wordings, with what a waiting session is asking

It holds none of Claude Code's own wording and no tag. As in the page's, what a session is asking can hold a command, a web address, or a file's full path when the file is outside the session's folder. No network request is involved. On any system but macOS the server shows nothing. In the Mac app, the server shows them as the app's own notifications instead, and runs no `osascript` for them. macOS files them under Agent Lookout, and a click on one brings the app's window forward, on the session's details for a wait. For a wait whose permission request Agent Lookout holds, the app's notification says what the request asks instead, with Deny and Allow, as [In the Mac app](#in-the-mac-app) says.

### Reminders and summaries

With the [time rules](docs/GUIDE.md#time-rules) on, the page and the server make two more kinds of notification, in the same two ways and by the same switches. A reminder of a long wait has the session's name as its title, with the machine's name for a session on another machine, and as its text how long it has waited and for what, with what it is asking after it, as in "Has waited 10 minutes for permission: Run: npm test". On the page it takes the place of the wait's own, with its tag. With Remind again on, the same reminder is made again at each interval while the session still waits, with how long it has waited by then, on the page each taking the place of the last, and none once the wait is answered or the session ends. The summary made when quiet hours end has "While quiet" as its title, and as its text the names of the sessions that waited, finished, failed or ended while they held, each with the machine's name for a session on another machine, with how long each waited, as in "checkout-flow waited 25 minutes and billing-webhooks finished". It holds nothing a session was asking. The page's has the tag `agent-lookout:while-quiet`, and stays until you clear it. During quiet hours neither the page nor the server makes any notification.

The server shows them only while notifications are on, and only for the events switched on, and it learns both from the dashboard. Each request a dashboard page makes says, in the `X-Agent-Lookout-Notifications` header, which events are on when that page's choice is on and the browser allows notifications, and `off` otherwise. The server keeps the last thing a page said, in memory, for as long as it runs, and never writes it to disk. Before any page has said anything it is off, unless `AGENT_LOOKOUT_NOTIFICATIONS=on` was set when Agent Lookout started, which turns it on for a session starting to wait. A page that says `off` after that turns it off all the same. The header is listened to only on a request that passes the checks described under [Network](#network), so a page at another address cannot set it.

While a page that has notifications on is open and asking every 2 seconds, the page shows each notification and the server does not. The server holds its own back for a few seconds when such a page has just been asking, and drops it once that page has fetched the sessions.

A notification the server shows differs from the browser's:

- Outside the Mac app, macOS shows it as coming from Script Editor, which is how it labels whatever `osascript` shows. In the Mac app, macOS shows it as coming from Agent Lookout. The browser's permission and its notification settings do not apply to it. On macOS 26.5, where this was checked in the system's log, macOS delivered it without first asking whether Script Editor may show notifications.
- Outside the Mac app, it holds nothing that could open the session or the dashboard, and what a click on it does has not been checked. In the Mac app a click brings the window forward, on the session's details for a wait or a reminder of one.
- Outside the Mac app, the server cannot take it down. It stays in Notification Centre after the session stops waiting, and after Agent Lookout stops, until you clear it. The Mac app takes down one with Deny and Allow once a button on it is pressed, or once its request has been answered or let go.

## Email

Email notifications are off until you set them up, and they can be set up only in the environment Agent Lookout starts with: `AGENT_LOOKOUT_EMAIL_TO`, the one address emails go to, and `AGENT_LOOKOUT_SMTP_URL`, the mail server they go through, with the user name and password to sign in with. `AGENT_LOOKOUT_EMAIL_FROM`, the sender's address, `AGENT_LOOKOUT_EMAIL_AFTER`, how long a wait lasts before it is emailed, `AGENT_LOOKOUT_EMAIL_EVENTS`, what is emailed, and `AGENT_LOOKOUT_EMAIL_ASKING`, whether the email for a wait says what the session is asking, can be left out. While either of the first two is unset, no email is sent, the mail library is not loaded and no connection is opened. The same holds when any of the six is set to something Agent Lookout cannot read. The [guide](docs/GUIDE.md#email) says how to set them up and how to turn them off.

### What an email holds

An email is plain text. Its subject is the session's name followed by the reason, in the words the dashboard uses, such as "checkout-flow is waiting for permission", or by what happened, such as "billing-webhooks finished", "billing-webhooks failed" or "billing-webhooks ended". Its body holds:

- that same sentence
- how long the session has waited, and the time on this computer's clock when it began, or the time on that clock when Agent Lookout saw it finish, fail or end
- the name of the session's project folder: the last part of its path, never the path
- the app it runs in, such as VS Code or Terminal, when it is known
- the agent, such as Claude Code or Codex, or the agent a status file names
- one line saying Agent Lookout sent it and how to stop these emails

With the [time rules](docs/GUIDE.md#time-rules) on, two more kinds of email can be sent. A reminder of a long wait is the email of a wait with a subject that says how long it has waited, such as "checkout-flow has waited 10 minutes for permission", and a line on how often reminders come. With Remind again on, the same email goes again at each interval while the session still waits, saying how long by then, and holds nothing more than the first. The summary sent when quiet hours end has the subject "While quiet:" followed by the first few sessions' names and what happened, and in its body, one line for each session that waited, finished, failed or ended while they held, with how long it waited and from when, or when it finished, failed or ended, at most 50, and a line on where quiet hours are set. A summary holds the sessions' names alone, nothing of what they were asking and no folder.

It holds no folder path, no prompt, none of Claude Code's own wording for the wait, no link, no image, nothing that reports back when it is opened and, unless you set `AGENT_LOOKOUT_EMAIL_ASKING=on` (below), nothing of what a waiting session is asking. Its headers are the ones the mail library writes for every email: From, with the name Agent Lookout and the sender's address, To, Subject, Date, Message-ID, and three that say it is plain text in UTF-8. A session's name and its folder's name are cut to 80 characters, and anything in them that would end a line becomes a space, so nothing in a name can add a header or a recipient.

#### What a waiting session is asking, in an email

Start Agent Lookout with `AGENT_LOOKOUT_EMAIL_ASKING=on`, and the email for a wait also holds one more line, before the folder's name: `Asking:` followed by what the session is asking, such as `Asking: Run: npm test`. It is the line the Needs you panel shows, as [Claude Code's transcripts](#claude-codes-transcripts) describes, cleaned and cut in the same way: control characters taken out, made one line, and cut to 200 characters. It can hold:

- a command, which can name any path, a server or a password typed on the command line
- a web address, which your mail app may show as a link
- a file's path, which is the full path, and can name your home folder, when the file is outside the session's folder
- the question the session put to you, in the session's own words

It is never in the subject, and never in an email for a session that finished, failed or ended. Only a Claude Code session has one, and only when its transcript says, so an email for any other wait is the same as with the setting off. It is taken from the session list at the moment the email is sent, and is not kept for it: a wait that has not yet been emailed is remembered by its session's ID and the time it began alone, so a session that moves on to another tool while it waits is emailed with what it asks when the email goes. Once the email is handed to the mail server, Agent Lookout holds nothing of it. `AGENT_LOOKOUT_EMAIL_ASKING=off`, or leaving it out, puts nothing of it in an email, and anything else turns email off until it is corrected.

### Where it goes, and how

Each email goes to the one address in `AGENT_LOOKOUT_EMAIL_TO`, and to no other. It comes from the address in `AGENT_LOOKOUT_EMAIL_FROM`, or from the same address when that is not set. It goes through the mail server in `AGENT_LOOKOUT_SMTP_URL`, which then delivers it the way it delivers any email.

For each email Agent Lookout looks up the server's name, opens a connection to it, signs in with the user name and password from `AGENT_LOOKOUT_SMTP_URL`, hands the email over and closes the connection. It greets the server as `[127.0.0.1]`, not by this computer's name. The server sees the network address the connection comes from, as any server you connect to does. The connection is encrypted with TLS: from the first byte when the address begins `smtps://`, and when it begins `smtp://`, the server must offer to switch to TLS before anything is sent, or nothing is sent. The server's certificate is always checked, even when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Only to a mail server on this machine, at `127.0.0.1` or `localhost`, does `smtp://` go without TLS, since nothing leaves the machine on the way to it.

### When

`AGENT_LOOKOUT_EMAIL_EVENTS` names the events that are emailed, from `needs-you`, `finished`, `failed` and `ended`, and is `needs-you` alone unless you set it. An email is sent for a wait that begins after Agent Lookout started, once it has lasted the delay, which is one minute unless `AGENT_LOOKOUT_EMAIL_AFTER` says otherwise, if the session is still waiting then. A wait answered before then sends nothing, and so does a session that was already waiting when Agent Lookout started. Each wait sends one email at most, apart from reminders. With the long wait reminder on, a wait is also reminded of once it has waited the rule's minutes, unless its email went only after that. That includes a wait already open when Agent Lookout started, if it had not waited that long yet. Each change to the minutes while it waits can bring one more, once it has waited the new number. With Remind again on, a wait still open is reminded of again each time the interval passes after that, and never once the wait is answered or the session ends. After the computer has slept, or when quiet hours end, one email goes, not one for each interval missed. A wait already past the minutes when Agent Lookout started is reminded of at the next interval. With the others set, an email is sent as soon as a session is seen to finish, fail or end, and none for a session that had already finished or failed when Agent Lookout started. An email that could not be sent is not tried again. At most 20 are sent in any hour, whatever they are for. Past that, none goes until the hour has passed. Claude Code sessions and sessions from a status file can be seen waiting; a Codex session never can, so it never sends one for a wait.

The button and the switches for notifications in Settings do not turn emails on or off, or choose what is emailed. To stop them, start Agent Lookout again without `AGENT_LOOKOUT_EMAIL_TO`.

### What is kept

The settings, password included, live in the environment of the Agent Lookout process, as every setting on this page does. Programs running as your user on this machine can read a process's environment. Agent Lookout never writes them to a file, never sends them to the dashboard, and never prints them. When one cannot be read, it prints one line that names the setting and never its value. A setting typed in front of the command can be kept by your shell in its history file. The guide shows how to keep the password out of it.

Through `GET /api/email`, the dashboard learns whether email is on, the address with all but its first letter before the @ hidden, such as `n…@example.com`, the events that are emailed, the delay, whether the email for a wait says what the session is asking, never what it was asking, and when the last email was tried, with whether it was sent or a short reason why not. It never learns the server, the user name or the password. That, and the times of the emails of the last hour, are held in memory and are gone when Agent Lookout stops.

Once an email has been handed to the mail server, Agent Lookout has no hold on it. The mail server you named and the mailbox it is delivered to keep the email, and whatever they record about it, for as long as their own settings and terms say. Agent Lookout cannot recall or delete it.

## Webhook

Webhook posts are off until you set them up, and they can be set up only in the environment Agent Lookout starts with: `AGENT_LOOKOUT_WEBHOOK_URL`, the one address posts go to. `AGENT_LOOKOUT_WEBHOOK_EVENTS`, what is posted, `AGENT_LOOKOUT_WEBHOOK_AFTER`, how long a wait lasts before it is posted, and `AGENT_LOOKOUT_WEBHOOK_ASKING`, whether the post for a wait says what the session is asking, can be left out. While the address is unset, nothing is posted and no connection is opened. The same holds when any of the four is set to something Agent Lookout cannot read. The [guide](docs/GUIDE.md#webhook) says how to set it up and how to turn it off.

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

With the [time rules](docs/GUIDE.md#time-rules) on, two more kinds of post can be sent. A reminder of a long wait is the post of a wait, with the line saying how long it has waited, such as "checkout-flow has waited 10 minutes for permission", and one more field, `"reminder": true`. With Remind again on, the same post goes again at each interval while the session still waits, saying how long by then, with one field more, `"repeat"`, a count of the intervals since the first reminder's time, which can skip numbers after a sleep. The summary sent when quiet hours end looks like this:

```json
{
  "text": "While quiet: checkout-flow waited 25 minutes and billing-webhooks finished",
  "event": "quiet-summary",
  "from": "2026-10-05T21:00:00.000Z",
  "to": "2026-10-06T07:00:00.000Z",
  "items": [
    {
      "event": "needs-you",
      "session": {
        "name": "checkout-flow",
        "agent": "Claude Code",
        "folder": "storefront",
        "app": "VS Code"
      },
      "at": "2026-10-05T22:10:00.000Z",
      "waitedSeconds": 1500,
      "times": 1
    },
    {
      "event": "finished",
      "session": {
        "name": "billing-webhooks",
        "agent": "Claude Code",
        "folder": "billing",
        "app": "Terminal"
      },
      "at": "2026-10-06T00:12:00.000Z"
    }
  ]
}
```

`from` and `to` are when Agent Lookout saw the quiet hours begin and end, and `items` holds each session that waited, finished, failed or ended while they held, at most 100, with `more` saying how many were left out. A session that waited and then finished, failed or ended is one item, whose `then` says what it did and when, as `{"event": "ended", "at": "..."}`. Each item's `session` holds what a post's always does, and no item holds anything a session was asking.

It holds no folder path, no prompt, none of Claude Code's own wording for the wait, no session ID or process ID, nothing about this computer and, unless you set `AGENT_LOOKOUT_WEBHOOK_ASKING=on` (below), nothing of what a waiting session is asking. Its headers are `Content-Type: application/json`, `Content-Length`, `User-Agent: Agent Lookout/` followed by the version, `Host` and `Connection: close`. It carries no cookie and no other header.

A session's name, its folder's name and its agent's are each cut to 80 characters, and anything in them that would end a line becomes a space. In `text`, `<`, `>` and `&` are written as `&lt;`, `&gt;` and `&amp;`, which Slack shows as the characters themselves, and each `@` is followed by a space of no width, so nothing in a name can mention someone, ping a channel or make a link that shows other words than its address. The JSON is written whole by Node's own writer, so nothing in a name can add a field. Slack does show a web address written out in a name as a link to that address.

#### What a waiting session is asking, in a post

Start Agent Lookout with `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, and the post for a wait also says what the session is asking, in two places: in `text`, after the reason, as in `checkout-flow is waiting for permission: Run: npm test (4m 12s, storefront, VS Code, Claude Code)`, and in a field of its own, `asking`, after `reason`, such as `"asking": "Run: npm test"`. It is the line the Needs you panel shows, as [Claude Code's transcripts](#claude-codes-transcripts) describes, cleaned and cut in the same way: control characters taken out, made one line, and cut to 200 characters. It can hold:

- a command, which can name any path, a server or a password typed on the command line
- a web address, which Slack shows as a link to that address
- a file's path, which is the full path, and can name your home folder, when the file is outside the session's folder
- the question the session put to you, in the session's own words

In `text` it is written as names are, with `<`, `>` and `&` as entities and each `@` followed by a space of no width, so it cannot mention someone or ping a channel. In `asking` it is as the dashboard shows it. It is never in a post for a session that finished, failed or ended, and a post without it has no `asking` field. Only a Claude Code session has one, and only when its transcript says. It is taken from the session list at the moment the post is sent, and is not kept for it, as for email. Once the post is sent, Agent Lookout holds nothing of it. Everyone who can read the channel sees it. `AGENT_LOOKOUT_WEBHOOK_ASKING=off`, or leaving it out, puts nothing of it in a post, and anything else turns the webhook off until it is corrected. It is separate from `AGENT_LOOKOUT_EMAIL_ASKING`, so it can go to your own mailbox and stay out of a channel others read.

### Where it goes, and how

Each post goes to the one address in `AGENT_LOOKOUT_WEBHOOK_URL`, and to no other. For each post Agent Lookout looks up the address's host, opens a connection to it, sends the post, reads the status of the answer and closes the connection. The rest of the answer is read and dropped. A redirect is not followed, and a post is never tried again. The address must begin `https://`, so the connection is encrypted with TLS, and the certificate is always checked. Only to an address on this computer, at `127.0.0.1` or `localhost`, may it begin `http://`, since nothing leaves the machine on the way to it. The service at the address sees the network address the connection comes from, as any server you connect to does.

### When

`AGENT_LOOKOUT_WEBHOOK_EVENTS` names the events that are posted, from `needs-you`, `finished`, `failed` and `ended`, and is `needs-you` alone unless you set it. A post goes for a wait that begins after Agent Lookout started, once it has lasted the delay, which is one minute unless `AGENT_LOOKOUT_WEBHOOK_AFTER` says otherwise, if the session is still waiting then. A wait answered before then sends nothing, and so does a session that was already waiting when Agent Lookout started. Each wait sends one post at most, apart from reminders. With the long wait reminder on, a wait is also reminded of once it has waited the rule's minutes, unless its post went only after that. That includes a wait already open when Agent Lookout started, if it had not waited that long yet. Each change to the minutes while it waits can bring one more, once it has waited the new number. With Remind again on, a wait still open is reminded of again each time the interval passes after that, and never once the wait is answered or the session ends. After the computer has slept, or when quiet hours end, one post goes, not one for each interval missed. A wait already past the minutes when Agent Lookout started is reminded of at the next interval. With the others set, a post goes as soon as a session is seen to finish, fail or end, and none for a session that had already finished or failed when Agent Lookout started. A post that could not be sent is not tried again. At most 20 posts are tried in any hour, whatever they are for, counted apart from emails. Past that, none goes until the hour has passed. These are the rules emails follow, and the two share one copy of them.

The button and the switches for notifications in Settings do not turn posts on or off, or choose what is posted. To stop them, start Agent Lookout again without `AGENT_LOOKOUT_WEBHOOK_URL`.

### What is kept

Anyone who has the address can post to the channel behind it, so it is kept like a password. It lives in the environment of the Agent Lookout process, as every setting on this page does, and programs running as your user on this machine can read a process's environment. Agent Lookout never writes it to a file, never sends it to the dashboard, and never prints it. When a webhook setting cannot be read, it prints one line that names the setting and never its value. A setting typed in front of the command can be kept by your shell in its history file. The guide shows how to keep the address out of it.

Through `GET /api/webhook`, the dashboard learns whether the webhook is on, the host the posts go to and nothing else of the address, such as `hooks.slack.com`, the events that are posted, the delay, whether the post for a wait says what the session is asking, never what it was asking, and when the last post was tried, with whether it was sent or a short reason why not. That, and the times of the posts of the last hour, are held in memory and are gone when Agent Lookout stops. Settings shows the host in full, so with a service that puts its secret in the host, keep Settings out of screenshots too.

Once a post has been sent, Agent Lookout has no hold on it. The service at the address, such as Slack or Discord, keeps the message, and whatever it records about it, for as long as its own settings and terms say, and shows it to everyone who can read that channel. Agent Lookout cannot recall or delete it.

## ntfy

Pushes through [ntfy](https://ntfy.sh) are off until you set them up, and they can be set up only in the environment Agent Lookout starts with: `AGENT_LOOKOUT_NTFY_URL`, the address of one ntfy topic, on ntfy.sh or on a server of your own. `AGENT_LOOKOUT_NTFY_TOKEN`, an access token for the topic, `AGENT_LOOKOUT_NTFY_EVENTS`, what is pushed, `AGENT_LOOKOUT_NTFY_AFTER`, how long a wait lasts before it is pushed, and `AGENT_LOOKOUT_NTFY_ASKING`, whether the push for a wait says what the session is asking, can be left out. While the address is unset, nothing is pushed and no connection is opened. The same holds when any of the five is set to something Agent Lookout cannot read. The [guide](docs/GUIDE.md#ntfy) says how to set it up and how to turn it off.

### What a push holds

A push is one request with a body of JSON, such as:

```json
{
  "topic": "your-topic",
  "title": "checkout-flow is waiting for permission",
  "message": "4m 12s · storefront · VS Code · Claude Code",
  "priority": 4,
  "tags": ["hourglass"]
}
```

It holds:

- `topic`: the topic at the end of `AGENT_LOOKOUT_NTFY_URL`.
- `title`: the session's name and what happened, in the words the dashboard uses: "checkout-flow is waiting for permission", "checkout-flow asked you a question" or "checkout-flow is waiting for you", and "billing-webhooks finished", "billing-webhooks failed" or "billing-webhooks ended".
- `message`: for a wait, how long it had waited when it was pushed, and for a session that finished, failed or ended, the time on this computer's clock when Agent Lookout saw it, as in "Seen at 14:02"; then the name of the session's project folder, which is the last part of its path and never the path, the app it runs in and its agent, each left out when it is not known.
- `priority`: 4, ntfy's high, for a wait, a reminder of one and the test, which the ntfy app shows with a long vibration, and 3, ntfy's default, for the rest.
- `tags`: the name of one emoji ntfy shows before the title: `hourglass` for a wait, a reminder or the test, `white_check_mark` for finished, `x` for failed and `stop_sign` for ended. The summary has none.

With the [time rules](docs/GUIDE.md#time-rules) on, two more kinds of push can be sent. A reminder of a long wait has a title that says how long it has waited, such as "checkout-flow has waited 10 minutes for permission", and a message that says since when, as in "Since 14:01 · storefront · VS Code · Claude Code". With Remind again on, the same push goes again at each interval while the session still waits, saying how long by then. The summary sent when quiet hours end has the title "While quiet", and as its message the names of the first four sessions that waited, finished, failed or ended while they held, with how long each waited, and how many more there were, as in "checkout-flow waited 25 minutes and billing-webhooks finished". It holds nothing a session was asking and no folder.

It holds no folder path, no prompt, none of Claude Code's own wording for the wait, no session ID or process ID, no link, not the dashboard's address, nothing about this computer and, unless you set `AGENT_LOOKOUT_NTFY_ASKING=on` (below), nothing of what a waiting session is asking. Its headers are `Content-Type: application/json`, `Content-Length`, `User-Agent: Agent Lookout/` followed by the version, `Authorization: Bearer` followed by the token only when `AGENT_LOOKOUT_NTFY_TOKEN` is set, `Host` and `Connection: close`. It carries no cookie and no other header. A session's name, its folder's name and its agent's are each cut to 80 characters, and anything in them that would end a line becomes a space. The title is cut to 250 characters and the message to 1,024. The JSON is written whole by Node's own writer, so nothing in a name can add a field, and it is not marked as Markdown, so ntfy shows the words as they are. The ntfy apps may show a web address written out in a name as a link.

#### What a waiting session is asking, in a push

Start Agent Lookout with `AGENT_LOOKOUT_NTFY_ASKING=on`, and the push for a wait, and each reminder of it, begins its message with one more line: `Asking:` followed by what the session is asking, such as `Asking: Run: npm test`. It is the line the Needs you panel shows, as [Claude Code's transcripts](#claude-codes-transcripts) describes, cleaned and cut in the same way: control characters taken out, made one line, and cut to 200 characters. It can hold a command, which can name any path, a server or a password typed on the command line, a web address, a file's full path when the file is outside the session's folder, or the question the session put to you. It is never in the title, never in a push for a session that finished, failed or ended, and never in the summary. Only a Claude Code session has one, and only when its transcript says. It is taken from the session list at the moment the push is sent, and is not kept for it, as for email. Everyone who can read the topic sees it, and the server keeps it as long as it keeps the push. `AGENT_LOOKOUT_NTFY_ASKING=off`, or leaving it out, puts nothing of it in a push, and anything else turns ntfy off until it is corrected. It is separate from the other channels' settings for it.

### Where it goes, and how

Each push is posted to the server named in `AGENT_LOOKOUT_NTFY_URL`, at the address before the topic, which is `https://ntfy.sh/` for a topic on ntfy.sh, with the topic in the body, and to no other address. For each push Agent Lookout looks up the server's host, opens a connection to it, sends the push, reads the status of the answer and closes the connection. The rest of the answer, which repeats the push, is read and dropped. A redirect is not followed, and a push is never tried again. The address must begin `https://`, so the connection is encrypted with TLS, and the certificate is always checked, even when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Only to a server on this computer, at `127.0.0.1` or `localhost`, may it begin `http://`. It may hold no user name, password, query or fragment, so the token never goes in an address, where a log could keep it: it goes in the `Authorization` header alone. The server sees the network address the connection comes from, as any server you connect to does.

The server then hands the push to every phone and browser subscribed to the topic. Anyone who knows a topic's name can subscribe to it and read every push sent there, on ntfy.sh and on any server without access control, so the topic's name is a secret, like a password: the guide shows how to make one no one can guess, and an access token keeps out those who guess it only where the topic is guarded: on a server of your own with access control, or on ntfy.sh for a topic reserved for your account, which only its paid plans allow. On ntfy.sh's free plan the name is the only guard. ntfy's own documentation says that ntfy.sh keeps a push for 12 hours by default, so a phone that was off can fetch it, records topic names and network addresses, and does not encrypt a push from end to end, and that its Android and iPhone apps from the app stores may have a push carried by Google's or Apple's own push services. A server of your own keeps what its own settings say.

### When

`AGENT_LOOKOUT_NTFY_EVENTS` names the events that are pushed, from `needs-you`, `finished`, `failed` and `ended`, and is `needs-you` alone unless you set it. A push goes for a wait that begins after Agent Lookout started, once it has lasted the delay, which is one minute unless `AGENT_LOOKOUT_NTFY_AFTER` says otherwise, if the session is still waiting then, by the rules the [webhook](#when-1) follows: one at most for each wait apart from reminders and their repeats, none for a wait answered before then, none for what was already true when Agent Lookout started, nothing during quiet hours but one summary when they end, and nothing for a wait Agent Lookout answered. A push that could not be sent is not tried again. At most 20 are tried in any hour, whatever they are for, a test among them, counted apart from emails, posts and Pushover's pushes. Past that, none goes until the hour has passed.

### Send a test

While ntfy is on, its card in Settings has Send a test. Pressing it sends one push, titled "Agent Lookout test", with the message "Pushes from Agent Lookout reach this device.", and nothing of any session. It goes during quiet hours too, since you asked for it, counts toward the 20 an hour, and is not tried while those are spent. The request the page sends Agent Lookout's own server carries `X-Agent-Lookout-Action: phone-test` and the body `{"channel": "ntfy"}`, and nothing else. The card says when it went, or why it did not; the line on the last push is about notices alone.

### What is kept

Anyone who has the topic's address can read the pushes, and anyone who has the token can send and read on the topic as you, so both are kept like passwords. They live in the environment of the Agent Lookout process, as every setting on this page does, and programs running as your user on this machine can read a process's environment. Agent Lookout never writes them to a file, never sends them to the dashboard, and never prints them. When an ntfy setting cannot be read, it prints one line that names the setting and never its value. A setting typed in front of the command can be kept by your shell in its history file. The guide shows how to keep them out of it.

Through `GET /api/ntfy`, the dashboard learns whether ntfy is on, the host of the server and nothing else of the address, such as `ntfy.sh`, whether a token is set and never the token, the events that are pushed, the delay, whether the push for a wait says what the session is asking, never what it was asking, and when the last push of a notice was tried, with whether it was sent or a short reason why not. That, and the times of the pushes of the last hour, are held in memory and are gone when Agent Lookout stops.

Once a push has been sent, Agent Lookout has no hold on it. The server and every device subscribed to the topic keep it for as long as their own settings say. Agent Lookout cannot recall or delete it.

The button and the switches for notifications in Settings do not turn pushes on or off, or choose what is pushed. To stop them, start Agent Lookout again without `AGENT_LOOKOUT_NTFY_URL`.

## Pushover

Pushes through [Pushover](https://pushover.net) are off until you set them up, and they can be set up only in the environment Agent Lookout starts with: `AGENT_LOOKOUT_PUSHOVER_TOKEN`, the API token of a Pushover application you make, and `AGENT_LOOKOUT_PUSHOVER_USER`, your user key or a group key. Both are needed. `AGENT_LOOKOUT_PUSHOVER_EVENTS`, `AGENT_LOOKOUT_PUSHOVER_AFTER` and `AGENT_LOOKOUT_PUSHOVER_ASKING` can be left out, and work as ntfy's do. While either of the first two is unset, nothing is pushed and no connection is opened. The same holds when any of the five is set to something Agent Lookout cannot read. The [guide](docs/GUIDE.md#pushover) says how to set it up and how to turn it off.

### What a Pushover push holds

A push is one request with a body of JSON, such as:

```json
{
  "token": "your application's token",
  "user": "your user key",
  "title": "checkout-flow is waiting for permission",
  "message": "4m 12s · storefront · VS Code · Claude Code",
  "priority": 0
}
```

`token` and `user` say which application sends it and to whom. `title` and `message` are those of an ntfy push, as [What a push holds](#what-a-push-holds) describes, for reminders, their repeats and the summary of quiet hours too, and with `AGENT_LOOKOUT_PUSHOVER_ASKING=on` the push for a wait, and each reminder of it, begins its message with the `Asking:` line, as [ntfy's](#what-a-waiting-session-is-asking-in-a-push) does. `priority` is 0, Pushover's normal, for a wait, a reminder of one and the test, which sounds as your device is set to, and -1, quiet, for the rest, which shows without a sound. It is never 1, which would sound through the quiet hours you set in Pushover's own app, or 2, which repeats until you acknowledge it. It holds no address to open, no sound, no device and no HTML, and nothing more than an ntfy push holds. Its headers are `Content-Type: application/json`, `Content-Length`, `User-Agent: Agent Lookout/` followed by the version, `Host` and `Connection: close`.

### Where a Pushover push goes, and how

Each push is posted to `https://api.pushover.net/1/messages.json`, Pushover's own address, and to no other: no setting changes it. The token and the key go in the body alone, never in the address. As for ntfy, it is one request on a connection of its own, encrypted with TLS, with the certificate always checked, even when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set. No redirect is followed, the answer is read and dropped, and a push is never tried again. Pushover sees the network address the connection comes from.

Pushover then delivers it to the devices of that user or group, through Apple's and Google's push services for its iPhone and Android apps. Pushover's privacy policy says it deletes a message once its delivery has been confirmed, and otherwise after 21 days, and that it may record network addresses. Pushover's own documentation says an account may send 10,000 messages a month for free, shared by all its applications; past that Pushover refuses them, and the card says so.

### When a Pushover push goes

By the rules an ntfy push goes by, under Pushover's own settings, and with its own count of 20 an hour, a test among them.

### Send a test through Pushover

While Pushover is on, its card in Settings has Send a test, which sends the same test push ntfy's does, with `{"channel": "pushover"}`. It counts as ntfy's does.

### What is kept of Pushover

Whoever has the application's token and your user key can push to your devices, so both are kept like passwords, as ntfy's topic and token are: in the environment alone, never written to a file, sent to the dashboard or printed. When a Pushover setting cannot be read or is missing, Agent Lookout prints one line that names the setting and never its value. Through `GET /api/pushover`, the dashboard learns whether Pushover is on, the events, the delay, whether the push for a wait says what the session is asking, and when the last push of a notice was tried, with whether it was sent or a short reason why not. It never learns the token or the key. That is held in memory and is gone when Agent Lookout stops. Once a push has been sent, Agent Lookout cannot recall or delete it.

The button and the switches for notifications in Settings do not turn pushes on or off. To stop them, start Agent Lookout again without `AGENT_LOOKOUT_PUSHOVER_TOKEN` or `AGENT_LOOKOUT_PUSHOVER_USER`.

## Updates (Mac app only)

The Mac app checks whether a newer version of it has been released. Nothing else does: the npm package, `npx agent-lookout`, `npm start`, `npm run dev` and a development run of the app, `npm run dev:desktop`, never check by themselves.

### What it asks for, and from where

It asks GitHub, over HTTPS, for one small file, `latest-mac.yml`, from the latest release of the project, at `https://github.com/Olanetsoft/agent-lookout/releases/latest/download/latest-mac.yml`. The file gives the latest version's number, and the name, size and SHA-512 of each of its files. GitHub answers with a redirect to its own file host, `release-assets.githubusercontent.com`, or `objects.githubusercontent.com`, and the app follows a redirect only to one of those three hosts, only over HTTPS. The file may be no larger than 64 KB.

Only when that version is newer than the one running, and is not a prerelease, does it ask for one more file: the zip of the new version for your kind of Mac, from that version's release, about 120 MB, from the same hosts. It checks the zip's size and SHA-512 against `latest-mac.yml` as it downloads, unpacks it with `/usr/bin/ditto`, and checks with the bundle's `Info.plist`, turned into text by `/usr/bin/plutil` when it needs to be, that it is Agent Lookout and the version offered. A file that does not match is deleted.

### What a request holds

Each request holds the address above and a `User-Agent` header, `Agent-Lookout/` followed by the version running, such as `Agent-Lookout/0.2.1`, and an `Accept` header. It holds no cookie, no account, no session data, no name, path or count of sessions, and nothing else about this computer. As with any web request, GitHub sees the network address the request comes from, and it may keep what it records of requests under its own terms. The requests are made by the app's main process with Node's own HTTPS client, with the certificate checked. The page in the app's window cannot make any request off the machine.

### How often

A short while after the app starts, if a day has passed since the last check that had an answer, and then once a day while it runs. A check that had no answer, because the Mac was offline for instance, is tried again after six hours. Check for Updates…, in the Agent Lookout menu and in Settings, checks at once, whether or not the automatic check is on.

### Turning it off

Settings has an Updates card, in the Mac app only, with the switch Check for updates automatically. Turned off, the app asks GitHub nothing until you press Check for Updates…. It is on until you turn it off.

### Installing

Nothing is installed until you press Install and Restart, in Settings, or in the dialog Check for Updates… shows when the window is closed. The app then starts a short script, `/bin/sh` with a script that never changes, and quits. The script waits for the app to quit, moves the old app into the update's temporary folder, moves the new one into its place, and opens it, using `/bin/kill`, `/bin/sleep`, `/bin/mv` and `/usr/bin/open`. It is given the app's process ID and three paths: where the app is, and two in the temporary folder the app made itself. Nothing from the network reaches its arguments. If the new version cannot be moved in, the old one is put back and opened, and says under Updates in Settings that the version could not be installed. The app does this only from a folder it can change, such as Applications, and not when macOS runs it from where it was downloaded, or when it runs from its disk image or another disk under `/Volumes/`: then it says so, and links to the release page.

### What is kept

`update-state.json`, in `~/Library/Application Support/Agent Lookout/`, holds whether the automatic check is on, when a check last had an answer, the last version a notification was shown for, so each version is told of once, and, from Install and Restart until the app opens again, the version being installed, so the copy that opens knows whether that worked. The download is in a folder of the app's own in the system's temporary folder, and is deleted when the app quits without installing it, or when it does not match. After an install, the old app stays in that folder, and macOS clears it there in time.

## The MCP server

`agent-lookout mcp` does nothing until you add it to an agent's app, such as Claude Code, as the [guide](docs/GUIDE.md#for-your-agents) shows. The app then starts it, and speaks to it over its stdin and stdout. It opens no port.

### What it reads

For each tool the agent calls, it asks Agent Lookout's own server for the list of sessions, `GET /api/sessions`, once, at a loopback address only, as `agent-lookout status` does. The request carries no `Origin` and no notifications header, so it changes nothing in Agent Lookout. Otherwise it reads only `AGENT_LOOKOUT_URL` from the environment, and Agent Lookout's own `package.json`, for its version number. It reads no other file, runs no program and makes no other connection.

### What it sends, and to whom

It answers the app that started it, over stdout, and nothing and nobody else. An answer is one of three:

- For each session: its ID, its name, its agent, the other machine it runs on, when it runs on one read over SSH, its status, why it waits, the name of its folder and never the rest of the path, its branch or commit, its app, when its status began, and how long its agent has written nothing. With `AGENT_LOOKOUT_PULL_REQUESTS=on`, also the number of its branch's pull request and whether its checks are failing, pending or passing, and never its title. Never what a waiting session is asking, which is read from its transcript.
- For each session that needs you: the same, with how long it has waited, and one sentence naming each of them and any agent that could not be read.
- For each source: its state, the sentence that says how it is read or what went wrong, which can name the folders Agent Lookout reads, such as `~/.claude/sessions`, and, for another machine, the SSH target you named, such as `dev@devbox.local`, and the last line ssh printed when it failed, and what its agent can report.

When Agent Lookout cannot be reached, the answer is one sentence that says so, with the address it tried.

### What happens to an answer

What the app does with an answer is up to the app. An agent's app normally hands each answer to its model, and for most agents the model runs on the vendor's servers, so the names of your sessions, their folders and their branches, the SSH targets of the other machines you named, and with `AGENT_LOOKOUT_PULL_REQUESTS=on` the numbers of their pull requests and whether their checks pass, can leave this computer that way, under that app's own settings and terms. Add the server only to an app you would show your session names to, and remove it from the app to stop it: for Claude Code, `claude mcp remove agent-lookout`.

### What is kept

Nothing. Each answer is worked out from one reading of the list and is gone once it has been sent. The server stops when the app closes it.

## Storage

Agent Lookout keeps one thing about your sessions on disk: the history behind the Events log and the charts, so that they are still there after it restarts. [The history](#the-history) says what it holds, where it is, how long it is kept, how to clear it and how to turn it off. It also keeps its time rules and permission rules in a file, which holds nothing about your sessions: [The settings file](#the-settings-file). Apart from those, its own code writes no files, except the Mac app's, below.

The latest session list is held in memory only, and is gone when Agent Lookout stops. What a waiting session is asking is in that list only while it waits, and in no event or point of history, on disk or in memory. So is a permission request held for the dashboard, which is also kept in memory only while it is held. With `AGENT_LOOKOUT_EMAIL_ASKING=on`, `AGENT_LOOKOUT_WEBHOOK_ASKING=on`, `AGENT_LOOKOUT_NTFY_ASKING=on` or `AGENT_LOOKOUT_PUSHOVER_ASKING=on`, it is also in the email, post or push for that wait from the moment it is written until it is handed over, and nowhere else. So are the tmux panes and terminal tabs it last found, the branches and repositories it last read, with pull requests on the pull requests `gh` last gave and where each branch's is looked for, and what the dashboard pages last said about notifications.

### The history

The history is kept in the folder `~/.agent-lookout/history`, beside the folder of status files, or in the folder `AGENT_LOOKOUT_HISTORY_DIR` names. Agent Lookout makes the folder, and any folder above it that is not there, with mode 700, so only your user can open it, and makes each file in it with mode 600, so only your user can read or change it.

It writes there what it already holds in memory for the Events log and the charts, and nothing else:

- Each event: its ID, its time, the session's ID and name, whether the session appeared, changed status, ended, was stopped from Agent Lookout or had a permission prompt answered from it, the status it changed from and to, how serious the change was, for a session that was stopped, that Agent Lookout stopped it, and for a prompt that was answered, that Agent Lookout answered it and whether it allowed or denied it, and, when a permission rule answered it, the tool's name and the rule as you wrote it, never the command the session asked to run. A session's ID is its agent's own ID for it, or the name of its status file.
- Each history point, one for each poll: its time, and how many sessions were waiting on you, working, idle, and in all.
- When Agent Lookout started writing, and when the history was cleared.

Each event holds the session's name as the dashboard shows it: the name its agent gave it, from Claude Code's session file or the `claude` command's list, from Codex's `session_index.jsonl` or from a status file, or else the name of its folder, which for a Codex session is read from the start of its session file, and for an Antigravity CLI session its conversation ID, the name of its folder in `brain/`. Nothing else from a transcript, from Codex's session files or from agy's transcripts is written, and no folder path, branch, prompt or anything a waiting session is asking.

What it learns is written every 5 seconds, and once more as it stops. The files are JSON lines, one file for each day by the UTC clock, such as `v1-2026-10-06.jsonl`. A day that grows past 2 MB goes on in `v1-2026-10-06-2.jsonl`, and so on. Each day's file is deleted once that day ended more than 8 days ago, and the files hold 20 MB at most: before writing more than that, Agent Lookout deletes the oldest. When it starts, it reads the files back, and keeps in memory the last 1,000 events and the last six hours of points, as it does while it runs. For the Waits card it also keeps in memory, for 9 days, the events of sessions starting and stopping waiting on you, and the stretches of time it was measuring, which it works the card's totals out from. It reads only ordinary files in that folder of about 2 MB or less, does not follow a link, and passes over a line it cannot read. A file whose name says it was written by a later version of Agent Lookout, such as `v2-2026-10-06.jsonl`, is not read, written or deleted, for its age or by Clear history. A line dated more than a minute after the computer's clock was written while the clock was wrong, and is not read back.

When more than one copy runs at once, such as the Mac app and `npx agent-lookout`, one of them writes the history. It keeps a file in the folder, `writer.lock`, that holds its process ID, a random mark that tells it from another copy in the same process, and a fingerprint of the folders it reads sessions from, which names none of them. It deletes the file as it stops. The others read what had been kept when they started, keep what they see in memory, and one of them takes over when the writer stops. A copy that reads sessions from other folders than the writer's, such as a dev server pointed at empty folders, says so on its History card.

To clear the history, press Clear history on the History card in Settings and confirm. Agent Lookout deletes every history file this version wrote in the folder, and empties the Events log and the charts, which start again from that moment. The History card says where the files are, how much they hold and how far back they go. Deleting the folder while Agent Lookout is stopped clears it too.

To keep nothing on disk, start Agent Lookout with `AGENT_LOOKOUT_HISTORY=off`. It then makes no history folder and writes no history file, and the last 1,000 events, the last six hours of history and what the Waits card counts are held in memory only and are gone when it stops. While answering is on, it still makes the folder of its socket, `~/.agent-lookout` unless `AGENT_LOOKOUT_ANSWER_SOCKET` names another, with mode 700, and opens the socket there. The socket holds nothing and is removed when Agent Lookout stops, and the folder stays. Start it with `AGENT_LOOKOUT_ANSWER=off` as well to make no folder at all. A change to a rule in Settings still writes [the settings file](#the-settings-file).

### The settings file

Agent Lookout keeps the [time rules](docs/GUIDE.md#time-rules) and the [permission rules](docs/GUIDE.md#permission-rules) you set in Settings in `~/.agent-lookout/settings.json`, beside the history, or in the file `AGENT_LOOKOUT_SETTINGS_FILE` names, so they hold with no dashboard open and after a restart. It holds those rules and nothing else of Agent Lookout's: whether each time rule is on, the minutes before a reminder and, once you set it, whether it goes again and the minutes between, the hours before a session is stale, and the times and days of quiet hours with the switch for the summary, and each permission rule in its order, with an ID Agent Lookout gave it, its decision, its tool and, for Bash, the command you wrote. It holds nothing about a session. A command you write in a rule is in the file as you wrote it, so leave out of a rule anything you would not keep in a file.

Agent Lookout reads it as it starts and again just before each change, and at each poll, every 2 seconds, it looks at the file's size and times to read it again when another copy of Agent Lookout, such as the Mac app beside `npx agent-lookout`, has written it. It writes it only when you change a rule in Settings, through `POST /api/settings/time-rules` or `POST /api/settings/permission-rules`, which the dashboard's page sends, and which another program on this computer can send too, as [Network](#network) says. It writes the file whole: to a new file of mode 600, so only your user can read or change it, in the same folder, which then takes the old one's place, and makes the folder with mode 700 when it is not there. It neither reads nor writes through a link, at the file's name or the folder's, and reads no file larger than 64 KB. Anything else the file holds, such as a later version's settings, is written back as it was. A file it finds but cannot read, such as one larger than 64 KB or one it may not read, it never writes over: a change is not saved until the file is mended or removed. Permission rules it cannot read whole, such as a later version's, are no rule at all: none of them answers anything, Settings says so, and they stay in the file as they were until you change a permission rule, which writes the list again with the rules Settings shows. Until you change a rule, nothing is written and no folder is made. To go back to every time rule off and no permission rule, delete the file while Agent Lookout is stopped.

With notifications on, each notification holds a session's name, and for a wait what the session is asking, and the operating system keeps it in its notification list, as does the browser for one it made. [Notifications](#notifications) says what it holds and how long it stays. With email set up, each email holds a session's name and its folder's name, and with `AGENT_LOOKOUT_EMAIL_ASKING=on` the email for a wait holds what the session was asking, and the mail server and the mailbox keep it, as [Email](#email) says. With a webhook set up, each post holds the same, with `AGENT_LOOKOUT_WEBHOOK_ASKING=on` for what a session was asking, and the service it went to keeps it, as [Webhook](#webhook) says. With ntfy or Pushover set up, each push holds a session's name and its folder's name, with that channel's own setting for what a session was asking, and the service and the devices it reaches keep it, as [ntfy](#ntfy) and [Pushover](#pushover) say.

The tools that run it write files of their own. None of these holds session data.

- npm keeps a short log of each command it runs in `~/.npm/_logs/`. The log names the command and the project folder. It does not hold the program's output.
- In a clone, `npm start` and the `agent-lookout` command run through tsx, which keeps compiled copies of Agent Lookout's own source files in the system's temporary directory, in a folder named `tsx-` followed by your user ID. Installed from npm, the command is plain JavaScript and runs without tsx.
- `npx agent-lookout` keeps the package it downloads in npm's cache, in `~/.npm/_npx/`.
- `npm run dev` runs through Vite, which keeps pre-bundled copies of the dependencies in `node_modules/.vite/`.
- `npm run build` writes the built dashboard to `dist/` and the type checker's records to `node_modules/.tmp/`. `npm run build:package` also writes the bundled command to `dist/cli/`.

The Mac app keeps the history in the same folder as `npx agent-lookout` and `npm start`, and four files of its own. `window-state.json`, in `~/Library/Application Support/Agent Lookout/`, holds the window's place and size and the colour of the theme it last showed. `update-state.json`, beside it, holds whether it checks for updates by itself, when it last checked, the last version it told you of and, during an install, the version being installed, as [Updates (Mac app only)](#updates-mac-app-only) says, and a newer version it downloads waits in the system's temporary folder until it is installed or the app quits. `menu-bar-state.json`, beside it, holds whether its icon is shown in the menu bar. Its log, `~/Library/Logs/Agent Lookout/main.log`, holds the errors it met and the lines `npm start` would print, such as the one that says an email setting is wrong. None of them holds a session's name, though an error in the log can name a file the app could not read. Electron, which the app is built on, keeps the page's local storage, below, and caches of its own in the first folder.

The dashboard saves seven values in your browser's local storage. Your theme choice is under the key `agent-lookout-theme`. Whether notifications are on is under the key `agent-lookout-notifications`, as `on` or `off`, and is written only when you turn them on or off. The events that send one are under the key `agent-lookout-notification-events`, as their names separated by commas, such as `needs-you,finished`, and are written only when you switch one. The apps the page has said macOS will ask about, when you first jumped to a tab of one, are under the key `agent-lookout-automation-note`, as `Terminal`, `iTerm2` or both separated by a comma. The last time the Events log was on screen is under the key `agent-lookout-last-looked`, as a number of milliseconds since 1970, and is written when the page goes out of sight or is closed. It is what the line in the Events log that marks where you left off is drawn from, and while that line still shows, the time kept is the line's own. It holds nothing about any session or event. Whether the Sessions card shows the list, the list grouped by repository or the board is under the key `agent-lookout-sessions-layout`, as `list`, `repositories` or `board`, and is written only when you choose one. The sessions left running that you hid until they change are under the key `agent-lookout-hidden-sessions`, as a list of each one's ID and the moment its idle began, at most 100, and are written only when you hide one. All seven belong to one browser at one address.

## What is on screen

Session names, folder paths, repository names, branch names, pull request titles and what a waiting session is asking, such as a command or a file, can show what you are working on. Check a screenshot before you share it.

Resume puts a session's folder path and its ID on the clipboard, and only when you press it. From there, anything that reads your clipboard can see them, such as a clipboard manager, and on a Mac with Handoff on, Universal Clipboard makes them available on your other Apple devices. The page never reads the clipboard.

With notifications on, a session's name, and what a waiting session is asking, also appear in a system notification, outside the dashboard: over other apps, in Notification Centre and, depending on your system's settings, on the lock screen and while you mirror, share or record the screen. One the dashboard page made for a wait stays there until the session stops waiting or you clear it, and one that says Finished, Failed or Ended stays until you clear it. One the server showed stays until you clear it. To keep names off those, open Notifications in System Settings on macOS and change what your browser's notifications may show, which does not cover the ones the server shows (in the Mac app, both kinds come from Agent Lookout, so change Agent Lookout's own entry there), or leave notifications off. In the Mac app, the number of sessions that need you is shown in the menu bar, beside its icon, and the menu it opens lists their names and what each is asking, with the agent, project, branch or app of two that share a name, and, for a permission request Agent Lookout holds, every line of the command or the tool's inputs. Both show while you share or record the screen. To keep them off the menu bar, set Show in menu bar to Off in Settings. The app's own notification of a wait can hold the whole command a session asks to run, and macOS can show it on the lock screen. To keep it off the lock screen, open System Settings, then Notifications, choose Agent Lookout, and turn off its notifications on the lock screen, or set Show previews to When Unlocked or Never. An email shows the same name, and the folder's, wherever that mailbox is read, including the notifications a phone shows for it, and so does what a waiting session is asking, with `AGENT_LOOKOUT_EMAIL_ASKING=on`. A webhook post shows them to everyone who can read the channel it goes to, and in the notifications their apps show for it, and with `AGENT_LOOKOUT_WEBHOOK_ASKING=on` shows what a waiting session is asking there too. A push shows them on your phone, on its lock screen as its settings allow, and on every device subscribed to the ntfy topic or signed in to the Pushover account, and with that channel's own setting on, what a waiting session is asking.

## Changes

This file lists every command the app runs and every file it reads outside its own folder. A change that adds to either list, stores anything on disk or talks to a network updates this file in the same pull request.
