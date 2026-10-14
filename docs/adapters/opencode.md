# OpenCode adapter notes

These notes record what Agent Lookout reads from OpenCode, where each value comes from, and what breaks when OpenCode changes. Start here when the adapter stops working.

The adapter was built from OpenCode's source at v1.19.0, the latest release, published 2026-10-11 (commit `733b2c6` of [anomalyco/opencode](https://github.com/anomalyco/opencode), which was sst/opencode), and from SQLite's source at 3.54.0. It has not yet been checked on a computer running OpenCode. OpenCode was not run on the machine where it was written, and nothing in OpenCode's own folders there was read. Everything below comes from OpenCode's source and from databases written by hand with the same tables, so a status can be wrong.

The code is in `src/collector/adapters/opencode/`, and the status mapping is in `src/core/mapping/opencode/opencodeMapping.ts`. The adapter starts the system's `sqlite3` with the helpers the Antigravity adapter uses, in `src/collector/adapters/antigravity/app/summaries.ts`.

## How it reads OpenCode, and why

The adapter needs nothing installed and changes nothing: no plugin, no setting, no OpenCode program run, no network. It looks at OpenCode's database and the two files SQLite keeps beside it, and asks the system's `sqlite3` two fixed questions when they change.

OpenCode offers other ways in, and none of them can be used that way:

| Interface                         | Why it is not used                                                                                                                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any `opencode` command            | Starting one makes OpenCode's folders (`packages/core/src/global.ts`). `opencode session list`, the one checked, also opens the database read-write, sets WAL mode, moves the `-wal` into the database and applies migrations (`packages/core/src/database/database.ts`). |
| `opencode session list`           | The same, and it lists only the root sessions of the project it is run in, with no status (`packages/opencode/src/cli/cmd/session.ts`).                                                                                                                                   |
| `opencode serve` and its HTTP API | Only there while the person runs it, and asking it is a request to OpenCode's server.                                                                                                                                                                                     |
| A plugin                          | Needs a change to OpenCode's config. Agent Lookout installs only its own Claude Code plugin.                                                                                                                                                                              |
| The JSON files under `storage/`   | OpenCode wrote sessions there up to v1.1.65. From v1.2.0 it keeps them in the database, and v1.16.0 removed the one-time import, so those files are no longer kept up to date.                                                                                            |

## Where it looks

- **The data folder.** `AGENT_LOOKOUT_OPENCODE_HOME` if set, and then OpenCode's own variables are not read. Otherwise `opencode` in `XDG_DATA_HOME`, when that is an absolute path, or else `~/.local/share/opencode`. OpenCode takes `XDG_DATA_HOME`, or `~/.local/share`, on every system, macOS included (xdg-basedir 5.1.0).
- **The database.** With `AGENT_LOOKOUT_OPENCODE_HOME`, `opencode.db` in that folder. Otherwise as OpenCode takes its own `OPENCODE_DB`: `:memory:`, which leaves nothing to read, an absolute path as it is, or a path in the data folder. Without it, `opencode.db` in the data folder (`database.ts`).
- **Not read:** `opencode-<channel>.db`. OpenCode writes that name in place of `opencode.db` when its build channel is not `latest`, `beta` or `prod`: a preview build, or a build from source on a git branch, such as `opencode-dev.db`.

## What it reads

| Path, in the data folder                            | How                                                                                                                                                                                        | How often                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The data folder itself                              | One `stat`. Not done when `AGENT_LOOKOUT_OPENCODE_HOME` is set                                                                                                                             | On the first poll, at most once a minute while it is missing, and on every poll while it holds no `opencode.db`                                                                                     |
| `opencode.db`, `opencode.db-wal`, `opencode.db-shm` | `lstat`. Each must be an ordinary file: a link, a pipe or a device is not read. An empty `opencode.db` is taken as none, since SQLite deletes the `-wal` beside an empty database it opens | Every poll                                                                                                                                                                                          |
| `opencode.db`                                       | `sqlite3`, with the probe and the sessions query below                                                                                                                                     | When the database or its `-wal` changed since the last read, by identity, size or modified time, or the `-wal` came or went. After a read that did not work, on the next change or 10 seconds later |

The adapter opens no file itself. Only `sqlite3` opens the database, its `-wal` and its `-shm`, and only as the next section says. Nothing is read on Windows.

## How sqlite3 opens the database

`sqlite3` is found and started as for Antigravity: at `/usr/bin/sqlite3`, `/bin/sqlite3`, `/opt/homebrew/bin/sqlite3`, `/usr/local/bin/sqlite3` or `/opt/local/bin/sqlite3`, never on `PATH`, directly with no shell, with stdin closed, only `PATH=/usr/bin:/bin` and `LC_ALL=C` in its environment, a 5-second timeout and at most 4 MiB of output. Its arguments are `-init /dev/null -batch -json`, the database's address and one fixed question.

OpenCode keeps its database in WAL mode (`database.ts`). While a program of OpenCode's has it open, what it saves lies in `opencode.db-wal` until SQLite moves it into the database, which SQLite does on its own at about 1,000 pages. `opencode.db-shm` indexes the `-wal`. So the address follows the files beside the database:

| Beside `opencode.db`                      | Address                                  | Why                                                                                               |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| No `-wal`, or an empty one                | `file:<database>?mode=ro&immutable=1`    | Nothing is in a `-wal`, so the file is whole. `immutable=1` takes no lock and makes no file       |
| A `-wal` that holds something, and `-shm` | `file:<database>?mode=ro&readonly_shm=1` | `readonly_shm=1` reads the `-wal` and opens the `-shm` read-only, so nothing is written to either |
| A `-wal` that holds something, no `-shm`  | Not read                                 | Reading it would make a `-shm`. The card says so                                                  |

`mode=ro` alone is never used. It opens the `-shm` to read and write, can empty it when no other program holds it, and writes a mark in it for each read (`src/os_unix.c` and `src/wal.c` at SQLite 3.54.0). `immutable=1` alone does not see the `-wal`, so while OpenCode runs it would miss the end of every turn. A reader whose `-shm` is read-only writes no mark. When no program holds the `-shm`, it builds the index in its own memory from the `-wal`, which SQLite can do from 3.22.0. If the index cannot be made that way, SQLite answers `SQLITE_READONLY_CANTINIT`, and the read counts as one that did not work.

`tests/integration/collector/adapters/opencode/database.test.ts` runs the real `sqlite3` on a database that a second `sqlite3` keeps open with commits only in the `-wal`, as OpenCode would. It checks that the newest commit is read, that `immutable=1` does not see it, and that no byte, size or modified time of the database, its `-wal` or its `-shm` changes. It checks the same once that second `sqlite3` is killed, as after a crash, and with an empty `-wal` left after a clean close. It also checks what is left when that second `sqlite3` closes the database between the `lstat` and the read. CI runs it on Linux, and it was run on macOS with `/usr/bin/sqlite3` 3.51.0 and with Homebrew's `sqlite3` 3.53.0, which is built from SQLite's own source. It has not been run against OpenCode itself.

Each run of `sqlite3` holds a shared lock on the database for the few milliseconds it takes. If OpenCode's last connection closes during one, it can leave its `-wal` behind, and SQLite recovers it the next time the database is opened.

If OpenCode closes the database between the `lstat` and the read, a `sqlite3` built from SQLite's own source, as on Linux, makes an empty `opencode.db-wal` in OpenCode's folder as it opens the database (`sqlite3WalOpen` in `src/wal.c`), and that read does not work. SQLite has no setting that stops it. The next read takes the empty `-wal` as closed. `/usr/bin/sqlite3` on macOS was seen to make none.

## The two questions

Both are fixed text. Nothing from a file, a request or a setting is put into them, and the 48-hour cut-off is worked out inside SQLite.

The probe asks for the names of tables and columns alone. It is asked each time before the sessions query, so a table OpenCode adds to the same file, as OpenCode 2 adds `session_v2`, is seen:

```sql
SELECT 'table' AS kind, name FROM sqlite_master
  WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_v2', 'session_message')
UNION ALL SELECT 'session', name FROM pragma_table_info('session')
UNION ALL SELECT 'session_v2', name FROM pragma_table_info('session_v2')
```

The sessions query is asked only when the probe finds `session`, `message` and `part`, with `id`, `parent_id`, `directory`, `title`, `time_created`, `time_updated` and `time_archived` in `session`:

```sql
SELECT s.id, substr(s.directory, 1, 4097) AS directory, substr(s.title, 1, 1000) AS title,
  s.time_created, s.time_updated,
  m.id AS m_id, m.time_created AS m_created, m.time_updated AS m_updated,
  CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') END AS m_role,
  CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.time.completed') END AS m_completed,
  CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.error.name') END AS m_error,
  CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.finish') END AS m_finish,
  (SELECT count(*) FROM part p WHERE p.message_id = m.id
    AND CASE WHEN json_valid(p.data) THEN
      json_extract(p.data, '$.type') = 'tool'
      AND json_type(p.data, '$.metadata.providerExecuted') IS NOT 'true'
      AND NOT (json_extract(p.data, '$.state.status') IS 'error'
        AND json_type(p.data, '$.state.metadata.interrupted') IS 'true') END) AS m_tools,
  (SELECT max(p.time_updated) FROM part p WHERE p.message_id = m.id) AS p_updated,
  (SELECT u.time_created FROM message u WHERE u.session_id = s.id
    AND CASE WHEN json_valid(u.data) THEN json_extract(u.data, '$.role') = 'user' END
    ORDER BY u.time_created DESC, u.id DESC LIMIT 1) AS u_created
FROM session s
LEFT JOIN message m ON m.id = (SELECT x.id FROM message x WHERE x.session_id = s.id
  ORDER BY x.time_created DESC, x.id DESC LIMIT 1)
WHERE s.parent_id IS NULL AND s.time_archived IS NULL
  AND s.time_updated >= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 172800000
ORDER BY s.time_updated DESC LIMIT 200
```

The tables and fields are those of `packages/core/src/session/sql.ts`, and the JSON shapes those of `packages/schema/src/v1/session.ts`. Every `time_*` column holds milliseconds.

| Field                                          | Holds                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.id`                                   | `ses_` and 26 characters. A row whose id does not match `^ses[0-9A-Za-z_-]{1,64}$` is dropped                                                                            |
| `session.directory`                            | The session's folder. Kept when it is an absolute path of at most 4,096 characters with no control or format character. An old session may have an empty one             |
| `session.title`                                | The session's title. `New session - <time>` and `Child session - <time>` are OpenCode's placeholders, kept as no title (`isDefaultTitle` in `session.ts`)                |
| `session.time_created`, `time_updated`         | When it began, and when its row was last written: at each prompt, and after each step, when OpenCode writes the session's summary                                        |
| `session.parent_id`, `time_archived`           | Set for a subagent's session and for an archived one, which are left out                                                                                                 |
| The newest message, by `time_created` and `id` | Its times, and from its `data`: `$.role`, `user` or `assistant`; `$.time.completed`, set once an assistant step ends; `$.error.name`; and `$.finish`, why the step ended |
| `m_tools`                                      | How many of that message's tool parts OpenCode would wait on before it ends the turn (`hasToolCalls` in `packages/opencode/src/session/prompt.ts`)                       |
| `p_updated`                                    | The newest `time_updated` of that message's parts                                                                                                                        |
| `u_created`                                    | When the person last wrote in the session                                                                                                                                |

`$.metadata.providerExecuted` and `$.state.metadata.interrupted` are tested inside SQLite, for the count: a tool the model's provider ran itself, and one OpenCode marked as cut off when it cleaned up a step, are not waited on. Nothing of either is printed. A role, error name or reason longer than 64 characters, or with a control character in it, is kept as a field of the wrong type, so no long text is kept.

Each `data` is read only once `json_valid` says it is JSON. A message whose `data` is not gives empty fields, which show as unknown, and a part whose `data` is not is not counted, rather than one row failing the whole read. The title is cut to 1,000 characters and the folder to 4,097 inside SQLite, so long ones cannot push the answer past 4 MiB, and a folder longer than 4,096 is still dropped.

## Which sessions are listed

- Root sessions only: OpenCode's subagents run in sessions of their own, with `parent_id` set.
- Not archived.
- Their own row written in the last 48 hours, by SQLite's clock, the newest 200.
- Then each for 24 hours after the newest of its row's `time_updated`, its newest message's and that message's parts'. A time ahead of the clock counts as it is, so a clock set back hides no session.

The name is the title, else the folder's name, else the session's id. A session's id in Agent Lookout is `opencode:<session id>`. It has no app, no process ID, no link, no Jump, no Stop, no token counts and no `lastWriteAt`.

## Open or closed

The `opencode` program writes no mark of its own for an open session or for itself (`packages/opencode/src/cli/cmd/serve.ts`, `packages/core/src/util/flock.ts`). So the adapter takes OpenCode to have the database open while `opencode.db-wal` holds at least one byte, and closed while it is missing or empty.

SQLite keeps the `-wal` for as long as any program has the database open, and the last one to close it removes it (sqlite.org/wal.html, section 4). The SQLite of macOS keeps it instead, empty, with the `-shm`: `/usr/bin/sqlite3` and `/usr/lib/libsqlite3.dylib` were seen to on one Mac. OpenCode's CLI runs on Bun, which is taken, not checked, to use that library on macOS, and OpenCode's source does not tell it otherwise. Its desktop app's v1 sidecar runs on Node instead. So an empty `-wal` is taken as closed too. Not yet checked against OpenCode: whether its `-wal` is there the whole time it runs, even idle, and whether it is gone or empty after it quits, on macOS and on Linux.

| `opencode.db-wal` | Taken as                                                              | Basis             |
| ----------------- | --------------------------------------------------------------------- | ----------------- |
| Holds something   | Open: an OpenCode program has it open                                 | `database`        |
| Missing or empty  | Closed: every session is finished, unless it failed or cannot be read | `database-closed` |

An OpenCode that has just opened the database and saved nothing yet reads as closed until it saves something. After a crash, the `-wal` still holds what OpenCode saved, so its sessions look open until OpenCode next opens and closes the database.

## Status

From each root session's newest message, by `time_created` and `id`:

| Newest message                                                                                                     | Open    | Closed   |
| ------------------------------------------------------------------------------------------------------------------ | ------- | -------- |
| None                                                                                                               | Idle    | Finished |
| `user`                                                                                                             | Working | Finished |
| `assistant`, no `time.completed`                                                                                   | Working | Finished |
| `assistant`, error `MessageAbortedError`                                                                           | Idle    | Finished |
| `assistant`, error that is one of the other seven names                                                            | Failed  | Failed   |
| `assistant`, error with any other name                                                                             | Unknown | Unknown  |
| `assistant`, ended, and `finish` is `tool-calls`, `unknown` or missing, or a tool to wait on: under 10 seconds ago | Working | Finished |
| The same, 10 seconds or more ago                                                                                   | Idle    | Finished |
| `assistant`, ended, any other `finish`                                                                             | Idle    | Finished |
| Any other role, or a field of the wrong type                                                                       | Unknown | Unknown  |

- An error is read first: OpenCode saves it as the step ends (`packages/opencode/src/session/processor.ts`).
- The seven names are `ProviderAuthError`, `UnknownError`, `MessageOutputLengthError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError` and `APIError` (`packages/schema/src/v1/session.ts`). `MessageAbortedError` is a reply that was stopped, as with Esc.
- Each step of a reply is an assistant message of its own. OpenCode starts the next step at once, and writes its message a moment after the last one ends, so a step that asks for tools is working for 10 seconds after it ended (`STEP_GAP_MS`). How long that moment lasts was not measured. A clock set back counts as those 10 seconds gone.
- A failed or unknown session stays so once the database is closed.
- A session is never shown as needing you.

The status time is when the person last wrote, for a working session, which starts the turn; else when the newest message began; else when the session did. For an idle, failed or finished session it is when the newest step ended, or else the newest time anything of the session was written. An unknown session has none.

## Known gaps

- A session waiting for your approval, or for an answer to a question, shows as working. OpenCode keeps both waits in memory, and writes nothing while one lasts (`packages/opencode/src/permission/index.ts`, `packages/opencode/src/question/index.ts`).
- Quiet for is never shown. OpenCode keeps every session in one database, so no file's modified time says when one session was last written.
- A reply's text is saved only once it ends, so nothing changes in the database while a long reply is written.
- After a crash, sessions look open until OpenCode next quits.
- A reply that fails before its first step begins, as when no model can be found, shows as working while OpenCode is open.
- A prompt sent with no reply asked for, as OpenCode's `/move` and its new-workspace dialog send, shows as working while OpenCode is open.
- When an approval is turned down, the turn ends there. If its last step asked for tools, the session shows as working for 10 seconds, then idle.
- Nothing is read on Windows, where Agent Lookout never runs `sqlite3`. The card says OpenCode is not read there.
- `opencode-<channel>.db` is not read.
- The JSON files OpenCode kept under `storage/` before v1.2 are not read.
- OpenCode 2's sessions, in `session_v2`, are not read yet. When the probe finds that table, the card says so. OpenCode 1.x has its own `session_message` table since v1.14.34, so that table alone does not mean OpenCode 2.
- A subagent's session is not listed, and its work does not show on the session that started it.
- A session whose own row was last written more than 48 hours ago is not asked for.
- No token counts yet.

## What it never reads

- **Files:** `auth.json` and `mcp-auth.json`, which hold keys and sign-ins; everything in OpenCode's state folder, `~/.local/state/opencode`, such as `locks/`, `kv.json`, `model.json`, `password`, `server.json` and `service.json`; everything in its config folder, `~/.config/opencode`, `service.json` among it; `log/`, `storage/`, `snapshot/`, `tool-output/`, `plans/`, `worktree/` and `repos/`; `opencode-<channel>.db`; and any file but the three database files.
- **Tables:** every one but `session`, `message` and `part`, and the names in `sqlite_master` and of the columns of `session` and `session_v2`. So never `event`, `event_sequence`, `account`, `control_account`, `credential`, `session_share`, `permission`, `project`, `todo`, `workspace` or `kv`.
- **Columns:** no `SELECT *` and no whole `data`. Never `share_url`, `summary_*`, `metadata`, `revert`, `permission`, `model`, `agent`, `cost` or `tokens_*` of `session`, and no text of a message or a part: never `$.text`, a tool's `$.state.input`, `$.state.output` or `$.state.error`, `$.system` or `$.summary`.
- **Programs:** no `opencode` command, no `ps`, no git in OpenCode's folders and no request to OpenCode's server.

## What breaks when OpenCode changes

| Change in OpenCode                                                  | What the dashboard shows                                                 | Where to fix it                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| A column the probe asks for is renamed or dropped                   | The card says the database is from a version Agent Lookout does not read | `sessionRows.ts`                               |
| `message` or `part` loses a column the query asks for               | The card says sqlite3 could not read the database                        | `sessionRows.ts`                               |
| OpenCode drops the 1.x tables, as OpenCode 2 can                    | No sessions, and the card says OpenCode 2's sessions are not read yet    | `sessionRows.ts`, `database.ts`                |
| A new error name                                                    | Sessions that end on it show as unknown                                  | `src/core/mapping/opencode/opencodeMapping.ts` |
| `$.role`, `$.time.completed`, `$.error` or `$.finish` changes shape | Sessions show as unknown, or with the wrong status                       | `src/core/mapping/opencode/opencodeMapping.ts` |
| The next step's message is written later after a step ends          | A session between two steps shows as idle for a moment                   | `STEP_GAP_MS` in `opencodeMapping.ts`          |
| The data folder or the database's name moves                        | OpenCode is not found, or found with no database                         | `index.ts`                                     |
| The `-wal` is kept full after OpenCode quits, or gone while it runs | Sessions never show as finished, or always do                            | `database.ts`                                  |
| The placeholder title changes                                       | New sessions are named by the placeholder, not the folder                | `sessionRows.ts`                               |

To check a new OpenCode version, read at its tag `packages/core/src/session/sql.ts`, `packages/core/src/session/projector.ts`, `packages/schema/src/v1/session.ts`, `packages/core/src/database/database.ts`, `packages/core/src/global.ts`, `packages/opencode/src/session/processor.ts` and `prompt.ts`, and `isDefaultTitle` in `packages/opencode/src/session/session.ts`. Then compare the dashboard with OpenCode's own list of sessions, with a turn running, waiting for approval, stopped with Esc, ended on an error, and after OpenCode quits.
