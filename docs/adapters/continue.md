# Continue adapter notes

These notes record what Agent Lookout reads from Continue, where each value comes from, and what breaks when Continue changes. When the adapter stops working, start here.

Written on 2026-11-04 from Continue's source at `v1.5.45`, released 2026-03-04 (commit `abb1fc0` of [continuedev/continue](https://github.com/continuedev/continue)), the newest release of its `cn` command then. Continue is under the Apache-2.0 licence at that tag. Continue was not installed or run to write them, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from Continue's source at v1.5.45 and has not yet been checked on a computer running Continue.** The Sources view says so too.

The same day, the files below were compared with `v2.1.0-vscode`, the newest tag of the editor extension, and with `main`. `save` in `core/util/history.ts`, the session paths in `core/util/paths.ts`, how an editor sets a title and `workspaceDirectory`, and `cn`'s Node wrapper are the same there. What differs that touches a session is that there `cn` no longer saves a session with no messages.

Each citation is `path:line` at `v1.5.45`, from the top of that repository. `gui/` is the chat panel both editors show.

The code is in `src/collector/adapters/continue/`. There is no status mapping in `src/core/mapping/`, as no state of Continue's is read.

## What the issue said, and what holds

| What issue #42 said                                                 | What the source shows                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One JSON file per session in `~/.continue/sessions/`, with an index | True, on macOS, Linux and Windows, unless a setting moves them, as [Where it looks](#where-it-looks) says. The index is `sessions.json`                                                                                                                                   |
| The same for its editor extensions and its `cn` CLI                 | True. Both write through `HistoryManager.save` (`core/util/history.ts:101`). How often they write, the form of the folder and the way a title is made differ, as [The editors](#the-editors) and [Names](#names) say                                                      |
| Nothing marks a session as running                                  | True. Continue writes no status, no end, no pid and no lock for a session                                                                                                                                                                                                 |
| In the CLI, a tool call waiting for approval is written `generated` | True, and of no use here. Every tool call is written `generated` before its permission is checked, one that needs no approval too, and a crash leaves a call as it was, as [A tool call waiting for approval](#a-tool-call-waiting-for-approval) says. So Needs you is No |
| That is read from its source and is not documented                  | True of its docs. A comment on the type says it (`core/index.d.ts:499`)                                                                                                                                                                                                   |

## How it reads Continue, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no Continue program run, no network. It reads one file, `sessions.json`, read-only, and looks up when each recent session's file was written. It opens no session's file, because nothing in one could be used without guessing.

Continue has other ways in, and neither can be used that way:

| Interface      | Why it is not used                                                                                                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cn ls --json` | It starts Continue's own program, reads every recent session's whole file for its first prompt, and asks Continue's servers for remote sessions once signed in (`extensions/cli/src/session.ts:385`, `:485`, `:502`) |
| `cn serve`     | It is a server for one session of its own, on a port nothing on disk names                                                                                                                                           |

## Where it looks

Continue works the folder out in `core/util/paths.ts:27-36`, and `cn` the same way in `extensions/cli/src/session.ts:54-57`. The first of these that is set is used, and an empty one counts as unset:

| Setting                       | Sessions folder                                     |
| ----------------------------- | --------------------------------------------------- |
| `AGENT_LOOKOUT_CONTINUE_HOME` | `<folder>/sessions`, for Agent Lookout alone        |
| `CONTINUE_GLOBAL_DIR`         | `<folder>/sessions`, when it is an absolute path    |
| None                          | `~/.continue/sessions`, on macOS, Linux and Windows |

`~` is the home folder, `os.homedir()` in Continue and in Agent Lookout, which on Windows is `C:\Users\<name>`. A relative `CONTINUE_GLOBAL_DIR` means a folder relative to where Continue was started, which cannot be known here, so the adapter goes past it.

When the folder is missing, Continue is reported as not found, with no advice, and the folder is looked for again once a minute, or on every poll when `AGENT_LOOKOUT_CONTINUE_HOME` is set, with one `lstat`. Continue makes it the first time it is asked for (`core/util/paths.ts:78-84`). When `AGENT_LOOKOUT_CONTINUE_HOME` names a folder with nothing in it, that is an answer, not a missing Continue: the source is watched and lists no sessions.

Two things that move Continue's folder cannot be followed:

- A `.env` file where Continue starts, which `dotenv.config()` reads before `CONTINUE_GLOBAL_DIR` is looked at (`core/util/paths.ts:15`). A person who keeps the setting there can start Agent Lookout with `CONTINUE_GLOBAL_DIR` set to the same folder.
- `CONTINUE_CLI_TEST`, with `HOME`, which `cn` keeps for its own tests (`extensions/cli/src/session.ts:43-52`).

## What it reads

| Path                                      | How                                                 | How often                                                                                                  |
| ----------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| The sessions folder                       | One `lstat`, to see that it is a folder and no link | Every poll, and while it is missing once a minute, or every poll when `AGENT_LOOKOUT_CONTINUE_HOME` is set |
| `sessions.json`                           | One `lstat`                                         | Every poll                                                                                                 |
| The same file                             | Opened read-only and read whole, up to 8 MiB        | When its size, modified time or identity changes                                                           |
| `<id>.json` of a session written lately   | One `lstat`. Never opened                           | Every poll, for the newest 200 written in the last day                                                     |
| `<id>.json` of every other session listed | One `lstat`. Never opened                           | Once a minute                                                                                              |

Continue removes no session by itself, so the folder can hold thousands. With 5,000 old sessions and one written lately, a poll is three `lstat` calls and opens nothing, and a test holds it to that. Each save moves `sessions.json`, so while Continue is busy the list is read again on each poll. At about 250 bytes a session, that is about a megabyte at 5,000 sessions.

`sessions.json` is opened without following a link at its name and without waiting on a pipe, and read only if the open file is an ordinary file. A link in place of a session's file is not a session, and its target is never looked at. A link in place of the sessions folder is not followed, and the card says so. The folder above it can be a link. Nothing else in Continue's folder is read: not `config.yaml`, `config.json`, `.env`, `index/`, `logs/` or anything beside the sessions folder.

## The list

`sessions.json` is one JSON array, written with `JSON.stringify(list, undefined, 2)`, oldest session first (`core/util/history.ts:36-37`).

| Field                | Meaning                                                                                                                      | Kept                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `sessionId`          | The session's id, and its file's name. A UUID, or what `cn serve --id` is given (`extensions/cli/src/commands/serve.ts:174`) | Yes, when it is letters, digits, `.`, `_` and `-`, of 200 characters or less, and starts with a letter or digit |
| `workspaceDirectory` | The session's folder, as [The folder](#the-folder) says                                                                      | Yes, when it is an absolute path on this computer of up to 4,096 characters with nothing unprintable in it      |
| `dateCreated`        | When it was first saved: `String(Date.now())` (`core/util/history.ts:161`)                                                   | Yes, when it is digits. A time before 2020, or ahead of the clock, is treated as none                           |
| `title`              | Its title, as [Names](#names) says                                                                                           | No: dropped with the parsed file, never copied, kept or logged                                                  |
| `messageCount`       | How many replies it holds                                                                                                    | No                                                                                                              |

A session's id in Agent Lookout is `continue:<id>`. Anything else in the array is passed over, as is an entry with a bad id, or in Continue's old format, which has `session_id` and which Continue passes over too (`core/util/history.ts:36`). Any other bad value is treated as none. A file that is not a JSON array shows the card as Not working, with why. So does a file over 8 MiB, which is not read: one array cannot be read from its end. An empty file is an empty list, as it is for Continue (`:135`).

**What writes it, and when.** `HistoryManager.save` writes the session's file, then the list, each with `fs.writeFileSync` in place, with no temporary file (`core/util/history.ts:121`, `:168`). So a read can catch either one empty or half written. When the list reads as broken or empty after one that held sessions, what was read before stands in for one poll, so no session seems to end. A list that stays so is taken as it is.

Deleting a session removes its file and its entry (`:50-75`), and clearing the history removes the folder (`:77-79`).

### The folder

`workspaceDirectory` is written differently by each:

| Written by                    | Value                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cn`                          | The path it runs in, `process.cwd()` (`extensions/cli/src/session.ts:326`)                                                                                                                         |
| VS Code                       | The URI of the first workspace folder (`extensions/vscode/src/ContinueGUIWebviewViewProvider.ts:166-170`): `file:///Users/you/code/demo`, or on Windows `file:///c%3A/Users/you/code/demo`         |
| A JetBrains editor            | The same (`extensions/intellij/src/main/kotlin/com/github/continuedev/continueintellijextension/utils/Utils.kt:83`): `file:///Users/you/code/demo`, or on Windows `file:///C:/Users/you/code/demo` |
| An editor with no folder open | Nothing (`gui/src/redux/thunks/session.ts:297`)                                                                                                                                                    |
| VS Code on a remote machine   | A URI of another kind, such as `vscode-remote://`, which names no folder on this computer                                                                                                          |

So a `file:` URI is read back into a path, on the rules of the system Agent Lookout runs on, and any other kind of URI is no folder. A session with no folder is named by its id.

## A session's file

`<id>.json` is one pretty-printed JSON object: `sessionId`, `title`, `workspaceDirectory`, `history`, then `mode`, `chatModelTitle` and `usage` when they are set (`core/util/history.ts:105-120`). `history` holds every prompt, reply and tool call, with a tool's arguments and output. It is never opened. Its modified time is all that is taken from it, since the list has no time of a last write.

## Which sessions are listed

Each session in the list whose file was written in the last 24 hours, by its modified time, the newest 200. So a session that sits open and quiet for a day leaves the list until it is next written. One opened again after that is found by the next look through every session, within a minute.

## Status

Always `unknown`, with no status time. A session is never `working`, `idle`, `needs-you`, `finished` or `failed`. It is shown for a day after it was last written, and then leaves the list.

### The process

**No process can be told to hold a session, and `ps` cannot show `cn`.** A session's files name no process, and Continue writes no lock or pid file for one. The only use of its own pid in `cn` is to signal itself or to count its open files.

`cn` is a Node script: its command is a file that starts `#!/usr/bin/env node` (`extensions/cli/build.mjs:94-97`), and both of its install scripts and `npm i -g @continuedev/cli` install it that way (`extensions/cli/README.md:9-25`). It sets no `process.title`, at this tag or on `main`. So `ps -A -o comm=`, the name each process gives its program, prints `node`, as it does for every other Node program that sets no title, Agent Lookout among them. Which program a `node` runs could only be read from its arguments, and Agent Lookout reads arguments only for a program `ps` has named as `agy` (`src/collector/adapters/antigravity/cli/agyProcesses.ts`). So `ps` is not run for Continue, and nothing can say that none runs, which is why no session shows as finished.

A session whose process has gone never shows as running, since no session does. Recent writes are not used either: a file written a moment ago may belong to a `cn` that has just crashed, and a quiet file says nothing.

### A tool call waiting for approval

`cn` writes a tool call as `generated` when it adds the reply that asked for it (`extensions/cli/src/services/ChatHistoryService.ts:185`, `extensions/cli/src/stream/handleToolCalls.ts:75`). Then it checks the call's permission (`extensions/cli/src/stream/streamChatResponse.helpers.ts:556`). If it may run, it is rewritten as `calling` (`:598`), and if it is refused, as `canceled` (`:575`). The file is saved at each of these (`extensions/cli/src/services/ChatHistoryService.ts:73`).

So `generated` in a file can mean three things: a call waiting for approval, the moment before a permitted call runs, or a call whose `cn` crashed. The first and the third cannot be told apart. Kimi Code's adapter tells them apart by a lock whose process it can ask about, and Qwen Code's by a process id on a list of running sessions. Continue has neither. A session a crash left behind would show as needing you for a day, so Needs you is No, and no session's file is opened for it.

### A crash

A crash writes nothing, and a quit writes no line that says it was one, so a session a crash left behind reads as one that was closed and as one still open. It shows as unknown, and leaves the list a day after it was last written.

### Failed

No. `errored` is the state of one tool call, not of a turn. When a request fails, `cn` shows it in a system line (`extensions/cli/src/ui/hooks/useChat.ts:342-353`), and system lines are dropped before a save (`extensions/cli/src/session.ts:217-220`). An editor shows it in a dialog (`gui/src/redux/thunks/streamThunkWrapper.tsx`).

## Names

Continue's title comes from more than one place, and nothing says which:

- `cn` starts a session as `Untitled Session` (`extensions/cli/src/constants/session.ts:4`). After the first reply a model writes a title of 3 or 4 words from that reply (`extensions/cli/src/ui/hooks/useChat.stream.helpers.ts:52-64`, `extensions/cli/src/commands/chat.ts:308-330`, `core/util/chatDescriber.ts:12-13`). A person can set one with `/title` (`extensions/cli/src/slashCommands.ts:145-161`).
- An editor starts one as `New Session`, then does the same with its first reply (`gui/src/redux/thunks/session.ts:251-275`). A person can rename one in its history (`gui/src/components/History/HistoryTableRow.tsx:78`).
- **An editor falls back to the prompt.** With `disableSessionTitles` set, when that call fails or gives nothing, or when a session is saved with no title asked for, the title is the last line of the first message, cut to 100 characters, word for word (`gui/src/redux/thunks/session.ts:216-228`, `:278`).

So a title can be what was typed, and no field says when it is not. It is never kept, and a session takes its folder's name, else its id. The form of the folder could tell most of `cn`'s sessions from an editor's, and their titles are a model's or a person's. That is not done: both read the same list, one session can be opened in each, and a title kept by mistake is your own words. [What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) in PRIVACY.md says this for people.

## Quiet for

No. The file's time is there, but the page says how quiet a session is only while it is working, and a Continue session never is. So a Continue session has no `lastWriteAt`, rather than a time nothing shows.

## Token counts

No. `Session.tokens` holds the counts of the newest reply, and those are in that reply's entry in the session's file, which is never opened. For the same reason there is no [last message](../GUIDE.md#a-sessions-details).

## Jump, Stop and Answer

None. A session's files name no process or terminal to go to, and no process to confirm and stop, and Agent Lookout makes no request to Continue. `cn serve` takes an answer over HTTP (`extensions/cli/src/commands/serve.ts:272`), on a port nothing on disk names.

## The editors

Continue's VS Code and JetBrains extensions write to the same folder, through the same `HistoryManager.save`, by the `history/save` message (`core/core.ts:362-364`). `cn` saves at every change to a session's history. An editor saves when a reply's stream ends (`gui/src/redux/thunks/streamThunkWrapper.tsx:28-36`) and when you move to another session.

An editor's session can be told from `cn`'s. Its `workspaceDirectory` in the list is a URI, as [The folder](#the-folder) says, where `cn`'s is a path, and its file has `mode` and `chatModelTitle`, where `cn`'s has `usage`. The adapter uses the URI only to find the folder. So an editor's sessions are listed beside `cn`'s, in the same way, and the app is not shown.

An editor writes `generated` too (`gui/src/redux/slices/sessionSlice.ts:835-848`), and it says no more there than it does for `cn`.

## On Windows

The files are read as on any system, from `%USERPROFILE%\.continue\sessions`. Nothing differs but the form of a folder: a `file:` URI is read on Windows' rules, with its drive letter. `ps` is run nowhere for Continue, so a session shows as it does on a Mac.

## Known gaps

- A session never shows as working, idle, needing you, finished or failed. Each listed session shows as unknown, even one that was closed an hour ago, and even one that waits for your approval.
- A session takes its folder's name, so sessions in one folder share a name. A title a model or you gave it is not shown.
- A session with no folder, or on a remote workspace, shows its id.
- A session left quiet for a day leaves the list until it is next written, and one opened again after that takes up to a minute to appear.
- Only the newest 200 sessions written in the last day are listed.
- A session whose id has a character other than letters, digits, `.`, `_` and `-`, as `cn serve --id` can give it, is not listed.
- A session's file with no entry in the list is not listed. `cn`'s `--resume` finds such a file, as it looks through the folder (`extensions/cli/src/session.ts:283-299`).
- A link in place of the sessions folder is not followed, though Continue follows one. The card says so, and `AGENT_LOOKOUT_CONTINUE_HOME` can name the folder that holds the real one.
- A list over 8 MiB is not read, and the card says so.
- A broken `sessions.json` lists no session until Continue or you repair it. Continue itself then saves a session's file and stops at the list (`core/util/history.ts:173-180`).
- A session a file's `lstat` fails for is left out until the next look through every session, within a minute. The card says nothing of that.
- A folder set in a `.env` file is not followed. Nor is a relative `CONTINUE_GLOBAL_DIR`.
- A session's app is not shown.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Continue installed to check:

1. That `~/.continue/sessions/sessions.json` and a `<id>.json` for each session appear on macOS, Linux and Windows, from `cn` and from each editor, with the fields above.
2. That `cn` at v1.5.45 writes a session as soon as it opens, with no messages, as `saveSession` allows at this tag, and so lists one before any prompt.
3. That VS Code and a JetBrains editor write `workspaceDirectory` in the URI forms above, on each system, and what each writes for a folder on another disk or a network share.
4. That `ps -A -o comm=` shows `node` for `cn`, however it was installed, on macOS and Linux.
5. That a file's modified time moves at each save, on each system.
6. That a real list stays well within 8 MiB, and how long one read of it takes.
7. That a version of Continue older than v1.5.45 writes these fields. None was read, so no oldest version is named.

## What breaks when Continue changes

| Change in Continue                                 | What the dashboard shows                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| The folder moves                                   | Continue is not found                                                    |
| `sessions.json` is renamed or dropped              | Continue is found, with no sessions                                      |
| `sessions.json` stops being a JSON array           | The card says Not working                                                |
| `sessionId` is renamed                             | Continue is found, with no sessions                                      |
| A session's file moves or is renamed               | Continue is found, with no sessions                                      |
| `workspaceDirectory` moves or changes form         | Sessions show their id, with no folder                                   |
| `dateCreated` changes form                         | Sessions show no start time                                              |
| `cn` starts to set a `process.title`               | Nothing changes until the adapter asks `ps`. Finished could then be told |
| Continue starts to write a status, a pid or a lock | Nothing changes until the adapter reads it, and sessions stay unknown    |

To check a new Continue version, read `core/util/history.ts`, `core/util/paths.ts`, `core/index.d.ts`, `extensions/cli/src/session.ts`, `extensions/cli/src/services/ChatHistoryService.ts`, `extensions/cli/src/stream/streamChatResponse.helpers.ts` and `extensions/cli/build.mjs`, and, in `gui/src/redux/thunks/session.ts`, `saveCurrentSession`. Then update `UNCHECKED_NOTE` in `src/collector/adapters/continue/index.ts` and the first paragraphs here.
