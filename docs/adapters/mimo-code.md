# MiMo Code adapter notes

These notes record what Agent Lookout reads from MiMo Code, where each value comes from, and what breaks when MiMo Code changes. When the adapter stops working, start here.

Written on 2026-11-17 from MiMo Code's source at the tag `v0.1.17` of [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code). MiMo Code is under the MIT licence, and its `LICENSE` names both Xiaomi's MiMo Code and opencode. Its command, `mimo`, is built from OpenCode's source. MiMo Code was not installed or run to write these notes, and no real session or `mimocode.db` was looked at, so nothing here has been checked on a computer running MiMo Code. The source was read file by file at the tag. The fixtures are written by hand from it.

Each citation is under `packages/` at `v0.1.17`. It is `path:line` for the short files whose lines were checked, and the path and the name of a function, a constant or a case for the long ones.

The code is in `src/collector/adapters/mimo-code/index.ts`. It is the OpenCode adapter's body, `createOpencodeFamilyAdapter` in `src/collector/adapters/opencode/index.ts`, with `MIMO_CODE_PROFILE`, an `OpencodeProfile` from `src/collector/adapters/opencode/profile.ts`. The status mapping is OpenCode's, in `src/core/mapping/opencode/opencodeMapping.ts`, with two more rules. Everything [the OpenCode notes](opencode.md) say of OpenCode 1.x holds here unless this page says otherwise, and a change to those modules changes MiMo Code too.

## What the issue said, and what holds

| What issue #77 said                                                                                           | What the source shows                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every session is in one SQLite database in WAL mode, `~/.local/share/mimocode/mimocode.db` on macOS and Linux | True (`cli/src/storage/db.ts:32-37`, `:94`, `shared/src/global.ts:26-50`)                                                                                                                                                                                                                                                 |
| Under `$XDG_DATA_HOME/mimocode/` or `$MIMOCODE_HOME/data/` when they are set                                  | True. `MIMOCODE_HOME` wins, and MiMo Code stops when it is not an absolute path (`global.ts:27-37`)                                                                                                                                                                                                                       |
| `MIMOCODE_DB` can point to another file                                                                       | True: an absolute path, a path in the data folder, or `:memory:` (`db.ts:40-44`)                                                                                                                                                                                                                                          |
| Pre-release builds write `mimocode-<channel>.db`                                                              | Not by default. Every build writes `mimocode.db` unless `MIMOCODE_DISABLE_CHANNEL_DB` is `false` or `0` (`db.ts:33-36`, `MIMOCODE_DISABLE_CHANNEL_DB` in `cli/src/flag/flag.ts`), as [Where it looks](#where-it-looks) says                                                                                               |
| The README's macOS folder is not what the code uses                                                           | True: xdg-basedir 5.1.0 has no case for macOS or Windows                                                                                                                                                                                                                                                                  |
| MiMo Desktop uses MiMo Code as its engine and shares the same data                                            | Not checked here. MiMo Desktop has no public source, and it was not read                                                                                                                                                                                                                                                  |
| `session` has the folder, title, times, `parent_id` and `time_archived`                                       | True (`cli/src/session/session.sql.ts:24`, `:28-29`, `:46`, `:48`). It also has `title_source` (`:30`), and a title marked `fallback` is the first line of the person's prompt, as [Names](#names-tokens-and-the-rest) says, and `title_revision` (`:31`), 0 when a session is made and 1 more on each write of its title |
| The main agent's (`agent_id = 'main'`) last assistant message says when a turn ends and when it fails         | True, with two more things to read. Subagents work in the same session, so their messages sit beside the main agent's (`session.sql.ts:95`), and while one of them is `pending` or `running` in `actor_registry` the session is working. `time.completed` is set at the end of every step, and never with an error        |
| A `question` part in the state `running` waits for an answer                                                  | True, and so does a `plan_exit` part, which asks through the same question                                                                                                                                                                                                                                                |
| Approval waits, and busy or idle, are in memory only                                                          | True (`cli/src/permission/index.ts`, `cli/src/session/status.ts`)                                                                                                                                                                                                                                                         |
| Nothing records whether a process still has a session open                                                    | True of what the adapter reads. Each actor's row of `actor_registry`, the main agent's too, keeps the id of the process that registered it (`cli/src/actor/actor.sql.ts:37`). The main agent's row is made `pending` with the session, and its turns leave it so. No `instance_id` is read                                |
| Agent Lookout reads no SQLite today                                                                           | Out of date. It reads OpenCode's database with the system's `sqlite3`, and this adapter reads MiMo Code's the same way                                                                                                                                                                                                    |
| It is checked on a machine running MiMo Code                                                                  | Not done, as [Not yet checked](#not-yet-checked) says                                                                                                                                                                                                                                                                     |

## How it reads MiMo Code, and why

As for OpenCode: it looks at `mimocode.db` and the two files SQLite keeps beside it, asks the system's `sqlite3` two fixed questions when the database or its `-wal` changes, and asks `ps` whether a MiMo Code program runs. It runs no program of MiMo Code's: any `mimo` command makes MiMo Code's folders as it starts (`cli/src/global/index.ts:28-32`), and opening the database runs a checkpoint of its `-wal` (`db.ts:98`). It makes no request to MiMo Code's server. It reads no last message and nothing on Windows.

## Where it looks

- **The data folder.** `AGENT_LOOKOUT_MIMO_CODE_HOME` if set, and then MiMo Code's own variables are not read. Otherwise `data` in MiMo Code's own `MIMOCODE_HOME`, when that is an absolute path (`global.ts:27-37`). MiMo Code refuses one that is not absolute and stops (`:29-33`), so such a one is passed over, and so is an empty one. Otherwise `mimocode` in `XDG_DATA_HOME`, when that is an absolute path, or else `~/.local/share/mimocode` (`global.ts:6`, `:45`, and `xdgData` in xdg-basedir 5.1.0's `index.js:7-8`). MiMo Code takes `XDG_DATA_HOME`, or `~/.local/share`, on every system, macOS included. The README's `~/Library/Application Support/mimocode/` is not what the code uses.
- **The database.** With `AGENT_LOOKOUT_MIMO_CODE_HOME`, `mimocode.db` in that folder. Otherwise as MiMo Code takes its own `MIMOCODE_DB`, read as it is (`MIMOCODE_DB` in `flag.ts`, `db.ts:40-44`): `:memory:`, which leaves nothing to read, an absolute path as it is, or a path in the data folder. Empty, or not set, it is `mimocode.db` in the data folder. MiMo Code reads no `OPENCODE_DB` or `KILO_DB`, and nor does this adapter.
- **Not read:** the file of another build channel. A build writes `mimocode.db` when its channel is `latest`, `beta` or `prod`, or when `MIMOCODE_DISABLE_CHANNEL_DB` is on (`db.ts:33-34`), and it is on unless it is `false` or `0` (`falsy` and `MIMOCODE_DISABLE_CHANNEL_DB` in `flag.ts`). Only then does another channel write `mimocode-<channel>.db` (`db.ts:35-36`). Agent Lookout reads `mimocode.db` alone, lists no folder to look for another, and reads one only when `MIMOCODE_DB` names it.

What it reads, how often, and the addresses `sqlite3` opens the database at, are [OpenCode's](opencode.md#what-it-reads), with `mimocode.db`, `mimocode.db-wal` and `mimocode.db-shm` in place of OpenCode's three. MiMo Code keeps the database in WAL mode, as OpenCode does (`db.ts:94`).

## The tables

- **`session`** (`session.sql.ts:15-59`): `id`, `parent_id` (`:24`), `directory` (`:28`), `title` (`:29`), `title_source`, one of `fallback`, `generated` and `user`, `user` by default (`:30`), `title_revision`, 0 by default and when a session is made, and 1 more on each write of its title (`:31`, `createNext` and `writeTitle` in `cli/src/session/session.ts`), `time_created` and `time_updated` (`:46`, from `cli/src/storage/schema.sql.ts:3-10`) and `time_archived` (`:48`).
- **`message`** (`session.sql.ts:87-103`): `session_id`, `agent_id`, `main` by default (`:95`), the shared times, and `data` (`:97`). The projector writes `agent_id` from the message's `agentID`, or `main` when it has none, and `time_created` from its `time.created` (`MessageV2.Event.Updated` in `cli/src/session/projectors.ts`).
- **`part`** (`session.sql.ts:105-121`): `message_id`, `session_id` (`:113`), the shared times and `data`.
- **`actor_registry`** (`actor.sql.ts:6-48`): one row for each actor of a session, keyed by `session_id` and `actor_id` (`:42`), with its `mode`, one of `peer`, `subagent` and `main` (`:14`), its `status`, one of `pending`, `running` and `idle` (`:16`), `last_activity_time` (`:35`), `instance_id` (`:37`) and the shared times (`:39`). Every session has a row for its main agent, with `actor_id` and `mode` `main`, which `createNext` in `session.ts` registers as `pending` with its process's `instance_id`, and each subagent has one with the `mode` `subagent`. When a part is written, the projector moves `last_activity_time` of the row whose `actor_id` is the `agent_id` of the part's message (`MessageV2.Event.PartUpdated` in `projectors.ts`).

The JSON in `data` is OpenCode's: an assistant message has `role`, `time.created`, an optional `time.completed`, an optional `error` with its `name`, `finish` and `tokens`, and a tool part has `type`, `tool` and `state.status`, one of `pending`, `running`, `completed` and `error`, with `state.time.start` once it runs (`Assistant`, `ToolPart` and `ToolStateRunning` in `cli/src/session/message-v2.ts`). A part cut off when a step is cleaned up gets `state.metadata.interrupted` (`abortedToolState` there), as in OpenCode.

Session ids are `ses_` and 26 characters (`session` and `LENGTH` in `cli/src/id/id.ts`). Message ids changed their format at 0.1.12, and the comments of `id.ts` give both forms, so the order of a session's messages is taken from `time_created`, then `id`, as OpenCode's question already takes it.

The indexes on these tables are on plain columns (`session.sql.ts:54-57`, `:100-101`, `:118-119`, `actor.sql.ts:43-46`). Every read runs with `PRAGMA trusted_schema=OFF`, and `tests/integration/collector/adapters/mimo-code/index.test.ts` runs the real `sqlite3` on a database with these tables and indexes and asks both questions.

## The questions

The probe is `probeQueryFor(MIMO_EXTRAS)` in `sessionRows.ts`: OpenCode's, with `actor_registry` among the names of tables asked for, and the names of the columns of `message` and `actor_registry` too. A database without `actor_registry`, `actor_registry.mode`, `message.agent_id`, `session.title_source` or `session.title_revision`, or with `session_v2`, is taken for a version Agent Lookout does not read.

The sessions query is `MIMO_SESSIONS_QUERY`, which `v1SessionsQuery` builds with `MIMO_TOOLS` and `MIMO_EXTRAS`. Its tools that ask are OpenCode's own, `question` and `plan_exit`. It is `SESSIONS_QUERY` with three changes:

- The newest message, the newest prompt, the reply whose token counts are read and the walk back to it keep to the main agent's messages, with `AND <alias>.agent_id = 'main'` in each of the five places a message is picked.
- The title is printed only when a model wrote it or the person renamed the session: `CASE WHEN s.title_source IN ('generated') OR (s.title_source IN ('user') AND typeof(s.title_revision) = 'integer' AND s.title_revision > 0) THEN substr(s.title, 1, 1000) END AS title`. A title marked `fallback`, and one marked `user` at revision 0, never leave SQLite.
- It adds `a_active_at`, the newest time a subagent of the session that is `pending` or `running` was written:

```sql
(SELECT max(max(CASE WHEN typeof(a.time_updated) = 'integer' THEN a.time_updated ELSE 0 END,
                CASE WHEN typeof(a.last_activity_time) = 'integer' THEN a.last_activity_time ELSE 0 END))
  FROM actor_registry a WHERE a.session_id = s.id AND a.mode = 'subagent'
  AND a.status IN ('pending', 'running')) AS a_active_at
```

It is null when no subagent is `pending` or `running`. The main agent's row is left out, since it stays `pending`, and so is a peer's, as MiMo Code's own wait leaves out every row whose `mode` is not `subagent` (`waitForSubagents` in `prompt.ts`). The mode, the status and the two times are tested inside SQLite, and only that one number is printed. OpenCode's and Kilo Code's questions do not ask for any of this, so they are as they were.

## Waits

### Needs you

A session needs you while the main agent's newest step has a `question` or a `plan_exit` part in the state `running` and no `$.time.completed`, as for OpenCode 1.x.

- `question` (`cli/src/tool/question.ts:16`) waits inside its call on `question.ask` (`:47`), which keeps the question in memory and waits on a `Deferred` until you answer or dismiss it (`ask` in `cli/src/question/index.ts`). In MiMo Code's never-ask mode it answers itself and does not wait (`question.ts:29`). It is offered when `MIMOCODE_CLIENT` is `app`, `cli` or `desktop`, and `cli` is the default, or with `MIMOCODE_ENABLE_QUESTION_TOOL` (`questionEnabled` in `cli/src/tool/registry.ts`, `MIMOCODE_CLIENT` in `flag.ts`).
- `plan_exit` (`cli/src/tool/plan.ts:21`) asks whether to go on with the plan through the same `question.ask` (`:42`), and waits for the answer (`:60`). It is always offered (`planexit` in `registry.ts`).
- The processor writes a tool part as `running`, with `state.time.start`, on the `tool-call` event, before the tool's code runs (`handleEvent` in `cli/src/session/processor.ts`). So a `running` part of either tool is on disk while it waits.

The reason is `question`, and nothing of what it asks is read.

A wait for a tool's approval is in memory alone (`cli/src/permission/index.ts`), so a session in one shows as working. The `permission` table holds saved rules, not waits.

A subagent keeps the `question` tool unless its list of tools leaves it out (`available` in `registry.ts`, `toolAllowlist` in `cli/src/tool/actor.ts`). A question a subagent asks is a part of the subagent's message, which is not read, so the session shows as working while it waits, since that subagent's row is `running`.

### Subagents

MiMo Code's subagents share their parent's session and run as actors registered under it (`cli/src/tool/actor.ts`), each with a row of `actor_registry` that starts `pending` (`register` in `cli/src/actor/registry.ts`). The main agent's row starts `pending` too, and its turns leave it so, moving only its times and its count of turns (`updateTurn` there), so only rows whose `mode` is `subagent` are counted. Their messages are in `message`, with their actor's id in `agent_id`. So only the main agent's messages say how the session stands: a subagent's reply that ended after the main agent's does not make the session idle, and a subagent's prompt does not start a turn.

Once its last step ends, the main agent waits for its subagents, and MiMo Code shows the session as busy, with a wait of the kind `subagents`, in memory (`waitForSubagents` in `cli/src/session/prompt.ts`, `cli/src/session/status.ts`). A subagent started in the background runs on while the main agent answers you (`spawn` in `tool/actor.ts`). So a session with a subagent `pending` or `running` is working here, wherever the main agent's step says idle: `subagents` in `opencodeMapping.ts`. One that needs you, failed or cannot be read is so whatever its subagents do.

A subagent's row stays `running` when its program is killed, until a later program settles it as `idle`, some time on (`sweepAbandonedZombies` in `registry.ts`). So a row last written before the last `ps` that showed no MiMo Code is passed over, as a `running` part from before then is: `subagentsAtWork` in `toSession.ts`.

## Status

As [OpenCode 1.x's](opencode.md#status), from the main agent's newest message, with these differences:

- With a subagent at work, each row of OpenCode's table that is idle while open is working. A row that needs you, failed or is unknown stays so, and a closed session is finished.
- An error is read before `$.time.completed`. The processor sets `time.completed` as a step is cleaned up, only when it has no error (`cleanup` in `processor.ts`), and an aborted step's error is `MessageAbortedError`, so it ends idle.
- A step that ends with `finish` `tool-calls` is followed by a new step, as in OpenCode, so it is working for up to 10 seconds after it ended, and idle after that if no step follows.
- The error names are those of MiMo Code's `Assistant` (`message-v2.ts`): `MessageAbortedError`, which ends a reply as idle, and eleven that end it as failed, `MIMO_FAILED_ERRORS` in `mimo-code/index.ts`. Seven are OpenCode's, `ProviderAuthError`, `UnknownError` (`NamedError.Unknown` in `shared/src/util/error.ts`), `MessageOutputLengthError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError` and `APIError`, and four are MiMo Code's own: `InvalidOutputError`, `StreamIncompleteError`, `TextToolCallError` and `ModelError`. Any other name is unknown.

## Open or closed

`ps -A -o comm=` is asked as for OpenCode. A process whose program is `mimo`, alone or at the end of a path, is taken for MiMo Code (`MIMO_PROGRAMS` in `mimo-code/index.ts`):

- The install script puts the program at `$HOME/.mimocode/bin/mimo` (`INSTALL_DIR` in `install`, at the root of the repository).
- npm's package has one command, `mimo`, a Node script (`bin` in `cli/package.json`, `cli/mimo.js`) that starts the program `mimo` from its `vendor` folder with `spawnSync` and waits for it (`vendorBinaryPath` and `runBinary` in `cli/launcher.js`). So `ps` shows the launcher as `node`, and the program as `mimo`.
- No process title is set.

None of OpenCode's names or Kilo Code's is `mimo`, and `mimo` is none of theirs, so one running keeps no session of the other open. It fits in the 15 characters Linux keeps.

What that gives:

- While any `mimo` runs, every MiMo Code session is open, whether or not a window shows it.
- Once `ps` shows none, every session is finished, unless it failed or cannot be read.
- Another program called `mimo` keeps sessions from showing as finished, and nothing more.
- MiMo Desktop's program is not known. While it runs with no `mimo` beside it, its sessions show as finished.

## Names, tokens and the rest

The name is MiMo Code's title when its `title_source` is `generated`, which a model wrote (`setGeneratedTitle` in `cli/src/session/session.ts`), or `user` with a `title_revision` above 0, which the person renamed it to (`setTitle` there), unless it is still OpenCode's placeholder. Otherwise it is the folder's name. A new session's title is `Untitled`, marked `fallback` (`createNext` in `session.ts`). Before a model names it, MiMo Code writes the first line of the person's prompt as its title, cut to 48 characters, also marked `fallback`, and it stays when naming fails (`ensureTitle` and `normalizeTitleInput` in `prompt.ts`). Such a title is the person's own words, so it is never read. `createNext` also marks `user` any title given when a session is made or forked, at revision 0: a fork's, which `fork` copies from the session it came from with ` (fork #1)` after it (`getForkedTitle` there), and one passed when a session is made, as `mimo run --title` does, with the first 50 characters of the prompt when it has no value (`title` in `cli/src/cli/cmd/run.ts`). Each write of a title adds 1 to `title_revision` (`writeTitle` in `session.ts`), and only a rename writes `user` once a session is made, so such a session keeps its folder's name until the person renames it. So does a session from before `title_source` was added, which has MiMo Code's defaults, `user` at revision 0.

A session's id in Agent Lookout is `mimo-code:<session id>`. Its token counts are those of the main agent's newest reply that has them, read as [OpenCode 1.x's are](opencode.md#token-counts), since MiMo Code works them out the same way: the prompt without what was read from a cache or written to one, and the output without the reasoning (`getUsage` in `session.ts`). Counts that could not be right are not shown. It has no app, no process ID, no link, no Jump, no Stop, no Answer and no Quiet for.

## Last message

Not read. The profile has no `lastMessageRead`, so the adapter has no `lastMessage`, `GET /api/sessions/last-message` answers `not-read` for its sessions, and its card has no row for it.

## What it never reads

- **Files:** `auth.json` in the data folder, which holds keys and sign-ins (`cli/src/auth/index.ts`); anything else in the data folder; and anything in MiMo Code's state, config or cache folders, `$MIMOCODE_HOME/state`, `config` and `cache`, or `mimocode` in `~/.local/state`, `~/.config` and `~/.cache` (`global.ts:37-40`, `:45-48`). Of the files, the adapter reads only the three of the database. A session's own folder is looked in for a git repository, as every session's is.
- **Tables:** every one but `session`, `message`, `part` and `actor_registry`, and the names in `sqlite_master` and of the columns of `session`, `session_v2`, `message` and `actor_registry`. So never `account`, `account_state` or `control_account` (`cli/src/storage/schema.ts`), `permission`, `todo`, `project`, `workspace`, `workflow_run`, `history_fts` or `session_prefix_snapshot`.
- **Columns:** of `session` only `id`, `parent_id`, `directory`, `title`, `title_source`, `title_revision`, `time_created`, `time_updated` and `time_archived`, never `slug`, `prompt`, `revert`, `permission` or a `summary_` column, and `title_source` and `title_revision` only inside SQLite. Of `message` and `part` those OpenCode's notes list, and `message.agent_id` only inside SQLite. Of `actor_registry` only `session_id`, `mode`, `status`, `time_updated` and `last_activity_time`, never `description`, `last_error`, `tools`, `agent`, `result_message_id` or `instance_id`.
- **Programs:** no `mimo` command and no request to MiMo Code's server. `ps` is asked for the name of each process's program alone, never its arguments.

## Known gaps

- A wait for a tool's approval shows as working.
- A question a subagent asks shows as working.
- A session with a subagent at work shows as working, also once MiMo Code has stopped waiting for it.
- A program killed in the middle of a turn leaves its session working until `ps` shows no `mimo`.
- MiMo Desktop's program is not known, so its sessions can show as finished while it runs.
- The file of another build channel is read only when `MIMOCODE_DB` names it.
- A title given when a session is made, as with `mimo run --title`, is not shown until the session is renamed, since MiMo Code marks it as it marks a fork's copied title.
- A subagent MiMo Code starts on its own, such as `checkpoint-writer`, counts as at work, since `agent` is not read (`SYSTEM_SPAWNED_AGENT_TYPES` in `cli/src/agent/config.ts`).
- Nothing is read on Windows, where Agent Lookout runs no `sqlite3`. The card says so.
- No last message is read.
- The gaps the OpenCode notes list for OpenCode 1.x.

## Not yet checked

This was built from MiMo Code's source at v0.1.17, and not checked on a computer running it. On a computer running MiMo Code: that `mimocode.db` is in `~/.local/share/mimocode` on macOS, that it holds the rows the source writes, that a `question` part is `running` while MiMo Code asks, that a row of `actor_registry` is `running` while a subagent works and the main agent's stays `pending`, that a rename moves `title_revision` above 0, and what `ps -A -o comm=` prints for MiMo Code started from the install script and from npm, and for MiMo Desktop. To check, read only `$.tool` and `$.state.status` of the newest parts of the main agent's newest message while it asks a question, and `status` of `actor_registry` while a subagent works, and look for `mimo` in `ps -A -o comm=`.

## What breaks when MiMo Code changes

| Change in MiMo Code                                                                                                                   | What the dashboard shows                                                                    | Where to fix it                                             |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `actor_registry`, `actor_registry.mode`, `message.agent_id`, `session.title_source` or `session.title_revision` is renamed or dropped | The card says the database is from a version Agent Lookout does not read                    | `MIMO_EXTRAS` in `mimo-code/index.ts`, and `sessionRows.ts` |
| The main agent's `agent_id` is no longer `main`                                                                                       | Sessions show as idle, or with no message, as a subagent's are not read                     | `MIMO_EXTRAS` in `mimo-code/index.ts`                       |
| A subagent's `status` gets a new value for work under way                                                                             | A session whose subagent works shows as idle                                                | `ACTIVE_SUBAGENTS` in `opencode/sessionRows.ts`             |
| A title from the prompt is marked with another `title_source`, or `user` above revision 0                                             | That title, the person's words, would be shown                                              | `titleSources` and `renamedSources` in `MIMO_EXTRAS`        |
| The main agent's row of `actor_registry` gets the `mode` `subagent`                                                                   | Every session shows as working while MiMo Code runs                                         | `ACTIVE_SUBAGENTS` in `opencode/sessionRows.ts`             |
| It adds `session_v2`                                                                                                                  | The card says the database is from a version Agent Lookout does not read                    | `readsV2` in `MIMO_CODE_PROFILE`, and the OpenCode notes    |
| A column or table the questions ask for is renamed or dropped                                                                         | The card says the database is from a version it does not read, or sqlite3 could not read it | `sessionRows.ts`                                            |
| `question` or `plan_exit` is renamed, or stops waiting inside its call                                                                | A session that asks shows as working                                                        | `MIMO_TOOLS` in `mimo-code/index.ts`                        |
| A new error name is recorded on a reply                                                                                               | A session that fails shows as unknown                                                       | `MIMO_FAILED_ERRORS` in `mimo-code/index.ts`                |
| The data folder, the file's name, `MIMOCODE_HOME` or `MIMOCODE_DB` moves                                                              | MiMo Code is not found, or found with no database                                           | `MIMO_CODE_PROFILE` and `profile.ts`                        |
| `MIMOCODE_DISABLE_CHANNEL_DB` is off by default again                                                                                 | A pre-release's sessions are not listed                                                     | `mimoCodeDatabaseFor` in `mimo-code/index.ts`               |
| MiMo Code's program is given another name                                                                                             | Its sessions show as finished while it runs                                                 | `MIMO_PROGRAMS` in `mimo-code/index.ts`                     |
| Anything OpenCode's notes list for OpenCode 1.x                                                                                       | As they say                                                                                 | As they say                                                 |

To check a new MiMo Code version, read at its tag `cli/src/storage/db.ts`, `shared/src/global.ts`, `cli/src/flag/flag.ts`, `cli/src/session/session.sql.ts`, `cli/src/actor/actor.sql.ts`, `cli/src/actor/registry.ts`, `cli/src/session/projectors.ts`, `cli/src/session/message-v2.ts`, `cli/src/session/processor.ts`, `cli/src/session/prompt.ts`, `cli/src/session/session.ts`, `cli/src/cli/cmd/run.ts`, `cli/src/agent/config.ts`, `cli/src/tool/registry.ts`, `cli/src/tool/question.ts`, `cli/src/tool/plan.ts`, `cli/src/tool/actor.ts`, `cli/package.json`, `cli/launcher.js` and `install`, at the root of the repository.
