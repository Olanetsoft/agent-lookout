# Droid adapter notes

These notes record what Agent Lookout reads from Droid, where each value comes from, and what breaks when Droid changes. When the adapter stops working, start here.

Written on 2026-11-18 from Factory's public material alone. Droid is Factory's coding agent, in its command `droid`. Its own program is not open source: Factory publishes no source for it, and its repository [Factory-AI/factory](https://github.com/Factory-AI/factory) holds its documentation, marked "Copyright © 2025-2026 Factory AI. All rights reserved." (`README.md:69-71` at commit `e6241cd`). So the `droid` program and its npm package were never downloaded, unpacked, read, disassembled or run to write these notes, and no real session or `~/.factory` folder was looked at. What is here comes from Factory's documentation, in that repository at commit `e6241cd` (2026-11-11), whose release notes stop at v0.179.0, months behind the live pages at docs.factory.com; from issues people opened on Factory-AI/factory, marked as such; and from Factory's two Droid SDKs, both under the Apache-2.0 licence: the Python `droid-sdk` 0.5.0 (commit `aa6fd94` of [Factory-AI/droid-sdk-python](https://github.com/Factory-AI/droid-sdk-python), `pyproject.toml:2-6`) and the TypeScript `@factory/droid-sdk` 0.11.0, whose code is published only as the compiled files of its npm package, with its examples at commit `a4103054` of [Factory-AI/droid-sdk-typescript](https://github.com/Factory-AI/droid-sdk-typescript). The TypeScript SDK says its `listSessions` mirrors the logic of the `droid` command's `SessionService`. Where the documentation and the SDKs disagree, the SDKs' code is taken. The fixtures are written by hand. **The adapter was built from Factory's documentation and its Droid SDKs, droid-sdk 0.5.0 and @factory/droid-sdk 0.11.0, and has not yet been checked on a computer running Droid.** The Sources view says so too.

The citations:

- `docs:path:line` is Factory-AI/factory at `e6241cd`, under `docs/`.
- `py:path:line` is the Python SDK at `aa6fd94`, where `discovery.py` stands for `src/droid_sdk/_high_level/discovery.py`.
- `ts:file, function` is the TypeScript SDK's npm files at 0.11.0, read on unpkg and named by file and function, not counted by line.
- `ts-repo:path:line` is Factory-AI/droid-sdk-typescript at `a4103054`.
- A user report is an issue someone opened on Factory-AI/factory. Each says what one person saw, not what Factory documents.

The code is in `src/collector/adapters/droid/`. `index.ts` builds the adapter, `sessionFile.ts` reads each session's first line, `settingsFile.ts` reads whether it is archived, and `toSession.ts` makes the session. It shares Pi's finder of session files, `src/collector/adapters/pi/sessionFiles.ts`, Pi's tests of which IDs are allowed and of a session's `cwd`, `SESSION_ID` and `folder` in `src/collector/adapters/pi/sessionFile.ts`, and Pi's question to `ps`, `src/collector/adapters/pi/processes.ts`. The status is given by `src/core/mapping/droid/droidMapping.ts`.

## What the issue said, and what holds

| What Agent Lookout issue #33 said                                                       | What Factory's material shows                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One JSONL file for each session in `~/.factory/sessions/`, in a folder for each project | True (`py:discovery.py:16-29`; `ts:node.js, getDefaultSessionsDir`). The hook examples name `~/.factory/projects` instead, as [Where Factory's material disagrees](#where-factorys-material-disagrees) says |
| The first line holds the title and the working folder                                   | True: a `session_start` line with `title` and `cwd` (`py:discovery.py:141-147`; `ts:chunk-KAAWCHO4.js, SessionStartEventSchema`)                                                                            |
| Nothing on disk marks a session as running or waiting                                   | True. Neither SDK reads a lock, a pid or a status, and no page documents one                                                                                                                                |
| The hooks `Notification`, `Stop`, `SessionStart` and `SessionEnd` could say more        | True (`docs:reference/hooks-reference.mdx:215-277`). Left to a later issue, as [A hook, later](#a-hook-later) says                                                                                          |
| Facts from Droid's "docs and source"                                                    | No source of Droid's own program is public. The facts come from the documentation and the two SDKs                                                                                                          |
| Not checked on a computer running Droid                                                 | Still true                                                                                                                                                                                                  |

## How it reads Droid, and why

It needs nothing installed and changes nothing. It reads the first line of each recent session file and `archivedAt` from the settings file beside it, read-only, and asks `ps` whether a `droid` program runs. It runs no Droid program, connects to no Droid daemon and makes no request to Droid or to Factory. CONTRIBUTING's fourth step asks for the files to be checked against a listing the vendor documents for outside tools, and this adapter does not do that.

Factory documents a way for other programs to list sessions: the SDKs' `listSessions` and `list_sessions`. Neither is used:

- The TypeScript SDK would add nine runtime dependencies (its npm entry at 0.11.0), and the Python one needs Python.
- Both read every line of every session file to count its messages (`py:discovery.py:137`; `ts:node.js, scanSessionFile`), and every line after the first is the conversation.
- Both read the whole settings file, with no cap (`py:discovery.py:152`; `ts:node.js, loadSettingsFile`).
- The `droid` command documents no list of sessions: `droid resume` opens a picker and `droid search` searches what was said (`docs:reference/cli-reference.mdx:95`, `:104`).

It is a small adapter of its own, not a profile of Pi's. Profiles are for a tool built from another's source that keeps the other's files, as Kimchi does. Droid's first line, its IDs, its project folders and its settings file all differ from Pi's.

## Where it looks

| Setting                    | Droid's sessions                                                             |
| -------------------------- | ---------------------------------------------------------------------------- |
| `AGENT_LOOKOUT_DROID_HOME` | `sessions` in that folder, for Agent Lookout alone                           |
| None                       | `~/.factory/sessions`, which on Windows is `%USERPROFILE%\.factory\sessions` |

Both SDKs take the home folder, so on Windows it is `%USERPROFILE%` (`py:discovery.py:16-17`; `ts:node.js, getDefaultSessionsDir`). Factory's settings page puts Droid's settings in `~/.factory`, and `%USERPROFILE%\.factory` on Windows (`docs:cli/configuration/settings.mdx:17-22`), and a user report (Factory-AI/factory issue #59) shows a Windows session at `%USERPROFILE%\.factory\sessions\<project>\<id>.jsonl`.

Not followed:

- `FACTORY_HOME_OVERRIDE`. No page of Factory's documentation names it. The Python SDK never reads it, and the TypeScript SDK reads it only for the path of an opt-in log of its own, never for its list of sessions (`ts:node.js, getFactoryHome` and `getDefaultSessionsDir`). Factory's own example runner drops it from the environment it starts examples in (`ts-repo:scripts/run-examples.test.mjs:100-118`), which suggests the command follows it, but that is not documented. Someone who uses it can set `AGENT_LOOKOUT_DROID_HOME` to the `.factory` folder it leads to.
- `FACTORY_PROJECT_DIR`, which is set only for a hook's command (`docs:reference/hooks-reference.mdx:121-125`).
- Any setting. None moves the sessions folder. `sessionRetentionDays` is an organisation's rule for "synced session history" (`docs:cli/configuration/settings.mdx:290`). Whether it removes files here is not checked.
- The `sessionsDir` option of the TypeScript SDK's `listSessions`, which moves only where its caller looks.
- A Droid process's arguments and environment, which are never read.

When the sessions folder is not there, Droid is reported as not found, with no advice, and looked for again once a minute, or on every poll when `AGENT_LOOKOUT_DROID_HOME` is set. When that setting names a folder with no `sessions`, that is an answer, not a missing Droid, and nothing else is read for Droid and `ps` is not asked for it.

## What it reads

| Path                                                                                     | How                                                                                                 | How often                                                                         |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The sessions folder                                                                      | Listed                                                                                              | Every poll, every 2 seconds                                                       |
| Each folder in it whose name starts with `-`                                             | One `lstat`, to see that it is a folder and not a link, and for its modified time                   | Every poll                                                                        |
| The same folder                                                                          | Listed                                                                                              | When its modified time moves, and once a minute                                   |
| Each `*.jsonl` in those folders or loose in the sessions folder, written in the last day | One `lstat`                                                                                         | Every poll, for the newest 200                                                    |
| Every other `*.jsonl`                                                                    | One `lstat`. Never opened                                                                           | Once a minute                                                                     |
| A session file whose name Droid gives                                                    | Opened read-only: its first 4 KiB, and only when the first line runs past them, up to 64 KiB in all | When its size, modified time or identity changes                                  |
| `<id>.settings.json` beside a file that shows a session                                  | One `lstat`. Opened read-only only when it is 16 KiB or less, reading at most 16 KiB and one byte   | The `lstat` every poll, the open when its size, modified time or identity changes |

A file is opened without following a link at its name and, in a project folder, only when that folder is a real folder: the folder is looked up again just before, and a file whose identity is not the one its `lstat` found is read again on the next poll. The sessions folder itself, or `~/.factory`, is followed if it is a link, as Pi's is, so a person who keeps Droid's folder on another disk through a link is still read. A project folder that is a link is not.

Never opened, and never looked up:

- `.favorites` and any other file in the sessions folder that is not a `*.jsonl` or the `<id>.settings.json` beside a file that shows a session.
- Anything else under `~/.factory`: `settings.json`, `settings.local.json` and `config.json`, which can hold API keys (`docs:cli/byok/overview.mdx:24-56`), `mcp.json`, `hooks.json` and hook scripts, `.ssh/` (`docs:cli/features/droid-computers.mdx:150-162`), `logs/` (`docs:integrations/ide-integrations.mdx:121`), `memories.md`, `AGENTS.md`, `droids/`, `skills/`, `commands/`, `rules/`, specs, worktrees and Missions files.
- Droid's tokens, in the system keyring or any file.
- No socket of Droid's daemon is connected to.

Factory does not say where the search index `droid search --reindex` rebuilds is kept (`docs:reference/cli-reference.mdx:413`), so it is item 10 below: it is never opened unless it is kept as an `<id>.jsonl` in the sessions folder or a `-` folder in it.

## The session file

The file is `<id>.jsonl`, in a project folder or, for older sessions, loose in the sessions folder (`py:discovery.py:59-84`; `ts:node.js, listSessions`). A project folder's name is `-` and the project's path, with each `/` or `\` as `-`, and on Windows the drive's colon dropped, so `C:\Users\you\code` is `-C-Users-you-code` (`py:discovery.py:20-29`). The Python SDK turns `\` into `-` on macOS and Linux too, and the TypeScript SDK turns each run of separators into one `-` (`ts:node.js, sanitizePathToDirectoryName`). A path's own `-` reads the same, so the name cannot be turned back into a path, and it is never decoded: the folder comes from the first line. Any name in the sessions folder that starts with `-` is taken for a project folder, `-` alone among them (`py:discovery.py:65`).

### The ID

The ID is the file's name without `.jsonl`, as both SDKs take it (`py:discovery.py:82`; `ts:node.js, collectCandidates`). The `sessionId` on the first line is never used. The name must be an ID as Pi allows one: letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit, at most 200 characters. A file with any other name, such as one with a space in it, is never opened, and the Sources view says a file is not a Droid session's. Droid's own IDs are lowercase UUIDs, as in the answer `droid exec` gives (`docs:cli/droid-exec/overview.mdx:255`), but Factory's examples also use IDs that are not, such as `session-abc123` and `session-123` (`docs:reference/cli-reference.mdx:96`, `:102`), and neither SDK checks the shape, so no UUID is required.

### The first line

Its first line is a `session_start` entry (`ts:chunk-KAAWCHO4.js, SessionStartEventSchema`), with `type`, an optional `sessionId`, `title`, an optional `owner` and `cwd`, and the Missions fields `decompSessionType` and `decompMissionId`. Factory's own test sets `owner` to an email address (`py:tests/test_v5_discovery.py:31`). A title is made from your first prompt, and a rename writes another (`ts-repo:examples/node/rename-session.ts:4-7`, `:33-38`).

- The line is read up to its first line break. It is turned into text and parsed only when it holds `"session_start"` as bytes, with its opening quote not escaped: JSON writes a `"` inside a string as `\"`, so that can only be a key or a value. A message line, which holds your prompts, is not turned into text.
- It must parse as a JSON object with `type` `session_start`, as both SDKs require (`py:discovery.py:138-142`).
- It must have a title, as both SDKs require of a session: a `title` that is text, even empty (`py:discovery.py:143-145`), or an older `sessionTitle` that is text other than spaces, which the TypeScript SDK takes in its place (`ts:chunk-KAAWCHO4.js, normalizeSessionStartEvent`). The Python SDK does not take `sessionTitle`. Neither is kept.
- `cwd` is kept when it is a full path, at most 4096 characters and with no control character, by the rules of the system Agent Lookout runs on. It is not resolved.
- Everything else, the title, `owner` and `sessionId` among it, is dropped with the parsed line. The TypeScript SDK also leaves out a session whose `cwd`, `owner` or `sessionId` is not text. The Python SDK keeps it, and so does this.

A first line longer than 64 KiB is not taken for a session's. Factory documents no size. The Python SDK says a custom system prompt "persists locally" and is sensitive (`py:README.md:208-210`), without saying where; if it were on the first line, the line could run past 64 KiB.

### After the first line

No byte after the first line break is turned into text, parsed, kept or logged. Agent Lookout only compares the open file's size with where the first line ends. A file with nothing after its first line is not listed until Droid writes more to it: Factory's app can leave such a file for a session that never had a prompt (user reports, Factory-AI/factory issues #1 and #22), as Goose and Pi make no file before the first message. The SDKs list such a file, with no messages.

The SDKs read past the first line only to count lines. This does not.

### A file that changes

A file is opened again whenever its size, modified time or identity changes, and only its first line is read again. A file that showed a session and is then found not to, as while Droid rewrites its first line on a rename, goes on showing it until the file holds still for a poll. Then what the file holds is shown, as for a file read for the first time. A file that cannot be opened or read shows what it showed and is tried again on the next poll.

## The settings file

Beside each session file is `<id>.settings.json` (`py:discovery.py:150`; `ts:node.js, loadSettingsFile`). It holds `archivedAt` once the session is archived (`ts:chunk-KAAWCHO4.js, SessionSettingsFileSchema`, where it is optional text), and also the session's tags, which you can write with `--tag` (`docs:reference/cli-reference.mdx:146`), its model and its token counts. Only `archivedAt` is needed.

- It is looked up only for a file that shows a session whose ID no newer file has given, once each poll.
- It is opened only when its size, modified time or identity changes and it is 16 KiB or less. At most 16 KiB and one byte are read, and a file that gives more than 16 KiB is not parsed.
- It is turned into text and parsed only when it looks whole, ending in `}`, and holds `"archivedAt"` as bytes.
- A session is archived when `archivedAt` is text that is not empty. Both SDKs hide such a session (`py:discovery.py:155`; `ts:node.js`, `if (settings?.archivedAt) return null`), the TypeScript SDK only when the whole file passes its schema (`ts:node.js, loadSettingsFile`; `ts:chunk-KAAWCHO4.js, SessionSettingsFileSchema`), so there `tags` that are not a list of tags leave it listed. This reads `archivedAt` alone, as the Python SDK does. The TypeScript SDK's schema takes only text, so a value of another kind, such as `true`, leaves the session shown here; the Python SDK would hide it.
- Only that yes or no is kept. The tags, the model, the counts and everything else are dropped with the parsed file.
- A settings file that is missing or not JSON leaves the session listed, as the SDKs leave it. One larger than 16 KiB or a link leaves it listed too, though both SDKs read the whole file and follow a link, and would hide an archived session in it.
- One caught half written, gone or not JSON shows what it showed until it holds still for a poll, so an archived session does not come back for a moment while Droid writes its file.

A user report (Factory-AI/factory issue #59) shows a settings file left after its `.jsonl` was gone. Such a file gives nothing.

## Which sessions are listed

Each session whose file was written in the last day, by its modified time, of the newest 200 files, but:

1. An archived session, as [The settings file](#the-settings-file) says.
2. A file whose first line is not a session's: without `"session_start"`, not of that type, without a title, or longer than 64 KiB. The Sources view says a file is not a Droid session's.
3. A file still being made, or with nothing after its first line, until Droid writes more. Nothing is said.
4. A file whose name is not one Droid gives. The Sources view says so.
5. A link, a pipe or a device at a file's name or a project folder's. The TypeScript SDK keeps a linked file, and the Python SDK follows links.
6. Files in a folder whose name does not start with `-`.
7. The older of two files with one ID, unless the newer is archived or shows no session. The newer is opened first, and the older is not opened at all once the newer is listed, as in the Python SDK (`py:discovery.py:92-103`). Of two written at the same moment, the one whose path sorts first is shown, which puts a project folder's before a loose file's, as the Python SDK's sort by path does (`py:discovery.py:89`).

Not left out: Missions workers, which both SDKs list; the sessions of every project, not only one folder's; and favourites, which are not marked, since `.favorites` is never read.

## Status

`mapDroidStatus` in `src/core/mapping/droid/droidMapping.ts`:

| A `droid` program runs                                                                                 | Status     |
| ------------------------------------------------------------------------------------------------------ | ---------- |
| Yes, or `ps` cannot say, as on Windows                                                                 | `unknown`  |
| No, by an answer asked 2 seconds or more after the last write to any session shown                     | `finished` |
| No, by an answer asked because the clock was set back, at or after the last write to any session shown | `finished` |
| No, by any other answer                                                                                | `unknown`  |

A session is never `working`, `idle`, `needs-you` or `failed`. A finished session's time is its file's last write.

- `ps` is asked only while a session is listed, at most every 10 seconds, and sooner, but not within 2 seconds of the last ask, when a session is written after `ps` said none runs, or up to 2 seconds before. A clock set back counts as time enough.
- An answer that no `droid` runs finishes every session only when it was asked 2 seconds or more after the last write to every session shown, as a disk can keep a write's time rounded down. A write nearer the answer says a `droid` may have started since `ps` looked. Until `ps` is asked again, every session shows as unknown, as while one runs. An answer asked because the clock was set back allows nothing for a rounded time: a write before it counts as before.
- The time a rule goes by is the open file's modified time when the file was opened on that poll and that is later than its `lstat`'s, else the `lstat`'s.
- The poll's basis is Pi's: `files`, `files-closed` while `ps` shows no `droid` and its answer tells, and `files-without-processes` while `ps` cannot say. Closing the last `droid` finishes every session at once, so it sends no Finished, even right after a write.

### The process

`ps -A -o comm=` through `runPs`, the name each process gives its program and nothing else. Each line's last part, after any `/`, is compared with `droid` and `droid-dev`, and the rest is dropped. Only whether one matched is kept.

- `droid` is the command on macOS and Linux, and `droid.exe` on Windows (`docs:reference/cli-reference.mdx:72`). The Python SDK starts `droid` (`py:src/droid_sdk/transport.py:78`), and so does the TypeScript SDK, or `droid-dev` when its caller asks for a development build (`ts:node.js, resolveDroidCommand`). Zed and JetBrains, set up by hand, start the full path of `droid` (`docs:integrations/zed.mdx:57-70`, `docs:integrations/jetbrains.mdx:59-73`).
- The match is exact: `/Applications/…/bin/droid` counts, and `Droid`, `android`, `droidx` and `fdroid` do not. Linux keeps 15 characters of a program's name, and both fit.
- Any program named `droid` or `droid-dev` counts, whatever it is, and can only keep sessions from showing as finished.

### Factory's app, the daemon and tunnels

`droid` runs for more than a session in a terminal:

- `droid daemon` runs Factory's daemon (`docs:reference/cli-reference.mdx:117`), and the terminal starts one of its own (`docs:changelog/release-notes.mdx:2558`).
- With Remote Access on, Factory's app keeps a connection open for as long as it runs (`docs:cli/features/droid-computers-byom.mdx:24`). User reports say the app runs `droid daemon` and `droid exec` (Factory-AI/factory issues #1 and #22).
- `droid computer ssh`, as an SSH `ProxyCommand`, and `droid computer port-forward` run as long as their tunnel does (`docs:cli/features/droid-computers.mdx:86-106`, `:150-168`).

So while any of them runs, every session shows as unknown, even one closed long ago.

### Why nothing shows as working or waiting

Nothing Droid writes to a session's files says what it is doing. The SDKs' lists have no status (`py:discovery.py:123-175`; `ts:node.js, listSessions`), and the daemon, which can list the open sessions, is asked with a Factory API key (`ts-repo:docs/typescript-sdk-reference.md:53`, `:913`). Droid's hooks could tell, as [A hook, later](#a-hook-later) says.

## Names

A session takes its folder's name, the last part of `cwd`, else `droid:<id>`. The title is never kept: Droid makes it from your first prompt, or you set it by renaming the session, and nothing on the first line says which. The `owner`, which can be your email address, and the tags are never kept. The project folder's own name is never decoded.

## Quiet for, tokens, Jump, Stop and Answer

None. A Droid session never shows as working, its token counts are in its settings file, of which only whether `archivedAt` is set is kept, its files name no process or terminal, and Agent Lookout makes no request to Droid. There is no last message either. When it started is not known: the first line has no time, and the SDKs take the file's creation time, which Agent Lookout does not read.

## On Windows

The files are read as on any system, from `%USERPROFILE%\.factory\sessions`, and `cwd` by Windows' rules. `ps` is not run, so every session shows as unknown until it leaves the list, and the way of reading is always `files-without-processes`. The card says so.

An Agent Lookout in WSL pointed at Windows' `.factory` runs `ps` in Linux, which cannot see `droid.exe`, so each session there shows as finished, except in the seconds after each write, when every session shows as unknown. A `C:\` folder is not a full path in Linux, so such a session is named `droid:<id>`.

## A hook, later

Droid documents hooks that could tell working, waiting and finished apart: `Notification` when it needs your permission or asks you a question, `Stop` when it has finished responding, and `SessionStart` and `SessionEnd` (`docs:reference/hooks-reference.mdx:215-277`). Using one needs a plugin of Agent Lookout's in Droid, which changes what Droid runs, and questions answered first, such as which session a hook's `session_id` names. That is a separate, opt-in change, in an issue of its own.

## Where Factory's material disagrees

- Every hook example gives `transcript_path` as `~/.factory/projects/…/<id>.jsonl` (`docs:reference/hooks-reference.mdx:305`, `:324`, `:345`, `:358`), while both SDKs read `~/.factory/sessions`. The SDKs' code is taken.
- Session IDs in the examples are UUIDs, `abc123` and `session-abc123`.
- The release notes in the repository stop at v0.179.0, months behind the live ones.

## Known gaps

- Every session is unknown while Factory's app, Droid's daemon or a tunnel runs.
- No session ever shows as working or as needing you, and finished is all or nothing.
- While a `droid` runs, as one does all day while Factory's app is open, and always on Windows, a session sends Ended when it leaves the list: a day after its last write, when you archive it, or when its file goes (a user report, Factory-AI/factory issue #59).
- A finished session's time is its file's last write, which a rename in the app moves.
- A session copied here from another computer, as a synced or pulled one may be (`docs:changelog/release-notes.mdx:215`, `:1292`), shows as finished once no `droid` runs here, unless its file keeps a time ahead of this computer's clock, which keeps every session unknown, as below.
- A session whose file is cut back to its first line for good leaves the list once the file holds still.
- When a session started is not known.
- `FACTORY_HOME_OVERRIDE` is not followed.
- A linked session file is not shown, though the TypeScript SDK lists it.
- An `archivedAt` that is not text, such as `true`, leaves the session shown.
- A settings file larger than 16 KiB, or a link, counts as not archived, though both SDKs read it.
- A settings file left half written shows as not archived once it holds still.
- Droid run under another name, as an SDK host can start it (`ts-repo:docs/typescript-sdk-reference.md:39-41`), or as `node`, is not seen by `ps`. While it writes, every session shows as unknown. A session that leaves the list then sends Ended only once a write or a `droid` next shows every session as unknown, or no session is listed, which can be a day later. Once no session has been written for 2 seconds, every session shows as finished, though it runs.
- Missions workers are listed.
- A session with only lines Droid's hooks add after its first line is listed (a user report, Factory-AI/factory issue #1).
- Favourites are not marked.
- A session file stamped ahead of this computer's clock, as after the clock is set back, on a network home folder whose clock runs ahead, or for a file copied or restored with its time kept, keeps every session unknown until `ps` is asked 2 seconds or more after that time, or after the clock is set back, at or after it. Until then, while no `droid` runs, `ps` is asked on every poll. Nothing limits how far ahead that time can be, so a file stamped years ahead keeps every session unknown until it is archived or its file goes.
- On Windows every session is unknown. In WSL pointed at Windows' folder, every session shows as finished, except in the seconds after each write, when every session shows as unknown.

## Not yet checked

Everything here is read from Factory's documentation and SDKs, so each of these is for a person with Droid installed to check:

1. What `ps -A -o comm=` shows for the command, the daemon, Factory's app and `droid.exe`, and for Droid set up through the Zed extension (`docs:integrations/zed.mdx:11`), JetBrains' ACP registry (`docs:integrations/jetbrains.mdx:23-26`), VS Code's install (`docs:integrations/ide-integrations.mdx:38-42`) and npm (`docs:integrations/ide-integrations.mdx:115`, `docs:reference/cli-reference.mdx:42-43`).
2. Whether the command follows `FACTORY_HOME_OVERRIDE`.
3. How long real first lines and settings files are.
4. Whether a first line can be written without its line break.
5. Whether a rename or a settings write replaces the file at once.
6. Whether archiving touches the `.jsonl`.
7. Where subagent and Missions sessions are kept.
8. Whether sessions pulled from the cloud are written to `~/.factory/sessions` (`docs:changelog/release-notes.mdx:1292`).
9. Whether the custom system prompt is on the first line.
10. Where the keyring's fallback file and the search index are.
11. What a crash leaves, and whether a daemon outlives a terminal that crashed.
12. Whether Agent Lookout's brief read of a file on Windows can make Droid's save of it fail (a user report, Factory-AI/factory issue #59).

## What breaks when Droid changes

| Change in Droid                                                               | What the dashboard shows                                                                                                |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The sessions folder moves from `~/.factory/sessions`                          | Droid is not found, or found with no sessions                                                                           |
| The first line's type is renamed, or the title made optional                  | Sessions are not listed, and the Sources view says so                                                                   |
| The ID stops being the file's name without `.jsonl`                           | Sessions are listed by the file's name, or not at all                                                                   |
| `archivedAt` is renamed                                                       | Archived sessions are listed                                                                                            |
| The program is renamed, or runs as `node`                                     | Sessions show as finished while Droid runs, except in the seconds after each write, when every session shows as unknown |
| Droid starts to write a status or a pid                                       | Nothing changes until the adapter reads it, and sessions stay unknown                                                   |
| The first line grows past 64 KiB, as a long system prompt on it would make it | Sessions are not listed, and the Sources view says so                                                                   |

To check a new Droid, read the Python SDK's `src/droid_sdk/_high_level/discovery.py` and `src/droid_sdk/transport.py`, the TypeScript SDK's `listSessions`, `loadSettingsFile`, `SessionStartEventSchema`, `normalizeSessionStartEvent`, `SessionSettingsFileSchema` and `resolveDroidCommand`, and Factory's CLI reference and hooks reference. Then update `UNCHECKED_NOTE` in `src/collector/adapters/droid/index.ts` and the first paragraphs here.
