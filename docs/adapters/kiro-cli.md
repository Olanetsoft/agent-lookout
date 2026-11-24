# Kiro CLI adapter notes

These notes record what Agent Lookout reads from Kiro CLI, where each value comes from, and what breaks when Kiro changes. When the adapter stops working, start here.

Written on 2026-11-23 from public material alone. Kiro CLI, the command `kiro-cli`, is not open source. So no Kiro program or package was downloaded, unpacked, read, disassembled or run to write these notes, and no real session or `~/.kiro` folder was looked at. What is here comes from two kinds of source, and only facts and shapes were taken from either:

- Kiro's own documentation at [kiro.dev/docs](https://kiro.dev/docs), read on 2026-11-22. Kiro CLI 3.0.0 came out on 2026-11-03, and the newest build the documentation names is 3.5.0.
- Open-source readers of Kiro's files, each read at a fixed commit after its licence was checked: MIT, Apache-2.0, or MPL-2.0 for one. They saw Kiro CLI from 2.5.1 to 2.36.0, with V3 turned on by `--v3` before 3.0.0. Where a reader names Kiro's own internal functions, or took what it says from Kiro's program, that claim is not used, and no repository with no licence is.

The fixtures are written by hand. **The adapter was built from Kiro's documentation and open-source readers of its files, and has not yet been checked on a computer running Kiro CLI.** The Sources view says so too.

The citations:

- `docs:page` is a page under kiro.dev/docs, with its line where it helps.
- `owner/repo@commit:path:line` is an open-source reader, with its licence after it.

| Short name              | Repository and commit                                                      | Licence    |
| ----------------------- | -------------------------------------------------------------------------- | ---------- |
| atuin                   | `atuinsh/atuin@86573ef2dbeb`, `crates/atuin-common/src/harnesstools/kiro/` | MIT        |
| collie                  | `AltanS/collie@44f349353570`, `bridge/journal/`                            | MIT        |
| session-inspector       | `kirodotdev-labs/session-inspector-for-kiro@42fbb2b6ad2b`, Kiro's labs     | Apache-2.0 |
| KiroCrew                | `kirodotdev/KiroCrew@48ed4ccfc039`, Kiro's own organisation                | Apache-2.0 |
| Irrlicht                | `ingo-eichhorst/Irrlicht@4f9ed3989d10`, live recordings of 2.5.1           | MIT        |
| ai-devkit               | `codeaholicguy/ai-devkit@210605adc1f6`                                     | Apache-2.0 |
| agent-office            | `ignitrondev/agent-office@513082eb9aa4`                                    | Apache-2.0 |
| bugyo                   | `Sannrox/bugyo@41367e03f3fa`, notes on 2.11.1                              | Apache-2.0 |
| SessionZero             | `notnotrachit/SessionZero@b67cdd4dc60f`                                    | MIT        |
| web-terminal-kiro       | `cplieger/web-terminal-kiro@4ac2fb222c80`, locks from real runs            | MPL-2.0    |
| deja-vu                 | `vshulcz/deja-vu@389f7782b64e`, `docs/registry/kiro.md`                    | MIT        |
| JustSessions            | `yangzichao/JustSessions@6011872c6c07`                                     | MIT        |
| codeburn                | `getagentseal/codeburn@c08d761087af`                                       | MIT        |
| mezame                  | `aichholzer/mezame@0f2e24e9d9da`                                           | MIT        |
| franken_agent_detection | `Dicklesworthstone/franken_agent_detection@0aa31157d399`                   | MIT        |
| agent-git               | `Einsia/agent-git@6a0a82aa6a4f`, notes on 2.14.1                           | MIT        |
| Pulse                   | `qunqin24/Pulse@c48b2ed6924e`                                              | Apache-2.0 |
| wakely                  | `sloemo01/wakely@8c4629d14666`                                             | MIT        |
| agent-fleet             | `k-k1/agent-fleet@c691ea648433`                                            | Apache-2.0 |

The code is in `src/collector/adapters/kiro-cli/`. `index.ts` builds the adapter and works out Kiro's folder, `stores.ts` finds the sessions in both stores, `headers.ts` reads each session's header, `locks.ts` reads its lock and judges whether it is open, `lineLog.ts` reads a log's newest lines in file order, `rows.ts` says what each line is, and `toSession.ts` makes the session. The status is given by `src/core/mapping/kiro-cli/kiroCliMapping.ts`.

## How it reads Kiro CLI, and why

It needs nothing installed and changes nothing. Kiro documents no list of its sessions for other programs: `kiro-cli chat --list-sessions` and `/sessions` print one for a person, and its ACP server needs a client to start it. So the adapter reads the files Kiro keeps for each session, read-only, and on a Mac asks `ps` when the process a lock names started. It runs no Kiro program, never writes, clears or takes a lock, and never opens `session-index/`.

Kiro's documentation tells clients not to write session files and not to depend on the V3 layout, which it calls the server's (`docs:cli/v3/acp-migration.md` L21, L130, L148-150). So the adapter fails closed: anything it does not recognise reads as unknown, never as a status it guessed.

## Where it looks

By default Kiro's session store is `~/.kiro/sessions/` (`docs:permissions.md` L303). `KIRO_HOME` moves it, in 2.x from 2.3.0 and in V3, and must be set before Kiro starts. In V3 Kiro takes it only as an absolute path that is not a file system's root, the home folder or a folder above it, and otherwise uses `~/.kiro` (`docs:reference/settings.md` L372, `docs:changelog/cli/2-3`). How 2.x treats such a value is not documented. The adapter follows V3's rule for both stores, comparing without regard to case on Windows, and the Sources card says when `KIRO_HOME` is set and passed over. `AGENT_LOOKOUT_KIRO_HOME` names the folder for Agent Lookout alone and wins over both.

The collector sees only its own environment. A `KIRO_HOME` set in your shell's profile, and not where Agent Lookout starts, as for the Mac app, is not seen, and `~/.kiro` is read. Set `AGENT_LOOKOUT_KIRO_HOME` to the same folder then.

With no folder there, the card says Kiro CLI was not found and the adapter looks again once a minute. With `AGENT_LOOKOUT_KIRO_HOME` set, a folder that is not there is an answer, and no sessions are listed.

## The two stores

V2 and V3 keep separate stores. V2 cannot open a V3 session, and resuming a V2 session in V3 makes a V3 copy and leaves the original in place (`docs:cli/v3/migration-guide.md` L19-25). From 3.0.0 interactive chat starts V3 by default, while a local headless run, `--no-interactive`, still starts V2 unless `--trust-all-tools`, `--cloud`, `--repo` or a V3 `--resume-id` is given (`docs:cli/agent-harness.md` L9-37, L99). Such a V2 run writes no file in the V2 store, one reader found: it keeps the conversation as a row of `conversations_v2` in `kiro-cli/data.sqlite3` in the local data folder, which is not read, so it is not listed (deja-vu `kiro.md:6,20-24`). The adapter reads the two stores side by side and never merges them, so a V2 session resumed in V3 shows twice, as the original and its copy. No field that ties the two is confirmed.

### V3

Each session is a folder `sessions/<bucket>/sess_<uuid>/`, for every bucket but `cli` (atuin `session.rs:1-5`; session-inspector `sessions/cli.rs:17-18,351-355`, `paths.rs:37-45`; collie `kiro.ts:3-7`; SessionZero `kiro_cli.rs:3-8`). In it:

- `session.json`, the header. Of it only `title`, the first of `workspacePaths`, `createdAt`, `createdReason` and `parentSessionId` are read (session-inspector `cli.rs:206-250`; atuin `session.rs:2-4,37-41,965-971`). The rest, `lastModifiedAt`, `modelId` and anything else, is dropped with the parsed file.
- `messages.jsonl`, the row log, one row `{"id":…,"timestamp":…,"payload":{"type":…}}` on each line (atuin `session.rs:7-8`; collie `kiro.ts:3`; deja-vu `kiro.md:16-18`).
- `.lock`, while the session is open (collie `kiro-discovery.ts:7-9`; JustSessions `KiroSessionLock.swift:3-5`).

A subagent's log is `sess_<id>/sub-executions/<subSessionId>.jsonl` (atuin `session.rs:63-69`). Nothing in `sub-executions/` is read: a subagent is not listed as a session. A `sess_` folder whose header has `createdReason` `subagent` and names a `parentSessionId` is a subagent's too, and is not listed. One that names a `parentSessionId` with another `createdReason` is a conversation forked by a rewind or a tangent, and is listed (atuin `session.rs:81-83,965-971`). The Kiro IDE writes this store too, as V3 is the IDE's harness (`docs:cli/agent-harness.md` L13; session-inspector `cli.rs:351-353`), so an IDE session is listed as a Kiro CLI one.

### V2

The V2 store is `sessions/cli/` (`docs:cli/v3/acp-migration.md` L21), a flat set of files for each session (Irrlicht `1-4_session-resume/metadata.json`; bugyo `acp-notes.md:279-287`; ai-devkit `KiroSessionLocator.ts:33,77-104`; agent-office `kiro.ts:6-9`):

- `<uuid>.json`, the header. A session is found by it. Of it only `cwd`, `created_at`, `parent_session_id` and `session_created_reason` are read (codeburn `kiro.ts:435-441`; session-inspector `cli.rs:85-155`; JustSessions `KiroSessionMetadata.swift:12-16`). Its `title`, which is the first prompt word for word, `session_state` and the rest are dropped with the parsed file. A header with `parent_session_id` is a subagent's session, which is not listed (deja-vu `kiro.md:144-149`), unless `session_created_reason` is `rewind` or `tangent`. A rewind makes a new session whose header has `session_created_reason` `rewind` and a `parent_session_id` that names the original, and the person's next turn runs in it (Irrlicht `1-6_checkpoint-rewind/metadata.json`, live on 2.6.0). A tangent names the session it came from too (JustSessions `KiroSessionMetadata.swift:15`). `session_created_reason` alone says nothing, as V2 writes `subagent` there for top-level sessions too (deja-vu `kiro.md:148-149`; JustSessions `KiroSessionMetadata.swift:12-13`).
- `<uuid>.jsonl`, the transcript.
- `<uuid>.lock`, while the session is open.

A `.history` file, a `<uuid>/` folder and a `<uuid>.lock` that is a folder are passed over.

## What it reads, and how

- Every folder from `sessions/` down is looked up with `lstat` and must be a real folder, not a link. A file is opened without following a link at its name and only as an ordinary file.
- A header is read whole, up to 4 MiB. Over that, its session is not shown and the card says so.
- A lock is read whole, up to 4 KiB.
- A log is read one complete line at a time and always in file order, never by the time a row gives: V3 row times are not in file order (atuin `session.rs:78`; collie's fixture). The first read goes back from the end, at most 8 MiB, to the newest line the status needs, and later reads take only the lines added. A line still being written, with no newline after it yet, is left for the next read.
- A file that shrank, was replaced by another, or no longer has a newline where the last read ended, is read afresh from its end. atuin (2.36.0) and collie (2.32.0) find the V3 log only appended to, and one other reader says it is rewritten whole, from a source that is not used here, so the adapter is ready for both.
- Each file is opened again only once its size, modified time or identity changed. A lock that could not be opened or read is opened again on the next poll.

Of a V3 log, a line is parsed only when `"turn_`, `"pending_interaction"` or `"interaction_resolved"` appears in it, which now and then is a prompt or a tool's output that holds those words. Of a line parsed only `payload.type`, `timestamp`, `payload.toolCallId` and `payload.interactionType` are kept, and the rest is dropped with the parsed line. Every other line is passed over unparsed once it is seen to start with `{` and end with `}`. Of a V2 transcript each line read is parsed, and of it only `version`, `kind`, whether an `AssistantMessage` holds a block of kind `toolUse`, and a `Prompt`'s `data.meta.timestamp` are kept. No prompt, reply, question, command or tool's output is kept, copied or logged.

A session is looked up in full on every poll while it was written in the last day, has a lock, or was seen open in the last day. Any other session is looked up only for its lock, with an `lstat` of its folder and of its `.lock` in V3, and in V2 from the listing of `cli/`, which names each lock, and is looked up in full once a minute. A session is listed while it is open or not known to be closed, and for a day after it was last written or last seen open.

## The lock

Kiro's documentation says a local session is open in one process at a time, and that opening it elsewhere fails, naming that process (`docs:cli/chat/session-management.md` L221-225, L251). It does not name the lock. Readers of the files find `cli/<uuid>.lock` for V2 and `sess_<uuid>/.lock` for V3 (Irrlicht `1-2_session-end/metadata.json`; KiroCrew `acp_runtime_start.py:112-136`; collie `kiro-discovery.ts:7-9`; JustSessions `KiroSessionLock.swift:3-5`; web-terminal-kiro `kirolocksweep.go:16`), holding one line of JSON with an integer `pid` and an RFC 3339 `started_at` (web-terminal-kiro's locks from real runs; KiroCrew `acp_runtime_start.py:116`; bugyo `acp-notes.md:287-288`; SessionZero `kiro_cli.rs:157-161`). On Linux a V3 lock also holds `linux_boot_id` and `linux_start_ticks` (web-terminal-kiro, one source), which are not read.

Kiro removes the lock on a clean exit, `/quit` in the terminal app or the end of stdin or SIGTERM for `kiro-cli acp`, and a session resumed with `--resume-id` holds it again (Irrlicht; agent-fleet `driver.go:10-16,270-272`; bugyo; KiroCrew). A process killed or crashed leaves its lock behind, still naming the dead process (KiroCrew; bugyo; mezame `session.rs:3-13`; collie; web-terminal-kiro). The process a lock names is not `kiro-cli` itself: in V3 it is the terminal app's process, and in V2 a helper below `kiro-cli` (collie `kiro-discovery.ts:7,48-49`; JustSessions; ai-devkit `KiroSessionLocator.ts:39-41`). So it is used only to tell whether the session is open, never to find a terminal.

A session is:

| Its lock                                                                                                   | Open    |
| ---------------------------------------------------------------------------------------------------------- | ------- |
| None, or in V2 a folder at its name                                                                        | closed  |
| A link or anything else at its name, over 4 KiB, not JSON, or with no `pid` that is a whole number above 0 | unknown |
| Its `pid` not running, by signal 0                                                                         | closed  |
| A `started_at` that cannot be read                                                                         | unknown |
| Taken before the computer started                                                                          | closed  |
| On a Mac, `ps` says its process started more than a minute after the lock was taken                        | closed  |
| On a Mac, `ps` says its process started no later than a minute after                                       | open    |
| On Linux and Windows, or when `ps` cannot say                                                              | unknown |

The minute is the same as other adapters give `ps`, whose start times are whole seconds. Readers of Kiro's files use 5 seconds (JustSessions) and 2 minutes (SessionZero), and web-terminal-kiro requires the process to start no later than the lock. `ps -o pid=,lstart= -p <pids>` is run every 30 seconds while a lock names a process that runs, and sooner when another such lock appears, and asks only for each process's ID and start, never its arguments. Once `ps` says a lock's pid is another program's, the session stays closed while that pid runs. A lock left behind is left as it is.

## Status

A session that is not open is finished, whatever its log says. One that is open, or not known to be closed, takes its status from its log.

### V3

The log brackets each turn: `turn_start` follows the person's row, and `turn_end`, with a `stopReason`, closes it (collie's fixture, written by Kiro 2.32.0; atuin `session.rs:29-31`; wakely `AgentAppSessionState.swift:80-81`; Pulse `AgentActivity.swift:276-279`). A wait for an approval is a `pending_interaction` row, with `interactionType` `tool_approval` and a `toolCallId`, answered by an `interaction_resolved` row with the same `toolCallId`, both inside the turn (collie's fixture; atuin `session.rs:31-32`; wakely; deja-vu). The adapter keeps the newest turn row and the waits asked since the newest `turn_start` with no answer yet. A turn row clears them.

| The newest turn row                          | Open, or not known | Not open |
| -------------------------------------------- | ------------------ | -------- |
| `turn_start`, with a wait unanswered         | needs-you          | finished |
| `turn_start`                                 | working            | finished |
| `turn_end`                                   | idle               | finished |
| none, with the whole log read, or no log yet | idle               | finished |
| another `turn_…`, or none in the 8 MiB read  | unknown            | finished |
| a log that is not a file, or cannot be read  | unknown            | finished |

A line since the newest turn row that cannot be read, or a `pending_interaction` or `interaction_resolved` with no `toolCallId`, makes it unknown until the next turn row. A link, a folder or anything but an ordinary file at the log's name, or a log that cannot be looked up or read, makes it unknown too, in both stores. Only nothing at its name is no log yet. A wait for a `tool_approval` needs you for permission, and any other `interactionType` for another reason. Every other row is bookkeeping, a message or a tool's call or result, and does not change the status.

The status time is when the oldest unanswered wait was asked while it needs you, when the turn started while it works, and when it ended while it is idle, each as its row says. An idle session with no turn row has been idle since its log, or its header with no log, was last written.

### V2

Each line is `{"version":"v1","kind":…,"data":{"content":[…],"meta":{"timestamp":…}}}`, with blocks of kind `text`, `thinking`, `toolUse` or `toolResult` in `content`, and a time in seconds only on a `Prompt` (Irrlicht `parser.go:11-17`; franken_agent_detection `kiro.rs:8-30`; agent-office `kiro.ts:22-26`; agent-git, on 2.14.1). The kinds seen are `Prompt`, `AssistantMessage` and `ToolResults`, and `Clear` is named, with no payload known (Irrlicht `parser.go:62-88`; codeburn `kiro.ts:431`; mezame `http.rs:533-582`). An `AssistantMessage` with a `toolUse` block is in the middle of a turn, and the last one of a turn has none. V2 writes no record at a turn's end (Irrlicht `parser.go:19-22`, checked live on 2.5.1; agent-office `kiro.ts:35-50`; ai-devkit `KiroSessionParser.ts:134-144`; Pulse `AgentActivity.swift:291-302`).

| The newest record, a `Clear` passed over                                                 | Open, or not known | Not open |
| ---------------------------------------------------------------------------------------- | ------------------ | -------- |
| `AssistantMessage` with a `toolUse` block                                                | working            | finished |
| `ToolResults`, `Prompt`                                                                  | working            | finished |
| `AssistantMessage` with no `toolUse` block                                               | idle               | finished |
| none, with the whole transcript read, or no transcript                                   | idle               | finished |
| a transcript that is not a file, or cannot be read                                       | unknown            | finished |
| another `kind`, another `version`, a line that does not parse, or none in the 8 MiB read | unknown            | finished |

A V2 session never needs you. Irrlicht saw, live on 2.5.1, that V2 writes the `toolUse` that waits for approval before it asks, and nothing after it until the person answers, so the wait reads as working. It also saw a turn with no tool write nothing until it ended, so such a turn reads as idle while it runs. Both come from one source, and the card says so. Irrlicht found no record V2 writes to its transcript when a turn is stopped with Esc or Ctrl-C, or cut off by an error, though it did not record either live, so such a turn reads as working until the next turn ends (Irrlicht `2-20_user-esc-interrupt/metadata.json`, `2-14_turn-aborted-by-error/metadata.json`). It says the header records the end, as `end_reason` in `session_state`, but it took the values for a cancel and an error from Kiro's program and saw only `UserTurnEnd` written, so the header is not read for it.

The status time is the newest `Prompt`'s while it works, and the transcript's modified time while it is idle.

### Finished, and failed

A finished session has been so since the later of its last write and the last poll that saw it open. No session is ever failed: Kiro's turn rows and records are not read for errors.

## Names and folder

A V3 session is named by its header's `title`, trimmed, else by its folder's last name, else by its ID. Kiro asks a model for that title at the session's first prompt, and with `KIRO_DISABLE_SESSION_TITLE_LLM` set to `true` it asks none and the session goes untitled (KiroCrew `test/test_kas_session_title_env.py:1-7`, `docs/system-specs/modules/acp-client.md:4502`). `/rename` replaces it (atuin `session.rs:41-42`), and `/sessions rename <name>` sets a title on this computer (`docs:reference/slash-commands.md`). A title made only of spaces, and the literal `(no title)`, which one reader saw in a V2 header, are no title. A V2 session is named by its folder's last name, else by its ID, because its header's `title` is the first prompt word for word, case and all (agent-git `samples/kiro/session-2293dba9.jsonl` and `.state.json`, `layout-and-index.txt`, on 2.14.1), so it is never read, and a name given to a V2 session is not shown either. A prompt is never read for a name. The folder is the first of `workspacePaths` in V3, the folder the session was started in, and `cwd` in V2.

A V3 session's ID is its folder's name, `sess_<uuid>` (atuin `session.rs:126-127`; deja-vu `kiro.md:35-39`), and a V2 one's its files' stem, a bare UUID (`docs:cli/chat/session-management.md`). The ID in Agent Lookout is `kiro-cli:` and that. Kiro resumes either with `kiro-cli chat --resume-id <ID>`, which it prints when a session ends (`docs:cli/chat/session-management.md` L32, L67). Agent Lookout does not offer to copy that command: its Resume button is Claude Code's alone.

## Quiet for, tokens, Jump, Stop and Answer

Quiet for is the log's modified time. Irrlicht saw V2 write each record whole once it is made, so a long reply or a tool-free turn looks quiet while it runs. No token counts are read. There is no Jump and no Stop: the lock names Kiro's terminal app's process, or a V2 helper, and no terminal or window, and Agent Lookout does not confirm that process. Agent Lookout does not talk to Kiro, so it cannot answer a wait.

## On Windows

The files are read as on macOS and Linux, and `KIRO_HOME` is compared without regard to case. `ps` is not run, so a lock whose process runs leaves a session not known to be closed, and its status comes from its log. How Kiro keeps its locks on Windows is not checked.

## Known gaps

- On Linux and Windows, and on a Mac when `ps` cannot say, a lock left by a crash whose pid now belongs to another program keeps its session showing what its log said, often working, until that program ends or the computer restarts.
- A Kiro IDE session with no lock shows as finished, even while the IDE has it open.
- A V2 turn with no tool shows as idle, and a V2 approval as working.
- A V2 turn stopped with Esc or Ctrl-C, or cut off by an error, shows as working until the next turn ends, as no reader saw V2 write it to its transcript (Irrlicht).
- A headless V2 run, `kiro-cli chat --no-interactive`, is not listed: it writes no session file, only a row in `kiro-cli/data.sqlite3`, which is not read (deja-vu).
- A V2 rewind or tangent on Kiro 2.16 or later is not listed if its header says `subagent`, as the terminal app writes for every session it starts from 2.16 (JustSessions): beside a `parent_session_id`, that reads as a subagent's session. Which reason a rewind or a tangent writes there is not checked.
- A wait a subagent asks shows as working, if Kiro writes it only in the subagent's log in `sub-executions/`, which is not read. Where Kiro writes it is not checked.
- Kiro's live signals of a wait, its terminal state over OSC 7501, the `PermissionRequest` hook from 3.4.0 and ACP's `session/request_permission` (`docs:cli/terminal-ui.md` L99-104; `docs:hooks/types.md` L17-35, L252-317), are not used: each needs Agent Lookout to be Kiro's terminal, a hook Kiro runs, or its ACP client.

## Not yet checked

1. Whether V3 writes its `turn_start` and `pending_interaction` rows while the turn or the wait is still open, on a current 3.x build such as 3.5.0. Every V3 observation is from 2.16.2 to 2.36.0 run with `--v3`. If they reach the file only later, a V3 session reads as idle while it works or waits.
2. Whether Esc or Ctrl-C in V3 writes `turn_end`, and whether V2 writes anything to its transcript for Esc, Ctrl-C or an error. If not, the session stays working until the next turn ends.
3. `interactionType` values other than `tool_approval`.
4. Whether the Kiro IDE keeps a `.lock` in the `sess_` store, and how to tell an IDE session from a CLI one. One reader says a session listed in `~/.kiro/session-index/<bucket>.jsonl` came from the CLI (deja-vu), which is not used.
5. Which process holds the lock of a V3 ACP session, `kiro-cli acp --agent-engine=v3`, and where.
6. Whether V3's `--no-interactive` writes no lock, as one reader says. If so, such a run shows as finished while it runs.
7. The minute's slack against reused pids, reading a process's start on macOS, and Kiro's locks on Windows.
8. When V2 writes each record, and whether several `AssistantMessage` records can be pieces of one reply (deja-vu). A piece with no tool followed by one with a tool would show idle for a moment.
9. The documentation's line that sessions are kept in a SQLite database in `~/.kiro/` (`docs:cli/chat/session-management.md` L253, L260). One reader finds such a database only for headless runs, `kiro-cli/data.sqlite3` in the local data folder, not in `~/.kiro` (deja-vu `kiro.md:6,20-24`), and it is not read.
10. Whether `status` in `session.json`, `in_progress` or `idle` in readers' made-up samples, changes with each turn. It is not used.
11. The turn markers Kiro's terminal app keeps under `kiro-cli/run/turn-markers/` from 2.31.1 (JustSessions, one source), as a later signal of working for both stores.
12. Whether V3's lock moves to the new session on `/clear`, `/rewind` and `/sessions` (collie, one source). If so, the old session shows as finished and the new one as open, as they should.
13. What `end_reason` in a V2 header's `user_turn_metadatas` can be besides `UserTurnEnd`, and whether Kiro writes it when a turn is cancelled or cut off by an error. If so, it could end such a turn.
14. The literal `(no title)`.
15. What `session_created_reason` a V2 rewind's or tangent's header has from Kiro 2.16 on. Irrlicht saw a rewind write `rewind` on 2.6.0, and no reader saw what a V2 tangent writes. From 2.16 the terminal app writes `subagent` for every session it starts, the person's own included (JustSessions `KiroSessionMetadata.swift:12-13`). If a rewind or a tangent made there writes `subagent`, or any reason but `rewind` or `tangent`, beside its `parent_session_id`, it is taken for a subagent's session and not listed, though after a rewind the person's next turn runs in it.

## What breaks when Kiro changes

- A new layout of the V3 store, a new name for `session.json`, or a new bucket rule: no V3 session is found, and the card still says the folder is read.
- A new name for `messages.jsonl`: open V3 sessions read as idle, as with no log yet.
- A new name for `.lock`: every V3 session reads as finished, and one not written in the last day is not listed.
- A new `payload.type` for turn rows: the sessions read as unknown, or, for a new name that does not begin `turn_`, are passed over as bookkeeping and stay at the newest turn row they had.
- A V3 row split over more than one line: its pieces read as unknown.
- A lock with another shape, or another time field: open sessions read as unknown, which still shows their log's status.
- A V2 `version` other than `v1`: V2 sessions read as unknown.
- `KIRO_HOME` taken under other rules: Agent Lookout may read the default folder while Kiro uses another, or the reverse.
