# Autohand Code adapter notes

These notes record what Agent Lookout reads from Autohand Code, where each value comes from, and what breaks when Autohand Code changes. When the adapter stops working, start here.

Written on 2026-11-17 from Autohand Code's source at `v0.9.11`, released 2026-11-12 (commit `46a28b1` of [autohandai/code-cli](https://github.com/autohandai/code-cli)), the newest release then. Autohand Code is Autohand AI's terminal coding agent, `autohand`, under the Apache-2.0 licence. It was not installed or run to write these notes, and no real session was looked at. The fixtures are written by hand from the source. **The adapter was built from Autohand Code's source at v0.9.11 and has not yet been checked on a computer running Autohand Code.** The Sources view says so too.

Each citation is `path:line` at `v0.9.11`, from the top of Autohand Code's repository. The lines were counted on the raw files.

The code is in `src/collector/adapters/autohand-code/`. `index.ts` builds the adapter and keeps what it remembers of each session, `folders.ts` finds the folder and says which files may be read, `jsonBytes.ts` finds a field in a file's bytes, `heartbeats.ts` reads the heartbeats, `metadata.ts` reads each session's `metadata.json`, and `toSession.ts` makes the session. The status is given by `src/core/mapping/autohand-code/autohandCodeMapping.ts`.

## What this covers

Autohand Code keeps each session in a folder of its own, `~/.autohand/sessions/<id>/`, and, while a session runs, rewrites a heartbeat for it in `~/.autohand/active-agents` every 5 seconds for other programs to read (`src/session/ActiveAgentRegistry.ts:14`, `:202-252`). This adapter reads both.

- Heartbeats need Autohand Code 0.9.3 or later. From 0.9.3 to 0.9.7 a heartbeat is written in place; from 0.9.8 it is written to a temporary file and renamed, under a lock, and can carry an instance's ID in its name.
- `metadata.json` is written through a temporary file from 0.9.6 on, and in place before.
- A teammate of an agent team runs with no heartbeat and no session of its own (`src/modes/teammate.ts:74-174`), so it is not listed. The lead's session covers it, and a lead can be idle while its teammates work (`docs/teams.md:174-176`).

## How it reads Autohand Code, and why

It needs nothing installed and changes nothing. It reads the heartbeats and each session's `metadata.json`, read-only, and asks whether a heartbeat's process runs with signal 0, which sends the process nothing. It runs no Autohand Code program, opens no settings file, and never connects to the socket a heartbeat names.

- **It reads the folder itself.** Autohand Code's own reader of heartbeats, `listActive`, deletes every heartbeat it finds stale or cannot read (`src/session/ActiveAgentRegistry.ts:104-136`, `:154-169`), so it is never run, and neither is `autohand agents`, which calls it (`src/commands/agents.ts:95-101`).
- **Fields are found as bytes, not parsed.** A heartbeat holds the instruction the session works on, the command it runs and the files it wrote. A `metadata.json` holds the start of your last message and a title that can be your first words. So the few fields kept are found in the file's bytes, and nothing else is turned into text: see [Finding a field](#finding-a-field).
- **It reads only what Autohand Code reads.** Autohand Code takes a heartbeat only as an ordinary file with one name, of 131,072 bytes or less, and on macOS and Linux only one of the user it runs as that no one else may read or write, in an `active-agents` folder of that user (`src/session/ActiveAgentRegistry.ts:138-152`). Agent Lookout holds every heartbeat it reads to the same rule, and each `metadata.json` to it but for its size and mode, as [What it reads](#what-it-reads) says.

## What it reads

| Path                          | How                                                                                                                                 | How often                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `active-agents/`              | One `lstat`, then listed                                                                                                            | The `lstat` every poll, the listing when its modified time moves and once a minute                                               |
| `active-agents/<name>.json`   | One `lstat`. When it changed, opened read-only without following a link, and its first 4 KiB read, and at most 16 KiB               | Every poll, at most 200 of them: when there are more, the 200 written most recently                                              |
| `sessions/`                   | Listed                                                                                                                              | Every poll                                                                                                                       |
| `sessions/<id>/`              | One `lstat`, to see that it is a folder of this user's and not a link                                                               | Every poll for a session shown, a folder a heartbeat or the memory names and a new folder, and once a minute for every other one |
| `sessions/<id>/metadata.json` | One `lstat`. When it changed and its session is shown, opened read-only without following a link, and read whole when 1 MiB or less | The same                                                                                                                         |

A heartbeat and a `metadata.json` are read only as an ordinary file with one name. On macOS and Linux each one, `active-agents` and each session's folder must belong to the user Agent Lookout runs as, and a heartbeat must be one no one else may read or write. A `metadata.json` is not held to that: one the importer writes is readable by others (`src/import/importers/BaseImporter.ts:216`), and a later write keeps the mode it finds (`src/utils/atomicFile.ts:551-554`). Each is checked on the `lstat` and again on the open file. Autohand Code's own folder and `sessions` may be links, and are followed.

Never opened, and never looked up:

- `config.json`, `config.toml`, `config.yaml`, `config.yml` and the file `AUTOHAND_CONFIG` names (`src/config.ts:240-263`), which hold API keys and sign-in tokens;
- `sessions/index.json`, its lock, its copies and its temporary files (`src/session/SessionManager.ts:24-30`, `:449-469`), and a web transfer's temporary files (`src/session/transfer/transfer-session-store.ts:63`, `:79`);
- `conversation.jsonl`, `state.json`, `command-output/` and anything else in a session's folder;
- every `*.lock` folder, its `*.owner` file, every `*.lock.reaper`, and every temporary file and removed file, `.<name>.<pid>.<uuid>.tmp` and `.<name>.<pid>.<uuid>.tombstone` (`src/utils/atomicFile.ts:185-215`, `:541-545`, `:577-580`);
- `peer-messages/`, `peer-runtime/` and `peer-resources/` (`src/session/peers/PeerMessaging.ts:115`, `:122`; `src/core/agent/AgentPeerRuntime.ts:40`), and `telemetry/`, `memory/`, `projects/`, `plans/`, `exports/`, `mobile/`, `error.log`, `feedback.log`, `device-id`, `trusted-workspaces.json`, `feature-flags.json`, `announcements.json` and `axo.json` (`src/constants.ts:78-166`).

Nothing is created, locked, renamed, chmod'd or deleted. A heartbeat whose process has gone is left where it is.

## The folders

The first of these that applies is used:

| Setting                       | Autohand Code's folder                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `AGENT_LOOKOUT_AUTOHAND_HOME` | That folder, for Agent Lookout alone. A relative one is taken from the folder Agent Lookout runs in                           |
| `AUTOHAND_HOME`               | That folder, when it is a whole path, and on Windows not the Windows folder or one in it (`src/constants.ts:17-20`, `:41-45`) |
| None                          | `~/.autohand`, which on Windows is `%USERPROFILE%\.autohand` (`src/constants.ts:47-65`)                                       |

Heartbeats are in `active-agents` there and sessions in `sessions` (`src/constants.ts:83`, `:88`).

- Autohand Code takes `AUTOHAND_HOME` trimmed, with nothing in it meaning none, as it is given: `~` is not the home folder, and a relative one is read from the folder Autohand Code was started in (`src/constants.ts:41-45`). That folder is not known here, so a relative `AUTOHAND_HOME` is passed over.
- On Windows, when `USERPROFILE` is not set or is a system folder, Autohand Code goes on to `HOMEDRIVE` and `HOMEPATH`, then to the folder above `AppData` (`src/constants.ts:51-65`). Agent Lookout takes the home folder Node gives, which is normally `USERPROFILE`.
- An alpha build's launcher sets `AUTOHAND_HOME` to `~/.autohand-alpha/profile.<random>` (`install.sh:127-141`). Name that folder with `AGENT_LOOKOUT_AUTOHAND_HOME` to read it.
- With peer communication on, `sessions.communication.coordinationDirectory` moves heartbeats to `<that folder>/active-agents` (`src/core/agent.ts:3201-3203`). That setting is in Autohand Code's settings, which are never read, so such heartbeats are not found, and the sessions show as unknown. So does a `--set` given for one run (`src/runConfigOverlay.ts:20`, `:69-76`).

When neither `sessions` nor `active-agents` is there, Autohand Code is reported as not found, with no advice, and looked for again once a minute, or on every poll when `AGENT_LOOKOUT_AUTOHAND_HOME` is set. When that setting names a folder with neither, that is an answer, not a missing Autohand Code. A `sessions` folder that cannot be listed is an error. An `active-agents` folder that is missing, a link, another user's or cannot be listed leaves the sessions read from `metadata.json` alone, the way of reading named `files-without-heartbeats`, and the Sources view says so.

## Finding a field

Every writer of a heartbeat and of a `metadata.json` writes `JSON.stringify(value, null, 2)`: `atomicWriteJson` (`src/utils/atomicFile.ts:523-534`), the importer (`src/import/importers/BaseImporter.ts:216`), the web transfer (`src/session/transfer/transfer-session-store.ts:67`), and Autohand Code 0.9.3's heartbeat. Such text has a line break only between its parts: inside a string JSON writes one as `\n`. Each key of the outer object is on a line of its own after exactly two spaces, and each key of an object inside it after four or more. So the bytes of a line break, two spaces and `"<key>": ` can only begin a key of the outer object, and each field is found by them. A file written another way has no such bytes, and its fields are then not known, never wrong.

Each byte is compared as a number. Only two functions in `jsonBytes.ts` turn bytes into text, and no other code in the adapter's folder does: one for bytes already checked against a short list, such as the digits and signs of a time, and one that gives a single JSON string, from its opening quote to the first quote no backslash escapes, to `JSON.parse`. When that fails, the error, whose words can hold the bytes, is dropped. A test holds the folder to it.

## The heartbeat

A heartbeat is `active-agents/<session ID>.json`, or `<session ID>.<instance ID>.json` with peer communication on, the ID's other characters made `_` (`src/session/ActiveAgentRegistry.ts:88`, `:171-175`). Its name must be its own session's, or it is not read.

Two writers write it. The main one, on each 5-second tick, at each saved message and at each change of status (`src/session/ActiveAgentRegistry.ts:202-252`; `src/core/agent.ts:3133-3136`), puts its keys in this order: `version`, `pid`, `sessionId`, `workspaceRoot`, `projectName`, `provider`, `model`, `mode`, `status`, `startedAt`, `updatedAt`, the counts, `activity`, then `communication` (`:224-243`). With peer communication on, the presence writer writes once as it starts, with the folder's real path, mode `interactive`, and `communication` before `activity` (`src/session/peers/PeerMessaging.ts:228`, `:254-268`). The main writer's next write takes its place.

In both, `phase` is the first key of `activity`, before the instruction (`src/session/peers/PeerActivityPublisher.ts:60-61`; `src/core/agent.ts:3166`). So `\n  "activity": {\n    "phase": "` is found first, and the other keys are looked for only in the bytes before it. With no `activity`, they are looked for in what was read, and the stage is not known.

| Field                    | What is checked                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `phase`                  | `idle`, `thinking`, `editing`, `running_command` or `waiting_input`, compared as bytes. Another word is a stage not known |
| `version`                | `1`. Another number is a newer format, which is not read                                                                  |
| `pid`                    | 1 to 10 digits                                                                                                            |
| `sessionId`              | 1 to 200 letters, digits, `_`, `.` or `-`                                                                                 |
| `startedAt`, `updatedAt` | At most 40 of the bytes of a time as `Date.toISOString()` writes it                                                       |
| `mode`                   | `interactive`, `command` or `rpc`, compared as bytes (`src/session/ActiveAgentRegistry.ts:313-317`)                       |
| `workspaceRoot`          | One JSON string of at most 8 KiB, kept only when it is a whole path                                                       |

Never looked for: `projectName`, `provider`, `model`, `status`, which can lag `phase` (`src/core/agent.ts:3133-3136`), and the counts. Never looked for or turned into text: `activity.instruction`, which is up to 200 characters of the instruction the session works on (`src/session/peers/PeerActivityPublisher.ts:87-96`), `command`, `pathsWritten`, `claims`, `headRef`, and all of `communication`, whose socket is never connected to.

`startedAt` is when the session was made, not when its process started (`src/session/ActiveAgentRegistry.ts:234`). `updatedAt` is when the heartbeat was written (`:235`), and a heartbeat over 15 seconds old is stale, as Autohand Code judges it (`:15`, `:131-136`).

A heartbeat's first 4 KiB are read, and more, to at most 16 KiB in all, only when its stage is not in those. One over 128 KiB is not read. An unchanged one is not opened again. One that cannot be read once, as one written in place can be caught half written, stands in from the read before, once.

## metadata.json

`createSession` writes `sessionId`, `createdAt`, `lastActiveAt`, `projectPath`, `projectName`, `model`, `messageCount`, `status` and `client` (`src/session/SessionManager.ts:133-162`). A title, usage, the files read and, at the close, `closedAt` and `summary` come after them. The importer writes `summary` before `status` (`src/import/importers/BaseImporter.ts:198-214`), and a web transfer another order (`src/session/transfer/transfer-session-store.ts:64-66`). So each key is looked for in the whole file.

| Field                                   | What is checked                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------ |
| `status`                                | `active`, `completed` or `crashed`, compared as bytes. Another word is one not known |
| `createdAt`, `lastActiveAt`, `closedAt` | A time                                                                               |
| `projectPath`                           | One JSON string of at most 8 KiB, kept only when it is a whole path                  |
| `client`                                | `terminal` or `vscode`, compared as bytes                                            |
| `titleSource`                           | `user`, compared as bytes                                                            |
| `title`                                 | Looked for only when `titleSource` is `user`: one JSON string of at most 1 KiB       |
| `importedAt` of `importedFrom`          | A time, looked for only inside `importedFrom`                                        |

A file is read only when it begins with `{` and ends with `}`, so one cut off as it was written in place stands in from the read before, once. One over 1 MiB is not read, and its session shows from its heartbeat.

Never looked for or turned into text: `summary`, the start of your last message (`src/core/agent/AgentSessionAccounting.ts:374-379`), `automodePrompt`, an auto-mode run's whole task (`src/index.ts:2942`), a `title` whose `titleSource` is not `user`, `readFileState`, which names the files the session read, `usage`, `branch`, `model`, `projectName`, the counts, and the rest of `importedFrom`, an account's ID among it.

### Why a title Autohand Code made is never read

`titleSource` is `auto` for two kinds of title, which cannot be told apart. The first is the start of your first instruction, up to 7 words or 48 characters (`src/core/agent/SessionAutoNamer.ts:20-38`; `src/core/agent/AgentSessionTitle.ts:48-59`). The second is a model's name for the session, written later the same way (`AgentSessionTitle.ts:65-83`). `user` comes only from `/rename` (`src/commands/rename.ts:39`) and `renameSession` (`src/session/SessionManager.ts:402-429`), which `autohand --rename` runs (`src/index.ts:527`, `:667-675`; `src/startup/renameSession.ts:16-28`). That command exists so a session can be named from a script, so a name set with it may not be yours. A fork copies the name of the session it came from (`src/session/SessionManager.ts:240-241`).

## Which sessions are listed

A session is listed while it has a fresh heartbeat whose process runs, while a status is held over a late poll, and for a day after its heartbeat was last written or its `metadata.json` was. A `metadata.json` last written over a day ago is opened only when a heartbeat of the last day names its session.

Left out:

- A run with `--ephemeral`, which keeps no session files (`src/index.ts:528`; `src/session/SessionManager.ts:111-131`), still writes a heartbeat (`src/core/agent.ts:3142-3238`). A heartbeat whose session has no folder in `sessions` is not listed, so such a run is left out, as it asks.
- A heartbeat whose session ID has a dot is never looked up in `sessions`, where its folder would be one of Autohand Code's other files, and so is not listed.
- A copy of another tool's session, or of a session from the web, that you never resumed: one written `completed` with the time of the copy, neither closed nor saved by a run of it since, with no heartbeat (`src/import/importers/BaseImporter.ts:198-216`; `src/session/transfer/transfer-session-store.ts:64-66`). One closed since, or saved since by a run of it, is listed, and so is one with a heartbeat, or that had one while Agent Lookout ran.
- A teammate, which has no heartbeat or session.
- Heartbeats of another format, whose name is not their session's, over 128 KiB, of another user, with a second name or links, and every temporary or removed file and lock.

An auto-mode run keeps a session of its own, written `type` `automode` with no heartbeat (`src/index.ts:2937-2942`), which shows as unknown while it runs and finished once closed (`:3103-3113`). Each of its iterations runs in a session of its own, with a heartbeat, that it does not close (`src/index.ts:3047-3049`; `src/core/agent/AgentLifecycleRunner.ts:1382-1392`), so each shows as finished once the next one starts, by row 5 below.

## Status

### What is remembered

Autohand Code deletes a session's heartbeat when the session closes, before it writes `completed`, or after it for the idle timeout (`src/core/agent/AgentSessionAccounting.ts:319-379`), and any Autohand Code that writes a heartbeat deletes every other one it finds stale (`src/session/ActiveAgentRegistry.ts:282`; `src/core/agent.ts:3220-3222`). A session in an editor over ACP closes no session when the editor goes: its heartbeat is deleted and its `metadata.json` stays `active` (`src/modes/acp/index.ts:88-94`; `src/modes/acp/adapter.ts:1406-1432`). So, while a session is listed, the adapter keeps in memory what its last heartbeat said: the process, the folder, the mode, when the session was made and when the heartbeat was written, and the status shown. Of text it keeps only the folder. What it read of each heartbeat is also kept while the file is there, so an unchanged one is not opened again, even for a session that is not listed. What it read of a `metadata.json` is kept too, until a look finds the file one it would not open, so an unchanged one is not opened again, as for a copy of another tool's session that you never resumed. The memory goes when Agent Lookout stops.

### The heartbeat a status is taken from

Each heartbeat of a session is one of these, by whether its process answers signal 0 and whether it was written within 15 seconds, or up to a minute ahead of this computer's clock:

- fresh: its process runs and it is recent;
- quiet: its process runs and it is older, or its time cannot be read;
- just ended: its process has gone and it is recent;
- gone: its process has gone and it is older.

A file found with its process gone stays so while it is unchanged, whatever a later process given the same ID answers. Two Autohand Codes on one session with peer communication off share one file (`src/session/ActiveAgentRegistry.ts:88`), so what each process last wrote in it counts while the file is there, it is fresh and that process runs. Of a session's heartbeats, a fresh one is taken first, and of those one that waits for input, then one that works, then an idle one. Of the others, the newest. Two alike go by name, then process, so two processes that take turns writing give the same answer.

### What metadata.json counts as

- `completed` with `lastActiveAt` more than a second past `closedAt`, or a heartbeat of the session more than 15 seconds past it, counts as `active`. Autohand Code keeps `completed` while a resumed session runs and saves nothing as it resumes one (`src/session/SessionManager.ts:164-178`), and each message moves `lastActiveAt` (`:598-611`). Every close but one stops the heartbeat first (`src/core/agent/AgentSessionAccounting.ts:350`; `src/core/agent/AgentLifecycleRunner.ts:332-336`). The idle timeout closes the session first and stops the heartbeat after (`src/core/agent/AgentSessionAccounting.ts:319-343`), and a close can wait up to 10 seconds on the session index's lock (`src/session/SessionManager.ts:26-30`, `:392-394`). For a copy of another tool's session, or of one from the web, the time of the copy counts in place of an earlier `closedAt`, or of none, as a copy from the web has none (`src/session/transfer/transfer-session-store.ts:64-66`).
- `crashed` with `lastActiveAt` no more than a second before the file was written counts as `active`. The crash's own write leaves `lastActiveAt` as it was (`src/core/agent/AgentLifecycleRunner.ts:2192-2206`), and a message saved after it moves it. A misreading can only make a session finished or unknown.

### The status

The first row that applies gives the status.

| #   | What there is                                                                                                               | Status                                |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | A fresh heartbeat that waits for input                                                                                      | Needs you, reason `other`             |
| 2   | A fresh heartbeat that thinks, edits or runs a command                                                                      | Working                               |
| 3   | A fresh heartbeat that is idle                                                                                              | Idle                                  |
| 4   | A fresh heartbeat with a stage not known, or none                                                                           | Unknown                               |
| 5   | No heartbeat, and the process of its last one, of mode `interactive` or `command`, has a fresh heartbeat of another session | Finished, or failed when it crashed   |
| 6   | A status held over a late poll                                                                                              | The status before, from the same time |
| 7   | A quiet heartbeat                                                                                                           | Unknown                               |
| 8   | A heartbeat whose process ended within 15 seconds                                                                           | Unknown                               |
| 9   | A gone heartbeat, with no save of the session over 15 seconds after it, and `crashed`                                       | Failed                                |
| 10  | A gone heartbeat, with no save of the session over 15 seconds after it                                                      | Finished                              |
| 11  | No heartbeat, and it was found ended before, or the process of its last one has gone                                        | Finished, or failed when it crashed   |
| 12  | No heartbeat, and `completed`                                                                                               | Finished                              |
| 13  | No heartbeat, and `crashed`                                                                                                 | Failed                                |
| 14  | No heartbeat, and `active` or no `metadata.json`                                                                            | Unknown                               |
| 15  | No heartbeat, and a status not known or a `metadata.json` that cannot be read                                               | Unknown                               |

"Crashed" is `metadata.json`'s status as it counts above. A session found finished or failed by rows 5, 9, 10 or 11 is remembered so, until a heartbeat of it comes back or its `lastActiveAt` moves past that moment, so a process given its ID later does not bring it back. Once its `lastActiveAt` moves past that moment, or over 15 seconds past its last heartbeat, the process of that heartbeat is forgotten, since another run saved the session, and rows 12 to 15 decide until a heartbeat comes.

- Row 1: Autohand Code sets `waiting_input` while it asks you to approve a tool and while it asks you a question (`src/core/agent.ts:2926-2948`, `:2969-2979`; `src/session/peers/PeerActivityPublisher.ts:46-52`). The two cannot be told apart.
- Row 5: an auto-mode iteration's session and a session a terminal's `/new` left are taken up by the same process (`src/core/agent/AgentLifecycleRunner.ts:325-380`, `:1132-1143`). An editor over ACP holds many sessions in one process and writes mode `rpc` (`src/modes/acp/adapter.ts:442-470`), so a process that writes `rpc` does not end a session this way.
- Rows 9 and 10: only a process that runs a session moves its `lastActiveAt`, as at each message, token count, file read, `/rename`, model change over ACP and close (`src/session/SessionManager.ts:386`, `:409`, `:601`, `:634`, `:683`, `:730`; `src/modes/acp/adapter.ts:324`). A rename from another process (`src/startup/renameSession.ts:20-29`; `src/session/SessionManager.ts:416-429`) and the crash's own write leave it as it was. A process that writes a heartbeat rewrites it every 5 seconds while it runs, so a `lastActiveAt` over 15 seconds after a heartbeat whose process has gone came from another run, as one with `--no-daemon`, and that heartbeat counts for nothing.
- Rows 9 and 13: only the interactive loop writes `crashed` (`src/core/agent/AgentLifecycleRunner.ts:2189-2211`).
- Rows 10 and 11: a process ends with no close on `kill -9`, on a second Ctrl+C (`src/core/agent/AgentLifecycleRunner.ts:629-651`), on SIGHUP, which it has no handler for, and when an editor's ACP connection closes.
- Row 12: `closeSession` (`src/session/SessionManager.ts:382-395`). A `-p` run that fails is closed as `completed` too (`src/core/agent/AgentLifecycleRunner.ts:1382-1388`), so it shows as finished.
- Row 14: a run with `--no-daemon`, which writes no heartbeat (`src/core/agent.ts:3143`), a run whose heartbeats were moved, the moment of a clean close between the heartbeat's removal and `completed`, a session left open whose heartbeat was deleted while Agent Lookout was not running, and an RPC session its client switched from (`src/modes/rpc/adapter.ts:1410-1428`) until its process ends.

### A late poll

After the computer sleeps, a session's heartbeat is over 15 seconds old until Autohand Code writes the next one, at most 5 seconds on. Without a rule, a session that waits would show as unknown and then as needing you again, a new wait. So on a poll more than 15 seconds after the one before, or before it by the clock, a session that had a fresh heartbeat on the poll before, whose process still runs and that has not been closed since, keeps the status it had, with the same time, while its heartbeat is quiet or gone. It keeps it until a fresh heartbeat comes, or for 7 seconds, and is never held again from that poll. It is not held while the heartbeats folder cannot be read.

### The time of a status

- Needs you, working and idle keep the time they began while they last. A new one takes the time of the heartbeat that first showed it. On Agent Lookout's first poll, and for a session first seen then, it is not known.
- Unknown has no time.
- Finished and failed have when the session ended: its `closedAt`, when it was closed and not resumed since; else the latest of its heartbeat's time, its `lastActiveAt` and, when it crashed or was marked `completed` with no close, when its `metadata.json` was written; else when `metadata.json` was written.

### Prompts that do not show as needing you

Autohand Code shows these with no `waiting_input`, so the session shows as working:

- the commit message prompt (`src/core/actionExecutor.ts:2701-2732`);
- the prompt for a folder outside the project as an instruction starts (`src/core/agent/InstructionRunner.ts:438-450`; `src/permissions/directoryPermissionPrompt.ts:111-124`, `:206`);
- the prompt to accept a plan (`src/core/agent/AgentCommandRuntime.ts:563-609`);
- computer use's "Trust and set up" (`src/core/agent/InstructionRunner.ts:356`, `:400-410`).

Its offer to publish a research report comes once the instruction has ended (`src/core/agent/InstructionRunner.ts:951`), so the session shows as idle. A teammate's approval is refused unless it is given automatically (`src/core/teams/TeammateAuthorization.ts:16-23`). With `--yes`, `--unrestricted`, `ui.autoConfirm` or a YOLO rule, a tool's approval is given with no prompt (`src/core/agent/AgentCommandRuntime.ts:359-373`), and nothing waits.

A wait shows up to 7 seconds after its prompt opens, since `beginAwaitingInput` writes nothing (`src/core/agent.ts:2926-2930`) and the next heartbeat is due within 5 seconds, and it lingers as long after the prompt closes.

## The process

A heartbeat's process is asked about with signal 0 alone, once a poll for each process, and so is the process of a session's last heartbeat after that heartbeat has gone, until it has ended, the session is found ended or another run saves it. EPERM counts as running. No `ps` is run, and no program's name, arguments, environment or start time is read.

A heartbeat names a process that wrote it within the last 15 seconds when it is fresh, so a process ID given to another program is not taken for Autohand Code then. A gone heartbeat's process ID can be given to another program before Agent Lookout first sees it, after Agent Lookout starts again, as on Windows, where process IDs are used again soon. Such a session shows as unknown while that program runs and the heartbeat is there, as its `metadata.json` says once the heartbeat is gone, and as finished, or failed when it crashed, once that program ends while Agent Lookout runs. A heartbeat written in a container names a process this computer cannot reliably ask about, so while such a session runs it can show as unknown or finished, or, when a process here has the same ID, as its heartbeat says.

## Names, folders and apps

- The name is the one given with `/rename` or `autohand --rename`, else the folder's name, else the session's ID.
- The folder is `metadata.json`'s `projectPath`, which is `path.resolve` of the folder it was started in (`src/session/SessionManager.ts:146`), else the heartbeat's `workspaceRoot`. The presence writer's is the folder's real path.
- The app is VS Code when `metadata.json`'s `client` is `vscode`; else a terminal for a heartbeat of mode `interactive` or `command`, none known for one of mode `rpc`, and else a terminal when `client` is `terminal`.
- It started when `metadata.json` says the session was made, else when its heartbeat says so.

## Quiet for

Quiet for is the time since `metadata.json` was last written, never the heartbeat's, which is rewritten every 5 seconds whatever the session does. Autohand Code saves `metadata.json` at each message, each reply's token counts and each file the session reads (`src/session/SessionManager.ts:598-611`, `:658-693`, `:728-732`), so nothing moves while a prompt waits or one long tool runs. A session with no `metadata.json` has none.

## Token counts

A heartbeat and `metadata.json` hold a session's running totals. A reply's own counts are in `conversation.jsonl`, which is never opened. So no tokens are shown.

## Jump, Stop and Answer

No Jump yet: Agent Lookout does not look for the terminal an Autohand Code session runs in. No Stop: Agent Lookout stops Claude Code sessions only so far. No Answer: it never connects to Autohand Code's peer socket or its RPC client, so it cannot send one.

## Known gaps

- A run with `--no-daemon`, or with its heartbeats moved, writes no heartbeat here. A new one shows as unknown while it runs, and is finished only once closed. One that resumes a session shows as that session did before, finished or failed from its old time, or is not listed when it was last written over a day ago, until it first saves. Then it shows as unknown.
- A run with `--no-daemon`, or with its heartbeats moved, that Autohand Code marks crashed after an error its loop gets past shows as failed while it runs, until its next save.
- Heartbeats moved with `coordinationDirectory`, or by a `--set` for one run, are not found.
- A failed `-p` run is written `completed` and shows as finished.
- The memory is lost when Agent Lookout stops. Then an editor's session closed over ACP, an auto-mode iteration and a session whose heartbeat another Autohand Code deleted show as unknown, until they leave the list a day after their last write, and a copy of another tool's session that was resumed with nothing saved yet is left out again.
- A session an RPC client switched from stays unknown until its process ends.
- When an editor over ACP reloads a session, its heartbeat goes for a moment (`src/modes/acp/adapter.ts:467-471`), and the session can show as finished for up to 5 seconds.
- Two processes on one session with peer communication off share one file, and one's clean close deletes it (`src/session/ActiveAgentRegistry.ts:96-102`), so the session can show as finished for up to 5 seconds until the other writes again.
- A crash right after a message was saved, within a second, reads as a session that went on, and a crash after an error the loop got past, with nothing saved since, reads as failed.
- Autohand Code's other Windows folders, used when `USERPROFILE` is not set or is a system folder, are not followed, and neither is a relative `AUTOHAND_HOME`.
- A heartbeat held up by long work that blocks Autohand Code's process can be over 15 seconds old while the session runs, and the session shows as unknown until the next one.
- A heartbeat written in a container names a process this computer cannot ask about.
- Files of another user are not read, so Agent Lookout run as root on macOS or Linux sees no session of another user's.

## Not yet checked

Everything here is read from the source, so each of these is for a person with Autohand Code installed to check:

1. The heartbeat and `metadata.json` as `dist/index.js` writes them, byte for byte, on macOS, Linux and Windows.
2. How soon a heartbeat follows a prompt, and how late it comes after the computer wakes.
3. How soon another Autohand Code deletes a stale heartbeat.
4. On Windows, whether Autohand Code's rename onto a heartbeat or `metadata.json` that Agent Lookout has open can fail (`src/utils/atomicFile.ts:560`), and how soon a process ID is used again.
5. The form of a web transfer's session IDs.
6. Whether an ACP client closes its connection or ends the process, and whether anything calls the ACP adapter's `dispose()` (`src/modes/acp/adapter.ts:1056-1066`).
7. Which loop errors come after a message was saved.
8. Whether a workspace's settings can turn on peer communication.
9. Whether `/rename` can reach a session from an RPC client.

## What breaks when Autohand Code changes

| Change in Autohand Code                                 | What the dashboard shows                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Files written other than with two spaces                | Heartbeats are not read and sessions show as unknown                            |
| `phase` no longer the first key of `activity`           | Sessions show as unknown while they run                                         |
| A heartbeat `version` above 1                           | Its heartbeats are not read, and the Sources view says why                      |
| A stale rule other than 15 seconds, or another interval | A session flips to unknown while it runs, or stays fresh after its process ends |
| A new stage of work                                     | Sessions in it show as unknown                                                  |
| A new title source                                      | Its titles are not read, and sessions take their folder's name                  |
| Other folders or file names                             | Autohand Code is not found, or its sessions are not listed                      |
| Other rules for who may own a heartbeat                 | Heartbeats Autohand Code reads may not be read here                             |

To check a new Autohand Code version, read `src/session/ActiveAgentRegistry.ts`, `src/session/peers/PeerActivityPublisher.ts` and `PeerMessaging.ts`, `src/session/SessionManager.ts`, `src/session/types.ts`, `src/utils/atomicFile.ts`, `src/constants.ts`, `src/core/agent.ts`'s heartbeat, `src/core/agent/AgentLifecycleRunner.ts` and `AgentSessionAccounting.ts`, and the importers. Then update `UNCHECKED_NOTE` in `src/collector/adapters/autohand-code/index.ts` and the first paragraphs here.
