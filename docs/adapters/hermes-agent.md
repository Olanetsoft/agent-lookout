# Hermes Agent adapter notes

These notes record what Agent Lookout reads from Hermes Agent, where each value comes from, and what breaks when Hermes Agent changes. Start here when the adapter stops working.

The adapter was built from Hermes Agent's source at v0.22.5, published 2026-10-22 (commit `bf0203a` of [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)), and from its docs under `website/docs/` at that tag. It has not yet been checked on a computer running Hermes Agent. Hermes Agent was not installed or run where it was written, and nothing in Hermes Agent's own folders there was read. Everything below comes from the source and from databases written by hand with the same tables, so a status can be wrong. [Not yet checked](#not-yet-checked) lists what only a real install can answer. Paths in parentheses are Hermes Agent's files at that tag.

The code is in `src/collector/adapters/hermes-agent/`, and the status mapping is in `src/core/mapping/hermes-agent/hermesAgentMapping.ts`. The adapter starts the system's `sqlite3` with the helpers the OpenCode and Antigravity adapters use, in `src/collector/adapters/antigravity/app/summaries.ts`.

## How it reads Hermes Agent, and why

The adapter needs nothing installed and changes nothing, but for the one empty `-wal` [below](#how-sqlite3-opens-the-database): no plugin, no setting, no Hermes Agent program run, no network. It looks at each profile's database and the two files SQLite keeps beside it, reads the database's first 20 bytes when it changed, asks the system's `sqlite3` two fixed questions when the database or its `-wal` changed, and while a turn runs, checks the turn's process with signal 0.

Hermes Agent offers other ways in, and none of them can be used that way:

| Interface                                                   | Why it is not used                                                                                                                                   |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Any `hermes` command                                        | It runs Hermes Agent's own code, and a client can start the profile's gateway when none runs (`hermes_cli/gateway_client.py:262-289`)                |
| The gateway's WebSocket API (`/api/ws`)                     | It needs a ticket, and asking it is a request to Hermes Agent                                                                                        |
| `sessions/sessions.json` and `runtime/active_sessions.json` | Their gateway entries hold chat and user ids (`gateway/run_busy.py:326-333`, `gateway/config.py:586-602`)                                            |
| A plugin or an approval hook                                | It needs a change to Hermes Agent's config (`tools/approval_context.py:54-73`). Agent Lookout installs only its own Claude Code plugin               |
| `sessions/<id>.jsonl`                                       | Written only as a fallback, when `state.db` was replaced under a running Hermes Agent (`hermes_state.py:433-447`), and it holds a session's messages |

## Where it looks

- **The root.** `AGENT_LOOKOUT_HERMES_HOME` if set, and then Hermes Agent's own variable is not read. Otherwise Hermes Agent's own `HERMES_HOME`, by Hermes Agent's rule, when it is an absolute path once a leading `~` is the home folder: a folder in `~/.hermes`, or `~/.hermes` itself, has `~/.hermes` as its root; `<x>/profiles/<name>` has `<x>`; any other folder is its own root (`hermes_constants.py:93-100`, `296-309`). Otherwise `~/.hermes`. Hermes Agent follows links in `HERMES_HOME` to tell where it is; Agent Lookout does not, and other `$` variables in it are not filled in.
- **The profiles.** The default profile's database is `<root>/state.db`. A named profile's is `<root>/profiles/<name>/state.db` (`hermes_cli/profiles.py:283-293`, `433-445`; `hermes_state_sessions.py:338-353`). A name is taken when it matches `[a-z0-9][a-z0-9_-]{0,63}`, as Hermes Agent allows (`hermes_state_sessions.py:346`), and is not `default`, and when `lstat` says the entry is a folder, so a link is skipped. Deleted profiles leave a tombstone in `profiles/.deleted`, which the pattern never matches (`hermes_constants.py:312`). The first 16 names in order are read, and `profiles/` is listed at most once a minute. `active_profile`, which names the profile Hermes Agent starts in, is not read: every profile is.
- **Not read:** a home with `HERMES_DATA_DIR_SUFFIX`, which Hermes Agent's desktop channel builds bake into their own environment (`hermes_constants.py:51-58`; `website/docs/reference/environment-variables.md:894`), and Hermes Agent's Windows home, `%LOCALAPPDATA%\hermes`.

## What it reads

| What                                                   | How                                                                                                        | When                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The root folder                                        | One `stat`. Not done when `AGENT_LOOKOUT_HERMES_HOME` is set                                               | On the first poll, at most once a minute while it is missing, and on every poll while no profile has a database                                                                                     |
| `<root>/profiles/`                                     | `readdir` of the names, then `lstat` of each that matches the pattern                                      | At most once a minute                                                                                                                                                                               |
| `state.db`, `state.db-wal`, `state.db-shm` of each one | `lstat`. Each must be an ordinary file. An empty `state.db` is taken as none                               | Every poll                                                                                                                                                                                          |
| The first 20 bytes of each `state.db`                  | One read-only `open`, a read and a close, in Agent Lookout's own process, of the file `lstat` saw          | When `state.db` changed since the header was last read                                                                                                                                              |
| Each `state.db`                                        | `sqlite3`, with the probe and the sessions query below                                                     | When the database or its `-wal` changed since the last read, by identity, size or modified time, or the `-wal` came or went. After a read that did not work, on the next change or 10 seconds later |
| Each `sqlite3` at the fixed places                     | `<path> -init /dev/null --version`, so the person's own `~/.sqliterc` is not run first                     | Before it is first chosen for a live `-wal`, and again once the program at that place changes                                                                                                       |
| A live turn lease's process                            | Signal 0, which asks the system whether it exists and sends it nothing (`src/collector/processes/pids.ts`) | Every poll, only for leases that have not run out                                                                                                                                                   |
| Agent Lookout's own `/proc/self/ns/pid`, on Linux only | `readlink`                                                                                                 | The first time a lease is live, and again only after a read that failed, to compare with the lease's `pidns=`                                                                                       |

Hermes Agent reads the same 20 bytes itself: its `hermes sessions` journal-mode command opens the file plainly and reads bytes 18 and 19, which are 1 and 1 in rollback-journal mode and 2 and 2 in WAL mode (`hermes_cli/sessions_cmd_journal_mode.py:16-27`; also `hermes_cli/doctor_platform.py:78-91`). Hermes Agent allows such a plain read only in a process that holds no SQLite connection, because closing any file a process has open lets go of that process's own locks on it (`hermes_cli/sqlite_safe_read.py:1-6`). Agent Lookout's process never holds a SQLite connection: only the `sqlite3` it starts does. So its open and close cannot let go of a lock Hermes Agent holds.

The adapter's own code opens nothing else of Hermes Agent's. Only `sqlite3` opens the databases, their `-wal` and `-shm`, and a `state.db-journal` that a write left unfinished, and only as the next section says. Nothing is read on Windows.

## How sqlite3 opens the database

`sqlite3` is found and started as for OpenCode and Antigravity: never on `PATH`, directly with no shell, with stdin closed, only `PATH=/usr/bin:/bin` and `LC_ALL=C` in its environment, a 5-second timeout and at most 4 MiB of output. The fixed places are tried in this order: `/usr/bin/sqlite3`, `/bin/sqlite3`, `/opt/homebrew/bin/sqlite3`, `/usr/local/bin/sqlite3`, `/opt/local/bin/sqlite3`, and for Hermes Agent alone, `/opt/homebrew/opt/sqlite/bin/sqlite3` and `/usr/local/opt/sqlite/bin/sqlite3`, where Homebrew keeps its own `sqlite3` without linking it, since macOS has one. Its arguments are `-init /dev/null -batch -json`, in rollback-journal mode `-cmd ".timeout 1000"`, the database's address and one fixed question.

Hermes Agent does not always keep its database in WAL mode. It never switches one to WAL mode while its own Python's SQLite has the WAL-reset bug below, and keeps such a database in rollback-journal (`DELETE`) mode; it never switches one back once it is in WAL mode (`hermes_state_wal.py:254-341`, `450-485`). `DELETE` mode is also set by `database.journal_mode: delete` (`hermes_state_wal.py:157-167`), on virtiofs and 9p mounts such as Docker's and OrbStack's (`:184`, `:327-335`), and on a disk that refuses WAL mode (`:24-29`). So the address follows the header's bytes and the files beside the database:

| State of `state.db` and the files beside it                  | Address                                                        | Why                                                                                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header 1/1 (rollback journal), no `-wal`                     | `file:<database>?mode=ro&readonly_shm=1`, with `.timeout 1000` | Hermes Agent writes pages straight into `state.db`, so `immutable=1` could read a commit half-written. A shared lock waits a commit out, for up to a second |
| Header 2/2 (WAL), no `-wal` or an empty one                  | `file:<database>?mode=ro&immutable=1`                          | Nothing is in a `-wal`, so the file is whole. `immutable=1` takes no lock and makes no file                                                                 |
| Header 2/2, a `-wal` that holds something, and `-shm`        | `file:<database>?mode=ro&readonly_shm=1`                       | It reads Hermes Agent's newest commits and opens the `-shm` read-only, so nothing is written to either. Only with a `sqlite3` that passes the test below    |
| Header 2/2, a `-wal` that holds something, no `-shm`         | Not read                                                       | Reading it would make a `-shm`. The card says so                                                                                                            |
| Either sidecar not an ordinary file                          | Not read                                                       | The card says so                                                                                                                                            |
| A `-wal` beside a header of 1/1, or a header that is neither | Not read                                                       | SQLite opens a database in WAL mode whenever a `-wal` is beside it, whatever its header says. The card says `sqlite3` could not read it                     |

`readonly_shm=1` changes nothing for a rollback-journal database, which has no `-shm`. It is there in case Hermes Agent switches the database to WAL mode between the read of its header and the open: a reader without it would open the `-shm` to read and write and write a mark in it.

`-cmd ".timeout 1000"` is new beside OpenCode's arguments. A WAL reader does not wait on writers, but a rollback-journal reader does: Hermes Agent raised its own read wait to 5 seconds after "database is locked" failures (`hermes_state.py:192-197`). Its writers wait up to 20 seconds, transcript writes up to 60, and activity writes half a second before they skip (`hermes_state.py:486`). So a read of a few milliseconds costs at most one skipped activity write, which Hermes Agent makes again in its next minute. A read that ends in "disk I/O error" or "database is locked" does not work, and is tried again 10 seconds later. Hermes Agent itself retries the first for its own read-only opens while a checkpoint runs (`hermes_state.py:185-192`).

Opened without `immutable=1`, `sqlite3` also looks for a `state.db-journal` beside the database, as any SQLite program does (`hasHotJournal` in `src/pager.c`). In rollback-journal mode Hermes Agent writes one for each write and deletes it when the write ends, so one stays only when a write did not finish, such as when Hermes Agent was killed in the middle of it. When no write holds the database, `sqlite3` opens that journal read-only to see whether it holds a write to undo. With `mode=ro` it never undoes it or writes to it: when the journal holds a write to undo, `sqlite3` stops with "attempt to write a readonly database", and the profile is not read until Hermes Agent opens the database again and undoes the write itself.

### The WAL-reset test

A database in WAL mode whose `-wal` holds something is read only with a `sqlite3` that passes Hermes Agent's own test for SQLite's WAL-reset bug, copied exactly (`is_sqlite_wal_reset_vulnerable` in `hermes_cli/sqlite_runtime.py:23-30`; the same rule at `hermes_state_wal.py:131-134`). It counts SQLite from 3.7.0 up to, not including, 3.51.3 as having the bug, except 3.44.6 and the later 3.44 releases, and 3.50.7 and the later 3.50 releases.

Hermes Agent refuses a `sqlite3` with the bug even to salvage a copy of a database: such a program opening a live database can delete its `-wal` and `-shm` and split it in two, losing writes Hermes Agent had already confirmed. It adds that Debian's and Ubuntu's `sqlite3` are often in that range, 3.45.1 for one (`hermes_cli/session_lost_and_found.py:73-95`). Its source does not say whether a `mode=ro&readonly_shm=1` reader can cause the split, so the adapter follows Hermes Agent.

So for a live `-wal`, each fixed place is asked `-init /dev/null --version`, once, and again only when the program there changes by identity, size or modified time, and the first that passes is used. One whose answer cannot be read fails the test. When none passes, the profile is not read, and the card names the first `sqlite3` found and its version, and says to install 3.51.3 or newer: on a Mac with `brew install sqlite`, which the two Homebrew places above find, and elsewhere at `/usr/local/bin/sqlite3`, such as sqlite.org's precompiled tools. macOS's own `/usr/bin/sqlite3`, 3.51.0 at the time of writing, fails the test. A rollback-journal database, or a WAL database with no `-wal` to read, is read with the first `sqlite3` found: the bug is in WAL mode alone.

### What a read can leave behind

`tests/integration/collector/adapters/hermes-agent/database.test.ts` runs the real `sqlite3` on databases written by hand with Hermes Agent's tables: one in rollback-journal mode, one in WAL mode with no `-wal`, and one whose commits lie only in the `-wal` of a second `sqlite3` that keeps it open, as Hermes Agent would. It checks the rows read, and that no byte, size or modified time of the database, its `-wal` or its `-shm` changes. It has not been run against Hermes Agent itself. The same file kills a write in the middle of a rollback-journal database, which leaves a `state.db-journal` with a write to undo, and checks that the read fails, is tried again 10 seconds later, and changes no byte, size or modified time of the database or the journal, and that the database is read as it was before the write once a `sqlite3` that may write opens it.

If a program closes the database between the `lstat` and the read, and SQLite removes the `-wal` and `-shm` as it does then, a `sqlite3` built from SQLite's own source, as on Linux, makes an empty `state.db-wal` in Hermes Agent's folder as it opens the database (`sqlite3WalOpen` in `src/wal.c`), and that read does not work. SQLite has no setting that stops it. The next read opens the database as a file nothing changes. `/usr/bin/sqlite3` on macOS was seen to make none. This is the same case as OpenCode's, and #148 decides it for both.

## The two questions

Both are fixed text. Nothing from a file, a request or a setting is put into them, and every cut-off is worked out inside SQLite. They follow Hermes Agent's own advice to tell its versions apart by their columns, "never by this number" (`hermes_state_common.py:284-289`): `schema_version` is not read.

The probe asks for the names of three tables and of their columns alone:

```sql
SELECT 'table' AS kind, name FROM sqlite_master
  WHERE type = 'table' AND name IN ('sessions', 'messages', 'session_turn_leases')
UNION ALL SELECT 'sessions', name FROM pragma_table_info('sessions')
UNION ALL SELECT 'messages', name FROM pragma_table_info('messages')
UNION ALL SELECT 'session_turn_leases', name FROM pragma_table_info('session_turn_leases')
```

The sessions query is asked only when the probe finds the three tables, with `id`, `source`, `created_source`, `parent_session_id`, `started_at`, `ended_at`, `end_reason`, `cwd`, `title`, `model_config`, `session_key`, `archived`, `hidden`, `last_activity_at` and `last_activity_description` in `sessions`; `id`, `session_id`, `role`, `timestamp`, `active`, `display_kind`, `display_metadata`, `finish_reason`, `tool_calls` and `tool_call_id` in `messages`; and `conversation_id`, `holder`, `acquired_at` and `expires_at` in `session_turn_leases`. `created_source` first ships in Hermes Agent v0.21.6, published 2026-10-08, so that is the oldest version read. An older database makes the card say it is laid out as a version Agent Lookout does not read.

```sql
WITH RECURSIVE
cut(t) AS (SELECT CAST(strftime('%s', 'now') AS REAL) - 172800),
recent(id) AS (
  SELECT s.id FROM sessions s, cut
  WHERE max(s.started_at, coalesce(s.ended_at, 0), coalesce(s.last_activity_at, 0)) >= cut.t
    OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id AND m.timestamp >= cut.t)
),
up(id, root, depth) AS (
  SELECT id, id, 0 FROM recent
  UNION ALL
  SELECT up.id, p.id, up.depth + 1
  FROM up
  JOIN sessions c ON c.id = up.root
  JOIN sessions p ON p.id = c.parent_session_id
  WHERE up.depth < 64
    AND p.end_reason = 'compression'
    AND (CASE WHEN json_valid(c.model_config) THEN json_extract(c.model_config, '$._branched_from') END) IS NULL
    AND (CASE WHEN json_valid(c.model_config) THEN json_extract(c.model_config, '$._delegate_from') END) IS NULL
    AND (CASE WHEN json_valid(c.model_config) THEN json_extract(c.model_config, '$._reset_from') END) IS NULL
    AND coalesce(c.source, '') != 'tool'
),
heads(id, root, depth) AS (SELECT id, root, max(depth) FROM up GROUP BY id)
SELECT h.root AS root_id, c.id,
  r.source AS root_source, r.created_source AS root_created_source, r.started_at AS root_started_at,
  substr(r.title, 1, 1000) AS root_title, substr(r.cwd, 1, 4097) AS root_cwd,
  c.started_at, c.ended_at, c.end_reason, c.last_activity_at,
  (SELECT max(m.timestamp) FROM messages m WHERE m.session_id = c.id) AS last_message_at,
  substr(c.title, 1, 1000) AS title, substr(c.cwd, 1, 4097) AS cwd,
  c.last_activity_description LIKE 'waiting for user approval%' AS approval_label,
  c.last_activity_description LIKE 'waiting for user clarify response%' AS question_label,
  n.role AS n_role, n.timestamp AS n_at, n.display_kind AS n_kind, n.finish_reason AS n_finish,
  CASE WHEN json_valid(n.display_metadata) THEN json_type(n.display_metadata, '$.error') IS NOT NULL END AS n_error,
  a.timestamp AS calls_at,
  (SELECT count(*) FROM json_each(CASE WHEN json_valid(a.tool_calls) THEN a.tool_calls ELSE '[]' END) q
    WHERE json_extract(q.value, '$.function.name') = 'clarify'
    AND NOT EXISTS (SELECT 1 FROM messages x WHERE x.session_id = c.id AND x.role = 'tool' AND x.id > a.id
      AND x.tool_call_id = json_extract(q.value, '$.id'))) AS open_questions,
  (SELECT count(*) FROM json_each(CASE WHEN json_valid(a.tool_calls) THEN a.tool_calls ELSE '[]' END) q
    WHERE NOT EXISTS (SELECT 1 FROM messages x WHERE x.session_id = c.id AND x.role = 'tool' AND x.id > a.id
      AND x.tool_call_id = json_extract(q.value, '$.id'))) AS open_calls,
  l.acquired_at AS lease_at, l.expires_at AS lease_until,
  CASE WHEN l.holder GLOB 'pid=[0-9]*' THEN CAST(substr(l.holder, 5) AS INTEGER) END AS lease_pid,
  CASE WHEN instr(l.holder, ':pidns=') > 0 THEN CAST(substr(l.holder, instr(l.holder, ':pidns=') + 7) AS INTEGER) END AS lease_pidns
FROM heads h
JOIN sessions c ON c.id = h.id
JOIN sessions r ON r.id = h.root
LEFT JOIN messages n ON n.id = (SELECT x.id FROM messages x WHERE x.session_id = c.id AND x.active = 1
  AND x.role NOT IN ('session_meta', 'system') ORDER BY x.id DESC LIMIT 1)
LEFT JOIN messages a ON a.id = (SELECT x.id FROM messages x WHERE x.session_id = c.id AND x.active = 1
  AND x.role = 'assistant' AND x.tool_calls IS NOT NULL ORDER BY x.id DESC LIMIT 1)
LEFT JOIN session_turn_leases l ON l.conversation_id = h.root
WHERE (r.parent_session_id IS NULL
    OR (CASE WHEN json_valid(r.model_config) THEN json_extract(r.model_config, '$._branched_from') END) IS NOT NULL
    OR EXISTS (SELECT 1 FROM sessions p WHERE p.id = r.parent_session_id
      AND p.end_reason = 'branched' AND r.started_at >= p.ended_at)
    OR (CASE WHEN json_valid(r.model_config) THEN json_extract(r.model_config, '$._reset_from') END) IS NOT NULL
    OR EXISTS (SELECT 1 FROM sessions p WHERE p.id = r.parent_session_id
      AND p.end_reason IN ('session_reset', 'session_switch', 'idle', 'daily', 'suspended', 'resume_pending_expired')
      AND r.session_key IS NOT NULL AND r.session_key != '' AND r.session_key = p.session_key))
  AND (CASE WHEN json_valid(r.model_config) THEN json_extract(r.model_config, '$._delegate_from') END) IS NULL
  AND r.archived = 0 AND r.hidden = 0
  AND coalesce(r.source, '') NOT IN ('kanban', 'tool', 'oneshot')
ORDER BY max(c.started_at, coalesce(c.ended_at, 0), coalesce(c.last_activity_at, 0)) DESC, c.id DESC
LIMIT 500
```

The tables and columns are those of `SCHEMA_SQL` (`hermes_state_common.py:451-770`: `sessions` at 461-529, `messages` at 531-562, `session_turn_leases` at 711-716). Every time is a count of seconds, with a fraction (`hermes_state_common.py:258-283`), and is kept in milliseconds.

| Field                                                      | Holds, and where it comes from                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `root_id`, `id`                                            | The conversation's root, and the row's own id. A row whose id does not match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, which covers every shape Hermes Agent mints (`hermes_state_ids.py:15-60`), is dropped                                                                                                                               |
| `up` and `heads`                                           | Each row followed back to its root through the rows Hermes Agent starts when it compresses a conversation, as `_CHAIN_STEP_SQL` follows them (`hermes_state_compression.py:30-50`, `466-470`)                                                                                                                                          |
| `root_source`, `root_created_source`                       | Where the conversation came from: `cli`, `tui`, `desktop`, a chat platform, `cron`, and so on, and for a `local` row the surface that made it (`gateway/session_policy.py:85-103`; `agent/session_source.py:11-23`)                                                                                                                    |
| `root_started_at`                                          | When the conversation began. Hermes Agent lists a chain under its root, with the root's start (`hermes_state_sessions.py:1117-1160`)                                                                                                                                                                                                   |
| `root_title`, `title`, `root_cwd`, `cwd`                   | The root's and the row's title and folder. A title is cut to 1,000 characters; Hermes Agent caps one at 100 (`hermes_state.py:1609`)                                                                                                                                                                                                   |
| `started_at`, `ended_at`, `end_reason`, `last_activity_at` | The row's start, Hermes Agent's end stamp and why it ended (`hermes_state_sessions.py:475-481`), and its last activity, which lags by up to a minute (`agent/session_activity.py:21`)                                                                                                                                                  |
| `last_message_at`                                          | When the row's newest message was written                                                                                                                                                                                                                                                                                              |
| `approval_label`, `question_label`                         | 1 when `last_activity_description` begins `waiting for user approval` or `waiting for user clarify response` (`tools/approval_gateway_wait.py:61`, `tools/clarify_gateway.py:91`, built at `tools/environments/base.py:172-183`). The label itself is never printed                                                                    |
| `n_role`, `n_at`, `n_kind`, `n_finish`                     | The newest row of the conversation that is `active` and not `session_meta` or `system`, as `latest_conversation_role` takes it (`hermes_state_messages.py:609-616`): its role, time, `display_kind` and `finish_reason`                                                                                                                |
| `n_error`                                                  | 1 when that row's `display_metadata` has an `error` key, which Hermes Agent writes on a failed turn (`agent/conversation_loop.py:1848-1864`, `1889-1933`). Its value is never printed                                                                                                                                                  |
| `calls_at`, `open_questions`, `open_calls`                 | When the newest assistant row with tool calls was written, how many of its calls are to `clarify` with no `tool` row answering them yet, and how many of its calls, to any tool, have none (`tools/clarify_tool.py:137`, `195`; `agent/turn_tool_round.py:131-133`; `agent/tool_executor.py:200-211`). No call's arguments are printed |
| `lease_at`, `lease_until`, `lease_pid`, `lease_pidns`      | The turn lease on the root: when the turn began, when the lease runs out, and its holder's pid and pid namespace, cut from `pid=<n>[:pidns=<id>]:turn=<id>:platform=<p>` inside SQLite (`hermes_state_compression.py:683-707`; `agent/turn_facade_lease.py:321-324`)                                                                   |

The JSON markers in `model_config` are tested as Hermes Agent tests them (`_sql_json_extract`, `hermes_state_common.py:84-91`), and `session_key` is only compared with the parent's, for Hermes Agent's older reset rule. Nothing of either is printed. A role, kind, reason or source longer than 64 characters, or with a control character in it, is kept as a field of the wrong type, so no long text is kept. A folder is kept when it is an absolute path of at most 4,096 characters with no control or format character.

## Which sessions are listed

- **One row per conversation.** The rows of a compression chain share a root and are one session. Its id is the root's, its start is the root's, and its title, folder and status come from the tip: the row that did not end with `compression`, an open one before an ended one, then the one written most recently, in the order of `_CHAIN_STEP_SQL` (`hermes_state_compression.py:40-48`). When every row ended with `compression`, the one written most recently is the tip.
- **Roots, as Hermes Agent lists them.** A row with no parent, a branch, or a reset child (`_LISTABLE_CHILD_SQL`, `_BRANCH_CHILD_SQL`, `_RESET_CHILD_SQL` and `_RESET_END_REASONS`, `hermes_state_common.py:171-179`, `214-243`). Hermes Agent treats a branch or a reset child as a conversation of its own (`hermes_state_sessions.py:118-135`). Scheduled runs and chats from messaging apps are listed.
- **Not listed:** a subagent's run, with a `_delegate_from` marker; an archived or hidden row (`hermes_state_sessions.py:118-152`, `1371-1372`); and the sources Hermes Agent hides from people, `kanban`, `tool` and `oneshot` (`INTERNAL_LISTING_SOURCES`, `hermes_state_sessions.py:239`, as `hermes_cli/console_engine.py:600-603` uses it). `hermes sessions list` hides only `tool` (`hermes_cli/sessions_cmd.py:276-278`).
- **The window.** A row whose own times or messages fall in the last 48 hours, by SQLite's clock, up to the newest 500 rows. Then each session for 24 hours after the newest time of its rows. A time ahead of the clock counts as it is, so a clock set back hides no session.
- **Not folded as Hermes Agent folds them.** Hermes Agent folds a local session's earlier reset segments into one, using receipts in `state_meta` (`hermes_state_local.py:231-239`). The adapter does not read `state_meta`, so an earlier segment shows as a finished session of its own.

A session's id in Agent Lookout is `hermes-agent:<profile>/<root id>`, where the profile is `default` or the profile's name. `default` can never be a named profile's name (`hermes_cli/profiles.py:433-437`), and the `/` keeps a second colon out of the id.

## Working, needs you and the turn lease

- **The lease brackets a turn.** Hermes Agent takes it before a turn starts and lets it go in the turn's `finally` (`agent/turn_facade.py:83`, `199-203`; `hermes_state_compression.py:717-740`, `831-840`). It runs out 300 seconds after it was last written and is renewed every 60 (`agent/turn_facade_lease.py:26`, `52`); a renewal moves only `expires_at` (`hermes_state_compression.py:815-830`). Hermes Agent itself takes a live lease for a running turn (`hermes_state_local_migration.py:77-79`). A turn whose agent has no database takes none (`agent/turn_facade_lease.py:307-308`).
- **Live.** A lease is live while `expires_at` is after Agent Lookout's clock, which is Hermes Agent's on the same machine, and its process was not found gone. This is judged on every poll from the rows already read, so a lease that runs out with no file changed ends Working.
- **The process.** At v0.22.5 `hermes chat` runs its turns in the profile's gateway: the CLI process builds no agent and writes no `state.db` (`hermes_cli/gateway_agent.py:1-6`; `hermes_cli/main.py:1682-1689`). TUI, desktop and ACP sessions go through the same gateway (`website/docs/developer-guide/gateway-local-sessions.md:66-80`). So a lease's `pid=` is mostly the gateway's. Each live lease's pid is checked with signal 0, by Hermes Agent's own strict rule for leases (`holder_pid_checkable`, `hermes_state_pidns.py:95-116`): where there are no pid namespaces, as on macOS, which writes no `pidns` (`:51-53`), the pid is checked; on Linux, only when the holder names Agent Lookout's own pid namespace. A holder that names another, such as Hermes Agent in a container sharing the folder, or none, is not checked, and its lease's expiry is trusted, as it is while Agent Lookout's own namespace cannot be read. A dead pid means the lease is not live, so a gateway killed mid-turn shows as idle at once rather than working for up to 300 seconds.
- **A question.** A `clarify` call with no result while the lease is live is a question that waits, on any surface, when the call is the running turn's: written no earlier than the lease's `acquired_at`. The call's row is saved before the tool runs, and its result after the tool ends. A call an earlier turn left with no result is no wait: Hermes Agent keeps such a call in the database when its gateway is killed while it asks, and deals with it only in what it sends the model next (`strip_dangling_tool_call_tail`, `agent/replay_cleanup.py:120-144`).
- **An approval.** Pending approvals and questions are kept only in Hermes Agent's memory (`tools/approval.py:51-58`; `tools/clarify_gateway.py:30-34`). The only trace is the activity label, which the gateway's wait touches every 10 seconds as `waiting for user approval (Ns elapsed)` (`tools/approval_gateway_wait.py:61-75`; `tools/approval_human_wait.py:95-105`), and which Hermes Agent saves at most once a minute (`agent/session_activity.py:21`; `agent/activity_tracking.py:91-121`). So it shows 10 to 70 seconds after the prompt, and can outlast the answer by up to a minute while the approved tool runs. It is cleared when the turn ends (`agent/activity_tracking.py:123-149`; `agent/turn_facade.py:204-207`). Hermes Agent writes `last_activity_at` only together with the label, as the time of the touch that wrote it (`hermes_state_sessions.py:628-651`; `hermes_state_worker_lifecycle.py:121-122`). So the label counts only while it was saved no earlier than the running turn's newest tool call, and one of that call's tools has no result yet. A label that outlasts its approval is then never put on the model's next tool call, which would be announced as a new wait. The classic CLI's turns run in the gateway at v0.22.5, so its approvals take this path. The in-process prompt, which writes no label (`tools/approval.py:905-916`), is reached only by an agent that runs inside a CLI process; no path to it from `hermes chat` was found.
- **When.** A wait's time is the tool call's row, which stays the same while the wait lasts, so one wait is never announced twice. Working's time is the lease's `acquired_at`, the turn's start.

## Status

Checked in this order, from the tip and the root's lease:

| Condition                                                                                                                                      | Status                 | Since                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------ |
| A field of the wrong type, or a newest row whose role is not `user`, `assistant` or `tool`                                                     | Unknown                | None                                 |
| Live lease, and a `clarify` call of the turn with no result                                                                                    | Needs you (question)   | The tool call's row                  |
| Live lease, and the approval label, saved since the turn's newest tool call, while a tool of that call has no result                           | Needs you (permission) | The tool call's row                  |
| Live lease, and the question label, likewise                                                                                                   | Needs you (question)   | The tool call's row                  |
| Live lease                                                                                                                                     | Working                | The lease's `acquired_at`            |
| Newest row is `assistant` with `display_kind` `failed_turn` and an `error`, or a `finish_reason` of `error`, `agent_error` or `content_filter` | Failed                 | The newest row                       |
| `ended_at` is set                                                                                                                              | Finished               | `ended_at`                           |
| Anything else, or no newest row                                                                                                                | Idle                   | The newest row, else the newest time |

- **Failed.** Hermes Agent closes a failed turn with an assistant row whose `display_kind` is `failed_turn` (`agent/turn_failure_copy.py:58`), with the error in `display_metadata`. The `finish_reason` values are those Hermes Agent counts as errors (`hermes_state_sessions.py:247-258`). An interrupt before any text gets the same row, usually with no `error`, so it shows as idle. A reply stopped after some text is marked `interrupted` (`agent/turn_api_call.py:207-210`) and shows as idle. A failed session stays failed once it is ended.
- **Finished.** Hermes Agent stamps a session it ends with `ended_at` and `end_reason`, and the first reason stands (`hermes_state_sessions.py:475-481`); `reopen_session` clears it (`:517`). The interactive CLI ends its session with `cli_close` on a normal quit, on Ctrl+C and on SIGTERM or SIGHUP (`hermes_cli/cli_tui_runtime_mixin.py:538-545`; `cli.py:506-511`), through the gateway at v0.22.5 (`hermes_cli/cli_shutdown.py:159-163`). `kill -9` cannot be caught (`cli.py:511`). A chat from a messaging app stays open between messages until a reset ends it (`hermes_state_common.py:179`). `compression` is a step on, not an end, and the tip is never a row that ended with it unless every row did.
- **Idle against finished.** Neither the database nor anything the adapter reads says whether an open session's CLI or gateway still runs. The gateway writes no heartbeat row; only `tui_gateway` does (`tui_gateway/session_reaper.py:470`). Hermes Agent closes orphaned rows through the TUI gateway's startup sweep, of `tui`, `desktop`, `subagent` and `unknown` rows (`:392`, `425-427`), and through its auto-maintenance, which is off unless `sessions.auto_prune` is set (`hermes_state_maintenance.py:478-535`; `hermes_cli/config_defaults.py:2286-2288`). So a session left open by a killed process shows as idle, and as stale after a day.

## Names, folders and apps

- **Name:** the tip's title, else the root's, cleaned and cut as every agent's is. Hermes Agent's own list does the same, since a title moves from the root to the tip after a compression (`hermes_state_sessions.py:1146-1151`). Without a title, the folder's name, then the session's id. A title can be the model's, or made from the first message (`hermes_state_common.py:21-24`; `hermes_state.py:1609-1616`), so it can echo what was first asked.
- **Folder:** the tip's `cwd`, else the root's. It is set for local CLI runs (`run_agent.py:43-54`), and for a gateway session from the folder the client sends when it makes it (`hermes_state_local.py:66-71`, `127-136`). A child with no `cwd` takes its parent's (`hermes_state_sessions.py:355-358`). A chat from a messaging app has none.
- **App:** the terminal for `cli` and `tui`, and for `local` made by either; the desktop app for `desktop`, and for `local` made by it. Hermes Agent keeps its gateway's `cli`, `tui`, `gui` and `acp` sessions as `local`, with the surface in `created_source` (`gateway/session_policy.py:85-103`). Anything else, such as `acp`, a messaging platform, `api_server`, `webhook` or `cron`, is not known.
- **None of these:** a process ID, a link, Jump, Stop, Answer, token counts or `lastWriteAt`.

## Known gaps

- A session whose CLI or gateway was killed without closing stays idle, and is stale after a day.
- A wait for an approval shows 10 to 70 seconds late, and can stay up to a minute after it is answered.
- A turn whose context overflows writes no closing row (`agent/conversation_loop.py:1909-1913`), so it shows as idle, not failed.
- A remote gateway's sessions (`HERMES_TUI_GATEWAY_URL`) live in that machine's database, which Agent Lookout reads only by running there itself.
- A home with `HERMES_DATA_DIR_SUFFIX` is not read.
- Earlier reset segments of a local session are not folded into it.
- `kanban`, `tool` and `oneshot` sessions, and subagent runs, are not listed.
- Nothing is read on Windows, where Agent Lookout never runs `sqlite3`. A Hermes Agent inside WSL is not seen from Windows; an Agent Lookout inside WSL reads WSL's own `~/.hermes` as on Linux.
- A WAL database with a live `-wal` is not read when every `sqlite3` found has the WAL-reset bug, as Ubuntu's and Debian's often do. Docker and OrbStack mounts keep the database in rollback-journal mode, which any `sqlite3` reads.
- A database in rollback-journal mode is not read while a `state.db-journal` that a write left unfinished holds a write to undo. It is read again once Hermes Agent opens the database and undoes the write.
- Quiet for is never shown: every session of a profile is in one file.
- No token counts yet. Hermes Agent stores a session's totals, not its newest reply's request.
- Hermes Agent older than v0.21.6 is not read.

## What it never reads

- **Files and folders in the root and each profile's folder:** `.env`, `auth.json`, `config.yaml`, which can hold endpoint keys (`hermes_cli/config.py:760-767`), every OAuth or token file, `memories/` (`MEMORY.md`, `USER.md`), `SOUL.md`, `sessions/` and everything in it, `sessions.json` among it, `runtime/active_sessions.json`, `gateway.pid`, `gateway_state.json`, `logs/`, `checkpoints/`, `cron/`, `kanban.db`, `active_profile`, and any other file. The adapter's own code opens only the first 20 bytes of each `state.db`, and only `sqlite3` opens `state.db`, its `-wal` and `-shm`, and a `state.db-journal` that a write left unfinished. A session's own folder is looked in for a git repository, as every session's is, as [PRIVACY.md](../../PRIVACY.md#git-repositories) describes.
- **Tables:** every one but `sessions`, `messages` and `session_turn_leases`, beyond the names in `sqlite_master` and of their columns. So never `system_prompts`, `session_admissions`, `worker_executions`, `worker_receipts`, `async_delegations`, `gateway_routing`, `gateway_heartbeats`, `state_meta`, `session_model_usage`, `compression_locks`, `conversation_generations`, any `messages_fts` table, or the Telegram topic tables.
- **Columns of `sessions`:** never `system_prompt`, `system_prompt_hash`, `model_config`, `user_id`, `chat_id`, `chat_type`, `thread_id`, `display_name`, `origin_json`, `session_key`, `model`, `billing_*`, the cost and token columns, `handoff_*`, `compression_*`, `git_*`, `last_activity_description`, `last_activity_provenance`, `tool_names` or `title_source`. Of those, three keys of `model_config`, `session_key` and two prefixes of `last_activity_description` are tested inside SQLite, and print 0, 1 or nothing.
- **Columns of `messages`:** never `content`, `api_content`, `reasoning*`, `codex_*`, `tool_calls`, `tool_name`, `display_metadata` or `display_identity`. How many calls in `tool_calls` have no answer, and how many of those are to `clarify`, and whether `display_metadata` has an `error` key, are tested inside SQLite, and nothing of their text is printed.
- **Programs:** no `hermes` command, no request to Hermes Agent's gateway, no `ps` and no git command.

## Not yet checked

Each of these needs a computer running Hermes Agent. Tick one off with the version it was checked on.

- [ ] The journal mode a fresh install has, and which SQLite its Python links, which decide how often the WAL-reset test stops a read.
- [ ] That a terminal `hermes` session's row reads `source = 'local'` with `created_source = 'cli'`, holds the terminal's folder in `cwd`, and gets a title.
- [ ] That a lease's `pid=` is the gateway's for CLI, TUI and desktop turns, and that a killed gateway's lease is swept or simply runs out.
- [ ] How late the approval label shows and how long it stays, on a command that waits, and whether an approval through a plugin (`tools/approval.py:835-848`) writes any label.
- [ ] That a tool call's row is always written after its turn took the lease, and the label's `last_activity_at` after the call, which is how a wait is placed in its turn.
- [ ] That a pending `clarify` shows at once in the CLI, the TUI and a messaging chat.
- [ ] What `end_reason` closing a terminal leaves, and whether a CLI killed with `kill -9` leaves its session open while the gateway idles out.
- [ ] Whether a `-wal` is left after every Hermes Agent process exits.
- [ ] That a read with `readonly_shm=1` leaves every byte of a live Hermes Agent database as it was. The integration test stands in for Hermes Agent with `sqlite3`.
- [ ] Whether a branched session's compression chain gives the lease's root and the adapter's root the same id: the lease's walk binds markers to the parent (`hermes_state_messages.py:1878-1897`), while lists test them by presence (`hermes_state_compression.py:36-37`).
- [ ] Whether a provider's error always carries the `error` key, and which `finish_reason` values appear.
- [ ] Whether each named profile runs its own gateway, and whether every profile's sessions appear.
- [ ] On Linux, the `pidns` stamps with Hermes Agent in a container and Agent Lookout on the host.
- [ ] Whether macOS's `/usr/bin/sqlite3` 3.51.0 carries Apple's own fix for the WAL-reset bug. The test refuses it either way.

## What breaks when Hermes Agent changes

| Change in Hermes Agent                                                                  | What the dashboard shows                                                        | Where to fix it                                       |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A column the probe asks for is renamed or dropped                                       | The card says the database is from a version Agent Lookout does not read        | `sessionRows.ts`                                      |
| The lease table, or its holder's form, changes (`agent/turn_facade_lease.py:321-324`)   | Running turns show as idle, or a dead process's turn as working                 | `sessionRows.ts`, `processes.ts`                      |
| The waiting label's words change (`tools/approval_gateway_wait.py:61`)                  | A session waiting for approval shows as working                                 | `sessionRows.ts`                                      |
| `last_activity_at` is written apart from the label (`hermes_state_sessions.py:628-651`) | A session waiting for approval shows as working, or an old label as a new wait  | `src/core/mapping/hermes-agent/hermesAgentMapping.ts` |
| `failed_turn` is renamed (`agent/turn_failure_copy.py:58`)                              | A failed turn shows as idle                                                     | `src/core/mapping/hermes-agent/hermesAgentMapping.ts` |
| A new kind of child is listed as a conversation (`hermes_state_common.py:171-243`)      | Its sessions do not show                                                        | `sessionRows.ts`                                      |
| A new source is hidden from people (`hermes_state_sessions.py:239`)                     | Its sessions show                                                               | `sessionRows.ts`                                      |
| The home or root rule changes (`hermes_constants.py`)                                   | Hermes Agent is not found, or found with no database                            | `home.ts`                                             |
| `clarify` is renamed (`tools/clarify_tool.py:137`)                                      | A session asking a question shows as working                                    | `sessionRows.ts`                                      |
| A new role for a conversation's rows                                                    | Sessions that end on it show as unknown                                         | `src/core/mapping/hermes-agent/hermesAgentMapping.ts` |
| The WAL-reset range changes (`hermes_cli/sqlite_runtime.py:23-30`)                      | A live `-wal` is read, or refused, by a `sqlite3` Hermes Agent judges otherwise | `sqlite.ts`                                           |

To check a new Hermes Agent version, read at its tag `SCHEMA_SQL` in `hermes_state_common.py` and its listing rules there, `hermes_state_compression.py`, `hermes_state_sessions.py`, `hermes_state_messages.py`, `hermes_state_pidns.py`, `hermes_state_wal.py`, `hermes_constants.py`, `hermes_cli/profiles.py`, `hermes_cli/sqlite_runtime.py`, `agent/turn_facade_lease.py`, `agent/turn_failure_copy.py`, `agent/activity_tracking.py`, `tools/approval_gateway_wait.py`, `tools/clarify_gateway.py` and `tools/clarify_tool.py`. Then compare the dashboard with `hermes sessions list` and the gateway's own view, with a turn running, asking a question, waiting for an approval, stopped with Ctrl+C, ended on an error, and after the CLI and the gateway quit.
