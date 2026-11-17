# Prime Agent adapter notes

These notes record what Agent Lookout reads from Prime Agent, where each value comes from, and what breaks when Prime Agent changes. When the adapter stops working, start here.

Written on 2026-11-17 from Prime Agent's source at `v0.10.3`, committed 2026-11-12 (commit `efb25e2` of [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)), the newest release then. Prime Agent is under the MIT licence (`LICENSE`), and is a Rust port of Prime Agent's TypeScript product, whose last release was `v0.9.8`. It was not installed or run to write these notes, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from Prime Agent's source at v0.10.3 and has not yet been checked on a computer running Prime Agent.** The Sources view says so too.

Each citation is `path:line` at `v0.10.3`. A path with no crate in front of it is in `crates/pa-daemon/src/`. The lines were counted on the raw files.

The code is in `src/collector/adapters/prime-agent/`. `index.ts` holds the profile and builds the adapter: the Pi adapter's body, `createPiFamilyAdapter` in `src/collector/adapters/pi/index.ts`, with `PRIME_AGENT_PROFILE` and a reader of status of its own, `status.ts`. That reads the leases (`leases.ts`), checks their processes (`holders.ts`) and reads the workers' journals (`journals.ts`), listing their folders with `folders.ts`. The status mapping is `src/core/mapping/prime-agent/primeAgentMapping.ts`. What [the Pi notes](pi.md) say of a session file holds here unless this page says otherwise, and a change to those modules changes Prime Agent too.

## What the issue said, and what holds

Issue #74 was written from Prime Agent's source, and corrected from these notes.

| What issue #74 said                                                                         | What the source shows                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions are `~/.prime/agent/sessions/<uuidv7>.jsonl`, on macOS, Linux and Windows          | True (`paths.rs:11`, `:48-66`; `session_store/read.rs:13-20`). The Windows build is `prime-agent.exe` (`install-rust.sh:798-804`)                                                                     |
| `PRIME_AGENT_CODING_AGENT_DIR`, `PRIME_AGENT_SESSION_DIR` or the older name move the folder | True (`paths.rs:9-10`; `crates/pa-cli/src/config.rs:43`, `:128-134`). `--session-dir` and the `sessionDir` setting can move it too (`crates/pa-cli/src/lib.rs:245-252`), and are not followed         |
| Lines are added, and a file is sometimes rewritten by a rename                              | True. A file with a new identity at a name is read from its start, as for Pi                                                                                                                          |
| The header, with optional `parentSession`, `rlmDepth` and `git`                             | True (`crates/pa-types/src/session.rs:26-50`). Only `id`, `timestamp`, `cwd` and `version` are read                                                                                                   |
| `session_info` holds a name you or the model gave                                           | True, as [Names](#names) says                                                                                                                                                                         |
| `session-leases/<hash>.lock/owner.json` names the process, its start and its worker         | True (`lease.rs:16-28`, `:98-108`, `:513-523`)                                                                                                                                                        |
| A worker's record holds its token beside its socket, and should never be opened             | True (`supervisor/worker_lifecycle.rs:326`, `:334`; `descriptor.rs:66-69`). It can hold an API key and prompts too (`supervisor/worker_lifecycle.rs:266-268`, `:274-296`). It is never opened         |
| The journal's `busy` is true on every create, so working comes from the step names          | True (`worker/create.rs:654`; `worker/summary.rs:169-185`)                                                                                                                                            |
| The journal's queue lines hold queued message text                                          | True (`journal.rs:214-238`, `:263-275`). Only their start and end are read, as [The recovery journal](#the-recovery-journal) says                                                                     |
| `rlm.spawn` children live under `session-artifacts/`; `rlm.create_session` ones in sessions | True (`crates/pa-core/src/session_engine/rlm_host.rs:325-336`; `rlm_children/host.rs:350-352`)                                                                                                        |
| Automatic archiving was removed in 0.10.1                                                   | True (`CHANGELOG.md:179`)                                                                                                                                                                             |
| Prime Agent asks nothing mid-turn                                                           | True of what was read: its one tool is Python (`crates/pa-core/src/tools/ipython.rs:635`), and its roster knows Running, Idle and Inactive alone (`crates/pa-types/src/daemon/agent_roster.rs:13-17`) |

## How it reads Prime Agent, and why

As for Pi: it needs nothing installed and changes nothing. It reads the first line and the name lines of each recent session file, read-only. It runs no program of Prime Agent's, takes no lease, and connects to none of Prime Agent's sockets. Unlike Pi, Prime Agent writes down which process has each session open, and what that process's worker is doing, so a session's status comes from those files and not from whether any `prime-agent` runs.

A process that opens a session takes its **lease** first, `session-leases/<SHA-256 of the file's path>.lock` (`lease.rs:98-108`), a daemon worker before it opens or makes the file (`worker/create.rs:222-227`, `:324-333`, `:363-372`), and gives it up when it closes the session. The lease names the process and the worker's ID. A daemon worker's ID names its **recovery journal** (`supervisor/worker_lifecycle.rs:246`, `:317-320`), and is the ID it writes into its leases (`supervisor/worker_lifecycle.rs:336`; `descriptor.rs:75-81`; `lease.rs:518`). So the lease leads to the one journal that says what the session's worker is doing, and nothing has to be guessed from the journals of other workers.

**Why a worker's record is never opened.** Beside each journal, the daemon keeps a record of the worker, `<worker ID>.json` (`supervisor/worker_lifecycle.rs:359`). It holds `authenticationToken` next to `socketPath` (`:326`, `:334`): a connection to that socket that sends that token is taken as the worker's supervisor (`worker/connection.rs:589-647`, `:649-690`). It can also hold an API key, system prompts and environment variables (`supervisor/worker_lifecycle.rs:249-316`). The record's fields cannot be picked out safely as bytes, since its `createCommand` holds nested text whose keys can repeat, so it would have to be parsed whole, with the token in memory. The lease and the journal say everything the record would, so the record is never opened. The lease's own `token` is a different one, which Prime Agent compares only when it gives the lease up (`lease.rs:370-377`), and which controls nothing. It is dropped with the parsed lease.

## Where it looks

The first of these that is set is used, and an empty one counts as unset:

| Setting                                | Sessions folder                                                   |
| -------------------------------------- | ----------------------------------------------------------------- |
| `AGENT_LOOKOUT_PRIME_AGENT_HOME`       | `<folder>/sessions`, for Agent Lookout alone                      |
| `PRIME_AGENT_SESSION_DIR`              | That folder, with the files directly in it (`paths.rs:10`, `:61`) |
| `PRIME_AGENT_CODING_AGENT_SESSION_DIR` | The same, the older name (`crates/pa-cli/src/config.rs:43`)       |
| `PRIME_AGENT_CODING_AGENT_DIR`         | `<folder>/sessions` (`paths.rs:9`, `:48-53`)                      |
| None                                   | `~/.prime/agent/sessions` (`paths.rs:11`)                         |

| Setting                          | Agent folder, which holds `session-leases/` and `daemon-workers/` |
| -------------------------------- | ----------------------------------------------------------------- |
| `AGENT_LOOKOUT_PRIME_AGENT_HOME` | That folder                                                       |
| `PRIME_AGENT_CODING_AGENT_DIR`   | That folder                                                       |
| None                             | `~/.prime/agent`                                                  |

The command reads `PRIME_AGENT_SESSION_DIR`, then the older name (`crates/pa-cli/src/config.rs:128-134`), and hands the folder to the worker it starts as `PRIME_AGENT_SESSION_DIR` (`descriptor.rs:109-111`). The leases and the workers' folder stay in the agent folder whatever the sessions folder is (`lease.rs:98-108`, `descriptor.rs:204-208`). A leading `~` is the home folder, and a relative value, which Prime Agent takes from each process's own folder, is passed over.

Not followed, because Agent Lookout reads no settings file and no process's arguments: `--session-dir`, and the `sessionDir` setting in `settings.json`, global or a project's (`crates/pa-cli/src/lib.rs:245-252`). A person who uses either can start Agent Lookout with `PRIME_AGENT_SESSION_DIR` set to the same folder. `PRIME_AGENT_DAEMON_SOCKET` and `--daemon-socket` are not followed either: they only pick the folder of the workers in `daemon-workers/`, `hash_key(<socket path>, 12)`, the first 12 hex digits of its SHA-256 (`paths.rs:88-96`, `descriptor.rs:204-208`), and every such folder is looked in.

Where Agent Lookout and Prime Agent differ: Agent Lookout trims a value, and Prime Agent uses any that is not empty as it is (`paths.rs:50`, `:63`). Agent Lookout expands `~\` on Windows, as Prime Agent's command does (`crates/pa-cli/src/config.rs:97-100`), and its daemon does not (`paths.rs:31-39`). When `PRIME_AGENT_SESSION_DIR` is set but empty, Prime Agent's command does not go on to the older name (`crates/pa-cli/src/config.rs:129-132`), and Agent Lookout does.

When the sessions folder is missing, Prime Agent is reported as not found, with no advice, and the folder is looked for again once a minute, or on every poll when `AGENT_LOOKOUT_PRIME_AGENT_HOME` is set. When `AGENT_LOOKOUT_PRIME_AGENT_HOME` names a folder with nothing in it, that is an answer, not a missing Prime Agent.

## What it reads

| Path                                         | How                                                                                     | How often                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The sessions folder                          | One `lstat`. Listed. A link at its name is followed                                     | Every poll. Listed when its modified time moves, once a minute, or when a link  |
| Each `*.jsonl` written in the last day       | One `lstat`                                                                             | Every poll, for the newest 200                                                  |
| Every other `*.jsonl`                        | One `lstat`. Never opened                                                               | Once a minute                                                                   |
| A session file written in the last day       | Opened read-only: its first 64 KiB and last 256 KiB, then what was added, as for Pi     | When it changes                                                                 |
| `session-leases/`                            | One `lstat`. Listed. A link at its name is not followed                                 | Every poll that lists a session. Listed when its time moves, and once a minute  |
| Each `<64 hex digits>.lock` in it            | One `lstat`, and one of its `owner.json`, without following a link at either name       | Every poll that lists a session                                                 |
| `owner.json`                                 | Opened read-only, at most 8 KiB                                                         | When it changes                                                                 |
| `daemon-workers/`                            | One `lstat`. Listed. A link at its name is not followed                                 | On macOS and Linux, every poll on which a session's lease is held by a process  |
| Each `<12 hex digits>/` in it                | One `lstat`, and one of `<worker ID>.recovery.jsonl` in it, for each worker that counts | The same                                                                        |
| The one `<worker ID>.recovery.jsonl` found   | Opened read-only: its last 1 MiB, then what was added, at most 8 MiB a poll             | When it changes                                                                 |
| `/proc/<pid>/stat` of a lease's process      | Opened read-only, at most 4 KiB. Field 22 is kept                                       | On Linux, for a `proc:` start, at most every 30 seconds, and when a lease comes |
| `ps -o pid=,lstart=,comm= -p <pids>`, in UTC | Run directly, never through a shell                                                     | On macOS, and on Linux for a lease whose start was not compared, the same       |

Nothing else in Prime Agent's folders is read: not `settings.json`, its credentials, its logs, `sessions-archive/`, `session-artifacts/`, a session's `<id>.info-cache.json`, which holds the text of its first message (`session_store/info_sidecar.rs:1`, `:37-38`, `:76`), or `<id>.window-cache.json`, and in `daemon-workers/` nothing but the journal a lease names: no worker record, no `supervisor-config` (`descriptor.rs:14-16`), no `compaction-supervision.jsonl`, `<worker ID>.identity-pending`, `<worker ID>.orphans.jsonl` (`journal.rs:16`), temporary file, or another worker's journal. A journal's `.writer-lock` (`journal.rs:139-152`) is never opened or locked: a lock taken on it, even a moment's, can make a worker that is starting fail.

## The session file

The file is `<session ID>.jsonl`, directly in the sessions folder (`session_store/read.rs:17-20`), and its ID is a UUIDv7 (`:13-15`). A path given to `--resume` that does not exist yet is made there under that name, with a new ID (`crates/pa-core/src/session/discovery.rs:190-196`; `worker/create.rs:314-341`). Every line after the first is an entry, `{"type":…,"id":…,"parentId":…,"timestamp":…,…}` (`session_store.rs:93-104`), with `type` first.

### The header

`{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…,"rlmDepth":0}`, with `type` put first (`session_store/write.rs:320-338`) and the rest in `SessionHeader`'s order (`crates/pa-types/src/session.rs:26-50`): `version`, `id`, `timestamp`, `cwd`, then `parentSession`, `rlmDepth` and `git` when they are set. `version` is `3` (`session_store/read.rs:11`), and a higher one is left out, as for Pi. Only `id`, `timestamp`, `cwd` and `version` are read. `parentSession`, which a fork's and an `rlm.create_session` session's header hold, is dropped with the parsed line, and a session is never left out for having one.

### Name lines

`{"type":"session_info",…,"name":…}`, written trimmed (`session_store/write.rs:81-83`). The newest whole one in the bytes read names the session, as for Pi.

### Everything else

Every other line is passed over as bytes: messages, with the prompts, the replies and each tool's arguments and output, `session_state`, model changes, compactions and custom rows. None of it is parsed, kept or logged.

## The session lease

`owner.json` in `session-leases/<hash>.lock/`, written whole with `serde_json::to_string_pretty` into a folder of another name, which is then renamed into place (`lease.rs:505-524`), so a lease's folder is there only once its `owner.json` is complete. Its fields, `LeaseOwner` (`lease.rs:16-28`):

| Field             | What it is                                                                   | Kept                                                                                    |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `version`         | Always `1` (`:514`)                                                          | Looked at: another one makes the lease one that cannot be read                          |
| `token`           | A new UUID, compared only when the lease is given up (`:506`, `:370-377`)    | No. Dropped with the parsed file                                                        |
| `pid`             | The process that took it (`:516`)                                            | Yes, when it is a whole number above 0                                                  |
| `processStartId`  | When that process started, as [The process](#the-process) says (`:517`)      | Yes, when it is `proc:<digits>`, `ps:<up to 64 printable characters>` or `win:<digits>` |
| `activeSessionId` | The worker's ID, from `PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID` (`:518`) | Yes, when it is up to 128 letters, digits, `_` and `-`. None for a print or RPC run     |
| `sessionPath`     | The session file's path, its links followed (`:519`, `:72-80`)               | Only the name at its end, which is matched with the name of a listed session's file     |
| `createdAt`       | When it was taken (`:520`)                                                   | Yes, when it is a time                                                                  |

A lease is given up by renaming its folder to `<hash>.lock.stale-<pid>-<id>` and removing that (`lease.rs:194-219`). Only names of 64 hex digits and `.lock` are looked at, so `.lock.guard` (`:257`), `.lock.candidate-*` (`:507-511`) and `.lock.stale-*` are passed over. A lease whose folder is a link, has no `owner.json`, or whose `owner.json` is over 8 KiB, is not JSON, is of another version, or has no good `pid`, `sessionPath` or `createdAt`, is one that cannot be told whose it is. A lease that names no listed session's file is passed over. A parse that fails keeps nothing of its error.

Since 0.10.1 Prime Agent's daemon removes the leases of processes that have gone (`lease.rs:571-601`, `CHANGELOG.md:150`). How often was not checked.

## The recovery journal

`daemon-workers/<hash>/<worker ID>.recovery.jsonl` (`journal.rs:12`; `supervisor/worker_lifecycle.rs:317-320`), one for each worker, which keeps the worker's slot. Each line is written by `serde_json::to_string` of a `Value` (`journal.rs:24-38`, `:47-64`), and the workspace's `serde_json` keeps an object's fields in the order they were put in (`Cargo.toml:37`, `preserve_order`), so a line's fields are in the order of its struct.

### Record lines

`WorkerRecoveryRecord` (`journal.rs:178-188`):

`{"activeSessionId":"<worker ID>","sessionId":"<session ID>","sessionFile":"<path>","busy":true,"operation":"<step>","recordedAt":"<time>"}`

`sessionFile` is left out when the worker has no file. The worker writes `core.active_session_id`, which is its ID, with its session's ID and file (`worker/summary.rs:169-185`, `worker/queue.rs:259-273`). `recordedAt` is `now_iso()`, 24 characters in UTC (`util.rs:23-40`). A record is written only when `busy`, `operation` or `sessionFile` changes (`journal.rs:392-399`).

A line is taken as a record only when, as bytes, it begins `{"activeSessionId":"`, is at most 4 KiB, and ends `,"recordedAt":"`, 20 to 30 bytes of a time, and `"}`. Only then is it turned into text and parsed. A record torn off and glued to the next line does not end that way, and is passed over unread. Kept: the worker's ID, `sessionId`, the name at the end of `sessionFile`, `busy`, `operation` and `recordedAt`.

### Queue lines

`WorkerQueueSnapshotRecord` (`journal.rs:263-275`):

`{"version":2,"type":"queue_snapshot","active_session_id":"<worker ID>","steering":[…],"follow_up":[…],"suspended":false,"recorded_at":"<time>"}`

The two lanes hold the queued messages, with their text, previews and images (`journal.rs:214-238`). `suspended` is always written (`:272-273`). A line is taken as a queue line when, as bytes, it begins `{"version":2,"type":"queue_snapshot","active_session_id":"`. The worker's ID is the bytes up to the next `"`, at most 128 of letters, digits, `_` and `-`. The line must end with `"}`, after 20 to 30 bytes of a time with no `"` in them, after exactly `,"suspended":true,"recorded_at":"` or `,"suspended":false,"recorded_at":"`. A `"` inside a JSON string is always written `\"`, so those bytes can only be the line's own. Only the ID and the time are turned into text, and which of the two endings matched says whether the queue is parked. The lanes are never turned into text, parsed or kept. A line that begins as a queue line and does not end as one counts as a queue that cannot be read. A queue line of the first format, `"version":1`, whose lanes are bare text (`journal.rs:610-636`), is passed over.

### How it is written

A step that changes the queue writes its queue line first and its record line after, in one write, and leaves the record out when nothing in it changed (`journal.rs:460-514`). When every slot of the journal is idle after a write, Prime Agent rewrites the journal whole, through a temporary file renamed into place, to the newest record of each slot and the newest queue line (`:409-416`, `:544-557`, `:77-95`), and it does the same when it opens a journal whose last line was torn (`:300-318`). A file with another identity, or one that grew shorter, is read again from its end. A last line with no newline is left for the next read. Lines of another worker's slot are passed over.

## Which sessions are listed

Each session whose file was written in the last 24 hours, by its modified time, the newest 200, as for Pi. Every file with a good header is listed. Forks and `rlm.create_session` sessions, whose headers name a parent, are listed: the latter are sessions of their own, with a worker of their own (`rlm_children/host.rs:325-370`). An archived session stays listed, and once nothing holds it, it shows as finished: `session_state` is not read, and reopening a session makes it active again. `rlm.spawn` children are kept in `session-artifacts/<parent>/<child>/`, or in a temporary `prime-agent-rlm-<child>` folder (`crates/pa-core/src/session_engine/rlm_host.rs:325-336`), and are never read. Two files with one ID show once, the newest.

## Status

First, who holds the session's lease, by the name of its file (`primeAgentHolder` and `primeAgentLeaseProcess`):

| Rule | What the leases say                                                                 | Holder  |
| ---- | ----------------------------------------------------------------------------------- | ------- |
| H1   | Every lease was read, and none names the session's file                             | none    |
| H2   | `session-leases/` is missing, is not a folder, or cannot be listed                  | unknown |
| H3   | The lease's process does not answer signal 0                                        | none    |
| H4   | Its start differs from the lease's (`lease.rs:141-147`)                             | none    |
| H5   | Its start is the lease's                                                            | runs    |
| H6   | No start was compared, and the lease was taken before the computer started          | none    |
| H7   | `ps` names its program `prime-agent`                                                | runs    |
| H7b  | `ps` names another program                                                          | unknown |
| H7c  | `ps` names none, or cannot be run                                                   | unknown |
| H8   | On Windows, a lease since the boot whose process answers signal 0                   | unknown |
| H9   | Some lease since the boot cannot be told whose it is, and no lease of this one runs | unknown |
| H10  | Two leases name it: it runs if one runs, else it is unknown if one is               |         |

`none` is `finished`, at the file's last write. `unknown` is `unknown`. While a process that runs holds it, on macOS and Linux, its worker's journal says the rest. The worker is the lease's `activeSessionId`. With none, as for a print or RPC run, no journal, or more than one, the session is unknown. The newest record of the slot counts only if it is this session's, by the name of `sessionFile` against the session file's name or, with none, by `sessionId`, and was written since the lease was taken. The newest queue line counts only if it was written since then too.

| Newest record                                                                                                     | `busy` | Queue line                  | Status    | Since                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------ | --------------------------- | --------- | --------------------------------------------- |
| None that counts                                                                                                  |        |                             | `unknown` |                                               |
| `prompt_accepted`                                                                                                 | true   | any                         | `working` | The first line of the run that works          |
| `steer_queued`, `follow_up_queued`, `turn_end`, `queue_purged`, `queue_cleared`, `queue_mutated`, `queue_resumed` | true   | not parked                  | `working` | The same                                      |
| The same                                                                                                          | true   | parked, or none that counts | `unknown` |                                               |
| `turn_end`, `queue_purged`, `queue_cleared`, `queue_mutated`, `queue_resumed`                                     | false  | any                         | `idle`    | When this session's run of idle records began |
| `create`, and anything else                                                                                       | any    | any                         | `unknown` |                                               |

- `busy` alone says nothing. It is "admitted work a restart must revive" (`journal.rs:331-337`), and `create` writes it true on every create and every reopen (`worker/create.rs:654`).
- A prompt is accepted into a lane while a turn runs, or as the turn it starts, and refused while the queue is parked unless it asks to resume it (`worker/input.rs:52-66`, `:143-147`).
- `steer_queued` and `follow_up_queued` are written with `busy` true (`worker/queue.rs:275-276`, `:456-457`, `:515-518`, `:581-582`). A settle, `turn_end`, `queue_purged`, `queue_cleared` or `queue_mutated`, writes `busy` true while a turn is in flight or a lane holds work (`worker/queue.rs:280-283`; `worker/turn.rs:1153-1162`; `worker/commands.rs:621-623`). `queue_mutated` is written after an edit, move or delete of a queued message, which first lifts a parked queue (`queue_commands.rs:121-143`), and after the agent messages in the lanes are cleared (`agent_message_ingest.rs:144-151`). `queue_resumed` is written when a parked queue is resumed while no turn runs, with `busy` true when work waits, and leaves the queue not parked (`worker/lifecycle.rs:368-421`). After a turn's end the worker runs what waits in its lanes unless its input is paused, its queue is parked or it is compacting (`worker/turn.rs:59`).
- `shutdown`, `killed`, `replaced` and `worker_gave_up` say the worker is ending or are not traced, so they are unknown. A worker gives its lease up after it records `killed` (`worker/commands.rs:806-807`) and before it records `shutdown` (`worker/lifecycle.rs:146`, `:161`).
- The run that works is the records at the end of the journal that each say working by the queue line read before it, are this session's and were written since the lease was taken.
- The run of idle records is the slot's records at the end of the journal that each say idle and are this session's. Prime Agent rewrites its journal to its newest record each time the worker is idle, as [How it is written](#how-it-is-written) says, so Agent Lookout keeps that time across the rewrite. When Agent Lookout starts, it is the time of the first of them in the part of the journal it reads, which is often the newest record's.

A working session's `lastWriteAt` is its file's modified time, unless that is before the session started. A session never has a process ID, a link or an app.

### The process

Prime Agent's own rule is that a lease's owner is gone when its pid does not run, or when the lease records a start and the process with that pid now started at another time. An owner it cannot look at counts as running (`lease.rs:133-149`). It writes the start as `process_start_id` makes it (`crates/pa-types/src/platform/process.rs:15-100`):

- On Linux, `proc:` and field 22 of `/proc/<pid>/stat`, the start in clock ticks since the boot (`:21-26`). When that cannot be read, `ps:` and what `ps -p <pid> -o lstart=` prints with `LC_ALL=C` and `TZ=UTC` (`:36-51`).
- On macOS, `ps:` and the start from the kernel's record of the process, formatted with `strftime_l("%c")` in the C locale after `gmtime_r` (`:53-83`), which its comment says is byte for byte what `ps -p <pid> -o lstart=` prints with `LC_ALL=C` and `TZ=UTC`.
- On Windows, `win:` and the process's creation time in ticks (`:85-100`).

So Agent Lookout asks the same:

- **Signal 0** on every poll, for the pid of each lease of a listed session. It sends nothing to the process.
- **On Linux**, for a `proc:` start, `/proc/<pid>/stat` is read, at most 4 KiB, through `readProcFile` and `startTicksOf` in `src/collector/processes/linuxProcesses.ts`, and field 22 is compared with it. The rest of the line is dropped as it is read. A start that is the same means the lease is held, and the boot rule is not used.
- **On macOS, and on Linux for a lease whose start was not compared there**, `ps -o pid=,lstart=,comm= -p <pids>` is run once for every such lease, with `TZ=UTC` and `LC_ALL=C`. A `ps:` start is compared with what `lstart` prints by `compareProcessStart` in `src/collector/processes/processStart.ts`, which takes the runs of spaces `%e` leaves as one, and counts two starts within a minute as one. A lease with no start that can be compared counts only while its program, the name after the last `/` of `comm`, is `prime-agent`, and not at all once it was taken before the computer started. The binary is `prime-agent` (`crates/pa-cli/Cargo.toml:22-24`; `install-rust.sh:798-804`), and the daemon and its workers run it again, the workers with the argument `worker` (`supervisor/supervision.rs:573-593`), so `comm` cannot tell a worker from the command.
- Each answer of `/proc` and `ps` is kept for 30 seconds, and a new lease is asked about at once (`rememberingCheck` in `src/collector/adapters/qwen-code/processCheck.ts`).
- **On Windows**, nothing more is asked. A `win:` start needs a call into Windows to compare, and a pid there can be another program's, so a lease whose process answers signal 0 cannot be told, and its session is unknown.

The process's arguments and environment are never read.

### Why nothing shows as waiting

Prime Agent's model has one tool, Python (`crates/pa-core/src/tools/ipython.rs:635`), whose `input()` reads nothing, since its standard input is `/dev/null` (`prime-agent-runtime/src/rlm/repl.md:23-24`), and its roster knows Running, Idle and Inactive alone (`crates/pa-types/src/daemon/agent_roster.rs:13-17`). Nothing was found that waits for you mid-turn. `agent_status` lines with `needs_input`, which tests of the TypeScript build hold, are not read. A failed turn is written inside a message, whose text is never parsed, so nothing shows as failed.

## Names

A name is read, as for Pi. In the Rust build at v0.10.3, every `session_info` line in the sessions folder comes from someone naming the session:

- you, with `/name` or `/new --name <name>` in the terminal (`crates/pa-tui/src/session_ui/commands.rs:149`, `:767-776`; `crates/pa-tui/src/new_session_command.rs:1-40`), where text after `/new` without `--name` is the first prompt, or a rename of a saved session (`saved_session_commands.rs`);
- a program that drives Prime Agent over RPC with `set_session_name` (`rpc/session_commands.rs:341-347`), or a name sent when a session is made (`worker/create.rs:48`, `:453`);
- its model, with `rlm.rename` or `rlm.create_session` (`rlm_children/host.rs:333-352`, `:655-720`).

The command has no `--name` flag. The names Prime Agent makes from a task's prompt, `subagent-<words of the prompt>`, go on `rlm.spawn` children (`rlm_children/host.rs:93`), which are never read. The text of a session's first message is in `<id>.info-cache.json`, which is never opened.

The TypeScript build shares the folder by design (`install-rust.sh:107-110`, `:2839-2842`). Its own automatic names go on children outside the sessions folder, and an extension of it can set a session's name, as in Pi. Its interactive mode, RPC mode and bundled extensions were not checked. [What a session's name can hold](../../PRIVACY.md#what-a-sessions-name-can-hold) in PRIVACY.md says this for people.

## Quiet for, tokens, Jump, Stop and Answer

- **Quiet for**: a working session's file's modified time. A reply is written whole when it ends, and a tool's result when the tool ends (`worker/turn.rs:614-621`), so a long reply or a long Python call writes nothing until it ends.
- **Tokens**: no. A reply's counts are on the line with its text.
- **Jump**: no. The files name no terminal.
- **Stop**: no. Agent Lookout sends no signal but signal 0.
- **Answer**: no. No request is made to Prime Agent's sockets.

There is no last message either.

## On Windows

The session files and the leases are read as on any system, from `%USERPROFILE%\.prime\agent`, the folder `os.homedir()` gives. Prime Agent's `cmd` launcher sets `PRIME_AGENT_CODING_AGENT_DIR` to `%USERPROFILE%\.prime\agent` when it is not set (`install-rust.sh:2903`), but Prime Agent itself looks at `HOME` before `USERPROFILE` (`crates/pa-types/src/platform/dirs.rs:13-31`). `daemon-workers/` is never read, and `ps` never runs. A session with no lease, whose lease's process has gone, or whose lease was taken before the boot, is finished. One whose lease's process answers signal 0 is unknown, and the card says why. The basis is `files`.

## Known gaps

- An idle session whose worker Prime Agent stops after a while idle (`supervisor/clients.rs:688-702`) gives its lease up, and shows as finished.
- A turn held by an input pause a client takes shows as working: the pause is not written down (`worker/turn.rs:59`).
- Compaction parks the queue and writes no record as it starts (`worker/lifecycle.rs:447-461`), so a session shows as idle while it compacts. A branch summary may do the same.
- A worker that outlives a stop keeps its lease and its journal's last line, which keep showing.
- A worker writes its lease and journal under the agent folder of the daemon that started it (`descriptor.rs:96-98`). A terminal and a daemon started with different `PRIME_AGENT_CODING_AGENT_DIR` split the files, and a session in the other folder shows as unknown.
- On macOS, a pid given within a minute of the first process's start to another `prime-agent` is taken for the lease's own process.
- A clock set back past the boot, outside Linux's `/proc` check, can make a held lease look older than the boot.
- `~\`, values with spaces at their ends, an empty `PRIME_AGENT_SESSION_DIR`, a relative folder, `--session-dir` and the `sessionDir` setting, as [Where it looks](#where-it-looks) says.
- A session shows as unknown from its opening, or a reopening, until its first prompt.
- Print mode, `-p`, and `--mode rpc` run in one process with no worker, so their sessions show as unknown while they run.
- The TypeScript build shares the folders, and was not checked.
- A lease that cannot be read keeps every session no running `prime-agent` holds unknown, not finished, until the computer restarts.
- A journal with more than 256 of the slot's working lines in a row gives the time of the 256th from its end.
- A turn that starts and ends between two polls, after a time idle, is not seen, and the session stays idle from the start of that time, since the journal is rewritten to its newest record in between.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Prime Agent installed to check:

1. That a session's file, its lease and its worker's journal appear as above, on macOS, Linux and Windows.
2. That `ps -o pid=,lstart=,comm= -p <pid>` names a worker `prime-agent`, and that its `lstart` is the `ps:` start in its lease, byte for byte, on macOS.
3. That `/proc/<pid>/stat` field 22 of a worker is the `proc:` start in its lease on Linux.
4. That the journal's lines are written with their fields in the order above.
5. That a turn shows as working and then idle, a parked queue as unknown, and a closed session as finished.
6. How often the daemon removes the leases of processes that have gone, and how it treats a crashed worker's journal at its next start.
7. That a terminal and its daemon keep their files in one agent folder.
8. The TypeScript build's leases, journals and names.

## What breaks when Prime Agent changes

| Change in Prime Agent                                               | What the dashboard shows                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------- |
| The lease's folder or `owner.json` moves or changes its shape       | Sessions show as unknown, or as finished while they run       |
| `activeSessionId` is no longer the worker's ID                      | Sessions held by a worker show as unknown                     |
| The journal is named another way, or moves                          | Sessions held by a worker show as unknown                     |
| A record or queue line begins or ends another way                   | Sessions show as unknown                                      |
| `serde_json` stops keeping the fields' order                        | Every line's start or end moves, and sessions show as unknown |
| A record field or a step is renamed, or a new step comes            | Sessions show as unknown at that step                         |
| A start is written another way                                      | It is not compared, and `comm` decides                        |
| The folder of a daemon's workers is named with more or other digits | No journal is found, and sessions show as unknown             |
| The binary is renamed                                               | A lease with no start that can be compared shows as unknown   |
| The session `version` goes above 3                                  | Those sessions are left out, and the Sources view says so     |

To check a new Prime Agent version, read `crates/pa-daemon/src/lease.rs` for `LeaseOwner` and `acquire_runtime_session_lease`, `journal.rs` for the two records and how they are written, `worker/queue.rs` and `worker/summary.rs` for what a record holds, the steps in `worker/input.rs`, `worker/turn.rs`, `worker/lifecycle.rs` and `worker/commands.rs`, `supervisor/worker_lifecycle.rs` for the worker's ID and journal, `descriptor.rs` for the workers' folder and environment, `paths.rs` and `crates/pa-cli/src/config.rs` for the folders, `crates/pa-types/src/platform/process.rs` for the starts, `crates/pa-types/src/session.rs` for the header, and the `serde_json` features in `Cargo.toml`. Then update `UNCHECKED_NOTE` in `src/collector/adapters/prime-agent/index.ts` and the first paragraphs here.
