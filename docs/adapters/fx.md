# fx adapter notes

These notes record what Agent Lookout reads from fx, where each value comes from, and what breaks when fx changes. When the adapter stops working, start here.

Written on 2026-11-17 from fx's source at `v0.0.17`, released 2026-11-14 (commit `d1d4a88` of [vercel-labs/fx](https://github.com/vercel-labs/fx)), the newest release then. fx is Vercel Labs' coding agent, one program built from Zig, under the Apache-2.0 licence. It was not installed or run to write these notes, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from fx's source at v0.0.17 and has not yet been checked on a computer running fx.** The Sources view says so too.

Each citation is `path:line` at `v0.0.17`. A path with no folder in front of it is in `src/core/session_manager/`. `README.md`, `CHANGELOG.md`, `build.zig` and `tests/` are at the top of fx's repository, and every other path is in `src/`. The lines were counted on the raw files.

The code is in `src/collector/adapters/fx/`. `index.ts` builds the adapter. `paths.ts` works out the folders, `logFiles.ts` finds the logs, `logFile.ts` reads them and keeps what it read, `logLines.ts` judges each line as bytes, `processes.ts` asks `ps` which fx programs run, and `toSession.ts` makes the session. The status mapping is `src/core/mapping/fx/fxMapping.ts`.

## What the issue said, and what holds

Issue #75 was first written from fx's older session files, and rewritten from fx's source at v0.0.17 before this was built.

| What issue #75 said                                                                             | What the source shows                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Since 0.0.15 every session is in `~/.fx/sessions/v2/<id>/log.jsonl`, on macOS and Linux         | True (`CHANGELOG.md:332`, under 0.0.15; `core/session/session_adapter.zig:188`; `core/session/session_layout.zig:18`; `README.md:42`; `api.zig:77`)                                                                |
| `session.json`, `events.jsonl`, `owner.live` and `recovery.json` are no longer written          | True: they are the older store's, which fx converts when a session is opened and no longer writes (`CHANGELOG.md:332`). None is read                                                                               |
| `FX_HOME` moves `~/.fx`                                                                         | True, from 0.0.17 (`CHANGELOG.md:36`; `core/shared/profile_paths.zig:40-47`), as [Where it looks](#where-it-looks) says                                                                                            |
| Each line is `{"v":1,"seq":N,"ts":MS,"kind":…,…,"crc":"<8 hex>"}`                               | True (`schema.zig:1-7`, `:51-58`; `log.zig:26-28`), as [The log](#the-log) says                                                                                                                                    |
| While a turn runs fx writes `turn_started` and each finished piece as an `item`                 | True: each finished piece reaches the log before the next request (`core/agent/runtime/orchestrator.zig:4374-4375`). With the gateway, fx's default, a turn is on disk before its first request too (`:8827-8851`) |
| A turn ends with `turn_committed` or `turn_interrupted` (`cancel`, `failed`, `closed`, `crash`) | True (`schema.zig:99`; `core/session/session_adapter.zig:2129-2134`; `session.zig:936-941`, `:1406-1407`)                                                                                                          |
| The only sign a session is open is a lock on `<id>/lock`, which is never touched                | True (`storage.zig:291-296`; `tests/tla/session/LiveSessions.tla:6-15`). It is never opened, taken or tried                                                                                                        |
| Approvals and questions stay in fx's memory                                                     | True of what was read: nothing in `core/app/input_approval_runtime.zig` writes to a session's log                                                                                                                  |
| The title is often the first line of your prompt                                                | True (`core/session/session_display_metadata.zig:40-65`; `core/session/session_adapter.zig:2142-2150`). A model's title and a rename are written the same way (`:2845-2852`, `:2856-2876`), so no title is read    |

## How it reads fx, and why

It needs nothing installed and changes nothing. It reads each recent session's log, read-only, and asks `ps` which fx programs run. It runs no program of fx's and makes no request to it.

fx has a list of open sessions of its own, `fx sessions --live` (`CHANGELOG.md:20`). It is not run. For each saved session it tries the session's lock (`core/session/session_adapter.zig:653-679`; `api.zig:460-466`; `session.zig:2266-2279`), and fx's own model of it says that try can make an fx that opens the session at that moment, with no wait, fail (`tests/tla/session/LiveSessions.tla:17-25`). Its listing can also write to fx's index, marking a session whose folder has gone (`catalog.zig:349`, `:585-596`). So Agent Lookout reads fx's files alone, and the Sources view says why.

## Where it looks

The first of these that applies is used:

| Setting                 | fx's folder                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `AGENT_LOOKOUT_FX_HOME` | That folder, for Agent Lookout alone. Sessions are in its `sessions/v2` |
| `FX_HOME`               | That folder, taken as fx takes it, below                                |
| None                    | `~/.fx` (`core/shared/profile_paths.zig:5`)                             |

fx takes `FX_HOME` as it is given (`core/shared/profile_paths.zig:40-47`; `main.zig:3914-3923`):

- An empty value is not set.
- It must be absolute. `~` is not taken for the home folder.
- Any `/` at its end is left off. Nothing left is `/`, which fx refuses.
- It may not be the folder `HOME` names, with any `/` at its end left off. With `HOME` unset, that is not checked.

For a value fx refuses, fx stops before it reads or writes anything there, so Agent Lookout reads `~/.fx` instead, and loses nothing. Agent Lookout reads `HOME` only for this.

fx opens the folder that holds its own, then its own by name (`core/shared/profile_paths.zig:102-115`), so the system follows a link before it applies a `..`. Node joins paths by their letters, which would apply the `..` first and read another folder. So an `FX_HOME` with a `.` or `..` in it is not followed: the Sources view says so, and nothing of fx's is read. `AGENT_LOOKOUT_FX_HOME` can name the folder instead.

**Real folders.** fx refuses to keep sessions in a `.fx`, the last folder of `FX_HOME`, `sessions` or `v2` that is a link or not a folder (`core/session/session_adapter.zig:199-218`). On every poll, Agent Lookout looks at each of those three with `lstat`. When one is a link or not a folder it reads nothing, says so, and looks again once a minute.

When the folder is missing, fx is reported as not found, with no advice, and the folder is looked for again once a minute, or on every poll when `AGENT_LOOKOUT_FX_HOME` is set. When `AGENT_LOOKOUT_FX_HOME` names a folder with no sessions in it, that is an answer, not a missing fx.

## What it reads

The v2 store holds `index.jsonl`, `index.lock`, `.tmp/`, `.trash/` and a folder for each session, `<id>/`, with `log.jsonl`, an empty `lock` and `blobs/` in it (`tests/tla/session_manager/system-design.md:159-171`; `session.zig:549-571`).

| Path                                  | How                                                           | How often                                                                                      |
| ------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| fx's folder, `sessions` and `v2`      | One `lstat` each, to see that each is a folder and not a link | Every poll, and while missing once a minute, or every poll when `AGENT_LOOKOUT_FX_HOME` is set |
| `v2`                                  | Listed. Only a name fx gives a session's folder is taken      | When its modified time moves, and once a minute                                                |
| Each session's folder, `<id>/`        | One `lstat`, to see that it is a folder and not a link        | Every poll, for the logs written in the last day, the newest 200                               |
| Its `log.jsonl`                       | One `lstat`                                                   | The same                                                                                       |
| Every other `log.jsonl`               | One `lstat`. Never opened                                     | Once a minute                                                                                  |
| A `log.jsonl` written in the last day | Opened read-only, without following a link, as below          | When its size, modified time or identity changes                                               |

fx renames a session's folder into `v2` once its first line is on disk, and out to `.trash/` when it is deleted (`session.zig:541-578`, `:2218-2241`). Adding to a log does not move `v2`'s time, so a log is looked up on its own on every poll.

A name fx gives a session's folder is 1 to 255 of `A-Z`, `a-z`, `0-9`, `.`, `_` and `-`, not starting with `.`, and not `index.jsonl` or `index.lock` (`validId`, `schema.zig:572-579`). Pi's finder takes every name that ends in `.jsonl`, which here would be the index, so fx has a finder of its own.

Of a log it reads at most:

- its first 16 KiB, at position 0, once for each file, for its first line;
- its end, backwards, in pieces of at most 64 KiB, fx's own block size (`log.zig:24`), at most 8 MiB in all, from the newest whole line to the newest that says how the last turn stands;
- after that, what was added, in one read from the byte before it, of at most 8 MiB and one byte. A file that shrank, that is another file, whose byte before is not a newline, that grew by more than 8 MiB, or whose first new line's `seq` is not the next, is read from its end again.

Bytes after the last newline are a line fx is still writing, and are passed over.

Never opened, listed or locked: `index.jsonl`, which holds every session's title, `index.lock`, a session's `lock`, its `blobs/`, `.tmp/` and `.trash/`; the older store's `sessions/<id>/` folders and `sessions/trash+v1`; `terminal/`, `session-files/` and `hosts/`; and fx's sign-in and key files `auth.json`, `chatgpt-auth.json`, `grok-auth.json`, `api-key` and `mcp-credentials/`, its `settings.json`, `mcp.json`, `history.jsonl`, `backups/`, `logs/`, `recordings/`, `skills/` and `agents/` (`core/shared/profile_paths.zig:5-27`). Nothing is written, no lock is taken or tried, and no fx program is run.

## The log

fx only adds to a log, a batch of whole lines at a time, with one write at its end (`session.zig:752-757`; `log.zig:326-341`). It cuts a line it never finished when it next opens the log to write, and it never rewrites or renames a log (`log.zig:150-156`, `:285-310`).

### Each line

Every line is one JSON object, with this header first, always in this order, with no space and no leading zero, and `v` and `seq` at least 1 (`schema.zig:1-7`, `:51-90`, `:635-647`):

```
{"v":1,"seq":7,"ts":1727400000000,"kind":"turn_committed"
```

Then come the fields of its kind, then `,"crc":"`, 8 lowercase hex digits and `"}` with the newline. The digits are CRC32C (Castagnoli, polynomial 0x82F63B78, reflected) of every byte before `,"crc":"` (`log.zig:26-57`, `:99-128`). A line is 19 bytes to 4 MiB, newline included (`log.zig:21`, `:28`).

A line counts only when its length, its frame, its checksum and its header all pass, a `,` or nothing follows the header, and its `seq` is one more than the line before it, as fx's own reader judges it (`log.zig:108-128`, `:150-215`). Agent Lookout computes the checksum itself, and a test holds it to fx's own check value, `crc32c("123456789") = 0xe3069283` (`log.zig:675`). A bad last line with nothing after it is one fx was writing, which fx cuts on its next open for writing: it is passed over until it is whole. Any other bad line, or a gap in `seq`, fx takes as damage, and Agent Lookout shows the session as unknown.

`v` above 1 is a newer fx's (`schema.zig:11-13`). fx's 11 kinds are `session_created`, `turn_started`, `item`, `compacted`, `turn_committed`, `turn_interrupted`, `set`, `child_spawned`, `child_finished`, `snapshot` and `closed` (`schema.zig:17-29`).

Text cannot make a line of its own: every line is checked from its start, fx writes a line break in a string as `\n` (`schema.zig:541-565`), and a piece of a line fails the checksum.

### The first line

The first line is `session_created`, with `seq` 1, and these fields, in this order (`schema.zig:177-189`):

| Field         | Read                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `id`          | Compared as bytes with the folder's name. Another id, and the session is not listed |
| `workspace`   | The session's folder: the one part of any line turned into text, as below           |
| `role`        | `root` or `child`. A child is a subagent's session, which is not listed             |
| `host`        | `app`, `ask`, `acp`, `sdk` or `child`. Checked as bytes and dropped                 |
| `parent`      | A child's parent, when there is one. Checked as bytes and dropped                   |
| `forked_from` | A fork's source, `{"id":…,"seq":S}`, when there is one. Only `S` is kept            |

`workspace` is scanned as a JSON string, as bytes, and decoded once, with `JSON.parse`. It becomes the session's folder only when it is not empty, at most 4096 characters, has no control character and is absolute, as for every agent. Otherwise the session has no folder, and takes its id for its name. A later `set` line for `workspace` is never decoded.

A first line with `v` above 1, or with a field fx 0.0.17 does not write, is a newer fx's: the session is not listed, and the Sources view says so. Any other first line that does not match is not listed either.

fx writes the first line with the held settings and the first batch of the first turn in one write, then syncs, takes the lock and renames the folder into place (`session.zig:503-521`, `:546-578`). So a session's folder is never seen with its first line alone, but for a fork from before its source's first turn.

### Turn lines

| Kind               | Fields after the header, compared as bytes                             | What it says                         |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------ |
| `turn_started`     | exactly `,"turn":<n>`                                                  | A turn is open                       |
| `item`             | not looked at: the header is enough                                    | A turn is open                       |
| `turn_committed`   | exactly `,"turn":<n>`                                                  | The turn ended, not failed           |
| `turn_interrupted` | exactly `,"turn":<n>,"reason":"cancel"`, `failed`, `closed` or `crash` | The turn ended, failed when `failed` |
| `closed`           | nothing                                                                | fx let the session go                |

fx refuses an `item` outside an open turn, a `turn_started` while one is open, and a turn's end with no open turn (`fold.zig:287-315`), so an `item` proves an open turn. A turn line of any other shape, `session_created` after the first line, or a kind fx 0.0.17 does not write, makes the session unknown.

### Everything else

`set`, `snapshot`, `compacted`, `child_spawned` and `child_finished` lines are judged by their header alone and passed over. An `item`'s `data` holds your prompts, the replies, the tools' arguments and their output, a `set` line's `value` holds titles and settings, and a snapshot holds all of them. None of it is turned into text, parsed, kept or logged.

### Forks

A fork is a new session whose first line is new, written when the fork is made, and whose lines 2 to `S` are the source's, copied byte for byte with their `seq` and `ts`, where `S` ends a turn of the source or comes before its first (`session.zig:1737-1740`, `:1795`, `:1823-1832`, `:2106-2165`). A line whose `seq` is `S` or less is the source's, so it says nothing of the fork's own turns: reading backwards stops there, with no turn yet.

## Which sessions are listed

Each session whose log was written in the last 24 hours, by its modified time, the newest 200, and whose newest `ts` read, the first line's included, is in the last 24 hours too. The second rule leaves out a session converted from the older store long ago: its first line keeps that session's time, and its other lines the newest of its times (`core/session/session_adapter.zig:4298`), though the log was written now. A fork's first line is new, so a fork of an old session is listed.

A subagent's session is its own folder in `v2`, with `role` `child` in its first line (`core/session/session_adapter.zig:1765`). fx's own lists show roots only (`catalog.zig:600-604`; `core/session/session_adapter.zig:666`), and so does Agent Lookout: of a child, only its first line is read, once, and it is looked at again only at the sweep, once a minute, and read again only when its log is another file.

## Status

`mapFxStatus` in `src/core/mapping/fx/fxMapping.ts`. The rows are taken in order:

| Row | Last turn                  | fx programs                                       | Status     |
| --- | -------------------------- | ------------------------------------------------- | ---------- |
| 1   | Cannot be read             | Any                                               | `unknown`  |
| 2   | Ended as failed            | Any                                               | `failed`   |
| 3   | Open, ended or none        | `ps` cannot say                                   | `unknown`  |
| 4   | Open, ended or none        | None                                              | `finished` |
| 5   | Ended, not failed, or none | Some                                              | `unknown`  |
| 6   | Open                       | Some, each missing from an answer after the write | `finished` |
| 7   | Open                       | Some, quiet for 30 minutes, or written ahead      | `unknown`  |
| 8   | Open                       | Some                                              | `working`  |

The last turn is read from the log's end backwards: the newest `item` or `turn_started` says open, the newest `turn_committed` or `turn_interrupted` says ended, and reaching the first line, or the lines a fork copied, says none. A `closed` before an open turn is passed over, since fx writes it as it lets a session go, after the turn's end (`session.zig:893-956`). After the first read, each line added is folded in the same way, so a log read in two parts says what it says when read whole.

- **Row 2.** fx writes a failed turn as `turn_interrupted` with `failed` (`core/session/session_adapter.zig:2129-2134`), and a failure stands whether fx runs or not.
- **Row 4.** fx's lock is the only sign a session is open, and the system lets it go when fx's process ends, however it ends (`storage.zig:291-296`; `tests/tla/session/LiveSessions.tla:6-15`). With no fx program, no session is held.
- **Row 5.** A resume writes nothing unless it has something to repair (`session.zig:1401-1448`), and only fx's index records it (`api.zig:319-321`, `:626-645`). So a session fx holds between turns looks on disk as one it has let go.
- **Row 6.** A running fx that was missing from a `ps` answer taken after the log's last write did not make that write. An fx that opened the log for writing since would have repaired it first, writing `turn_interrupted` with `crash` (`session.zig:1177-1201`, `:1401-1407`), which moves the write.
- **Row 7.** fx sets no time limit on a command (`core/execution/command_runner.zig:36`), so a turn can be quiet for long. A turn a crash cut off, while another fx runs, would look open for good, so a working session quiet for 30 minutes shows as unknown, as does one written further ahead of the clock than a minute.
- **Row 8.** fx writes each finished piece before the next request (`core/agent/runtime/orchestrator.zig:4374-4375`).

A converted session's unended turn is converted as `turn_interrupted` with `failed` (`core/session/session_adapter.zig:2502`).

The poll's basis is `files` while `ps` lists an fx program, `files-closed` while it lists none, and `files-without-processes` while it cannot say.

A session's last write is its log's modified time. A finished session's status time is that write, and a failed one's is the time on the line that ended its turn. Neither is kept when it is more than 2 seconds before the session's start.

### The process, and the other program named fx

The program is built as `fx` (`build.zig:73`), and the installer puts it in `~/.local/bin` (`README.md:42`). `ps -A -o pid=,comm=` prints each process's ID and the name it gives its program, and nothing else. A line whose program is `fx`, or a path ending in `/fx`, counts, and only its ID is kept, in memory. A line that names `fx` without an ID that can be read counts too, and keeps every session from finishing by row 6. `ps` is asked while a session is listed, at most every 10 seconds, and sooner, though not within 2 seconds of the last ask, when a log is written after `ps` listed no fx.

For row 6, each fx process ID is kept with the time of the answer before the one that first listed it, when it was missing. A clock set back drops every such time. The rule holds on macOS and Linux alike, and needs no start time from `ps`.

Another program can be named `fx`, such as the JSON viewer of that name. While one runs, a session between turns stays unknown, by row 5. It can never make a session idle or needing you, keep a turn working past 30 quiet minutes, or keep a turn working once it was missing from an answer taken after that turn's last write.

### A crash

A crash writes nothing. The next time fx opens that session to write, it first writes `turn_interrupted` with `crash`, at that time (`session.zig:1401-1407`). Until then the log shows an open turn: finished once no fx runs, or once every fx running started after the last write, and otherwise working for up to 30 quiet minutes and then unknown. `crash` is not a failure, so once fx writes it the session is finished or unknown.

### Thirty quiet minutes

The same 30 minutes keep the Mac awake for a working session (`KEEP_AWAKE_WORKING_MS`). A turn quiet for that long, as while fx waits for your approval, or while one command runs, shows as unknown until fx writes again.

### Why nothing shows as waiting or idle

fx keeps a pending approval or question in memory (`core/app/input_approval_runtime.zig`), and tells a terminal multiplexer it is blocked over that program's own socket only (`builtins/hooks/herdr.zig:1-4`). A question is an ordinary tool call inside an open turn. So a session waiting for you shows as working, and then as unknown. Between turns fx writes nothing, so idle never shows.

## Names

A session takes its folder's name, else its id. fx names a session from the first line of your first prompt, cut to 8 words or 240 bytes (`core/session/session_display_metadata.zig:12-13`, `:40-65`; `core/session/session_adapter.zig:2142-2150`). A title its model writes, and a rename you make, are written as the same `set title` line (`core/session/session_adapter.zig:2845-2852`, `:2856-2876`), and nothing tells them apart. So no title is read, from the log or from `index.jsonl`.

## Quiet for, tokens, Jump, Stop and Answer

- **Quiet for** is the time since the log was last written, its modified time, for up to 30 minutes.
- **Tokens:** fx keeps a session's running totals in a `set` line, not a reply's counts, and it is not read.
- **Jump and Stop:** the log names no process or terminal.
- **Answer:** Agent Lookout makes no request to fx, and fx keeps its approvals in memory.

There is no last message either.

## On Windows

fx runs on macOS and Linux only (`README.md:42`), and its storage is for those systems alone (`api.zig:77`). On Windows, and on any other system, the adapter reads nothing and runs nothing, and the Sources view says so.

## Known gaps

- fx run through Node, as its library libfx is, writes the same store (`acp/server.zig:1007-1012`) and shows in `ps` as `node`, not `fx`. Its sessions show as finished while it runs.
- A subagent can still work after its parent's turn ends (`core/app/app_agents_runtime.zig:1478-1483`), and the parent shows its own last turn, not the subagent's work.
- A parent waiting on a subagent for more than 30 minutes, writing nothing, shows as unknown.
- With a provider other than the gateway, a new turn reaches the log only with its first reply (`core/agent/runtime/orchestrator.zig:8849-8851`). Until then a session shows what the last turn left: unknown after a commit or a cancel, and failed after a failure.
- A session reopened between turns shows as unknown while fx runs.
- An `FX_HOME` set in your shell but not in Agent Lookout's environment is not followed. Start Agent Lookout with the same `FX_HOME`, or `AGENT_LOOKOUT_FX_HOME`.
- An `FX_HOME` with a `.` or `..` in it shows fx as unavailable.
- A damaged log shows as unknown. fx never repairs one: it refuses to open it for writing (`session.zig:1249-1259`).
- For up to 2 seconds after an fx starts, a session can show as finished.
- A turn a crash cut off that Agent Lookout first sees while another fx runs, as after Agent Lookout starts, shows as working for up to 30 minutes and then as unknown.
- With two fx programs, one of which left a turn open, the same.
- A converted session with an unended turn, written in the last day, shows as failed.

## Not yet checked

Everything here is read from the source, so each of these is for a person with fx installed to check:

1. What `ps -A -o pid=,comm=` prints for fx on macOS and Linux, and for its helpers. On Linux some helpers start again from `/proc/self/exe` (`core/shared/self_exe.zig:8-20`).
2. What closing the terminal window, or a signal, leaves in the log. `CHANGELOG.md:30` says a reopen sends again a request a crash or a closed window cut off.
3. What a paused turn, and a turn a subagent yields, leave on disk.
4. Whether a helper or a terminal launcher named `fx` outlives an fx that was killed.
5. Which folders libfx is given in practice.
6. The log's format at 0.0.15 and 0.0.16.
7. That Zig's path joining leaves a `..` for the system, as this assumes.

## What breaks when fx changes

| Change in fx                                                  | What the dashboard shows                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| The header, the frame, the checksum or the `seq` rule changes | Sessions show as unknown, or are not listed                                      |
| A new kind, a higher `v`, or a turn line of another shape     | Those sessions show as unknown, or are not listed, and the Sources view says why |
| A new reason for `turn_interrupted`                           | Those sessions show as unknown                                                   |
| `sessions/v2`, the `FX_HOME` rules or the rule for ids change | fx is not found, or found with no sessions                                       |
| `forked_from`'s `seq` comes to mean another line              | A fork shows its source's last turn                                              |
| A writable open stops writing `crash` first                   | Row 6 can show a turn a running fx is still in as finished                       |
| The program is renamed                                        | Sessions show as finished while fx runs                                          |
| fx writes a file that says a session is open                  | Nothing changes until the adapter reads it. It could show idle then              |

To check a new fx version, read `src/core/session_manager/schema.zig`, `log.zig`, `session.zig` and `fold.zig`, `src/core/shared/profile_paths.zig`, `useFxHomeFromEnv` in `src/main.zig`, and in `src/core/session/session_adapter.zig` `checkSessionsPath`, `commitTurn` and `listLive`, then the CHANGELOG. Then update `UNCHECKED_NOTE` in `src/collector/adapters/fx/index.ts` and the first paragraphs here.
