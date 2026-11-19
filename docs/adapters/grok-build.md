# Grok Build adapter notes

These notes record what Agent Lookout reads from Grok Build, where each value comes from, and what breaks when Grok Build changes. When the adapter stops working, start here.

Written on 2026-11-19 from Grok Build's source. Grok Build is SpaceXAI's terminal coding agent, in its command `grok`. Its source is at [xai-org/grok-build](https://github.com/xai-org/grok-build) under the Apache-2.0 licence (`LICENSE`), and these notes read it at commit `2bdd1d6` (2026-09-29), which is version 1.0.45 (`crates/codegen/xai-grok-version/Cargo.toml:4`). Released builds are at 1.0.89, whose source is not public. Grok Build was never installed or run to write these notes, its native program's packages, `@xai-official/grok-<platform>`, were not unpacked, and of its npm launcher, `@xai-official/grok` 1.0.89, only the text files were read. No real `~/.grok` folder was looked at. The fixtures are written by hand. **The adapter was built from Grok Build's source at 1.0.45 and has not yet been checked on a machine running Grok Build.** The Sources view says so too.

Paths below are under `crates/codegen/` at `2bdd1d6`:

- `AS` is `xai-grok-active-sessions/src/lib.rs`.
- `EV` is `xai-grok-session-events/src/`.
- `SH` is `xai-grok-shell/src/`.
- `PG` is `xai-grok-pager/src/`.
- `UG` is `xai-grok-pager/docs/user-guide/`.

The code is in `src/collector/adapters/grok-build/`. `index.ts` builds the adapter, `home.ts` finds Grok Build's folder, `registry.ts` reads the list of open sessions, `folders.ts` finds each session's folder, `eventLog.ts` reads its event log, `sessionFiles.ts` reads its title and plan file, `toSession.ts` makes the session, and `finishedSessions.ts` keeps the sessions it has seen and the ones that ended. It shares Qwen Code's check of a process's start, `src/collector/adapters/qwen-code/processCheck.ts`, and Autohand Code's test of what it reads and its reading of JSON as bytes, `isTrusted` in `src/collector/adapters/autohand-code/folders.ts` and `src/collector/adapters/autohand-code/jsonBytes.ts`. The status is given by `src/core/mapping/grok-build/grokBuildMapping.ts`.

## What the issue said, and what holds

| What Agent Lookout issue #31 says                                                               | What the source shows                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The terminal app lists its open sessions in `active_sessions.json`, in `GROK_HOME` or `~/.grok` | True: each entry holds `session_id`, `pid`, `cwd` and `opened_at` (`AS:15-25`; `xai-dirs/src/lib.rs:49-59`)                                             |
| Each session's folder is `sessions/<URL-encoded working directory>/<ID>/`, hashed when long     | True (`xai-grok-config/src/paths.rs:61-78`, `:139-141`; `SH/session/persistence.rs:966-968`)                                                            |
| Working, idle and failed from the last turn's start and end                                     | True: `turn_started` and `turn_ended` (`EV/types.rs:8-18`, `:48-54`). Some turns end with no line, as [Turns left open](#turns-left-open) says          |
| A crash's turn is marked when the session reopens                                               | True, when its summary still names the turn's request (`SH/session/interrupted_turn.rs:79-105`)                                                         |
| Needs you while `ask_user_question` waits, or `plan_mode.json` says a plan waits                | True (`xai-grok-tools/src/implementations/grok_build/ask_user_question/mod.rs:300`; `SH/session/plan_mode.rs:56-66`)                                    |
| A wait for approval cannot be told                                                              | True: the permission lines surround every tool call, approved by you or not (`SH/session/acp_session_impl/tool_calls.rs:1758-1880`)                     |
| Finished when its process ends, or it leaves the list with its turn over                        | True. /new takes a session off the list and leaves it running (`PG/app/dispatch/session/lifecycle.rs:380`)                                              |
| A crash leaves its entry, so on a Mac each process's start is checked against `opened_at`       | True (`AS:1-2`, `:45-50`)                                                                                                                               |
| A title only when `summary.json` marks it as yours                                              | True: a title Grok Build makes can be the first ten words of your first prompt (`SH/session/helpers/session_summary.rs:174-186`, `:255`)                |
| IDE sessions are never listed                                                                   | True: only the terminal app registers a session, and `grok -p` only with `GROK_TRACK_HEADLESS` (`PG/app/effects/mod.rs:133-140`; `PG/headless.rs:1078`) |
| Not checked on a machine running Grok Build                                                     | Still true                                                                                                                                              |

## How it reads Grok Build, and why

It needs nothing installed and changes nothing. It reads Grok Build's list of open sessions and, for each, a few files in the session's folder, read-only, and asks whether each listed process runs. It runs no Grok Build program, connects to no Grok Build socket or ACP server, and makes no request to Grok Build or to xAI. Grok Build documents no way for another program to list its sessions: its user guide names only `~/.grok/sessions/` (`UG/17-sessions.md:18-46`). So the adapter reads the files alone, as CONTRIBUTING's fourth step allows, and opens only the files these notes list.

## Where it looks

| Setting                   | Grok Build's home                                            |
| ------------------------- | ------------------------------------------------------------ |
| `AGENT_LOOKOUT_GROK_HOME` | That folder, for Agent Lookout alone                         |
| `GROK_HOME`               | That folder, as Grok Build takes it, when it is a whole path |
| None                      | `~/.grok`, which on Windows is `%USERPROFILE%\.grok`         |

Grok Build takes `GROK_HOME` as it is when it is not empty, and otherwise `.grok` in the home folder (`xai-dirs/src/lib.rs:33-59`). It does not read `~` in it or trim it. So a `GROK_HOME` that is not a whole path on the system's rules, `~/grok` among them, is passed over, since Grok Build reads it from the folder it was started in, and the card says so. An empty one counts as not set, as it does for Grok Build. Grok Build's own program, `bin/grok`, is never looked up or run.

When the home holds neither `active_sessions.json` nor `sessions`, Grok Build is reported as not found, with no advice, and looked for again once a minute, with two `lstat`s. When `AGENT_LOOKOUT_GROK_HOME` names a folder that holds neither, that is an answer, not a missing Grok Build, and it is looked at every poll.

## The list of open sessions

`<home>/active_sessions.json` is one JSON array of `{session_id, pid, cwd, opened_at}` (`AS:15-21`). The terminal app adds an entry when a session is ready, with its own process ID and the time (`PG/app/effects/mod.rs:133-140`), for a new session and for one it resumes (`PG/app/dispatch/session/lifecycle.rs:1485-1488`, `:1623-1626`; `PG/app/dispatch/session/load.rs:1359`). It takes the entry out when it quits, closes the session, or moves on from it, as /new and leaving for the welcome screen do (`lifecycle.rs:380`, `:492-493`). It does not wait for the list's lock to take one out, and skips it when another Grok Build holds the lock at that moment (`AS:52-61`, `PG/app/effects/helpers.rs:1699-1720`). Adding an entry for an ID replaces the one there, with a new `opened_at` (`AS:45-50`). The whole file is written to `active_sessions.json.tmp` and renamed over it (`AS:130-141`), so a read never catches it half written.

- It is looked at with `lstat` every poll, and opened only when its size, modified time or identity changed, without following a link, only as an ordinary file with one name of the user Agent Lookout runs as, and only when it is 1 MiB or less.
- An entry is kept only when its ID could name a folder, letters, digits, `.`, `_` and `-`, at most 128, and not `.` or `..`; its process ID is a positive 32-bit number; its `cwd` is a whole path of at most 4,096 characters with no control character; and its `opened_at` is a time as chrono writes one. Anything else in an entry is dropped with the parsed text. Of two entries for one ID the newer is kept, and at most the 200 newest are kept.
- An empty file is an empty list, as Grok Build reads it (`AS:111-128`). No file is an empty list too. One that cannot be read, is larger than 1 MiB, is not an ordinary file of this user's or does not parse fails the poll, so nothing is finished from it, though Grok Build would read it as empty.
- `active_sessions.lock` and `active_sessions.json.tmp` are never opened, locked or looked up. Grok Build's own writers wait at most 2 seconds to take the first when they add a session, and not at all when they take one out (`AS:27-31`, `:45-61`).

A session's ID is a UUIDv7, or one a client chose with `-s` (`UG/17-sessions.md:18`). Only an ID that passes the rule above goes into a path.

## Sessions left with /new

/new, Ctrl+N and leaving for the welcome screen take a session off the list, when its lock is free, and keep its agent: a turn under way goes on (`lifecycle.rs:380`, `:492-493`). Agent Lookout watches such a session while its process runs, for up to a day from when it was last listed:

- while its turn is under way, it shows as working;
- while a question is open in that turn, or its plan file says a plan waits, it shows as needing you;
- otherwise, a log it cannot read or a turn left over among them, it shows as finished, with no process, since its process has not ended;
- a new turn in its log shows it as working again.

A session left this way while idle shows as finished at once, as a Qwen Code session moved on with /clear does. No Jump is given for one, since its process shows another session now.

## Finding a session's folder

Grok Build names the folder of a working folder's sessions by URL-encoding the working folder: each byte of its UTF-8 but a letter, a digit, `-`, `_`, `.` and `~` becomes `%` and two upper-case hex digits (`encode_cwd_dirname` in `xai-grok-config/src/paths.rs:61-65`, with urlencoding 2.1.3). Node's `encodeURIComponent` leaves `!'()*` as they are, so Agent Lookout has an encoder of its own. A name that would be over 255 bytes is `<slug>-<16 hex>` instead, from a BLAKE3 hash (`paths.rs:55-78`), which Node cannot work out.

- Every poll, each listed or watched session's folder is looked up with `lstat`: `sessions`, the folder named for its working folder, then its ID in that. Each must be a real folder of the user Agent Lookout runs as, never a link. A folder found before is looked up the same way, and dropped when it fails.
- A session not found so is looked for by its ID in every folder in `sessions`: at most once a minute, a clock set back counting as time enough, for at most the 10 newest such sessions, in at most the first 2,000 names, sorted, that Grok Build could write. Each folder is looked up with `lstat`, then each such ID in it. One found is the session's. An ID in two folders is in neither, as Grok Build itself takes neither (`SH/session/storage/relocation/mod.rs:76-77`, `:114-118`), and its status is unknown. That is at most 22,000 `lstat`s a minute.
- The names in `sessions` are only put into paths: never decoded, logged or shown, and none but a folder found is kept past the look. The `.cwd` file Grok Build writes in a hashed folder is never read.

A session whose folder is not found shows as unknown.

## The event log

`<folder>/events.jsonl` is written by the session's own process, a line for each event, each in one write at the end, with no fsync (`EV/log.rs:34-51`, `:62-81`). Each line is `{"ts":"<time>","type":"<kind>",…}`, its time in UTC to the millisecond, and the event's own fields after (`EV/log.rs:12-17`, `:64`; `EV/types.rs:5-7`). Grok Build never rewrites a line. It is read for listed sessions whose process runs, and for watched ones.

- The first time, its end is read backwards, 64 KiB at a time and at most 8 MiB, and the line break before it, from the newest whole line to the newest that starts or ends a turn, and the lines from there on are folded. A whole log of 8 MiB or less with neither has no turn yet. One whose newest such line is not in its last 8 MiB says nothing, and nor does one with more than 8 MiB after it.
- After that, only what was added is read, at most 8 MiB at once, and folded the same way, so what is kept is what a first read of the same file gives. More than 8 MiB added is read from the end again, and so is a log that shrank, was replaced, or does not go on from the last line read. Bytes after the last line break are a line still being written, and wait until it is whole.
- A line counts only when it begins `{"ts":"YYYY-MM-DDTHH:MM:SS.mmmZ","type":"`, then a kind of `a` to `z`, digits and `_`, at most 64, and a quote, ends with `}`, and has no second `{"ts":"` in it, as two lines run together by a crash would. The whole line is looked through for its line break and that second `{"ts":"` alone. Of a line that counts only its first 512 bytes are compared, with the few words below: an outcome, a tool's name and a phase right after the kind, where Grok Build writes them, and `,"schema_version":"1.` anywhere after it. Each begins `,"`, and JSON writes a quote inside a string as `\"`, so nothing a model, a tool, a hook or a server put in a field can match.
- A line that does not count, at or after the newest that starts or ends a turn, makes the status unknown. Before it, it is passed over.

What is compared, as bytes:

| Line                                                                                                                     | Compared                                                                                                     | Kept                                              |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `turn_started`                                                                                                           | `,"schema_version":"1.` in its first 512 bytes (`EV/types.rs:3`, `:8-18`)                                    | A turn under way, of this format or not, its time |
| `turn_ended`                                                                                                             | `,"outcome":"` and then `completed`, `cancelled`, `error` or `interrupted` (`EV/types.rs:48-54`, `:418-426`) | How it ended, its time                            |
| `tool_started`                                                                                                           | `,"tool_name":"ask_user_question"}` or `,"tool_name":"exit_plan_mode"}` as the line's end                    | A question opened, a plan's call, its time        |
| `tool_completed`                                                                                                         | `,"tool_name":"ask_user_question",`                                                                          | A question closed                                 |
| `loop_started`, `phase_changed` to `waiting_for_model`                                                                   | The kind, or `,"phase":"waiting_for_model"}`                                                                 | Every open question closed                        |
| `first_token`, `tool_started`, `permission_requested`, `phase_changed` to text, reasoning, a tool or a permission prompt | The kind, or the phase                                                                                       | The model wrote                                   |
| Those, `tool_completed` and `permission_resolved`                                                                        | The kind                                                                                                     | The newest time of a turn's own line              |

Anything else, the MCP lines among it, is passed over. Of a log only numbers and flags are kept: where reading goes on from, the file's size, time and identity, the newest turn's start or end, its outcome and time, how many questions are open and since when, the newest plan call's time, whether the model wrote, the newest time of a turn's line, and whether a line did not count. No byte of it becomes text. A turn's reasons, `cancellation_context`, which can hold a client's own words (`SH/session/commands.rs:249`; `SH/session/acp_session_impl/cancel.rs:768-772`), an MCP server's errors, commands, URLs and raw output, tool names other than the two, model IDs, prompts and replies are never decoded.

The tool's wire name is `ask_user_question` (`ask_user_question/mod.rs:300`). `AskUserQuestion` is the name a Claude settings file or a hook gives it, not one written to the log (`xai-grok-tools/src/types/claude_alias.rs:62`), so it is not matched. A plan's tool is `exit_plan_mode` (`xai-grok-tools/src/implementations/grok_build/exit_plan_mode/mod.rs:83`).

### When a question ends

A question's call, `tool_started`, is written before the call is made ready (`tool_calls.rs:533-548`), and a call that fails to be made ready writes no result (`:551-563`; `EV/tracker.rs:126-128`). So a question is open from its call until a `tool_completed` of the question tool, a new round, `loop_started` (`SH/session/acp_session_impl/turn.rs:2748`), a wait for the model, `phase_changed` to `waiting_for_model` (`turn.rs:3028`), or the turn's end. Its time is when the first of the open questions was asked, and stays while any is open.

## Turns left open

Some turns start and never write their end:

- a rewind aborts the turn and writes no `turn_ended` (`cancel.rs:122-128`, `:768-778`);
- an error before the model is asked, after the turn started, is only counted (`turn.rs:990-999`, `:140-148`);
- a crash leaves the turn open until the session is loaded again, and Grok Build then writes `turn_ended` with `interrupted`, but only when the turn's start is in the last 256 KiB of the log and its summary still names the turn's request (`SH/session/interrupted_turn.rs:14-15`, `:92-105`).

So an open turn counts as left over by either of two rules, and a listed session's status is then unknown, a watched one's finished:

1. Nothing from the model since the turn started, no first token, text, reasoning, tool call or permission check, and the log written nothing for 2 minutes and 2 seconds, the 2 seconds for a disk that keeps a write's time rounded down. A model that takes longer than that to start answering shows the session as unknown until it does.
2. The turn started more than a minute before the session was listed, and no line of a turn's own was written at or after the listing. The minute allows for a session started with a prompt, whose turn can start a moment before it is listed (`lifecycle.rs:1485`).

A time that cannot be right, before 2020 or more than a minute ahead of the clock, takes part in neither rule, so it never ends a turn.

## Titles

`summary.json` holds the session's title, `generated_title`, and `title_is_manual`, written only when it is true (`SH/session/persistence.rs:1240-1245`). Grok Build sets it with /rename (`SH/session/storage/summary_write.rs:198-201`), and `/rename --auto` clears it (`:185-197`). The dashboard's rename and an ACP client's `x.ai/session/rename` set it too, and so can a session pulled or imported with it set, which Agent Lookout cannot tell from one you typed. A title Grok Build made is not marked, and when its title call fails it is the first ten words of your first prompt (`session_summary.rs:174-186`, `:255`).

Grok Build writes `summary.json` with serde's pretty printer (`SH/session/storage/jsonl/mod.rs:766`; `summary_write.rs:466`): a line break and two spaces before each key of the outer object, four or more before one inside it, and a line break inside a string only as `\n`. So:

- It is looked at with `lstat` every poll for listed and watched sessions, and for one whose process has ended, so its name is the same after a restart. It is opened only when its size, modified time or identity changed, without following a link, only as an ordinary file with one name of this user's, at most 1 MiB, and only when it is a whole object, `{` first and `}` last.
- `\n  "title_is_manual": true` followed by `,` or a line break must be in it, as bytes. Only then is `\n  "generated_title": ` looked for, and the one JSON string after it, at most 1 KiB, turned into text alone, then cleaned and cut to 200 characters as every name is.
- A file written another way, as compact JSON, or one cut off, gives no title. Nothing else of it is looked at: the summaries a model wrote of the conversation, `session_summary`, `last_turn_summary` and `last_recap`, its git remotes, which can hold a password in a URL, its branch, worktree and the rest.

## Plan approval

`plan_mode.json` holds `awaiting_plan_approval`, true while you are shown a plan to approve and have not answered (`SH/session/plan_mode.rs:56-66`). Grok Build writes it with the same pretty printer (`jsonl/mod.rs:1457-1465`), and keeps it across a restart, when it shows the plan again without writing the file (`tool_calls.rs:2236-2262`).

- It is read for listed sessions whose process runs, and for watched ones, never for one that ended. It is looked at with `lstat` every poll and opened only when it changed, as `summary.json` is, at most 64 KiB, and only when it is a whole object.
- `\n  "awaiting_plan_approval": ` followed by `true` or `false` and then `,` or a line break is looked for as bytes. Only that yes or no is kept, with the file's modified time.
- No file is no plan waiting. A whole object without the field is no plan waiting, as Grok Build reads an older one. One that cannot be read, is too large or is not a whole object makes a listed session unknown.

A plan's wait begins at the newest `exit_plan_mode` call in the turn under way, or else at the later of when the file was last written and the listing. The second is kept for as long as the plan waits, though the file is written again. A newer `exit_plan_mode` call starts a new wait.

## Status

`mapGrokBuildStatus` in `src/core/mapping/grok-build/grokBuildMapping.ts`. The first row that holds wins:

| When                                                                                                                                                                                                                                                                    | Status      | Since                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------- |
| Its process has ended, or another program has its ID, or it is watched and its turn is over                                                                                                                                                                             | `finished`  | The later of the listing and the log's last write     |
| Listed, and its folder is not found or is in two places, its log is missing, cannot be read or says nothing, a line did not count, its turn ended in a way 1.0.45 does not write, its turn is of a newer format, its plan file cannot be read, or its turn is left over | `unknown`   | None                                                  |
| A question is open in the turn under way, or a plan waits for approval                                                                                                                                                                                                  | `needs-you` | The question's, or the plan's, with reason `question` |
| Its newest turn started                                                                                                                                                                                                                                                 | `working`   | The turn's start                                      |
| Its newest turn ended with `error`, or a crash cut it off, `interrupted`                                                                                                                                                                                                | `failed`    | The turn's end                                        |
| Its newest turn ended with `completed` or `cancelled`, or no turn has started                                                                                                                                                                                           | `idle`      | The turn's end, or the listing                        |

- `cancelled` is a turn you stopped or one at the max-turns limit (`turn.rs:1564-1572`). Esc never stops a turn in the terminal app (`UG/01-getting-started.md:107`).
- `interrupted` is written for a turn a crash cut off, when the session is loaded again, and the terminal app paints it as a failed turn (`PG/app/turn_completion.rs:111-118`).
- A refusal ends a turn as `completed` (`turn.rs:1491-1497`).
- A wait for a tool's approval is not told apart: `phase_changed` to `permission_prompt`, `permission_requested` and `permission_resolved` surround every tool call, whatever approves it (`tool_calls.rs:1758-1880`). Such a session shows as working.
- A session whose log shows only lines of the session's own, such as an MCP server's setup (`SH/session/mcp_servers.rs:62`), has no turn yet and is idle.
- Every time is judged against the clock on every poll, and one that cannot be right is none. A finished session's time is the same whether a live poll or a restart finds it. When neither of its times can be right, it is finished from the first poll that found it so, and keeps that time unless a clock set back puts it more than a minute ahead, when it is finished from that poll.

## Whether its process still runs

The listed process ID is the terminal app's own (`PG/app/effects/mod.rs:137`). In Grok Build's usual mode its agent runs in that process. Whether it runs is asked with signal 0, which sends nothing, once for each process each poll, `EPERM` counting as running, as Grok Build's own check counts it (`AS:143-155`).

A crash leaves a session's entry, until another session Grok Build opens prunes entries whose process has gone (`AS:1-2`, `:45-50`), and the system gives its process ID to another program sooner or later. Grok Build records no start for its process, but `opened_at` is when the process listed the session, so a process with the ID now that started no later, give or take a minute, is the same one:

- On a Mac, `ps -o pid=,lstart= -p <pids>` with `TZ=UTC` and `LC_ALL=C`, run directly with a 2-second timeout, says when each listed process started, every 30 seconds for each process and listing, and at once for a new one (`src/collector/adapters/qwen-code/processCheck.ts`). One that started more than a minute after `opened_at` was given the ID since, and the session is finished. When `ps` fails or `opened_at` is more than a minute ahead of the clock, signal 0 decides. Jump and the card's process ID come only after `ps` says it is the same process.
- On Linux, `ps` works out a process's start from the clock each time, so it moves when the clock is set (`src/collector/processes/processStart.ts`). Signal 0 alone decides, as for Cline, Kimi Code and Mistral Vibe. The same `ps` is asked only about a process found in a tmux pane, before Jump.
- On Windows, signal 0 alone, and `ps` is never run.

The minute lets a terminal app that crashes within a minute of listing a session, and whose process ID is given to another program in that minute, count as the same.

A session whose process has ended is finished, and of its folder only its log's modified time and its `summary.json` are looked at. A session a crash left listed shows as finished from the first poll, and on every poll after, for a day from its end.

## Names and folder

A session's name is a title marked as set by you, as [Titles](#titles) says, else the last part of the folder Grok Build's list names, else `grok-build:<id>`. Its folder is the list's `cwd`, and it began when Grok Build listed it. A title Grok Build made is never read.

## Quiet for, tokens, Jump, Stop and Answer

- Quiet for is the time since the event log was last written: the open file's modified time, never earlier than its `lstat`'s. A long reply or a long command writes nothing until it ends.
- No tokens. Grok Build counts tokens by turn in `usage.json`, which is never read.
- Jump is a pane for tmux, and a tab for Terminal or iTerm2 on a Mac, found for the listed process by the finders Claude Code's sessions are found with, `ps -A -o pid=,ppid=,tty=,comm=`, as for Qwen Code. Not in another terminal, and not on Windows.
- No Stop: Agent Lookout stops Claude Code sessions only so far.
- No Answer: Agent Lookout never connects to `leader.sock` or Grok Build's ACP server.

There is no last message.

## On Linux

Files are read as on a Mac. Whether a session's process runs is signal 0 alone, so a session a crash left listed shows as open while another program has its process ID. Jump in tmux is given only after `ps` says the process in the pane started before the listing.

## On Windows

The home is `%USERPROFILE%\.grok`. A session's folder is named for its working folder as written, `C%3A%5CUsers%5C…` for `C:\Users\…`. Signal 0 alone decides whether a process runs, as Grok Build's own prune asks Windows whether one does (`AS:156-168`), so a session a crash left listed shows as open while another program has its ID. The listed process is Grok Build's own program (`PG/app/effects/mod.rs:137`). There is no Jump. Each file is held open for one read only. A Grok Build inside WSL is not seen. An `AGENT_LOOKOUT_GROK_HOME` under `\\wsl$` or `\\wsl.localhost` lists Linux process IDs, which mean nothing to Windows, so their sessions show as finished, or as open while a Windows program has the same ID.

## Known gaps

- A wait for a tool's approval shows as working.
- A subagent's wait, a background subagent (`UG/16-subagents.md:154`), an MCP server asking for input (`SH/session/pending_interaction.rs:22-31`) and work left running in the background (`UG/20-background-tasks.md:187-193`) show as working or idle, not as needing you.
- A manual /compact outside a turn shows as idle (`SH/session/acp_session_impl/run_loop.rs:1185-1190`).
- A question tool renamed by a custom toolset is not seen, and nor is `exit_plan_mode` renamed, though its plan file still is.
- An imported `plan_mode.json`, written compact, shows no plan waiting.
- Sessions an editor runs over ACP, and `grok -p` without `GROK_TRACK_HEADLESS`, are never listed.
- A session left with /new shows as finished while it is idle, and a new turn in it shows it again.
- A session that left the list before Agent Lookout started is not seen.
- Grok Build skips taking a session off its list when another Grok Build holds the list's lock at that moment (`PG/app/effects/helpers.rs:1699-1720`). A session left with /new or closed in Grok Build's dashboard then still shows as open, with its process's Jump, until that process ends. On a home whose lock a crash left held, as can happen on NFS (`AS:27-29`), no session is added to the list or taken off it.
- A rewind, or an error before the model is asked, leaves a turn with no end. One with nothing from the model shows as working for 2 minutes, then unknown, and one after the model wrote shows as working until the next turn.
- A crash whose turn's start is more than 256 KiB from the log's end is not closed by Grok Build, so the session shows as unknown until its next turn.
- In leader mode the listed process is the terminal app's, not the leader's (`SH/leader/mod.rs:1-33`), so a leader that goes on after the terminal app quits shows its sessions as finished.
- A container that shares `~/.grok` lists process IDs that mean nothing here.
- A Grok Build inside WSL is not seen from Windows.
- The minute's slack on a Mac, as [Whether its process still runs](#whether-its-process-still-runs) says.

## Not yet checked

Everything here is read from Grok Build's source at 1.0.45, so each of these is for a person with Grok Build installed to check:

1. Any version after 1.0.45, 1.0.89 among them.
2. The name `ps` gives the terminal app's process. Agent Lookout does not use it.
3. Whether the list's `cwd` is always the folder a session's folder is named from.
4. How long after a first prompt's turn starts the session is listed.
5. How often rewinds and errors leave turns open.
6. Whether Grok Build's rename over an open `active_sessions.json` works on every Windows version.

## What breaks when Grok Build changes

| Change in Grok Build                                                    | What the dashboard shows                                  |
| ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `active_sessions.json` moves, or its entries change their fields        | No sessions, or the poll fails                            |
| A session's folder is named another way                                 | Sessions show as unknown, until the look by ID finds them |
| `events.jsonl` moves, or its lines no longer begin with `ts` and `type` | Sessions show as unknown                                  |
| `turn_ended` writes another outcome, or `outcome` is no longer first    | Sessions show as unknown after such a turn                |
| `schema_version` 2 is written                                           | Sessions show as unknown while a turn is under way        |
| `ask_user_question` is renamed                                          | Questions show as working                                 |
| `title_is_manual` is renamed, or `summary.json` is written compact      | Sessions take their folder's name                         |
| `plan_mode.json` is written compact                                     | Plans waiting show as idle or working                     |
| Grok Build writes a start for its process                               | Nothing changes until the adapter reads it                |

Grok Build reads hooks from Claude Code's settings (`UG/10-hooks.md:60-75`), but has no `PermissionRequest` hook and skips a hook it does not know, as its own test of a `PermissionRequest` hook shows (`xai-grok-hooks/src/config.rs:1411-1440`). So Agent Lookout's plugin, whose hook is `PermissionRequest`, never runs for Grok Build, and Agent Lookout cannot answer Grok Build's prompts.

To check a new Grok Build, read `xai-grok-active-sessions/src/lib.rs`, `xai-grok-session-events/src/types.rs` and `log.rs`, `encode_cwd_dirname` in `xai-grok-config/src/paths.rs`, `Summary` in `xai-grok-shell/src/session/persistence.rs`, `PlanModeSnapshot` in `xai-grok-shell/src/session/plan_mode.rs`, and where `tool_started`, `turn_started` and `turn_ended` are written in `xai-grok-shell/src/session/acp_session_impl/`. Then update `UNCHECKED_NOTE` in `src/collector/adapters/grok-build/index.ts` and the first paragraphs here.
