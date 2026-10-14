# Antigravity adapter notes

These notes record what Agent Lookout reads from the Antigravity CLI, `agy`, and from Antigravity 2.0, Google's desktop app, where each value comes from, and what breaks when either changes. Start here when an adapter stops working. [Antigravity 2.0](#antigravity-20) has the desktop app's own part.

Written on 2026-10-07 from agy 1.3.1: its `agy --version` and `agy --help`, the text and protocol buffer descriptors inside its program, the documentation it bundles under `builtin/skills/` in its folder, its changelog ([google-antigravity/antigravity-cli](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md), also inside the program up to 1.3.0), and Google's documentation of [hooks](https://antigravity.google/docs/hooks/) and of the [status line](https://antigravity.google/docs/cli/statusline). When the adapter was first written no conversation had been run on that machine, so the files below are as agy documents them and its program describes them, and the tests use hand-written files laid out the same way. On 2026-10-07 one conversation was run there with agy 1.3.1, asked to run a command, and looked at while it waited for approval: by the names, sizes and modified times of its files, by which files its agy program had open (`lsof`), by the fields of each transcript step other than its content, and by the lines of the program's log that say what it does with conversations and approvals. What that showed is marked as seen below. [Not yet checked](#not-yet-checked) lists what is still to be shown, and how to check it.

The code is in `src/collector/adapters/antigravity/`: what both products share in `shared/` (the conversation finder, the transcript reader, the title reader and the session it makes), the CLI's adapter in `cli/` and Antigravity 2.0's in `app/`. The status mapping is in `src/core/mapping/antigravityMapping.ts`, which conversations are open in `src/core/mapping/antigravityLiveness.ts`, and what a program's log says in `src/core/mapping/antigravityLog.ts`.

## How it reads agy, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no agy program run, no network. It lists two folders, looks up when files were changed, reads the end of each recent transcript and each conversation's title, asks `ps` which agy programs run, and reads the log of each.

agy documents several things another program could use, and none of them can be used that way:

| Interface                               | Why it is not used                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks, in `~/.gemini/config/hooks.json` | Need the person to edit that file, which the CLI and its backend share (changelog 1.0.8). The events are `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation` and `Stop`. No hook fires when an approval prompt is shown, and Esc fires no `Stop`.                                                                                    |
| The status line command                 | Needs a change to the person's `settings.json`. Its `agent_state` is `idle`, `thinking`, `working`, `tool_use` or `initializing`, with no waiting value. Its `transcript_path` points into `~/.gemini/antigravity/` instead of `antigravity-cli/` (google-antigravity/antigravity-cli#744, open).                                               |
| `conversation_summaries.db`             | SQLite, with a row for each conversation: its `title`, `workspace_uris`, `status`, `not_fully_idle`, `killed` and more. It also holds `preview` and `raw_summary`, which hold prompt text. `node:sqlite` needs a flag on Node 22.12. The CLI's is not read; Antigravity 2.0's is, for two columns, with `sqlite3`, as [Folders](#folders) says. |
| `conversations/<id>.db`                 | The conversation's own SQLite database, in WAL mode, described for agy 1.0.16 as holding a `steps` table with each step's payload, which holds the content. The same reasons apply. The CLI's is only looked at for its modified time; Antigravity 2.0's is read for the place and status of its newest step, as [Waits](#waits) says.          |
| `agy` itself                            | Has no command that lists conversations, and running it signs in to Google.                                                                                                                                                                                                                                                                     |

## What it reads

| Path, under the agy folder                           | How                                                                                                                        | How often                                                                                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The agy folder itself                                | One `stat`. Not done when `AGENT_LOOKOUT_ANTIGRAVITY_HOME` is set                                                          | On the first poll, then at most once a minute while it is missing, and on each poll while it has no `brain/`                                          |
| `brain/`                                             | Listed                                                                                                                     | Every poll                                                                                                                                            |
| `conversations/`                                     | Listed                                                                                                                     | Every poll                                                                                                                                            |
| `brain/<id>/.system_generated/logs/transcript.jsonl` | `lstat`, then opened read-only: the first line within 256 KiB, the first 4 KiB, the last 2 MiB, then only what is appended | `lstat` every poll for a conversation changed in the last day or that may be open, else every 30 seconds; read when its size or modified time changes |
| `conversations/<id>.db` and `<id>.db-wal`            | `lstat` only, for the modified time, for Quiet for. Never opened                                                           | As the transcript's `lstat`                                                                                                                           |
| `annotations/<id>.pbtxt`                             | `lstat`, then opened read-only when it is an ordinary file of at most 4 KiB, for its `title`                               | `lstat` every poll for each conversation shown; read when it changes                                                                                  |
| `log/`                                               | Listed                                                                                                                     | While `ps` shows an agy program, on each poll until every such program's log is found                                                                 |
| `log/cli-YYYYMMDD_HHMMSS.log`                        | `lstat`, then opened read-only: at most the last 4 MiB, then only what is appended                                         | Every poll, for the log of each agy program `ps` shows; read when its size or modified time changes                                                   |
| `antigravity-ide`, beside it                         | One `lstat`, for whether it is there. Nothing in it is opened, listed or watched                                           | On the first poll, then at most once a minute                                                                                                         |

A transcript is opened with `O_NOFOLLOW` and `O_NONBLOCK` and read only if the open file is an ordinary file, so a link, a pipe or a device named like a transcript is never read and cannot stall a poll.

It never reads `~/.gemini/oauth_creds.json`, `google_accounts.json`, `settings.json`, `config/hooks.json`, `history/` or any `history.jsonl`, nor, in the agy folder, `conversation_summaries.db`, any `.db`, `.db-wal` or `.db-shm` file, `transcript_full.jsonl`, `cli.log`, the log of an agy program that is not running, `jetski_state.pbtxt`, `jetbox_summaries_proto.pb`, `installation_id`, `updater/`, `presence/`, any other file in `annotations/`, `implicit/`, `crashes/` or anything else in a conversation's folder.

### The agy folder

`AGENT_LOOKOUT_ANTIGRAVITY_HOME` if set, otherwise `~/.gemini/antigravity-cli`. The [hooks documentation](https://antigravity.google/docs/hooks/) gives each product an app data folder of its own, `<app_data_dir>`:

| Product                                                 | Folder                      | Read                                 |
| ------------------------------------------------------- | --------------------------- | ------------------------------------ |
| The Antigravity CLI, `agy`                              | `~/.gemini/antigravity-cli` | Yes                                  |
| The Antigravity IDE, the editor                         | `~/.gemini/antigravity-ide` | No. Only whether the folder is there |
| Antigravity 2.0, the desktop app with the Agent Manager | `~/.gemini/antigravity`     | Yes, by a source of its own          |

A 1.x Antigravity IDE kept its files in `~/.gemini/antigravity` too, so that folder may be 2.0's or left from an older IDE. On Windows the folders are in `%USERPROFILE%\.gemini`.

When the folder is missing, the Antigravity CLI is reported as not found, with no advice, and the folder is looked for again once a minute. Polls in between touch nothing, and no `ps` is run. A folder named by `AGENT_LOOKOUT_ANTIGRAVITY_HOME` with no `brain/` in it is an answer, not a missing agy: the source is watched and lists no sessions.

When the agy folder is the one read for Antigravity 2.0, as when `AGENT_LOOKOUT_ANTIGRAVITY_HOME` names `~/.gemini/antigravity`, its case aside on macOS and Windows, the CLI's source reads nothing and runs no `ps`, so each chat is listed once, under Antigravity. Its card says: "Agent Lookout reads ~/.gemini/antigravity for Antigravity too, so what is in it is listed under Antigravity alone."

### The IDE's folder

Agent Lookout does not read the Antigravity IDE yet. So that Sources can say why its sessions do not appear, `cli/otherFolders.ts` looks for `antigravity-ide` beside the agy folder, with one `lstat`, on the first poll and then at most once a minute. While the agy folder is missing, it is looked at only on a poll that looks for that too. A link in the folder's place counts as there and is not followed. A file of that name, or a path that cannot be looked at, counts as not there. Nothing in it is opened, listed or watched, and only whether it is there is kept. Antigravity 2.0's folder is no longer looked at here: its own source reads it.

When it is there, the CLI card's note ends with a sentence that says so, whether the CLI is found or not: "The Antigravity IDE's folder is here, ~/.gemini/antigravity-ide. Agent Lookout does not read the IDE yet." It says the folder is there, not that the product is used, since a folder can be there and hold nothing. With `AGENT_LOOKOUT_ANTIGRAVITY_HOME` set, it looks beside the folder that names instead.

On a machine where agy 1.3.1 was installed and had run no conversation, the folder held empty `conversations/`, `brain/` and `crashes/` folders, `conversation_summaries.db`, `installation_id`, `last_check.timestamp`, `jetski_state.pbtxt`, `cli.log` (a link to `log/cli-YYYYMMDD_HHMMSS.log`, one log for each process), `updater/`, `cache/`, `bin/` and `builtin/`.

Seen once a conversation had been run there, while its agy program was still running: `brain/<id>/` with `.system_generated/logs/transcript.jsonl`, `transcript_full.jsonl` and `chunks/` folders beside it; `conversations/<id>.db`, with no `-wal` or `-shm` file beside it, and last changed half a minute after the transcript; and new beside them, `presence/<id>.lock`, an empty file, `annotations/<id>.pbtxt`, `implicit/`, `history.jsonl` and `jetbox_summaries_proto.pb`. The program held `presence/<id>.lock` open, with a lock of its own, and neither the conversation's database nor its transcript. Its standard output and error went to its log.

### Transcripts

Path: `brain/<conversation id>/.system_generated/logs/transcript.jsonl`, with the id a UUID. The hooks documentation gives it as `<app_data_dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`, and the program's own instructions to its agents give the same, with `transcript_full.jsonl` beside it.

The program's instructions describe the format: "Each line is a single JSON object representing one "step"". Its fields:

- `step_index`, the step's place in the conversation
- `source`: `USER_EXPLICIT`, `USER_IMPLICIT`, `MODEL`, `SYSTEM` or `SYSTEM_SDK`
- `type`, such as `USER_INPUT`, the person's prompt, and `PLANNER_RESPONSE`, the model's reply and the tool calls it asks for
- `status`, such as `DONE` or `ERROR`
- `created_at`, an ISO 8601 time
- `content`, `thinking`, `tool_calls` and `media`
- `truncated_fields`, only when something was cut short; `transcript_full.jsonl` has it whole

Values are written without the `CORTEX_STEP_TYPE_` and `CORTEX_STEP_STATUS_` prefixes the program uses. The adapter reads them in any case, with or without the prefix.

The program defines 118 step types (`CortexStepType`) and twelve statuses (`CortexStepStatus`): `UNSPECIFIED`, `PENDING`, `RUNNING`, `DONE`, `INVALID`, `CLEARED`, `CANCELED`, `ERROR`, `GENERATING`, `WAITING`, `QUEUED` and `INTERRUPTED`. Its own text says a step whose status is `WAITING` is waiting for the person's approval. Both lists are in `antigravityMapping.ts`.

The adapter parses each line it reads and keeps `type`, `status`, `step_index`, `created_at` and whether `tool_calls` is empty, and from a reply its [token counts](#token-counts). It drops the rest at once. It never keeps `content`, `thinking`, `media`, `source` or a tool call's arguments.

- The file is not only appended to. agy rewrites it when it compacts a conversation (changelog 1.1.13). A file that shrank, is a new file, or whose first 4 KiB changed is read afresh.
- A line can be broken: 1.1.13 fixed a compaction that left malformed JSON in the saved transcript, and 1.2.14 fixed resuming a conversation with a step missing after a crash or an interrupted write. A line that does not parse is passed over.
- A last line with no newline is used only if it is already a whole step.
- Before 1.2.4, a step that ended in `ERROR` could be left out of the file.

### Token counts

Seen on 2026-10-13 in one transcript of agy 1.3.1 and two of the Antigravity 2.0 app of October 2026, ten replies in all, by a check of the numbers alone: a reply's step, `PLANNER_RESPONSE`, carries three whole numbers, `input_tokens`, `cache_read_tokens` and `output_tokens`, and no other step carries a token count. `input_tokens` is only the part of the prompt not read from a cache: one reply's `cache_read_tokens` was larger than its `input_tokens`. Neither product documents these keys.

So a session's Tokens are its newest reply's, as for Codex:

| Shown  | From                                            |
| ------ | ----------------------------------------------- |
| In     | `input_tokens` and `cache_read_tokens` together |
| Cached | `cache_read_tokens`                             |
| Out    | `output_tokens`                                 |

`readStepLine` in `shared/transcriptFile.ts` keeps these three numbers from a reply's line and nothing more, and `tokenCountsOf` in `src/core/tokens/tokenCounts.ts` checks them.

- A tool step after a reply keeps the reply's counts: they are held apart from the last step.
- A reply that names none of the three changes nothing, and a reply agy cleared or marked invalid is passed over.
- Counts that could not be right give a dash, never an older reply's: a count that is negative or not a whole number, a missing `input_tokens` or `output_tokens`, or a whole prompt of 0, with `input_tokens` 0 and `cache_read_tokens` 0 or left out. A `cache_read_tokens` that is left out counts as 0, and the cached part is left out.
- Nothing is summed: there are no totals.
- The newest reply is noted as the tail is read for the last step. When none has been found by the start of the run of steps that say the same, at most 256 KiB more of the file is read for one, within the 2 MiB.

### A program's log

Each agy program writes a log of its own to `log/cli-YYYYMMDD_HHMMSS.log`, named for the local time it started; `cli.log` is a link to the newest. Seen: a program `ps` said started at 12:58:33 wrote `cli-20261007_125834.log`. Its lines are in the glog format, `I1007 13:00:19.223691     787 tool_confirmation_manager.go:226] message`: the level, the month and day, the local time, a thread, the source line and the message. Seen in that log, in this order:

- `Creating CLI server backend: product=antigravity workspaceDirs=[<folder>] …`, once, at the start: the folder agy was started in.
- `Created conversation <id>` and `Streaming conversation <id>`, when it began the conversation. `Streaming` also follows a switch of conversation, by agy's own words.
- `Surfacing tool confirmation: "RunCommand" at step 2`, when it asked whether to run the command. The transcript then ended at step 1, the reply that asked for the tool, with status `DONE`. No step 2 was written while the prompt was on screen, and nothing was written with status `WAITING`.
- `Responding to tool confirmation: convID=<id>, stepIdx=2, approved=true, sandboxOverride=false, persistGrants=[]`, from `input_loop.go`, when the person approved. The transcript then held step 2, the command, with the time it began, and step 3, the reply.

The rest of the log is requests to Google's servers, errors and what the program does, and is passed over.

The adapter reads a log only when it can tie it to one running program: the program `ps` shows started in the 10 seconds before the log's name, or up to 2 seconds after it, since the start `ps` gives can be late, and no other program could have written it, nor the program another log. `log/` is listed again every 10 seconds and whenever `ps` shows another program, so a log named late, or a second one that makes a match unsure, is seen. A program started in the hour a clock set back repeats is matched to no log. A log is read from its start, at most its last 4 MiB, and then only what is added; the rest of a line longer than 64 KiB is passed over to its newline. Each line is matched against the lines above by its message and by the source file it names, never the line number, which moves between versions, and is then dropped. glog writes a message that holds newlines as it is, and agy's own output goes to the log too, so text agy logs could be written to look like one of these lines. So each kind is taken only from the file agy writes it from, `server.go`, `conversation_manager.go`, `tool_confirmation_manager.go` or `input_loop.go`; the folder only from the first line that names one, and only an absolute path with no space, control character or mark that turns text around; and an approval only for a step at most 2 past the transcript's last, so a line made to look like one can at most show a wait that ends with agy's next step. What is kept is the folder, the conversations opened, the one open now, and an approval asked for and not yet answered: its conversation, step, tool and time (`antigravityLog.ts`).

### Titles

`annotations/<id>.pbtxt`, seen holding only `title:"List Directory Contents"` for the conversation it names, in protocol buffer text format. The title is read with its escapes undone, as UTF-8, and cleaned and cut as any session's name is. agy wrote it once the conversation had its first reply.

## Which conversations are listed

A conversation is listed when its transcript is there and is an ordinary file, and its transcript was written in the last 24 hours or an agy program may have it open. Only the transcript's time counts: only the program running a conversation adds steps to it, while agy writes the database at other times too, as when a program exits (changelog 1.1.26), and it was seen written half a minute after the transcript. A conversation none of whose three files changed for a day is looked at again every 30 seconds, so one resumed after a day is found within that.

Subagents: the program's instructions say a subagent's conversation can be found by searching a transcript for `invoke_subagent`. Whether agy gives a subagent a folder of its own in `brain/` was not checked. If it does, a subagent shows as a session of its own.

## Status

The status comes from the last step that says how the conversation stands. These are passed over: `CHECKPOINT`, `EPHEMERAL_MESSAGE`, `CONVERSATION_HISTORY`, `SYSTEM_MESSAGE`, `SUGGESTED_RESPONSES`, `KNOWLEDGE_ARTIFACTS`, `KNOWLEDGE_GENERATION`, `KI_INSERTION`, `DIRECTORY_RULES`, `BRAIN_UPDATE`, `DUMMY` and `CIDER_AGENT_DUMMY`, and any step whose status is `CLEARED` or `INVALID`.

| Last step                                                                            | While agy may have it open | Once none could |
| ------------------------------------------------------------------------------------ | -------------------------- | --------------- |
| `ERROR_MESSAGE`, or `PLANNER_RESPONSE` with status `ERROR`                           | Failed                     | Failed          |
| Status `PENDING`, `RUNNING`, `GENERATING`, `QUEUED` or `WAITING`                     | Working                    | Finished        |
| Status `CANCELED` or `INTERRUPTED`                                                   | Idle                       | Finished        |
| `PLANNER_RESPONSE`, `DONE`, with no tool call                                        | Idle                       | Finished        |
| `FINISH`, `DONE`                                                                     | Idle                       | Finished        |
| `USER_INPUT`, `DONE`                                                                 | Working                    | Finished        |
| `PLANNER_RESPONSE`, `DONE`, with a tool call                                         | Working                    | Finished        |
| Any other step type agy 1.3.1 defines, `DONE` or `ERROR`                             | Working                    | Finished        |
| No step yet: an empty file, or only steps passed over                                | Idle                       | Finished        |
| A type or status it does not know, `UNSPECIFIED`, or none read within the last 2 MiB | Unknown                    | Unknown         |

A session needs you, for permission, while its program's log says it asked for approval of a tool and was not answered, and the step that waits is just past the transcript's last step, at most 2 past it. agy was not seen to write that step while the prompt was on screen, so a step there means the wait is over, however it ended, and an approval asked for further ahead is not taken for agy's. The detail is the tool's name as agy logs it, such as `RunCommand`, and the wait began when the log says agy asked. A conversation agy is known to have closed is finished, whatever its log last said, and the log of a program that has ended is read only until `ps`, asked at most every 10 seconds, no longer shows it. `WAITING` in a transcript, which was not seen, still shows as working.

A tool step that ends in `ERROR`, such as a command that fails or a file that is not there, shows as working: the agent reads the error and goes on, so a session is not shown as failed for a moment each time a tool fails. A turn that does end on such a step shows as working until agy is closed.

The status time is when the steps at the end of the file that say the same began: a working session since its turn's first step, an idle one since the step that ended its turn, a failed one since the error. A step's `created_at` is when it began, so an idle session's time is when its last reply began. A finished session has been so since its last step. When the run of steps goes back further than the 2 MiB read, its time is not known.

## Which conversations are open

agy 1.3.1 keeps what may be a mark of an open conversation, `presence/<conversation id>.lock`: a running agy was seen holding it, locked, for the conversation it had open. When it is made, whether it moves with `/new` and `/resume`, and whether it goes at `/exit` or stays after a crash are not yet checked, so it is not read ([Not yet checked](#not-yet-checked)). Each program's log says which conversation it opened last, and that is read instead.

So the adapter runs `ps -A -o pid=,ppid=,lstart=,comm=` in UTC, at most every 10 seconds while there is a conversation to show, and sooner, though not within 2 seconds of the last run, when a conversation is written that no agy program it knows of could have open. It keeps the processes whose program is named `agy`, and leaves out one started, directly or through other agy programs, by an agy program that runs a session, since it belongs to that session. One started by an agy program that is not a session, such as the `remote-control` service, counts as a session of its own when its command line says so. For each agy program it has not seen before it runs `ps -o pid=,args= -p <ids>` and reads the command line for two things: whether it is one of agy's own commands, `agent`, `agents`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin`, `plugins`, `remote-control` or `update`, or `--help` or `--version`, which are not sessions; and the conversation it names with `--conversation <id>`. `ps` joins arguments with spaces, so the first word after the program decides: a prompt given with `-p` comes after `-p`.

Then (`antigravityLiveness.ts`):

- A program that names a conversation may have it open. One whose log has opened a conversation names that one, the last it opened, in place of what its command line named.
- A program may have open any conversation whose transcript was written since it started: the one it began, one it moved to with `/new` or `/resume`, or, as far as the files can tell, one another agy program wrote to and has since closed.
- A conversation whose transcript was written since `ps` was last asked may be open in a program started since, which `ps` has not shown yet, so it is not closed until `ps` is asked again.
- A conversation no program could have open is closed, and shows as finished, or failed.
- A program that names none, by its command line or its log, and has written none since it started, as just after it starts, or when the first thing it does is `/resume` an older conversation and its log does not say so, could have any conversation open, and so could a program whose start is not known. While one runs, no conversation is shown as finished. Such a poll is named apart for the poller (`files-unmatched`), and is compared only with polls read the same way, so finished conversations do not seem to start again and finish.
- A program that has written to one conversation and then moves to an older one with `/resume` holds the older one only once it writes to it. Until then it can show as finished.
- When `ps` cannot be asked, as on Windows, no conversation is shown as finished either (`files-without-processes`).

This errs towards open. With one agy program left open all day, every conversation it wrote to since it started stays open until it ends.

## Names, folders and apps

A session is named by the title agy gave the conversation, from its annotation file; else by the name of its folder; else by its conversation id, which `agy --conversation <id>` takes. Its folder is the one its program's log names, which gives its project and its branch. A conversation whose program has ended, or whose log the adapter cannot tie to it, has no folder. Its app is the terminal.

## Quiet for

A session's `lastWriteAt` is the newest modified time of its transcript, its database and its database's log, from the `lstat`s made on each poll. agy writes to its database as it works (`PRAGMA journal_mode = WAL` in its program, and changelog 1.1.26 on flushing it at exit), and may do so before it writes the transcript. A time from before the conversation's first step, or ahead of the clock, is not used. Only Quiet for uses the database's times: which conversations are listed and which may be open go by the transcript's.

## Known gaps

- A session waiting for an answer to a question it asked shows as working: whether agy logs a question as it logs an approval is not yet checked.
- A wait shows for up to 10 seconds after its program ends, until `ps` is asked again.
- A session has no folder once its program has ended, or when two agy programs started in the same 10 seconds, and is named by its conversation id until agy gives it a title.
- A log longer than 4 MiB is read only near its end, where the folder and the conversation opened may not be, so its session shows no wait.
- A conversation one agy program wrote to and left, with `/new` or `/resume`, stays open until that program ends.
- A conversation reopened with `/resume` in an agy program that has already written to another can show as finished until agy writes to it.
- While an agy program runs that has written nothing since it started, no conversation is shown as finished.
- agy's `remote-control` service: if it runs conversations in its own program, which `ps` shows as `agy remote-control …`, they show as finished while they run. If its command line begins with anything else, it counts as a session, and while it has written nothing since it started, no conversation is shown as finished.
- On Windows no conversation is shown as finished.
- `ps` is asked only while some conversation was written in the last day, so a conversation agy has kept open, unwritten, for more than a day is listed only while another one is recent.
- A tool that fails shows as working. Only an error agy reports as its own step, or a failed reply, shows as failed.
- The Antigravity IDE is not read. Only whether its folder is there is checked, as [The IDE's folder](#the-ides-folder) says. Antigravity 2.0 is read by a source of its own, [below](#antigravity-20).
- No Jump, no Stop and no Answer: agy takes the answer to its prompt only in its terminal.
- What a session last said is not read yet. `GET /api/sessions/last-message` answers `not-read` for an Antigravity CLI session.
- Tokens show a dash while the newest reply is further back than the part read for it, until the next reply.

## Not yet checked

Each of these needs a real conversation, and each says what changes if it turns out otherwise:

1. Whether `brain/<id>/` and `conversations/<id>.db` appear on 1.3.1, and when: at start, at the first prompt or at the first step. If late, a new agy program holds every conversation open until it writes.
2. Whether `type` and `status` are written without the prefix and in capitals. The adapter reads either, so only a different field name would break it.
3. Whether the transcript is written while a step runs, or only when it ends. If only at the end, a long step shows the step before it, and `RUNNING` is never seen.
4. What an open `ask_question`, Esc at an approval prompt and `/exit` each write, to the transcript and to the log. Seen for an approval wait: no step is written while the prompt is on screen, and the log says `Surfacing tool confirmation`; once it is approved, the log says `Responding to tool confirmation`, and the step that waited is written. Not yet seen: a denial, and Esc at the prompt.
5. What `status` in `conversation_summaries` holds, and whether `not_fully_idle` and `killed` change. These could give titles, folders and finished, read-only.
6. Whether one program keeps one conversation after `/new` or `/resume`. A running agy was seen holding open `presence/<id>.lock` for its conversation, and not the conversation's `.db`. If agy makes that file when a conversation opens, moves it with `/new` and `/resume`, and lets it go at `/exit`, conversations could be matched to programs exactly, which would settle the `/resume` gap, the `remote-control` service and an agy left open all day. Whether a crash leaves it behind decides whether it can be trusted alone. Whether `/new` and `/resume` each log `Streaming conversation <id>` decides whether a program's log names the conversation it has open after them: if `/resume` does not, a conversation resumed in a program whose log names another shows as finished until agy writes to it.
7. How often an idle conversation does not end with a `PLANNER_RESPONSE` with no tool call. Issue #69 cites 18 of 103 conversations from older versions that did not.
8. Whether `/resume` changes any file of other conversations: their `.db`, a `-wal` or `-shm` beside it, or their transcript, while its picker is open. If it does, and it is the transcript, every conversation it shows is held open while that program runs.
9. What `ps` shows for the `remote-control` service, and whether a turn started from a Remote Control companion runs in that program or in an agy program it starts.
10. Whether an error agy retries by itself, such as a `503` from the model, writes an `ERROR_MESSAGE` step before agy goes on. If it does, a session shows as failed for a moment, which can send a Failed notification.
11. Whether `output_tokens` counts the reply's `thinking`. If it does not, Out leaves the reply's thinking out.

To check, in a scratch folder, with agy's default permission mode, run `agy`. After each step below, from another terminal, note these, and only these fields, never the content:

```sh
ls -laR ~/.gemini/antigravity-cli/conversations ~/.gemini/antigravity-cli/brain ~/.gemini/antigravity-cli/presence
ps -axo pid,ppid,lstart,args | grep '[a]gy'
lsof -p <pid> | grep -E 'conversations|brain|presence'
tail -n 4 <transcript.jsonl> | jq -c '{step_index,type,status,source,created_at,tc:(.tool_calls|length)}'
grep -E 'conversation [0-9a-f-]{36}$|tool confirmation|workspaceDirs' ~/.gemini/antigravity-cli/log/<the program's log>
sqlite3 'file:<agy folder>/conversations/<id>.db?mode=ro' 'select idx,step_type,status from steps order by idx desc limit 5'
sqlite3 'file:<agy folder>/conversation_summaries.db?mode=ro' 'select conversation_id,status,step_count,not_fully_idle,killed,last_modified_time from conversation_summaries'
```

1. Ask it to reply with one word, and note once it has answered: expected idle.
2. Ask it to run `ls` and say how many entries there are. Note while it asks whether to run the command, then approve and note again.
3. Ask it to use its ask-question tool to ask which of two files you prefer. Note while the question is open, then answer.
4. Ask it to run `sleep 30` and then say done. Approve, press Esc during the sleep, and note.
5. Ask it to view a file that does not exist. Note.
6. Type `/exit` and note at once, with whether `.db-wal` shrinks, whether the summaries row changes and whether the `presence/` file goes.
7. Run `agy --conversation <id>` and check that `ps` shows the id. Then run `/new` in it and check whether the same program writes to a new folder in `brain/`, and which `presence/` file it holds.
8. In that program, which has now written, open `/resume` and note, with the picker open, whether any other conversation's `.db`, `-wal`, `-shm` or transcript appears or changes. Then pick an older conversation, and before typing anything, note whether any of its files, its `presence/` file included, changes.
9. Run `agy remote-control start`, and note its `ps` line and its parent. Start a turn from a Remote Control companion, if you have one, and note which program writes the conversation.
10. If agy shows it is retrying an error from the model, note the last steps of the transcript while it does and once it goes on.

Then run Agent Lookout against the same folder and compare its Sources card and sessions with what was noted.

## What breaks when Antigravity changes

| Change in agy                                                    | What the dashboard shows                                                           | Where to fix it                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- |
| A step type or status is added or renamed                        | Conversations whose last step has it show as Unknown, and the Sources card says so | `src/core/mapping/antigravityMapping.ts`              |
| The transcript moves, or `brain/` is renamed                     | No conversations are found                                                         | `shared/conversations.ts`                             |
| The transcript's fields are renamed                              | Conversations show as Unknown                                                      | `shared/transcriptFile.ts`                            |
| Transcripts are written only to SQLite                           | No conversations are found                                                         | `shared/conversations.ts`, `shared/transcriptFile.ts` |
| The program is no longer named `agy`, or its commands change     | Every conversation shows as finished, or a daemon holds conversations open         | `cli/agyProcesses.ts`                                 |
| A program agy starts is named `agy` and is not under another agy | While it runs, no conversation is shown as finished                                | `cli/agyProcesses.ts`                                 |
| `--conversation` is renamed                                      | Nothing, unless no other program has written since it started                      | `cli/agyProcesses.ts`                                 |
| `~/.gemini/antigravity-cli` stops being the CLI's folder         | The Antigravity CLI is not found, or found empty                                   | `cli/index.ts`                                        |
| The IDE's folder is renamed or moved                             | The card no longer says that folder is there                                       | `cli/otherFolders.ts`                                 |
| The log's lines, its name or its format change                   | No session needs you, and sessions have no folder                                  | `antigravityLog.ts`, `cli/agyLogs.ts`                 |
| The annotation file moves or changes format                      | Sessions are named by their folder or conversation id                              | `shared/annotations.ts`                               |
| A reply's token keys are renamed                                 | Tokens is a dash in every session's details                                        | `shared/transcriptFile.ts`                            |
| `input_tokens` starts to count the part read from a cache        | Tokens shows more input than the context in use                                    | `shared/transcriptFile.ts`                            |

To check a new agy version, read its changelog for the transcript, compaction, `/resume` and the process, run `agy --help` for its commands, and make the check above.

## Antigravity 2.0

Antigravity 2.0 is Google's desktop app with the Agent Manager, shown in Agent Lookout as Antigravity, source `antigravity-app`. Written on 2026-10-12 from a check of one Mac with Antigravity 2.0 installed beside Antigravity IDE 2.5.5: the names of the app's files and folders, the names of the fields and tables in them, the values of a few kinds, such as a step's `type` and `status`, and the program names of its processes. No prompt, reply, title, path or ID was looked at, and none is in this repository: the tests use hand-written files laid out the same way. A chat that ran there was in Antigravity 2.0, not the IDE, whose own folder held no conversation. The code is in `src/collector/adapters/antigravity/app/`.

### Its folder

`AGENT_LOOKOUT_ANTIGRAVITY_APP_HOME` if set, otherwise `~/.gemini/antigravity`. Seen at its top level: `agyhub_summaries_proto.pb`, `annotations/`, `antigravity_state.pbtxt`, `bin/`, `brain/`, `builtin/`, `cache/`, `conversation_summaries.db`, `conversations/`, `crashes/`, `installation_id`, `lib/` and `scratch/`. Each chat has the CLI's layout: `brain/<id>/.system_generated/logs/transcript.jsonl`, with `transcript_full.jsonl` and `chunks/` beside it and `messages/`, `steps/` and `tasks/` near it, `conversations/<id>.db`, a SQLite database, and `annotations/<id>.pbtxt`, whose top-level `title` is the chat's title. So the CLI's readers in `shared/` serve it: the folder listing, the 24-hour rule and the 30-second look at older chats, the transcript's bounded reads, the title, and the times of `<id>.db` and `<id>.db-wal` for Quiet for. When the folder is missing, Antigravity is reported as not found and looked for again once a minute, as the CLI is.

### Transcripts

Seen: lines with `step_index`, `source`, `type`, `status`, `created_at`, `content` and `thinking`, as the CLI writes them, with `input_tokens`, `cache_read_tokens` and `output_tokens` on the model's replies, and `truncated_fields` on the lines under `chunks/`. `type` was `USER_INPUT` or `PLANNER_RESPONSE`, `status` `DONE`, without a prefix. The token counts are read as the CLI's are, as [Token counts](#token-counts) says. While a chat was at work, its transcript held only the steps that were done, and its `steps/` folder was ahead of it: a step is written to the transcript only once it is done.

### Status

The CLI's table applies, from `antigravityMapping.ts`, with three differences, each in `mapAntigravityStatus` or `app/index.ts`:

- A chat whose last step says idle is working while any of its transcript, its database and the database's log was written in the last 10 seconds (`WRITING_MS`), since the step under way is not in the transcript yet. The app was seen to write a step that waits for approval into the database before the transcript, as [Waits](#waits) says. Whether it writes the database while other steps run has not been seen yet. So a chat that has just answered shows as working for up to 10 seconds more, and a chat whose files are written while it waits can show as working. If the app also writes the database later, as agy has been seen to half a minute after the transcript, an idle chat shows as working for 10 seconds then too.
- Needs you comes from the chat's database, as [Waits](#waits) says, not from a log, and is shown unless the app is known to be closed or the transcript's last step failed, reads as unknown, or was not found.
- Open and closed come from the app's one program, not from one program for each conversation, as [Liveness](#liveness) says.

### Liveness

The app runs every chat's agent in one program, its hub: on macOS `Contents/Resources/bin/language_server` inside `Antigravity.app`, seen in `/Applications`. The Antigravity IDE runs its own language server from `Antigravity IDE.app/Contents/Resources/app/extensions/antigravity/bin/`, which is another program. The hub's arguments hold a secret, so they are never read: `app/hubProcess.ts` runs `ps -A -o comm=`, which prints only the name each process gives its program, on macOS its first argument, and takes a line for the hub when it is a full path ending in `/Antigravity.app/Contents/Resources/bin/language_server`. So the hub is found wherever the app is: in `/Applications`, `~/Applications`, another folder or disk, or the folder macOS runs an app opened from Downloads in (App Translocation). Only `/Applications` has been seen. While the hub runs every chat is open; once it is not, every chat is finished, or failed. A chat written after `ps` last said the app was closed counts as open until `ps` is asked again, at most every 10 seconds, and sooner, though not within 2 seconds of the last run, after such a write. Closing the app finishes every chat at once, and opening it again shows them all as open, so a poll made while `ps` says the app is closed is named `files-app-closed` and compared only with the last poll made while it was closed. So closing the app sends no Finished for each chat of the last day, however often it is opened and closed. On Linux and Windows the hub's place is not known yet, so `ps` is not run and no chat is shown as finished; the poll is named `files-without-processes`.

### Folders

`conversation_summaries.db` is the app's own list of chats, a SQLite database whose table `conversation_summaries` has `conversation_id`, `title`, `preview`, `step_count`, `last_modified_time`, `workspace_uris`, `status`, `source`, `project_id`, `agent_name`, `parent_conversation_id`, `nesting_depth`, `battle_id`, `winning_conversation_id`, `not_fully_idle`, `killed`, `last_user_input_time`, `last_user_input_step_index`, `app_data_dir`, `raw_summary` and `group_id`, beside text search tables, `conversations_fts`, which hold the chats' text. Seen: `workspace_uris` a JSON list of `file:///` addresses, or empty, and `status` `CASCADE_RUN_STATUS_IDLE`, one of five the program names.

`app/summaries.ts` reads `conversation_id` and `workspace_uris` alone, with the system's `sqlite3`, from fixed places, `/usr/bin/sqlite3` first, never `PATH`, and never on Windows:

```sh
sqlite3 -init /dev/null -batch -json 'file:<folder>/conversation_summaries.db?mode=ro&immutable=1' \
  'SELECT conversation_id, workspace_uris FROM conversation_summaries'
```

Seen on that Mac: `file:<path>?immutable=1` opened the database, and `-readonly` with `?mode=ro` did not, with "unable to open database file (14)", while no `-wal` or `-shm` file was beside it, since a reader of a database in WAL mode otherwise makes its `-shm`. `immutable=1` takes no lock and makes no file. `mode=ro` is added so a database that is not there is never made: with `immutable=1` alone, `sqlite3` makes an empty one. `?mode=ro&immutable=1` was checked on a database in WAL mode with no side files, made for the tests, not on the app's own. `immutable=1` also means the app's `-wal` file is not read, so a chat begun a moment ago may have no folder until the app moves its writes into the database, and a read made while it does can fail. The folder is the first address in `workspace_uris` that is a local absolute path. The database is looked at with `lstat` on each poll that shows a chat, and read again only when its size or modified time changes after a read that worked, or a minute after a read that did not work, whether it changed or not, so a `sqlite3` that cannot read it, such as one too old to know `-json`, is not run on every change. With no `sqlite3`, or when it fails, chats show without a folder, and the card says so.

### Waits

`conversations/<id>.db` is each chat's own SQLite database. Its table `steps` has a row for each step: `idx`, `step_type`, `status`, `has_subtrajectory`, `metadata`, `error_details`, `permissions`, `task_details`, `render_info`, `step_payload` and `step_format`, with `step_type` and `status` numbers from the program's `CortexStepType` and `CortexStepStatus`. Seen on 2026-10-13, while the app asked to approve a command and said it was waiting for user input: the newest step, by `idx`, had status 9, `CORTEX_STEP_STATUS_WAITING`, and type 132, `CORTEX_STEP_TYPE_GENERIC`, not `RUN_COMMAND`, with `permissions` empty. The transcript held only the steps before it, and the app's list of chats said `CASCADE_RUN_STATUS_RUNNING`. The database was in WAL mode, with no `-wal` or `-shm` file beside it for the hours the wait lasted.

`app/waits.ts` reads two numbers of the newest step alone, with the same `sqlite3` as [Folders](#folders):

```sh
sqlite3 -init /dev/null -batch -json 'file:<folder>/conversations/<id>.db?mode=ro&immutable=1' \
  'SELECT idx, status FROM steps ORDER BY idx DESC LIMIT 1'
```

A chat whose newest step has status 9 needs you, for permission, with no detail, since the step's payload, which holds what it asks, is never read. It has waited since the database's modified time when that step was first seen to wait. The database is read only for a chat that is shown and whose app is not known to be closed, again only when its size or modified time changes after a read that worked, or a minute after one that did not, and not while its `-wal` file is there, since `immutable=1` would not see what that file holds: the chat then shows as it would without it. With no `sqlite3`, or when it fails, a chat that waits shows as working or idle, and the card says so. Nothing is read on Windows.

### Its gaps

- No Jump, no Stop and no Answer. Needs you does not say what a chat asks, and is not shown on Windows.
- On Linux, where the app is never known to be closed, a chat the app left waiting when it quit or crashed shows as needing you until its transcript is a day old, unless its database changes.
- No chat is shown as finished on Linux or Windows, and on Windows none has a folder.
- A chat with `nesting_depth` above 0, a subagent's, would show as a chat of its own if it has a transcript of its own. None was seen.
- A 1.x Antigravity IDE's chats left in the same folder are listed as the app's, if their transcript was written in the last day.
- The app's logs, in `~/Library/Logs/Antigravity`, are not read. `language_server.log` was seen to hold none of the lines the CLI's log has about conversations, folders and approvals.

### What breaks when Antigravity 2.0 changes

| Change in the app                                            | What the dashboard shows                                                 | Where to fix it     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ | ------------------- |
| `~/.gemini/antigravity` stops being its folder               | Antigravity is not found, or found empty                                 | `app/index.ts`      |
| The layout under `brain/` or the transcript's fields change  | As for the CLI: no chats, or chats shown as Unknown                      | `shared/`           |
| The hub is renamed or moves inside the app                   | Every chat shows as finished                                             | `app/hubProcess.ts` |
| `conversation_summaries` or its two columns are renamed      | Chats show without a folder, and the card says sqlite3 could not read it | `app/summaries.ts`  |
| A wait is written with another status, or `steps` is renamed | A chat that waits shows as working, not as needing you                   | `app/waits.ts`      |

To check a new version, with the app open, start a chat that asks to run a command, and note, never the content: `ls -la` of `brain/<id>/.system_generated/logs/` and `steps/`, the `type` and `status` of the transcript's last lines, `ls` of `conversations/<id>.db*` and the `idx`, `step_type` and `status` of the newest row of its `steps` while the approval is asked, and `ps -A -o comm=` for the hub's path. Then compare Agent Lookout's card and the chat's status with what was noted.
