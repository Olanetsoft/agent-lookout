# Mistral Vibe adapter notes

These notes record what Agent Lookout reads from Mistral Vibe, where each value comes from, and what breaks when Vibe changes. Vibe does not document these files for other programs, so when the adapter stops working, start here.

Built on 2026-10-14 from the source of Mistral Vibe 2.26.1, released 2026-10-09 (tag `v2.26.1`, commit `4ae5c59` of [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe)), with its store at format `mistral.vibe.unified-session-store/v1`, minor 8. **Vibe was not installed on the machine where the adapter was written, and nothing here has been checked on a computer running Vibe.** Everything below comes from Vibe's source and from hand-written files laid out the same way. A citation is a path in that repository at `v2.26.1`. `harness/…/vibe/` stands for `harness/runtimes/python/python/mistralai_vibe_local_harness/vibe/`.

The code is in `src/collector/adapters/mistral-vibe/`, and the status mapping is in `src/core/mapping/mistralVibeMapping.ts`.

This version reads working, idle, finished and failed, the name, the folder and Quiet for. It does not read Needs you, token counts or what a session last said yet, and it does not list sessions Vibe ran on its older engine.

## How it reads Vibe, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no program run, no network. It reads Vibe's session folder, read-only.

Vibe documents no listing of its sessions for another program. `vibe --resume` is a picker for a person (`README.md`), and Vibe's app server lists sessions only for the clients it serves. So the adapter reads the files Vibe's own list is built from (`harness/…/vibe/_host.py`, `_list`).

## What it reads

| Path, under the session folder          | How                                                                                                                                                        | How often                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The session folder itself               | One `stat`                                                                                                                                                 | Every poll, and once a minute while it is missing, unless `AGENT_LOOKOUT_VIBE_SESSION_DIR` names it                                                                                                                                                                      |
| `unified/`                              | One `lstat`, to see whether it changed                                                                                                                     | Every poll                                                                                                                                                                                                                                                               |
| `active/`                               | Listed. A `<session ID>.lock` is never opened                                                                                                              | Every poll                                                                                                                                                                                                                                                               |
| `active/<session ID>.lock.json`         | `lstat`, then opened read-only, at most 4 KiB, for a session with a lock                                                                                   | When its size, modified time or identity changes                                                                                                                                                                                                                         |
| `unified/<session ID>/CURRENT`          | `lstat`, then opened read-only, at most 4 KiB                                                                                                              | `lstat` every poll for each followed session. Read when it changes                                                                                                                                                                                                       |
| `generations/<g>/manifest.json`         | Opened read-only, at most 256 KiB                                                                                                                          | Once for each generation, while the session is followed                                                                                                                                                                                                                  |
| `generations/<g>/projection-state.json` | Opened read-only, at most 4 MiB                                                                                                                            | Once for each generation, while the session is followed                                                                                                                                                                                                                  |
| `generations/<g>/runtime-state.json`    | Opened read-only, at most 8 MiB                                                                                                                            | Once for each generation, while the session is followed                                                                                                                                                                                                                  |
| `journal/<16 digits>.jsonl`             | `lstat`, then opened read-only: the last 8 MiB the first time, then only what was added                                                                    | `lstat` every poll for each followed session. Read when it changes                                                                                                                                                                                                       |
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

| `active/`                                               | Held                                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Missing, or cannot be listed                            | Not known. No session is shown as finished, and the poll is named apart |
| No `<session ID>.lock`                                  | No                                                                      |
| A lock, and a `.lock.json` naming a process that exists | Yes                                                                     |
| A lock, and a `.lock.json` naming one that does not     | No: a lease a crashed program left behind                               |
| A lock, and no `.lock.json`, or one empty or torn       | Yes: a program taking the lease                                         |

What that costs:

- A lease left behind whose process ID another program has since been given looks held, until that program ends.
- A program that crashed between making the lock and writing the `.lock.json` leaves a lock that looks held for good.
- Vibe takes the lease of a stored session for a moment when it renames, forks, imports or deletes it, and when it clears the output of processes the session ran (`_host.py`, `_run_process_output_cleanup`). To clear that output, Vibe takes the lease of every stored session that ran a process, however old, and holds them all until it is done (`_cleanup_process_output_once`). So a lease taken less than 30 seconds ago, by the `acquired_at` the `.lock.json` gives, does not show a session as open until Vibe writes to it, and a session Vibe last wrote to more than a day ago is listed only once its lease has been held for 30 seconds. Until then nothing in its store is opened. A lease whose `acquired_at` cannot be read yet, as between making the lock and writing the `.lock.json`, counts as taken at the poll that first finds it so. A session a program reopens shows as finished for up to 30 seconds, until Vibe writes to it.
- A finished session still shows as open while Vibe holds its lease in two cases: once Vibe writes to it under the lease, as when it renames it or marks as orphaned the processes a crashed Vibe left running (`reconcile_orphaned_processes`), and once Vibe has held the lease for 30 seconds, as a long clearing of old output can. It shows as open until Vibe lets go. Each time, the Events log gets two entries, the change to open and the change back, and Finished is sent again wherever you chose to get it.

The folder also holds Vibe's short-lived `.watch-<hex>` files and the lease Vibe takes while it clears old process output, `process-output-cleanup`, which belongs to no session. Both are left alone, and so are the leases of subagents, whose ids begin with `child-`. A `.lock.json` with no `.lock` beside it is a lease Vibe let go of and could not delete, and is not read.

### `CURRENT` and its generation

Each session's store is `unified/<session ID>/` (`_storage.py`). Every file in it is JSON with sorted keys and no spaces, ending in a newline, replaced whole through a temporary file and a rename (`canonical_json`, `_replace_document`).

`CURRENT` names the session's newest saved state, a generation: `store_format`, `store_format_minor`, `session_id`, `generation`, 16 digits, `snapshot_sequence` and `manifest_sha256` (`CurrentPointerV1`). The adapter reads it whole when it changes, and goes on only when the format is `mistral.vibe.unified-session-store/v1`, the session ID is the folder's and the generation is 16 digits.

Vibe's readers accept a store of their own minor or lower and refuse a higher one (`STORE_FORMAT_MINOR = 8`). A field Vibe adds raises no minor (`_StoredModel`). The adapter does the same: it reads any minor up to 8, keeps no key it does not know, and shows a session whose store has a higher minor with no status, with its name and folder when they still read, and a sentence on the card.

When `CURRENT` names a generation not read before, the adapter reads, once each while it follows the session, since Vibe never changes them:

- `generations/<g>/manifest.json` (`GenerationManifestV1`), for the journal segment that follows the generation, `recovery_journal_segment.path`, kept only if it is `journal/<16 digits>.jsonl`. The segment's name is taken from here, never from the newest file in `journal/`: Vibe makes the next segment before it moves `CURRENT`. The manifest also names the two files below, which are opened only when it names them `projection-state.json` and `runtime-state.json`, as Vibe always does (`write_generation`), so no manifest can lead to `checkpoint.json`.
- `generations/<g>/projection-state.json` (`ProjectionStateV1`), whose `snapshot` is the session's public state, in camelCase (`harness/…/session_protocol.py`, `PublicSessionState`). It is the state when the generation was saved.
- `generations/<g>/runtime-state.json` (`RuntimeStateV3`), for `session_metadata.cwd`, the session's folder, `identity.kind`, `root`, `fork` or `subagent`, and `lifecycle.type`, `deleting_tree` while Vibe deletes it.

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
- a `projection_advanced` record, a whole state that no build from 2.25.7 on writes, is a state the adapter does not read: the status is not known until a newer state or a save.

The first read of a segment looks back from its end through at most 8 MiB for the newest line that sets the state. A single line can be longer, up to Vibe's 64 MiB, and the state, which comes last on it, is still read from its end. After that, only what was added is read, at most 8 MiB at a time. A segment that shrinks, is replaced or grows by more than that is read afresh from its end.

The newest state in the segment wins over the generation's. Vibe saves a session whole when a turn ends with nothing left running and the journal holds something, and when its folder, model or settings change (`harness/…/vibe/_runtime.py`). A rename, and the title Vibe makes for a session in the background, are journaled with no save after them. So the generation's state is often older than the journal's, and an idle session's segment is often not empty.

From a public state the adapter keeps `session.title`, `session.status.type`, `session.createdAt`, `session.updatedAt`, and `latestTurn.status`, `startedAt` and `completedAt`. It drops the rest, which includes `session.preview`, the first thing you asked, every error in full, the queue of prompts and the requests waiting for an answer. Vibe 2.26.1 began writing `latestTurn.stopReason` as `limit` or `length` with no new minor, so values and keys the adapter does not know are left where they are.

## Which sessions are listed

A session is followed for a day after Vibe last wrote to its `CURRENT` or a segment of its journal, and while a Vibe program holds its lease. One Vibe last wrote to before that is listed only once a program that runs has held its lease for 30 seconds, since Vibe takes the lease of every old session that ran a process for as long as it takes to clear their output. Until then, and for a lease a crashed program left behind, nothing in its store is opened. The stores of sessions no program holds are found by the look through `unified/`. Vibe rewrites its own index there, `unified/.session-index.json`, each time one of its programs lists sessions after any session changed (`harness/…/vibe/_session_catalog.py`), so the folder's time moves far more often than sessions are made. That is why the look comes at most every 30 seconds. A session a program holds is found through its lease on every poll.

Left out:

- subagents: an id that begins with `child-` (`harness/…/vibe/_subagents/_operations.py`), or a store whose `identity.kind` is `subagent`, as Vibe's own list leaves them out;
- a session being deleted, `lifecycle.type` `deleting_tree`;
- a lease with no store yet: Vibe takes a new session's lease before it saves anything, and drops the folder if the session closes unused. It appears once Vibe saves it;
- sessions Vibe ran on its older engine, `<prefix>_<YYYYmmdd>_<HHMMSS>_<id[:8]>/` with `meta.json` and `messages.jsonl` (`vibe/core/session/session_logger.py`). Vibe 2.26.0 made the unified engine the default (`CHANGELOG.md`), and `--legacy-harness` still selects the older one. When it saved one in the last day, the card says those sessions are not shown. Nothing in their folders is opened.

Forks are listed: their `parentSessionId` is set, as a subagent's is, so the kind decides, not the parent.

## Status

| `session.status.type`                   | Held              | Status   |
| --------------------------------------- | ----------------- | -------- |
| not read, or a store newer than minor 8 | any               | unknown  |
| `failed`                                | any               | failed   |
| `idle`, `running`, `blocked`            | no                | finished |
| `running`                               | yes, or not known | working  |
| `blocked`                               | yes, or not known | working  |
| `idle`                                  | yes, or not known | idle     |
| `archived`, or anything else            | any               | unknown  |

The projector writes only `running`, `failed` and `idle` (`harness/…/vibe/_projection.py`). Vibe stamps `blocked` only on the state it holds in memory, and `archived` only on what its app server sends, so neither is expected on disk. A session waiting for your approval or an answer reads as `running`, and shows as working until Needs you is read. A failed turn stays failed once no program holds the session.

The status time is when the newest turn began while it works, when it ended once it is idle or failed, and the state's last change once it is finished, each from the public state. An unknown status has no time.

## Names, folders and apps

A session is named by its title, then its folder's name, then its id. Never by `preview`, the first thing you asked, which Vibe shows in its place when it has no title. With `[session_logging] generate_titles = false`, Vibe gives no title, so the folder names it. The folder is `session_metadata.cwd`, which Vibe rewrites when a session moves, as into a worktree.

The files do not say whether a session runs in the terminal, an editor, the app server for ACP or the desktop app, so no app is shown. There is no Jump, Stop or pid: the process that holds a lease can hold many sessions' leases, as an app server does.

## Quiet for

Quiet for is the journal segment's own modified time. Every record Vibe adds moves it, and a save starts a new segment. Nothing is journaled while a model streams its reply, so a long reply can read as quiet.

## Known gaps

- Needs you, token counts and what a session last said are not read yet.
- Vibe's desktop app lets go of an idle session's process a second after each turn (`README.md`), so its sessions are finished between turns and working again at the next. Whether the editor extension and ACP hold the lease while a session is shown is not known.
- A lease left behind looks held while its process ID belongs to another program, and a lock left with no process ID looks held for good.
- A finished session shows as open while Vibe holds its lease, from when Vibe writes to it under the lease, as to rename it, or from 30 seconds into the lease, as in a long clearing of old output. That adds two entries to the Events log and sends Finished again. A session a program reopens shows as finished for up to 30 seconds, until Vibe writes to it. One last written to more than a day ago is listed only once its lease is 30 seconds old, so a clearing of old output that takes longer than that lists it too.
- A Vibe that stops mid-turn without closing records no error, so the session shows as finished once its process is gone.
- A failure Vibe reports only to its clients, as when a turn cannot start, may never reach the files, so the session shows as idle or working.
- A session folder moved by `save_dir` is not followed.
- Sessions of the older engine are not listed.
- On Windows Vibe locks a lease another way, and the folder is taken to be `%USERPROFILE%\.vibe\logs\session`. Neither has been checked.
- On Windows Vibe replaces `CURRENT` with `MoveFileExW`, which can fail while another program has the file open, and it does not try again (`_windows_replace`). So a save of Vibe's that comes during the moment Agent Lookout reads `CURRENT`, each time it changes, may fail. This has not been checked.

## Not yet checked

All of this comes from Vibe's source. A computer running Vibe has yet to show:

- that real journal lines are laid out as above: `type` last, `set_envelope` the last step, `}],"watermark":` right after the state;
- whether the terminal app holds its lease from start to quit, and which process its `process_id` is;
- what a crash leaves behind, and whether reopening the session rewrites its status;
- how large real stores and journal segments grow, against the limits above;
- whether the older engine's sessions are still common on real machines;
- on Windows, whether Agent Lookout's read of `CURRENT` can make Vibe's replacing it fail.

## What breaks when Vibe changes

- A store minor above 8: those sessions show with no status until the adapter knows the new minor.
- A field renamed in `CURRENT`, the manifest, the public state or the runtime state.
- Journal lines with `type` no longer last, or a step after `set_envelope`: states are no longer read, and sessions show as unknown.
- A new lease format, or leases moved out of `active/`. An `acquired_at` written another way leaves a session Vibe last wrote to more than a day ago out while a program holds it, and shows a held session as finished for the first 30 seconds a poll finds it, until Vibe writes to it.
- The session folder moving from `logs/session`.
