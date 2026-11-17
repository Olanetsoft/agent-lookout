# Kimchi adapter notes

These notes record what Agent Lookout reads from Kimchi, where each value comes from, and what breaks when Kimchi changes. When the adapter stops working, start here.

Written on 2026-11-17 from Kimchi's source at `v1.35.0`, released 2026-11-16 (commit `dcdcab9` of [getkimchi/kimchi](https://github.com/getkimchi/kimchi)), the newest release then. Kimchi runs Pi's coding agent, `@earendil-works/pi-coding-agent` 1.3.0 (`package.json:63`), so Pi's source was read at its tag `v1.3.0` too (commit `71023ae` of [earendil-works/pi](https://github.com/earendil-works/pi)). Kimchi is under the Apache-2.0 licence (`package.json:6`), and Pi under the MIT licence. Neither was installed or run to write these notes, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from Kimchi's source at v1.35.0 and has not yet been checked on a computer running Kimchi.** The Sources view says so too.

Each citation is `path:line` at Kimchi's `v1.35.0`, or `pi:path:line` at Pi's `v1.3.0`, where every Pi path is in `packages/coding-agent/`. The lines were counted on the raw files.

The code is in `src/collector/adapters/kimchi/index.ts`. It is the Pi adapter's body, `createPiFamilyAdapter` in `src/collector/adapters/pi/index.ts`, with `KIMCHI_PROFILE`, a `PiProfile` from `src/collector/adapters/pi/profile.ts`. The status mapping is Pi's, in `src/core/mapping/pi/piMapping.ts`. Everything [the Pi notes](pi.md) say holds here unless this page says otherwise, and a change to those modules changes Kimchi too. Pi's finder, `sessionFiles.ts`, also finds Unreal Agent's files, with options Kimchi does not set, which leave what it finds for Kimchi as it was.

## What the issue said, and what holds

Issue #73 was written from Kimchi v1.7.1 and Pi 0.85.1.

| What issue #73 said                                                                          | What the source shows                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi's JSONL session files under `~/.config/kimchi/harness/sessions/`, one folder each project | True, on macOS, Linux and Windows (`src/entry.ts:54-59`, `pi:src/config.ts:649-650`, `pi:src/core/session-manager.ts:589-594`)                                                                                                        |
| Kimchi Studio writes its sessions there too                                                  | Not checked: these notes read the command's source alone                                                                                                                                                                              |
| `--session-dir`, `KIMCHI_CODING_AGENT_SESSION_DIR` or `sessionDir` move the folder           | True of Pi's `main()`, which the terminal, print and RPC modes run (`src/cli.ts:1119-1120`, `pi:src/main.ts:691-695`). ACP mode never moves it, as [Where it looks](#where-it-looks) says. Only the variable is followed here         |
| The last `message` line tells working from idle                                              | Not well enough. A crash leaves a session's last lines as they were mid-turn, and nothing ties a session to a process. So the status is Pi's, as [Status](#status) says                                                               |
| An assistant message with `stopReason` `error` marks a failed turn                           | It does, but Pi can retry after a run ends, so a reply that works can follow it (`src/extensions/agent-end-will-retry.ts:5-8`). It is not read                                                                                        |
| A `custom` line `agent_end` when a run ends, and `agent_terminated` when the process stops   | True (`src/extensions/shutdown-marker.ts:3-4`, `:53-59`). `agent_end` is written at every run's end, a retry or not, and a killed process writes neither. They are not read                                                           |
| Approval prompts and questions are not written to disk                                       | True. A question emits an event in Kimchi's process and writes nothing (`src/extensions/questionnaire/questionnaire.ts:241`), and so does a tool's approval (`src/extensions/permissions/index.ts:1846`, `:1907`)                     |
| Nothing on disk marks a session whose Kimchi has exited                                      | True                                                                                                                                                                                                                                  |
| Subagent sessions sit in the same folder with a `kimchi:subagent-session` line               | True, as the second line (`src/extensions/agents/manager/session-file.ts:28-45`). Ferment's evaluator marks its sessions `kimchi:internal-session` the same way (`src/extensions/ferment-v2/evaluator.ts:347-350`). Both are left out |
| The format is Pi's, so this may share a reader with #36                                      | True: this adapter is the Pi adapter's body                                                                                                                                                                                           |

## How it reads Kimchi, and why

As for Pi: it needs nothing installed and changes nothing. It reads the first bytes of each recent session file, read-only, and asks `ps` whether a `kimchi` program runs. It runs no program of Kimchi's and makes no request to it. It differs from Pi's in three ways:

- It reads no name. Kimchi names every session itself from the person's first messages, as [Names](#names) says.
- It leaves out the sessions Kimchi marks as its own on their second line, as [The second line](#the-second-line) says.
- It reads only a file's first 64 KiB, and once it has found a session or a mark there, not again while the file only grows. Nothing past the first two lines is needed.

Kimchi's ACP server (`src/modes/acp/server.ts`) lists sessions too, but it is a Kimchi that a client starts and talks to, and its list reads every line of every file, with the text of every message.

## Where it looks

The first of these that is set is used, and an empty one counts as unset:

| Setting                           | Sessions folder                                                  |
| --------------------------------- | ---------------------------------------------------------------- |
| `AGENT_LOOKOUT_KIMCHI_HOME`       | `<folder>/sessions`, for Agent Lookout alone                     |
| `KIMCHI_CODING_AGENT_SESSION_DIR` | That folder, with the files directly in it                       |
| None                              | `~/.config/kimchi/harness/sessions`, on macOS, Linux and Windows |

**The agent folder.** As Kimchi starts, `src/entry.ts:54` sets it to `~/.config/kimchi/harness` from `homedir()`, and writes it into `KIMCHI_CODING_AGENT_DIR` and `PI_CODING_AGENT_DIR` over anything set before (`:55`, `:59`). So neither variable moves it, and the adapter reads neither. Pi takes `sessions` in it (`pi:src/config.ts:605-611`, `:649-650`).

**The variable.** Pi names its variable for the sessions folder after its app's name: `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR` (`pi:src/config.ts:586`). That name is `piConfig.name` in the `package.json` of Pi's package folder (`pi:src/config.ts:565-579`), which is `PI_PACKAGE_DIR` when it is set (`pi:src/config.ts:393-397`). Kimchi sets `PI_PACKAGE_DIR` as it starts (`src/entry.ts:44`), to a folder its build copies its own `package.json` into (`scripts/copy-resources.js:116`), whose `piConfig.name` is `kimchi` (`package.json:52-56`). So the variable is `KIMCHI_CODING_AGENT_SESSION_DIR`. A leading `~` is the home folder, as Pi takes it (`pi:src/utils/paths.ts:88-94`). A relative value is relative to where Kimchi was started, which cannot be known here, so the adapter goes past it.

**ACP mode.** A client that runs Kimchi over ACP gets its sessions in `sessions` in the agent folder, in the same project folders, whatever the variable and the setting say (`defaultSessionLoader` and `encodeCwdDir` in `src/modes/acp/server.ts`). So with `KIMCHI_CODING_AGENT_SESSION_DIR` set, those sessions are not listed.

Not followed, because Agent Lookout reads no settings file and no process's arguments: `kimchi --session-dir <folder>`, which Pi takes first (`pi:src/main.ts:693`), and the `sessionDir` setting in `~/.config/kimchi/harness/settings.json` (`pi:src/main.ts:695`). A person who uses either can start Agent Lookout with `KIMCHI_CODING_AGENT_SESSION_DIR` set to the same folder.

When the folder is missing, Kimchi is reported as not found, with no advice, and the folder is looked for again once a minute, or on every poll when `AGENT_LOOKOUT_KIMCHI_HOME` is set. When `AGENT_LOOKOUT_KIMCHI_HOME` names a folder with nothing in it, that is an answer, not a missing Kimchi.

## What it reads

| Path                                   | How                                                                               | How often                                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The sessions folder                    | Listed                                                                            | Every poll, and while it is missing once a minute, or every poll when `AGENT_LOOKOUT_KIMCHI_HOME` is set    |
| Each project folder, `--<folder>--/`   | One `lstat`, to see that it is a folder and not a link, and for its modified time | Every poll                                                                                                  |
| The same folder                        | Listed                                                                            | When its modified time moves, and once a minute                                                             |
| Each `*.jsonl` written in the last day | One `lstat`                                                                       | Every poll, for the newest 200                                                                              |
| Every other `*.jsonl`                  | One `lstat`. Never opened                                                         | Once a minute                                                                                               |
| A session file written in the last day | Opened read-only: its first 64 KiB                                                | When it changes, until a session or a mark is found in it, then only when it is a new file or grows shorter |

A file is opened without following a link at its name, and not through a link at a project folder, as for Pi. Nothing else in Kimchi's folder is read: not `settings.json`, `auth.json`, `models.json`, its logs, its memory, its work ledger or anything beside the sessions folder.

## The session file

The file is Pi's: `<project folder>/<time>_<id>.jsonl`, where `<time>` is the header's with `:` and `.` as `-` (`pi:src/core/session-manager.ts:1076-1077`). The project folder is the working directory with its first `/` or `\` dropped, and `/`, `\` and `:` as `-`, between `--` and `--` (`:589-594`), which Kimchi's ACP server writes the same way (`encodeCwdDir`). Pi makes the file at the session's first user or assistant message, writing each entry held until then in turn, and then adds one line for each entry (`_persist`, `:1169-1186`).

### The header

The first line, as Pi writes it (`:43-50`, `:1060-1067`). Only `id`, `timestamp`, `cwd` and `version` are kept, as [the Pi notes](pi.md#the-header) say. `version` is `3` at Pi 1.3.0 (`:41`), and a higher one is left out. `parentSession`, which a subagent's, a branch's and a side chat's header holds, is dropped with the parsed line, and a session is never left out for having one. Pi 1.3.0 allows an id of any length (`assertValidSessionId`, `:266-271`). The reader takes one of up to 200 characters, as Pi 1.5.0 allows.

### The second line

Kimchi writes two kinds of session for itself, beside the person's, and marks each on its second line, the entry right after the header. Kimchi's own list of sessions looks at that line for the same markers (`src/session-visibility.ts:5-7`, `:77-79`).

| Session               | Second line                                                                                                                      | Where it is written                                                                                                                                                                             |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A subagent's          | `{"type":"custom","id":…,"parentId":null,"timestamp":…,"customType":"kimchi:subagent-session","data":{"type":…}}`                | With the header, in one write, in the parent's project folder (`src/extensions/agents/manager/session-file.ts:28-45`)                                                                           |
| Ferment's evaluator's | `{"type":"custom","customType":"kimchi:internal-session","data":{"kind":"ferment-evaluator"},"id":…,"parentId":…,"timestamp":…}` | By Pi's `appendCustomEntry` (`pi:src/core/session-manager.ts:1286-1297`), first after the header, in the parent's project folder (`src/extensions/ferment-v2/evaluator.ts:347-350`, `:480-484`) |

A file whose second line is either is left out. The line is compared as bytes, in the first 64 KiB, and never turned into text: it must start with `{"type":"custom",`, and the first `"customType":` in it must be followed by `"kimchi:subagent-session"` or `"kimchi:internal-session"`, then `,` or `}`. JSON writes a `"` inside a string as `\"`, so those bytes cannot come from words in a string. Both writers put `customType` before `data`, the one value that can hold an object. A marker anywhere else, or on another kind of line, leaves a session in.

A file with only its header is not listed until its second line is written, and is read again from the start then: Pi writes the first entries one at a time. A file left out is not opened again while it only grows.

### Everything else

Every other line is passed over, `session_info` included. `message` lines hold the prompts, the replies and the tools' arguments and output, and `custom` lines hold what Kimchi's extensions keep, such as `agent_end`, `agent_terminated` and `work_identity`. None of it is parsed, kept or logged.

## Which sessions are listed

Each session whose file was written in the last 24 hours, by its modified time, the newest 200, but for those [The second line](#the-second-line) leaves out. Kimchi's own ACP list leaves out every session with a `parentSession`, but a branch the person makes with `/branch` is a fork (`src/extensions/branch-command.ts:65`), which names its parent too (`pi:src/core/session-manager.ts`, `createBranchedSession`), so here a branch is listed as a session of its own.

A side chat is kept in `side-chats/<session id>/<id>.jsonl` in the session's folder, with no marker (`src/extensions/side-chat/store.ts:6`, `:36`, `:70-72`). Only the `*.jsonl` files directly in a project folder are looked at, so a side chat is never listed, nor opened.

## Status

`mapPiStatus` in `src/core/mapping/pi/piMapping.ts`, as for Pi:

| A `kimchi` program runs | Status     |
| ----------------------- | ---------- |
| Yes, or `ps` cannot say | `unknown`  |
| No                      | `finished` |

A session is never `working`, `idle`, `needs-you` or `failed`, for the reasons [the Pi notes](pi.md#status) give. Kimchi's `agent_end` and `agent_terminated` lines do not change that. `agent_end` is written whenever a run ends (`src/extensions/shutdown-marker.ts:53-54`), and Pi can retry after it (`src/extensions/agent-end-will-retry.ts:5-8`). `agent_terminated` is written from `session_shutdown`, as `signal` when no cause is given (`:57-59`). A killed or crashed Kimchi writes neither. So none of them says whether a session is open, and reading them would mean reading past a file's first lines on every change.

The poll's basis is Pi's: `files`, `files-closed` while no `kimchi` runs, and `files-without-processes` while `ps` cannot say.

### The process

`src/entry.ts:61` sets `process.title` to `kimchi` before anything else loads. Kimchi's releases for macOS and Linux are one program named `kimchi` (`scripts/build-binary.js:19-22`, `:25-28`), which runs `src/entry.ts` (`src/binary-entry.ts:28`), and the package's command is `kimchi` too (`package.json:7-9`). So `ps -A -o comm=` shows `kimchi` in every mode, ACP included. It compares each line with `kimchi`, or a path ending in it, and drops it. It does not count `pi` or `pi-rpc`, and the Pi adapter does not count `kimchi`. A Node program that sets its title to `kimchi` shows as that on macOS and Linux, and a test holds the real `ps` to that. No real Kimchi was seen.

### Why nothing shows as waiting

Kimchi asks before a tool runs, by its permission modes, and its questionnaire asks you questions. Both wait in memory: a question emits an `agent_needs_input` event in Kimchi's process (`src/extensions/questionnaire/questionnaire.ts:241`), and a tool's approval emits `BEFORE_PROMPT` (`src/extensions/permissions/index.ts:1846`, `:1907`). Neither writes to the session file.

## Names

Kimchi names every session itself. After a turn ends, if the session has no name, `src/extensions/session-name.ts` sends up to three of the person's first messages, each cut at 500 characters, to a model, and sets its answer as the name (`:28`, `:92`, `:235-250`). With no login, or when that fails, the name is the first message, cut at 50 characters at a space (`:26`, `:103-109`, `:135`). Both are written as `session_info` lines, as a rename the person makes is, and nothing tells them apart.

So no `session_info` line is read, and a Kimchi session takes its folder's name, else its id. A name the person gave is not shown. [What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) in PRIVACY.md says this for people.

## Quiet for, tokens, Jump, Stop and Answer

None, as for Pi. A Kimchi session never shows as working, a reply's counts are on the line with its text, which is never parsed, a session's file names no process or terminal, and Agent Lookout makes no request to Kimchi. There is no last message either.

## On Windows

The files are read as on any system, from `%USERPROFILE%\.config\kimchi\harness\sessions`, the folder `homedir()` gives `src/entry.ts:54` there. `ps` is not run, so nothing says whether a `kimchi` runs: each session shows as unknown until it leaves the list, and none shows as finished. The card says so.

## Known gaps

- Every gap [the Pi notes](pi.md#known-gaps) list for status, the process, the list of 200, links and files that cannot be read holds here, with `kimchi` for `pi`.
- A session never shows as working, idle, needing you or failed, and finished is all or nothing.
- A name you gave a session is not shown: every Kimchi session takes its folder's name, so sessions in one folder share one.
- With `KIMCHI_CODING_AGENT_SESSION_DIR` set, a session a client started over ACP is not listed, since it stays in the default folder. A folder `--session-dir` or the `sessionDir` setting names is not read.
- A subagent's or an evaluator's file whose marker is not its second line, as an older Kimchi's may be, is listed.
- A left-out file still counts among the newest 200 files looked at.
- A file left with only its header, as after a crash between two writes, is never listed.
- A session with an id of more than 200 characters, which only `--session-id` can give, is not listed.
- A session run on another machine, such as one of Kimchi's remote sessions, is not in these files.
- Something else called `kimchi` counts as Kimchi, and keeps sessions from showing as finished.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Kimchi installed to check:

1. That a session's file appears under `~/.config/kimchi/harness/sessions/` at its first prompt, on macOS, Linux and Windows, with the header as its first line.
2. That `ps -A -o comm=` shows `kimchi` for Kimchi from Homebrew, the install script and npm, on macOS and Linux, in the terminal and over ACP.
3. That a subagent's file and Ferment's evaluator's file have their marker as the second line, with the keys in the order above.
4. That `KIMCHI_CODING_AGENT_SESSION_DIR` moves a terminal session's file, and that ACP sessions stay in the default folder.
5. That a killed `kimchi` leaves the file as a quit does.

## What breaks when Kimchi changes

| Change in Kimchi                                                                        | What the dashboard shows                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| The agent folder moves from `~/.config/kimchi/harness`                                  | Kimchi is not found, or found with no sessions                                   |
| `piConfig.name` changes                                                                 | `KIMCHI_CODING_AGENT_SESSION_DIR` is the wrong name, and is followed for nothing |
| A marker is renamed, leaves the second line, or gets another object before `customType` | Those sessions are listed                                                        |
| A new kind of session of its own comes with a new marker                                | Those sessions are listed until the profile names it                             |
| Side chats move beside the session files                                                | They are listed                                                                  |
| Pi's session `version` goes above 3                                                     | Those sessions are left out, and the Sources view names a newer format           |
| `process.title` changes, or the release program is renamed                              | Sessions show as finished while Kimchi runs                                      |
| Kimchi starts to write a status or a pid                                                | Nothing changes until the adapter reads it, and sessions stay unknown            |

To check a new Kimchi version, read `package.json` for `piConfig` and the version of `@earendil-works/pi-coding-agent`, then `src/entry.ts`, `src/session-visibility.ts`, `src/extensions/agents/manager/session-file.ts`, `src/extensions/ferment-v2/evaluator.ts`, `src/extensions/side-chat/store.ts`, `src/extensions/session-name.ts`, `scripts/build-binary.js` and, in `src/modes/acp/server.ts`, `defaultSessionLoader`, and search for who else writes `INTERNAL_SESSION_ENTRY` or `SUBAGENT_SESSION_ENTRY`. For Pi's version, follow the list at the end of [the Pi notes](pi.md#what-breaks-when-pi-changes). Then update `UNCHECKED_NOTE` in `src/collector/adapters/kimchi/index.ts` and the first paragraphs here.
