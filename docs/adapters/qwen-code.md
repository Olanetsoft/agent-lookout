# Qwen Code adapter notes

These notes record what Agent Lookout reads from Qwen Code, where each value comes from, and what breaks when Qwen Code changes. When the adapter stops working, start here.

Written on 2026-10-14 from the source of Qwen Code `v0.25.1`, released 2026-10-11 (commit `c1a8218` of [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)), and the documentation in that tag. Qwen Code was not installed or run on the machine where the adapter was written, and no Qwen Code folder was read there. Everything below comes from that source and from hand-written files laid out the same way. **The adapter was built from Qwen Code's source at v0.25.1 and has not yet been checked on a machine running Qwen Code.** The Sources view says so too.

Each citation is `path:line` at `v0.25.1`, where `core/` is `packages/core/src/` and `cli/` is `packages/cli/src/`.

The code is in `src/collector/adapters/qwen-code/`, and the status mapping is in `src/core/mapping/qwen-code/qwenCodeMapping.ts`.

## How it reads Qwen Code, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no program run, no network. It reads two things, both read-only:

- the list of running sessions in `<qwen home>/sessions/`, which Qwen Code documents for other programs to read (`docs/users/features/cross-session-protocol.md:22-131`);
- each listed session's chat file, `<runtime>/projects/<folder>/chats/<session id>.jsonl`.

It asks whether each session's process runs with signal 0, which tests a process and sends it nothing.

Qwen Code has other ways in, and none of them can be used that way:

| Interface                                    | Why it is not used                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen sessions ps`                           | It starts Qwen Code, and it deletes the records whose process it judges gone (`core/services/session-registry.ts:786`), which writes in Qwen Code's folder. |
| `qwen sessions list`                         | It starts Qwen Code, and it walks the chat files without saying which sessions run.                                                                         |
| Hooks (`Notification`, `PermissionRequest`)  | Each needs a change to Qwen Code's settings.                                                                                                                |
| A session's socket, `ipcPath`, and its token | It takes messages for the session. Agent Lookout never connects to it, and never uses the token.                                                            |
| `qwen --acp` and Qwen Code's server          | They drive sessions of their own, and do not list the terminal's.                                                                                           |

## What it reads

| Path                                                 | How                                                                                                                    | How often                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `<qwen home>/sessions` and `<runtime>/projects`      | One `stat` each, to tell whether Qwen Code is there. Not done when `AGENT_LOOKOUT_QWEN_HOME` is set                    | On the first poll, then at most once a minute while both are missing, and on every poll while `sessions/` is missing and `projects/` is there |
| `<qwen home>/sessions/`                              | Listed                                                                                                                 | Every poll                                                                                                                                    |
| `sessions/<pid>.json`, `sessions/<pid>-<8 hex>.json` | Opened read-only, whole, when 64 KiB or less (`core/services/session-registry.ts:107,119`)                             | Every poll                                                                                                                                    |
| `<runtime>/projects/<folder>/chats/<id>.jsonl`       | One `lstat`, for a session whose process runs                                                                          | Every poll                                                                                                                                    |
| The same file                                        | Opened read-only: the last 8 MiB, then only what is appended                                                           | When its size, modified time or identity changes                                                                                              |
| `<runtime>/projects/`                                | Listed, then one `lstat` of `<each>/chats/<id>.jsonl`, when a session's file is not in the folder named for its folder | At most every 30 seconds for each session                                                                                                     |
| `chats/<id>.jsonl` of a record a crash left behind   | One `lstat`, for its modified time. Never opened                                                                       | Once, at the first poll                                                                                                                       |

A file is opened without following a link at its name and without waiting on a pipe, and read only if the open file is an ordinary file. A link at a chat file's name is not a chat file.

## The folders

| Folder                               | First                     | Then               | Otherwise       |
| ------------------------------------ | ------------------------- | ------------------ | --------------- |
| Qwen Code's own, with `sessions/`    | `AGENT_LOOKOUT_QWEN_HOME` | `QWEN_HOME`        | `~/.qwen`       |
| The runtime folder, with `projects/` | `AGENT_LOOKOUT_QWEN_HOME` | `QWEN_RUNTIME_DIR` | Qwen Code's own |

This is the order Qwen Code uses (`core/config/storage.ts:172-203`). A value is trimmed, an empty one counts as unset, and `~` is the home folder, as Qwen Code reads it (`core/config/storage.ts:71-91`). `AGENT_LOOKOUT_QWEN_HOME` names both folders at once, and Qwen Code's own variables are then not looked at.

When both folders are missing, Qwen Code is reported as not found, with no advice, and they are looked for again once a minute. Polls in between touch nothing. When `AGENT_LOOKOUT_QWEN_HOME` names a folder with no `sessions` folder in it, that is an answer, not a missing Qwen Code: the source is watched and lists no sessions.

Two ways Qwen Code moves its folders cannot be followed, because Agent Lookout never reads Qwen Code's settings:

- `advanced.runtimeOutputDir` in `settings.json` moves the chat files (`cli/config/config.ts:1797-1799`).
- `QWEN_HOME` and `QWEN_RUNTIME_DIR` can be set in `~/.qwen/.env` or `~/.env`, which Qwen Code reads at start (`cli/config/environment.ts:200-258`).

A person who uses either can start Agent Lookout with `QWEN_HOME` or `QWEN_RUNTIME_DIR` set to the same folder.

## The list of running sessions

`<qwen home>/sessions/` holds one small JSON file for each session a Qwen Code process has open. The file is `<pid>.json`, or `<pid>-<8 hex>.json` for a process that hosts more than one session (`core/services/session-registry.ts:110-139`). The pid in the name, written as Qwen Code writes it, must be the record's own. No other name is opened, Qwen Code's temporary files `<name>.json.<12 hex>.tmp` among them.

A record, as Qwen Code writes it (`core/services/session-registry.ts:474-485`; `docs/users/features/cross-session-protocol.md:38-68`):

| Field           | Meaning                                                                                       | Kept                                           |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `schemaVersion` | `1`. A record of a higher version is counted and not read, as Qwen Code's own readers do      | Read, not kept                                 |
| `pid`           | The writer's process. It must match the file's name                                           | Yes                                            |
| `procStart`     | A start token on Linux, `null` on a Mac and Windows                                           | Only whether there is one                      |
| `pidNs`         | A process namespace on Linux, `null` elsewhere                                                | Only whether there is one                      |
| `sessionId`     | The session's id. `/clear` and `/resume` change it in place                                   | Yes, when it is hex digits and dashes          |
| `cwd`           | The session's folder. `/cd` changes it                                                        | Yes, when it is an absolute path               |
| `name`          | A label made from the folder                                                                  | No                                             |
| `startedAt`     | When the process registered the session, in epoch milliseconds                                | Yes                                            |
| `qwenVersion`   | The Qwen Code version                                                                         | No                                             |
| `kind`          | `tui`, `headless`, `serve` or `external`. Absent means `tui`                                  | Yes                                            |
| `ipcPath`       | The session's socket                                                                          | No, never used                                 |
| `ipcToken`      | The token a program sends to the session with. Qwen Code's docs say never to show it anywhere | No: dropped with the parsed record, never used |

- Only terminal sessions, `kind` `tui` or none, are listed. `headless` and `serve` are sessions an editor or Qwen Code's own server drives, and `external` a program that is not Qwen Code. They are left out in this version.
- On a Mac or Windows, a record with a start token or a namespace was written on Linux: by Qwen Code in a container, `qwen --sandbox`, which shares the folder. Its pid means nothing here, so it is not listed, and the Sources view says so.
- Two records of one session give the one with the newest `startedAt` whose process runs, as Qwen Code decides: its own listing asks each process first (`core/services/session-registry.ts:701-793`). When no process of them runs, the newest.
- A record caught mid-write keeps the entry it held before, for one poll. Qwen Code writes each through a temporary file and a rename (`core/services/session-registry.ts:537-541`).
- A session's id in Agent Lookout is `qwen-code:<session id>`.

Qwen Code removes a record when its process exits on `/quit`, SIGINT, SIGTERM or SIGHUP. A crash, `kill -9` or a power cut leaves it behind (`cli/llm.tsx:228-317`).

## Chat files

Path: `<runtime>/projects/<folder>/chats/<session id>.jsonl` (`core/config/config.ts:11898-11906`). The folder is the session's folder with every character that is not a letter or a digit made a `-`, after it is made lowercase on Windows (`core/utils/paths.ts:388-392`). The file is made with the session's first line, so a new session has none yet. Chat recording can be turned off, and then there is no file.

Each line is one record, appended and never rewritten (`core/utils/jsonl-utils.ts:347-369`). Its first keys are `uuid`, `parentUuid`, `sessionId`, `timestamp` and `type`, in that order, after an optional `backgroundTurn`, and `cwd`, `version` and `gitBranch` follow (`core/services/chatRecordingService.ts:1525-1555`). `type` is `user`, `assistant`, `tool_result` or `system`, with a `subtype` for most system lines (`core/services/chatRecordingService.ts:371-414`).

Kept of each line: its type, subtype and time, and

- of a `user` line, whether it is a notification stamped `deliveredTurn`, the first line of a turn Qwen Code went on to send (`core/services/chatRecordingService.ts:420-448`);
- of an `assistant` line, whether it holds a reply and whether that calls a tool;
- of a `tool_result` line, whether `toolCallResult.status` is `cancelled`;
- of a `ui_telemetry` line with a `request_lifecycle` event, its `phase`, its `outcome` and whether a subagent made it (`core/telemetry/request-lifecycle.ts:15-46`);
- of a `custom_title` line, the title (`core/services/chatRecordingService.ts:3305-3335`);
- whether the line belongs to a Managed Session log.

Never kept: the prompt, the reply, its thoughts, a tool's input and output, `cwd`, `gitBranch`, token counts, or any other field. Each line is parsed and dropped at once. A line a subagent wrote, `isSidechain: true`, is skipped.

Every read is bounded. The first reads at most the last 8 MiB and drops the line it cut into. Each one after reads only what was appended, at most 8 MiB at once. A line still being written is left for the next read. A line over 4 MiB is not parsed: its type, subtype and time are read from its first 64 KiB. A file that shrank or was replaced is read again from its end.

## What it never reads

Under Qwen Code's own folder:

- `oauth_creds.json`, `oauth_creds.lock`, `mcp-oauth-tokens*.json`, `extension-secrets-v1.json`, `ide/`, `daemon/`, `jobs/`, `agent-hosts/` and `channels/`, which hold sign-ins, tokens and secrets;
- `settings.json`, `.env`, `installation_id`, `google_accounts.json`, `trustedFolders.json` and `memory.md`;
- `file-history/`, and a project's own `.qwen/settings.json`.

Under the runtime folder: `tmp/`, `debug/`, `todos/`, `usage/` and `resources/`, and in each project's folder `memory/`, `subagents/`, `chats/archive/` and the files beside a chat file, `<id>.runtime.json`, `<id>.worktree.json`, `<id>.pr.json` and `<id>.ledger.jsonl`.

It never writes, creates, renames or deletes anything in either folder, never writes a record of its own into `sessions/`, never connects to a session's socket and never runs `qwen`.

## Status

What each line says:

| Line                                                       | Status                                |
| ---------------------------------------------------------- | ------------------------------------- |
| A prompt: `user` with no subtype, `cron` or `goal_runtime` | Working                               |
| A `user` `notification` stamped `deliveredTurn`            | Working                               |
| `user` `mid_turn_user_message`, typed while a turn runs    | Working                               |
| `assistant` whose reply calls a tool                       | Working                               |
| `tool_result`, none stopped since the calls                | Working                               |
| `request_lifecycle` `started`, of the session's own        | Working                               |
| `assistant` with a reply and no call                       | Idle                                  |
| `tool_result`, one or more stopped or declined             | Idle                                  |
| `system` `rewind`                                          | Idle                                  |
| `system` `turn_result`                                     | Idle                                  |
| `request_lifecycle` `ended` with `cancelled`               | Idle                                  |
| `request_lifecycle` `ended` any other way                  | What the line before the request said |
| A line of another type, or a reply too long to read        | Unknown                               |

Every other line says nothing: a notification saved before any turn ran, messages between agents, other telemetry, a subagent's requests, titles, compressions and snapshots. Nor does an `assistant` line right after a request ended with `cancelled`: it is the part of the reply Qwen Code had when Esc stopped it, written after the stop (`core/core/llm-chat.ts:6218-6258`, `core/core/llm-chat.ts:5183-5196`). Even when that part calls a tool, no tool runs, and the turn is over.

A request that ended well or failed, with no line after it, puts back what the line before it said. After a reply, Qwen Code can ask the model whether it should speak next, when `skipNextSpeakerCheck` is off (`core/core/client.ts:5481-5507`), and writes a request for it but no reply, so the session is idle again once that request ends. An idle stretch that comes back this way begins when the request ended.

The first rule that holds wins:

1. A Managed Session log: unknown.
2. No chat file, or one read whole with nothing that says anything: idle since the session registered.
3. A file read from its middle with nothing that says anything: unknown.
4. A newest line that says something from before the session registered: idle since it registered. That is a session resumed with `/resume`, or one an earlier Qwen Code left mid-turn.
5. Otherwise, what the newest line that says something says.

A session that `/clear` or `/resume` moved a running process to while Agent Lookout watched counts as registered at the last poll before the move.

A result that was stopped ends the turn because Esc while tools run ends it, whichever calls finished (`cli/ui/hooks/use-llm-stream.ts:5496-5522`). When a person declined one call of several, Qwen Code goes on, and its next request, written from 0.25.1, or a reply that calls a tool shows the session as working again.

A working session's time is when its stretch of work began, or none when that is before what was read. An idle session's is when it became idle, never before it registered. A Qwen Code session is never shown as needing you or failed.

## Closed sessions

A session closes when a poll no longer finds it open after an earlier poll did: its record has gone, its process has gone, or its record names another session, as after `/clear` or `/resume`. It is shown as finished from that poll for 24 hours, with what was last known of it, and its chat file is not read again. It leaves the list sooner if it is open again. When its process is still open with another session, as after `/clear` or `/resume`, it names no process, and with `finished` notifications on it sends one like any session that finishes.

At the first poll, a record whose process has already gone, as a crash leaves, is shown as finished from its chat file's modified time, or from when it registered. One a day old or more is left out. Every other session that closed before Agent Lookout started is not shown, and nothing of this is kept across a restart.

## Fields

- **Name:** the title Qwen Code gave the session, or the one set with `/rename`, then the folder's name, then the id. The newest `custom_title` wins. What was typed is never used, and neither is the record's `name`.
- **Folder:** the record's `cwd`, which `/cd` changes.
- **Started:** the chat file's first line, when the file was read from its start. Otherwise when the process registered the session, or when `/clear` or `/resume` moved the process to it, if Agent Lookout saw that happen.
- **Quiet for:** the chat file's modified time from the `lstat` on each poll. Every line Qwen Code adds moves it on. A session with no chat file has none.
- **App:** Terminal.
- **Process:** the record's `pid`, with no Jump, Stop or link.

## Versions

- The list of running sessions is written from Qwen Code 0.21.14 (QwenLM/qwen-code#8969). With an older Qwen Code there is no list, and the Sources view says so.
- `kind` is written from 0.23.3. A record without one is a terminal's.
- `request_lifecycle` and `executionContext` are written from 0.25.1.
- Up to 0.3.0 Qwen Code kept chats in `tmp/<hash>/chats/session-*.json`. From 0.4.0 the only chats are the JSON Lines files under `projects/`. `tmp/` is never read.

## Known gaps

- A session waiting for your approval shows as working, and its Quiet for grows. Qwen Code writes nothing while it asks.
- A request that fails for good shows as working until the next prompt: Qwen Code records each failed try, and nothing when it gives up. So can a reply stopped with Esc. Before 0.24.0, Esc writes nothing. From 0.24.0, Esc after any part of a reply writes that part (`core/core/llm-chat.ts:6218-6259`), which shows as idle unless it calls a tool, and an Esc before the first part writes nothing. From 0.25.1, Esc during a request also writes a stopped request first, and the session shows as idle whatever the part holds. But Esc while Qwen Code waits to retry a failed try writes nothing, since no request is open then (`core/utils/retry.ts:171-195`), and nor may Esc before a turn's first request starts, as while Qwen Code compacts the chat. Those show as working until the next prompt on 0.25.1 too.
- Before 0.25.1, a session where you declined one call of several shows as idle until Qwen Code's next reply.
- Closed sessions are shown only while Agent Lookout runs, and records a crash left at its start.
- After a crash, another process can take the pid. The closed session then shows as open, with the status its chat file last gave, often working, since a crash tends to come mid-turn. That can last as long as the process that took the pid runs, and come back each time the pid is given out again while the record is left. On a Mac or Windows, with no start time to compare, Qwen Code keeps a record whose pid runs (`core/utils/process-liveness.ts:201-210`). On Linux, a Qwen Code that lists its sessions, as `qwen sessions ps` does, removes the record sooner. It does not once the computer has restarted: Qwen Code leaves alone a record from before the restart (`core/services/session-registry.ts:756-760`).
- Never listed: `qwen -p` runs, which never register (`docs/users/features/commands.md:770`); Qwen Code before 0.21.14; sessions an editor or Qwen Code's server drives; sessions in a container, on a Mac or Windows; and sessions under a folder Agent Lookout's own environment does not name.
- Chats moved by `advanced.runtimeOutputDir`, or with chat recording off, show as idle, and after ten minutes the Sources view says no chat file was found.
- Managed Session logs show as unknown.
- After `/clear` or `/resume` made before Agent Lookout started, the session is idle since its process registered, which can be long before, until its next prompt, so it can show as stale at once. After such a `/clear`, Started is that time too until the new session writes its first line. Started is also when the process registered for a chat file over 8 MiB, which is read from its middle.
- On Linux, a record written in a container is listed, and its pid is checked on this computer.

## What breaks when Qwen Code changes

| Change in Qwen Code                                   | What the dashboard shows                                                                                                                                  | Where to fix it                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| The record's fields or `schemaVersion` change         | No Qwen Code sessions, and the Sources view names a newer format                                                                                          | `registry.ts`                                   |
| Record names change                                   | No Qwen Code sessions                                                                                                                                     | `registry.ts`                                   |
| The project folder rule changes                       | Sessions are still found by a look through every folder in `projects/`, up to 30 seconds late, and a crash's leftover is finished from when it registered | `transcriptFile.ts`                             |
| The order of the first keys of a line changes         | A line over 4 MiB reads as unknown                                                                                                                        | `chatRecords.ts`                                |
| `request_lifecycle` changes shape                     | A stopped reply shows as working until the next prompt                                                                                                    | `chatRecords.ts`                                |
| A new `user` subtype begins turns                     | Those turns do not show as working                                                                                                                        | `src/core/mapping/qwen-code/qwenCodeMapping.ts` |
| A new line type                                       | Sessions show as unknown until their next line                                                                                                            | `src/core/mapping/qwen-code/qwenCodeMapping.ts` |
| `custom_title` changes                                | Sessions are named after their folder                                                                                                                     | `chatRecords.ts`                                |
| `QWEN_HOME` or `QWEN_RUNTIME_DIR` mean something else | Qwen Code is not found, or found empty                                                                                                                    | `index.ts`                                      |

To check a new Qwen Code version, read `core/services/session-registry.ts`, `core/services/chatRecordingService.ts`, `core/telemetry/request-lifecycle.ts`, `core/utils/paths.ts`, `core/config/storage.ts` and `docs/users/features/cross-session-protocol.md` at its tag. Then run a session in a terminal, and compare the dashboard with `qwen sessions ps` on a machine where nothing else reads the list.
