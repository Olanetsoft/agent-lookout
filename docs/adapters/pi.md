# Pi adapter notes

These notes record what Agent Lookout reads from Pi, where each value comes from, and what breaks when Pi changes. When the adapter stops working, start here.

Written on 2026-11-04 from Pi's source at `v1.5.0`, released 2026-11-02 (commit `f9a2636` of [earendil-works/pi](https://github.com/earendil-works/pi)), the newest release then. Pi is under the MIT licence. Pi was not installed or run to write them, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from Pi's source at v1.5.0 and has not yet been checked on a computer running Pi.** The Sources view says so too.

Each citation is `path:line` at `v1.5.0`. Every path is in `packages/coding-agent/`, and `session-manager.ts` is `src/core/session-manager.ts`.

The code is in `src/collector/adapters/pi/`, and the status mapping is in `src/core/mapping/pi/piMapping.ts`.

## What the issue said, and what holds

| What issue #36 said                                                    | What the source shows                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSONL session files under `~/.pi/agent/sessions/`                      | True, on macOS, Linux and Windows, unless a setting moves them, as [Where it looks](#where-it-looks) says                                                                                                                                                                                                                                                           |
| Grouped by folder                                                      | True by default, with one folder for each working directory. A sessions folder named with a setting holds its files directly, with no folders in it                                                                                                                                                                                                                 |
| Nothing on disk marks a session as running                             | True. Pi writes no status, no end, no pid and no lock for a session                                                                                                                                                                                                                                                                                                 |
| So that would rest on the `pi` process and on recent writes            | On the process only as far as it goes: it says whether any `pi` runs, never which session it holds, as [The process](#the-process) says. Not on recent writes, which would be a guess                                                                                                                                                                               |
| Pi does not ask for approval before tool calls                         | True of Pi itself, which has no permission system of its own (`README.md:90` at the top of the repository). An extension can ask, with `ctx.ui.confirm`, and that is written nowhere (`docs/extensions.md:2757-2762`)                                                                                                                                               |
| The only wait is for the next prompt, which an extension event reports | True, and of no use here. The event is `agent_settled`, not `agent_end`, which Pi's docs say can be followed by more work (`docs/extensions.md:336`). It goes to extensions and to a program that drives Pi, in RPC or JSON mode or through its SDK, and in the terminal it sets the status Pi reports to a terminal that supports it. Nothing of it reaches a file |

## How it reads Pi, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no Pi program run, no network. It reads a little of each recent session file, read-only, and asks `ps` whether a `pi` program runs.

Pi has other ways in, and none of them can be used that way:

| Interface                                     | Why it is not used                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SessionManager.list` and `listAll`           | They are code in Pi's package, and they read every line of every file, with the text of every message |
| `pi --mode rpc`                               | It starts a Pi with a session of its own, and takes commands                                          |
| Extensions, with `agent_settled` and the rest | They would mean installing something in Pi, which runs inside its process with what it can reach      |

## Where it looks

Pi works the folder out in `src/config.ts:630-636` and `:674-676`, and takes the setting first in `src/main.ts:702-706`. The first of these that is set is used, and an empty one counts as unset:

| Setting                       | Sessions folder                                     |
| ----------------------------- | --------------------------------------------------- |
| `AGENT_LOOKOUT_PI_HOME`       | `<folder>/sessions`, for Agent Lookout alone        |
| `PI_CODING_AGENT_SESSION_DIR` | That folder, with the files directly in it          |
| `PI_CODING_AGENT_DIR`         | `<folder>/sessions`                                 |
| None                          | `~/.pi/agent/sessions`, on macOS, Linux and Windows |

`~` is the home folder, `os.homedir()` in Pi and in Agent Lookout, which on Windows is `C:\Users\<name>`. Pi expands a leading `~` in its two variables, and so does the adapter. A relative value means a folder relative to where Pi was started, which cannot be known here, so the adapter goes past it.

When the folder is missing, Pi is reported as not found, with no advice, and the folder is looked for again once a minute, or on every poll when `AGENT_LOOKOUT_PI_HOME` is set, with one listing and no `ps`. Pi makes it at its first session (`getDefaultSessionDir`, `session-manager.ts:597-603`). When `AGENT_LOOKOUT_PI_HOME` names a folder with nothing in it, that is an answer, not a missing Pi: the source is watched and lists no sessions.

Three ways Pi moves its folder cannot be followed, because Agent Lookout never reads Pi's settings or a process's arguments:

- `pi --session-dir <folder>`, which comes before everything else (`src/main.ts:703-704`).
- The `sessionDir` setting in Pi's `settings.json` (`src/core/settings-manager.ts:703-706`).
- A package that renames Pi with `piConfig`, which gives it another folder and other variables (`src/config.ts:602-611`).

A person who uses the first two can start Agent Lookout with `PI_CODING_AGENT_SESSION_DIR` set to the same folder.

## What it reads

| Path                                   | How                                                                                             | How often                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The sessions folder                    | Listed                                                                                          | Every poll, and while it is missing once a minute, or every poll when `AGENT_LOOKOUT_PI_HOME` is set |
| Each project folder, `--<folder>--/`   | One `lstat`, to see that it is a folder and not a link, and for its modified time               | Every poll                                                                                           |
| The same folder                        | Listed                                                                                          | When its modified time moves, and once a minute                                                      |
| Each `*.jsonl` written in the last day | One `lstat`                                                                                     | Every poll, for the newest 200                                                                       |
| Every other `*.jsonl`                  | One `lstat`. Never opened                                                                       | Once a minute                                                                                        |
| A session file written in the last day | Opened read-only: its first 64 KiB and its last 256 KiB, then only what Pi added, up to 256 KiB | When its size, modified time or identity changes                                                     |

Pi never removes a session by itself, so these folders can hold thousands. A poll looks up each project folder, so a new file is found by the next poll: adding a file moves its folder's time. Adding to a file does not, so a look through every file once a minute is what finds an old session opened again. A file last written over a day ago is never opened.

A file is opened without following a link at its name and without waiting on a pipe, and read only if the open file is an ordinary file. It is not opened through a link at a project folder, which is looked up again just before. The sessions folder itself can be a link. Any name that ends in `.jsonl` counts, as it does for Pi's own list (`session-manager.ts:951-955`), since `/import` keeps a file's own name (`src/core/agent-session-runtime.ts:370`). Nothing else in Pi's folder is read: not `settings.json`, `auth.json`, `models.json` or anything beside the sessions folder.

## The session file

`<project folder>/<time>_<id>.jsonl` is JSON Lines, one entry to a line, as `docs/session-format.md` describes. `<time>` is the header's with `:` and `.` as `-`, and `<id>` is a UUID, or what `--session-id` gives (`session-manager.ts:1058-1084`). The project folder is the working directory with its first `/` or `\` dropped, and `/`, `\` and `:` as `-`, between `--` and `--` (`:590-595`). It cannot be read back into a path, so the adapter takes the folder from the header.

**What writes it, and when.** `SessionManager` makes the file at the session's first message, with everything held until then, so a session opened with no prompt has no file (`_persist`, `:1173-1190`). After that it adds one line for each entry with `appendFileSync`, at the end of each message and not while one comes in (`src/core/agent-session.ts:1163-1181`). So nothing is written during a long reply or a long tool. Pi rewrites a file whole only to move an old session to the newest format (`session-manager.ts:1125-1135`). It writes no line that says a session ended, however it ends: extensions get `session_shutdown`, and that goes no further (`src/core/agent-session-runtime.ts:404-410`).

### The header

The first line. Only this line is parsed whole.

| Field           | Meaning                                                                                         | Kept                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `type`          | `session`. Any other first line is not a session file                                           | Read, not kept                                                                            |
| `version`       | `3`, and missing from Pi's first format. A higher one is left out, and the Sources view says so | Read, not kept                                                                            |
| `id`            | The session's id. It must be what `assertValidSessionId` allows, in 200 characters or less      | Yes                                                                                       |
| `timestamp`     | When the session began, as an ISO time                                                          | Yes, when it is one. A time before 2020, or ahead of the clock, is treated as none        |
| `cwd`           | The session's folder. Pi never changes it (`docs/sessions.md:16`)                               | Yes, when it is an absolute path of up to 4,096 characters with nothing unprintable in it |
| `parentSession` | The path of the file a fork came from                                                           | No: dropped with the parsed line. No path in a file is ever opened                        |

A session's id in Agent Lookout is `pi:<id>`. A file with no whole first line in its first 64 KiB, whose first line is not JSON or not a session's, or with a bad `id` or `version`, is not listed. Any other bad value is treated as none.

### The name

`{"type":"session_info","id":…,"parentId":…,"timestamp":…,"name":…}`, written by `appendSessionInfo` (`session-manager.ts:1315-1326`). The newest one wins and an empty one clears the name, as Pi reads it (`:830-832`, `:1329-1340`).

The adapter looks for these lines in the bytes, with `Buffer.lastIndexOf`, and turns only the newest whole one into text, up to 4 KiB. Every other line is left as bytes. No line is parsed but the header and that one, so no prompt, reply, tool's argument or output is ever turned into text. The search is for a line break followed by `{"type":"session_info"`. JSON writes a line break inside a string as `\n`, two characters, so those bytes can only be the start of a line, and nothing said in a session can look like one. `JSON.stringify` writes `type` first because `appendSessionInfo` does.

The first read covers the first 64 KiB, where `--name` puts it, as the first entry, and the last 256 KiB. Each later read starts at the line after the last whole line read, up to 256 KiB from the end, so a name set while Agent Lookout runs is seen and stays once more has been written after it.

### Everything else

Every other entry is passed over. `message` entries hold the prompts, the replies with their `usage`, the tools' arguments and output, and the system prompt, and the others hold summaries, an extension's data and the model's name. None of it is parsed, kept or logged. `docs/session-format.md` lists them.

## Which sessions are listed

Each session whose file was written in the last 24 hours, by its modified time, the newest 200. So a session that sits open and quiet for a day leaves the list until it is next written. One opened again after that is found by the next look through every file, within a minute.

Pi writes a file only once a session has a message, so a new session is not listed until its first prompt. With `--no-session`, nothing is written (`src/main.ts:364-365`), so it is never listed. A subagent, in the extension Pi gives as an example, runs with `--no-session` (`examples/extensions/subagent/index.ts:298`). A fork or a clone is a new file, and is listed as a session of its own.

## Status

`mapPiStatus` in `src/core/mapping/pi/piMapping.ts`:

| A `pi` program runs     | Status     |
| ----------------------- | ---------- |
| Yes, or `ps` cannot say | `unknown`  |
| No                      | `finished` |

A session is never `working`, `idle`, `needs-you` or `failed`. An `unknown` session has no status time. A `finished` session's is the file's last write, the last thing known of it.

Closing the last `pi` finishes every session at once, and opening one shows them all as unknown, so a poll while no `pi` runs has a basis of its own, `files-closed`, and is compared only with the last time none ran. A poll while `ps` cannot say is `files-without-processes`. So no notification is sent for each of them. Where `ps` is not run, a poll that lists no session is `files-without-processes` too, so a session that leaves the list is logged as ended at that poll.

### The process

**No process can be told to hold a session.** A session's file names no process, and Pi writes no lock or pid file for one. Its file locks are for its settings, its logins, its trusted projects and its updates, never a session. One process can move from one session to the next with `/new`, `/resume` or `/fork`, and which session a `pi` has could at most be read from the rest of its arguments, which Agent Lookout does not read, and a session it moved to need not be named there.

So `processes.ts` asks only whether any `pi` runs, with `ps -A -o comm=`, the name each process gives its program. Pi sets `process.title` to `pi` as it starts, or `pi-rpc` from its entry point for RPC (`src/cli/setup.ts:5`, `src/bun/runtime-setup.ts:8`, `src/rpc-entry.ts:6`), so a Pi run by Node shows as that and not as `node`. On macOS `ps` prints what Node wrote over the process's first argument, and on Linux the name Node gave the process. A Node program that sets its title that way shows as `pi` on the Mac the adapter was written on, and a test holds the real `ps` to that on macOS and Linux. No real Pi was seen.

It compares each line with `pi` and `pi-rpc`, or a path ending in one, and drops it. It asks at most every 10 seconds while there are sessions to show, and sooner, though not within 2 seconds of the last ask, when a session is written after `ps` said none runs. On macOS and Linux only.

A session whose process has gone never shows as running, since no session does. Recent writes cannot say whether Pi is working: nothing is written while a reply comes in or a tool runs, so a quiet file says nothing, and a file written a moment ago may belong to a process that has just crashed.

### A crash

A crash writes nothing, and a quit writes no line that says it was one, so the two cannot be told apart. With no `pi` left, such a session is finished, and while another `pi` runs it is unknown.

The newest lines could say more, and they are not parsed. A `user` or `toolResult` line last means a turn was under way, and an assistant line's `stopReason` says how a reply ended: `stop`, `toolUse`, `error`, `aborted` and others (`docs/message-types.md:134`). But a crash leaves a `user` or `toolResult` line last too, and with nothing to tie the session to a process, a session could show as working with nobody there, for as long as any other `pi` runs. Pi writes a turn that failed in such a line as well, so a failed turn is not shown either. Parsing any of them would mean turning into text the lines that hold what was said, for half an answer.

### Why nothing shows as waiting

Pi has no approval step of its own, so nothing asks before a tool runs. The one wait is for your next prompt, which writes nothing. An extension can stop to ask you something, such as the `permission-gate.ts` example, and that writes nothing either. `agent_settled` says Pi has stopped, to extensions and to a program that drives Pi, and writes nothing to a file. A later version could read it with a small extension that writes a status file, which would mean a person installing it in Pi.

## Names

Pi names no session by itself.

- A session has no name until something gives it one. Pi's list shows the first prompt where there is none (`src/modes/interactive/components/session-selector.ts:459`), and that is never written as a name, so nothing here parses it.
- A person gives one with `/name` (`src/modes/interactive/interactive-mode.ts:6784`), `pi --name` (`src/main.ts:721-728`) or a rename in the session picker (`interactive-mode.ts:5841`).
- A program that drives Pi over RPC gives one with `set_session_name` (`src/modes/rpc/rpc-mode.ts:659-665`), and an extension with `pi.setSessionName()` (`src/core/agent-session.ts:3494`). Pi's own extensions, under `src/extensions/`, do not. Pi cannot tell these from a person's, and an extension can read prompts, so such a name is whatever that program writes, which can be a model's title or your own words.

So a name on a `session_info` line is kept, and a session without one takes its folder's name, else its id. [What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) in PRIVACY.md says this for people.

## Quiet for

No. The file's time is there, but the page says how quiet a session is only while it is working, and a Pi session never is. So a Pi session has no `lastWriteAt`, rather than a time nothing shows.

## Token counts

No. `Session.tokens` holds the counts of the newest reply, and those are in that reply's `usage`, on the line with its text. That line is never parsed. For the same reason there is no [last message](../GUIDE.md#a-sessions-details).

## Jump, Stop and Answer

None. A session's file names no process or terminal to go to, and no process to confirm and stop, and Agent Lookout makes no request to Pi.

## On Windows

The files are read as on any system, from `%USERPROFILE%\.pi\agent\sessions`. `ps` is not run, so nothing says whether a `pi` runs: each session shows as unknown until it leaves the list, and none shows as finished. The card says so.

## Known gaps

- A session never shows as working, idle or needing you. While any `pi` runs, each listed session shows as unknown, even one that was closed an hour ago.
- Finished is all or nothing: it comes when no `pi` runs, so one `pi` left open keeps every session unknown. Nothing can say that one session ended.
- On Windows a session never shows as finished.
- A session that waits for your next prompt, or for an extension's question, does not show as waiting.
- A turn that failed does not show as failed.
- A program that runs Pi through its SDK writes sessions with no `pi` process, so they show as finished as they run, unless a `pi` also runs. A Pi started under another name, or in a container `ps` does not see into, is the same. Something else called `pi` counts as Pi, and keeps sessions from showing as finished.
- A session with no name takes its folder's name, so sessions in one folder share a name.
- A name an extension or an RPC client gave is shown as it was written, and can hold what that program chose, your own words among them.
- A name set or cleared in a long session while Agent Lookout was not reading it, before it starts or while the file is off the list, is not seen if it lies past the first 64 KiB and more than 256 KiB from the end. The session shows the newest name in the bytes read, which can be an older one or one since cleared, and its folder's name only when those bytes hold none.
- A name written in the same 2 seconds as more than 256 KiB of other lines can be missed. A name line over 4 KiB counts as no name.
- A session left quiet for a day leaves the list until it is next written, and one opened again after that takes up to a minute to appear.
- Only the newest 200 sessions written in the last day are listed.
- A rename in the session picker writes to the file, so a session closed long ago can come back for a day.
- A session in a folder `--session-dir` or the `sessionDir` setting names is not listed, nor is a file `--session` opens from elsewhere, nor a session run with `--no-session`.
- A link at a project folder is not followed, though Pi's own list follows one. `PI_CODING_AGENT_SESSION_DIR` is the way to name another disk.
- Two files that hold one id, as `--session-id` can make in two folders or `/import` can make of a copy, show as one session, from the newest.
- A file Pi can read past a broken first line is left out here: only the first line is taken for the header. An old session with no `cwd` has no folder, and shows its id.
- When Pi moves an old session to the newest format, a poll that catches the file half written leaves that session out for that poll.
- A file that could not be opened is tried again on each poll. One that was listed keeps what was read of it until then.
- A project folder that cannot be listed or looked up keeps the list it last gave, and is tried again. With no list yet, as after a restart, its sessions are left out. So is a file that cannot be looked up, which the Events log then shows as ended. The card says nothing of either.
- A session that leaves the list with none left after it, read while `ps` could not be run on macOS or Linux, or listed only while no `pi` ran, is logged as ended only when a later session is read the same way, which can be days late.
- A session's app is not shown: the file does not say which of Pi's modes wrote it.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Pi installed to check:

1. That a session's file appears at its first prompt, under `~/.pi/agent/sessions/`, on macOS, Linux and Windows, with the header above as its first line, and that `--name` puts a `session_info` line near the start.
2. That `ps -A -o comm=` shows `pi` for a Pi from npm, pnpm, Homebrew and the built binary, on macOS and Linux, and `pi-rpc` for the RPC entry point.
3. That a file's modified time moves with each line, and its folder's with each new file, on each system.
4. That a killed `pi` leaves the file as a quit does, and that a real session stays well within what is read.
5. That a name set with `/name`, the picker and `set_session_name` reads as above, with `type` first.

## What breaks when Pi changes

| Change in Pi                                       | What the dashboard shows                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| `version` goes above 3                             | Those sessions are left out, and the Sources view names a newer format |
| The folder moves, or the file ending changes       | Pi is not found, or found with no sessions                             |
| The header stops being the first line              | Those sessions are left out                                            |
| `id` allows characters it does not at this version | Those sessions are left out                                            |
| `cwd` moves or changes format                      | Sessions show their id, with no folder                                 |
| `session_info` no longer starts with `type`        | A session takes its folder's name                                      |
| Pi starts to write a name of its own from a prompt | A prompt's words can reach the name                                    |
| `process.title` changes, or Pi stops setting it    | Sessions show as finished while Pi runs                                |
| Pi starts to write a status or a pid               | Nothing changes until the adapter reads it, and sessions stay unknown  |

To check a new Pi version, read `docs/session-format.md`, `src/core/session-manager.ts`, `src/config.ts`, `src/cli/setup.ts`, `src/rpc-entry.ts`, `src/bun/runtime-setup.ts` and, in `src/main.ts`, the lines around `ENV_SESSION_DIR` and `appendSessionInfo`, and search for who calls `appendSessionInfo` and `setSessionName`. Then update `UNCHECKED_NOTE` in `src/collector/adapters/pi/index.ts` and the first paragraphs here.
