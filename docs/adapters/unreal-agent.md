# Unreal Agent adapter notes

These notes record what Agent Lookout reads from Unreal Agent, where each value comes from, and what breaks when Unreal Agent changes. When the adapter stops working, start here.

Written on 2026-11-17 from Unreal Agent's source at `v0.3.1`, released 2026-10-06 (commit `55747f5` of [unreallabsai/unreal-agent](https://github.com/unreallabsai/unreal-agent)), the newest release then. Unreal Agent is Unreal Labs' coding agent: a terminal app, `unreal-agent-tui`, and a runner that answers one request, `unreal-agent-runner`, both built from Go. Unreal Agent is under the MIT licence. It was not installed or run to write these notes, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from Unreal Agent's source at v0.3.1 and has not yet been checked on a computer running Unreal Agent.** The Sources view says so too.

Another project has the same name, TREE Industries' Unreal Agent, an Unreal Engine editor plugin. It is not covered.

Each citation is `path:line` at `v0.3.1`. `.goreleaser.yaml`, `Dockerfile.release` and `LICENSE` are at the top of Unreal Agent's repository. A path that starts `localfile/` is in `harness/sessionstore/`, one that starts `TUI` is in `cmd/unreal-agent-tui/`, and one that starts `runner` is in `cmd/internal/agentrunner/`. These names stand alone: `codec.go`, `store.go`, `state.go` and `list.go` are in `harness/sessionstore/localfile/`, `sessionstore.go` in `harness/sessionstore/`, `session.go` in `harness/session/`, `model.go` in `harness/llm/`, `tool.go` in `harness/tool/`, `inbox.go` in `harness/inbox/`, `operation.go` and `shell.go` in `harness/operation/`, `loop.go` in `harness/coordinator/`, `directory.go` in `cmd/internal/xdgpath/`, and `runcontrol/stop.go` in `cmd/unreal-agent-tui/internal/`. Every other path is from the top. The lines were counted on the raw files.

The code is in `src/collector/adapters/unreal-agent/`. `index.ts` builds the adapter, `lines.ts` compares each line with the shapes Unreal Agent writes, `sessionFile.ts` reads a file and keeps what it read, `processes.ts` asks `ps` when Unreal Agent's programs started, and `toSession.ts` makes the session. The files are found by Pi's finder, `src/collector/adapters/pi/sessionFiles.ts`. In `src/core/mapping/unreal-agent/`, `unrealAgentReplay.ts` replays the lines, `unrealAgentLiveness.ts` tells from `ps` whether a program could hold a session, and `unrealAgentMapping.ts` gives the status.

## What the issue said, and what holds

Issue #76 was first written from the source at `main`, and rewritten from the source at v0.3.1 before this was built.

| What issue #76 said                                                                             | What the source shows                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit `a5f3fd1`                                                                                | That is `main`, one commit past the tag, changing only a README. The tag `v0.3.1` is commit `55747f5`, and these notes cite it                                                                                                                            |
| Each session is `<uuid>.session.jsonl`                                                          | `<id>.session.jsonl` (`localfile/store.go:22`, `:382-384`). The terminal app's id is a new UUID (TUI `run.go:202`), but a runner's can be any id of letters, digits and dashes its caller chooses (runner `run.go:658-666`; `localfile/store.go:470-484`) |
| The terminal app is `unreal-agent`                                                              | It is `unreal-agent-tui` (`.goreleaser.yaml:18`). Homebrew links it as `unreal-agent` and `uat` (`.goreleaser.yaml:69-70`)                                                                                                                                |
| The folder is under `XDG_STATE_HOME` when that is set                                           | Only when it is an absolute path (`cmd/internal/xdgpath/directory.go:18`), as [Where it looks](#where-it-looks) says                                                                                                                                      |
| A reply with no tool calls means idle                                                           | Not enough: a heartbeat's turn is answered while commands still run, and a compaction's reply is always followed by a turn (`loop.go:278-281`, `:641-643`). See [Status](#status)                                                                         |
| A tool call runs while its operation has not ended                                              | A tool call runs until its second status line is written, once all its commands have ended (`loop.go:863-900`). Its `WaitingFor` does not change between the two                                                                                          |
| A runner writes `when_idle` once its turn is answered                                           | It writes `when_idle` as it starts, before the first turn (runner `run.go:404-412`), and ends once idle (`loop.go:133-135`)                                                                                                                               |
| A reply with a `Failure` ends the session                                                       | Nothing ends: its tool calls still run, and the terminal app waits for the next message (`loop.go:231-259`)                                                                                                                                               |
| The project folder is in the file                                                               | Only as the `Directory` of a shell command, which is the folder the program was started in, or a runner's `-workspace` (`harness/tool/bash/bash.go:163-168`; TUI `run.go:190`, `:245`; runner `run.go:211`, `:327-331`)                                   |
| The Ctrl+C stop is written as a control input with `Mode` `hard`                                | True (`cmd/unreal-agent-tui/internal/runcontrol/stop.go:18`; TUI `run.go:282-284`)                                                                                                                                                                        |
| An error that ends the run is not written                                                       | True (`loop.go:231-237`)                                                                                                                                                                                                                                  |
| A heartbeat is written every 10 minutes during a long tool call, and the runner can turn it off | True (TUI `run.go:262`; runner `run.go:163`; `loop.go:137-141`)                                                                                                                                                                                           |

## How it reads Unreal Agent, and why

It needs nothing installed and changes nothing. It reads each recent session's file, read-only, and asks `ps` when each Unreal Agent program started. It runs no program of Unreal Agent's and makes no request to it.

Unreal Agent writes no lock or pid file, and a session's file names no process. A grep of `cmd/` and `harness/` finds no lock, no pid file and no `Getpid`. So the only tie between a session and a program is time: a program writes only to the session it opened after it started, and each program opens one session at most (TUI `run.go:202-203`; runner `run.go:291`).

Every line of a session's file is one record written by Go's `encoding/json/v2`, which writes a struct's fields in the order they are declared, writes compact output, and writes every `"` inside a string as `\"` (`localfile/codec.go:5-6`, `:230-243`). So each line is compared, from its start, with the bytes Unreal Agent writes for its kind, and a field is found only where the shape puts it. A string that can hold text is passed over to its closing `"`, minding `\`, and never turned into text.

## Where it looks

The first of these that applies is used:

| Setting                                  | The sessions folder                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR` | That folder, for Agent Lookout alone                                        |
| `XDG_STATE_HOME`, when absolute          | `unreal-agent/sessions` in it (`cmd/internal/xdgpath/directory.go:13-19`)   |
| None                                     | `~/.local/state/unreal-agent/sessions`, on macOS too (`directory.go:21-32`) |

Unreal Agent takes `XDG_STATE_HOME` only when it is an absolute path, as it is given: it is not trimmed, and `~` is not taken for the home folder (`directory.go:18`). Agent Lookout does the same. Unreal Agent reads `HOME` for the home folder (`directory.go:21-28`), and Agent Lookout the home folder Node gives.

Not followed:

- a runner's `-session-directory` (runner `run.go:160`), since a program's arguments are never read;
- the `/state` volume of Unreal Agent's Docker image (`Dockerfile.release:11`);
- `.harness/sessions` in the folder a runner was started from, where runners before 0.2.0 kept their sessions.

When the folder is missing, Unreal Agent is reported as not found, with no advice, and the folder is looked for again once a minute, or on every poll when `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR` is set. When that setting names a folder that is not there, or holds no sessions, that is an answer, not a missing Unreal Agent.

## What it reads

The sessions folder holds each session's file, `<id>.session.jsonl`, `.session-<random>.tmp` copies of a session being made (`localfile/store.go:386-411`), and `operations/<session ID>/<operation ID>/out` and `err`, the whole output of every shell command (`harness/operation/shell.go:466-477`; TUI `run.go:235-238`; runner `run.go:311-314`).

| Path                           | How                                                                                    | How often                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The sessions folder            | One `lstat`, and listed when its modified time moves. A link at its name is followed   | Every poll, and listed once a minute, or on every poll when it is a link           |
| Each `<id>.session.jsonl`      | One `lstat`. Only a name of 1 to 241 letters, digits and dashes, then `.session.jsonl` | Every poll, for the files written in the last day, the newest 200                  |
| Every other session file       | One `lstat`. Never opened                                                              | Once a minute                                                                      |
| A file written in the last day | Opened read-only, without following a link, as below                                   | When its size, modified time or identity changes, or a held-back whole read is due |

The finder is Pi's, flat: it never goes into a folder in the sessions folder, and drops every name that is not a session file's before anything is looked up. So the `operations` folder and the `.session-*.tmp` files are never opened or looked up, though the listing returns their names. A link at a session file's name is not followed. Unreal Agent's own listing takes only ordinary files with a valid id too (`localfile/list.go:33-40`).

Of a file it reads at most:

- its first 1 KiB, for its first line. A first line that does not end inside it is not a session file's, and the file is read again when it changes;
- its last 8 MiB, the first time, and the lines in them;
- after that, what was added, of at most 64 MiB, from the end of the last whole line read. The byte before must be a newline, and the first item added must be the one after the last item read. Otherwise, or when the file shrank, has another identity, did not grow but changed, or grew by more than 64 MiB, it is read as for the first time;
- the whole file, once, when the lines read do not reach its start and say the session waits, or said so at a hard stop, as [Reading the whole file](#reading-the-whole-file) says.

Every read goes in pieces of 1 MiB, each of which must come back whole, or the read is dropped and what was known stands. Bytes after the last newline are a line Unreal Agent is still writing, and are left until it ends, as Unreal Agent's own reader leaves them (`localfile/codec.go:88-94`). Of a line longer than 1 MiB, only its first 1 MiB and its last 32 bytes are kept while it is read. Lines are applied only once every one was read.

Never opened or looked up: `operations/**`, `.session-*.tmp`, `~/.config/unreal-agent` or `unreal-agent` in `XDG_CONFIG_HOME` with its `preferences.json` and `settings.json` (`directory.go:9-11`; TUI `run.go:132`, `:158`), the Codex sign-in `~/.codex/auth.json` Unreal Agent can use, a workspace's `.env` and `.harness/skills`, and a runner's `-log-directory` files (runner `run.go:162`). Nothing is written, and no Unreal Agent program is run.

### Reading the whole file

A command started before the last 8 MiB and still running has its first status there and no later line, so lines that do not reach the file's start cannot say the session waits. When they say it does, the whole file is read once, in 1 MiB pieces, if it is 64 MiB or less, and the session's state is the whole file's. After a hard stop, it is what they said at it that counts. This is done at most once for each time the file is read as for the first time, and not within 10 minutes of the last whole read of that file, so two programs that cut each other's lines cannot make it read the file on every poll. A whole read the 10 minutes held back is made on the first poll after them, even if the file has not changed. A clock set back counts as time enough. A file over 64 MiB is not read whole: its session shows as unknown while it seems to wait and a program could still hold it, and the Sources view says why. Quit with Ctrl+C, or with no program to hold it, it shows as finished, unless its newest reply failed or is unclear: then it stays unknown.

### Shrinking

Every append first cuts the file to the size its writer believes it has (`localfile/store.go:413-433`), so a file shrinks when a write failed part way, when a runner resumes a file with a cut line, and when two programs write one session, which nothing prevents. A file that shrank, or changed without growing, is read as for the first time.

## The session file

### The first line

```
{"type":"session","data":{"Version":2,"Session":{"ID":"<id>","CreatedAt":"<time>"}}}
```

(`localfile/codec.go:25-33`; `harness/session/session.go:17-20`). The ID must be the file's name without `.session.jsonl`, as Unreal Agent requires (`localfile/store.go:292-298`), or the file is not listed. A version above 2 is a newer Unreal Agent's: the session is not listed, and the Sources view says so. Version 1, which Unreal Agent itself refuses (`codec.go:114-121`), and any other first line, is not listed either. `CreatedAt` is the session's start.

### Item lines

```
{"type":"item","data":{"Item":{"Sequence":<n>,"RecordedAt":"<time>","Kind":"<kind>","Data":{…}}[,"Operations":[…]]}}
```

(`localfile/codec.go:35-38`; `harness/sessionstore/sessionstore.go:33-38`). Items are numbered from 1, one after another (`codec.go:137-145`). A gap is a line this does not read. The kinds are `fork`, `input`, `turn`, `model_response` and `tool_call_status` (`sessionstore.go:23-29`). Of each, only these are compared, as bytes:

| Kind               | Compared, in order                                                                                                                                                                                           | What it says                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`            | `"ID":"`, passed over, then `"Kind":"external"`; or `"Kind":"control","Payload":{"Mode":"` and the mode: `hard`, `when_idle`, `heartbeat` or `settings` (`harness/inbox/inbox.go:24-28`, `:51-56`, `:65-69`) | A message, or the control input's mode. The message's text, and a control input's reason, which for a heartbeat names the running commands, come after and are never reached |
| `turn`             | `"ID":"<uuid>","PreviousTurnID":"…","Type":"regular"` or `"compaction"`, and the line's end (`session.go:22-26`)                                                                                             | A turn began                                                                                                                                                                 |
| `model_response`   | `"TurnID":"<uuid>","Response":{"ID":"…","Stop":"<stop>"`, and the line's last bytes (`sessionstore.go:51-54`; `harness/llm/model.go:120-134`)                                                                | The turn it answers, and how it ended                                                                                                                                        |
| `tool_call_status` | `"TurnID":"…","CallID":"…","Status":{"Error":"`, then whether the error is empty, the IDs it waits for, and the first command's status (`sessionstore.go:56-61`; `harness/tool/tool.go:13-17`)               | A tool call's first or second status, or one that failed at once                                                                                                             |
| `fork`             | The kind alone                                                                                                                                                                                               | The items before are a parent session's                                                                                                                                      |

- **A reply.** `Stop` is `complete`, `refused`, `max_output_tokens` or empty (`model.go:122-126`). Its output, which holds the model's text, reasoning and tool calls, and its token counts come after and are never looked at. Its last field is `Failure`, null or `{"Code":…,"Message":…}` (`model.go:128-134`, `:162-165`), and nothing follows a reply in its line (`codec.go:35-38`, `:149-155`). So a line that ends `,"Failure":null}}}}}` has no failure, one that ends `"}}}}}}` has one, and any other ending is a line this does not read. The reply is complete with `Stop` `complete` and no failure, failed with a failure or `Stop` `refused` or `max_output_tokens`, as MiMo Code's are, and unclear with an empty or unknown `Stop`.
- **A tool call's status.** An error that is not empty means the call failed at once, and the error is never read on. Otherwise it waits for 1 to 64 commands, each a UUID, whose snapshots follow at the line's end as `"Operations":[…]` (`localfile/store.go:180-205`). The first status has its commands at `ready` (`loop.go:813-861`), and the second, written once they have all ended, at `completed`, `failed` or `canceled` (`loop.go:863-900`). It waits for every command the call started (`localfile/state.go:228-242`). A status with no error and nothing to wait for is not written at v0.3.1, and an empty error marked as cut, or a status with no commands after it, as a fork's parent's are, is a line this does not read.
- The IDs of replies and tool calls can hold any character, since a provider chooses them. An input's ID is a UUID at v0.3.1, and a runner refuses a message ID of its caller's that is not one (runner `run.go:634-637`), but Unreal Agent's store takes any input ID that is not empty (`inbox.go:30-33`), so every ID is read the same way. They are passed over, minding `\`, up to 4 KiB, and never turned into text or kept.

### Operation lines

```
{"type":"operation","data":{"Operation":{["MaxOutputLength":<n>,]"ID":"<uuid>","Type":"<type>","Version":<n>,"Status":"<status>","State":{…}}}}
```

(`localfile/store.go:207-229`; `harness/operation/operation.go:39-47`). A command's newest state, written at each step it takes. The status is `ready`, `awaiting`, `canceling`, `completed`, `failed`, `canceled` or empty (`operation.go:21-29`). `completed`, `failed` and `canceled` end it, and empty does not (`loop.go:997-1004`). Any other status is a line this does not read. Its state, which holds the command and, once it ends, its output, comes after.

### The one decoded token

For a shell command of version 3 (`shell.go:15-17`), the state begins with the command's input, then the folder its commands store their output in (`shell.go:36-52`, `:106`):

```
,"State":{"Input":{"Command":"<command>","Shell":"<shell>","Directory":"<folder>"},"BaseDirectory":"…
```

The command and the shell are passed over as bytes, minding `\`, the command within the 1 MiB kept of the line. The folder, up to 16 KiB, is the one part of any line decoded with `JSON.parse`, and only for the newest shell command's line in each read. It is the session's folder only when it is not empty, at most 4096 characters, has no control character and is absolute, as for every agent. Any step that fails gives no folder from that line, as for two records written into one line, which then holds `{"type"` where `","Shell":"` should be. `BaseDirectory`, the command's output and its paths are never looked at.

## Which sessions are listed

Each session whose file was written in the last 24 hours, by its modified time, the newest 200, with a first line as above. Both the terminal app's and the runner's are listed. A file with its first line and nothing more shows as idle. Not listed: a name that is not a session file's, a link, a first line that names another session or another version, and the folders [Where it looks](#where-it-looks) does not follow.

## Status

### What the lines say

`unrealAgentPhase` in `unrealAgentReplay.ts` replays the lines in order and gives a phase. Unreal Agent's coordinator is idle only with no model call, no input waiting, no tool call left and no command running (`loop.go:278-281`), and these rows follow that:

| Evidence                                                                                        | Phase   | Why                                   |
| ----------------------------------------------------------------------------------------------- | ------- | ------------------------------------- |
| A line this does not read, until the file is read afresh or a fork follows                      | unread  |                                       |
| The newest turn has no reply                                                                    | busy    | `loop.go:365-407`                     |
| A message or a heartbeat since the newest turn                                                  | busy    | `loop.go:181-216`, `:597-616`         |
| A tool call ended, or failed at once, since the newest turn                                     | busy    | `loop.go:215`, `:712-723`, `:902-909` |
| A tool call has its first status and not its second, or a command's newest line does not end it | busy    | `loop.go:278-281`, `:330-337`         |
| The newest reply answers a compaction turn                                                      | busy    | `loop.go:641-643`                     |
| The newest reply answers a regular turn, or there is none, read from the start                  | waiting |                                       |
| The same, from lines that do not reach the start, or after a reply whose turn was not read      | unsure  |                                       |

- Only the newest turn counts. A message during a model call starts a new turn, and a late reply to the older one is not written (`loop.go:170-172`, `:421-433`). A reply to another turn is a line this does not read.
- A `settings` input starts each launch (TUI `run.go:213-224`; runner `run.go:369-385`), and begins a new run: a runner that resumes a session takes up no old stop (`loop.go:586-616`). Messages not yet answered and commands carry over.
- A `fork` item clears what the coordinator clears at it, the tool calls and the commands, and keeps the messages not yet answered (`loop.go:581-584`). The items before it are the parent's, copied first (`localfile/codec.go:157-159`). No program of Unreal Agent's makes a fork at v0.3.1: `Store.Fork` is called only by tests.
- The lines read are complete when they begin with the first item, hold item 1, or hold a fork.

### Ended

- **Ctrl+C.** The terminal app writes a control input with `Mode` `hard` as it quits, on Ctrl+C, `SIGINT` or `SIGTERM` (`cmd/unreal-agent-tui/main.go:16`; TUI `run.go:269-291`; `runcontrol/stop.go:12-31`). Commands are then cancelled, and their lines can follow it (`loop.go:267-276`), so what the lines said at it is the phase used.
- **A runner.** It writes `when_idle` as it starts (runner `run.go:404-412`) and ends once idle (`loop.go:133-135`). So a session whose run has `when_idle` has ended once it waits.

A failed reply ends nothing: its tool calls still run (`loop.go:231-259`).

### The status

`mapUnrealAgentStatus` in `unrealAgentMapping.ts`. The rows are taken in order:

| Phase and reply                 | Ended | Program that could hold it | Status                                     |
| ------------------------------- | ----- | -------------------------- | ------------------------------------------ |
| unread                          | any   | any                        | unknown                                    |
| waiting, reply failed           | any   | any                        | failed                                     |
| waiting, reply unclear          | any   | any                        | unknown                                    |
| unsure, reply failed or unclear | any   | any                        | unknown                                    |
| busy, waiting or unsure         | yes   | any                        | finished                                   |
| the same                        | no    | none                       | finished                                   |
| busy                            | no    | may run, or cannot tell    | working, or unknown after 30 quiet minutes |
| waiting                         | no    | may run                    | idle                                       |
| waiting                         | no    | cannot tell                | unknown                                    |
| unsure                          | no    | may run, or cannot tell    | unknown                                    |

A reply with tool calls is followed at once by their statuses, each one more write (`loop.go:475-495`). So a reply that is the file's newest line, written less than 2 seconds ago, counts as busy, unless no program could hold the session, which then writes nothing more. A hard stop is never so counted.

A session's last write is its file's modified time, taken from the file as it was opened, so a write since it was looked up counts with the lines it added. Its status time is when its newest turn began, or its first message since, for a working session; its newest item's time for an idle one; its newest reply's for a failed one; and its last write for a finished one. None is kept when it is more than 2 seconds before the session's start.

The poll's basis is `files` while `ps` shows an Unreal Agent program, `files-closed` while it shows none, and `files-without-processes` while it cannot say.

### Open or closed

`unrealAgentLiveness` in `unrealAgentLiveness.ts` tells, for a session that has not ended, whether a program that could hold it runs. The program's start is from `ps`, and the write is the file's modified time:

| Rule | Evidence                                                                     | Answer      |
| ---- | ---------------------------------------------------------------------------- | ----------- |
| L0   | `ps` could not be run, or was not                                            | cannot tell |
| L1   | `ps` shows no Unreal Agent program                                           | none        |
| L2   | Written more than 2 seconds before a `ps` that showed none                   | none        |
| Lx   | Some Unreal Agent program's start cannot be read                             | cannot tell |
| L3   | Every Unreal Agent program started more than 60 seconds after the last write | none        |
| L4   | More sessions look open than programs that started by when their run began   | cannot tell |
| L5   | Otherwise                                                                    | may run     |

- **L3.** A program writes to a session only after it started, so a session last written before every running program started is held by none of them. The 60 seconds are the slack Agent Lookout gives a start time from `ps` (`SAME_START_WITHIN_MS`), as the Antigravity CLI adapter does.
- **L4.** Of the sessions not ended and not closed whose run began by the time `ps` was asked, ordered by when their run began, by their `settings` input, a session cannot be told when some session whose run began as late or later has more sessions begun by then than programs started by then. Each program holds one session at most, so one of them has none, and which cannot be told. It never makes a session finished.
- **The clock.** On Linux, `ps` works a start out from the time the system started, which moves when the clock is set, as Agent Lookout's `src/collector/processes/processStart.ts` says, so a clock set forward makes running programs look started after writes made before it. On macOS a start stays as it was taken, so a clock set back makes new writes look earlier than programs started before it. When either is seen, by a poll's time against a clock that is never set on Linux, or against the latest time seen on macOS, L3 closes no write made before it. That only ever keeps a session open.

`ps` is asked while a session is listed, at most every 10 seconds, and sooner, though not within 2 seconds of the last ask, when a file is written after `ps` showed no Unreal Agent program, or up to 2 seconds before. A clock set back counts as time enough.

### The process, and other programs with its names

`ps -A -o lstart=,comm=` is run in UTC, directly, never through a shell, from `/usr/bin` or `/bin`, with a 2 second timeout. It prints when each process started and the name it gives its program, and nothing else. A line whose program, after its last `/`, is one of these counts:

| Name                                 | Program                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `unreal-agent-tui`                   | The terminal app (`.goreleaser.yaml:18`)                        |
| `unreal-agent-runner`                | The runner (`.goreleaser.yaml:10`)                              |
| `unreal-agent`, `uat`                | Homebrew's links to the terminal app (`.goreleaser.yaml:69-70`) |
| `unreal-agent-tu`, `unreal-agent-ru` | The first two as Linux keeps them, cut to 15 characters         |

Only when each matching program started is kept, in memory. Every other line is dropped as it is read. A line that names one of them but whose start cannot be read makes Lx apply. Another program named `uat` or `unreal-agent` counts too: it can keep a session from showing as finished, and nothing more.

### Thirty quiet minutes

A busy session that has written nothing for 30 minutes shows as unknown, as does one written further ahead of the clock than a minute. The same 30 minutes keep the Mac awake for a working session (`KEEP_AWAKE_WORKING_MS`). A model call writes nothing until it answers, and each of its attempts may wait 30 minutes for a reply (`harness/llm/responsesapi/adapter.go:129`; `harness/llm/messagesapi/adapter.go:132`), five attempts by default (`harness/primitives/remote.go:26`). While commands run, a heartbeat is written every 10 minutes (TUI `run.go:262`; runner `run.go:163`; `loop.go:137-141`), unless a runner turned it off.

### A request that fails outright

A model call that fails after its retries writes nothing (`loop.go:231-237`), so the file ends on a turn with no reply and the session is busy. In the terminal app it shows as working, then unknown after 30 quiet minutes, and then finished once the app quits, which writes no hard stop after a failure (`runcontrol/stop.go:13-16`). A runner ends with an error (runner `run.go:107-130`), so the session is finished at the next `ps`. It never shows as failed.

### Why nothing needs you

Unreal Agent asks for no approval before a command runs, and its tools are `Bash`, `ViewImage` and `SkillUse` (`harness/tool/registry.go:18-20`), none of which asks anything. So no session is ever shown as needing you.

## Names and folder

A session takes its folder's name, else its ID. Unreal Agent gives a session no name: a session has an ID and a start time alone (`session.go:17-20`). The folder is the `Directory` of the newest shell command read, which is the folder the terminal app was started in, or a runner's `-workspace`, and never a folder the model names (`harness/tool/bash/bash.go:163-168`; TUI `run.go:190`, `:245`; runner `run.go:161`, `:211`, `:327-331`). A `cd` inside a command does not change it. Until a command runs there is no folder, and the name is the ID, which for a runner can be one its caller chose (runner `run.go:60`, `:658-666`).

## Quiet for, tokens, Jump, Stop and Answer

- **Quiet for** is the time since the file was last written, its modified time.
- **Tokens:** a reply's counts are on its line, after its text, and are not read.
- **Jump and Stop:** a session's file names no process or terminal.
- **Answer:** Unreal Agent never asks for an approval, so there is nothing to answer.

There is no last message either.

## On Windows

Unreal Agent is built for Linux and macOS alone (`.goreleaser.yaml:11`, `:19`). On Windows the adapter lists nothing, reads nothing and runs nothing, and the Sources view says so.

## Known gaps

- An Unreal Agent program that started before a session's run, and still runs, keeps that idle session from showing as finished, as long as the count of sessions and programs balances. That program can be a terminal app still in its first-run dialog, the program of a session written over a day ago or beyond the newest 200, a Docker runner on Linux, a runner writing to another `-session-directory`, another account's Unreal Agent, or another program named `uat` or `unreal-agent`.
- `ps -A` lists every account's processes, so another account's Unreal Agent counts as a program that could hold a session.
- A session longer than 64 MiB that seems to wait, and whose last 8 MiB do not reach its start, shows as unknown, not idle, until it is quit with Ctrl+C or no program could hold it. When its newest reply failed or is unclear, it stays unknown.
- A runner started with its heartbeat turned off shows as unknown after 30 quiet minutes while one long command runs.
- After a clock is set, a session that ended can stay unknown or idle until `ps` shows no Unreal Agent program, Agent Lookout restarts, or it leaves the list a day after its last write. On Linux a suspend, which moves the clock past the time that passed, does the same.
- On Linux, a clock set forward by more than a minute makes running programs look started later than they did. A session whose run began before then can show as unknown whenever it waits, until its program quits. When Agent Lookout starts after the clock was set, such a session not written since can show as finished.
- A file's time is the disk's. On a disk whose times fall more than 2 seconds behind this computer's clock, as a network home folder's can, a session written in a program's first seconds can show as finished until it is written again.
- Two programs that write one session cut each other's lines, and the session shows what the file holds at each read.
- A runner in Docker keeps its sessions in a volume that is not read. With the sessions folder mounted from a Mac, its program is not in this computer's `ps`, so its sessions show as finished while it works.
- A runner given `-session-directory` keeps its sessions where Agent Lookout does not look, unless `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR` names that folder.
- The Mac app may be started without your shell's `XDG_STATE_HOME`. When you set it, set `AGENT_LOOKOUT_UNREAL_AGENT_SESSION_DIR` there too.
- A runner session's ID, which its caller can choose, is its name until a command runs.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Unreal Agent installed to check:

1. That Go's `encoding/json/v2` writes these lines byte for byte as the shapes above, a time with its fraction's trailing zeros cut, and a provider's raw values in a state as they were given.
2. How long passes between a reply and its first tool call status, each one write with a sync to the disk (`localfile/store.go:413-433`). The 2 seconds assume much less.
3. What `ps -o comm=` prints on macOS for the terminal app started through Homebrew's `unreal-agent` and `uat` links, and on Linux for the two programs.
4. That macOS keeps a process's start time as it was when the clock is set.
5. How Node's monotonic clock behaves across a suspend on Linux.
6. Whether Docker Desktop's processes show in a Mac's `ps`.
7. Whether every view_image and skill_use command reaches a line that ends it. One that never does keeps the session busy, as it keeps the coordinator from idling.

## What breaks when Unreal Agent changes

| Change in Unreal Agent                              | What the dashboard shows                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| The order of a record's fields                      | Sessions show as unknown                                                           |
| A higher format version                             | Those sessions are not listed, and the Sources view says why                       |
| A new item kind, input kind, control mode or status | Those sessions show as unknown, and the Sources view says why                      |
| A new shell command version                         | Sessions take no folder, and are named by their ID                                 |
| A shorter or longer heartbeat, or none              | A session running one long command shows as unknown sooner or later than it should |
| A program renamed, or a new one                     | Its sessions show as finished while it runs                                        |
| A new rule for the sessions folder                  | Unreal Agent is not found, or found with no sessions                               |
| A lock or pid file for a session                    | Nothing changes until the adapter reads it                                         |

To check a new Unreal Agent version, read `harness/sessionstore/localfile/codec.go`, `store.go` and `state.go`, `harness/sessionstore/sessionstore.go`, `harness/inbox/inbox.go`, `harness/llm/model.go`, `harness/tool/tool.go`, `harness/operation/operation.go` and `shell.go`, `harness/coordinator/loop.go`, `cmd/internal/xdgpath/directory.go`, and the two programs' `run.go`, then `.goreleaser.yaml`. Then update `UNCHECKED_NOTE` in `src/collector/adapters/unreal-agent/index.ts` and the first paragraphs here.
