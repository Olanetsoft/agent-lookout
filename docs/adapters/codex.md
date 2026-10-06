# Codex adapter notes

These notes record what Agent Lookout reads from Codex, where each value comes from, and what breaks when Codex changes. The files Codex writes are undocumented and change often, so when the adapter stops working, start here.

Checked on 2026-10-04 against Codex `rust-v0.160.0`, released 2026-10-01 (commit `79b1b66` of [openai/codex](https://github.com/openai/codex)), and the Codex documentation at learn.chatgpt.com. Codex was not installed on the machine where the adapter was written. Everything below comes from Codex's source and documentation and from hand-written files laid out the same way, except the section on the Codex desktop app, which was installed on that machine later the same day and checked against the adapter. **The adapter has not been checked against the Codex CLI or the IDE extension, and the dashboard has not yet been compared with Codex's own list of sessions.**

The code is in `src/collector/adapters/codex/`, and the status mapping is in `src/core/mapping/codexMapping.ts`.

## How it reads Codex, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no program run, no network. It reads three things under the Codex folder, all read-only.

Codex documents several interfaces, and none of them can be used that way:

| Interface                                                         | Why it is not used                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex app-server`, `thread/list`                                 | Documented, but starting it runs Codex's own start-up work, which writes under the Codex folder (rollout migration and compression). It also reports a thread that another Codex process has open as `notLoaded`, so it gives no live status for those. |
| The shared app-server daemon and its socket                       | Labelled experimental, and only there when the person runs it.                                                                                                                                                                                          |
| Hooks (`~/.codex/hooks.json` or `[hooks]` in config) and `notify` | Each needs the person to edit Codex's config, and hooks need a trust review in `/hooks`. They belong to the approvals milestone, where they are the only way to see an approval wait.                                                                   |
| `codex resume`                                                    | An interactive picker with no JSON output.                                                                                                                                                                                                              |
| `codex cloud list --json`                                         | Lists cloud tasks only, through the person's ChatGPT login.                                                                                                                                                                                             |
| OpenTelemetry (`[otel]`)                                          | Off by default and needs a config edit. It has no idle or waiting event.                                                                                                                                                                                |
| `codex://threads/<id>`                                            | Not documented, so the adapter builds no link to open a Codex session.                                                                                                                                                                                  |

`CODEX_HOME` is the only part of this that Codex documents: "the root for Codex state, including config, auth, logs, sessions", `~/.codex` by default (docs: `config-file/environment-variables.md`). The layout inside it is not documented.

## What it reads

| Path, under the Codex folder                   | How                                                                                                                              | How often                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| The Codex folder itself                        | One `stat`. Not done when `AGENT_LOOKOUT_CODEX_HOME` is set                                                                      | On the first poll, then at most once a minute while it is missing, and on each poll while it has no `sessions/`               |
| `sessions/`                                    | Listed, to tell no sessions from a folder that cannot be read                                                                    | Every poll                                                                                                                    |
| `sessions/YYYY/MM/DD/` for today and yesterday | Listed                                                                                                                           | Every poll                                                                                                                    |
| Every other `sessions/YYYY/MM/DD/`             | Listed, never opened, to find an open session in an older folder                                                                 | Only while an open session is not found: at once, but not within 5 seconds of the last listing, then at most every 30 seconds |
| `sessions/**/rollout-*.jsonl`                  | Opened read-only. The first 2 MiB for the `session_meta` line, the last 8 MiB for the last turn line, then only what is appended | When the file's size or modified time changes                                                                                 |
| `thread-writer-locks/`                         | Listed. Its files are never opened                                                                                               | Every poll                                                                                                                    |
| `session_index.jsonl`                          | Opened read-only, the last 4 MiB at most                                                                                         | When its size or modified time changes                                                                                        |

A session file is opened with `O_NOFOLLOW` and `O_NONBLOCK` and read only if the open file is an ordinary file, so a link, a pipe or a device named like a session file is never read and cannot stall a poll. A file not written to for a day, of a session no Codex process has open, is not opened.

It never reads `auth.json`, `config.toml`, `history.jsonl`, the SQLite files (`state_5.sqlite`, `thread_history_1.sqlite`, `logs_2.sqlite`, `queue_1.sqlite` and others), `log/`, `archived_sessions/` or any `.jsonl.zst` file.

### The Codex folder

`AGENT_LOOKOUT_CODEX_HOME` if set, then Codex's own `CODEX_HOME`, then `~/.codex`.

When the folder is missing, Codex is reported as not found, with no advice, and the folder is looked for again once a minute. Polls in between touch nothing. When `AGENT_LOOKOUT_CODEX_HOME` names a folder with no `sessions` folder in it, that is an answer, not a missing Codex: the source is watched and lists no sessions. That is how to see the dashboard with Codex present and empty.

### Session files

Path: `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<thread id>.jsonl`. The folder and the time in the name are in local time, taken when the session was created (`codex-rs/rollout/src/recorder.rs`, `precompute_new_rollout_path`). The thread id is a UUID (v7 for new threads, `codex-rs/protocol/src/thread_id.rs`).

- A reverted session gets a second file, `rollout-<time>-<thread id>_<rollout id>.jsonl`, with the same thread id (`codex-rs/rollout/src/rollout_file_name.rs`). The adapter shows one session per thread, from the file written to most recently.
- `codex resume` appends to the session's original file, which can be in a folder many days old. A resumed session that was compressed is decompressed to `.jsonl` again before Codex writes to it.
- Files untouched for seven days are compressed to `.jsonl.zst` (`codex-rs/rollout/src/compression.rs`, `MIN_ROLLOUT_AGE`). Archived sessions move to `archived_sessions/`.
- A new session's file is not created until its first turn (the recorder defers creation until `persist()`), so a session appears once its first prompt is sent.
- A start-up migration in Codex (`codex-rs/thread-store/src/local/rollout_migration/startup.rs`) can rewrite old files, so a file's modified time does not say when the session was last active. The times inside the file do.
- A session's `lastWriteAt`, which the dashboard shows as how long a working session has been quiet, is the file's modified time all the same, from the `lstat` made on each poll. It is when Codex last wrote anything to the file, a line still being written included. A rewrite by that migration moves it later, which can only make a session look less quiet than it is. A time from before the session's `session_meta` timestamp, or ahead of the clock, is not used. It also counts the files of subagents the session started, those whose `session_meta` names it in `parent_thread_id`, because a session waiting on its subagents writes nothing to its own file while they work. A subagent's own subagents are not counted.
- The SQLite files hold projections of these files. The default paginated history mode still writes the JSON Lines file.

Each line is `{"timestamp":"YYYY-MM-DDTHH:MM:SS.mmmZ","ordinal"?:n,"type":"<item>","payload":{...}}`, with the time in UTC (`codex-rs/history/src/lib.rs`, `RolloutLine`; `codex-rs/history/src/rollout_payload.rs`).

The adapter uses two kinds of line and parses no other.

The first `session_meta` line. Kept: `id`, `timestamp` (when the session was created), `cwd`, `source`, `thread_source`, `parent_thread_id`, `originator` (the program that created the session: `codex_cli_rs` for the Codex CLI, `Codex Desktop` for the desktop app) and `cli_version` (the Codex version that created it). `originator` and `cli_version` are kept only when they are at most 64 characters. Dropped: everything else, including `base_instructions`, `dynamic_tools`, `git`, `creator_user_id`, `creator_account_id`, `model_provider` and `session_id`. The session's id in Agent Lookout is `codex:<thread id>`, with the thread id taken from the file name, which is also how Codex names the lock file and the names file.

Turn lines: `"type":"event_msg"` with `payload.type` of

- `task_started`, which Codex also reads as `turn_started`, when a turn begins,
- `task_complete`, also read as `turn_complete`, when it ends,
- `turn_aborted`, with `reason` `interrupted`, `replaced`, `review_ended` or `budget_limited`, when it is stopped.

Only the type, the line's time, and whether `payload.turn_id` has the form `external-import-turn-<n>` are kept. A turn Codex runs has a UUID for its turn id; the other form marks a turn copied in from another agent (see "Sessions imported from another agent" below). Message lines, tool calls, commands and their output are never parsed and nothing from them is kept.

`codex-rs/rollout/src/policy.rs` lists what is written. `exec_approval_request`, `apply_patch_approval_request`, `request_permissions`, `request_user_input`, `elicitation_request`, `error` and `shutdown_complete` are transient and never written. So the files hold no sign that a session is waiting for approval, and no line that says a session has ended.

### The lock folder

`thread-writer-locks/<thread id>.lock`, one per session a Codex process has open. Codex creates it when a process starts or resumes a session and deletes it when the session shuts down (`codex-rs/rollout/src/writer_lock.rs`, `codex-rs/thread-store/src/local/live_writer.rs`). It was added in openai/codex#44138, merged on 2026-09-09, and first shipped in 0.155.0. The same folder holds `.coordination.lock`, which is not a session. The folder is created the first time a Codex of that version opens a session.

The adapter lists the folder and never opens, locks or examines its files: opening one could disturb the lock Codex holds on it.

A crash leaves the lock behind. The next Codex to start removes locks no process holds.

Only a Codex of 0.155.0 or later writes locks, and the folder is shared by every Codex that uses the same Codex folder: the Codex CLI, the IDE extension and the desktop app may each bundle a different version. So a missing lock means a session has ended only when the session was created by a Codex that writes locks. For a session whose `cli_version` is older than 0.155.0, a pre-release of 0.155.0, `0.0.0` (a build from source) or missing, a missing lock says nothing: the status follows the file, as it does when there is no lock folder, and the Sources view says some sessions come from an older Codex. A lock that is there means open, whatever the version.

While the folder is missing or cannot be listed, no session is shown as finished, so one that had finished shows as idle. Such a poll is named apart for the poller (`files-without-locks`, not `files`), and is compared only with polls read the same way. So a listing that fails once does not make every finished session seem to start again and finish, in the Events log or in a notification.

### The names file

`session_index.jsonl`: one line per name given to a session, `{"id":"<thread id>","thread_name":"<name>","updated_at":"<time>"}`. Codex appends a line on each rename, and the newest line for an id wins. It rewrites the file only to remove a session's names (`codex-rs/rollout/src/session_index.rs`). Only `id` and `thread_name` are kept.

## Which sessions are listed

A session is listed while its lock exists, and otherwise for 24 hours after the last line in its file.

`source` says where a session was started. Listed: `cli` and `vscode`, the sources Codex itself treats as interactive; `exec`, for `codex exec` runs; `{"custom":"chatgpt"}`, the ChatGPT desktop app; and any other or missing source. Left out: `{"subagent":...}`, `{"internal":...}` and `mcp` (threads run for another program through `codex mcp-server` or the app-server), any thread with a `parent_thread_id`, and any thread whose `thread_source` is `subagent`, `guardian_review` or `memory_consolidation`. Each of those belongs to a session that is already listed, or is Codex's own work.

Also left out: a session whose last turn line was imported from another agent. It is listed from the first turn Codex runs in it.

| `originator`, then `source`                | Shown as                                 |
| ------------------------------------------ | ---------------------------------------- |
| `originator` `Codex Desktop`, any `source` | Desktop app                              |
| `cli`, `exec`                              | Terminal                                 |
| `vscode`                                   | VS Code                                  |
| `{"custom":"chatgpt"}`                     | Desktop app                              |
| anything else, or none                     | A dash in the list, and no app elsewhere |

## Status

| Last turn line in the file                                       | Lock present, no lock folder, or made by a Codex before 0.155 | Lock gone |
| ---------------------------------------------------------------- | ------------------------------------------------------------- | --------- |
| `task_started`, `turn_started`                                   | Working                                                       | Finished  |
| `task_complete`, `turn_complete`, `turn_aborted`                 | Idle                                                          | Finished  |
| None yet: the file holds only `session_meta` and the like        | Idle                                                          | Finished  |
| Any other `task_` or `turn_` type, or none within the last 8 MiB | Unknown                                                       | Unknown   |

A Codex session is never shown as needing you. The status time is the turn line's time, or the last line's time for a session that is finished or has not begun a turn.

## Known gaps

- A session waiting for approval shows as working. Codex does not write approval waits to its files. Only hooks can see them, and hooks need setup.
- A session whose Codex crashed in the middle of a turn shows as working until the next Codex start removes its lock.
- Finished means no Codex process has the session open. A thread the IDE extension or the desktop app has unloaded shows as finished while it is still in that app's list.
- On Codex older than 0.155 there is no lock folder. Finished cannot be told from idle, sessions leave the list 24 hours after their last line, and a resumed session in a folder older than yesterday is not found. The Sources view says so.
- When an older and a newer Codex share one Codex folder, the older one's sessions are never shown as finished, and leave the list 24 hours after their last line. The Sources view says so. A session an older Codex created and a newer Codex resumed and then closed shows as idle, not finished.
- A new session appears with its first turn, because Codex creates the file then.
- Errors are not shown: Codex does not write them to the file.
- Sessions the Codex desktop app imported from another agent are not listed until Codex runs a turn in one. See below.
- The Codex desktop app writes no `session_index.jsonl`, so its sessions are named after their folder, and several can share a name. See below.

## The desktop apps

Codex's source lists `{"custom":"chatgpt"}` among its interactive sources (`INTERACTIVE_SESSION_SOURCES` in `codex-rs/rollout/src/lib.rs`), so the ChatGPT desktop app's Codex threads are listed if the app writes them into the same Codex folder. That was not checked, and nothing specific to the app is read.

The Codex desktop app, at 0.160.0, was checked on 2026-10-04 by running the adapter against the folder it keeps, `~/.codex`, with no setup. Only the fields named below and the times and types of lines were looked at. No message was read.

- The app writes ordinary session files into `~/.codex/sessions` and a lock into `thread-writer-locks/` for each session it has open, so it needs nothing more than the CLI does.
- Each session's `session_meta` has `"originator":"Codex Desktop"`, `"cli_version":"0.160.0"` and `"source":"vscode"`, not `{"custom":"chatgpt"}`. `source` alone cannot tell this app from the IDE extension; `originator` can, so the adapter shows these sessions as the desktop app. `Codex Desktop` is the client name the app gives Codex's app-server (`codex-rs/app-server/README.md`, `codex-rs/otel/src/auth_storage/originator.rs`).
- The `session_meta` keys were `creator_user_id`, `creator_account_id`, `session_id`, `id`, `timestamp`, `cwd`, `runtime_workspace_roots`, `originator`, `cli_version`, `source`, `thread_source`, `model_provider`, `base_instructions`, `history_mode` and `context_window`. There was no `parent_thread_id`.
- `thread-writer-locks/` held one lock for each session the app had open, and the adapter showed exactly those sessions as idle.
- Some threads had a `thread_source` of `onboarding_checklist`, a value the adapter does not know. They are listed.
- Each turn the app ran wrote a `turn_context` line, and its turn ids were UUIDs.

### Names

There was no `session_index.jsonl` after the app had created its sessions, so the adapter names them after their folder, and sessions in one folder share a name. The app shows a title for each session, so it keeps titles somewhere else. Where was not established: the top-level keys of the app's `.codex-global-state.json` hold settings per thread but none for a title. Whether renaming a session in the app writes `session_index.jsonl` was not checked. Reading another file for titles would widen what PRIVACY.md lists, so it is left to the maintainer.

### Sessions imported from another agent

The app offers to import another agent's past sessions (`codex-rs/external-agent-migration/src/sessions/`). Each imported session is written as a new rollout in today's folder, with every turn it had, and each line is stamped with the time of the import. The import is also recorded in `external_agent_session_imports.json`, whose `records` carry `source_path`, `content_sha256`, `imported_thread_id`, `imported_at`, `source_modified_at`, `connector_names` and `title` (`ledger.rs`). The adapter does not read that file.

The rollout itself marks the import (`export.rs`, `rollout_items_from_messages`):

- every imported turn's `task_started` and `task_complete` lines have `turn_id` `external-import-turn-<n>`, counting from 1;
- the last turn ends with an `agent_message` whose text is `<EXTERNAL SESSION IMPORTED>`, then `token_count`, then `task_complete`;
- there is no `turn_context` line, and `session_meta` has no `creator_user_id` or `creator_account_id`.

When the source session changes, the app may append the new turns to the same thread (`append.rs`); those turns have the same kind of turn id.

The adapter uses the first of these. A session whose last turn line has an imported turn id is left out, whether or not the app has it open: it did not run in Codex, and its times are the time of the import. When Codex runs a turn in it, that turn has a UUID, and the session is listed from then on, with the time it was created in Codex, which is the time of the import. Without this rule, a desktop app that has imported another agent's history would show every imported session as one that had just finished.

## What breaks when Codex changes

| Change in Codex                                              | What the dashboard shows                                                            | Where to fix it                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ---------------------------------- |
| A turn line is renamed                                       | Sessions whose last turn line has the new name show as Unknown                      | `src/core/mapping/codexMapping.ts` |
| The lock folder moves or is renamed                          | No session is finished, and the Sources view says there is no list of open sessions | `writerLocks.ts`                   |
| The names file is renamed or its fields change               | Sessions are named after their folder                                               | `sessionIndex.ts`                  |
| The `sessions/YYYY/MM/DD/rollout-*.jsonl` layout changes     | No sessions are found, or only those in older folders                               | `rollouts.ts`                      |
| `session_meta` moves out of the first 2 MiB or changes shape | Those sessions are left out                                                         | `rolloutFile.ts`                   |
| Live files are compressed, or written to SQLite only         | Those sessions are left out                                                         | `rollouts.ts`, `rolloutFile.ts`    |
| `CODEX_HOME` stops being the root of Codex's state           | Codex is not found, or found empty                                                  | `index.ts`                         |
| Imported turns get another kind of turn id                   | Imported sessions are listed as finished Codex sessions for a day after the import  | `src/core/mapping/codexMapping.ts` |
| The desktop app's `originator` changes                       | Its sessions show as VS Code                                                        | `src/core/mapping/codexMapping.ts` |
| `cli_version` is no longer written, or changes form          | No session is finished, and the Sources view says they come from an older Codex     | `src/core/mapping/codexMapping.ts` |

To check a new Codex version, read `codex-rs/rollout/src/policy.rs`, `writer_lock.rs`, `rollout_file_name.rs`, `session_index.rs` and `recorder.rs`, and `codex-rs/external-agent-migration/src/sessions/export.rs`, at its tag, then compare the dashboard with the sessions in Codex's own `/resume` list.
