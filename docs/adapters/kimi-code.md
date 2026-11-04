# Kimi Code adapter notes

These notes record what Agent Lookout reads from Kimi Code, where each value comes from, and what breaks when Kimi Code changes. When the adapter stops working, start here.

Written on 2026-11-04 from Kimi Code's source at `@moonshot-ai/kimi-code@2.4.1`, released 2026-10-30 (commit `2c73f3f` of [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code)), the newest full release then. Kimi Code is under the MIT licence at that tag. Kimi Code was not installed or run to write them, and no real session was looked at, so nothing here has been checked on a computer running Kimi Code. The fixtures are written by hand from the source.

This is the TypeScript Kimi Code, whose `kimi` command writes `~/.kimi-code`. It is not the older Python Kimi CLI of [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli), Apache-2.0, which that repository calls legacy and no longer maintained, and which kept its files in `~/.kimi`. This adapter never reads `~/.kimi`. Kimi Code can bring sessions over from it, and those are in `~/.kimi-code` as [Which sessions are listed](#which-sessions-are-listed) says.

Each citation is a path at that tag, where `core/` is `packages/agent-core-v2/src/`.

The code is in `src/collector/adapters/kimi-code/`, and the status mapping is in `src/core/mapping/kimi-code/kimiCodeMapping.ts`.

## What the issue said, and what holds

| What issue #32 said                                           | What the source shows                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An index at `~/.kimi-code/session_index.jsonl`                | True, unless `KIMI_CODE_HOME` moves it. It has a line for each session made or forked and one for each deleted, and holds no status or time                                                            |
| An append-only event file for each session                    | True of `agents/main/wire.jsonl`, with another for each subagent. Kimi Code can rewrite one whole, as when it migrates or repairs it                                                                   |
| It records an approval or a question being asked and answered | True: `interaction.request` and `interaction.resolved`. A crash or a close writes no answer, so a line with none proves nothing alone, as [Needs you](#needs-you) says                                 |
| Nothing marks a terminal session as still running             | Not so from 2.3.0: `locks/sessions/<id>.lock` names the process using a session while it is busy, in every client. It holds for a session idle between turns, whose lock is let go. Nothing marks that |
| So running would rest on the process and on recent writes     | On the process. Recent writes are not used, since a quiet session and a closed one read the same                                                                                                       |
| This comes from its docs and source, and has not been checked | Still so. Both are public at the tag above                                                                                                                                                             |

## How it reads Kimi Code, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no Kimi Code program run, no network. It reads the files below, read-only, and asks whether the process a lock names runs with signal 0, which sends the process nothing. On a Mac it also asks `ps` when that process started.

Kimi Code has other ways in, and none of them can be used that way:

| Interface                                               | Why it is not used                                                                                                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kimi --session`, `kimi export` and the other commands  | They start Kimi Code, and they are made for a person                                                                                                                |
| The server of `kimi web`, with `GET /sessions`          | It says `busy` and what is pending, but it needs a token, it runs only when a person starts it, and it knows the live state only of sessions loaded in that process |
| Hooks in `config.toml`                                  | They would need a change to Kimi Code's settings                                                                                                                    |
| `sessions/.index-cache` and Kimi Code's own query store | They hold the same summaries, last prompts included, and are its own caches                                                                                         |
| The OSC 7501 status it sends a terminal                 | It goes to the terminal, and is on no disk                                                                                                                          |
| `wire.jsonl`, whole                                     | It holds every prompt, reply and tool call. Only lines about approvals and questions are parsed, from its end, while a process that runs holds the session's lock   |

## What it reads

| Path, in Kimi Code's folder         | How                                                                                                                      | How often                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| The folder itself                   | One `stat`, which follows a link                                                                                         | When there is no index, and then once a minute while it is missing                                                        |
| `session_index.jsonl`               | One `lstat`                                                                                                              | Every poll                                                                                                                |
| The same file                       | Opened read-only, at most its last 8 MiB read                                                                            | When its size, modified time or identity changes                                                                          |
| `locks/` and `locks/sessions/`      | One `lstat` of each, to see that each is a folder and not a link, then listed                                            | Every poll                                                                                                                |
| `locks/sessions/<id>.lock`          | One `lstat`                                                                                                              | Every poll, while it is there                                                                                             |
| The same file                       | Opened read-only, 4 KiB or less                                                                                          | When its size, modified time or identity changes, and again each poll after a read that failed                            |
| `sessions/<bucket>/<id>/state.json` | One `lstat`                                                                                                              | Every poll for a session shown, with a lock, new, or found written in the last day, and once a minute for every other one |
| The same file                       | Opened read-only when written in the last day, or when its session is shown or locked, and read whole when 1 MiB or less | When its size, modified time or identity changes, and once more when a lock comes back on one over a day old              |
| `sessions/`, `<bucket>/`, `<id>/`   | One `lstat` of each, to see that each is a folder and not a link                                                         | Before a `state.json` or an event file is opened                                                                          |
| `<id>/agents/main/wire.jsonl`       | One `lstat`                                                                                                              | Every poll, while a process that runs holds the session's lock                                                            |
| The same file                       | Opened read-only, at most its last 1 MiB read                                                                            | When its size, modified time or identity changes                                                                          |
| `<id>/agents/`, `<id>/agents/main/` | One `lstat` of each, to see that each is a folder and not a link                                                         | Before an event file is opened                                                                                            |

Kimi Code keeps every session it ever ran, so most `state.json` files are looked up once a minute, and one last written over a day ago is never opened unless its session is shown or has a lock.

A file is opened without following a link at its name and without waiting on a pipe, and read only if the open file is an ordinary file. Nothing else is opened: not `config.toml`, `tui.toml`, `mcp.json`, `credentials/`, `logs/`, `user-history/`, `server/`, a subagent's `wire.jsonl`, a session's `tasks/`, `cron/` or `plans/`, or anything in `~/.kimi`.

A look at a `state.json` or an event file that fails is no fact about the file, so what was last read of it stands, and the session stays as it was. Only a file that is missing, or is no ordinary file, counts as gone.

## The folder

The folder is worked out as Kimi Code works it out (`resolveKimiHome` in `core/app/bootstrap/bootstrap.ts`, and `getDataDir` in `apps/kimi-code/src/utils/paths.ts`), on every system. The first of these that is set is used, and an empty value counts as unset:

| Setting                        | Folder                              |
| ------------------------------ | ----------------------------------- |
| `AGENT_LOOKOUT_KIMI_CODE_HOME` | `<folder>`, for Agent Lookout alone |
| `KIMI_CODE_HOME`               | `<folder>`                          |
| None                           | `~/.kimi-code`                      |

On Windows that is `%USERPROFILE%\.kimi-code`. The VS Code extension calls the same `resolveKimiHome` (`apps/vscode/src/telemetry.ts`), and `kimi web` and `kimi acp` are the same program as the terminal's.

When there is no index and the folder is missing, Kimi Code is reported as not found, with no advice, and the folder is looked for again once a minute. When there is no index in a folder that is there, the source is watched and lists no sessions. When `AGENT_LOOKOUT_KIMI_CODE_HOME` names a folder with nothing in it, that is an answer, not a missing Kimi Code. The folder itself can be a link, as it may be the person's own. Nothing below it is opened through one.

## The index

`session_index.jsonl` is JSON Lines. Kimi Code appends through its log store:

- when it makes or forks a session, `{"sessionId":"session_<uuid>","sessionDir":"<absolute path>","workDir":"<absolute path>"}` (`appendSessionIndexEntry` in `core/workspace/sessionLifecycle/sessionLifecycleService.ts`);
- when it deletes one, `{"sessionId":"…","deleted":true}`.

It rewrites the file whole now and then, to drop lines for folders that have gone and lines that are not JSON (`compactSessionIndexIfStale` in `core/app/workspace/workspaceAlias.ts`), and leaves any other line it finds. Sessions it imports have ids of the form `ses_…`.

| Field        | Read for                                                  | Rules                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`  | The session's id, and the name of its folder and its lock | Letters, digits, `.`, `_` and `-`, up to 200, starting with a letter or digit. Anything else skips the line                                                                                       |
| `sessionDir` | Only the name of its bucket                               | It must end in `sessions/<bucket>/<id>`, by `/` or `\`, with this line's id. It is written when the session is made, so it is never followed: the path is worked out from the folder as it is now |
| `workDir`    | Its folder, when `state.json` gives none                  | An absolute path by the system's own rules, of 4096 characters or fewer, with no control character                                                                                                |
| `deleted`    | Removes an earlier line for the id                        | Only when it is `true`                                                                                                                                                                            |

A later line for an id replaces an earlier one. A session line with a bad `sessionId` or `sessionDir`, or a line that is not JSON, is skipped. A bad `workDir` only leaves the session with no folder from the index. A bucket is `wd_<slug>_<first 12 of a sha-256>` (`encodeWorkDirKey` in `core/_base/utils/workdir-slug.ts`), and is held to the same rule as an id.

## `state.json`

Kimi Code rewrites `state.json` whole, through a temporary file (`atomicWrite` in `core/persistence/backends/node-fs/fileStorageService.ts`), each time a session's title, last prompt, agents or last turn changes (`core/session/sessionMetadata/sessionMetadataService.ts`), so a read never catches one half written.

| Field                                 | Read for                                                                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                                 | The session's folder, by the same rules as `workDir`. Anything else falls back to the index                                                     |
| `createdAt`                           | When it began, in Unix milliseconds                                                                                                             |
| `updatedAt`                           | The status time of a session that is not working or waiting. Kimi Code moves it at each prompt and at the end of each turn, and not for a title |
| `lastTurnReason`                      | Only whether it is `failed`, which Kimi Code writes for a turn that ended `failed` or `blocked` (`sessionOutcomeMirrorService.ts`)              |
| `archived`                            | A session the person archived is not listed                                                                                                     |
| `custom`                              | Only whether it holds `child_session_kind`, `imported_from` or `imported_from_kimi_cli`. Nothing in it is kept                                  |
| `title`, `titleKind`, `isCustomTitle` | The name, as [Names](#names) says                                                                                                               |

Every other field is dropped with the parsed file, never copied, kept or logged. That covers `lastPrompt`, which holds the last prompt, cut to 4,000 characters, `agents`, `forkedFrom` and the rest of `custom`.

A value that is not a finite number, as in the older string times, is read as none. A time before 2020 or more than a minute ahead of the clock is treated as none when the session is made, and so is a status time more than a second before the session began.

## The lock

Kimi Code takes a lock so two processes do not write one session at once (`core/persistence/backends/node-fs/sessionLockService.ts`, first at 2.3.0). It writes a temporary file and links it to `locks/sessions/<id>.lock`, so a lock is never half written. Its fields are `version`, `token`, `pid`, `hostname`, `startedAt`, `clientIdentity` and, for some clients, `clientDisplayName`.

Only `pid` and `startedAt` are kept. Kimi Code reads a lock with no time as dead, and a lock with no good `pid` or no whole `startedAt` is treated here as naming nothing. `token`, `hostname` and the client's names are dropped with the parsed file. A `.lock.tmp-…` or `.lock.reclaim` file is not read.

When it holds one (`core/session/sessionActivity/sessionRunGateService.ts`, `core/wire/wireService.ts`):

- it takes the lock when a turn begins, and whenever it writes to the session's metadata or event file;
- it holds it while the session is busy, which means a turn, a background task or a compaction in any of its agents, and a wait for you is inside a turn;
- it lets it go 3 seconds after the session stops being busy, and when the process exits.

So a lock is a session in use, and no lock is a session idle or closed. A crash leaves a lock behind, which the next Kimi Code to want that session clears once it finds the process gone.

## The event file

`agents/main/wire.jsonl` is JSON Lines, opened by `{"type":"metadata","protocol_version":"1.5","created_at":…}`. Each record is `{"type":"<type>",<its fields>,"time":<Unix ms>}`, with `type` first and `time` last (`serialize` in `core/app/event/event2.ts`). Each line reaches the disk within moments, and is not buffered for a turn.

Two types matter here (`core/agent/interaction/interactionOps.ts`):

| Type                   | Fields read                                   | Left in the file                                                                 |
| ---------------------- | --------------------------------------------- | -------------------------------------------------------------------------------- |
| `interaction.request`  | `id`, `kind` (`approval`, `question`), `time` | `request`, which holds the tool's input or the question, `toolCallId`, `agentId` |
| `interaction.resolved` | `id`                                          | `response`, which holds your answer                                              |

`kind` can also be `user_tool`, a tool a client runs for itself, which waits for no person, as Kimi Code's own `resolvePendingInteraction` says. An id is `approval_<uuid>`, `question_<uuid>` or `<agent>:interaction-<n>`, and is held to 128 letters, digits, `:`, `.`, `_` and `-`. A line with a bad id, or a request with a time that is not a whole number, is left out.

The reader looks through the bytes of the file's last 1 MiB for a line break followed by `{"type":"interaction.`. A line of JSON has no line break in it, so those bytes cannot be inside a prompt or a reply. Every other line is never turned into text. Each line found is parsed, its three fields are taken, and it is dropped. A last line with no line break yet is left for the next read.

## Which sessions are listed

A session is listed when its `state.json` was written in the last 24 hours, and for as long as a process that runs holds its lock, or last held it. Not listed:

- a session the person archived;
- a child session, with `custom.child_session_kind` `child`, which a client makes from another for one piece of work (`createChild` in `sessionLifecycleService.ts`);
- a session with no readable `state.json`, as when the index names a folder that has gone, or one over 1 MiB, and the card says so for that;
- subagents, which are agents inside a session, and have no line in the index.

A session Kimi Code brought over from another program is listed like any other, as finished, for a day after it was imported, since that writes its `state.json`. A fork is listed.

## Status

The status comes from `mapKimiCodeStatus`. The rows are taken in this order:

| A process that runs holds its lock | Waits | Last turn failed | The process that last held it runs | Status      |
| ---------------------------------- | ----- | ---------------- | ---------------------------------- | ----------- |
| Yes                                | Yes   | Any              | Any                                | `needs-you` |
| Yes                                | No    | Any              | Any                                | `working`   |
| No                                 | Any   | Yes              | Any                                | `failed`    |
| No                                 | Any   | No               | Yes                                | `idle`      |
| No                                 | Any   | No               | No                                 | `finished`  |

A session is never `unknown`. It shows as `working` while any of its agents is busy, so a background task alone keeps it working.

| Status      | Status time                                         |
| ----------- | --------------------------------------------------- |
| `working`   | The lock's `startedAt`                              |
| `needs-you` | When the wait began                                 |
| Any other   | `updatedAt`, else the modified time of `state.json` |

### Idle and finished

Kimi Code writes nothing that says a session is open but idle. So Agent Lookout keeps the process it last saw hold a session's lock, in memory, for as long as that process runs, and the session is `idle` until it ends. That is written nowhere, and a restart of Agent Lookout forgets it. It names a process, not a client, so a session left in a server or a window that serves many stays idle for as long as that runs.

A session whose lock Agent Lookout never saw held is `finished`. A session left idle in a Kimi Code opened before Agent Lookout saw it busy is one of these, until its next turn, as [Known gaps](#known-gaps) says.

### Needs you

A session is `needs-you` while the main agent's event file holds an `interaction.request` of kind `approval` or `question` with no `interaction.resolved` of the same id, and both of these hold, as in `kimiCodeWaitOf`:

- A process that runs holds the lock. A wait is kept in that process's memory (`core/human/interaction/facade.ts`), and a crash writes nothing. An agent that closes with a wait open writes no answer either, since `detachInteractionAgent` takes its dispatcher away first.
- It was asked at or after the lock's `startedAt`. Kimi Code holds the lock through a turn, so an earlier process's line, left in the file, does not count once another process takes the lock.

The reason is `permission` for an approval and `question` for a question, and with both open it is `permission`, as `resolvePendingInteraction` in `core/session/sessionActivity/sessionActivityService.ts` puts it first. There is never a `waitingText`.

A plan to approve, and any tool Kimi Code asks about, is an approval. A background question stays open while the session works on, and shows as `needs-you` for that time, which is true: it waits for you.

A wait keeps the time of its oldest line while any line it hung on stands, so answering the older of two does not read as a new wait (`continuedKimiCodeWait`). To tell, the id, the kind and the time of each open interaction stay in memory, and nothing else of them.

### The process

A lock counts while all of these hold, the first two being Kimi Code's own rule in `alive`:

- Signal 0 finds its process.
- Its `startedAt` is not before the computer started, by `os.uptime()`. A power cut leaves a lock behind, and after a restart low pids go to other programs.
- On a Mac, `ps -o pid=,lstart= -p <pids>` does not say that process started more than a minute after `startedAt`. If it did, it was given the pid of a Kimi Code that ended. That answer stands while the pid runs, and a later `ps` that cannot answer does not bring the session back. `ps` that says nothing leaves the session as signal 0 says. It is asked every 30 seconds while a session's process runs, and sooner when another appears, in one run for them all. This is the same check as for Cline and Mistral Vibe (`createRecordProcessCheck`). It reads a start time, and never a process's arguments.

Kimi Code also compares `hostname`, which this adapter does not read, as [Known gaps](#known-gaps) says. Only on a Mac is `ps` asked, as a comparison acts only when it is sure: Linux's `ps` works a start out again from the clock each time, a lock holds no start token to read from `/proc`, and Windows has no `ps`.

## Names

`applyPromptMetadata` sets a session's title from its first prompt, cut to 200 characters, as `replaceable`. So by default a title is what was typed, word for word, and it is never kept. Then:

| What says so                                                                    | Who set it                                                                                                             | Kept  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----- |
| `titleKind` `replaceable`, or none at all, without `isCustomTitle` `true`       | Kimi Code, from the first prompt                                                                                       | Never |
| `titleKind` `generated`                                                         | A model, through Kimi Code's service, after the first turn, when the provider is Kimi's own (`sessionTitleService.ts`) | Yes   |
| `titleKind` `custom`, or `isCustomTitle` `true`                                 | A person with `/title`, or a client that sent one                                                                      | Yes   |
| Either of those, with `custom.imported_from` or `custom.imported_from_kimi_cli` | A session brought over keeps its title marked `generated`, and it can be that program's first prompt                   | Never |

A `replaceable` beside `isCustomTitle` `true` is from a file an older Kimi Code wrote, and Kimi Code reads that as custom, so the title is kept. A name not kept falls to the folder's name, then the id. A child session's title is `Child: <parent's title>`, marked `custom`, which is one more reason child sessions are not listed. A fork is `Fork: <title>` with the kind of its source, so a fork of a default title is not kept.

A name is cleaned and cut as every other agent's is. [What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) says where it goes.

## Quiet for

The last write is the modified time of `agents/main/wire.jsonl`, looked up while a process that runs holds the lock. Every record the main agent writes moves it. A subagent writes to its own file, so a session whose subagent works can look quiet. Hence Partly.

## Token counts

Kimi Code writes counts into the event file, in `token_counting.turn_recorded` and others, and those lines are not parsed. So No.

## Jump, Stop and Answer

No Jump: a lock names a process, which can be `kimi web` serving many sessions, or an editor, and no terminal or window. The tmux and tab finders are not asked. No Stop: the process that holds a session's lock can hold others too, so none can be confirmed and stopped alone. No Answer: Agent Lookout does not talk to Kimi Code.

## On Windows

Everything is read as elsewhere, from `%USERPROFILE%\.kimi-code`, and signal 0 works there. `ps` is never asked. A lock is made there with a hard link too.

## Known gaps

- A session left idle in a Kimi Code opened before Agent Lookout saw it busy shows as finished until its next turn. So does a session resumed with `kimi --session` until Kimi Code next writes to it, and every idle session after Agent Lookout restarts. After a restart the Events log also records each session last seen idle as changing to finished, though its Kimi Code may still be open.
- A session left with `/new` or `/sessions` in one process stays idle until that process ends, since a process that moves on writes nothing.
- A session in `kimi web`, the desktop app or an editor stays idle for as long as that process runs, though Kimi Code unloads one in the first two from memory after 30 minutes idle.
- A subagent's wait is in the subagent's own file, which is not read, so a session whose subagent waits for you shows as working.
- A crash mid-turn shows as finished: Kimi Code clears `lastTurnReason` when a turn starts (`sessionOutcomeMirrorService.ts`), and writes nothing when it dies. A session that crashed before its first model request can show as failed once Kimi Code reopens it, if the turn before failed, as Kimi Code restores that outcome from the event file.
- Kimi Code before 2.3.0 keeps no lock, and neither does one with `KIMI_CODE_SESSION_LOCK=0`, or on a file system where a hard link fails, where it carries on without one. Its sessions never show as working, idle or needing you, only as finished or failed.
- On Linux and Windows, after a crash, another program can take the lock's pid. The session then shows as working until that program ends, unless the computer has restarted since.
- On a Mac, a session shows as finished while it runs if the clock was set back by more than a minute between its process's start and the lock's `startedAt`.
- Kimi Code treats a lock with another `hostname` as held. This adapter does not read `hostname`, so with a folder shared between computers, another computer's lock is checked as a process here.
- A wait further back than the event file's last 1 MiB, or a line longer than that, as for an approval of a very large write, shows as working.
- Of an index over 8 MiB, only the newest lines are read, some 25,000 sessions, and older sessions are not listed.
- A `state.json` over 1 MiB is not read, so that session is not listed, and the card says so.
- A `state.json` that could not be opened is not tried again until it is next written or Agent Lookout restarts. Its session is not listed until then, one that was listed leaves the list as one that ended, and the process that last held it is forgotten, so an idle session comes back as finished.
- A failed look at a `state.json` not yet read leaves its session out until the next look that works, which can be a minute away, and a failed look at an event file not yet read shows the session as working until a look works.
- A title you set on a session brought over from another program is not kept, and neither is one from before `titleKind`, marked only with `customTitle`, until Kimi Code rewrites the file.
- A session brought over from Claude Code or Codex is listed as a finished Kimi Code session for a day after the import. One Agent Lookout also lists under that tool shows twice.
- A session last written over a day ago that is opened again takes up to a minute to appear, unless its lock shows it first.
- A session's app is not shown, though a lock names its client: the adapter keeps less.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Kimi Code installed to check:

1. That `session_index.jsonl`, `state.json` and `wire.jsonl` appear as above, and that a line of `wire.jsonl` has `type` first in practice.
2. That a lock appears within a poll of a turn starting and goes 3 seconds after it ends, in the terminal, in `kimi web`, in `kimi acp` and in the VS Code extension.
3. That a tool's approval and a question each write one `interaction.request` and one `interaction.resolved` to the main agent's file, and that a subagent's go to its own.
4. That a killed process leaves its lock behind, with the pid that held it.
5. That `titleKind` moves from `replaceable` to `generated` after a first turn, and stays `replaceable` with another provider.
6. How long a real `state.json` grows, and how far back a wait can sit from the end of a real `wire.jsonl`.
7. That a lock is made on Windows, and on a network folder, as above.

## What breaks when Kimi Code changes

| If Kimi Code changes this                                                   | What happens                                                                                                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Moves or renames `session_index.jsonl`                                      | Kimi Code shows as having no sessions                                                                                   |
| Stops writing `sessionDir`, or lays out `sessions/` differently             | Its lines are skipped, and sessions are not listed                                                                      |
| Renames `locks/sessions`, or a lock's `pid` or `startedAt`                  | No session shows as working, idle or needing you. Every one shows as finished or failed                                 |
| Holds a lock for less than a turn                                           | Sessions show as idle or finished while they work                                                                       |
| Holds a lock for as long as a session is open                               | Sessions show as working while idle. A row of the mapping would need to change                                          |
| Renames `interaction.request`, `interaction.resolved`, `kind` or `time`     | Waits show as working                                                                                                   |
| Puts another field before `type` in a line                                  | Waits show as working: the reader looks for `{"type":"interaction.` at a line's start                                   |
| Writes an answer with another `id`                                          | A session stays `needs-you` until its lock goes                                                                         |
| Renames `titleKind`, or a value of it                                       | Names fall to the folder's. A new kind that means the first prompt stays out, as only `custom` and `generated` are kept |
| Adds a new way to make a title from a prompt marked `generated` or `custom` | Such a title is shown as the name. Read `sessionTitleService.ts` and `applyPromptMetadata` when moving up               |
| Renames `lastTurnReason` or `failed`                                        | Failed sessions show as idle or finished                                                                                |
| Renames `custom.child_session_kind` or `archived`                           | Child or archived sessions are listed                                                                                   |
