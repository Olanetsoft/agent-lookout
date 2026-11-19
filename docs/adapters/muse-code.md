# Muse Code adapter notes

These notes record what Agent Lookout reads from Muse Code, where each value comes from, and what breaks when Muse Code changes. When the adapter stops working, start here.

Written on 2026-11-19 from public material alone. Muse Code is Meta's terminal coding agent, in its command `muse`. Its own program is not open source, so the `muse` program, its launcher and its packages were never downloaded, unpacked, read, disassembled or run to write these notes, and no real session or `~/.local/share/muse` folder was looked at. What is here comes from:

- Meta's SDK documentation site for 1.4, from the `gh-pages` branch of meta-models/muse-code-sdk at `3512269`: its host-operations guide (`HO`), its pages on sessions and turns (`turns`), approvals (`approvals`), durability profiles (`durability`) and hook events (`hooks`), and its compatibility page (`compat`). That branch holds no licence file of its own.
- Meta's MIT-licensed Muse Code SDK and protocol schema, meta-models/muse-code-sdk at `5d8ba2e` (1.4.24): `schema/msp/msp.d.ts` (`d.ts`), `schema/msp/experimental/msp.schema.json` (`schema`) and the SDK's own code and changelog (`sdk`).
- Meta's MIT-licensed cookbook, meta-models/meta-model-cookbook at `281239e`, whose audit recipe (`cb:audit`) holds a raw export of a real Muse Code 0.1.0 session, "Meta's export" below.
- Meta's product pages and changelog at dev.meta.ai, which name no licence.
- Open-source readers of Muse Code's files, each under an open licence, named with the commit read. From them only facts were taken: record and field names, shapes, observed values and counts. No code was copied, and every test file was written by hand. A reader with no licence, or whose evidence came from the shipped program, was not used, and two readers that may have drawn on such evidence are used only where another source agrees.

It has not been checked on a computer running Muse Code, and its card says so.

The code is in `src/collector/adapters/muse-code/`. `index.ts` builds the adapter, `home.ts` finds the sessions folder, `sessionFolders.ts` finds the logs, `logReader.ts` reads them, `jsonWalker.ts` and `records.ts` read each line as bytes, and `toSession.ts` makes the session. The fold of a log's newest turn is `src/core/mapping/muse-code/museCodeFold.ts`, and the status `museCodeMapping.ts` beside it. It asks and judges `ps` with DeepSeek Harness's `src/collector/adapters/deepseek-harness/processes.ts`, with Muse Code's names, keeps a wait across polls with DeepSeek Harness's `continuedDeepseekHarnessWait`, checks a folder with Pi's `folder` and decodes its one text with Autohand Code's `literalOf`.

## What the issue said, and what holds

| What Agent Lookout issue #71 said                                                                  | What the sources show                                                                                                                                   |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One append-only log at `~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl`        | True (HO, "Where the host keeps its files" and "Sessions"; `cb:audit/README.md`). Meta adds that the layout is an implementation detail that may change |
| The same path on macOS and Linux                                                                   | Meta gives one default with no row for each system. Readers saw it on macOS                                                                             |
| `XDG_DATA_HOME` or `MUSE_DATA_DIR` moves it                                                        | `XDG_DATA_HOME` does (HO). `MUSE_DATA_DIR` is in no Meta source, and readers that looked say it does nothing                                            |
| Each line is JSON with a microsecond `recorded_at`                                                 | True for a record (`RawLogRecordEnvelope` in `schema`). Some lines are a `retained_marker` (`schema`) or a `retained_frame` (readers) instead           |
| A run starts with `started` and ends with `terminal` of `completed`, `failed` or `cancelled`       | True, and an unknown terminal is still an end (`d.ts`, `TurnTerminal`; compat)                                                                          |
| An open question is `user_input_prompt_requested` with no `user_input_prompt_settled`              | Readers saw both names in real logs of 1.4.0 to 1.4.13. Meta documents only their wire names, `userInput/requested` and `userInput/settled`             |
| An approval is `approval` / `requested`, then `decision_applied` with the same `pending_action_id` | True in Meta's export. No record has `payload_type` `approval.review`                                                                                   |
| Subagent logs under `<session-id>/subagent/` belong to the parent                                  | True (`cb:audit/README.md`; `d.ts`). They are never read                                                                                                |
| `session-index.db`, the locks and the sockets must be left alone                                   | They are. None is opened, listed, looked up, locked or probed                                                                                           |

## How it reads Muse Code, and why

It needs nothing installed and changes nothing. It reads each recent session's log, read-only, as bytes, and asks `ps` which Muse Code programs run. It runs no Muse Code program, connects to no socket and makes no request.

Meta asks programs to take a log's path from a running host, and calls the folder layout "current implementation detail" (HO, "Sessions"). Its way to list sessions is `muse serve` with `session/list`, `session/read` and `approval/listPending`. Starting a host runs its start-up housekeeping, which reclaims empty sessions and, with retention set, deletes old ones (HO, "Retention"), so it would write to Muse Code's files. `muse serve --no-session-log` writes no session, but it is still a Muse Code program, Meta does not say whether its housekeeping runs, and a host knows only the sessions it holds. `muse sessions --json`, named in the 1.4.15 changelog, prints fields Meta does not document. Hooks would need a plugin of Agent Lookout's inside Muse Code, which changes what Muse Code runs. So the files are read alone, as the Codex adapter does, and this adapter is expected to break when Muse Code changes them. CONTRIBUTING's fourth step asks for the files to be checked against a listing the vendor documents for outside tools, and this adapter does not do that.

## Where it looks

The data folder is the first that applies:

1. `AGENT_LOOKOUT_MUSE_CODE_HOME`, trimmed, when it is not empty. A missing `sessions/` in it is then an answer, not a missing Muse Code, and it is looked for on every poll.
2. `muse` in `XDG_DATA_HOME`, as Agent Lookout's own environment gives it, when it is set, not empty and absolute. One that is not absolute is passed over, as the XDG rules call such a value invalid, and the card says so. What Muse Code itself does with one is not known.
3. `~/.local/share/muse`. On Windows that is `%USERPROFILE%\.local\share\muse`, which Meta does not document, so the card says it is assumed.

The sessions are in `sessions` there. `MUSE_DATA_DIR`, `MUSE_HOME`, `MUSE_SESSIONS_DIR`, `XDG_CONFIG_HOME`, `~/.config/muse`, any setting in Muse Code's files and any process's arguments or environment are never read. `XDG_DATA_HOME` is Agent Lookout's own: someone who sets it only in Muse Code's shell sets `AGENT_LOOKOUT_MUSE_CODE_HOME`. When `sessions/` is missing, it is looked for again once a minute.

## Finding the logs

Everything from `sessions/` down is looked up with `lstat`, which follows no link, and a link, or anything but a folder or an ordinary file, is never gone into or opened, `sessions/` itself included. Names are taken only as Muse Code makes them: years of four digits, months and days of two, and session folders that are lowercase UUIDs. A dot folder such as `.msp-view-v1` and every other name are never looked up.

On each poll `sessions/` is looked up and listed again when its modified time moved. Between sweeps the newest three day folders by name are looked at, years newest first, then months, then days, each listed again only when its time moved, so neither local time nor UTC is assumed for a folder's date. In them, and for each log the last sweep found written in the last day wherever it is, and for each session that needed you at the last poll, the session folder is looked up, then its `session.jsonl`. A session folder is never listed, so `.session.lock`, `cron.db`, `goals.db`, `subagent/`, `approval-review/` and every other name beside the log are never learnt. Once a minute a sweep lists every year, month and day folder and looks up every session in them. A resumed session, which Muse Code appends to in its old day folder (`cb:audit/README.md`), is found at the next sweep, up to a minute late.

A log written in the last day, or one of a session that needed you, is read; the newest 200, and every one that needed you. A session with no turn yet, holding only its first records as a session just made or one housekeeping may reclaim does, is not listed, and nor is a top-level folder of approval records alone, which some readers saw for subagents.

## The log

The log is opened read-only, without following a link at its name and without waiting on a pipe, only when its `lstat` size, modified time or identity changed, and only when the open file is the one that `lstat` found. Its write time is the later of the `lstat`'s and the open file's.

Each line is a record, `{schema_version, id, stream {kind, id}, sequence, recorded_at, record_type, durability, causation_id, payload_type, payload_schema_version, payload}`, written compact in that order in Meta's export and every reader's file, with `recorded_at` in microseconds since the epoch (`schema`, `RawLogRecordEnvelope`). `payload` is marked unstable there.

### The first 64 KiB

The first 64 KiB are read once for each file, and again on a change while the file is shorter and none was found, for the first `runtime.session.metadata` record on the session's own stream (readers saw it among the first lines, from 0.2.1 to 1.4). Its `payload.record.workspace_root` is the session's folder, and its `recorded_at` its start when the session's ID holds none.

### Reading as bytes

The log holds prompts, questions, answers, commands and outputs unredacted (`cb:audit/README.md`), so almost nothing is decoded. A line is walked only when its first 1 MiB holds one of `"runtime.session"`, `"approval_wait.effect.terminal"`, `"session.end"` and `"session.resumed"`, quotes included, or, in the first 64 KiB, `"runtime.session.metadata"`. The walker steps through the line's JSON as bytes, to a depth of 32, and compares keys with the few paths wanted. It stops once a line's kind has every field it reads, so a `started` whose prompt comes after its kind is read however long the prompt is. Every other line is passed over unwalked.

A walked line is judged in this order: a `retained_frame` or `retained_marker` key at its top is passed over, and a frame is never opened; a syntax error, a depth past 32 or a wanted path met twice makes it unreadable; one with no `payload_type` read below is passed over; one not on the stream `{"kind":"session","id":<its folder's name>}` is passed over, as another stream's record, a subagent's task runs and side chats among them; a `schema_version` other than `1` makes it unreadable, and newer when it is a whole number above 1; a field its kind needs missing, or not of its kind, makes it unreadable.

| `payload_type`                   | `payload.kind`       | `event.kind`                                               | Read                                                                              |
| -------------------------------- | -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `runtime.session`                | `run`                | `started`, `run_retracted` or any other                    | `payload.run_id`                                                                  |
| `runtime.session`                | `run`                | `terminal`                                                 | `payload.run_id`, `event.terminal`                                                |
| `runtime.session`                | `run`                | `user_input_prompt_requested`, `user_input_prompt_settled` | `payload.run_id`, `event.prompt_id`                                               |
| `runtime.session`                | `approval`           | `requested`                                                | `payload.run_id`, `event.pending_action_id`, `event.presentation_phase`           |
| `runtime.session`                | `approval`           | `automated_review_started`, `decision_applied`             | `payload.run_id`, `event.pending_action_id`                                       |
| `runtime.session`                | `approval`           | `automated_review_completed`                               | the same, `event.status`, `event.timed_out` and whether `event.failure` is `null` |
| `runtime.session`                | `approval`           | any other                                                  | `payload.run_id`                                                                  |
| `runtime.session`                | any other, as a task | none                                                       | nothing more                                                                      |
| `approval_wait.effect.terminal`  | none                 | none                                                       | `payload.record.pending_action_id`                                                |
| `session.end`, `session.resumed` | none                 | none                                                       | nothing more                                                                      |

Every line taken gives its `recorded_at` too: 1 to 16 digits, no sign, fraction or exponent, worked out from the digits. Only two kinds of bytes become text, each found as bytes first: the workspace folder, one JSON string of at most 16 KiB decoded alone, kept only when it is a whole path of the system's of at most 4,096 characters with no control character; and the IDs, 1 to 128 bytes each of a letter, a digit, `.`, `_`, `:` or `-`. Every word is compared as bytes with a closed list, and the stream's ID with the folder's name. The prompt, questions, answers, `raw_args`, `approval_subject`, the review's `assessment`, usage, replies, `route_facts`, `session.name.changed` and every other field are stepped over as bytes.

Where the sources come from: `started` and `terminal` are in a hand-authored transcript of Meta's SDK (`sdk:schema/msp/transcripts/reconciliation-refold/records.jsonl`) and in readers' real logs; an approval's `requested` and `decision_applied` and `approval_wait.effect.terminal` are in Meta's export; the question records, `run_retracted`, `automated_review_*`, `presentation_phase`, `runtime.session.metadata` and `retained_frame` are from readers alone (ingo-eichhorst/Irrlicht at `4523336`, MIT; AltanS/collie at `314eb4c`, MIT; AlexanderTar/swarmrun at `440e622`, Apache-2.0; devswha/ovis at `3f4b8c7`, MIT; and others), and Meta publishes none of them on disk; `session.end` and `session.resumed` are in the cookbook's audit recipe and readers' logs of 1.4.2 to 1.4.13.

### The newest turn

Two kinds of whole line decide where the status comes from: a `started` of a run on the session's own stream, and a line that would decide and cannot be read. The newest of them in the file decides. The first time, the end is read backwards, 256 KiB at a time, looking through at most the last 8 MiB and the byte before them, to the newest such line. When it is a `started`, the lines from it to the last line break are read again onwards and folded. After that, while the file keeps its identity, is no shorter than the end of the last whole line read, grew by 8 MiB or less, and the byte before that end is a line break, only the whole lines added are read. Otherwise it is read from its end again. So what is kept is what a first read of the same file gives. A last line with no line break yet waits until it is whole. At most one piece of 256 KiB, one line's first 1 MiB and the first 64 KiB are held at once.

A session whose newest turn began more than 8 MiB before its log's end is unknown, and so is one whose newest deciding line cannot be read, or that holds more than 64 open questions and approvals at once, until its next turn starts.

### The fold

From the newest `started` of run R:

- A `terminal` of R, or its `run_retracted`, ends R, as the newest end, and closes its questions and approvals, as Meta's own fold retires a pending prompt when its turn ends (`sdk:clients/sdk-ts/src/fold/session-fold.ts`). Another run's `terminal`, as a queued launch that failed with no start (turns, "What turn terminal states mean"), is only the newest end.
- A question of R opens while R is open, and closes on its `user_input_prompt_settled`.
- An approval of R opens with its `requested` while R is open, and closes on `decision_applied` or `approval_wait.effect.terminal` with its `pending_action_id`. Its phase and the reviewer's records are kept on it.
- A `session.end` or `session.resumed` marks the session, closes R when it is open, and closes every question and approval opened before it. At a resume after a crash Muse Code writes `session.end` with `crash_inferred`, then `session.resumed` (`cb:audit/README.md`), so a resumed session never shows the dead turn's work or wait.
- A closed R opens again on its own later record of a run's kind other than its end, or on an approval's `requested`, `automated_review_started` or `automated_review_completed`, as of that record's time. So a run that recovery takes up again, and the fresh request recovery writes for an approval it parked (approvals, "Crash and restart"), open again. A decision, `approval_wait.effect.terminal` and a task's record do not: recovery writes those for the old approval whether or not the turn goes on.

## When an approval waits for you

Meta's Auto-review profile, the default since 1.2.1 (`sdk:CHANGELOG.md`), has a model reviewer decide most approvals before you are asked. On the wire a request the reviewer holds is not pending for you (`d.ts`, `approval/reviewing`). On disk a reader saw the phase as `event.presentation_phase`, the request's last key, `automated_reviewing` in 68 of 77 requests and `human_pending` in 9, and the reviewer's records `automated_review_started` 6 to 27 ms after the request and `automated_review_completed` with its word, `status` `approved`, `escalated` or `timed_out`, the reviewer holding a request about 8 seconds at the median and 90 seconds at most (Irrlicht). An open approval of the open run waits for you:

| Its `presentation_phase`               | Waits for you                                                                                                                     | Since                     |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `human_pending`                        | At once                                                                                                                           | The request               |
| `automated_reviewing`                  | After `automated_review_completed` that is not a clean approval: a status other than `approved`, `timed_out` true, or a `failure` | That completion           |
| `automated_reviewing`                  | With no completion, 2 minutes after the request                                                                                   | The request and 2 minutes |
| None or another, with a review record  | As for `automated_reviewing`                                                                                                      | As for it                 |
| None or another, with no review record | 6 seconds after the request, Muse Code's own delay before it tells hooks a prompt waits (hooks, `Notification`)                   | The request               |

Until then it shows as working. A clean approval is decided within milliseconds. The 2 minutes are past the longest hold seen and catch a reviewer that never answers, as 2 of 68 did, and Meta's fallback "to asking you when the reviewer is unavailable", however that is written. A timer needs a request time that can be right. An approval that waited for you at the last poll keeps waiting while it is open, and a wait that goes on keeps the time it began, so a clock set back gives no second notice.

## Status

"The time judged" is the newest record taken's `recorded_at`, never later than the file's last write; the file's last write when that record has no time; and none when its time cannot be right. A Muse Code that holds a session wrote every record taken and started before it, so a later write that decides nothing, as a rename or a model change, neither holds a finished session again nor moves when it finished. "Backed" means `ps` lists a Muse Code program that started no later than a minute after the time judged.

| Row | When                                                                                                   | Status    | Since                             |
| --- | ------------------------------------------------------------------------------------------------------ | --------- | --------------------------------- |
| 1   | The newest turn is too far back, its newest deciding line cannot be read, or too many wait             | unknown   | none                              |
| 2   | The run is not open and the newest end is `failed`                                                     | failed    | that end's `recorded_at`          |
| 3   | The run is not open and Muse Code wrote `session.end`                                                  | finished  | that record's `recorded_at`       |
| 4   | `ps` cannot say, on Windows and other systems, or no time judged can be right                          | unknown   | none                              |
| 5   | No Muse Code that could hold it runs, or it was written more than a minute before the computer started | finished  | the time judged                   |
| 6   | The open run asks a question, or an approval waits for you, backed                                     | needs you | the wait's start                  |
| 7   | The run is open, backed, and the file was written in the last 30 minutes                               | working   | the run's start, or its reopening |
| 8   | The run is open, backed, and quieter than that                                                         | unknown   | none                              |
| 9   | The run ended otherwise, or a host resumed the session, backed                                         | idle      | that end or resume                |

Rows 2 and 3 need a time that can be right, or show as unknown: a line whose time cannot be right only stops a finish. A failure stands until a new turn starts, through a resume and a `session.end`, as for fx and DeepSeek Harness. Every orderly unload writes a `session.end` first: an idle unload, a host's shutdown and a released `session/leave` (`d.ts`, `SessionEnd`). Closing stdin, SIGTERM or SIGINT cancels the active turn, then writes one for every session the host holds, and SIGKILL writes neither (HO, "Stopping the host"; turns, "The process model"). Idle shows only because Muse Code writes `session.end` when it lets a session go. Every time is judged against the clock on every poll.

## Whether a Muse Code that could hold it runs

Nothing on disk ties a session to its process, and one `muse serve` holds many sessions (HO; turns). The lock file, `.session.lock`, is Muse Code's writer lease, held with an operating system lock and freed when its holder exits (HO, "One host, one client"), and it is never opened, looked up, locked or probed. So on macOS and Linux, while a listed session's status depends on it, Agent Lookout runs `ps -A -o pid=,lstart=,comm=`, in UTC, at most every 10 seconds, and sooner, though not within 2 seconds of the last ask, when a session is written after an answer that listed no Muse Code program, or up to 2 seconds before. Its output is collected whole, and of each line only whether it is Agent Lookout's own and, for a Muse Code program, when it started is kept: an answer that does not list Agent Lookout's own process is not used. A finish by `ps` needs an answer asked 2 seconds or more after the time judged, as a disk can keep a write's time rounded down, and none for an answer asked because the clock was set back, for files unchanged since. On macOS, after the clock is set back by more than a minute, a write stamped between the time it was set back to and the latest time seen is not finished by a start that looks later. When the computer started is the earliest worked out while Agent Lookout runs.

### Names of the program

A program counts when the last part of its name is `muse` or `muse.exe`, or begins `muse-` with more after it, compared case-sensitively, so a Mac app named `Muse` does not count:

- `muse` is the command (Meta's product overview; `sdk:clients/sdk-ts/src/connection/discovery.ts`), and Meta's cookbook stops it with `pkill -9 -x muse` (`cb:audit/README.md`).
- The Homebrew cask installs one file, `muse-<arch>-<os>`, as `muse` (Homebrew/homebrew-cask at `87c2c5d`, `Casks/m/muse-code.rb`, BSD-2-Clause).
- Readers report `muse-bin-<version>` running behind a `muse` launcher, and `.exe` on Windows (Irrlicht, seen on 1.2.1; Collie; stablyai/orca at `20b6610`, MIT).
- Linux keeps a program's first 15 bytes, so `muse-bin-1.4.24-R9131.1` shows as `muse-bin-1.4.24`, which still begins `muse-`.

`tbh-linux-sandbox`, Muse Code's Linux sandbox helper (dev.meta.ai changelog, 1.4.10), does not count. Any other program called `muse`, or whose name begins `muse-`, such as the MusE sequencer on Linux, counts, and can only keep a session from finishing.

### Known limits

- **Any older Muse Code holds every session.** A long-running `muse serve`, `muse acp` in an editor or another terminal's Muse Code that started before a session's last write keeps that session from finishing while it runs. A session whose own Muse Code was killed mid-turn shows as working for up to 30 minutes, then unknown, or as needing you with no time limit when it was waiting; one whose terminal was closed without a `session.end` shows as idle.
- **A running name of another shape finishes live sessions.** If Muse Code's program runs under a name other than `muse`, `muse.exe` or `muse-…`, `ps` finds none, and every session not closed by `session.end` shows as finished 2 seconds after each write, while it works too.
- **A turn cut off by a crash** shows as idle after the resume, not failed, unless Muse Code writes a failed end for it. Meta says a host-death failure is synthesized on the next resume or read (turns, "What turn terminal states mean"), not that it is written to `session.jsonl`.
- **Waits:** a subagent's question or approval is not shown on its parent, whether in a `subagent/` log, on another stream of the parent's log or in a folder of its own, so the parent shows as working. An approval the reviewer holds shows as working for up to 2 minutes, and so do the first 6 seconds of a request on a build that writes no phase and no review. A question asked under `--yolo`'s async questions shows as needing you while the agent goes on.
- **Reading:** a session whose newest turn began more than 8 MiB before its log's end is unknown, even once the turn ends. A deciding line whose fields are not in its first 1 MiB makes a session unknown until its next turn. A frame is never opened, so a deciding record put inside one would be missed. A session's folder is missing when its metadata record is not in the first 64 KiB.
- **Listing:** a session resumed from an old day folder appears up to a minute late, and sessions leave the list a day after their last write, unless one needs you.
- **Closing a terminal window** may end Muse Code with SIGHUP, and whether that writes `session.end` is not documented, so such a session finishes by `ps` alone.
- `--no-session-log` sessions write nothing and are never seen (HO; durability).

## Names and folder

The name is the workspace folder's last part, else `muse-code:` and the session's ID. A session's `name`, `title`, `generatedName` and `firstUserPrompt` (`d.ts`, `Session`) are typed by you or made from your words, and are never read, nor is a `session.name.changed` record or a terminal title. The folder is `workspace_root`, which can differ from the folder Muse Code was started in. The start is the time a version 7 UUID holds in its first 48 bits, when the folder's name is one with the RFC variant, as Meta names a session (turns), else the metadata record's time: Meta's own 0.1.0 export holds a version 4 ID.

## Quiet for, tokens, Jump, Stop and Answer

Quiet for is the time since the log's last write, while a session works, for up to 30 minutes. Muse Code writes `resource_usage_sampled` during a run (readers), so a live turn usually writes within that time, though a long command, or a subagent with a log of its own, may not. Tokens are not read: Muse Code's counts are on lines that are stepped over. There is no Jump, Stop or Answer: nothing read names a session's process or terminal, and Agent Lookout makes no request to Muse Code.

## On Windows

The folder is assumed, and `ps` is not run, so the way read is `files-without-processes`. A session shows as failed or finished only when Muse Code wrote that its last turn failed or that it let the session go, and as unknown otherwise, as a crash leaves turns, questions and approvals open in the log. Under WSL, pointed at Windows' folder, `ps` cannot see `muse.exe`, so sessions show as finished between writes. Whether reading a log while Muse Code writes it on Windows can make a write fail is not known.

## Not yet checked

On a computer running Muse Code:

1. The data folder on each system, that `XDG_DATA_HOME` moves `sessions/`, what a relative one does, that `MUSE_DATA_DIR` does nothing, and whether day folders are named by local date or UTC.
2. What `ps -A -o pid=,lstart=,comm=` shows for the terminal app, `muse exec`, `muse serve` started by an SDK, `muse acp` in an editor, and each way of installing it, on macOS and Linux.
3. Which ways of quitting write `session.end`: `/quit`, `/exit`, Ctrl-C, Ctrl-D, closing the window, `kill` and `kill -9`, and whether `/resume` to another session writes one for the session it leaves.
4. On 1.4.24, the shapes of `started` and `terminal`, that `kind` comes before `prompt`, what Esc, a provider error and a retracted turn write, whether a host-death failure is written on resume, and how often `resource_usage_sampled` is written during a long command.
5. The question records' names and outcomes, and where a subagent's question goes.
6. The approval records' order and times, the values of `presentation_phase`, that a profile with no reviewer writes `human_pending` and no review, what the fallback to asking you writes, and what recovery writes for a parked approval on resume.
7. That every deciding record is on the session's own stream, with a lowercase ID, and that no `retained_frame` holds one.
8. How far a log's newest `started` sits from its end, how long its lines get, and where its metadata record sits.
9. Whether pruning behind compaction, or the 16 MiB checkpoint, rewrites `session.jsonl`.
10. Whether any record carries a null `payload_type`, as the cookbook's prose says while its schema and export do not.

## What breaks when Muse Code changes

| Change in Muse Code                                                          | What the dashboard shows                                                                     |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The data folder or the `sessions/YYYY/MM/DD/<id>/session.jsonl` layout moves | Not found, or found with no sessions                                                         |
| `schema_version` goes past 1                                                 | Sessions unknown, and the card says the log format is newer                                  |
| Session or stream IDs stop being lowercase UUIDs                             | Sessions not listed                                                                          |
| `runtime.session`, `run`, `started` or `terminal` are renamed or moved       | Sessions not listed, or unknown                                                              |
| The deciding fields move past a line's first 1 MiB                           | Those sessions unknown                                                                       |
| `user_input_prompt_*` are renamed                                            | Questions show as working                                                                    |
| `presentation_phase` and `automated_review_*` stop being written             | Every reviewed approval shows as needing you after 6 seconds                                 |
| `presentation_phase` alone is dropped or renamed                             | No change: the review records decide                                                         |
| `automated_review_completed` stops being written while the phase stays       | Reviewed approvals show as needing you 2 minutes after the request                           |
| `decision_applied` and `approval_wait.effect.terminal` are renamed           | Approvals stay needing you until the run ends                                                |
| `session.end` is renamed                                                     | Sessions finish by `ps` alone                                                                |
| `session.resumed` is renamed                                                 | A session resumed after a crash shows the dead turn as working while an older Muse Code runs |
| The running program is renamed away from `muse`, `muse.exe` and `muse-…`     | Every session not closed by `session.end` shows as finished 2 seconds after each write       |
| `runtime.session.metadata` moves past 64 KiB or is renamed                   | Sessions named `muse-code:<id>`, with no folder                                              |
| Deciding records move into frames                                            | Those signals are missed                                                                     |

To check a new version, read Meta's host-operations, approvals and sessions-and-turns pages, `RawLogRecordEnvelope` and `TurnTerminal` in the schema, and the changelog, then compare one real session's line kinds, names and counts, never its words, with the table above.
