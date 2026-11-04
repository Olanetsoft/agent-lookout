# OpenCode adapter notes

These notes record what Agent Lookout reads from OpenCode, where each value comes from, and what breaks when OpenCode changes. Start here when the adapter stops working.

The adapter was built from OpenCode's source at v1.19.0, the latest release, published 2026-10-11 (commit `733b2c6` of [anomalyco/opencode](https://github.com/anomalyco/opencode), which was sst/opencode), and from SQLite's source at 3.54.0. Which waits show as needing you was checked in OpenCode's source at v1.19.5 ([Needs you](#needs-you)). It has not yet been checked on a computer running OpenCode. OpenCode was not run on the machine where it was written, and nothing in OpenCode's own folders there was read. Everything below comes from OpenCode's source and from databases written by hand with the same tables, so a status can be wrong.

The code is in `src/collector/adapters/opencode/`, and the status mapping is in `src/core/mapping/opencode/opencodeMapping.ts`. The adapter starts the system's `sqlite3` with the helpers the Antigravity adapter uses, in `src/collector/adapters/antigravity/app/summaries.ts`, and `ps` as that adapter does for Antigravity's own program.

## How it reads OpenCode, and why

The adapter needs nothing installed and changes nothing, but for the one empty `-wal` [below](#how-sqlite3-opens-the-database): no plugin, no setting, no OpenCode program run, no network. It looks at OpenCode's database and the two files SQLite keeps beside it, asks the system's `sqlite3` two fixed questions when the database or its `-wal` changes, and asks `ps` whether an OpenCode program runs. While a session's details are open, it asks one more fixed question, about that session alone, for what it last said ([Last message](#last-message)).

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

| Path, in the data folder                                 | How                                                                                                                                                                                        | How often                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The data folder itself                                   | One `stat`. Not done when `AGENT_LOOKOUT_OPENCODE_HOME` is set                                                                                                                             | On the first poll, at most once a minute while it is missing, and on every poll while it holds no `opencode.db`                                                                                                                                              |
| `opencode.db`, `opencode.db-wal`, `opencode.db-shm`      | `lstat`. Each must be an ordinary file: a link, a pipe or a device is not read. An empty `opencode.db` is taken as none, since SQLite deletes the `-wal` beside an empty database it opens | Every poll                                                                                                                                                                                                                                                   |
| `opencode.db`                                            | `sqlite3`, with the probe and the sessions query below                                                                                                                                     | When the database or its `-wal` changed since the last read, by identity, size or modified time, or the `-wal` came or went. After a read that did not work, on the next change or 10 seconds later                                                          |
| `opencode.db`, its `-wal` and `-shm`, then `opencode.db` | The same three `lstat`s, then `sqlite3`, with the question of a session's last message below                                                                                               | Only when `GET /api/sessions/last-message` asks, while that session's details are open, and never by a poll: the `lstat`s at most once a second for the session, and `sqlite3` only when the database or its `-wal` changed since that session's last answer |

The adapter opens no file itself. Only `sqlite3` opens the database, its `-wal` and its `-shm`, and only as the next section says, for the last-message question as for a poll's. While there are sessions to show, it also runs `ps`, at most every 10 seconds, and sooner after a session is written while `ps` shows no OpenCode, as [Open or closed](#open-or-closed) says. Nothing is read on Windows.

## How sqlite3 opens the database

`sqlite3` is found and started as for Antigravity: at `/usr/bin/sqlite3`, `/bin/sqlite3`, `/opt/homebrew/bin/sqlite3`, `/usr/local/bin/sqlite3` or `/opt/local/bin/sqlite3`, never on `PATH`, directly with no shell, with stdin closed, only `PATH=/usr/bin:/bin` and `LC_ALL=C` in its environment, a 5-second timeout and at most 4 MiB of output. Its arguments are `-init /dev/null -batch -json`, the database's address and one fixed question. For the question of a session's last message, at most 256 KB of output is read.

OpenCode keeps its database in WAL mode (`database.ts`). What it saves lies in `opencode.db-wal` until SQLite moves it into the database, which SQLite does on its own at about 1,000 pages, and `opencode.db-shm` indexes the `-wal`. OpenCode 1.19.0 never closes the database itself, so it leaves the `-wal` full when it quits, and what it saved there must still be read ([Open or closed](#open-or-closed)). So the address follows the files beside the database:

| Beside `opencode.db`                      | Address                                  | Why                                                                                                                             |
| ----------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| No `-wal`, or an empty one                | `file:<database>?mode=ro&immutable=1`    | Nothing is in a `-wal`, so the file is whole. `immutable=1` takes no lock and makes no file                                     |
| A `-wal` that holds something, and `-shm` | `file:<database>?mode=ro&readonly_shm=1` | `readonly_shm=1` reads the `-wal` and opens the `-shm` read-only, so nothing is written to either, whether OpenCode runs or not |
| A `-wal` that holds something, no `-shm`  | Not read                                 | Reading it would make a `-shm`. The card says so                                                                                |

`mode=ro` alone is never used. It opens the `-shm` to read and write, can empty it when no other program holds it, and writes a mark in it for each read (`src/os_unix.c` and `src/wal.c` at SQLite 3.54.0). `immutable=1` alone does not see the `-wal`, so while OpenCode runs it would miss the end of every turn. A reader whose `-shm` is read-only writes no mark. When no program holds the `-shm`, it builds the index in its own memory from the `-wal`, which SQLite can do from 3.22.0. If the index cannot be made that way, SQLite answers `SQLITE_READONLY_CANTINIT`, and the read counts as one that did not work.

`tests/integration/collector/adapters/opencode/database.test.ts` runs the real `sqlite3` on a database that a second `sqlite3` keeps open with commits only in the `-wal`, as OpenCode would. It checks that the newest commit is read, that `immutable=1` does not see it, and that no byte, size or modified time of the database, its `-wal` or its `-shm` changes. It checks the same once that second `sqlite3` is killed, which leaves the `-wal` and `-shm` full with no program holding them, as OpenCode's quit and a crash do, and with an empty `-wal` left after a clean close. It also checks what is left when that second `sqlite3` closes the database between the `lstat` and the read. CI runs it on Linux, and it was run on macOS with `/usr/bin/sqlite3` 3.51.0 and with Homebrew's `sqlite3` 3.53.0, which is built from SQLite's own source. It has not been run against OpenCode itself.

Each run of `sqlite3` with `readonly_shm=1` holds a shared lock on the database while it runs, which can be up to its 5-second timeout. A program that closes the database during one cannot then move its `-wal` into the database, so it leaves the `-wal` and `-shm` in place, as OpenCode 1.19.0 does on every quit anyway. Whether a session is open is told from `ps`, not from these files, so this changes no status.

If a program closes the database between the `lstat` and the read, and SQLite removes the `-wal` and `-shm` as it does then, a `sqlite3` built from SQLite's own source, as on Linux, makes an empty `opencode.db-wal` in OpenCode's folder as it opens the database (`sqlite3WalOpen` in `src/wal.c`), and that read does not work. SQLite has no setting that stops it. The next read opens the database as a file nothing changes. `/usr/bin/sqlite3` on macOS was seen to make none. OpenCode 1.19.0 never closes the database itself, but another program, such as a person's own `sqlite3`, can.

## The two questions

Each poll asks these two. Both are fixed text. Nothing from a file, a request or a setting is put into them, and the 48-hour cut-off is worked out inside SQLite. The third, which no poll asks, is under [Last message](#last-message).

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
  (SELECT count(*) = 1 AND sum(json_extract(p.data, '$.tool') IS 'bash') = 1 FROM part p
    WHERE p.message_id = m.id
    AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') = 'tool' END) AS m_shell,
  (SELECT CASE WHEN max(json_extract(p.data, '$.state.status') IS 'running') THEN
    min(CASE WHEN json_type(p.data, '$.state.time.start') IS 'integer'
    THEN json_extract(p.data, '$.state.time.start') ELSE p.time_created END) END FROM part p
    WHERE p.message_id = m.id AND <asking part>) AS m_asked_at,
  (SELECT max(p.time_updated) FROM part p WHERE p.message_id = m.id) AS p_updated,
  (SELECT u.time_created FROM message u WHERE u.session_id = s.id
    AND CASE WHEN json_valid(u.data) THEN json_extract(u.data, '$.role') = 'user' END
    AND NOT (EXISTS (SELECT 1 FROM part q WHERE q.message_id = u.id AND <own>)
      AND NOT EXISTS (SELECT 1 FROM part q WHERE q.message_id = u.id AND NOT <own>))
    ORDER BY u.time_created DESC, u.id DESC LIMIT 1) AS u_created,
  <count of input> AS r_input, <count of output> AS r_output,
  <count of reasoning> AS r_reasoning, <count of cache.read> AS r_cache_read,
  <count of cache.write> AS r_cache_write, <count of total> AS r_total
FROM session s
LEFT JOIN message m ON m.id = (SELECT x.id FROM message x WHERE x.session_id = s.id
  ORDER BY x.time_created DESC, x.id DESC LIMIT 1)
LEFT JOIN message r ON r.id = (SELECT y.id FROM message y WHERE y.session_id = s.id
  AND y.time_created >= coalesce((SELECT z.time_created FROM message z WHERE z.session_id = s.id
    ORDER BY z.time_created DESC, z.id DESC LIMIT 1 OFFSET 9), 0)
  AND <counted step> ORDER BY y.time_created DESC, y.id DESC LIMIT 1)
WHERE s.parent_id IS NULL AND s.time_archived IS NULL
  AND s.time_updated >= CAST(strftime('%s', 'now') AS INTEGER) * 1000 - 172800000
ORDER BY s.time_updated DESC LIMIT 200
```

where `<asking part>`, whether a part is a call that asks the person, begun and perhaps over, as [Needs you](#needs-you) says, is:

```sql
CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') IS 'tool'
  AND json_extract(p.data, '$.tool') IN ('question', 'plan_exit')
  AND json_extract(p.data, '$.state.status') IN ('running', 'completed', 'error') ELSE 0 END
```

`<own>`, whether a part of a prompt is one OpenCode writes itself when it compacts a session on its own (`packages/opencode/src/session/compaction.ts`), is:

```sql
CASE WHEN json_valid(q.data) THEN (json_extract(q.data, '$.type') IS 'compaction'
  AND json_type(q.data, '$.auto') IS 'true')
  OR json_type(q.data, '$.metadata.compaction_continue') IS 'true' ELSE 0 END
```

`<counted step>`, whether a message is a step of a reply that ended with token counts, as [Token counts](#token-counts) says, is:

```sql
CASE WHEN json_valid(y.data) THEN json_extract(y.data, '$.role') IS 'assistant'
  AND json_type(y.data, '$.time.completed') IS 'integer'
  AND (json_extract(y.data, '$.tokens.input') > 0 OR json_extract(y.data, '$.tokens.cache.read') > 0
    OR json_extract(y.data, '$.tokens.cache.write') > 0) ELSE 0 END
```

and `<count of field>`, one of the counted step's six counts, is:

```sql
CASE WHEN json_valid(r.data) THEN CASE WHEN json_type(r.data, '$.tokens.<field>') IS 'integer'
  THEN json_extract(r.data, '$.tokens.<field>') END END
```

The tables and fields are those of `packages/core/src/session/sql.ts`, and the JSON shapes those of `packages/schema/src/v1/session.ts`. Every `time_*` column holds milliseconds.

| Field                                          | Holds                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.id`                                   | `ses_` and 26 characters. A row whose id does not match `^ses[0-9A-Za-z_-]{1,64}$` is dropped                                                                                                                                                                 |
| `session.directory`                            | The session's folder. Kept when it is an absolute path of at most 4,096 characters with no control or format character. An old session may have an empty one                                                                                                  |
| `session.title`                                | The session's title. `New session - <time>` and `Child session - <time>` are OpenCode's placeholders, kept as no title (`isDefaultTitle` in `session.ts`)                                                                                                     |
| `session.time_created`, `time_updated`         | When it began, and when its row was last written: at each prompt, and after each step, when OpenCode writes the session's summary                                                                                                                             |
| `session.parent_id`, `time_archived`           | Set for a subagent's session and for an archived one, which are left out                                                                                                                                                                                      |
| The newest message, by `time_created` and `id` | Its times, and from its `data`: `$.role`, `user` or `assistant`; `$.time.completed`, set once an assistant step ends; `$.error.name`; and `$.finish`, why the step ended                                                                                      |
| `m_tools`                                      | How many of that message's tool parts OpenCode would wait on before it ends the turn (`hasToolCalls` in `packages/opencode/src/session/prompt.ts`)                                                                                                            |
| `m_shell`                                      | 1 when that message's one tool part is the shell's, `bash`, as for a command the person runs with `!` (`shellImpl` in `prompt.ts`), else 0                                                                                                                    |
| `m_asked_at`                                   | Null unless one of that message's calls that ask the person is still `running`. Then the oldest `$.state.time.start` among all such calls, those that are over too, or the part's `time_created` for one with no whole number there ([Needs you](#needs-you)) |
| `p_updated`                                    | The newest `time_updated` of that message's parts                                                                                                                                                                                                             |
| `u_created`                                    | When the newest `user` message began, passing over one whose parts are all a compaction OpenCode made on its own or the text it adds after one                                                                                                                |
| `r_input` to `r_total`                         | From the `data` of the newest step that ended with token counts, among the newest 10 messages: `$.tokens.input`, `$.tokens.output`, `$.tokens.reasoning`, `$.tokens.cache.read`, `$.tokens.cache.write` and `$.tokens.total` ([Token counts](#token-counts))  |

`$.metadata.providerExecuted` and `$.state.metadata.interrupted` are tested inside SQLite, for the count: a tool the model's provider ran itself, and one OpenCode marked as cut off when it cleaned up a step, are not waited on. So are a tool part's `$.tool`, for `m_shell`, a part's `$.type`, `$.tool` and `$.state.status`, for `m_asked_at`, a prompt's parts' `$.type`, `$.auto` and `$.metadata.compaction_continue`, for `u_created`, and a message's `$.role` and `$.time.completed`, for which step's counts are read. Nothing of any of them is printed. Of a call that asks, `$.state.time.start` is printed only when `json_type` says it is a whole number, and never its `$.state.input`. Of `$.tokens`, the three counts of a prompt are tested to pick that step too, and the six counts are printed for that step alone. A role, error name or reason longer than 64 characters, or with a control character in it, is kept as a field of the wrong type, so no long text is kept.

Each `data` is read only once `json_valid` says it is JSON. A message whose `data` is not gives empty fields, which show as unknown, and a part whose `data` is not is not counted, rather than one row failing the whole read. The title is cut to 1,000 characters and the folder to 4,097 inside SQLite, so long ones cannot push the answer past 4 MiB, and a folder longer than 4,096 is still dropped. Each count is printed only when `json_type` says it is a whole number, so a count that is text, an object or a list prints nothing, and the six add at most about 200 bytes a session, about 40 KB for 200 sessions. `m_asked_at` adds about 30 bytes a session, about 6 KB for 200 sessions. It looks only at the parts of the session's newest message, through `part_message_id_id_idx`, as `m_tools`, `m_shell` and `p_updated` do.

## Which sessions are listed

- Root sessions only: OpenCode's subagents run in sessions of their own, with `parent_id` set.
- Not archived.
- Their own row written in the last 48 hours, by SQLite's clock, the newest 200.
- Then each for 24 hours after the newest of its row's `time_updated`, its newest message's and that message's parts'. A time ahead of the clock counts as it is, so a clock set back hides no session.

The name is the title, else the folder's name, else the session's id. A session's id in Agent Lookout is `opencode:<session id>`. It has no app, no process ID, no link, no Jump, no Stop and no `lastWriteAt`. Its `tokens` are the counts of its newest reply that has them, as [Token counts](#token-counts) says.

## Open or closed

The `opencode` program writes no mark of its own for an open session or for itself (`packages/opencode/src/cli/cmd/serve.ts`, `packages/core/src/util/flock.ts`). Nor do the files beside the database say whether it runs. OpenCode 1.19.0 closes its database only when its runtime is disposed, which nothing does before it exits (`packages/core/src/database/sqlite.bun.ts`, `packages/opencode/src/effect/app-runtime.ts`), and Bun's own close at exit moves nothing into the database while a statement is still prepared. So a quit leaves `opencode.db-wal` full, as a crash does.

So the adapter asks `ps`, as it does for Antigravity's own program (`processes.ts`): `ps -A -o comm=`, the name of each process's program and nothing else, run directly from `/usr/bin` or `/bin` with a 2-second timeout, only while there are sessions to show, on macOS and Linux. It runs at most every 10 seconds, and sooner, though not within 2 seconds of the last run, when a session is written after `ps` showed none, since OpenCode may have been started since. OpenCode's releases are one program built with Bun, named `opencode` (`packages/opencode/script/build.ts`). A process whose program has exactly that name is taken for it: on macOS `ps` prints a process's first argument, such as `opencode` or a full path ending in `/opencode`, and on Linux the name of the file it was started from, cut to 15 characters.

| `ps`                                        | Taken as                                                              | Basis                        |
| ------------------------------------------- | --------------------------------------------------------------------- | ---------------------------- |
| Shows a program named `opencode`            | Open                                                                  | `database`                   |
| Shows none                                  | Closed: every session is finished, unless it failed or cannot be read | `database-closed`            |
| Could not be run, or not run on this system | Not known: no session is shown as finished                            | `database-without-processes` |

`ps` is not run on a system other than macOS and Linux. While no session is listed, it is not asked, and the basis is `database`. A session written after `ps` showed none is not held open: it shows as finished until `ps`, asked again, shows OpenCode. So a session written by a program `ps` does not see stays finished, and sends no new Finished notice each time it is written. Not yet checked against OpenCode: whether every way of installing it starts it by that name. The install script and Homebrew install a program named `opencode` (`install`, `packages/opencode/script/publish.ts`). npm's package keeps the program as `bin/opencode.exe` and links `opencode` to it, so it is seen when started through that link (`packages/opencode/script/postinstall.mjs`). OpenCode started by another name, such as that file itself, from its source with `bun`, or through Node, is not seen, and nor is OpenCode's desktop app, which runs OpenCode inside its own program (`packages/desktop/src/main/server.ts`): while only one of those runs, its sessions show as finished.

## Status

From each root session's newest message, by `time_created` and `id`:

| Newest message                                                                                                     | Open      | Closed   |
| ------------------------------------------------------------------------------------------------------------------ | --------- | -------- |
| None                                                                                                               | Idle      | Finished |
| `user`                                                                                                             | Working   | Finished |
| `assistant`, no `time.completed`, and a `question` or `plan_exit` tool part that is `running`                      | Needs you | Finished |
| `assistant`, no `time.completed`, and no such part                                                                 | Working   | Finished |
| `assistant`, error `MessageAbortedError`                                                                           | Idle      | Finished |
| `assistant`, error that is one of the other seven names                                                            | Failed    | Failed   |
| `assistant`, error with any other name                                                                             | Unknown   | Unknown  |
| `assistant`, ended, no `finish`, and its one tool part the shell's                                                 | Idle      | Finished |
| `assistant`, ended, and `finish` is `tool-calls`, `unknown` or missing, or a tool to wait on: under 10 seconds ago | Working   | Finished |
| The same, 10 seconds or more ago                                                                                   | Idle      | Finished |
| `assistant`, ended, any other `finish`                                                                             | Idle      | Finished |
| Any other role, or a field of the wrong type                                                                       | Unknown   | Unknown  |

- An error is read first: OpenCode saves it as the step ends (`packages/opencode/src/session/processor.ts`).
- The seven names are `ProviderAuthError`, `UnknownError`, `MessageOutputLengthError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError` and `APIError` (`packages/schema/src/v1/session.ts`). `MessageAbortedError` is a reply that was stopped, as with Esc.
- Each step of a reply is an assistant message of its own. OpenCode starts the next step at once, and writes its message a moment after the last one ends, so a step that asks for tools is working for 10 seconds after it ended (`STEP_GAP_MS`). How long that moment lasts was not measured. A step that ended up to a minute after the poll noted its time ended while the poll read, and is working too. One further ahead is from a clock set back, which counts as those 10 seconds gone.
- A command the person runs with `!` is a step of its own with no `finish` and one tool part, the shell's, and no next step follows it, so it is idle once it ends.
- A failed or unknown session stays so once OpenCode is closed.
- A session that needs you has the reason `question` and no `waitingText`, and is finished, with no reason, once OpenCode is closed. A part older than the last `ps` that showed no OpenCode counts as no such part ([Needs you](#needs-you)).

The status time of a working session is when the newest `user` message began, which is mostly the person's prompt that starts the turn; else when the newest message began; else when the session did. The two prompts OpenCode writes itself when it compacts a session on its own are passed over, though OpenCode writes the message of each before its part, so a read that falls in between counts it until the next read. Three others it writes are not told apart from the person's, so the time moves to them: the one that asks for a subtask's summary after a command run as a subtask, a prompt it sends again after it compacts a session whose context overflowed (`prompt.ts`, `compaction.ts`), and, with OpenCode's experimental plan mode, the one it writes when the person approves a plan (`packages/opencode/src/tool/plan.ts`). A session that needs you has `m_asked_at` for its time, so no write while it waits moves it. For an idle, failed or finished session it is when the newest step ended, or else the newest time anything of the session was written. An unknown session has none.

## Needs you

A session needs you while OpenCode waits for the person inside a call to its `question` or `plan_exit` tool. OpenCode writes no wait as such. What the database holds is the tool part of that call.

### What OpenCode writes

From OpenCode's source at v1.19.5, the newest 1.x tag (commit `810c0eb`), whose line numbers these are. `ai` is 6.0.168 there, as at v1.19.0.

- `question` and `plan_exit` are tools (`Tool.define` in `packages/opencode/src/tool/question.ts:14-15` and `packages/opencode/src/tool/plan.ts:15-16`). The `execute` of each calls `question.ask` (`question.ts:24-28`, `plan.ts:30-44`), which keeps the request in a `Map` in memory and waits on a `Deferred` (`ask` in `packages/opencode/src/question/index.ts:87-112`, at `:103` and `:106-111`). So the wait lasts as long as the tool's `execute`.
- `question` is offered in OpenCode's terminal, app and desktop clients, or with `flags.enableQuestionTool` (`packages/opencode/src/tool/registry.ts:207`, `:233`), and `plan_exit` only with OpenCode's experimental plan mode, in its terminal client (`registry.ts:248`). Both are denied to an agent unless allowed (`packages/opencode/src/agent/agent.ts:126-128`), and a denied tool is not offered to its model (`Permission.disabled` in `packages/opencode/src/session/llm/request.ts:210`). `build` is allowed `question` (`:148`), and `plan` both (`:163-164`). So a subagent has neither unless the person's config gives it one.
- A part's `data` holds `$.type`, `$.tool` and `$.state`, and its `id`, `messageID` and `sessionID` are columns (`partData` in `packages/core/src/session/projector.ts:84-87`). `session.updatePart` publishes the part, and the projector writes it to `part` (`updatePart` in `packages/opencode/src/session/session.ts:635-643`, `projector.ts:310-328`).

The table says what the call's row in `part` holds at each point, with lines in `packages/opencode/src/session/processor.ts` unless another file is named. OpenCode writes nothing to it while the call waits.

| When                                                                                                                                                  | `$.state.status`                          | Where                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model begins the call                                                                                                                             | `pending`                                 | `ensureToolCall`, `:236-245`, from `tool-input-start`. Nothing is asked yet                                                                                                                                                                                                                                          |
| The call is whole, and OpenCode starts the tool                                                                                                       | `running`                                 | `tool-call`, `:337-351`. `$.state.time.start` is `Date.now()` at `:346`, a whole number by `ToolStateRunning` (`packages/schema/src/v1/session.ts:266-274`)                                                                                                                                                          |
| OpenCode waits for the person                                                                                                                         | `running`                                 | No write                                                                                                                                                                                                                                                                                                             |
| The person answers                                                                                                                                    | `completed`                               | `reply` settles the `Deferred` (`question/index.ts:114-132`), the tool returns, and `tool-result` calls `completeToolCall` (`:383-414`, `:160-184`), which keeps `time.start` and adds `time.end`                                                                                                                    |
| The person declines: Esc in the question (`packages/tui/src/routes/session/question.tsx:57-62`, `:253`, `:281`), or No for `plan_exit` (`plan.ts:46`) | `error`                                   | For Esc, `reject` fails the `Deferred` (`question/index.ts:134-148`). For No, `reply` settles it and the tool fails with `Question.RejectedError` (`plan.ts:46`). Then `tool-error` calls `failToolCall` (`:416-419`, `:186-205`). By default the turn ends there (`ctx.blocked`, `:200-202`, `:694`)                |
| The step is stopped some other way                                                                                                                    | `error`                                   | `cleanup` waits up to 250 ms for the calls, then writes `error` with `$.state.metadata.interrupted` true (`:585-607`). `halt` records `MessageAbortedError` on the message (`:613-639`, `:662-669`)                                                                                                                  |
| OpenCode quits, crashes or is killed                                                                                                                  | `running`, or `error` if it gets to write | Disposing OpenCode's instance rejects what waits (the state's finalizer, `question/index.ts:74-81`). A crash or a kill writes nothing, and nothing at v1.19.5 moves such a part when OpenCode starts again: `toModelMessagesEffect` only reads it as cut off (`packages/opencode/src/session/message-v2.ts:362-364`) |

Three more things hold for a step that waits:

- `running` is written before the wait. With the AI SDK, `tool-call` goes on the stream before the tool starts (`controller.enqueue(toolCall)` at `:277` and `executeToolCall` at `:336` of `packages/ai/src/generate-text/run-tools-transformation.ts` in `ai` 6.0.168), and OpenCode's stream is read one event at a time (`processor.ts:656-660`). OpenCode's own runtime gives `tool-call` before it dispatches the tool too (`packages/opencode/src/session/llm/native-runtime.ts:115-129`).
- The step has no `$.time.completed`. OpenCode sets it only in `cleanup`, after the stream ends (`processor.ts:609-610`, `:690`), and the stream goes on until every tool has ended. The AI SDK holds the step's end back until then, so the step has no `$.finish` either (`attemptClose`, `run-tools-transformation.ts:172-182`). OpenCode's own runtime can write `$.finish` while the tool runs (`native-runtime.ts:131-137`), so the status goes by `$.time.completed`.
- After Yes to `plan_exit`, the tool writes a `user` message of its own before it returns (`plan.ts:53-69`), so the session is working from that message on, a moment before its part moves to `completed`.

### What is shown

- While the newest message has a `question` or `plan_exit` tool part in the state `running`, and has no `$.time.completed`, the session needs you. The reason is `question` for both tools, as in [Qwen Code](qwen-code.md): both put a question to the person, and neither asks for a tool's approval.
- It has no `waitingText` and no `waitingDetail`. `$.state.input`, which holds the question, is never read, so the Needs you panel says Asked you a question and nothing more, and a notification says the same. There is no Answer: the person answers in OpenCode.
- Its time is `$.state.time.start`, the moment before OpenCode asks. A step that asks two at once takes the older, and keeps it until neither waits, whichever is answered first: one step is one model call, so its calls are one wait. A call the model is still writing, which is `pending` and has no start, does not count. No other write moves the time, so one wait is announced once. A part with no whole number there, which OpenCode 1.19.5 never writes for a call it has started, takes the time the part was written, and a time that could not be right is shown as none.
- Once the part leaves `running`, the rest of the message decides. After an answer the session is working, since the step goes on. After a refusal the step ends with `tool-calls`, so it is working for 10 seconds, then idle. After a stop it ends on `MessageAbortedError`, so it is idle at once. Each change is read on the first poll after the database or its `-wal` changes.
- With OpenCode closed the session is finished, with no reason, since the wait was in OpenCode's memory. The wait ends in the Events log and in Waits on the first poll that reads it so.
- A wait lives in a running OpenCode's memory, so a `running` part older than the last `ps` that showed no OpenCode is no wait: a killed OpenCode left it. Once OpenCode runs again the session shows as working, as a step that was cut off does, and it is not announced again.
- A session leaves the list a day after it was last written ([Which sessions are listed](#which-sessions-are-listed)), and OpenCode writes nothing while it asks, so a question unanswered for a day leaves the list though OpenCode still asks. Its wait stops there, the Events log says the session ended, and Keep awake lets go. It comes back once the person answers.
- A wait for a tool's approval is unchanged, and shows as working. `permission.ask` keeps it in the same way, in memory (`ask` in `packages/opencode/src/permission/index.ts:67-107`), but it runs inside the tool that asks, whose part is already `running` as any tool's that works, so nothing in the database tells the two apart.

`tests/integration/collector/adapters/opencode/database.test.ts` runs the real `sqlite3` on a database written as above: a `question` call waiting, answered, declined and cut off, a `plan_exit` call waiting, answered and declined, two calls of one step answered in either order, a call still being written, tools of other names running, a part that is not JSON and a subagent's question. Not yet checked on a computer running OpenCode: that a part is `running` while OpenCode asks. To check, have a session ask a question, and read the `$.tool` and `$.state.status`, and only those, of the newest part of its newest message.

## Token counts

A session's details give the token counts of its newest reply that has them. They come from the sessions query each poll asks, so nothing is read for them that a poll does not read, and no question is asked for them alone.

### Where OpenCode writes them

From OpenCode's source at v1.19.0, whose line numbers these are. At v1.19.5 the code named here is the same, and so are the versions of the AI SDK packages it pins.

- Each step of a reply is an `assistant` message of its own, made with every count 0 (`runLoop` in `packages/opencode/src/session/prompt.ts:1186-1199`). Each step is one call of the model: `streamText` is given no `stopWhen` (`packages/opencode/src/session/llm.ts:280`), so the AI SDK makes one step. A command run with `!` (`shellImpl`, `prompt.ts:489-502`) and a command's subtask handed to a subagent (`handleSubtask`, `prompt.ts:268-282`) are `assistant` messages made the same way, which no model call fills in.
- When the step's usage comes, in its `step-finish`, OpenCode sets the message's `tokens` to what `getUsage` works out and saves the message (`packages/opencode/src/session/processor.ts:435-470`, `ctx.assistantMessage.tokens = usage.tokens` at `:459`). It sets `time.completed` later, when it cleans up the step, however it ends (`cleanup`, `processor.ts:553-610`, at `:609`). So a step under way can have its counts and no `time.completed`, and a step stopped before its usage came, as with Esc, ends with every count 0.
- A message's `tokens` is `{ total?, input, output, reasoning, cache: { read, write } }`, with `total` the one that can be left out (`Assistant` in `packages/schema/src/v1/session.ts:472-481`).

`getUsage`, in `packages/opencode/src/session/session.ts:338-405`, works them out from the usage the step's provider sent:

| Count         | What `getUsage` writes                                                                                                                                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`       | `inputTokens` less `cacheReadInputTokens` and `cacheWriteInputTokens` (`:364`): the prompt, but for what was read from a cache or written to one                        |
| `cache.read`  | `cacheReadInputTokens` (`:345`)                                                                                                                                         |
| `cache.write` | `cacheWriteInputTokens`, or, when the usage has none, the `cacheCreationInputTokens` an Anthropic, Vertex, Bedrock or Venice provider puts in its metadata (`:346-359`) |
| `output`      | `outputTokens` less `reasoningTokens` (`:371`): what the reply wrote, but for its reasoning                                                                             |
| `reasoning`   | `reasoningTokens` (`:343`)                                                                                                                                              |
| `total`       | `totalTokens`, as it is, and none when the usage has none (`:366`)                                                                                                      |

A count the usage does not hold is 0 (`?? 0`), and one that is not finite, or comes out below 0 after the taking away, is 0 (`safe`, `:339-340`). The comment above `input` says that AI SDK v6 counts the cached tokens in `inputTokens` for every provider (`:361-363`).

The usage comes from the AI SDK, `ai` 6.0.168 at v1.19.0. OpenCode's `usage` takes its step usage's `inputTokens`, `outputTokens`, `totalTokens`, `outputTokenDetails.reasoningTokens`, `inputTokenDetails.cacheReadTokens` and `inputTokenDetails.cacheWriteTokens` (`packages/opencode/src/session/llm/ai-sdk.ts:45-64`). The AI SDK takes `inputTokens` and `outputTokens` from the provider's `inputTokens.total` and `outputTokens.total`, and makes `totalTokens` the two added up (`asLanguageModelUsage` in `ai` 6.0.168). With OpenCode's experimental native runtime on (`flags.experimentalNativeLlm`, `llm.ts:226`), it comes instead from OpenCode's own `@opencode-ai/llm`, whose `Usage` has the same meaning: `inputTokens` with the cache's reads and writes in it, `outputTokens` with the reasoning in it, and `totalTokens` the provider's total or the two added up (`packages/llm/src/schema/events.ts:7-74`).

What each provider's package, at the version OpenCode 1.19.0 pins, puts in them:

| Provider                                                                                     | `inputTokens.total`                                                                  | `cacheRead`                       | `cacheWrite`                          | `outputTokens.total`                                     | `reasoning`                                                  |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- | ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| Anthropic (`convertAnthropicMessagesUsage` in `@ai-sdk/anthropic` 3.0.111)                   | `input_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` together | `cache_read_input_tokens`, else 0 | `cache_creation_input_tokens`, else 0 | `output_tokens`, the thinking in it                      | `output_tokens_details.thinking_tokens` when sent, else none |
| Amazon Bedrock (`convertBedrockUsage` in `@ai-sdk/amazon-bedrock` 4.0.166)                   | `inputTokens`, `cacheReadInputTokens` and `cacheWriteInputTokens` together           | `cacheReadInputTokens`, else 0    | `cacheWriteInputTokens`, else 0       | `outputTokens`                                           | none                                                         |
| OpenAI chat (`convertOpenAIChatUsage` in `@ai-sdk/openai` 3.0.88)                            | `prompt_tokens`                                                                      | `cached_tokens`, else 0           | `cache_write_tokens` when sent        | `completion_tokens`                                      | `reasoning_tokens`, else 0                                   |
| OpenAI Responses (`convertOpenAIResponsesUsage` in `@ai-sdk/openai` 3.0.88)                  | `input_tokens`                                                                       | `cached_tokens`, else 0           | `cache_write_tokens` when sent        | `output_tokens`                                          | `reasoning_tokens`, else 0                                   |
| OpenAI-compatible (`convertOpenAICompatibleChatUsage` in `@ai-sdk/openai-compatible` 2.0.41) | `prompt_tokens`                                                                      | `cached_tokens`, else 0           | none                                  | `completion_tokens`                                      | `reasoning_tokens`, else 0                                   |
| Google (`convertGoogleGenerativeAIUsage` in `@ai-sdk/google` 3.0.73)                         | `promptTokenCount`                                                                   | `cachedContentTokenCount`, else 0 | none                                  | `candidatesTokenCount` and `thoughtsTokenCount` together | `thoughtsTokenCount`, else 0                                 |

When Anthropic lists a reply's `iterations` and none is a fallback, its `input_tokens` and `output_tokens` there are those of its `compaction` and `message` iterations added up. OpenCode patches some of these packages (`patches/` in its repository), and no patch changes how usage is read.

So, for each of them, `input`, `cache.read` and `cache.write` together are the whole prompt, the provider's `inputTokens.total`, and `output` and `reasoning` together are everything the reply wrote, its `outputTokens.total`, with the reasoning in it once: `output` leaves the reasoning out when the provider counts it apart, and holds it when the provider does not, as Anthropic without `thinking_tokens` and Bedrock, with `reasoning` 0. `total` is the two added up. OpenCode's own sidebar counts the context in use the same way, as the five added up, for the newest `assistant` message whose `output` is above 0 (`packages/tui/src/feature-plugins/sidebar/context.tsx:20-29`).

### What is shown

| Shown  | From the counted step's `$.tokens`               |
| ------ | ------------------------------------------------ |
| In     | `input`, `cache.read` and `cache.write` together |
| Cached | `cache.read`, unless 0                           |
| Out    | `output` and `reasoning` together                |

`replyTokensOf` in `sessionRows.ts` works out these three, and `tokenCountsOf` in `src/core/tokens/tokenCounts.ts` checks them.

- What was written to a cache counts in In, and not in Cached. It is part of the prompt the reply was given, which the provider read whole and then kept, and none of it was read from a cache. Anthropic's and Bedrock's packages count it in `inputTokens.total`, OpenCode's sidebar counts it in the context, and the Claude Code and [Qwen Code](qwen-code.md#token-counts) adapters count it in In too.
- A `cache.read` of 0 is left out, and the details say only Newest reply: each package above writes 0 for a provider that sent none, and so does `getUsage` for a usage with none (`?? 0`), so the message cannot tell that from a cache that held none.
- The counted step is the newest `assistant` message of the session's own, among its newest 10 by `time_created` and `id`, whose `$.time.completed` is a whole number and whose `$.tokens.input`, `$.tokens.cache.read` or `$.tokens.cache.write` is above 0 (`COUNTED_STEP` in `sessionRows.ts`). A subagent works in a session of its own, so its steps are never counted for the session that started it.
- A step under way has no `$.time.completed`, even once its counts are written, so it leaves the counts of the step before it.
- A step `/undo` took back is still counted until the next prompt, or command run with `!`, removes it: unlike the last-message question, the sessions query reads nothing of `revert`, so the counts can be those of a reply after the one Last message shows.
- A step that ended with no prompt count above 0, its `input`, `cache.read` and `cache.write` each 0, missing or below 0, is passed over even when its `output` is above 0, and the counts stay those of the step before it. A step that ended with every count 0 is one, and OpenCode's sidebar passes over those too: a step stopped before its provider sent its usage, as with Esc, or failed before it, a command run with `!`, a command's subtask handed to a subagent, and every step of a provider that sends no usage, for which the details show a dash. So is a step of a provider that sends what a reply wrote but no prompt counts: `getUsage` writes 0 for a count the usage does not hold, so its `output` is above 0 and its three prompt counts are 0, and OpenCode's sidebar counts it. `getUsage` never leaves a prompt count out, or writes one below 0.
- A compaction's summary is a step with counts of its own, so once OpenCode compacts a session, the counts are the summary's until the next step ends. Its In is the conversation it was given to sum up.
- Once a step is counted, counts that could not be right give a dash, never an older step's: one of the five that is missing, not a whole number or below 0; a `total` smaller than In and Out together, which means `getUsage` raised a count that came out below 0 to 0, as when a provider's parts add up to more than its whole; or counts too large to add up exactly. SQLite holds text above every number, so a step whose `input` is text is counted, and gives a dash. A `total` that is missing, as OpenCode writes none when the usage has none, is not needed.
- Nothing is summed: there are no totals. The session's own `tokens_*` columns, which OpenCode adds each step's counts to (`packages/core/src/session/projector.ts:99-103`), are never read.
- When no step with counts is among the session's newest 10 messages, as after ten prompts sent with no reply between them, the details show a dash.

### What they cost

They are read inside the sessions query, so they cost no run of `sqlite3` of their own, and like the rest of it they are read only when the database or its `-wal` changed. For each session asked for, the query walks back through its messages, newest first, with `message_session_time_created_id_idx` on `session_id`, `time_created` and `id`, and stops at the first counted step. It never walks past the 10th newest, by `time_created` and `id`, which it finds in that index alone, without reading a message. So it reads the `data` of at most 10 messages a session, most often one or two, however long the session, even when several were written in the same millisecond as the 10th. Then it reads the counted message once more by its id. It prints six numbers a session at most, each only when `json_type` says it is a whole number: about 200 bytes a session at most, about 40 KB for the 200 sessions it asks for at most, against the 4 MiB `sqlite3` may print. `tests/integration/collector/adapters/opencode/database.test.ts` checks with the real `sqlite3` that the walk uses that index, bounded by the 10th newest's time and id, and how much the counts add to the answer.

Not yet checked on a computer running OpenCode: that its messages hold the counts as the source above writes them, for any provider. To check, run a session with each provider you use, and compare, for its newest reply, the five counts of its message's `$.tokens`, and only those, with what its details show. In and Out added up should be what OpenCode's sidebar shows under Context.

## Last message

What a session last said is asked for only when `GET /api/sessions/last-message` asks, which the dashboard does while the session's details are open, and only for a session the last poll listed (`lastMessages.ts`, on `createEndReader` in `src/collector/messages/tailReader.ts`, which keeps the limits of Codex's and Qwen Code's readers). No poll asks it, and it is never put on a session.

- It is asked with `askOnce` in `database.ts`: the same three `lstat`s as a poll, the same address, chosen the same way, the same `sqlite3`, found the same way, with the same arguments, stdin closed, no shell and the same 5-second timeout, and at most 256 KB of what it prints read. So it touches OpenCode's files in no way a poll does not, and the one empty `-wal` [above](#how-sqlite3-opens-the-database) can come of it as of a poll's read.
- It is asked again only once the database or its `-wal` has changed since that session's last answer, by identity, size or modified time. A look at the database counts as one of the four reads a second every agent's last messages share, and the answer is kept for at most 15 seconds after the last ask, as every agent's is.
- The question names the session by OpenCode's id for it, as the last poll read it, put into the question only once it matches `^ses[0-9A-Za-z_-]{1,64}$`, so it cannot end the quotes it is put between. `sqlite3` takes a value apart from the question only through its `.parameter set` command, which first reads the value as SQL and keeps it in a table of its temporary schema (`src/shell.c.in` at SQLite 3.54.0), so binding it that way would be no safer. Nothing from a request is put into it.
- The session must have no `parent_id`. A subagent works in a session of its own, so its messages are never the root session's, and the text the `task` tool hands back is in a `tool` part, which is never taken.
- The messages looked through and counted are those `/undo` has not taken back. `/undo` sets the session's `revert`, whose `$.messageID` names the prompt it went back to, and keeps the messages from that one on until the next prompt, or command run with `!`, removes them. The question leaves out each message that comes at or after that one, by `time_created` and `id`, when `revert` is JSON and the session has that message.

```sql
WITH asked AS (SELECT s.id,
  CASE WHEN json_valid(s.revert) THEN json_extract(s.revert, '$.messageID') END AS undo_from
  FROM session s WHERE s.id = '<id>' AND s.parent_id IS NULL),
undone AS (SELECT c.id, c.time_created FROM message c
  WHERE c.session_id = (SELECT id FROM asked) AND c.id = (SELECT undo_from FROM asked)),
recent AS (SELECT m.id, m.time_created, <reply step> AS step FROM message m
  WHERE m.session_id = (SELECT id FROM asked) AND <not undone>
  ORDER BY m.time_created DESC, m.id DESC LIMIT 100),
reply AS (SELECT r.id FROM recent r WHERE r.step = 1
  AND EXISTS (SELECT 1 FROM part p WHERE p.message_id = r.id AND <text part>)
  ORDER BY r.time_created DESC, r.id DESC LIMIT 1),
texts AS (SELECT p.id, json_extract(p.data, '$.text') AS t FROM part p
  WHERE p.message_id = (SELECT id FROM reply) AND <text part>),
ends AS (SELECT id, t, coalesce(sum(length(t) + 1) OVER
  (ORDER BY id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS after FROM texts)
SELECT 'reply' AS kind, (SELECT count(*) FROM texts) AS parts,
  (SELECT count(*) FROM (SELECT 1 FROM message m WHERE m.session_id = (SELECT id FROM asked)
    AND <not undone> LIMIT 101)) > 100 AS more, NULL AS n, NULL AS cut, NULL AS text
UNION ALL SELECT 'text', NULL, NULL, row_number() OVER (ORDER BY id),
  length(t) > 4000, substr(t, -4000) FROM ends WHERE after < 4000
```

where `<reply step>`, whether a message is a step of a reply and not a compaction's summary, is:

```sql
CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.role') IS 'assistant'
  AND json_type(m.data, '$.summary') IS NOT 'true' ELSE 0 END
```

`<not undone>`, whether `/undo` has left a message alone, is:

```sql
NOT EXISTS (SELECT 1 FROM undone u WHERE (m.time_created, m.id) >= (u.time_created, u.id))
```

and `<text part>`, whether a part is text of the reply's own, is:

```sql
CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') IS 'text'
  AND json_type(p.data, '$.text') IS 'text'
  AND json_type(p.data, '$.synthetic') IS NOT 'true'
  AND json_type(p.data, '$.ignored') IS NOT 'true'
  AND trim(json_extract(p.data, '$.text'), char(32, 9, 10, 13)) != '' ELSE 0 END
```

It prints one `reply` row, with how many text parts the reply has, none when no reply among the session's newest 100 messages has text, and whether the session has more than 100 messages. Then a `text` row for each text part needed for the reply's last 4,000 characters, numbered in the order of their ids, with its last 4,000 characters, and `cut` 1 when that left some of it out. So what it prints stays under 256 KB however long the reply: at most 2,000 `text` rows, since each part adds at least 2 to `after`, of under 8,000 characters in all, which come to under 175 KB even when `sqlite3` writes every character as six bytes, as it writes a control character. Of `data` it prints only `$.text` of those parts. `$.role`, `$.summary`, `$.type`, `$.synthetic` and `$.ignored` are tested inside SQLite, and nothing of them is printed. Of `session` it prints nothing: `$.messageID` of `revert` is only compared, inside SQLite, with the ids of the session's own messages. `answerFrom` joins the parts with a line break and makes the text fit to show as every last message is, at most its last 2,000 characters, with `cut` when the question or the cut to 2,000 left the start out. No reply with text is `nothing-yet`, or `too-far-back` when the session has more than 100 messages. No database is `not-found`. One that cannot be read, a `sqlite3` that is not found or does not answer, or an answer that is not this question's, is `unreadable`. The answer has no token counts: a session's are on the session, from the poll's read ([Token counts](#token-counts)). `AGENT_LOOKOUT_LAST_MESSAGE=off` or `AGENT_LOOKOUT_WAITING_TEXT=off` stops it, and the Sources card then says Last message read: Off. On Windows it says not read on Windows.

What was checked in OpenCode's source at v1.19.0, and not yet on a computer running OpenCode:

| What is taken, or left out                                                         | Checked in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each step of a reply is an `assistant` message, newest by `time_created` and `id`  | `page` in `packages/opencode/src/session/message-v2.ts`, which orders a session's messages that way, and the `message` table and its index in `packages/core/src/session/sql.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A message's parts, in the order of their ids                                       | `parts` and `hydrate` in `message-v2.ts`, which order them by `part.id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A text part's words are `$.text`, and OpenCode marks some `synthetic` or `ignored` | `TextPart` in `packages/schema/src/v1/session.ts`. Prompts get most `synthetic` parts (`resolvePart` and `shellImpl` in `packages/opencode/src/session/prompt.ts`, and the text OpenCode adds after it compacts a session in `compaction.ts`), and OpenCode's window leaves `synthetic` text out of a prompt it shows (`UserMessage` in `packages/tui/src/routes/session/index.tsx`). `ignored` text is left out of what the model is given (`toModelMessagesEffect` in `message-v2.ts`)                                                                                                                                                        |
| Thinking, tools and files are parts of their own                                   | `ReasoningPart`, `ToolPart` and `FilePart` in `session.ts`, of `$.type` `reasoning`, `tool` and `file`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A compaction's summary is an `assistant` message with `summary` true               | `compaction.ts`, which writes it with `summary: true`, `mode` and `agent` `compaction`, and `filterCompacted` in `message-v2.ts`, which tells it by `summary`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| A subagent's work is in a session of its own                                       | `packages/opencode/src/tool/task.ts`, which starts a subagent in a session it makes with `parentID` set to the session that asked, kept as `parent_id` of `session` (`sql.ts`), and hands back the subagent's words as the tool's output                                                                                                                                                                                                                                                                                                                                                                                                        |
| A reply under way holds no words in the database                                   | `text-start`, `text-delta` and `text-end` in `packages/opencode/src/session/processor.ts`: the part is saved empty at its start and with its words at its end, and `updatePartDelta` in `session.ts`, which the words in between go through, saves nothing. `packages/core/src/session/projector.ts` writes `part` only for a saved part                                                                                                                                                                                                                                                                                                        |
| A message `/undo` took back is left out until OpenCode removes it                  | `revert` and `cleanup` in `packages/opencode/src/session/revert.ts`: `/undo` sets the session's `revert` to the prompt it went back to, and the next prompt, or command run with `!`, removes that message and every one after it (`prompt` and `shellImpl` in `prompt.ts`). `messagesBeforeRevert` in `packages/tui/src/routes/session/index.tsx`, which "Copy last assistant message" reads, cuts the messages OpenCode's window holds, kept in the order of `time_created` and `id` (`compareMessage` in `packages/tui/src/context/sync.tsx`), at that message when it finds it there, and the window's list of messages hides the same ones |
| The parts are joined with a line break                                             | "Copy last assistant message" in `packages/tui/src/routes/session/index.tsx`, which joins the text parts of the newest assistant message with one and trims the whole. OpenCode's window shows each part as a block of its own                                                                                                                                                                                                                                                                                                                                                                                                                  |

Not checked on a computer running OpenCode: that the text looks as OpenCode shows it, and whether a plugin or a provider writes text parts of other shapes.

## Known gaps

- A session waiting for a tool's approval shows as working. OpenCode keeps that wait in memory, and writes nothing while it lasts (`packages/opencode/src/permission/index.ts`).
- A session a killed or crashed OpenCode left asking keeps its `running` part. With no OpenCode running it is finished, like every session. Once `ps` has shown none, the part is no wait, so the session shows as working when OpenCode starts again, like any other step that was cut off. If `ps` never showed none, because another OpenCode stayed open, or OpenCode came back before the next `ps`, the session goes on needing you, and counts for Keep awake, until a new prompt in it or until it leaves the list a day after it was last written. The time of that `ps` is kept in memory, so a restart of Agent Lookout forgets it until `ps` next shows none.
- A live question in a program `ps` does not see, such as OpenCode's desktop app or OpenCode started by another name, is taken for one left behind once `ps` has shown no OpenCode, so while another OpenCode runs its session shows as working.
- A question unanswered for a day leaves the list, and is logged as ended, though OpenCode still asks ([Needs you](#needs-you)). OpenCode writes nothing while it asks, so no time says the session is still in use.
- A question a subagent asks shows as working on the session that started it: its part is in the subagent's own session, which is not read. A subagent has the `question` tool only when the person's config gives it.
- Only the newest message is looked at, so a prompt sent while a question waits shows the session as working though OpenCode still waits. OpenCode's window hides its prompt box while a question shows (`packages/tui/src/routes/session/index.tsx:238`), so it takes another client to send one.
- Quiet for is never shown. OpenCode keeps every session in one database, so no file's modified time says when one session was last written.
- A reply's text is saved only once it ends, so nothing changes in the database while a long reply is written.
- Finished is told from `ps`, so while only OpenCode's desktop app runs, or OpenCode started by a name other than `opencode`, its sessions show as finished. When `ps` fails, no session is shown as finished.
- A reply that fails before its first step begins, as when no model can be found, shows as working while OpenCode is open.
- A prompt sent with no reply asked for, as OpenCode's `/move` and its new-workspace dialog send, shows as working while OpenCode is open.
- When an approval or a question is turned down, or a subtask is cancelled, the turn ends there. If its last step asked for tools, the session shows as working for 10 seconds, then idle.
- Nothing is read on Windows, where Agent Lookout never runs `sqlite3`. The card says OpenCode is not read there.
- `opencode-<channel>.db` is not read.
- The JSON files OpenCode kept under `storage/` before v1.2 are not read.
- OpenCode 2's sessions, in `session_v2`, are not read yet. When the probe finds that table, the card says so. OpenCode 1.x has its own `session_message` table since v1.14.34, so that table alone does not mean OpenCode 2.
- A subagent's session is not listed, and its work does not show on the session that started it.
- A session whose own row was last written more than 48 hours ago is not asked for.
- Token counts are those of the newest step with counts among the session's newest 10 messages. When there is none there, as after ten prompts sent with no reply between them, the details show a dash.
- A step stopped before its provider sent its usage, as with Esc, is passed over, so the details show the counts of the step before it.
- After `/undo`, the token counts can be those of a step it took back, until the next prompt, or command run with `!`, removes it: the sessions query reads nothing of `revert`, so they can be of a newer reply than Last message shows.
- While a reply is written, OpenCode saves its words only once each text part ends, so Last message shows the reply before it, or the parts of this one that have ended, until then.
- After Esc, Last message is the part of the reply OpenCode had when it stopped, which it saves as it cleans up the step (`cleanup` in `processor.ts`, which runs however the step ends).
- A reply further back than the session's newest 100 messages is not looked for, and Last message says it is further back.
- Last message joins a reply's text parts with one line break, where OpenCode's window shows each as a block of its own.
- With a `sqlite3` from 3.45.0 to 3.47.x, as Ubuntu 24.04's is, a control character in a reply, such as an escape, shows as its code without a backslash, such as `u001b`: those versions print it that way (`output_json_string` in SQLite's `src/shell.c.in`).

## What it never reads

- **Files:** `auth.json` and `mcp-auth.json`, which hold keys and sign-ins; everything in OpenCode's state folder, `~/.local/state/opencode`, such as `locks/`, `kv.json`, `model.json`, `password`, `server.json` and `service.json`; everything in its config folder, `~/.config/opencode`, `service.json` among it; `log/`, `storage/`, `snapshot/`, `tool-output/` and `plans/`; `opencode-<channel>.db`; and, for the adapter itself, any file but the three database files. A session's own folder is looked in for a git repository, as every session's is, and OpenCode makes its worktrees in `worktree/` in its data folder, so a session run in one has its folder there. Only its `.git` file is read there, then `HEAD` and `commondir` in the git folder that file names, and with `AGENT_LOOKOUT_PULL_REQUESTS=on` the repository's `config` and its remote's `HEAD`, as [PRIVACY.md](../../PRIVACY.md#git-repositories) describes.
- **Tables:** every one but `session`, `message` and `part`, and the names in `sqlite_master` and of the columns of `session` and `session_v2`. So never `event`, `event_sequence`, `account`, `control_account`, `credential`, `session_share`, `permission`, `project`, `todo`, `workspace` or `kv`.
- **Columns:** no `SELECT *` and no whole `data`. Never `share_url`, `summary_*`, `metadata`, `permission`, `model`, `agent`, `cost` or `tokens_*` of `session`, nothing of a message's `data` but the fields above, so never its `$.cost`, its `$.modelID` or its `$.providerID`, and of its `revert` only `$.messageID`, which the last-message question compares with message ids inside SQLite and never prints, and no text of a message or a part but the `$.text` of the reply's text parts that the last-message question prints: never a prompt's `$.text`, a `reasoning` part's, a tool's `$.state.input`, `$.state.output` or `$.state.error`, `$.system`, or `$.summary`, which that question only tests inside SQLite for `true`.
- **Programs:** no `opencode` command, no git command and no request to OpenCode's server. `ps` is asked for the name of each process's program alone, never its arguments.

## What breaks when OpenCode changes

| Change in OpenCode                                                                                                        | What the dashboard shows                                                 | Where to fix it                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| A column the probe asks for is renamed or dropped                                                                         | The card says the database is from a version Agent Lookout does not read | `sessionRows.ts`                               |
| `message` or `part` loses a column the query asks for                                                                     | The card says sqlite3 could not read the database                        | `sessionRows.ts`                               |
| OpenCode drops the 1.x tables, as OpenCode 2 can                                                                          | No sessions, and the card says OpenCode 2's sessions are not read yet    | `sessionRows.ts`, `database.ts`                |
| A new error name                                                                                                          | Sessions that end on it show as unknown                                  | `src/core/mapping/opencode/opencodeMapping.ts` |
| `$.role`, `$.time.completed`, `$.error` or `$.finish` changes shape                                                       | Sessions show as unknown, or with the wrong status                       | `src/core/mapping/opencode/opencodeMapping.ts` |
| The next step's message is written later after a step ends                                                                | A session between two steps shows as idle for a moment                   | `STEP_GAP_MS` in `opencodeMapping.ts`          |
| `question` or `plan_exit` is renamed, or a call stops being `running` while it waits                                      | A session that asks shows as working                                     | `ASKING_PART` in `sessionRows.ts`              |
| A wait is added to another tool of OpenCode's                                                                             | A session that asks through it shows as working                          | `ASKING_PART` in `sessionRows.ts`              |
| The data folder or the database's name moves                                                                              | OpenCode is not found, or found with no database                         | `index.ts`                                     |
| OpenCode's program is given another name                                                                                  | Its sessions show as finished while it runs                              | `processes.ts`                                 |
| The placeholder title changes                                                                                             | New sessions are named by the placeholder, not the folder                | `sessionRows.ts`                               |
| A text part's `$.text`, `$.synthetic` or `$.ignored`, a summary's `$.summary`, or `revert`'s `$.messageID`, changes shape | Last message shows nothing, or text OpenCode does not show as the reply  | `lastMessages.ts`                              |
| `session` loses `revert`, or `part` loses `id`, the columns only the last-message question asks for                       | Last message says the transcript could not be read                       | `lastMessages.ts`                              |
| A message's `$.tokens` changes shape, or `getUsage` counts `input`, `output` or `reasoning` another way                   | The details show a dash, or counts that are wrong                        | `sessionRows.ts`                               |

To check a new OpenCode version, read at its tag `packages/core/src/session/sql.ts`, `packages/core/src/session/projector.ts`, `packages/schema/src/v1/session.ts`, `packages/core/src/database/database.ts`, `packages/core/src/global.ts`, `packages/opencode/src/session/processor.ts`, `prompt.ts` and `compaction.ts`, `isDefaultTitle` in `packages/opencode/src/session/session.ts`, for the token counts `getUsage` there, `step-finish` and `cleanup` in `processor.ts`, `usage` in `packages/opencode/src/session/llm/ai-sdk.ts`, `Usage` in `packages/llm/src/schema/events.ts` and the version of `ai` and of each `@ai-sdk` package it pins, the program's name in `packages/opencode/script/build.ts`, for Needs you `packages/opencode/src/tool/question.ts` and `plan.ts`, `packages/opencode/src/question/index.ts`, `tool-call`, `completeToolCall`, `failToolCall` and `cleanup` in `processor.ts` and `packages/opencode/src/tool/registry.ts`, and, for Last message, `parts` and `page` in `packages/opencode/src/session/message-v2.ts`, `text-start` and `text-end` in `processor.ts`, `packages/opencode/src/session/revert.ts`, and "Copy last assistant message" and `messagesBeforeRevert` in `packages/tui/src/routes/session/index.tsx`. Then compare the dashboard with OpenCode's own list of sessions, with a turn running, waiting for approval, asking a question, stopped with Esc, ended on an error, and after OpenCode quits, and note what `ps -A -o comm=` prints for it, started each way it is installed. Compare Last message with what OpenCode shows of the newest reply, with one text part and with several, and after `/undo`, and the token counts as [Token counts](#token-counts) says.
