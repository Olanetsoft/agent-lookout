# Cline adapter notes

These notes record what Agent Lookout reads from Cline, where each value comes from, and what breaks when Cline changes. When the adapter stops working, start here.

Written on 2026-11-04 from the source of Cline's CLI at `cli-v3.0.74`, released 2026-10-26 (commit `04b6775` of [cline/cline](https://github.com/cline/cline)), whose runtime is `@cline/core` 0.2.0. The newest tags, `v4.1.26` for the VS Code extension and `desktop-v0.0.49` for the desktop app, are two commits and one commit on from it, and change only version numbers and changelogs. Cline was not installed or run on the machine where the adapter was written, and no Cline folder was read there. Everything below comes from that source and from hand-written files laid out the same way. **The adapter was built from Cline's source at cli-v3.0.74 and has not yet been checked on a computer running Cline.** The Sources view says so too.

Each citation is `path:line` at `cli-v3.0.74`, where `core/` is `sdk/packages/core/src/` and `shared/` is `sdk/packages/shared/src/`.

The code is in `src/collector/adapters/cline/`, and the status mapping is in `src/core/mapping/cline/clineMapping.ts`.

## What this covers

Cline has two ways of keeping sessions, and this adapter reads one.

- Its newer runtime, `@cline/core`, keeps a folder for each session under `~/.cline/data/sessions/`. Cline's CLI uses it, its desktop app uses it, and so do the VS Code builds that run the same runtime. This adapter reads that folder.
- The older VS Code extension keeps its tasks in the editor's own storage, in another layout. This adapter does not read them, so a session of that extension is not listed.

The issue this adapter came from says that a status, a folder and a process ID are on disk, and that a pending tool approval is not. The first holds. The second does not hold at `cli-v3.0.74`: the runtime writes `pending` for as long as a tool's approval is asked, as [Needs you](#needs-you) says, so a Cline session can show as needing you.

## How it reads Cline, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no Cline program run, no network. It reads each session's manifest, read-only, and asks whether the process it names runs with signal 0, which sends the process nothing. On a Mac it also asks `ps` when that process started, as [A pid another program was given](#a-pid-another-program-was-given) says.

Cline has other ways in, and none of them can be used that way:

| Interface                              | Why it is not used                                                                                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cline history` and the other commands | They start Cline, and listing sessions writes: `listSessions` ends each session whose process has gone, in Cline's database and in its manifest (`core/session/services/persistence-service.ts:445-514`) |
| `<data>/db/sessions.db`                | Cline's database of sessions holds the prompt and the same status as the manifest. Reading it would need `sqlite3` and adds nothing this adapter uses                                                    |
| Cline's hub, a local WebSocket server  | It takes commands and needs the hub's token, which Agent Lookout never reads                                                                                                                             |
| `<session id>.messages.json`           | It holds the whole conversation. Its modified time is looked up, and it is never opened                                                                                                                  |

## What it reads

| Path                           | How                                                                              | How often                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `<sessions folder>/`           | Listed                                                                           | Every poll, and once a minute while it is missing                                     |
| `<id>/<id>.json`, the manifest | One `lstat`                                                                      | Every poll for a session shown or a new folder, and once a minute for every other one |
| The same file                  | Opened read-only when written in the last day, and read whole when 1 MiB or less | When its size, modified time or identity changes                                      |
| `<id>/`                        | One `lstat`, to see that it is a folder and not a link                           | Before a manifest is opened                                                           |
| `<id>/<id>.messages.json`      | One `lstat`, for its modified time. Never opened                                 | Every poll, for a session whose manifest says it is open                              |

Every other manifest is looked up once a minute because Cline keeps every session it ever ran, so that folder can hold thousands. A manifest last written over a day ago is never opened.

A manifest is opened without following a link at its name and without waiting on a pipe, and read only if the open file is an ordinary file. A manifest is not opened through a link at a session's folder. The `lstat` of a manifest or a messages file does not check that folder first, so it can pass through such a link, and it takes only a size, a time and an identity from what is behind it. The sessions folder itself can be a link. A folder's name must be letters, digits, `.`, `_` and `-`, begin with a letter or a digit, and be 200 characters or less. No other folder is read, and neither are `sessions.index.json` and `subagent-spawn-queue.json`, which Cline writes there when it cannot use SQLite (`core/session/services/file-session-service.ts:63,67`).

## The folders

The sessions folder is worked out as Cline works it out (`shared/storage/paths.ts:158-200`). The first of these that is set is used, and an empty value counts as unset:

| Setting                    | Sessions folder                                   |
| -------------------------- | ------------------------------------------------- |
| `AGENT_LOOKOUT_CLINE_HOME` | `<folder>/data/sessions`, for Agent Lookout alone |
| `CLINE_SESSION_DATA_DIR`   | `<folder>`                                        |
| `CLINE_DATA_DIR`           | `<folder>/sessions`                               |
| `CLINE_DIR`                | `<folder>/data/sessions`                          |
| None                       | `~/.cline/data/sessions`                          |

When the folder is missing, Cline is reported as not found, with no advice, and the folder is looked for again once a minute. When `AGENT_LOOKOUT_CLINE_HOME` names a folder with nothing in it, that is an answer, not a missing Cline: the source is watched and lists no sessions.

Two ways Cline moves its folder cannot be followed, because Agent Lookout never reads Cline's settings or its command line:

- `cline --config <folder>` sets Cline's folder for that run (`apps/cli/src/main.ts:161`).
- `cline --data-dir <folder>` keeps that run's data in the folder, and `CLINE_SANDBOX=1` in a folder in the system's temporary files (`apps/cli/src/utils/helpers.ts:573-605`).

A person who uses `--config` can start Agent Lookout with `CLINE_DIR` set to the same folder, and one who uses `--data-dir` with `CLINE_DATA_DIR`.

## The manifest

`<id>/<id>.json` is JSON, two spaces to a level, written with `writeFileSync` (`core/session/stores/session-manifest-store.ts:112-119`), so in place and not through a temporary file. A read can catch one half written. What was last read of that file then stands in for one poll.

Cline makes a session's manifest at its first prompt, and for a forked or restored session as it starts (`core/runtime/host/local-runtime-host.ts:2437-2462`). The desktop app also makes one for each session it imports from Claude Code, Codex or OpenCode, already `completed`, with pid 0 and the times that session had there (`core/services/session-import/service.ts:325-345`). A session opened with no prompt has none, so it is not listed until its first prompt. After that, the runtime reads the manifest, changes it and writes it whole each time the status, the title or the session's other details change (`core/runtime/host/local-runtime-host.ts:1933-1969`).

| Field                                                                                                             | Meaning                                                                                                                      | Kept                                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `version`                                                                                                         | `1`. A higher one is left out, and the Sources view says so                                                                  | Read, not kept                                |
| `session_id`                                                                                                      | The session's id. It must be the folder's name                                                                               | Yes                                           |
| `pid`                                                                                                             | `process.pid` of the process that hosts the session, which can be the hub's                                                  | Yes, when it is a positive whole number       |
| `started_at`                                                                                                      | When the session began, as an ISO time                                                                                       | Yes, when it is one                           |
| `ended_at`                                                                                                        | When it ended, as an ISO time. Left out while it is open                                                                     | Yes, when it is one                           |
| `status`                                                                                                          | [Status](#status)                                                                                                            | Yes, when it is text of 32 characters or less |
| `cwd`                                                                                                             | The session's folder                                                                                                         | Yes, when it is an absolute path              |
| `metadata.title`                                                                                                  | Its title. By default the first line of its first prompt                                                                     | No: dropped with the parsed file              |
| `prompt`                                                                                                          | The first prompt, in full                                                                                                    | No: dropped with the parsed file              |
| `metadata`, but for `title`                                                                                       | Among much else the mode, the git state, `totalCost`, `usage` and `aggregateUsage`. A hub session's can hold a system prompt | No: dropped with the parsed file              |
| `source`, `exit_code`, `interactive`, `provider`, `model`                                                         | The app, how it ended, and the model it used                                                                                 | No                                            |
| `workspace_root`, `team_name`, `enable_tools`, `enable_spawn`, `enable_teams`, `messages_path`, `compaction_path` | Its settings and where its other files are. No path in a manifest is ever opened                                             | No                                            |

`session_id` that is not the folder's name, a `version` that is not a number or is below 1, and a file that is not a JSON object make the whole file unusable, and its session is not listed. Any other bad value is treated as none: a pid that is not a positive whole number, a time that is not an ISO time with a zone, a folder that is not an absolute path or holds a control character. A time before 2020, or more than a minute ahead of the clock, is treated as none too.

A manifest over 1 MiB is not read, and the Sources view says so. Cline sets no limit on a prompt, and the whole of the first prompt is in the manifest.

Subagents and teammates have no manifest and no folder of their own: their messages are in the folder of the session that started them (`core/services/session-artifacts.ts:132-144`).

A session's id in Agent Lookout is `cline:<session id>`.

## Which sessions are listed

A session is first listed when its manifest was written in the last 24 hours, by that time alone. Once it is listed, it stays for 24 hours after its manifest or, while that says it is open, its messages file was last written, and one that is working or needs you stays for as long as its process runs, so a wait left over a weekend does not drop out.

Cline never removes a session's folder by itself, so a look through every folder is what finds a session that was written again. A new folder is found on the next poll. A session last written over a day ago that is opened again is found by the next look, within a minute.

## Status

`status` is one of six words (`shared/session/records.ts:1-22`). The runtime writes each change to the manifest through `updateStatus` (`core/runtime/host/local-runtime-host.ts:2744-2773`).

| `status`                     | Its process | Status    | Written                                                                                                      |
| ---------------------------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------ |
| `completed`, `cancelled`     | Any         | Finished  | When a one-shot run ends, or an open session closes, by how its last turn ended (`:2069-2086`, `:2551-2564`) |
| `failed`                     | Any         | Failed    | When a turn throws, a one-shot run ends on an error, or an open session closes after one (`:2566-2577`)      |
| `running`                    | Runs        | Working   | From a turn's start to its end (`:2032`)                                                                     |
| `pending`                    | Runs        | Needs you | While a tool's approval is asked (`:957-978`)                                                                |
| `idle`                       | Runs        | Idle      | When a turn ends in an open session (`:2059-2067`), and for a session opened with no prompt                  |
| `running`, `pending`, `idle` | Gone        | Finished  | A crash writes nothing, so the manifest says what it said last                                               |
| `running`, `pending`, `idle` | Not known   | Unknown   | A manifest with no pid that could be one: a status that needs a process is not guessed at                    |
| Anything else                | Any         | Unknown   |                                                                                                              |

The status time is the manifest's modified time when it was first read with that status, and it stays while the status lasts, so a title written during a wait does not make it a new wait. Over a session that ended it is `ended_at`, and over one whose process went it is the last write. An unknown status has no time.

When Cline next starts, or lists its sessions, it finds each open session whose process has gone and rewrites it as `failed`, with `metadata.terminal_marker` set to `failed_external_process_exit` (`core/session/services/persistence-service.ts:445-514`). So a session a crash left behind shows as finished until then, and as failed after.

### Needs you

The runtime wraps the callback that asks for a tool's approval. It writes `pending` before it asks and `running` once it has an answer (`core/runtime/host/local-runtime-host.ts:957-978`). Both ways of hosting a session go through it: the CLI passes its callback to the local runtime, and the hub passes one to the runtime it runs (`core/hub/server/handlers/session-handlers.ts:447-450`). That wrapper is the one thing that writes `pending` to a manifest at this tag.

`pending` is shown as needing you, with the reason permission. What Cline asks is not in the manifest, so nothing of it is shown.

The comment beside the status in Cline's source describes `pending` as work waiting to be delivered or resumed, such as a queued prompt (`shared/session/records.ts:9-11`), and nothing at this tag writes it for that. If a later Cline does, such a session would show as needing you. The check to make is under [What breaks when Cline changes](#what-breaks-when-cline-changes).

A question, the `ask_question` tool, runs through its own callback and writes nothing, so a session that asks you one shows as working (`core/extensions/tools/definitions.ts:850-877`).

## The process, and Cline's hub

`pid` is `process.pid` of whatever hosts the session (`core/runtime/host/local-runtime-host.ts:611,2443`), and that depends on the app:

| App                                                            | What hosts the session                    | What `pid` is        |
| -------------------------------------------------------------- | ----------------------------------------- | -------------------- |
| The CLI, with a hub already running                            | Cline's hub, a detached background server | The hub's            |
| The CLI as the hub starts, with `--yolo`, or with `--data-dir` | The CLI                                   | The CLI's            |
| The desktop app                                                | Cline's hub                               | The hub's            |
| The VS Code builds that run the runtime                        | The extension host                        | The extension host's |

(`core/runtime/host/host.ts:211-262`, `apps/cli/src/runtime/interactive/session-runtime.ts:160-169`, `apps/examples/desktop-app/sidecar/context.ts:1308`, `apps/vscode/src/sdk/vscode-session-host.ts:180`.)

So several sessions can name one pid, and it may be in no terminal. And a program that closes a hub's session only detaches from it: the CLI's stop sends `session.detach` (`core/hub/runtime-host/hub-runtime-host.ts:1395-1399`), and the hub keeps the session, as it was, for as long as it runs. It has no idle shutdown. When the hub stops, each session it holds is ended and written as finished or failed (`core/hub/server/hub-server-transport.ts:788`). So a session you closed in the CLI stays idle here until the hub stops, or until it leaves the list a day after it was last written. A manifest does not say whether a hub session has a window open.

Every session whose manifest says it is open is asked about with signal 0 on every poll. A session that has ended is not, and it shows no process ID. A manifest that names no pid is not asked about, and shows as unknown.

### A pid another program was given

After a crash, the system can give a pid to another program, and signal 0 then says the process runs. A manifest holds no start token, but `started_at` says when the session began, and the session's process was running then. So on a Mac, `ps -o pid=,lstart= -p <pids>` is asked when the process with the pid started, with the check Qwen Code's and Mistral Vibe's adapters use (`qwen-code/processCheck.ts`). One that started more than a minute after `started_at` is another program, and the session is finished. It runs every 30 seconds while a session's process runs, and sooner when another appears, for all of them at once, and one answer stands until that pid ends, so a later check that fails does not bring the session back.

Only on a Mac, because a comparison acts only when it is sure. Linux's `ps` works a start time out again from the clock each time, so a clock set forward makes a process that runs look as if it started later, and Windows has no `ps`. There, a pid given to another program counts as the session's.

## Names, folders and apps

- **Name:** the folder's name, then the id.
- **Why not `metadata.title`:** by default it is the first line of the first prompt, cut to 120 characters (`core/services/session-data.ts:232-249`), and a fork's has ` (fork)` added, so it would carry what was typed into emails, webhook posts and pushes, which promise no prompt. You can set another with `cline history update --title`, but no field says which of the two a title is, and comparing it with `prompt` does not tell: a fork or a restored session keeps the title it came with while its manifest holds a later prompt (`core/runtime/host/local-runtime-host.ts:2011-2015`, `core/session/services/persistence-service.ts:243-246`). So it is dropped with the rest of the file, and, as for Qwen Code, what was typed is never used. `prompt` is never read for a name.
- **Folder:** `cwd`, as written.
- **App:** not known. `source` is `cli`, `desktop`, `vscode` and others, and it is not kept, so the session's app is not shown.

## Quiet for

The last write of a session whose manifest says it is open is the newest modified time of its manifest and its messages file. Cline rewrites the messages file at each reply and each step of a turn (`core/runtime/host/local-runtime-host.ts:1003-1016`, `core/services/agent-events.ts:312-318`), so its time moves as the session works. Only its time is looked up. Nothing is written while one long reply comes in or one long tool runs, so a session busy on either shows as quiet.

## Token counts

No. `Session.tokens` holds the counts of the newest reply. The manifest's `metadata` holds a session's running totals, `usage` and `aggregateUsage` (`core/runtime/host/local-runtime-host.ts:2246-2252`), which are not those, and a reply's own counts are in the messages file beside the conversation, which is never opened. For the same reason there is no [last message](../GUIDE.md#a-sessions-details).

## Jump, Stop and Answer

None. The process can be the hub, which many sessions share and which is in no terminal, so a pane or a tab cannot be told from it. Agent Lookout stops Claude Code sessions only so far, and signalling the hub would end every session it holds. It does not talk to Cline's hub or its runtime, so it cannot send an answer.

## Known gaps

- A session that asks you a question shows as working. Cline writes nothing for it.
- A session in Cline's hub stays idle after you close its window, for as long as the hub runs, until it leaves the list a day after it was last written. Nothing on disk says whether a window has it open.
- A session resumed in another process without a new prompt keeps the manifest it had, with the pid of the process before (`core/runtime/host/local-runtime-host.ts:628-650`). Once that process has gone, the session shows as finished while it runs, and Cline's own check of dead sessions can write it as failed.
- A session that crashed shows as finished, and as failed once Cline next starts.
- An open session whose turn ended on an error Cline returned, rather than threw, shows as idle until it closes.
- On Linux and Windows, after a crash, another program can take the pid. The session then shows as open, with the status its manifest last gave, until that program ends or the session leaves the list. If the manifest says `running` or `pending`, it stays listed for as long as that program runs.
- On a Mac, a session shows as finished while it runs if the clock was set back by more than a minute between its process's start and `started_at`.
- An open session left idle for a day leaves the list until it is next written.
- A session working or waiting whose manifest was last written over a day ago when Agent Lookout starts is not found until its manifest is next written, usually when the turn ends, however recently its messages file moved, because no manifest that old is opened.
- A session last written over a day ago that is opened again takes up to a minute to appear.
- A manifest over 1 MiB is not read, so that session is not listed.
- A manifest that could not be opened, as on a read error or a permission problem, is not tried again until it is next written or Agent Lookout restarts. Its session is not listed until then, and one that was listed leaves the list as one that ended.
- A session the desktop app imports from Claude Code, Codex or OpenCode is listed as a finished Cline session for a day after the import, with the start and status times it had in that tool. One Agent Lookout also lists under that tool shows twice.
- A session shown whose folder is moved and replaced by a link to it stays listed, with the times of the files behind the link, until its manifest next changes.
- A session of the older VS Code extension is not listed, and nor is one in a folder `cline --config` or `cline --data-dir` names, or one on a remote runtime.
- A session opened with no prompt is not listed until its first prompt, since it has no manifest yet.
- A session's app is not shown.
- Sessions in one folder share a name, and a title set with `cline history update --title` is not shown.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Cline installed to check:

1. That a session's folder and manifest appear as above, for the CLI, the desktop app and a VS Code build, and that `status` moves through `running`, `pending` and `idle` as a session works and asks for an approval.
2. That `pid` is the hub's for a CLI session started while a hub runs, and that the hub stays up after the CLI closes, with the session `idle`.
3. That a real manifest stays well under 1 MiB, and how long a large pasted prompt makes one.
4. That a killed process leaves `running` behind, and that the next `cline` rewrites it as `failed`.
5. Which VS Code builds write to this folder: the extension's source at this tag starts sessions through the runtime, and a build that runs the older code does not.

## What breaks when Cline changes

| Change in Cline                                          | What the dashboard shows                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `version` goes above 1                                   | No Cline sessions, and the Sources view names a newer format                      |
| The folder layout or the file names change               | No Cline sessions, or Cline is not found                                          |
| A new word in `status`                                   | Those sessions show as unknown, and the Sources view says so                      |
| Something else writes `pending`, such as a queued prompt | Such a session shows as needing you while it waits for nothing of yours           |
| The approval wrapper stops writing `pending`             | A session that waits for an approval shows as working                             |
| `pid` moves or stops being the host's                    | An open session shows as finished, or as unknown                                  |
| `started_at` stops being when the session began          | On a Mac, sessions show as finished while they run, or a crash's leftover as open |
| Manifests start to hold more than 1 MiB as a rule        | Those sessions are not listed, and the Sources view says so                       |
| The messages file moves or stops being rewritten         | A working session looks quiet                                                     |
| Cline's variables for its folders change                 | Cline is not found, or found empty                                                |

To check a new Cline version, read `core/session/models/session-manifest.ts`, `core/session/stores/session-manifest-store.ts`, `core/services/session-artifacts.ts`, `core/services/session-data.ts`, `shared/session/records.ts`, `shared/storage/paths.ts`, `core/runtime/host/local-runtime-host.ts` (search for `markTurnPending` and `updateStatus`) and `core/session/services/persistence-service.ts`, then update `UNCHECKED_NOTE` in `src/collector/adapters/cline/index.ts` and the first paragraphs here.
