# Crush adapter notes

These notes record what Agent Lookout reads from Crush, where each value comes from, and what breaks when Crush changes. When the adapter stops working, start here.

Written on 2026-11-04 from Crush's source at `v0.99.0`, released 2026-10-29 (commit `e38655a` of [charmbracelet/crush](https://github.com/charmbracelet/crush)), the newest release then. Crush is under the Functional Source License, FSL-1.1-MIT. Crush was not installed or run to write them, and no real session, project list or `.crush` folder was looked at, so nothing here has been checked on a computer running Crush. The fixtures are written by hand from the source.

Each citation is `path:line` at `v0.99.0`.

The code is in `src/collector/adapters/crush/`, and the status mapping is in `src/core/mapping/crush/crushMapping.ts`.

## What the issue said, and what holds

| What issue #39 said                                 | What the source shows                                                                                                                                                                  |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A SQLite file for each project at `.crush/crush.db` | True by default. The folder can be elsewhere, as [Where a project's database is](#where-a-projects-database-is) says                                                                   |
| And a list of projects                              | True since v0.25.0: `projects.json` in Crush's data folder, as [The list of projects](#the-list-of-projects) says                                                                      |
| Sessions are readable                               | True: `sessions`, with an id, a title, a parent, a count of messages and two times. It has no folder: that comes from the list                                                         |
| Nothing on disk marks a session as live             | True of the database. In one mode, `CRUSH_CLIENT_SERVER=1`, a `crush.lock` names a process, which says nothing of a session, as [The process](#the-process) says                       |
| A pending permission is held in memory              | True (`internal/permission/permission.go:128`). So is a question the agent asks (`internal/question/question.go`)                                                                      |
| Status would rest on the `crush` process            | Only on whether any `crush` runs, as [The process](#the-process) says                                                                                                                  |
| And on recent writes                                | Not built: it would be a guess. A session being written now can be told from one written a minute ago, but not one in a turn from one that a crash cut off, while Crush runs elsewhere |

## How it reads Crush, and why

The adapter needs nothing installed and changes nothing, but for the one empty `-wal` [below](#how-sqlite3-opens-the-database): no hooks, no settings, no Crush program run, no network. It reads Crush's list of projects when it changes, asks the system's `sqlite3` one fixed question when a project's database changes, and asks `ps` whether a Crush program runs.

Crush has other ways in, and none of them can be used that way:

| Interface                     | Why it is not used                                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crush session list --json`   | It starts Crush, which opens the database for writing and runs its migrations (`sessionSetup`, `internal/cmd/session.go:127`). It also lists one project |
| `crush projects --json`       | It starts Crush. The file it prints is simple enough to read                                                                                             |
| `crush server` and its socket | It takes commands, and the interface uses it only with `CRUSH_CLIENT_SERVER=1`                                                                           |
| Crush's hooks                 | They would mean installing something in Crush                                                                                                            |
| `.crush/logs/crush.log`       | It is not written for another program to read, and is not sure to leave what was said out                                                                |

## The list of projects

`projects.json` sits beside `crush.json` in Crush's data folder (`projectsFilePath`, `internal/projects/projects.go:31`). The folder is worked out by `GlobalConfigData` (`internal/config/load.go:1412`), and the first of these that applies is used:

| Value                      | Data folder                                                                |
| -------------------------- | -------------------------------------------------------------------------- |
| `AGENT_LOOKOUT_CRUSH_HOME` | That folder, for Agent Lookout alone                                       |
| `CRUSH_GLOBAL_DATA`        | That folder, when it is an absolute path                                   |
| `XDG_DATA_HOME`            | `crush` in it, when it is an absolute path                                 |
| None, on macOS and Linux   | `~/.local/share/crush`                                                     |
| None, on Windows           | `%LOCALAPPDATA%\crush`, or `%USERPROFILE%\AppData\Local\crush`. Never read |

Crush takes a relative `CRUSH_GLOBAL_DATA` or `XDG_DATA_HOME` as it stands, against the folder it was started in, which nothing outside it can know. Agent Lookout goes past such a value.

The file came with v0.25.0, released 2025-12-16. A Crush older than that writes none, so Agent Lookout finds no projects, and the card says so.

```json
{
  "projects": [
    {
      "path": "/Users/example/code/demo-project",
      "data_dir": "/Users/example/code/demo-project/.crush",
      "last_accessed": "2026-10-01T11:00:00.000000000Z"
    }
  ]
}
```

`Register` (`internal/projects/projects.go:78`) rewrites the whole file each time Crush starts in a folder (`internal/cmd/root.go:321`), with that folder first, so the newest is always first. It keeps each folder once, and nothing ever takes a folder out, so a project that was deleted stays listed. It writes the file in place, with `os.WriteFile`, so a read can catch it half written.

What is written as `path`:

- The folder Crush works in, from `os.Getwd`, which can hold a link, as `$PWD` does.
- With `crush --cwd <folder>`, that folder **as it was typed** (`ResolveCwd`, `internal/cmd/root.go:988`). So a relative path is a real entry.

Only `setupLocalWorkspace` registers a folder. A session run through `CRUSH_CLIENT_SERVER=1` adds nothing to the list.

### How the list is read

- The data folder and the file are looked at with `lstat`. A link, or anything but an ordinary file or folder, at either is not followed, and the card says so. A link at the data folder that leads nowhere, or to a file, is the exception, unless `AGENT_LOOKOUT_CRUSH_HOME` names that folder: the `stat` that looks for the folder follows it, so the card says Crush was not found.
- The file is opened without following a link, and read again only when its identity, size or modified time changes.
- A file over 1 MiB is not read, and the card says so. An entry is about 200 bytes, so that is some 5,000 projects.
- A read that catches it half written, or that cannot be parsed, leaves the last list standing. With none before it, the card says it could not be read.
- Of each entry only `path` is kept. `data_dir` and `last_accessed` are never taken.
- A `path` is kept only when it is a string of at most 4,096 characters, an absolute path, with no `.` or `..` in it and nothing unprintable in it. Any other entry is skipped, and opens nothing.
- Only the first 20 folders are taken, the newest. Each is a part of its own in `health.parts`, and a machine read from another shares 60 parts among all its sources (`MAX_REMOTE_PARTS` in `src/collector/remotes/remoteSessions.ts`).

## Where a project's database is

`crush.db` lies in the data directory (`internal/db/connect.go:93`), which `internal/config/load.go:736-744` works out:

1. `--data-dir`, any folder.
2. Else `options.data_directory` from a config file, any folder, relative to the working folder or absolute.
3. Else the nearest `.crush` above the working folder, up to the root of the repository (`projectBoundary`, `:1504`).
4. Else `.crush` in the working folder.

**Agent Lookout reads `.crush/crush.db` in a listed folder and nothing else.** It never takes `data_dir` from the list: that value can name any folder on the computer, and the list is the one thing that decides what is read. So:

- A session Crush keeps through `--data-dir` or `options.data_directory` is not read, unless that folder happens to be `.crush` in a listed folder.
- Crush started in a folder under a repository that has a `.crush` at its root writes to that one. The list then has both folders, since Crush made that `.crush` when it started at the root, and the sessions show under the root's folder. If the root's entry is older than the newest 20, they do not show.

## What it reads

| Path                               | How                                                                                                                         | How often                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The data folder                    | One `stat`, which follows a link and says only what kind of thing is there. Not done when `AGENT_LOOKOUT_CRUSH_HOME` is set | On the first poll, at most once a minute while it is missing, and on every poll while it holds no list                           |
| The data folder, `projects.json`   | One `lstat` each                                                                                                            | Every poll                                                                                                                       |
| `projects.json`                    | Read whole, at most 1 MiB                                                                                                   | When it changes by identity, size or modified time                                                                               |
| A listed folder and its `.crush`   | One `lstat` each, to see each is a folder and not a link                                                                    | Every poll, for each of the newest 20                                                                                            |
| `crush.db`, `crush.db-wal`, `-shm` | One `lstat` each                                                                                                            | Every poll, for each that has a `.crush`                                                                                         |
| `crush.db` and its `-wal`          | Read by `sqlite3`, with the question below                                                                                  | When either changes by identity, size or modified time, or the `-wal` comes or goes, and either was written in the last 48 hours |

A project that has gone costs one `lstat`, and is nothing to read: no error, and no line on the card. One that cannot be looked at, for any reason but that nothing is there, as when Agent Lookout is refused or a disk fails, is not taken for gone. It is left out of `health.parts`, so its sessions stay as they were, and the card names it. So at most 102 `lstat`s a poll, and for a Crush that is not installed one `stat` a minute.

A database neither of whose files was written in the last 48 hours holds no session to list, since each write of a session's row is a commit, and each commit touches one of them. No `sqlite3` is started for it. So the reads of a poll are those of the projects written lately.

The reads of a poll share 5 seconds (`READ_BUDGET_MS`), as Hermes Agent's profiles do. The first run of `sqlite3` gets its whole 5 seconds, each later one what is left, and none starts once it is used. A project not reached keeps its last read, and the next poll starts with it. A question that had its whole 5 seconds and failed is a read that did not work, so a database that does not answer does not take every poll. After a read that did not work, the question is asked again on the next change, or 10 seconds later. A database that is laid out another way stands until it changes.

Nothing else in Crush's folder is opened: not `crush.json`, which can hold a key, in the data folder or in `.crush`, nor `crush.log`, `crush.lock`, `init` or `skills/`. No folder is listed.

### How sqlite3 opens the database

Crush keeps the database in WAL mode (`internal/db/connect.go:20`), so what it has just saved can lie in `crush.db-wal`, and a new session can be there alone. Which way it is opened follows the files beside it, as for Goose's database:

| What is beside it                                                                                            | Address                              | What that does                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| No `-wal`, or an empty one                                                                                   | `file:<path>?mode=ro&immutable=1`    | Takes no lock and makes no file                                                                                                       |
| A `-wal` that holds something, and the `-shm`                                                                | `file:<path>?mode=ro&readonly_shm=1` | Reads the `-wal`, and opens the `-shm` read-only. It holds SQLite's shared read lock while it runs, which does not stop Crush writing |
| Such a `-wal` with no `-shm`                                                                                 | Not read                             | Reading it would make a `-shm`                                                                                                        |
| A link, or anything but an ordinary file, at any of the three names, or at the listed folder or its `.crush` | Not read                             | The card gives the folder's name, and nothing is opened through the link                                                              |
| An empty `crush.db`                                                                                          | Not read                             | SQLite would delete a `-wal` beside it                                                                                                |

The path goes into the address with each name of it percent-encoded, so a `?`, `#`, `&` or `%` in a folder's name cannot add to the address, and the address begins `file:`, so no folder can be taken for an option of `sqlite3`. No path goes into a question.

The folders above a listed folder are not looked at. A path in the list could name the place they lead to anyway, so a link there adds nothing, and on some systems one always stands there: `/tmp` and `/var` on macOS, and `/home` on an atomic Fedora.

`sqlite3` is found at fixed places only, never on `PATH`, and run directly with no shell, stdin closed, a 5 second timeout, at most 4 MiB of what it prints read, and `-init /dev/null`, so the person's `~/.sqliterc` is not run. Nothing is read on Windows.

A database lies in a project's folder, so a repository can ship one, and it is read as untrusted input. `sqlite3` is given `-cmd 'PRAGMA trusted_schema=OFF'` before the address, so a view named `sessions` cannot call `edit()`, which the `sqlite3` program adds and which starts a program. `sqlite3` turns that setting off itself from 3.42 on, and one older than 3.33 has no `-json`, so this matters for 3.33 to 3.41. Every agent's read has it, though OpenCode's, Hermes Agent's, Goose's and Antigravity's databases lie in a folder of the tool's.

A shared read lock is the one lock ever taken, and it is the least that reads the `-wal` at all. Reading only the file with `immutable=1` would take none, but would miss a new session until SQLite moved it out of the `-wal`.

If Crush closes the database between the `lstat` and the read, and SQLite removes the `-wal` and `-shm` as it does then, a `sqlite3` built from SQLite's own source, as on Linux, makes an empty `-wal` as it opens the database, and that read does not work. SQLite has no setting that stops it. The same goes for OpenCode's and Goose's databases.

### The question

`SESSIONS_QUERY` in `sessionRows.ts` prints three things, for the newest 200 sessions of a project:

| Printed      | From                                 | Kept as                                                                                   |
| ------------ | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| `id`         | `sessions.id`, cut to 129 characters | The session's id, `crush:<hash of its folder>/<id>`, when it is 1 to 128 of `A-Za-z0-9_-` |
| `created_at` | `sessions.created_at`, whole seconds | `startedAt`                                                                               |
| `updated_at` | `sessions.updated_at`, whole seconds | Which sessions are listed, and when a finished session finished                           |

Only rows are looked at where `parent_session_id` is null, `message_count` is above 0 and `updated_at` is in the last 48 hours. No other table is named, so nothing of `messages`, `files` or `read_files` is ever read. A value of the wrong type is taken as none, and an id that is not one Crush makes drops its row.

`sessions` has no index on `updated_at`, so the question walks that one table. SQLite reads the pages of that table alone, so the size of the rest of the database, where the messages and files are, costs nothing.

The probe, `PROBE_QUERY`, is asked only when the question fails, and prints only the name of one table and of its columns, to tell a database of another layout from one that cannot be read.

## Columns and values

The migrations are in `internal/db/migrations/`, and `sessions` is made by the first, `20250424200609_initial.sql`. Every column the question names is in it, so no version of Crush is left out by the table. Crush moves a database up to its own migrations as it opens one.

| Column              | Values                                                                                          | Written                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | A UUID (`internal/session/session.go:102`). A subagent's run has `<message id>$$<tool call id>` | When the session is made. The interface makes one as the first prompt is sent (`ensureSession`, `internal/ui/model/ui.go:5240`), and `crush run` as it starts                |
| `parent_session_id` | Null, or the session a subagent ran for                                                         | When the session is made                                                                                                                                                     |
| `title`             | As [Names](#names) says. Never read                                                             | At the start, after the first prompt, and on a rename                                                                                                                        |
| `message_count`     | How many rows `messages` holds for the session                                                  | By a trigger, with each message added or removed                                                                                                                             |
| `created_at`        | `strftime('%s', 'now')`: whole seconds, in UTC                                                  | When the session is made                                                                                                                                                     |
| `updated_at`        | The same                                                                                        | By the trigger `update_sessions_updated_at`, on any update of the row: a new message, through `message_count`, the counts after a turn, the todos, the channel, and a rename |

A comment on `Rename` says it leaves `updated_at` alone (`internal/session/session.go:266`). The trigger still fires. That was checked by running the migration's own statements in `sqlite3`: a rename moves `updated_at`, a new message moves it, and an update of a message does not. So `updated_at` moves with each message Crush adds, and not while a reply streams into its row.

A session has no column that says it is open, running or over, none that says it failed, and none that names a process, a terminal or a window. Crush writes nothing when it quits. A hook can see `SessionEnd`, but that is Crush's own hook, and only on a quit.

`ListSessions` is the reason for the first condition: `WHERE parent_session_id is NULL` (`internal/db/sql/sessions.sql:37`). Crush has no archive.

## Which sessions are listed

Each session with no parent and a message, for 24 hours after Crush last wrote it, from the newest 20 projects. So a session left open and quiet for a day leaves the list until it is next written.

## Status

`mapCrushStatus` in `src/core/mapping/crush/crushMapping.ts`:

| A Crush program runs    | Status     |
| ----------------------- | ---------- |
| Yes, or `ps` cannot say | `unknown`  |
| No                      | `finished` |

A session is never `working`, `idle`, `needs-you` or `failed`. An `unknown` session has no status time. A `finished` session's is `updated_at`, the last thing known of it.

Closing Crush finishes every session at once, and opening it again shows them all as unknown, so a poll while no Crush runs has a basis of its own, `database-closed`, and is compared only with the last time Crush was closed. A poll while `ps` cannot say is `database-without-processes`. So no notification is sent for each of them. Each project read is named in `health.parts` with the same way, so a database that could not be read on one poll leaves its sessions as they were.

### The process

**No process can be told to hold a session.** A session's row names no process, and in its usual mode Crush writes no lock or pid file. The name of a program does not say which project it works in. Which folder a `crush` runs in could be asked of the system, but that means reading more of a process than its name, which Agent Lookout does not do here, and it would still not say which session of that folder.

So `processes.ts` asks only whether any Crush runs, with `ps -A -o comm=`, the name each process gives its program. It compares each line with `crush` and drops it. On macOS `ps` prints a process's first argument, and on Linux the name of the file it was started from. It asks at most every 10 seconds while there are sessions to show, and sooner, though not within 2 seconds of the last ask, when a session is written after `ps` said none runs. `updated_at` is in whole seconds, so a session written in the same second as that `ps` counts as written after it, which costs at most one more run. On macOS and Linux only.

`crush.lock` in a data directory is the one file that names a process (`internal/db/datadirlock.go:23`, `:93`). It is not read. `crush server` writes it only with `CRUSH_CLIENT_SERVER=1` (`internal/backend/backend.go:463`), one server holds many sessions, and the file stays behind after that server ends, since what holds it is a `flock` on it, which Node cannot ask about. Its process ID could by then be another program's.

A session whose process has gone never shows as running, since no session does. A crash leaves a session as a quit does: with no Crush left it is finished, and while another Crush runs it is unknown.

### What a message could say

The issue says nothing marks a session as live. The `sessions` table does not, and the `messages` table does, in part:

- A reply's row has `finished_at` null until that reply ends (`write`, `internal/message/message.go:430`).
- A failed turn is a `finish` part with reason `error` inside `parts` (`internal/agent/agent.go:1208`), which holds what was said. A failure Crush can see is there. A crash is not.
- A tool's call is a part of `parts`, with no result beside it while it waits for a permission. That row holds the tool's name and arguments.

None of this is read, for three reasons. A crash leaves `finished_at` null, and with nothing to tie the session to a process, a session could show as working with nothing running, which Agent Lookout must not do, while Crush runs in another project. The same goes for a tool's call and a wait. And a failure means opening `parts`, which holds what was said.

So a session waiting for a permission shows as unknown. A later version could read `finished_at` alone. It would need a way to rule out a crash first.

## Names

Crush's title cannot be told from a person's first words, so it is never asked for. A session takes its folder's name, else its id, as for Cline.

- A session starts with a fixed title: `New Session` from the interface (`internal/ui/model/ui.go:5244`), `Untitled Session` from `crush run` (`internal/app/hooks.go:55`), or `non-interactive` from `crush run` with `CRUSH_CLIENT_SERVER=1` (`internal/cmd/run.go:750`).
- After the first prompt with text, Crush asks a small model for a title of at most 50 characters (`GenerateTitle`, `internal/agent/agent.go:1803`, and `internal/agent/templates/title.md`).
- If no model answers, the title is `Untitled Session`.
- **If the model answers with nothing, the title is the first 50 characters of the prompt, word for word** (`:1898-1903`). A model that only thinks does this, since Crush takes its `<think>` tags out of the answer.
- A person can rename a session with `crush session rename` or in the interface's list of sessions, which writes the same column.

Nothing on the row tells these apart: there is no field like Goose's `user_set_name`. The first prompt is only compared with a title by reading the prompt, which holds what was said, and the title's newlines and its cut at 50 characters make such a comparison unsafe anyway. So the question leaves the title inside SQLite. The name a person gave is lost with the rest, which is the price of never showing what was typed.

[What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) in PRIVACY.md says this for people.

## Quiet for

No. `updated_at` is there for each session, but the page says how quiet a session is only while it is working, and a Crush session never is. So a Crush session has no `lastWriteAt`, rather than a time nothing shows.

## Token counts

No. `sessions` holds `prompt_tokens` and `completion_tokens`, but they are not read: the title's call is added to them, and a summary sets `prompt_tokens` to 0 (`internal/agent/agent.go:1539`, `:1940`), so neither is a reply's own.

## Jump, Stop and Answer

None. The database names no process or terminal to go to, and no process to confirm and stop, and Agent Lookout makes no request to Crush.

## On Windows

Nothing is read, and `sqlite3` and `ps` are not run, as for OpenCode, Hermes Agent and Goose. The card says Not found, with a line that says why. Crush's folder there is not looked for.

## Known gaps

- A session never shows as working, idle or needing you. While any Crush runs, each listed session shows as unknown, even one closed an hour ago in another project.
- Finished is all or nothing: it comes when no Crush program runs, so one open Crush keeps every session unknown. Nothing can say that one session ended.
- A Crush started under another name is not seen by `ps`, so its sessions show as finished as they run. Something else called `crush` counts as Crush, and keeps sessions from showing as finished.
- A session waiting for a permission does not show as waiting, as [What a message could say](#what-a-message-could-say) says.
- Crush's title is never shown, even where a model wrote it or a person chose it, so two sessions in one folder share a name.
- Only the newest 20 projects are read. An entry for a folder that has gone takes up one of the 20.
- A session kept in a folder other than `.crush` in a listed folder is not read, as [Where a project's database is](#where-a-projects-database-is) says. So is a session run only through `CRUSH_CLIENT_SERVER=1`, unless the folder is listed anyway.
- An entry with a relative path, as `crush --cwd` can write, is not read.
- A listed folder, or its `.crush`, reached by a link is not read, and the card names it. The folders above it are not looked at.
- A link at the data folder is not followed to read the list, so a person who keeps Crush's data on another disk through a link sees an error on the card. `CRUSH_GLOBAL_DATA` or `AGENT_LOOKOUT_CRUSH_HOME` is the way to name it.
- A session left quiet for a day leaves the list until it is next written.
- A rename moves `updated_at`, so a session closed long ago can come back for a day.
- A folder copied with its `.crush` shows its sessions twice, once for each folder, each with an id of its own.
- A project not read is named on the card by its folder's name alone, so two folders of one name read alike.
- On another machine, its sources share 60 parts. Today they name at most 51, these 20 projects, Hermes Agent's 17 profiles and one for each of the other 14 sources, so a database that fails there leaves its sessions as they were here too. Past 60, which a later version there could reach, each source is compared as a whole, Hermes Agent's profiles too, so a database that fails there shows its sessions as ended here.
- `sqlite3 -json` needs SQLite 3.33 or newer. An older one is a failed read.
- A Crush older than v0.25.0 keeps no list, so nothing of it is read.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Crush installed to check:

1. That `~/.local/share/crush/projects.json` is written, on macOS and Linux, as above, and that a folder in it can hold a link when Crush is started through one.
2. That `.crush/crush.db` holds sessions as above, for the interface and for `crush run`.
3. That the `-wal` and `-shm` stay beside the database while Crush runs, and what a quit leaves behind.
4. That `ps -A -o comm=` shows `crush` for the interface, for `crush run` and for each install: Homebrew, npm, a Linux package and Nix, whose wrappers can start a program under another name.
5. That `title` is as above, with a model that answers and one that answers with nothing.
6. That `updated_at` moves as above on a real database.
7. What a database older than this version's migrations looks like before Crush moves it up.

## What breaks when Crush changes

| Change in Crush                                         | What the dashboard shows                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The data folder moves                                   | Crush is not found                                                                                                                     |
| `projects.json` moves, or stops being written           | Crush is found, with no list                                                                                                           |
| Its fields are renamed                                  | The card says the list could not be read, or no project is listed                                                                      |
| The list stops being kept newest first                  | The 20 read are not the newest                                                                                                         |
| `.crush/crush.db` moves                                 | No project holds a database                                                                                                            |
| A column the question names goes, or a table is renamed | No sessions from that project, and the card says it is laid out in a way Agent Lookout does not read                                   |
| `updated_at` stops moving with each message             | Sessions leave the list a day after they start                                                                                         |
| `updated_at` changes unit                               | Sessions leave the list, or their times are not shown                                                                                  |
| The journal mode changes                                | The `-wal` rules no longer apply: a database in rollback mode is read whole, with `immutable=1`, so a read can catch a commit and fail |
| The program is renamed                                  | Sessions show as finished while Crush runs                                                                                             |

To check a new Crush version, read `internal/projects/projects.go`, `GlobalConfigData` and the part of `load.go` that sets `DataDirectory`, `internal/db/connect.go`, `internal/db/sql/sessions.sql`, any new file in `internal/db/migrations/`, `GenerateTitle` in `internal/agent/agent.go`, `setupLocalWorkspace` in `internal/cmd/root.go` and `.goreleaser.yml`.
