# Mistral Vibe adapter notes

These notes record what Agent Lookout reads from Mistral Vibe, where each value comes from, and what breaks when Vibe changes. Vibe does not document these files for other programs, so when the adapter stops working, start here.

Built on 2026-10-14 from the source of Mistral Vibe 2.26.1, released 2026-10-09 (tag `v2.26.1`, commit `4ae5c59` of [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe)), with its store at format `mistral.vibe.unified-session-store/v1`, minor 8. Needs you and token counts were added on 2026-11-04 from the source of 2.26.1 and of 3.0.4, released 2026-10-30 (tag `v3.0.4`, commit `338ad4b`), whose store is minor 10. **Vibe was not installed on the machine where the adapter was written, and nothing here has been checked on a computer running Vibe.** Everything below comes from Vibe's source and from hand-written files laid out the same way. A citation is a path in that repository at `v2.26.1`, unless it says `3.0.4`, and a line number is one at `v3.0.4`. `harness/…/vibe/` stands for `harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/`.

The code is in `src/collector/adapters/mistral-vibe/`, and the status mapping is in `src/core/mapping/mistral-vibe/mistralVibeMapping.ts`.

This version reads Needs you, working, idle, finished and failed, the name, the folder, Quiet for and the token counts of the newest reply. It does not read what a session last said yet, and it does not list sessions Vibe ran on its older engine.

## Which versions this covers

| Vibe           | Store minor | Read                                                          |
| -------------- | ----------- | ------------------------------------------------------------- |
| 2.26.0, 2.26.1 | 8           | Yes                                                           |
| 3.0.0 to 3.0.2 | 9           | Yes                                                           |
| 3.0.3, 3.0.4   | 10          | Yes                                                           |
| A newer store  | Above 10    | With no status and no token counts, until the adapter is told |

The adapter was written from 2.26.1 and 3.0.4, and the minor of each tag between was read from its `_storage.py`. Every field the adapter reads is the same at 2.26.1 and 3.0.4. `CurrentPointerV1`, `GenerationManifestV1`, the callback models, `compute_projection_delta`, `_journal_record_bytes` and the public state's statuses have not changed. `RuntimeStateV3` gained fields the adapter does not read, and `ProjectionStateV1` holds the same public state, which 3.0.4 keeps with any field a newer Vibe added left in (`StoredPublicSessionState`). What changed does not touch what is read:

- Minor 9 added a journal record, `session_relocated`, which `relocate_session` and `update_session_metadata` write, and a baseline in a record the adapter does not read. Minor 10 left repeated settings out of a `core_input` record (`STORE_FORMAT_MINOR`, `_storage.py:117`).
- From 3.0.2, `resolve_callback` writes nothing for a callback already settled, where 2.26.1 wrote a second record. A second `callback_resolved` closes nothing more, so either reads the same.
- From 3.0.4, a settled question is added to the session's history (`_record_settled_user_input`, `_session.py:2966`), which is a `projection_delta` like any other.
- From 3.0.4, the first time a Vibe process takes a lease it deletes the leases no process holds (`_sweep_once`), so a lease a killed Vibe left behind goes when Vibe next runs, where before it stayed until its session was opened again.

## How it reads Vibe, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no Vibe program run, no network. It reads Vibe's session folder, read-only. The one program it runs is `ps`, on a Mac, and only while a lease could be one a crashed Vibe left behind (see [When a lease's process ID goes to another program](#when-a-leases-process-id-goes-to-another-program)).

Vibe documents no listing of its sessions for another program. `vibe --resume` is a picker for a person (`README.md`), and Vibe's app server lists sessions only for the clients it serves. So the adapter reads the files Vibe's own list is built from (`harness/…/vibe/_host.py`, `_list`).

## What it reads

| Path, under the session folder          | How                                                                                                                                                        | How often                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The session folder itself               | One `stat`                                                                                                                                                 | Every poll, and once a minute while it is missing, unless `AGENT_LOOKOUT_VIBE_SESSION_DIR` names it                                                                                                                                                                      |
| `unified/`                              | One `lstat`, to see whether it changed                                                                                                                     | Every poll                                                                                                                                                                                                                                                               |
| `active/`                               | Listed. A `<session ID>.lock` is never opened                                                                                                              | Every poll                                                                                                                                                                                                                                                               |
| `active/<session ID>.lock.json`         | `lstat`, then opened read-only, at most 4 KiB, for a session with a lock                                                                                   | When its size, modified time or identity changes, and every 30 seconds while it cannot be read                                                                                                                                                                           |
| `unified/<session ID>/CURRENT`          | `lstat`, then opened read-only, at most 4 KiB                                                                                                              | `lstat` every poll for each followed session. Read when it changes                                                                                                                                                                                                       |
| `generations/<g>/manifest.json`         | Opened read-only, at most 256 KiB                                                                                                                          | Once for each generation, while the session is followed                                                                                                                                                                                                                  |
| `generations/<g>/projection-state.json` | Opened read-only, at most 4 MiB                                                                                                                            | Once for each generation, while the session is followed                                                                                                                                                                                                                  |
| `generations/<g>/runtime-state.json`    | Opened read-only, at most 8 MiB                                                                                                                            | Once for each generation, while the session is followed                                                                                                                                                                                                                  |
| `journal/<16 digits>.jsonl`             | `lstat`, then opened read-only: at most the last 8 MiB the first time, then only what was added                                                            | `lstat` every poll for each followed session. Read when it changes                                                                                                                                                                                                       |
| `unified/` and each `<session ID>/`     | Listed. In each store folder, `CURRENT` and each segment in `journal/` looked up, and `journal/` listed. Nothing is opened                                 | On the first poll, then at most every 30 seconds while `unified/` or the session folder changes, and at least every 5 minutes. Every poll for a store that is not followed, while a program that runs holds its lease, until the lease's `acquired_at` is 30 seconds old |
| The older engine's folders              | The session folder listed, and the folders `<prefix>_<YYYYmmdd>_<HHMMSS>_<id>` looked up, newest first, until one saved in the last day. Nothing is opened | With the look through `unified/`                                                                                                                                                                                                                                         |

Every file is opened with `O_NOFOLLOW` and `O_NONBLOCK` and read only if the open file is an ordinary file, so a link, a pipe or a device is never read. `unified/`, or a store folder in it, that is a link is not read either: Vibe refuses one too (`harness/…/vibe/_storage.py`, `_reject_symlink_components`). The session folder, `active/` and the folders inside a store are followed when they are links.

### The session folder

The folder is the first of:

1. `AGENT_LOOKOUT_VIBE_SESSION_DIR`, which names the session folder itself;
2. `logs/session` in `VIBE_HOME`, with a leading `~` made the home folder, as Vibe reads it (`vibe/utils/vibe_home.py`);
3. `~/.vibe/logs/session`.

Vibe can move the folder with `[session_logging] save_dir` in its `config.toml`, in a trusted project's `.vibe/config.toml`, or through its environment and admin layers (`vibe/core/config/models.py`, `SessionLoggingConfig`; `vibe/core/config/default_orchestrator.py`). The adapter reads none of them. Someone who moved it names the folder with `AGENT_LOOKOUT_VIBE_SESSION_DIR`. With `[session_logging] enabled = false`, Vibe writes its sessions to a temporary folder it deletes afterwards (`vibe/app_server/_runtime.py`), and nothing can be seen.

When the folder is missing, the card says Mistral Vibe was not found, and the adapter looks again once a minute. When `AGENT_LOOKOUT_VIBE_SESSION_DIR` names a folder that is missing, the card says so and nothing is listed: that is an answer, not a missing Vibe. When the folder is there and has no `unified/`, Vibe has not saved a session there yet.

### Leases

Vibe keeps a lease in `active/` for each session one of its programs holds (`harness/…/vibe/_storage.py`, `SessionLease`). To take one, under a lock on the folder itself, `.registry`, it makes `<session ID>.lock`, locks it with the system's file lock, `flock` on macOS and Linux, then writes `<session ID>.lock.json`:

```json
{
  "acquired_at": "2026-10-01T11:00:00.000Z",
  "lease_version": 1,
  "process_id": 4242,
  "session_id": "…"
}
```

It writes that file with an open that empties it first, so a read can find it empty or half written. To let a lease go, it unlocks and deletes `.lock`, then `.lock.json`. A program that crashes leaves both behind, and the next one to take the lease uses them again.

Vibe's own programs tell a held lease by trying its lock (`session_is_live` in `_storage.py`). Its watcher of leases does the same before it reads the process ID (`vibe/app_server/_session_lease_watch.py`, `read_lease_holder`). **The adapter does not take the lock, on purpose.** It never opens a `.lock` or `.registry`, so it can never hold a lock Vibe is waiting for, or seed a lock file, as Vibe's own probe does. It reads only the `.lock.json`, and takes a lease as held while the process it names exists, by a signal-0 check:

| `active/`                                                  | Held                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| Missing, or cannot be listed                               | Not known. No session is shown as finished, and the poll is named apart |
| No `<session ID>.lock`                                     | No                                                                      |
| A lock, and a `.lock.json` naming a process that exists    | Yes, until that process is told to be another program's                 |
| A lock, and a `.lock.json` naming one that does not        | No: a lease a crashed program left behind                               |
| A lock, and no `.lock.json`, or one empty or torn          | Yes: a program taking the lease                                         |
| A lock, and a `.lock.json` that has never been read        | Yes, as for a program taking the lease, until a read works              |
| A lock, and a `.lock.json` that cannot be looked up        | As the last read of it said                                             |
| A lock, and a `.lock.json` that changed and cannot be read | Yes, until a read works, with no process and the time of the last read  |

A read that finds no process is a fact about the file, so it is kept until the file changes, as any read is. A read that fails, as when Agent Lookout is out of file handles, says nothing about the file, so it is not kept: the adapter tries the `.lock.json` again every 30 seconds (`LEASE_RETRY_MS`), and at once if it changes, until a read works. A file that never can be read costs one failed open every 30 seconds.

A failure should leave a running session as it was, so it never counts as a lease just taken if a read of the file worked before and is still kept. A Vibe that runs can still show as finished in the cases named here and in the costs below. What it leaves depends on what failed:

- A poll that cannot list `active/`, or look a `.lock.json` up, keeps the last read of it. The file is read again only if it changed or a try is due, so a failure of either adds no open. A folder or a file found missing is a fact, so its last read goes. A poll that cannot list `active/` knows no lease, so a session Vibe last wrote to more than a day ago, which only its lease keeps listed, leaves the list until a listing works, and comes back then only if its process still runs. Such a poll is compared only with the last one like it, so leaving tells nothing unless that one listed the session: then Ended is sent, though the session runs.
- A `.lock.json` that changed and cannot be read keeps the time of the last read, so it does not count as taken now, and gives no process. A change means a program wrote the file, so the process the last read named may have gone while another holds the lease, and asking about that one could show a Vibe that runs as finished. So no process is asked about and no wait is claimed until a read works. The kept time counts only for a session already followed. With no process to show that a program holds the lease, one Vibe last wrote to more than a day ago that is not listed stays so, and nothing in its store is opened, at least until a read works.
- A `.lock.json` that has never been read, or whose last read went with a folder or file found missing, has nothing to keep. It gives no process and no time, so no process is asked about, and its session stays as a lease being written leaves it: for the first 30 seconds as one no program holds, unless Vibe writes to it, and after that as held. A failed listing does not start those 30 seconds over, and a folder found missing does. A session that runs can show as finished for that time, as when Agent Lookout starts during a failure, but Finished is not sent for it: a session first seen as finished tells nothing, and one already finished has nothing new to tell. The exception is a session shown as open before the folder or file was found missing: it is compared with its last answer, and Finished is sent.

What reading leases this way costs:

- A lease left behind whose process ID another program has since been given looks held, until that program ends, unless that can be told (see [When a lease's process ID goes to another program](#when-a-leases-process-id-goes-to-another-program)).
- A program that crashed between making the lock and writing the `.lock.json` leaves a lock that looks held for good.
- A session whose process goes does not show that until a read works, and then shows as finished, when its `.lock.json` changed and cannot be read, or has never been read. One Vibe last wrote to more than a day ago, which only its lease keeps listed, leaves the list until a read works if none has yet, since the lease gives no time, or while `active/` cannot be listed. It comes back then only if its process still runs.
- A session another Vibe takes between two polls, just as the Vibe its last read names goes, shows as finished while its `.lock.json` cannot be looked up, even as the new Vibe writes to it: the last read stands, and the process it names has gone. Finished is sent. Once a look works it is a session a program reopened, which shows as open as soon as Vibe has written to it or held the lease for 30 seconds. Telling this from a lease left behind would take keeping more for every lease. The case needs two rare things at once, a takeover in those two seconds and a look that fails, and a look needs no file handle, so running out of them does not cause it.
- A session that showed as finished, because its lease was left behind, shows as open while a `.lock.json` that changed cannot be read, and one that waited shows as working. A change can be Vibe taking the lease for a moment. Then the Events log gets two entries, the change to open and the change back, and Finished is sent again. That is the lesser mistake: a Vibe that runs shown as finished is worse than one left behind shown as open.
- Vibe takes the lease of a stored session for a moment when it renames, forks, imports or deletes it, and when it clears the output of processes the session ran (`_host.py`, `_run_process_output_cleanup`). To clear that output, Vibe takes the lease of every stored session that ran a process, however old, and holds them all until it is done (`_cleanup_process_output_once`). So a lease taken less than 30 seconds ago, by the `acquired_at` the `.lock.json` gives, does not show a session as open until Vibe writes to it, and a session Vibe last wrote to more than a day ago is listed only once its lease has been held for 30 seconds. Until then nothing in its store is opened. A lease whose `acquired_at` cannot be read yet, as between making the lock and writing the `.lock.json`, counts as taken at the poll that first finds it so. A session a program reopens shows as finished for up to 30 seconds, until Vibe writes to it.
- A finished session still shows as open while Vibe holds its lease in two cases: once Vibe writes to it under the lease, as when it renames it or marks as orphaned the processes a crashed Vibe left running (`reconcile_orphaned_processes`), and once Vibe has held the lease for 30 seconds, as a long clearing of old output can. It shows as open until Vibe lets go. Each time, the Events log gets two entries, the change to open and the change back, and Finished is sent again wherever you chose to get it.

The folder also holds Vibe's short-lived `.watch-<hex>` files and the lease Vibe takes while it clears old process output, `process-output-cleanup`, which belongs to no session. Both are left alone, and so are the leases of subagents, whose ids begin with `child-`. A `.lock.json` with no `.lock` beside it is a lease Vibe let go of and could not delete, and is not read.

### When a lease's process ID goes to another program

The system gives the process ID of a lease left behind to another program sooner or later. Signal 0 then says the lease's process exists, and the session looks held for as long as that program runs. The rule is to tell for sure or leave the session as it is: a Vibe that runs shown as finished is worse than one left behind shown as open.

On a Mac, the adapter runs `ps -o pid=,lstart= -p <pids>` (`createRecordProcessCheck`, as for Qwen Code) and compares when a lease's process started with the lease's `acquired_at`:

- A process that started more than a minute after `acquired_at` cannot have taken the lease, since a process ID goes only to a program that starts later. No program holds the session, so it shows as it would once its process had gone: finished, with nothing else about it changed. It leaves the list a day after Vibe last wrote to it, as any finished session does. One Vibe last wrote to more than a day ago, which only that lease kept listed, leaves at once.
- A process that started earlier, or no more than a minute after, is left as held. An app server takes leases long after it starts, and one process can hold many, so each lease is compared with its own `acquired_at`.
- A process `ps` says nothing of, `ps` failing, or a lease that gives no process or no time leaves the session as it is.

`ps` is run only while a lease could be left behind:

- A session that waits is asked about as soon as it waits, again every 30 seconds while the wait stands, and sooner when another session starts to wait, whatever the last answer was. A wait keeps the Mac awake for as long as it is listed.
- Any other lease is asked about once its session has gone a minute by the clock with nothing written (`LEASE_QUIET_MS`). Nothing is written under a lease left behind, so a session Vibe keeps writing to costs no run, and a lease left behind is asked about a minute after Vibe's last write.
- A lease `ps` gives no answer for is asked about again every 30 seconds, until it gives one.
- A lease `ps` gave an answer for is not asked about again while its process runs. Its process ID, `acquired_at` and the answer are kept for that long, and signal 0 looks at the process on every poll. Once the process is found gone they are dropped, so a process ID that comes back is asked about as new. A poll that cannot list `active/`, or a `.lock.json` that changed and cannot be read, drops them too, which costs one more run.

Every lease due goes in one run, however many processes they name. So `ps` runs at most once a poll, once when a lease comes due or its session starts to wait, and otherwise every 30 seconds, and with no lease, with no process that runs, or with only leases already answered and no session waiting, it does not run at all.

`ps` is not run on Linux or Windows. Windows has no `ps`. On Linux, `ps` works a start time out again from the clock each time, so a clock set forward by more than a minute, as a virtual machine's can be when it wakes, moves the start of a Vibe that runs past its lease, and its session would show as finished and send Finished. A lease has no start token to read from `/proc` instead, as a Qwen Code record does, and comparing a process's age with the time since `acquired_at` goes wrong in the same way.

A program's name, from `ps -o comm=` or `/proc/<pid>/comm`, cannot tell either. It could say a process is not Vibe's only if every name Vibe's process can have could be listed, and they cannot. The process that takes a lease is a Python program (`os.getpid()` in `SessionLease.acquire`). Started as a console script, `vibe`, `vibe-acp` or `vibe-app-server` (`[project.scripts]` in `pyproject.toml`), Linux names it after the script, unless uv or pip made the script start through `/bin/sh`, as they do for an interpreter on a long path or one with a space, when it has the interpreter's name, `python3.14` or any other. A PyInstaller build has the name its `.spec` gives it. `VIBE_APP_SERVER_CMD` runs any command line (`resolve_launch`, `vibe/cli-rust/src/startup/launch.rs`). The desktop app's source is not in Vibe's repository. The title a Vibe process gives itself (`_set_process_title`, in `vibe/cli/entrypoint.py` at 2.26.1 and `vibe/app_server/stdio.py` at 3.0.4) is cosmetic and may fail, and `vibe-acp` sets none. A list that left one out would show a Vibe that runs as finished.

One thing holds on Linux and Windows with no clock and no program run: a process that ended never comes back. So where `ps` is not run, once signal 0 finds a lease's process gone, the lease stays left behind, whatever later has its process ID, and its session stays finished until a program takes the lease again, with a new `acquired_at`. This is kept in memory alone, so a restart of Agent Lookout, a poll that cannot list `active/`, or a `.lock.json` that changed and cannot be read, forgets it. If the process ID has been given out by then, the lease stands until that program ends. So does a lease whose process ID went to another program with no poll finding it free, as while Agent Lookout was stopped or across a restart of the computer.

### `CURRENT` and its generation

Each session's store is `unified/<session ID>/` (`_storage.py`). Every file in it is JSON with sorted keys and no spaces, ending in a newline, replaced whole through a temporary file and a rename (`canonical_json`, `_replace_document`).

`CURRENT` names the session's newest saved state, a generation: `store_format`, `store_format_minor`, `session_id`, `generation`, 16 digits, `snapshot_sequence` and `manifest_sha256` (`CurrentPointerV1`). The adapter reads it whole when it changes, and goes on only when the format is `mistral.vibe.unified-session-store/v1`, the session ID is the folder's and the generation is 16 digits.

Vibe's readers accept a store of their own minor or lower and refuse a higher one (`STORE_FORMAT_MINOR`, 8 at 2.26.1 and 10 at 3.0.4). A field Vibe adds raises no minor (`_StoredModel`). The adapter does the same: it reads any minor up to 10, keeps no key it does not know, and shows a session whose store has a higher minor with no status and no token counts, with its name and folder when they still read, and a sentence on the card.

When `CURRENT` names a generation not read before, the adapter reads, once each while it follows the session, since Vibe never changes them:

- `generations/<g>/manifest.json` (`GenerationManifestV1`), for the journal segment that follows the generation, `recovery_journal_segment.path`, kept only if it is `journal/<16 digits>.jsonl`. The segment's name is taken from here, never from the newest file in `journal/`: Vibe makes the next segment before it moves `CURRENT`. The manifest also names the two files below, which are opened only when it names them `projection-state.json` and `runtime-state.json`, as Vibe always does (`write_generation`), so no manifest can lead to `checkpoint.json`.
- `generations/<g>/projection-state.json` (`ProjectionStateV1`), whose `snapshot` is the session's public state, in camelCase (`harness/…/session_protocol.py`, `PublicSessionState`). It is the state when the generation was saved.
- `generations/<g>/runtime-state.json` (`RuntimeStateV3`), for `session_metadata.cwd`, the session's folder, `identity.kind`, `root`, `fork` or `subagent`, `lifecycle.type`, `deleting_tree` while Vibe deletes it, and `callbacks`, for the id, kind and time of each that is `pending` (see [Needs you](#needs-you)).

Vibe keeps only the two newest generations (`_RETAINED_GENERATIONS`), so a generation can go between reading `CURRENT` and reading its files. Then `CURRENT` is read once more, as Vibe's own reader does (`_load_current`). If that fails too, what was read before stands until the next poll.

A generation's `checkpoint.json` holds the whole conversation, and `chunks/` holds the history moved out of the other files. Neither is opened.

### The journal

Between two saves, Vibe records what happens in the segment the manifest names, one record a line, each added with one write (`_append_journal_record`). A line is the record's JSON with its keys sorted, so `payload` comes first and `type` last (`_journal_record_bytes`):

```text
{"payload":{…},"previous_record_sha256":…,"record_sha256":"…","recovery_journal_record_version":1,"sequence":5,"type":"projection_delta"}
```

A last line with no newline is one Vibe is still writing, or one it will cut off before its next write (`_read_journal`), and is left for the next read.

The public state changes only through `projection_delta` records, whose payload is `{"delta":[<steps>],"watermark":N}`. The steps add, replace or remove entries of the conversation first, then, when anything else changed, end with `{"op":"set_envelope","state":{…}}`: the whole public state with its history left out (`compute_projection_delta`, `SetEnvelopeOp`). So:

- each line's type is read from its end, `,"type":"<type>"}`, and no line is parsed for it;
- for a `projection_delta`, only what lies between the last `{"op":"set_envelope","state":` and the last `}],"watermark":` is parsed. A `"` inside a JSON string is always escaped, so the two can only be the record's own structure. The entries before them hold your prompts, Vibe's replies, the commands it ran and what they printed, and are never parsed;
- a `projection_advanced` record, a whole state that no build from 2.25.7 on writes, is a state the adapter does not read: the status is not known until a newer state or a save;
- `callback_registered` and `callback_resolved` are read from the first bytes of the line, at most 1 KiB, and no further (see [Needs you](#needs-you)).

The first read of a segment looks back from its end through at most 8 MiB for the newest line that sets the state. A single line can be longer, up to Vibe's 64 MiB, and the state, which comes last on it, is still read from its end. It stops at that line unless the state has a turn in flight, the one time a callback can hold the session. Then it goes on through the same 8 MiB for the turn's callbacks, and a segment begins at the last save, so that is most often the whole turn. After that, only what was added is read, at most 8 MiB at a time. A segment that shrinks, is replaced or grows by more than that is read afresh from its end.

The newest state in the segment wins over the generation's. Vibe saves a session whole when a turn ends with nothing left running and the journal holds something, and when its folder, model or settings change (`harness/…/vibe/_runtime.py`). A rename, and the title Vibe makes for a session in the background, are journaled with no save after them. So the generation's state is often older than the journal's, and an idle session's segment is often not empty.

From a public state the adapter keeps `session.title`, `session.status.type`, `session.createdAt`, `session.updatedAt`, `latestTurn.status`, `startedAt` and `completedAt`, and three numbers of `session.contextUsage`, the newest reply's [token counts](#token-counts). It drops the rest, which includes `session.preview`, the first thing you asked, `session.tokenUsage`, the session's running total, every error in full, the queue of prompts and `activeCallbacks`, which is empty on disk. Vibe 2.26.1 began writing `latestTurn.stopReason` as `limit` or `length` with no new minor, so values and keys the adapter does not know are left where they are.

## Which sessions are listed

A session is followed for a day after Vibe last wrote to its `CURRENT` or a segment of its journal, and while a Vibe program holds its lease. One Vibe last wrote to before that is listed only once a program that runs has held its lease for 30 seconds, since Vibe takes the lease of every old session that ran a process for as long as it takes to clear their output. Until then, and for a lease a crashed program left behind, nothing in its store is opened. The stores of sessions no program holds are found by the look through `unified/`. Vibe rewrites its own index there, `unified/.session-index.json`, each time one of its programs lists sessions after any session changed (`harness/…/vibe/_session_catalog.py`), so the folder's time moves far more often than sessions are made. That is why the look comes at most every 30 seconds. A session a program holds is found through its lease on every poll.

Left out:

- subagents: an id that begins with `child-` (`harness/…/vibe/_subagents/_operations.py`), or a store whose `identity.kind` is `subagent`, as Vibe's own list leaves them out;
- a session being deleted, `lifecycle.type` `deleting_tree`;
- a lease with no store yet: Vibe takes a new session's lease before it saves anything, and drops the folder if the session closes unused. It appears once Vibe saves it;
- sessions Vibe ran on its older engine, `<prefix>_<YYYYmmdd>_<HHMMSS>_<id[:8]>/` with `meta.json` and `messages.jsonl` (`vibe/core/session/session_logger.py`). Vibe 2.26.0 made the unified engine the default (`CHANGELOG.md`), and `--legacy-harness` still selects the older one. When it saved one in the last day, the card says those sessions are not shown. Nothing in their folders is opened.

Forks are listed: their `parentSessionId` is set, as a subagent's is, so the kind decides, not the parent.

## Status

| `session.status.type`                    | Held              | Status    |
| ---------------------------------------- | ----------------- | --------- |
| not read, or a store newer than minor 10 | any               | unknown   |
| `failed`                                 | any               | failed    |
| `idle`, `running`, `blocked`             | no                | finished  |
| `running`, `blocked`, with a wait        | yes               | needs-you |
| `running`, `blocked`                     | yes, or not known | working   |
| `idle`                                   | yes, or not known | idle      |
| `archived`, or anything else             | any               | unknown   |

The projector writes only `running`, `failed` and `idle` (`harness/…/vibe/_projection.py`). Vibe stamps `blocked` only on the state it holds in memory, and `archived` only on what its app server sends, so neither is expected on disk. A session waiting for your approval or an answer reads as `running` there, and only its callbacks tell it from one that works. A failed turn stays failed once no program holds the session.

The status time is when the newest turn began while it works, when the turn ended once it is idle or failed, and the state's last change once it is finished, each from the public state. While a session needs you, it is when the wait began, from its record. An unknown status has no time.

## Needs you

While Vibe waits for you, it is held on a callback: `approval` for a tool it asks you to allow, `user_input` for a question. These are the only two kinds it registers, at 2.26.1 and 3.0.4 (`_request_approval`, `_session.py:2879`, and `_request_user_input`, `_session.py:2915`). A wait on a hook or on a tool of a client's stays `running` (`BlockedSessionStatus`, `session_protocol.py`).

### What is on disk

Vibe journals a callback before it shows you the prompt (`register_callback`, `_storage.py:3652`):

```text
{"payload":{"callback_id":"approval-…","kind":"approval","routing":{"callbackId":"approval-…","createdAt":1790856000000,"detail":{…},…},"previous_record_sha256":…,"type":"callback_registered"}
```

`routing` is the whole callback (`_approval_callback`, `_session.py:4064`, and `_user_input_callback`, `_session.py:4131`). Its `detail` holds the tool's arguments, why Vibe asks, or the question. Keys are sorted (`canonical_json`, `_storage.py:3903`, `_journal_record_bytes`, `_storage.py:4888`), and `routing`'s are `callbackId`, `createdAt`, `detail`, `generationStatus`, `id`, `inputEntryId`, `relatedEntryId`, `sessionId`, `state`, `title`, `turnId`, `type` and `updatedAt`. So all the adapter needs comes before the first byte of `detail`. It reads the type from the line's end and the rest from its start, at most 1 KiB, and parses nothing. A `"` inside a JSON string is always escaped, so text cannot read as a record's start, and a line whose start was not read is never asked.

A callback is settled by one record, whose `result` holds the decision or the answer (`resolve_callback`, `_storage.py:3665`). Only `callback_id`, its first key, is read:

```text
{"payload":{"callback_id":"approval-…","result":…,"state":"resolved"},"previous_record_sha256":…,"type":"callback_resolved"}
```

A save takes what is open into the next generation. `runtime-state.json` has `callbacks`, each `{"callback_id","kind","result","routing","state"}` with `state` `pending`, `resolved` or `failed` (`RuntimeCallbackV1`, `_storage.py:610`), and the new segment starts with no record of them. A wait can outlast a save, since a turn that crosses 32 MiB of journal, or, from 3.0.3, 500 inputs, is saved where it stands (`_JOURNAL_COMPACTION_HIGH_WATER_BYTES`, `_runtime.py:214`). So what is open is what the generation saved as `pending` and the segment has not settled, and what the segment opened (`openCallbacks`). When the read did not reach the segment's start, a saved callback may have been settled in what was not read, so none is taken as open.

`blocked` is not on disk. `_with_open_callbacks` (`_session.py:3526`) stamps it, with the callback's id and kind, and fills `activeCallbacks`, only on the state Vibe sends its clients. Neither `_projection.py` nor `_storage.py` writes either: `session.status.type` stays `running`, `latestTurn.status` stays `in_progress`, and `projection-state.json` says nothing of the wait.

### What ends a wait

| What happens                                  | What Vibe writes                                                                                                                                                    | Where                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| You approve or answer                         | `callback_resolved`, `state` `resolved`, and the turn goes on                                                                                                       | `_respond_to_callback`, `_session.py:2135`                                              |
| You deny an approval                          | The same, with the decision in `result`, and the turn goes on without the tool                                                                                      | `_approval_grant`, `_session.py:4196`                                                   |
| You choose to cancel the turn                 | The same, then the turn is interrupted and the session is idle                                                                                                      | `_interrupt_active_turn_from_callback`, `_session.py:2986`                              |
| A client sends back an error                  | `callback_resolved`, `state` `failed`                                                                                                                               | `_respond_to_callback`                                                                  |
| You stop the turn, or Vibe closes             | `callback_resolved`, `state` `failed`, `{"code":"callback_closed",…}`                                                                                               | `_close_open_callbacks`, `_session.py:3029`, from `_cancel_active_work` and `shutdown`  |
| Vibe is killed                                | Nothing. The callback stays `pending`, and the lease stays behind                                                                                                   |                                                                                         |
| A later program opens the session             | An approval: `callback_resolved`, `state` `failed`. A question: nothing. Its action fails, since it cannot be reconnected, the turn goes on, and it stays `pending` | `_close_restarted_approval_callbacks`, `_runtime.py:3487`, `_recover`, `_recovery_mode` |
| Vibe abandons the action, in a turn that ends | Nothing. The callback leaves memory and stays `pending` on disk                                                                                                     | `_drive`, `_runtime.py:2287`, and the `finally` of `_request_approval`                  |

Every row but the last three writes a `callback_resolved`, so it ends the wait the moment the journal is read. `state` is not read: `resolved` and `failed` both settle a callback.

### When a callback counts

The last three rows can leave a callback open on disk that nothing waits on. Vibe keeps what it waits on in its process's memory (`_open_callbacks`), and the file cannot say so. A callback counts only (`vibeWaitOf`):

- while a program that runs holds the session, by a lease that gives its process and when it was taken. A session no program holds is finished, with no reason. So a Vibe killed while it waits shows as finished, and does not keep the Mac awake. With the folder of leases not listed, or a lease being written or not read since it changed, no wait is claimed, and the session shows as working;
- while a turn is in flight, `running` or `blocked`, as Vibe itself decides (`_held_by_open_callback`, `_session.py:4249`);
- when `createdAt` is at or after the lease's `acquired_at`. The program that holds the lease cannot be waiting on what an earlier one opened, which is how a question left behind by a killed Vibe stops counting once the session is reopened;
- when `createdAt` is at or after the newest turn's `startedAt`, which a turn keeps while it runs (`_started_at`, `_projection.py`). That rules out a callback Vibe abandoned in an earlier turn. Both are times from one computer's clock;
- when its kind is `approval` or `user_input`.

A wait keeps the Mac awake for as long as it is listed, where a session left working stops after 30 quiet minutes, so a lease whose process ID went to another program matters more here. On a Mac, `ps` is asked about the lease of a session that waits every 30 seconds while the wait stands, as [When a lease's process ID goes to another program](#when-a-leases-process-id-goes-to-another-program) says. A process that started more than a minute after the lease's `acquired_at` ends the wait: the session is finished, and that lease is not asked about again. A process that started earlier, or one `ps` says nothing of, leaves the wait standing. On Linux and Windows, where `ps` is not run, a wait in a lease whose process ID went to another program stands until that program ends, unless the adapter found its process gone first and still remembers that, as [Known gaps](#known-gaps) says.

### What a session shows

An approval is `needs-you` with the reason `permission`, and a question with the reason `question`. With two open at once, the reason is the newest's, as Vibe's own `_blocked_status` (`_session.py:3540`) takes it. There is no `waitingText` or `waitingDetail`.

The status time is `routing.createdAt`, the time Vibe asked, and the oldest's of those that count. It does not move while the wait stands: a write, a rename or a second ask does not touch it, and while any callback the wait hung on stands, it keeps the time it began, across polls (`continuedVibeWait`). Only that last part is kept from one poll to the next, so after Agent Lookout restarts the time is that of the oldest still open. Once every callback is settled the session is working, from when its turn began, as before the wait. A new ask with nothing carried over from the last is a new wait, however soon it comes.

Of a callback the adapter keeps its id, which ties its result to it, its kind and its time, in memory: while it is open, or, for one a save carried over, until the next save, and the id alone of one the journal settles that it did not see opened, until the next save too. A session gets only the waiting reason made from its kind, and its time as the status time, never the id, and an event or the history gets none of them. It keeps no tool, no arguments, no reason, no question and no answer.

## Names, folders and apps

A session is named by its title, then its folder's name, then its id. Never by `preview`, the first thing you asked, which Vibe shows in its place when it has no title. A title is one a model writes in the background (`harness/…/vibe/_title.py`), or one set with `/rename`, so it can echo what was asked. With `[session_logging] generate_titles = false`, Vibe gives no title, so the folder names it. The folder is `session_metadata.cwd`, which Vibe rewrites when a session moves, as into a worktree.

The files do not say whether a session runs in the terminal, an editor, the app server for ACP or the desktop app, so no app is shown. There is no Jump, Stop or pid: the process that holds a lease can hold many sessions' leases, as an app server does.

## Quiet for

Quiet for is the journal segment's own modified time. Every record Vibe adds moves it, and a save starts a new segment. Nothing is journaled while a model streams its reply, so a long reply can read as quiet.

## Token counts

A session's details give the token counts of its newest reply. They come from the public state the adapter reads for the status, and no file is opened or read for them that is not read for it.

### What is on disk

A public state's `session` holds two usages of the same shape, `TokenUsage` (`session_protocol.py:326`, `PublicSession`, `:483`), in every tag from 2.26.0 to 3.0.4:

```json
{
  "contextUsage": {
    "cachedInputTokens": 9000,
    "inputTokens": 12000,
    "outputTokens": 340,
    "totalTokens": 12340
  },
  "tokenUsage": {
    "cachedInputTokens": 310000,
    "inputTokens": 980000,
    "outputTokens": 41000,
    "totalTokens": 1021000
  }
}
```

| Field          | What it is                                                                                                                               | Read |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `contextUsage` | One reply's usage, not a total. Each reply Vibe commits replaces it with its own counts (`SessionProjector.apply`, `_projection.py:351`) | Yes  |
| `tokenUsage`   | Every reply and compaction added up, the session's running total (`_projection.py:343` and `:393`)                                       | No   |

A reply here is one request to the model, so a turn that runs tools makes several, and each replaces the counts. Both fields are `null` until the first reply.

A committed reply changes the public state, so that change's `projection_delta` ends with a `set_envelope` step, and that step holds the whole state, `session.contextUsage` in it (`_advance`, `_projection.py:643`, and `compute_projection_delta`, `_storage.py:1130`). It is journaled as the reply is committed (`_persist_core_transition`, `_runtime.py:3977`), not while the model streams it (`_advance_provisional`, `_projection.py:654`). A save writes the same state to the generation's `projection-state.json`. So the newest state the adapter already reads for the status holds the newest reply's counts, and the journal's wins over the generation's, as it does for the status.

### What each count holds

Vibe fills a usage from what the provider sent (`USAGE_FIELDS`, `completion_profile/formats.py:116`, at 3.0.4, read by `reply_token_usage`, `adapters/_reply_usage.py`):

| Provider's format    | `inputTokens`                                                                        | `cachedInputTokens`                   | `outputTokens`      |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------- | ------------------- |
| Mistral, OpenAI Chat | `prompt_tokens`                                                                      | `prompt_tokens_details.cached_tokens` | `completion_tokens` |
| OpenAI Responses     | `input_tokens`                                                                       | `input_tokens_details.cached_tokens`  | `output_tokens`     |
| Anthropic            | `input_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens` together | `cache_read_input_tokens`             | `output_tokens`     |
| Ollama               | `prompt_eval_count`                                                                  | None, so 0                            | `eval_count`        |

2.26.1 reads the same fields but Ollama's, which it has no format for, in other code (`_usage` in `adapters/mistral.py`, `adapters/generic/_anthropic.py`, and `_token_usage` in `adapters/generic/_execute.py`). In both, an Anthropic reply's cache counts are added to its input so that the input holds them, and `cachedInputTokens` is 0 for a count the provider did not send (`read_usage`, `formats.py:188`, at 3.0.4).

`outputTokens` is the provider's own count. At 3.0.4 Vibe's core holds `reasoning_tokens` apart, which the public state does not carry, and a total is the input and the output alone. OpenAI and Anthropic count reasoning in their output, as [Qwen Code's notes](qwen-code.md#token-counts) say. Vibe's source does not say whether Mistral's `completion_tokens` does, so whether Out includes a reply's thinking is not known.

| Shown  | Read from                     |
| ------ | ----------------------------- |
| In     | `inputTokens`                 |
| Cached | `cachedInputTokens`, unless 0 |
| Out    | `outputTokens`                |

`replyTokensOf` in `envelope.ts` takes these three numbers and reads `totalTokens` only to check them, `tokenCountsOf` in `src/core/tokens/tokenCounts.ts` checks them, and `mistralVibeSession` in `toSession.ts` puts them on the session.

### What a session shows

- A newer reply's counts show on the poll that reads its record.
- The counts stand while the session waits for you, once it is idle or failed and once it is finished. Nothing but a reply, a compaction or a rewind changes what shows, and a state Vibe writes for anything else, such as a rename, holds the same counts.
- A reply with no usage leaves the counts of the reply before it (`_projection.py:336`). Up to 3.0.2 a provider that sends none does this. From 3.0.3, a reply without usage fails its turn (`CHANGELOG.md`).
- A compaction sets every count to 0, since nothing has measured the summary it made until the next reply reports (`_projection.py:397`). That gives a dash, never an older reply's counts, as for [Codex](codex.md), until the next reply.
- A `/rewind` in place gives a dash until the next turn starts. Vibe cuts the history, sets `latestTurn` to null in the generation it saves and leaves `session.contextUsage` as it was, though the reply it counted may be gone (`rewind`, `_host.py:1275`). Nothing else in Vibe sets `latestTurn` to null, so a state with no turn gives no counts. [Known gaps](#known-gaps) says what shows once the next turn starts.
- A session that has never had a reply has a dash.
- A `cachedInputTokens` of 0 is left out, and the details say only Newest reply: Vibe writes 0 for a provider that sent no cached count, and the state cannot tell that from a cache that held none.
- Counts that could not be right give a dash, never an older reply's: a `contextUsage` that is not an object; an `inputTokens` that is missing, 0, negative, not a whole number or past what a JavaScript number holds exactly; an `outputTokens` that is missing, negative, not a whole number or past that; a `cachedInputTokens` that is negative, not a whole number, past that or larger than the input; and a `totalTokens` that is missing, past that or not the input and the output together, since Vibe refuses such a usage itself (`validate_token_usage`, `harness/core/src/core/wire/completion.rs`).
- While the newest state is not known, the session has no counts, as it has no status: a record whose state is not read, or none found in what was read of a long segment. The generation's counts are not shown in their place, since they can be an older reply's.
- A store newer than minor 10 shows none, as it shows no status: its counts may not mean what these do.

A session's counts are its own replies'. A subagent has a session of its own, whose counts are in its own store, which is not read.

The three numbers are kept in memory, with the rest of what is kept of a public state, and go where a session's `tokens` go: the snapshot, `GET /api/sessions` and the session's details, never an event, the history, a notification, an email, a webhook post, a push, an MCP answer or `agent-lookout status`.

## Known gaps

- What a session last said is not read yet.
- After a `/rewind` in place, from when the next turn starts until a reply reports, Tokens can be the counts of a reply the rewind took back. That state has a turn and the old `session.contextUsage`, and nothing in it tells those counts from ones that still stand.
- A subagent's wait shows its session as working. Vibe journals it in the subagent's own store, `unified/child-…`, and gathers it for its clients in memory (`open_callbacks`, `_host.py:1797`). That store is not read.
- A callback whose record is longer than 8 MiB, read for the first time, or among more than 8 MiB added at once, is not read, since its start is past what is read, and the session shows with no status until Vibe writes a state. A wait saved in a generation is not taken as open while its segment has grown past 8 MiB on a first read, and the session shows as working.
- A wait left behind in a lease whose process ID another program has since been given shows as needing you, until that program ends, when `ps` cannot tell: on Linux and Windows, where it is not run, unless the adapter found the process gone first and still remembers that, when it gives no answer, or with a program that started within a minute of the lease. Keep awake counts it all the while, on a Mac that watches that computer over SSH too.
- A clock set back by more than a minute between a Vibe's start and its taking a lease can make `ps`, on a Mac, say another program has the lease, and the session shows as finished until a program takes the lease again. A clock set back between a turn's start, or a lease, and a callback, makes the callback look left behind, and the session shows as working. A session's last write ahead of the clock, as after a clock set back or on a network folder with a fast clock, puts off asking `ps` about a lease with no wait until the clock is a minute past that write, and until then the session stays as it is.
- Vibe's desktop app lets go of an idle session's process a second after each turn (`README.md`), so its sessions are finished between turns and working again at the next. Whether the editor extension and ACP hold the lease while a session is shown is not known.
- A lease left behind looks held while its process ID belongs to another program that cannot be told from Vibe: on Linux and Windows, unless the adapter found the process gone first and still remembers that, since neither a start time nor a program's name is sure there (see [When a lease's process ID goes to another program](#when-a-leases-process-id-goes-to-another-program)), and on a Mac when `ps` gives no answer or the program started within a minute of the lease. On a Mac, a lease `ps` answered for is not asked about again while no poll finds its process gone, so a Vibe that crashed and had its process ID given out again between two polls is not seen, unless its session waits. A lock left with no process ID looks held for good, and one whose `.lock.json` changed and cannot be read, or has never been read, looks held for as long as that lasts.
- A finished session shows as open while Vibe holds its lease, from when Vibe writes to it under the lease, as to rename it, or from 30 seconds into the lease, as in a long clearing of old output. That adds two entries to the Events log and sends Finished again. A session a program reopens shows as finished for up to 30 seconds, until Vibe writes to it. One last written to more than a day ago is listed only once its lease is 30 seconds old, so a clearing of old output that takes longer than that lists it too.
- A Vibe that stops mid-turn without closing records no error, so the session shows as finished once its process is gone.
- A failure Vibe reports only to its clients, as when a turn cannot start, may never reach the files, so the session shows as idle or working.
- A session folder moved by `save_dir` is not followed.
- From 3.0.0, a session's move to another folder is journaled as `session_relocated`, which is not read, so the old folder shows until Vibe next saves the session.
- Sessions of the older engine are not listed.
- On Windows Vibe locks a lease another way, and the folder is taken to be `%USERPROFILE%\.vibe\logs\session`. Neither has been checked.
- On Windows Vibe replaces `CURRENT` with `MoveFileExW`, which can fail while another program has the file open, and it does not try again (`_windows_replace`). So a save of Vibe's that comes during the moment Agent Lookout reads `CURRENT`, each time it changes, may fail. This has not been checked.

## Not yet checked

All of this comes from Vibe's source. A computer running Vibe has yet to show:

- that real journal lines are laid out as above: `type` last, `set_envelope` the last step, `}],"watermark":` right after the state;
- that a real `callback_registered` line begins as above, and a real wait shows as needing you within a poll of the prompt;
- that a real `session.contextUsage` is laid out as above and changes with each reply, and that a real `/rewind` in place leaves it with `latestTurn` null;
- what closing a terminal does to a Vibe that waits: whether it closes its callbacks or is killed with them;
- whether the terminal app holds its lease from start to quit, and which process its `process_id` is;
- that, however Vibe is started, the process a lease names started before its `acquired_at`, as the check on a Mac takes it to;
- what a crash leaves behind, and whether reopening the session rewrites its status;
- how large real stores and journal segments grow, against the limits above;
- whether the older engine's sessions are still common on real machines;
- on Windows, whether Agent Lookout's read of `CURRENT` can make Vibe's replacing it fail.

## What breaks when Vibe changes

- A store minor above 10: those sessions show with no status and no token counts until the adapter knows the new minor.
- A field renamed in `CURRENT`, the manifest, the public state or the runtime state.
- Journal lines with `type` no longer last, or a step after `set_envelope`: states are no longer read, and sessions show as unknown.
- `session.contextUsage` renamed, or a `totalTokens` that is no longer the input and the output together: sessions show a dash for Tokens. `inputTokens` or `outputTokens` given a new meaning with no new minor would show wrong counts, since a file cannot say so.
- A key that sorts before `callbackId` or `createdAt` in a callback, or a callback's fields renamed: waits are no longer read, and sessions that wait show as working. So does a new kind of callback.
- `acquired_at` written another way, which leaves a lease with no time: no wait shows.
- A lease handed to a process that starts after it was taken, with `acquired_at` left as it was: on a Mac its session shows as finished.
- A new lease format, or leases moved out of `active/`. An `acquired_at` written another way leaves a session Vibe last wrote to more than a day ago out while a program holds it, and shows a held session as finished for the first 30 seconds a poll finds it, until Vibe writes to it.
- The session folder moving from `logs/session`.
