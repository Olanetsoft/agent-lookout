# DeepSeek Harness adapter notes

These notes record what Agent Lookout reads from DeepSeek Harness, where each value comes from, and what breaks when DeepSeek Harness changes. When the adapter stops working, start here.

Written on 2026-11-17 from DeepSeek Harness's source at `dsh-v0.2.2-rc.3`, published 2026-11-13 (commit `38a6a5c965aa` of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)), the newest tag then. Every release so far is a prerelease. DeepSeek Harness, `dsh`, is DeepSeek's coding agent, run as a local web page (`npx @deepseek-ai/dsh web`), a desktop app or headless, under the MIT licence. Its session format has been 4 since `dsh-v0.2.0-rc.2` (`docs/session-format-status.md:40-49`). It was not installed or run to write these notes, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from DeepSeek Harness's source at dsh-v0.2.2-rc.3 and has not yet been checked on a computer running DeepSeek Harness.** The Sources view says so too.

Each citation is `path:line` at `dsh-v0.2.2-rc.3`, from the top of DeepSeek Harness's repository. `persistence/` stands for `packages/session/session-persistence-jsonl/src/`, `session/` for `packages/core/session/src/` and `base.yml` for `packages/bundle/base/cordis.patch.yml`.

The code is in `src/collector/adapters/deepseek-harness/`. `index.ts` builds the adapter, `home.ts` finds the sessions folder, `logFiles.ts` finds the logs, `logReader.ts` reads them, `zstdFrames.ts` finds and undoes Zstandard frames, `lines.ts` reads each line as bytes, `processes.ts` reads `ps`, and `toSession.ts` makes the session. The status is given by `src/core/mapping/deepseek-harness/deepseekHarnessMapping.ts`.

## What the issue said, and what holds

Issue #78 was written from the same source. These parts needed more:

- The home is `%USERPROFILE%\.dsh` on Windows too, not only on macOS and Linux (`packages/util/home-paths/src/index.ts:70-72`).
- A project folder's name is not the folder with `/` made `-`: separators and `:` become `-`, runs of them collapse, the start is stripped, other characters are escaped as `~XXXX`, and the name is cut to 251 characters (`persistence/format.ts:225-245`). It cannot be turned back into a path, so the folder comes from the log's first line. A session with no folder is in `_no-cwd` (`:254-257`).
- A log is `session.v4.jsonl.zstd`, or `session.v4.jsonl` when DeepSeek Harness is set not to compress, as its SDK bundle is (`packages/bundle/sdk-minimal/cordis.patch.yml:172-176`).
- The first line also holds `type`, `version`, `isSeeded`, `delegationDepth` and `agentPreset`.
- `turn/end` can also be `interrupted`, written when a session is reopened after a crash, and `forked`, in a fork's copy (`session/types.ts:206-235`). `completed` means the turn is done and the session idle, not that it ended.
- A session whose newest log is newer than 4 is left out even when a log of format 4 is beside it, as DeepSeek Harness refuses it (`docs/subsystems/persistence.md:193`).
- An approval or a question counts only in the turn under way. One left in an earlier turn stays in the log for ever.
- A plan review, `exit_plan_mode`, waits for the person too (`packages/plan/plan-mode/src/index.ts:64`, `:281-331`).
- A session's first title is the first five words of its first prompt (`base.yml:60-65`), so only a title its model wrote or one marked as yours is decoded.
- Node.js reads Zstandard from 22.15, still marked experimental. On 22.12 to 22.14 compressed logs are not read, and the Sources view says so.

And two things the design missed, found in the source while building:

- A session reopened for writing gets a `session/end-seed` line with no `inherited`, after any lines that close a turn a crash left open (`packages/core/agent-loop/src/index.ts:796-812`, `session/index.ts:728-731`). So a reopened session is idle from then, not failed or finished from before.
- A frame Node.js's stream makes, as a migration from format 3 writes all of a session's lines (`persistence/generation.ts:747-765`), can be followed by one that holds nothing. Such a frame is passed over.

## How it reads DeepSeek Harness, and why

It needs nothing installed and changes nothing. It reads each session's event log, read-only, and asks `ps` when the programs that could write one started. It runs no DeepSeek Harness program and opens no settings file.

- **Its files alone.** DeepSeek Harness's command has no way to list sessions (`apps/cli/src/args.ts:160-210`), and its web page and desktop app keep them in the same logs.
- **As bytes.** A log holds the whole conversation: your prompts, the replies, every tool's arguments and output. So each line is compared, as bytes, with what the few kinds a status needs begin with, and only IDs, numbers, kinds and a title of the session's own become text: see [Event lines](#event-lines).
- **One log at a time, one frame at a time.** A compressed frame is undone alone, with at most 8 MiB out of it.

## Where it looks

The first of these that applies is used:

| Setting                               | DeepSeek Harness's sessions                                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME` | `sessions` in that folder, for Agent Lookout alone                                                               |
| `DSH_HOME`                            | `sessions` in that folder, when it is absolute once `~` is read (`packages/util/home-paths/src/index.ts:87-110`) |
| None                                  | `~/.dsh/sessions`, which on Windows is `%USERPROFILE%\.dsh\sessions`                                             |

The root is `dshHomePath('sessions')` (`base.yml:138-141`).

- DeepSeek Harness takes `DSH_HOME` as it is, with spaces alone meaning none. `~` alone is the home folder, and `~/` or `~\` at its start stands for it. A relative one is read from the folder DeepSeek Harness was started in (`:109`). That folder is not known here, so a relative `DSH_HOME` is passed over, and the Sources view says so.
- `DSH_HOME` comes only from the environment DeepSeek Harness starts in: its `.env` files cannot set it (`packages/boot/app-boot/src/index.ts:158`, `:191-193`). The desktop app keeps its own `DSH_HOME`, set when it starts, and one set only in your shell's files does not reach it (`apps/desktop/README.md:184`).
- Not followed: a root set in DeepSeek Harness's settings, a profile's or a `--patch` file's `cordis.patch.yml`, since those files are never read; and `./.sessions`, which older builds kept in each project.

When the sessions folder is not there, DeepSeek Harness is reported as not found, with no advice, and looked for again once a minute, or on every poll when `AGENT_LOOKOUT_DEEPSEEK_HARNESS_HOME` is set. When that setting names a folder with no `sessions`, that is an answer, not a missing DeepSeek Harness. A sessions path that is not a folder, or that cannot be listed, is an error.

## Finding the logs

A session is `<sessions>/<project folder>/<session folder>/<log>` (`persistence/format.ts:254-269`). Every folder in the sessions folder is a project's, and every folder in one of those a session's (`persistence/index.ts:1685-1692`). The session folder's name is the session's ID, escaped (`persistence/format.ts:199-214`). A log's name is `session.jsonl` or `session.v<N>.jsonl`, with `.zstd` when it is compressed (`packages/session/session-format/src/filename.ts:5`; `persistence/format.ts:42-77`).

| Path                       | How                                                                                            | How often                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/`                | Looked up, following a link there, then listed                                                 | The look every poll, the listing when its modified time moves and once a minute                                                                                                                                                                    |
| `sessions/<project>/`      | One `lstat`, which follows no link, then listed                                                | The `lstat` every poll, the listing when its modified time moves and once a minute                                                                                                                                                                 |
| `sessions/<project>/<id>/` | One `lstat`, which follows no link, then listed, for the names alone                           | The `lstat` every poll while its log is looked up, before the log, and every poll while it held no log when last listed; the listing when it first appears and once a minute, and every poll while it holds no log and was changed in the last day |
| `session.v4.jsonl[.zstd]`  | One `lstat`. When it changed, opened read-only without following a link, as the next part says | Every poll, unless it was found older than a day or past the newest 2,000, when it waits for the next minute's sweep                                                                                                                               |

- Of a session folder's names, the highest N is taken, as DeepSeek Harness takes it (`persistence/index.ts:1536-1569`). Only when it is 4 is the log read. A higher N leaves the session out, or shows it as unknown when its log of format 4 was already being read, and that log is not read again. Only lower ones leave it out too. Names of both kinds, with and without `.zstd`, leave it out, as DeepSeek Harness refuses such a folder (`:1561`).
- A `.jsonl` or `.jsonl.zstd` file directly in a project folder is DeepSeek Harness's older flat layout, which it refuses (`:1685-1692`), and is passed over.
- No link a lookup finds below the sessions folder is followed, and anything that is not a folder or a file is passed over. A session folder is looked up again on every poll just before its log is, and a log is read only when the file opened is the one its own lookup found, so a link put at a session folder's name since it was listed is not followed either, unless it is put there between those two lookups. A project folder is looked up once a poll, before its sessions, so a link put at its name after that, while its sessions are listed and looked up, is followed too. Either is followed for that poll alone.
- Never opened, and never looked up: `session.lock`, which DeepSeek Harness holds a lock on while a program owns the session (`persistence/lease.ts:19`, `:91-106`), the temporary files `<log>.<12 hex>.tmp` and `session.migration.<16 hex>.jsonl[.zstd].tmp` (`persistence/index.ts:1361-1371`; `persistence/generation.ts:728`, its suffix from `:652`), every other generation, and any other name.
- Without Zstandard, a compressed log is looked up only to be counted, and never opened.

Of the logs found, at most 400 a poll have their first line read, newest first, and the rest on the next poll. The newest 200 sessions that are not a subagent's are shown. The newest 200 logs of the subagents of the sessions shown, through their parents up to 16 deep, are read past their first line. Every other subagent's log is read no further than its first line.

## The log

DeepSeek Harness makes a log whole, with its first line, in a temporary file it then links in (`persistence/index.ts:1298-1305`; on Windows it moves it, `:1339-1341`). After that it adds a batch of lines at a time, in one write (`:1413-1440`). It cuts the log back when an append fails (`:1443-1451`) and when it repairs a torn end before its next write (`:1454-1462`). Nothing deletes a log.

- **First line.** Of a log not read before, at most 64 KiB is read for its first line, 4 KiB first. A first line longer than that leaves the session out. One not yet whole, in a file of 64 KiB or less, is looked for again on the next poll. This is read once for each file, by its identity, and again only when the log is read from its start, as below.
- **Reading on.** For a session shown and its subagents', the log is then read from the end of its first line, and after that only what was added. A compressed log longer than 16 MiB, or an uncompressed one longer than 64 MiB, is not read past its first line: it is shown with an unknown status, its folder's name and a note, and not read again until it is another file or grows shorter. That bound is on the log, not on one poll, so what is shown never depends on when it was read.
- **From its start again.** A log is read from its start, its first line too, when it is another file, grew shorter than was read, or did not go on as it was written: the byte before what was added is not a newline, what was added does not begin a frame, or a line's number is not the one after the last, which DeepSeek Harness keeps without a gap from 0 (`session/index.ts:790`).
- **Stuck.** When that happens again on the read from its start, or a frame is not one DeepSeek Harness writes, cannot be undone, or holds text that does not end a line, the log is stuck: its session is unknown until the log is another file or grows shorter, and it is not opened meanwhile.
- **Torn ends.** A last line with no newline, or a last frame cut short, is left, and read once it is whole. DeepSeek Harness's repair cuts the log back to where it began and writes what it held again (`persistence/index.ts:1005-1067`), so the next read goes on from there.
- **What is kept.** The log's identity, size and time, where its first line ends and how far it was read, the next line's number, the first line's fields, the turn's state and a title of at most 1 KiB. No byte of the log is kept between polls. Its times are kept as written, and judged against the clock on every poll, so a time more than a minute ahead of the clock when it was read is taken once the clock comes within a minute of it.

An uncompressed log is read in 1 MiB pieces. Of each line its first 512 bytes are kept while it is read, and up to 4 KiB of a title line of a session shown.

## Zstandard

A compressed log is a run of independent Zstandard frames: its first line in one, then one for each batch (`persistence/index.ts:1374-1394`). Each is made by Node's `zstdCompress`, with a checksum and no dictionary (`persistence/zstd.ts:15-20`, `:111-113`).

Where each frame ends is found from its headers alone, as DeepSeek Harness finds it (`persistence/zstd.ts:48-104`):

1. Four bytes of Zstandard's magic number.
2. Its header's first byte, which must say there is a checksum, no dictionary and nothing reserved; then a window byte unless the frame is one segment, and the size of what comes out of it in 0, 1, 2, 4 or 8 bytes.
3. Blocks, each with a 3-byte header, up to the last. A block of the reserved type, or over 128 KiB, is not Zstandard's.
4. The 4-byte checksum.

Running out of bytes anywhere is a frame still being written. Anything else, a skippable frame among it, is not DeepSeek Harness's, and the log is stuck.

Each whole frame is undone alone with `node:zlib`'s `zstdDecompress`, with at most 8 MiB out of it and a window of at most 8 MiB. Node.js stops a frame once more than 8 MiB has come out of it, a piece of up to 16 KiB past that. A frame whose header says more than 8 MiB is passed over without being undone. Either way the frame's lines are not read, the session's turn is not known until the next begins or ends, and the next line's number is taken as it is. A frame of a migration from format 3 says nothing of its size (`persistence/generation.ts:753-758`), so it is undone, and stopped if it is too large. What comes out of a frame is whole lines, or nothing.

Node.js has `zstdDecompress` from 22.15, still marked experimental. `node:zlib` is imported whole, and whether it has Zstandard is asked once, so a Node.js without it still runs Agent Lookout. Agent Lookout's Mac app runs Electron 44's Node.js 24, which has it. No other decoder is added: it would be a new dependency.

On a Node.js without Zstandard, the Sources view says so. When every session log written in the last day is compressed, no session is listed and the source is not working, with advice to update Node.js below 22.15. When some are not, those are listed, and the rest counted.

## The first line

The first line is the session's header, written with its keys in this order: `type`, `version`, `id`, `createdAt`, `cwd`, `parentSession`, `isSeeded`, `origin`, `delegationDepth`, `agentPreset`, the optional ones left out when absent (`packages/session/session-format-v1-to-v2/src/codec.ts:155-176`, its version made 4 in `packages/session/session-format-v3-to-v4/src/codec.ts:42-45`). In a compressed log it is a frame of its own, exactly one line (`persistence/index.ts:78-82`).

Only when its first bytes are `{"type":"session","version":4,"id":"` is it parsed as JSON. It must have only those keys, as DeepSeek Harness checks (`persistence/format.ts:96-98`, `:159-187`), with `version` 4. Kept:

| Field           | What is kept                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `id`            | A string of at most 1,024 characters                                                              |
| `createdAt`     | When the session was made, in milliseconds, or none when that cannot be right; it is still listed |
| `cwd`           | The folder it began in, when absolute, at most 4,096 characters, with no control character        |
| `parentSession` | The ID of the session whose subagent it is, at most 1,024 characters                              |
| `origin`        | Whether it is `subagent`                                                                          |

`isSeeded`, `delegationDepth` and `agentPreset` are checked and dropped with the parsed line. A first line that fails leaves the session out.

## Event lines

Every other line is one event, `JSON.stringify` of an object built as `{ type, seq, time, data, ...surface }` (`session/index.ts:540-542`; `persistence/format.ts:313-324`). Plugin records add `ignorable` after `data` (`session/index.ts:929-942`). A chat imported from chat.deepseek.com is written by the import itself, not by a session, as `{ type, data, ...surface, seq, time }`, its number and time last (`packages/experimental/deepseek-chat-import/src/conversation.ts:180-183`, `importer.ts:564-568`). Both orders are read. `JSON.stringify` writes every `"` inside a string as `\"`, so bytes such as `","seq":` or `,"data":{"turn":` can only be the line's own structure.

Of each line only its first 512 bytes are looked at, and up to 4 KiB of a `session/title` line of a session shown, as [Titles](#titles) says. It must begin `{"type":"<kind>","seq":<number>,"time":<number>,"data":`, or `{"type":"<kind>","data":` in the chat import's order, the kind's bytes printable and found within 128 bytes, each number of at most 16 digits. In the chat import's order the number and time are taken only from a line that ends `,"seq":<number>,"time":<number>}` within its first 512 bytes; a longer one keeps its kind, with no time, and its number is taken to be the one after the last. A line that begins neither way is one whose turn is not known. Each kind is compared as bytes:

| Kind               | The bytes after `"data":`, as each writer builds them                                                                                                     | What is taken                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `turn/start`       | `{"turn":<n>` (`packages/core/agent-loop/src/agent.ts:342`)                                                                                               | Its time                                                                |
| `turn/end`         | `{"turn":<n>,"reason":{"kind":"<kind>"`, and for `aborted` then `,"reason":{"kind":"<kind>"` (`agent.ts:93-108`, `:405-428`)                              | The kind, and for `aborted` its own reason's kind                       |
| `approval/asked`   | `{"id":"<uuid>"` (`packages/interaction/user-approval/src/index.ts:251-256`)                                                                              | The ID and the time                                                     |
| `approval/decided` | `{"id":"<uuid>","outcome":"` (`:259`)                                                                                                                     | The ID                                                                  |
| `tool/call`        | `{"turn":<n>,"step":<n>,"callId":"<id>","name":"` (`packages/core/tools/src/batch.ts:247-249`)                                                            | The call's ID, when the name is `ask_user_question` or `exit_plan_mode` |
| `tool/result`      | `{"turn":<n>,"step":<n>,"message":{"role":"tool","source":{"kind":"tool","callId":"<id>"` (`batch.ts:256-259`; `packages/llm/llm/src/message.ts:299-307`) | The call's ID                                                           |
| `session/end-seed` | `{"inherited":true}` for a fork's, anything else for a reopened session's (`session/fork.ts:21-29`; `session/index.ts:728-731`)                           | Which, and the time                                                     |
| `session/title`    | `{"title":"`: see below                                                                                                                                   | A title of its own, or none                                             |

A call's ID is 1 to 128 printable bytes other than `"` and `\`. A tool's name is compared up to `","arguments":`, so a name inside another call's arguments does not count. A wanted kind in another layout makes the turn unsure until the next turn begins or ends. A tool result in another layout does too while a question waits: a resume's or a failed step's results are written in another order (`session/repair.ts:173-193`), and the turn ends in the same batch.

The kind of a turn's end, a reason's kind, an approval's ID and a call's ID are the only parts of a line turned into text, with `latin1`, once their bytes pass a check of what they can hold. Your prompts, the replies, a tool's name, arguments and output, an approval's reason (`packages/sandbox/sandbox/src/escalation.ts:233-241`), a turn's error and a hook's reason are never turned into text.

### Titles

`session/title` holds `{"title":…,"messageSeqs":[…],"source":{"kind":…}}` (`packages/session/session-title/src/index.ts:422-426`, `:627-635`, `:810-814`). Its kind is `fallback`, the first five words of your first prompt (`base.yml:60-65`), `provider`, a title its model wrote, or `user`, a rename. The title comes before its kind, so on a line of at most 4 KiB the title is passed over to the first `","messageSeqs":[`, which can only be where it ends, then the numbers to `]`, and then `,"source":{"kind":"` and the kind are compared as bytes. Only for `provider` or `user`, and a title of at most 1 KiB as written, is the title decoded, with JSON's own rules. Any other kind gives no name, and its bytes are never decoded. The newest title line wins. A subagent's titles are never decoded.

A `user` title is not always one you typed. A scheduled task's session is renamed with the task's title (`packages/schedule/schedule/src/runtime.ts:449`, `:493-499`), which its model writes from what you asked (`packages/schedule/tool-schedule/src/index.ts:209-210`). A chat imported from chat.deepseek.com keeps the title it had there, marked `user` (`packages/experimental/deepseek-chat-import/src/conversation.ts:160-161`). The ACP and SDK apps write no model title (`packages/bundle/acp-app/cordis.patch.yml:8-9`; `packages/bundle/sdk-app/cordis.patch.yml:8-9`). A fork keeps its source's titles.

## Which sessions are listed

- A log of format 4 written in the last day, of a session that is not a subagent's.
- A subagent's session, `origin` `subagent` (`packages/subagent/subagent/src/child-agent.ts:136-154`), is not listed: product views hide it too (`docs/subsystems/persistence.md:197`). Its turns and approvals count for the session it is of.
- A fork you make is a session of its own (`session/index.ts:1490-1499`).
- Two folders of one session's name, which DeepSeek Harness refuses, are shown once, the newer.

A session's ID is `deepseek-harness:<session folder>` when the folder is `session-<uuid>` or `<agent>-session-<uuid>` (`packages/core/agent-loop/src/index.ts:342`), and `deepseek-harness:h<16 hex>` of a SHA-256 of the folder's name otherwise.

## Status

### The turns

Each log's lines are folded into where its turns stand: no turn yet, a turn under way and what it waits on, ended and how, or not known.

- `turn/start` opens a turn, waiting on nothing.
- `turn/end` ends it. One with no turn under way is passed over.
- `session/end-seed` starts again with no turn. A fork's copy ends with one that has `inherited`, and the lines DeepSeek Harness adds after it close the source's turn, not the fork's (`session/fork.ts:21-29`), so the fork is idle since it was made. A reopened session gets one with no `inherited` (`packages/core/agent-loop/src/index.ts:803-812`), and is idle since then.
- An approval asked waits until it is answered. A call of `ask_user_question` (`packages/interaction/tool-ask-user/src/index.ts:34-41`) or of `exit_plan_mode`, a plan to review (`packages/plan/plan-mode/src/index.ts:316-331`), waits until its result. Each counts only in a turn under way: an ask left in an earlier turn stays in the log, unanswered (`packages/interaction/user-approval/src/index.ts:244-250`).
- A wait begins when the turn goes from waiting on nothing to waiting on something. More than 64 at once make the turn not known, and no more are kept.

### The status

The first row that holds:

| #   | When                                                                                                                                                                                                                                                | Status                                                                | Since                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------ |
| 1   | Its log is too long, stuck, of a newer format since it was read, or its turn is not known                                                                                                                                                           | unknown                                                               |                                |
| 2   | Its last turn ended on `error`                                                                                                                                                                                                                      | failed                                                                | the end                        |
| 3   | Its last turn ended `aborted`, its own reason `disposed`: DeepSeek Harness closed it mid-turn                                                                                                                                                       | finished                                                              | the end                        |
| 4   | No program that could write it runs                                                                                                                                                                                                                 | finished                                                              | its last write                 |
| 5   | A turn of its own waits, and the desktop app backs it or it wrote within 30 minutes, or a subagent's waits, and the desktop app backs that subagent's last write or its log was written within 30 minutes and a program that could write it may run | needs you: for permission while an approval waits, else for an answer | when the earliest wait began   |
| 6   | Its own wait, with neither                                                                                                                                                                                                                          | unknown                                                               |                                |
| 7   | Its own turn is under way, and it wrote within 30 minutes                                                                                                                                                                                           | working                                                               | the turn's start               |
| 8   | Its own turn is under way, quiet longer                                                                                                                                                                                                             | unknown                                                               |                                |
| 9   | Its last turn ended in a way this does not know                                                                                                                                                                                                     | unknown                                                               |                                |
| 10  | A subagent's turn is under way, its log written within 30 minutes, and a program that could write it may run                                                                                                                                        | working                                                               | the earliest such turn's start |
| 11  | A subagent's wait with neither, unless no program that could write that subagent's log runs                                                                                                                                                         | unknown                                                               |                                |
| 12  | Its last turn ended `completed`, `blocked`, `max-tokens`, `interrupted`, `forked` or `aborted` otherwise                                                                                                                                            | idle                                                                  | the end                        |
| 13  | No turn yet                                                                                                                                                                                                                                         | idle                                                                  | when it began, or was reopened |

"Wrote" is its log's or a subagent's, the newer; a subagent's turn and wait are judged by that subagent's log alone. A wait that goes on across polls keeps the time it began while it shares an approval or a question with the one before, as Mistral Vibe's does.

### Thirty quiet minutes

Nothing on disk marks an open session, and a crash leaves an open turn, and any wait in it, as it was. So a turn of its own, once neither its log nor a subagent's has been written for 30 minutes, the same as keep-awake's bound for a working session, shows as unknown, and a subagent's turn whose own log has been quiet that long no longer keeps the session working. A wait is held past that only while the desktop app runs, as Mistral Vibe's adapter claims a wait only while a holder is shown: a real wait longer than 30 minutes in the command or the web page, with no desktop app, turns unknown after its notice was sent.

A subagent's wait is judged by its own log, and the desktop app backs it only when it started before that log's last write, or within a minute after: a crash leaves the wait open there for good, since DeepSeek Harness closes a crashed turn only in the session it reopens (`packages/core/agent-loop/src/index.ts:796-812`) and reopens a subagent only when it is messaged (`packages/subagent/subagent/README.md:78`). So its session's own writes never hold it. Without the desktop app, once its log is quiet for 30 minutes, it gives way to a turn of the session's own, or of another subagent, that is under way, and otherwise the session shows as unknown. A subagent whose log no program could still write, by `ps` or since the computer started, neither waits nor works.

### Whether a program could still write it

DeepSeek Harness's only marker of a live session is a lock on `session.lock` (`persistence/lease.ts:1-28`), which is never touched: a reader that took it even briefly would stop DeepSeek Harness reopening the session (`:93-97`). No pid is written. A program writes to a session only after it started. So on macOS and Linux a session is finished when either holds:

- its last write, of its log or a subagent's, was more than a minute before the computer started, as `os.uptime()` gives it, which on Linux reads `/proc/uptime`;
- `ps`, asked 2 seconds or more after that write, shows no program that could write it that started before it, or within a minute after, as Linux can move a start by that much. A start that cannot be read counts as before. Some disks keep a write's time in whole seconds, or steps of 2 seconds, rounded down, so a write stamped less than 2 seconds before `ps` was asked may have come after it, from a program `ps` did not show. An answer asked because the clock was set back allows nothing for that.

On macOS a start stays as it was taken, so once a poll's time is more than a minute behind the latest one seen, a last write stamped between the time the clock was set back to and that latest time is not finished by `ps` while a `node` or DeepSeek Harness program runs. The time the clock was set back to is taken as that poll's time less the time since the poll before, which is read on a clock that stops while the Mac sleeps.

`ps -A -o pid=,lstart=,comm=` is run in UTC, at most every 10 seconds, and sooner, though not within 2 seconds of the last run, when a session is written after `ps` showed no `node` or DeepSeek Harness program, or up to 2 seconds before, only while a session's status can change with it. A clock set back counts as time enough. The command is a Node.js script that names no title, so it shows as `node` (`apps/cli/src/bin.ts`). The desktop app and the host it starts from the same program show as `DeepSeek Harness` (`apps/desktop/scripts/electron-builder-config.mjs:119`; `apps/desktop/src/main.ts:210`; `apps/desktop/src/host-process.ts:211-224`). On Linux its program is named from its package, `@deepseek-aidsh-desktop`, which Linux cuts to `@deepseek-aidsh`; that was worked out from electron-builder's rules, not seen. A program of these names, or `nodejs`, counts, the part after the last `/` compared. A helper process of the app does not. Agent Lookout's own process is left out, and nothing else: the `node` that started it, as `npx` does, may be DeepSeek Harness's.

Of each line only whether it is Agent Lookout's own and, for one of those names, when it started and whether it is the desktop app's, is kept. When `ps` fails, or its table does not list Agent Lookout's own process, it cannot say, and only the computer's start finishes a session. That way of reading is named `files-without-processes`, and so is a poll that does not ask `ps` after such an answer, until `ps` is asked again and can say. The usual one is named `files`.

This departs from the Antigravity CLI adapter, where a program whose start is not known makes the answer unknown for every conversation it does not hold (`src/core/mapping/antigravityLiveness.ts:59-97`). Here such a program counts as one that started before the write: it keeps a session from finishing, and nothing more.

## Names and folder

The name is a title its model wrote or one marked as yours, else the folder's, else the ID. The folder is the header's `cwd`, where the session began: `working-directory/change` is not read (`packages/session/working-directory/src/index.ts:55-58`).

## Subagents

A subagent's session is `origin` `subagent`, with `parentSession` its parent's ID (`packages/subagent/subagent/src/child-agent.ts:136-154`). Its log is in the same project folder. The subagent tool returns at once, and the subagent works in the background while its parent can be idle (`packages/subagent/subagent/README.md:45`, `:177-185`), so its turns count for the session it is of: one under way keeps that session working, one that waits for an approval makes it need you, each judged by its own log, as [The status](#the-status) says. A subagent cannot ask you a question (`packages/interaction/user-questions/src/index.ts:144-148`). Its writes count for its session's last write. Its titles are never decoded.

## Quiet for, tokens, Jump, Stop and Answer

- **Quiet for** is the time since its log, or a subagent's, was last written, shown while it works. A long command can write nothing until it ends.
- **Tokens:** a reply's counts are on its line, after its text, and are never turned into text.
- **Jump** and **Stop:** a log names no terminal, window or process. **Answer:** Agent Lookout makes no request to DeepSeek Harness.

## On Linux

The desktop app's names there are worked out, not seen. procps works a process's start out from when the computer started, so a clock set forward by more than a minute makes running programs look started later than they did, and a session they still write can show as finished until it is written again.

## On Windows

`ps` is not asked and the computer's start is not compared, so a session is finished only when DeepSeek Harness closed it mid-turn, and a wait is never held past 30 quiet minutes. The way of reading is always `files-without-processes`.

## Known gaps

- A session reopened that wrote nothing since its last turn shows as finished once no program that started before that write runs.
- A `node` that started before a session's last write, and still runs, keeps that session from showing as finished, whatever it is.
- A real wait in the command or the web page longer than 30 minutes, with no desktop app, turns unknown.
- A question of the timed `ask_user_question`, which DeepSeek Harness's presets do not use, waits only until its time runs out, 120 seconds by default (`packages/interaction/tool-ask-user/src/index.ts:16-26`), then answers itself.
- An answer given in an editor over ACP, slower than one batch, can show as needing you for a moment.
- The folder is where the session began, not where it moved to.
- On Linux, a clock set forward by more than a minute can finish a live session.
- On macOS, after the clock is set back by more than a minute while Agent Lookout runs, a session whose last write is stamped between the time the clock was set back to and the latest time it had seen is not finished by `ps` while a `node` or DeepSeek Harness program runs, so it can stay idle or unknown until none runs, Agent Lookout restarts or it leaves the list a day after its last write. As the time between two polls is read on a clock that stops while the Mac sleeps, a session written after the clock was set back and just before the Mac slept, between the same two polls, can show as finished until it is written again.
- On macOS, when Agent Lookout starts after the clock was set back by more than a minute, a session written since by a program that started before then can show as finished, until it is written after the clock passes that program's start.
- A DeepSeek Harness that is closing can lose a turn's last line (`packages/core/agent-loop/README.md:232`), so a session closed mid-turn can show as working, then unknown or finished.
- A chat imported from chat.deepseek.com whose last reply the import closed on an error (`packages/experimental/deepseek-chat-import/src/conversation.ts:198-207`) shows as failed until it is reopened.

## Not yet checked

Everything here is read from the source, so each of these is for a person with DeepSeek Harness installed to check:

1. The key order of lines migrated from format 3. A difference shows as unknown.
2. The process names of the desktop app on Linux, and that the command shows as `node` everywhere, under `npx` too.
3. How often a streaming reply writes, and how soon an answer given in ACP is written.
4. That a window of 8 MiB covers every frame DeepSeek Harness writes.
5. The ID of a session made in the web page, which, when it is not `session-<uuid>`, is hashed.
6. How chat.deepseek.com titles a chat.
7. Whether `/permission` can reach a subagent from the web page.
8. Whether `os.uptime()` counts sleep on Windows. It is not used there.

## What breaks when DeepSeek Harness changes

| Change in DeepSeek Harness                                                                | What the dashboard shows                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A format 5                                                                                | Those sessions are not listed, or show as unknown, with a note |
| A new kind of `turn/end`                                                                  | Those sessions show as unknown, with a note                    |
| The key order of `turn/end`, `tool/call`, `tool/result`, an approval, a title or an event | Those sessions show as unknown, or take their folder's name    |
| Frames with other flags, or batches not of whole lines                                    | Those sessions show as unknown, with a note                    |
| A new default home or rule for `DSH_HOME`                                                 | DeepSeek Harness is not found, or found with no sessions       |
| A program renamed, or a title set for the command                                         | Its sessions show as finished while it runs                    |
| The tools renamed from `ask_user_question` and `exit_plan_mode`                           | Those waits show as working                                    |
| New kinds of a title's source                                                             | Those sessions take their folder's name                        |
| `session/end-seed` written otherwise                                                      | A fork or a reopened session shows its old status              |

To check a new DeepSeek Harness version, read `packages/session/session-persistence-jsonl/src/{format,index,zstd,lease,generation}.ts`, `packages/session/session-format/src/filename.ts`, the newest `packages/session/session-format-*/src/codec.ts`, `packages/core/session/src/{index,types,fork,repair}.ts`, `packages/core/agent-loop/src/{agent,index}.ts`, `packages/core/tools/src/batch.ts`, `packages/interaction/user-approval/src/index.ts`, `packages/interaction/tool-ask-user/src/index.ts`, `packages/plan/plan-mode/src/index.ts`, `packages/session/session-title/src/index.ts`, `packages/util/home-paths/src/index.ts`, `packages/bundle/base/cordis.patch.yml` and `apps/desktop/scripts/electron-builder-config.mjs`. Then update `UNCHECKED_NOTE` in `src/collector/adapters/deepseek-harness/index.ts` and the first paragraphs here.
