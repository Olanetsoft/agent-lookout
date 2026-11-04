# Goose adapter notes

These notes record what Agent Lookout reads from Goose, where each value comes from, and what breaks when Goose changes. When the adapter stops working, start here.

Written on 2026-11-04 from Goose's source at `v1.57.0`, released 2026-10-28 (commit `30bba95` of [block/goose](https://github.com/block/goose), which now answers as `aaif-goose/goose`), the newest release then. Goose is under the Apache-2.0 licence. Goose was not installed or run to write them, and no real session was looked at, so nothing here has been checked on a computer running Goose. The fixtures are written by hand from the source.

Each citation is `path:line` at `v1.57.0`, where `session_manager.rs` is `crates/goose/src/session/session_manager.rs`.

The code is in `src/collector/adapters/goose/`, and the status mapping is in `src/core/mapping/goose/gooseMapping.ts`.

## What the issue said, and what holds

| What issue #38 said                                   | What the source shows                                                                                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One SQLite file holds every CLI and desktop session   | True. The desktop app runs the same program as the terminal, `goose serve`, on the same database                                                                                                          |
| At `~/.local/share/goose/sessions/sessions.db`        | True on macOS and Linux, unless a setting moves it, as [Where it looks](#where-it-looks) says. On Windows it is `%APPDATA%\Block\goose\data\sessions\sessions.db`                                         |
| With a folder, a type and timestamps                  | True: `working_dir`, `session_type`, `created_at` and `updated_at`                                                                                                                                        |
| Nothing in it marks a session as running or waiting   | True of `sessions`, and only half true of the file. A tool's approval is written as a message, as [What a message could say](#what-a-message-could-say) says. It is not read, for the reasons given there |
| So status would rest on recent writes and the process | Not on recent writes, which would be a guess. The process can say only whether any Goose runs, as [The process](#the-process) says                                                                        |
| Or on a hooks plugin the person installs              | Not built. Agent Lookout installs nothing in Goose and changes no setting of its                                                                                                                          |

## How it reads Goose, and why

The adapter needs nothing installed and changes nothing, but for the one empty `-wal` [below](#how-sqlite3-opens-the-database): no hooks, no settings, no Goose program run, no network. It asks the system's `sqlite3` one fixed question when the database changes, and asks `ps` whether a Goose program runs.

Goose has other ways in, and none of them can be used that way:

| Interface                          | Why it is not used                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `goose session list`               | It starts Goose, which opens the database for writing and migrates it to its own schema (`pool` in `session_manager.rs:1107`) |
| `goose serve`, Goose's ACP server  | It takes commands, and asks for a secret the desktop app makes for itself                                                     |
| Goose's hooks                      | They would mean installing something in Goose                                                                                 |
| The logs in `~/.local/state/goose` | They hold what was said, and are not written for another program to read                                                      |

## Where it looks

`Paths::data_dir` works the folder out (`crates/goose/src/config/paths.rs:8-38`), and the database is `sessions/sessions.db` in it (`session_manager.rs:33-34`, `:1097`). The first of these that applies is used:

| Value                      | Data folder                                |
| -------------------------- | ------------------------------------------ |
| `AGENT_LOOKOUT_GOOSE_HOME` | That folder, for Agent Lookout alone       |
| `GOOSE_PATH_ROOT`          | `data` in it, when it is an absolute path  |
| `XDG_DATA_HOME`            | `goose` in it, when it is an absolute path |
| None                       | `~/.local/share/goose`                     |

Goose takes the last two from `etcetera` 0.11's `choose_app_strategy`, which is its XDG strategy on macOS as on Linux. A comment in `paths.rs` names `~/Library/Application Support/Block/goose/`, but that crate does not put Goose there at this version, and Goose's own [logs guide](https://github.com/block/goose/blob/v1.57.0/documentation/docs/guides/logs.md) gives `~/.local/share/goose/sessions/sessions.db`.

On Windows, `etcetera`'s Windows strategy gives `%APPDATA%\Block\goose\data`. Nothing is read there, as [On Windows](#on-windows) says.

## What it reads

| Path                            | How                                                                                                                         | How often                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| The data folder                 | One `stat`, which follows a link and says only what kind of thing is there. Not done when `AGENT_LOOKOUT_GOOSE_HOME` is set | On the first poll, at most once a minute while it is missing, and on every poll while it holds no database, or an empty one |
| The data folder and `sessions/` | One `lstat` each, to see each is a folder and not a link                                                                    | Every poll                                                                                                                  |
| `sessions.db`                   | One `lstat`                                                                                                                 | Every poll                                                                                                                  |
| `sessions.db-wal`, `-shm`       | One `lstat` each                                                                                                            | Every poll                                                                                                                  |
| `sessions.db` and its `-wal`    | Read by `sqlite3`, with the question below                                                                                  | When either changes by identity, size or modified time, or the `-wal` comes or goes                                         |

While the data folder is missing, and `AGENT_LOOKOUT_GOOSE_HOME` does not name it, only that `stat` is made. After a read that did not work, the question is asked again on the next change, or 10 seconds later. A database that is laid out as another version stands until it changes.

### How sqlite3 opens the database

Goose keeps the database in WAL mode (`session_manager.rs:1091`), so what it has just saved can lie in `sessions.db-wal`, and a new session can be there alone. Which way it is opened follows the files beside it, as for OpenCode's database:

| What is beside it                                                                                         | Address                              | What that does                                                                                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| No `-wal`, or an empty one                                                                                | `file:<path>?mode=ro&immutable=1`    | Takes no lock and makes no file                                                                                                       |
| A `-wal` that holds something, and the `-shm`                                                             | `file:<path>?mode=ro&readonly_shm=1` | Reads the `-wal`, and opens the `-shm` read-only. It holds SQLite's shared read lock while it runs, which does not stop Goose writing |
| Such a `-wal` with no `-shm`                                                                              | Not read                             | Reading it would make a `-shm`                                                                                                        |
| A link, or anything but an ordinary file, at any of the three names, or at the data folder or `sessions/` | Not read                             | The card says so, and nothing is opened through the link                                                                              |
| An empty `sessions.db`                                                                                    | Not read                             | SQLite would delete a `-wal` beside it                                                                                                |

A link at the data folder that leads nowhere, or to a file, is the exception, unless `AGENT_LOOKOUT_GOOSE_HOME` names that folder: the `stat` above follows it, so the card says Goose was not found.

`sqlite3` is found at fixed places only, never on `PATH`, and run directly with no shell, stdin closed, a 5 second timeout, at most 4 MiB of what it prints read, and `-init /dev/null`, so the person's `~/.sqliterc` is not run. Nothing is read on Windows.

A shared read lock is the one lock ever taken, and it is the least that reads the `-wal` at all. Reading only the file with `immutable=1` would take none, but would miss a new session until SQLite moved it out of the `-wal`.

If Goose closes the database between the `lstat` and the read, and SQLite removes the `-wal` and `-shm` as it does then, a `sqlite3` built from SQLite's own source, as on Linux, makes an empty `-wal` as it opens the database, and that read does not work. SQLite has no setting that stops it. The same goes for OpenCode's database.

### The question

`SESSIONS_QUERY` in `sessionRows.ts` asks for five named things, for the newest 200 sessions, with folders and names cut inside SQLite:

| Printed       | From                                                          | Kept as                                                                               |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `id`          | `sessions.id`                                                 | The session's id, `goose:<id>`, when it is 1 to 128 of `A-Za-z0-9_-`                  |
| `working_dir` | `sessions.working_dir`, cut to 4,097 characters               | The folder, when it is an absolute path of up to 4,096 with nothing unprintable in it |
| `own_name`    | `sessions.name`, cut to 1,000, only when `user_set_name` is 1 | The name, cleaned and cut to 200 characters                                           |
| `created_s`   | `sessions.created_at`, as whole seconds                       | `startedAt`                                                                           |
| `updated_s`   | `sessions.updated_at`, as whole seconds                       | Which sessions are listed, and when a finished session finished                       |

`strftime` does the sums inside SQLite, since Goose writes `YYYY-MM-DD HH:MM:SS` in UTC, through `datetime('now')`, and a session imported from before 1.10.0 keeps an RFC 3339 time. A value of the wrong type is taken as none, and an id that is not one Goose makes drops its row.

Only rows are looked at where `session_type` is `user`, `scheduled` or `acp`, `archived_at` is null, `updated_at` is in the last 48 hours and `messages` holds a row for the session. Of `messages`, nothing is printed and only `session_id` is named.

The probe, `PROBE_QUERY`, is asked only when the question fails, and prints only the names of two tables and of their columns, to tell a database of another version from one that cannot be read.

## Columns and values

The schema is version 17 at this tag (`session_manager.rs:32`). `sessions` is made at `:1164` and `messages` at `:1205`. Older databases are moved up as Goose opens them. The question needs `archived_at`, which came with schema version 12, in Goose v1.34.0, so an older database is reported as laid out as another version.

| Column          | Values                                                                                                      | Written                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | `YYYYMMDD_<count>`, or 1 to 128 of `A-Za-z0-9_-` when a client gives its own (`:1781`)                      | When the session is made                                                                                                                                                                                                                                                                      |
| `working_dir`   | The folder the session runs in. A session can move: `working_dir` is one of the columns `apply_update` sets | At the start, and when it moves                                                                                                                                                                                                                                                               |
| `session_type`  | `user`, `scheduled`, `sub_agent`, `hidden`, `terminal`, `gateway` or `acp` (`:62`)                          | When the session is made. `user` is `goose session`, `goose run` and the desktop app, `acp` an editor through `goose acp`, `scheduled` a scheduled job, `sub_agent` a subagent, `hidden` Goose's own, such as `goose run --no-session`, `terminal` `goose term`, and `gateway` a chat gateway |
| `name`          | What the session is called, as [Names](#names) says                                                         | At the start, by Goose after a person's first prompts, and when the person renames it                                                                                                                                                                                                         |
| `user_set_name` | 1 when the person gave the name, or an ACP client sent it (`user_provided_name`, `:241`), 0 when Goose did  | With `name`                                                                                                                                                                                                                                                                                   |
| `created_at`    | `CURRENT_TIMESTAMP`, in UTC                                                                                 | When the session is made                                                                                                                                                                                                                                                                      |
| `updated_at`    | `datetime('now')`, in UTC                                                                                   | With each message Goose saves (`:2192`) and each change to the row, such as a rename or an extension's state (`:1963`, `:2080`)                                                                                                                                                               |
| `archived_at`   | A time, or null                                                                                             | When the person archives the session                                                                                                                                                                                                                                                          |

A session has no column that says it is open, running or over, none that says it failed, and none that names a process, a terminal or a window. Goose writes nothing when it quits.

Goose's own lists are the reason for the three kinds asked for. `goose session list` shows `user` and `scheduled` (`:2524`), and the desktop app and other ACP clients those and `acp` (`crates/goose/src/acp/server.rs:133`), each session with a message (`crates/goose/src/acp/server/list_sessions.rs:118`).

## Which sessions are listed

Each session of those kinds, not archived, with a message, for 24 hours after Goose last wrote it. So a session that sits open and quiet for a day leaves the list until it is next written. A new chat in the desktop app has no message until its first prompt, and is not listed until then.

## Status

`mapGooseStatus` in `src/core/mapping/goose/gooseMapping.ts`:

| A Goose program runs    | Status     |
| ----------------------- | ---------- |
| Yes, or `ps` cannot say | `unknown`  |
| No                      | `finished` |

A session is never `working`, `idle`, `needs-you` or `failed`. An `unknown` session has no status time. A `finished` session's is `updated_at`, the last thing known of it.

Closing Goose finishes every session at once, and opening it again shows them all as unknown, so a poll while no Goose runs has a basis of its own, `database-closed`, and is compared only with the last time Goose was closed. A poll while `ps` cannot say is `database-without-processes`. So no notification is sent for each of them.

### The process

**No process can be told to hold a session.** A session's row names no process, and Goose writes no lock or pid file for a session. The one lock file it keeps in its data folder is `roam/serve.lock`, for `goose roam`, which says nothing of sessions (`crates/goose-cli/src/commands/roam.rs:616`). The terminal and the desktop app run one program, `goose`, and one `goose serve` holds every session of the desktop app. Which session a `goose` process has could at most be read from the rest of its arguments, which Agent Lookout does not read, and a resumed session need not name one there.

So `processes.ts` asks only whether any Goose runs, with `ps -A -o comm=`, the name each process gives its program. It compares each line with `goose`, `goosed`, the desktop app's server up to v1.41.0, and `goose-acp`, a server built on its own for ACP clients, and drops it. It asks at most every 10 seconds while there are sessions to show, and sooner, though not within 2 seconds of the last ask, when a session is written after `ps` said none runs. `updated_at` is in whole seconds, so a session written in the same second as that `ps` counts as written after it, which costs at most one more run. On macOS and Linux only.

The desktop app's window is a program of its own, `Goose`, which is not one of those names: what counts is the server it starts (`ui/desktop/src/gooseServe.ts:79`, `:366`). Some of Goose's own extensions run as `goose mcp`, under the same name, while their Goose runs.

A session whose process has gone never shows as running, since no session does. A crash leaves a session as a quit does: with no Goose left it is finished, and while another Goose runs it is unknown.

### What a message could say

The issue says nothing marks a session as waiting. The `sessions` table does not, and the `messages` table does, in part:

- A tool's approval is written as an `assistant` row whose `content_json` holds `{"type":"actionRequired","data":{"actionType":"toolConfirmation",…}}`, before Goose asks the person (`crates/goose/src/agents/state_machine/ops_tool_approval.rs:120`, `state_machine/session.rs`). The person's answer is a `user` row with `toolConfirmationResponse`. Goose works out what is still unanswered from those rows when it reloads a session (`pending_tool_confirmations`, `state_machine/tool_confirmation.rs:27`). That row also holds the tool's name and arguments.
- A question from an extension, an elicitation, is kept in memory (`crates/goose/src/action_required_manager.rs`).
- The newest row's `role` hints at whether a turn is under way.

None of this is read, for three reasons. A crash leaves an approval's row unanswered, and with nothing to tie the session to a process, a session could show as needing you with nobody asking, which Agent Lookout must not do, while another Goose runs. The same goes for `working` from the newest row. And it would mean opening `content_json`, which holds what was said, for half an answer: only a tool's approval is there, and in Goose's `auto` mode, its default, a tool's permission seldom asks for one.

So a session waiting for an approval shows as unknown. A later version could read this. It would need a way to rule out a crash first.

## Names

Goose's own title cannot be told from a person's first words, so it is never asked for. Only a name `user_set_name` marks is.

- A session starts with a fixed name: `CLI Session` from the command (`crates/goose-cli/src/cli.rs:453`), `New Chat` over ACP (`crates/goose/src/acp/server/new_session.rs:58`), `Scheduled job: <id>` for a scheduled one, or a recipe's title.
- After a person's first prompts, up to three, Goose writes a title beside the turn (`maybe_update_name`, `session_manager.rs:650`), with `user_set_name` 0. It leaves alone a name the person gave and a scheduled session's, and a session with a recipe keeps the recipe's title. `GOOSE_DISABLE_SESSION_NAMING` turns this off.
- By default a model writes that title, from the prompt in `crates/goose/src/prompts/session_name.md`.
- With a provider that uses local naming, no model is asked, and the title is **the first four words of the first prompt, word for word** (`generate_simple_session_description`, `crates/goose/src/providers/cli_common.rs:42`). `uses_local_session_naming` is on for `codex` and `cursor-agent`, and by default for every provider that manages its own context (`crates/goose-provider-types/src/base.rs:703`): `claude-code`, `gemini-cli` and every provider run through ACP, `AcpProvider`, such as `claude-acp`, `codex-acp`, `copilot-acp`, `amp-acp` and `pi-acp`.

Nothing on the row tells these apart. `provider_name` is the provider a session has now, which the person can change after it was named, and a new provider of this kind would pass a list of the known ones. A title is only compared with the first prompt by reading the prompt. So, as for Cline, the question leaves the title inside SQLite, and a session takes its folder's name, else its id.

A name the person gave is kept. It is `user_set_name` 1: from `goose session --name`, `goose session rename`, `goose term` with a name, or the desktop app's rename. An imported session keeps the mark it had. A fork or a copy does not take it: it has `user_set_name` 0, and its folder's name.

An ACP client can set the same mark. Goose records `sessionTitle` from `_meta` on `session/new` as user-set, so that its own naming leaves the title alone (`crates/goose/src/acp/server/new_session.rs:212`). So such a name is whatever that client sends, and no person need have chosen it.

[What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) in PRIVACY.md says this for people.

## Quiet for

No. `updated_at` is there for each session, but the page says how quiet a session is only while it is working, and a Goose session never is. So a Goose session has no `lastWriteAt`, rather than a time nothing shows.

## Token counts

No. `sessions` holds counts, but they are not read: `total_tokens` and its siblings are the provider's last figures, and a compaction replaces them with an estimate that has no output (`usage.rs`, `estimate_context`). `accumulated_*` are running totals, and neither is a reply's own.

## Jump, Stop and Answer

None. The database names no process or terminal to go to, and no process to confirm and stop, and Agent Lookout makes no request to Goose.

## On Windows

Nothing is read, and `sqlite3` and `ps` are not run, as for OpenCode and Hermes Agent. The card says Not found, with a line that says why. Goose's folder there is not looked for.

## Known gaps

- A session never shows as working, idle or needing you. While any Goose runs, each listed session shows as unknown, even one that was closed an hour ago.
- Finished is all or nothing: it comes when no Goose program runs, so one open desktop app keeps every session unknown. Nothing can say that one session ended.
- A Goose started under another name, or built into another program through its SDK, is not seen by `ps`, so its sessions show as finished as they run. Something else called `goose` counts as Goose, and keeps sessions from showing as finished.
- A session waiting for a tool's approval does not show as waiting, as [What a message could say](#what-a-message-could-say) says.
- A session Goose named takes its folder's name, so two sessions in one folder share a name. Goose's title is not shown, even where a model wrote it.
- `user_set_name` 1 also covers `sessionTitle`, which an ACP client sends, and a rename an ACP client asks for later (`on_rename_session`, `crates/goose/src/acp/server/manage_sessions.rs:216`), and nothing on the row tells either from a person's name. So a session started through such a client shows the title that client sent. No client in Goose's own source sends one at this tag.
- `goose term` and gateway sessions are not listed, as Goose's own lists leave them out. Nor is a session with no message.
- A session left quiet for a day leaves the list until it is next written.
- A rename or an extension's change moves `updated_at`, so a session closed long ago can come back for a day.
- A session id outside `A-Za-z0-9_-`, which only a session imported from before 1.10.0 can have, is dropped.
- A link at the data folder or at `sessions/` is not followed, so a person who keeps Goose's data on another disk through a link sees an error on the card. `GOOSE_PATH_ROOT` or `AGENT_LOOKOUT_GOOSE_HOME` is the way to name it.
- `sqlite3 -json` needs SQLite 3.33 or newer. An older one is a failed read.
- Goose older than v1.34.0 is not read.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Goose installed to check:

1. That `~/.local/share/goose/sessions/sessions.db` is where sessions land, for the command and the desktop app, on macOS and Linux, and that `goose session` and `goose run` write `session_type` `user`.
2. That the `-wal` and `-shm` stay beside the database while Goose runs, and what a quit leaves behind.
3. That `ps -A -o comm=` shows `goose` for the command, for the desktop app's server on each system, and for an install through npm or Homebrew, and that the desktop app's server ends with its window.
4. That `name` and `user_set_name` are as above, with a model and with a provider that uses local naming.
5. That `updated_at` reads as above through `strftime` on a real database, with one imported from an older Goose among them.

## What breaks when Goose changes

| Change in Goose                                         | What the dashboard shows                                                                                                               |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| The file or folder moves                                | Goose is not found, or found with no database                                                                                          |
| A column the question names goes, or a table is renamed | No Goose sessions, and the card says the database is laid out as another version                                                       |
| A new `session_type` for people's sessions              | Those sessions are not listed                                                                                                          |
| `updated_at` is no longer written with each message     | Sessions leave the list a day after they start                                                                                         |
| `updated_at` changes format                             | Sessions leave the list, or their times are not shown                                                                                  |
| The journal mode changes                                | The `-wal` rules no longer apply: a database in rollback mode is read whole, with `immutable=1`, so a read can catch a commit and fail |
| The program is renamed                                  | Sessions show as finished while Goose runs                                                                                             |
| `user_set_name` stops being set                         | A session the person named takes its folder's name                                                                                     |
| A name the person gave is made from a prompt            | A prompt's words can reach the name                                                                                                    |

To check a new Goose version, read `create_schema`, `apply_migration`, `create_session`, `apply_update`, `add_message`, `list_sessions` and `maybe_update_name` in `session_manager.rs`, `session_naming.rs`, `providers/cli_common.rs`, `crates/goose/src/config/paths.rs`, `crates/goose/src/acp/server/new_session.rs` and `list_sessions.rs`, `crates/goose-cli/src/cli.rs` and `ui/desktop/src/gooseServe.ts`.
