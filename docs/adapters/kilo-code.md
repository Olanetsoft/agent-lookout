# Kilo Code adapter notes

These notes record what Agent Lookout reads from Kilo Code, where each value comes from, and what breaks when Kilo Code changes. When the adapter stops working, start here.

Written on 2026-11-15 from Kilo Code's source at `v7.8.27`, the tag of commit `03a6f07` of [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode), dated 2026-11-05. Kilo Code is under the MIT licence. Its command, `kilo`, is built from OpenCode's source, and `.opencode-version` at that tag says `v1.18.26`. Kilo Code was not installed or run to write these notes, and no real session or `kilo.db` was looked at, so nothing here has been checked on a computer running Kilo Code. The fixtures are written by hand from the source.

Each citation is `path:line` at `v7.8.27`, under `packages/`.

The code is in `src/collector/adapters/kilo-code/index.ts`. It is the OpenCode adapter's body, `createOpencodeFamilyAdapter` in `src/collector/adapters/opencode/index.ts`, with `KILO_CODE_PROFILE`, an `OpencodeProfile` from `src/collector/adapters/opencode/profile.ts`. The status mapping is OpenCode's, in `src/core/mapping/opencode/opencodeMapping.ts`. Everything [the OpenCode notes](opencode.md) say of OpenCode 1.x holds here unless this page says otherwise, and a change to those modules changes Kilo Code too.

## What the issue said, and what holds

| What issue #43 said                                                                          | What the source shows                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions are in one SQLite file at `~/.local/share/kilo/kilo.db`                             | True for a release (`core/src/database/database.ts:50-66`). A pre-release or a build from source writes another name, as [Where it looks](#where-it-looks) says                                                                                                                                                        |
| Shared by its CLI and its editor extensions                                                  | True: the VS Code and JetBrains extensions start `kilo serve`, which opens the same file (`kilo-vscode/src/services/cli-backend/server-manager.ts:35`, `:129`)                                                                                                                                                         |
| Which sessions are busy or waiting is held in its server's memory, not on disk               | Partly. Whether a turn is under way is not written as such, but the rows say it as they do for OpenCode: a step under way has no `$.time.completed`, and a question waits in a `question` part that stays `running`. A wait for a tool's approval, and a plan's approval, are in memory alone, as [Waits](#waits) says |
| So status would need its local HTTP API or its event stream                                  | Not needed. Status comes from the rows of `message` and `part`, read with `sqlite3`, and no request is made to Kilo Code's server, which runs only with an editor or `kilo serve`                                                                                                                                      |
| This comes from its docs and source, and has not been checked on a machine running Kilo Code | Still true of these notes                                                                                                                                                                                                                                                                                              |

## How it reads Kilo Code, and why

As for OpenCode: it looks at `kilo.db` and the two files SQLite keeps beside it, asks the system's `sqlite3` two fixed questions when the database or its `-wal` changes, and asks `ps` whether a Kilo Code program runs. It runs no program of Kilo Code's: any `kilo` command, `kilo db path` among them (`opencode/src/cli/cmd/db.ts:51`), makes Kilo Code's folders as it starts (`core/src/global.ts:48-55`). It reads no last message and nothing on Windows.

## Where it looks

- **The data folder.** `AGENT_LOOKOUT_KILO_HOME` if set, and then Kilo Code's own variables are not read. Otherwise `kilo` in `XDG_DATA_HOME`, when that is an absolute path, or else `~/.local/share/kilo` (`core/src/global.ts:12`, `:21-22`). Kilo Code takes `XDG_DATA_HOME`, or `~/.local/share`, on every system, macOS and Windows included, with xdg-basedir.
- **The database.** With `AGENT_LOOKOUT_KILO_HOME`, `kilo.db` in that folder. Otherwise as Kilo Code takes its own `KILO_DB` (`core/src/flag/flag.ts:111`, `core/src/database/database.ts:51-53`): `:memory:`, which leaves nothing to read, an absolute path as it is, or a path in the data folder. Empty, or not set, it is `kilo.db` in the data folder. Kilo Code reads no `OPENCODE_DB`, and nor does this adapter.
- **Not read:** the file of another build channel. A release is the channel `latest` and writes `kilo.db`, and so do `beta` and `prod`, and any build with `KILO_DISABLE_CHANNEL_DB` set to `1` or `true` (`database.ts:55-60`). Any other channel writes `kilo-<channel>.db`, or an `opencode-<channel>.db` already in that folder when there is no `kilo-` one (`database.ts:61-66`). A pre-release is `rc`, so it writes `kilo-rc.db`, a build from a git branch writes `kilo-<branch>.db`, and a run from source or Nix writes `kilo-local.db` (`script/src/index.ts:30-35`, `core/src/installation/version.ts:8`). The VS Code extension always sets `KILO_DISABLE_CHANNEL_DB=true` (`server-manager.ts:35`), and JetBrains does for its own CLI, so both write `kilo.db`. Agent Lookout cannot learn the channel without running Kilo Code, so it reads `kilo.db` alone, lists no folder to look for another, and the card says that `KILO_DB` names any other file to read.

What it reads, how often, and the addresses `sqlite3` opens the database at, are [OpenCode's](opencode.md#what-it-reads), with `kilo.db`, `kilo.db-wal` and `kilo.db-shm` in place of OpenCode's three. Kilo Code keeps the database in WAL mode, as OpenCode does (`core/src/database/database.ts:31-37`).

## The tables

`session`, `message` and `part` have every column the questions ask for, with the same names and the same JSON in `data` (`core/src/session/sql.ts:24-114`, `core/src/database/schema.gen.ts:177-262`, `schema/src/v1/session.ts`). Kilo Code also has `session_message` (`schema.gen.ts:219`), which the probe names and `readSchema` passes over, so the probe gives the layout of OpenCode 1.x. It has no `session_v2`: nothing under `packages/` names one. Since Kilo Code follows OpenCode, a later version could add one, and a database with `session_v2` is taken for a version Agent Lookout does not read, rather than read with OpenCode 2's meaning.

Kilo Code adds three indexes built with `json_extract` to `message` and `part`, two of them partial: `recall_message_role_idx`, `part_session_step_finish_idx` and `recall_part_search_idx` (`schema.gen.ts:303`, `:310`, `:315`). Every read runs with `PRAGMA trusted_schema=OFF`, which refuses a function in a schema unless SQLite marks it as safe there. Its own JSON functions are, and `tests/integration/collector/adapters/kilo-code/index.test.ts` runs the real `sqlite3` on a database with those indexes, reads through two of them, and asks both questions. It was run on macOS with `/usr/bin/sqlite3` 3.51.0.

Session ids are `ses_` and 26 characters (`core/src/id/id.ts:6`), and placeholder titles are OpenCode's, `New session - ` or `Child session - ` and a time (`opencode/src/session/session.ts:57-64`). `directory` holds an absolute path, or an empty one for an old session (`core/src/database/path.ts:43-58`).

## The questions

The probe is OpenCode's. The sessions query is `KILO_SESSIONS_QUERY`, which `v1SessionsQuery` in `sessionRows.ts` builds with Kilo Code's tools, `KILO_TOOLS`. It is `SESSIONS_QUERY` with two changes:

- `<asking part>` names `question` alone: `json_extract(p.data, '$.tool') IN ('question')`.
- It adds `m_idle_call`, whether the newest message's one tool part not yet over is a `suggest` call in the state `running`:

```sql
(SELECT count(*) = 1 AND sum(json_extract(p.data, '$.tool') IN ('suggest')
    AND json_extract(p.data, '$.state.status') IS 'running') = 1
  FROM part p WHERE p.message_id = m.id
  AND CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') = 'tool'
    AND json_extract(p.data, '$.state.status') IS NOT 'completed'
    AND json_extract(p.data, '$.state.status') IS NOT 'error' END) AS m_idle_call
```

A part is over once its state is `completed` or `error`, and any other state, or none, counts as not over. The name and the state are tested inside SQLite, and only 1 or 0 is printed. OpenCode's own questions do not ask for it, so they are as they were.

## Waits

### Needs you

A session needs you while the newest step has a `question` part in the state `running` and no `$.time.completed`, as for OpenCode. Kilo Code's `question` tool waits inside its call on a `Deferred` (`opencode/src/tool/question.ts:16-17`, `opencode/src/question/index.ts:100-117`), and is offered to Kilo Code's own clients, the `cli` and `vscode` ones among them, and to JetBrains with `KILO_ENABLE_QUESTION_TOOL` (`opencode/src/tool/registry.ts:273`, `:314`). A new prompt dismisses every question that waits (`opencode/src/session/prompt.ts:1492-1493`), so a prompt sent while one waits ends it, unlike OpenCode. The reason is `question`, and nothing of what it asks is read.

`plan_exit` is not a wait in Kilo Code. Its tool finds the plan's file and returns at once (`opencode/src/kilocode/tool/plan.ts:19-56`). The approval, "Ready to implement?", is asked after the step has ended, through `question.ask` with no part of its own (`opencode/src/kilocode/plan-followup.ts:306-345`). So a session waiting for a plan's approval shows as working for up to 10 seconds, as a step that asked for tools does, then idle.

A wait for a tool's approval is in memory, as for OpenCode (`opencode/src/permission/index.ts:272-283`), so a session in one shows as working. The `permission` table holds saved rules, not waits.

### A suggestion

Kilo Code's `suggest` tool offers a review once a turn's work is done, as the last thing in the turn, and waits inside its call until you take it or dismiss it (`opencode/src/kilocode/suggestion/tool.ts:64-105`, `tool.txt`). While it waits, Kilo Code sets the session to idle itself (`tool.ts:89-94`), and its part stays `running`. It is offered to the `cli` and `vscode` clients (`registry.ts:329`).

So a step under way whose one tool part not yet over is a running `suggest` is idle here too, as Kilo Code shows it: `idleCall` in `opencodeMapping.ts`. It is not needs-you, since Kilo Code does not wait on it before it goes on, and its own description sends real questions to `question`. A step with another call still running beside it is working. Once you take the suggestion, the step goes on and the session is working again. With Kilo Code closed it is finished. Its time is the newest write of the session, since the step has not ended.

### Other waits

Kilo Code's `/resume-claude` and `/resume-codex` pickers (`prompt.ts:2185-2197`) and the prompt it shows when a snapshot is slow are in memory, and write nothing.

## Status

As [OpenCode 1.x's](opencode.md#status), with the two rows above: a `question` alone needs you, and a running `suggest` that is the one call not yet over is idle. The error names are OpenCode's (`schema/src/v1/session.ts:36-61`), and Kilo Code's own errors use them, as `APIError` for a malformed tool call (`opencode/src/kilocode/session/processor.ts:392-396`).

## Open or closed

`ps -A -o comm=` is asked as for OpenCode. A process whose program has one of these names, alone or at the end of a path, is taken for Kilo Code (`KILO_PROGRAMS` in `kilo-code/index.ts`):

| Name            | What it is                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `kilo`          | The program of the install script, at `~/.kilo/bin/kilo`, of Homebrew and the release archive, and the one the VS Code and JetBrains extensions start (`server-manager.ts:129`)            |
| `.kilo`         | The copy npm's launcher, `opencode/bin/kilo`, keeps beside itself and starts (`bin/kilo:90`, `opencode/script/postinstall.mjs`). The launcher is a Node script, so `ps` shows it as `node` |
| `.kilo-wrapped` | The program Nix's wrapper starts (`nix/kilo.nix:63`, at the root of the repository)                                                                                                        |

npm's second link, `kilocode`, points to the same Node launcher (`opencode/package.json:19-22`), so `ps` never shows it, and it is not one of the names. None of OpenCode's names is one, and none of these is OpenCode's, so one running keeps no session of the other open. Each fits in the 15 characters Linux keeps. No process title is set.

What that gives:

- While any `kilo` runs, every Kilo Code session is open, whether or not a window shows it. An editor's `kilo serve` runs while the editor is open (`KILO_PARENT_PID`, `server-manager.ts:152`), and `kilo daemon` runs until it is stopped (`opencode/src/kilocode/daemon/daemon.ts:291-322`), so while either runs, a session you have closed shows as idle, not finished.
- Once `ps` shows none, every session is finished, unless it failed or cannot be read.
- Another program called `kilo` keeps sessions from showing as finished, and nothing more.

## Names, tokens and the rest

The name is Kilo Code's title, which a model writes, unless it is still the placeholder, else the folder's name. A session's id in Agent Lookout is `kilo-code:<session id>`. Its token counts are those of its newest reply that has them, read as [OpenCode 1.x's are](opencode.md#token-counts), since Kilo Code works them out the same way (`opencode/src/session/session.ts:420-462`). It has no app, no process ID, no link, no Jump, no Stop, no Answer and no Quiet for.

## Last message

Not read. The profile has no `lastMessageRead`, so the adapter has no `lastMessage`, `GET /api/sessions/last-message` answers `not-read` for its sessions, and its card has no row for it. Kilo Code writes text parts as OpenCode 1.x does, so the OpenCode adapter's question would fit, but reading what a Kilo Code session said is left for a change of its own.

## Kilo Code's other files

Kilo Code moved its sessions into `kilo.db` at 7.0.26 (`kilo-vscode/CHANGELOG.md:3693`). Its import of the flat files before that reads only its own `storage/` (`opencode/src/kilocode/storage/json-migration.ts:78`, `:127`), never OpenCode's database, so a session is never listed by both adapters. Tables only Kilo Code writes, such as `kilo_board`, `kilo_board_message`, `kilo_continuation_intent`, `session_input` and `session_context_epoch` (`schema.gen.ts:8-278`), record no wait and no turn under way, and are not read.

## What it never reads

- **Files:** `auth.json` and `mcp-auth.json`, which hold keys and sign-ins (`opencode/src/auth/index.ts:11`); everything in Kilo Code's state folder, `~/.local/state/kilo` or `~/.local/share/kilo/state` (`core/src/global.ts:25-26`); everything in its config folder, `~/.config/kilo`; `log/`, `storage/`, `snapshot/`, `tool-output/` and `plans/`; any `kilo-<channel>.db` or `opencode-<channel>.db` `KILO_DB` does not name; and, for the adapter itself, any file but the three database files. A session's own folder is looked in for a git repository, as every session's is.
- **Tables:** every one but `session`, `message` and `part`, and the names in `sqlite_master` and of the columns of `session` and `session_v2`. So never `account` or `control_account`, which hold `access_token` and `refresh_token`, `credential`, which holds `value` (`schema.gen.ts:35-71`), `event`, `session_message`, `session_input`, `permission`, `project`, `todo` or any `kilo_` table.
- **Columns:** those OpenCode's notes list, and of a part's `data` only the fields above.
- **Programs:** no `kilo` command and no request to Kilo Code's server. `ps` is asked for the name of each process's program alone, never its arguments.

## Known gaps

- A wait for a tool's approval shows as working, and a wait for a plan's approval as working for 10 seconds, then idle.
- A session that ends on a suggestion shows as idle while Kilo Code waits for you to take it, as Kilo Code shows it, so it sends no Needs you.
- While an editor's `kilo serve` or `kilo daemon` runs, no session shows as finished.
- A pre-release, a build from source and Nix's build keep their sessions in another file, which is read only when `KILO_DB` names it.
- Nothing is read on Windows, where Agent Lookout runs no `sqlite3`. The card says so.
- No last message is read.
- The gaps the OpenCode notes list for OpenCode 1.x, but for the one about a prompt sent while a question waits, which ends the question in Kilo Code.

## Not yet checked

On a computer running Kilo Code: that `kilo.db` holds the rows the source writes, that a `question` part is `running` while Kilo Code asks and a `suggest` part while it suggests, and what `ps -A -o comm=` prints for Kilo Code started each way it is installed. To check, read the `$.tool` and `$.state.status`, and only those, of the newest parts of a session's newest message while it asks a question and while it suggests a review, and look for `kilo`, `.kilo` or `.kilo-wrapped` in `ps -A -o comm=` with the `kilo` command, the VS Code extension and the JetBrains plugin.

## What breaks when Kilo Code changes

| Change in Kilo Code                                                                        | What the dashboard shows                                                                    | Where to fix it                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| It adds `session_v2`                                                                       | The card says the database is from a version Agent Lookout does not read                    | `readsV2` in `KILO_CODE_PROFILE`, and the OpenCode notes |
| A column or table the questions ask for is renamed or dropped                              | The card says the database is from a version it does not read, or sqlite3 could not read it | `sessionRows.ts`                                         |
| `question` is renamed, or a call stops being `running` while it waits                      | A session that asks shows as working                                                        | `KILO_TOOLS` in `kilo-code/index.ts`                     |
| `suggest` is renamed, stops waiting inside its call, or Kilo Code stops showing it as idle | A session that suggests a review shows as working, or as idle when it should not            | `KILO_TOOLS` in `kilo-code/index.ts`                     |
| `plan_exit` waits inside its call again                                                    | A session waiting for a plan's approval shows as working, then idle                         | `KILO_TOOLS` in `kilo-code/index.ts`                     |
| The data folder, the file's name or `KILO_DB`'s rules move                                 | Kilo Code is not found, or found with no database                                           | `KILO_CODE_PROFILE` and `profile.ts`                     |
| Kilo Code's program is given another name                                                  | Its sessions show as finished while it runs                                                 | `KILO_PROGRAMS` in `kilo-code/index.ts`                  |
| An index is added with a function SQLite does not mark as safe in a schema                 | The card says sqlite3 could not read the database                                           | `sessionRows.ts`, and these notes                        |
| Anything OpenCode's notes list for OpenCode 1.x                                            | As they say                                                                                 | As they say                                              |

To check a new Kilo Code version, read at its tag `core/src/database/database.ts`, `core/src/database/schema.gen.ts`, `core/src/session/sql.ts`, `core/src/global.ts`, `core/src/flag/flag.ts`, `opencode/src/tool/registry.ts`, `opencode/src/tool/question.ts`, `opencode/src/kilocode/tool/plan.ts`, `opencode/src/kilocode/plan-followup.ts`, `opencode/src/kilocode/suggestion/tool.ts`, `opencode/bin/kilo`, `opencode/package.json`, `nix/kilo.nix` and `kilo-vscode/src/services/cli-backend/server-manager.ts`, and `.opencode-version`, then what the OpenCode notes say to read of the OpenCode version it names.
