# Privacy

Agent Lookout runs on your machine and reads a small amount of metadata about your Claude Code and Codex sessions. Agent Lookout itself sends nothing anywhere. It does run Claude Code's own listing command, which may contact Anthropic the way Claude Code normally does.

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

### Whether a process exists

Agent Lookout asks the operating system whether each Claude Code session's process still exists with a signal-0 check on the process ID, which sends nothing to the process.

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

### Settings

It reads seven settings from the environment: `AGENT_LOOKOUT_CLAUDE_HOME`, `AGENT_LOOKOUT_CLAUDE_BIN`, `AGENT_LOOKOUT_CLAUDE_FEED`, `AGENT_LOOKOUT_CODEX_HOME`, `AGENT_LOOKOUT_PORT`, `AGENT_LOOKOUT_HOST` and Codex's own `CODEX_HOME`. `AGENT_LOOKOUT_CLAUDE_HOME` replaces `~/.claude` in everything above. The [guide](docs/GUIDE.md#settings-you-can-change) says what each setting does.

## What it never reads

- The `.key` files that sit beside the registry files in `~/.claude/sessions/`.
- Claude Code's transcripts, in `~/.claude/projects/` or anywhere else. For Claude Code, Agent Lookout never sees your prompts, the agent's replies, your code or the output of tools.
- Claude Code's settings, credentials, history and memory files.
- Codex's `auth.json`, `config.toml`, `history.jsonl`, its SQLite files (`*.sqlite`), its `log/` folder, `archived_sessions/` and compressed session files (`*.jsonl.zst`), and the Codex desktop app's `external_agent_session_imports.json` and `.codex-global-state.json`.
- The files of any other application.

It runs no program but the `claude` binary and `ps`. It never writes to `~/.claude`, to the Codex folder or to any agent tool's files, and it never sends input to a session.

## Network

The only network traffic Agent Lookout's own code makes is between the dashboard in your browser and its own server on the same machine. One more connection never leaves the machine either: before `npm start` begins listening, it connects once to its own address and port to see whether another program already answers there, and sends nothing over that connection. There is no telemetry, no analytics, no crash reporting and no update check, and there is no account. Fonts and scripts are bundled, so the page loads nothing from the internet.

The `claude agents` command is Claude Code's own program, and it may contact Anthropic the way it does for anyone who runs it. Agent Lookout sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and `DISABLE_AUTOUPDATER` for each run, to ask Claude Code to skip its update check, usage reporting and error reporting, and runs the command seldom. Anything else that program does is governed by Claude Code's settings and terms. To stop Agent Lookout running it, set `AGENT_LOOKOUT_CLAUDE_FEED=off`. Sessions then come from the registry alone, and background jobs whose process has ended are not listed.

`npm start` listens on a loopback address only: `127.0.0.1`, or `::1` if you set `AGENT_LOOKOUT_HOST`. It refuses to start on any other address. `npm run dev` uses Vite's dev server, which listens on localhost unless you pass it `--host`.

The API refuses any request whose `Host` header is not `localhost`, `127.0.0.1` or `[::1]`, any request whose `Origin` header names another site, and any request the browser marks as cross-site. It sends no CORS headers. Together these stop a website you visit from reading your session names and paths through your browser.

The local server has no password. While Agent Lookout is running, another program on the same machine can request the same data, and on a shared computer so can another user account.

The Jump button opens a `vscode://` address that contains the session ID. Your operating system hands it to VS Code.

## Storage

Agent Lookout stores no session data on disk, and its own code writes no files. The latest session list, the last 1,000 events and the last six hours of history are held in memory and are gone when Agent Lookout stops.

The tools that run it write files of their own. None of these holds session data.

- npm keeps a short log of each command it runs in `~/.npm/_logs/`. The log names the command and the project folder. It does not hold the program's output.
- `npm start` runs through tsx, which keeps compiled copies of Agent Lookout's own source files in the system's temporary directory, in a folder named `tsx-` followed by your user ID.
- `npm run dev` runs through Vite, which keeps pre-bundled copies of the dependencies in `node_modules/.vite/`.
- `npm run build` writes the built dashboard to `dist/` and the type checker's records to `node_modules/.tmp/`.

The dashboard saves one value in your browser's local storage: your theme choice, under the key `agent-lookout-theme`.

## What is on screen

Session names and folder paths can show what you are working on. Check a screenshot before you share it.

## Changes

This file lists every command the app runs and every file it reads outside its own folder. A change that adds to either list, stores anything on disk or talks to a network updates this file in the same pull request.
