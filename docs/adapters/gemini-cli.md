# Gemini CLI adapter notes

These notes record what Agent Lookout reads from Gemini CLI, where each value comes from, and what breaks when Gemini CLI changes. The files Gemini CLI writes are not documented for other programs, so when the adapter stops working, start here.

Written on 2026-10-14 from Gemini CLI's source at `v0.64.0`, released 2026-10-13 ([google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) at that tag). Gemini CLI was not installed or run on the machine where the adapter was written, and no file of a real Gemini CLI was read. Everything below comes from that source and from hand-written files laid out the same way. **The adapter has not yet been checked on a machine running Gemini CLI**, and the Sources view says so.

The code is in `src/collector/adapters/gemini-cli/`, and the status mapping is in `src/core/mapping/gemini-cli/geminiCliMapping.ts`.

## How it reads Gemini CLI, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no program run, no network. It reads two kinds of file under Gemini CLI's folder, read-only, and on a Mac under the folder Gemini CLI keeps under macOS Seatbelt too ([below](#the-folder-gemini-cli-keeps-under-macos-seatbelt)).

| Interface                | Why it is not used                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gemini --list-sessions` | It lists only the sessions of the folder it is run in, and starting Gemini CLI writes under its folder (`packages/cli/src/config/config.ts`, `packages/core/src/config/storage.ts`). |
| Hooks in `settings.json` | They need the person's `settings.json` changed, which the adapter never does.                                                                                                        |
| `projects.json`          | It says the same as each project's `.project_root`, for every project at once. It is not needed, and is never opened.                                                                |

## What it reads

| Path, under each of Gemini CLI's folders                       | How                                                                                                                                             | How often                                                                                                                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmp/`                                                         | One `stat`, which follows a link, to see that it is a folder. Then listed, for the project folders                                              | The `stat` on every poll, or once a minute while no folder holds `tmp/`, unless `AGENT_LOOKOUT_GEMINI_CLI_HOME` is set. The listing when its time moves, or every 30 seconds |
| Each folder in `tmp/`                                          | One `lstat`, to see that it is a folder. Gemini CLI's own `bin/` and `background-processes/` are passed over unless they hold a `.project_root` | When `tmp/` is listed                                                                                                                                                        |
| `tmp/<project>/.project_root`                                  | Opened read-only, at most 4 KiB, for the folder the project is for. On Windows that folder's case is then asked of the system, as below         | When `tmp/` is listed and the file's size, time or identity changed, and on each poll while it was not there                                                                 |
| `tmp/<project>/chats/`                                         | Looked at with `lstat`, and listed                                                                                                              | Looked at on every poll, and listed when its time moves, or every 30 seconds                                                                                                 |
| `tmp/<project>/chats/session-*.jsonl`                          | Opened read-only. The first line, within 8 MiB, then at most the last 8 MiB, then only what is added                                            | When a file written to in the last day changes. A file not written to for a day is looked at only when the folder is listed                                                  |
| `tmp/<project>/chats/session-*.json`                           | Looked at with `lstat`, never opened, to count those changed in the last day                                                                    | When the folder is listed                                                                                                                                                    |
| `tmp/<project>/chats/<session id>/` of a listed session        | Looked at with `lstat`, which follows no link, and listed. See [Quiet for](#quiet-for)                                                          | Looked at on every poll, and listed when its time moves, or every 30 seconds, or on each poll while it cannot be listed                                                      |
| `tmp/<project>/chats/<session id>/*.jsonl` of a listed session | Looked at with `lstat`, never opened, for when it last changed                                                                                  | At most 1,000 when the folder is listed, and on every poll the 16 written to last and up to 16 more a listing could not look at                                              |
| The session file the last poll listed a session from           | Opened read-only: at most its last 256 KB, for what the session last said                                                                       | Only when `GET /api/sessions/last-message` asks, while the session's details are open. Never by a poll                                                                       |

A file is opened with `O_NOFOLLOW` and `O_NONBLOCK` and read only if the open file is an ordinary file, so a link, a pipe or a device is never read and cannot stall a poll.

In either folder, it never reads `oauth_creds.json`, `google_accounts.json`, `gemini-credentials.json`, `mcp-oauth-tokens.json`, `a2a-oauth-tokens.json`, `installation_id`, `.env`, `settings.json`, `trustedFolders.json`, `projects.json`, `history/`, or anything else in a project's folder: `logs.json`, which holds every input typed, `shell_history`, `logs/`, `tool-outputs/`, `checkpoints/`, `checkpoint-*.json`, `memory/` and the per-session folders. It looks into a subagent's folder in `chats/` only for a session it lists, never opens a subagent's file, never opens a `.tmp-<pid>` or `.unreadable-<time>` file a failed rewrite leaves, and never touches `antigravity-cli/`, `antigravity/` or `antigravity-ide/`, which the Antigravity adapters read. It reads nothing else in `~/.cache`.

### Gemini CLI's folders

`AGENT_LOOKOUT_GEMINI_CLI_HOME` if set, which names the folder that holds `tmp/`, and then no other folder is read. Otherwise `.gemini` in the folder Gemini CLI's own `GEMINI_CLI_HOME` names: that variable names a home folder, not Gemini CLI's folder (`homedir` in `packages/core/src/utils/paths.ts:22-28`). Then `~/.gemini`. On a Mac, without `AGENT_LOOKOUT_GEMINI_CLI_HOME`, the folder Gemini CLI keeps under macOS Seatbelt is read beside it: `.cache/.gemini` in the same home folder, so `~/.cache/.gemini` when `GEMINI_CLI_HOME` is not set.

Gemini CLI is there when a folder's `tmp/` is a folder. `~/.gemini` alone does not count, because Antigravity keeps its own folders in it. When no folder holds `tmp/`, Gemini CLI is reported as not found, with no advice, and each `tmp/` is looked for again once a minute. While one folder holds `tmp/`, the other's `tmp/` is looked at with one `stat` on each poll, and nothing more is read there while it is missing. When `AGENT_LOOKOUT_GEMINI_CLI_HOME` names a folder with no `tmp/`, that is an answer: the source is watched and lists no sessions.

When a `tmp/` that is there cannot be looked at or listed, the source is not working for that poll, though the other folder's was read, and the card says which folder. It then lists no sessions, so none is taken to have ended, and none to have appeared again at the next poll that reads both.

### The folder Gemini CLI keeps under macOS Seatbelt

These notes are from Gemini CLI's source at v0.64.0, and are not yet checked on a Mac running Gemini CLI under Seatbelt.

Gemini CLI keeps its sessions, with `projects.json`, `history/`, `installation_id` and `mcp-oauth-tokens.json`, in the folder `getGlobalRuntimeDir` gives (`packages/core/src/config/storage.ts:92-108`). That is `.gemini` in its home folder, unless `SANDBOX` is `sandbox-exec` (`:97`): then it is `.cache/.gemini` in the same home folder (`:100`). Its default Seatbelt profile, `permissive-open` (`packages/cli/src/utils/sandbox.ts:129`), does not let it write to `~/.gemini`, and lets it write to `~/.cache` (`packages/cli/src/utils/sandbox-macos-permissive-open.sb:77` and `:186-187`). The home folder is the one `GEMINI_CLI_HOME` names, otherwise the person's (`homedir`, above), so with `GEMINI_CLI_HOME` set it is `.cache/.gemini` there. `tmp/` is in that folder (`getGlobalTempDir`, `storage.ts:195-197`), and each project's folder is in `tmp/` (`getProjectTempDir`, `:230-234`).

In Gemini CLI's code, `SANDBOX` is set to `sandbox-exec` only for the Gemini CLI its own launch starts under macOS's `sandbox-exec` (`start_sandbox` in `sandbox.ts`, the Seatbelt branch from `:121`, the variable at `:306`), which is passed the rest of the launch's environment, `GEMINI_CLI_HOME` among it (`:318`). It starts that way when sandboxing is on, by `--sandbox`, `GEMINI_SANDBOX` or `tools.sandbox`, and names `sandbox-exec`, or names no command on a Mac that has `sandbox-exec` (`getSandboxCommand` in `packages/cli/src/config/sandboxConfig.ts:43-124`, the Mac at `:104`). `getGlobalRuntimeDir` does not ask which system it is on, but `sandbox-exec` is macOS's own program, so Agent Lookout reads this folder on a Mac alone. A Docker or Podman sandbox sets `SANDBOX` to the container's name (`sandbox.ts:855`), so Gemini CLI keeps its sessions in `.gemini` inside the container, a temporary folder that goes when the sandbox stops, and those sessions are not seen.

Agent Lookout cannot tell whether a session ran under Seatbelt, so on a Mac it reads both folders' `tmp/` when each is there, with no setting, and the same way: the same files, as often, with the same limits. Each folder has its own `projects.json`, so its own project folders in `tmp/`, and Gemini CLI's `--resume` and `/resume` look in the one `SANDBOX` gives alone. So a session in each folder is a session of its own, even when the same project folder name, or with `--session-id` the same session id, is in both, and its id says which folder it is in ([Which sessions are listed](#which-sessions-are-listed)).

The two can be one folder, when one is a link to the other, or its `tmp/` is. `tmp/` is looked at with `stat`, which follows a link. When the two `tmp/` have the same identity on the disk, Agent Lookout asks the system for each one's path with every link followed, which reads nothing in either, and when the paths are the same it reads the folder once, as Gemini CLI's own. Two folders apart on one disk never share an identity, so the paths are asked for only then.

To check, run `gemini --sandbox` on a Mac, and see that its session shows, with an id that ends `.seatbelt`.

### Project folders

Since Gemini CLI 0.29, a project's folder in `tmp/` is named from the last part of the folder Gemini CLI was started in, lower-cased with every other character made `-`, such as `demo-project`, and `-1`, `-2` and so on for a clash (`packages/core/src/config/projectRegistry.ts`). Before 0.29 it was a SHA-256 hash of the folder's path. Those folders are listed like any other, and a session in one has no known folder. Gemini CLI keeps its own `bin/` and `background-processes/` in `tmp/` too, and reserves neither name, so a project started in `~/bin` gets `tmp/bin/`. Those two are passed over unless they hold a `.project_root`.

`.project_root` holds the folder's path as plain text, written once. Its text, trimmed, is the session's folder when it is an absolute path on one line with no control characters. Otherwise the folder is not known. On macOS and Linux it should be the path with every link resolved, as the system gives a program its working folder, though that is read from how the system works, not from Gemini CLI's own code. On Windows Gemini CLI writes it in lower case, so there the adapter asks the system for the folder's path as its disk writes it, which reads nothing in the folder, and takes it when it differs from the text in case alone. That keeps its sessions under the same repository and name as other agents' sessions in the folder.

### Session files

Since Gemini CLI 0.39, a session's file is `chats/session-<YYYY-MM-DDTHH-MM>-<first 8 characters of its id>.jsonl`, with the time in UTC. A clash in the same minute adds `-<n>-` before the id. An imported session's file is `session-<epoch milliseconds>-<first 8 characters of its id>.jsonl`, with a new id. A subagent's file is `chats/<parent session id>/<agent id>.jsonl`, which is never opened: only [when it last changed](#quiet-for) is looked up. Versions before 0.39 wrote one JSON document, `session-<…>.json`, which is not read either. Gemini CLI deletes session files after 30 days by default, and deletes a session with nothing worth resuming when it exits cleanly.

Each line is one record, `JSON.stringify(record) + "\n"`, added with `appendFileSync`. Gemini CLI's own reader replays them in order (`packages/core/src/services/chatRecordingService.ts`, `createJsonlRecordAccumulator`), and the adapter replays them by the same rules:

| Line                                               | What it does                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `{"$rewindTo":"<id>"}`                             | Drops that message and every one after it. An id not in the list drops them all                                                        |
| `{"$patch":{…}}`                                   | Changes one message given at its top, then each of `updates`, then removes `removeIds`, then moves `orderIds` to the end in that order |
| A message: a string `id` and no `$patch`           | Added to the list. A later line with the same id replaces it where it stands                                                           |
| `{"$set":{…}}`                                     | Changes the session's details. With `messages`, as Gemini CLI 0.44 to 0.63 wrote, it replaces the whole list                           |
| The header: a string `sessionId` and `projectHash` | The session's details. Always the first line                                                                                           |

A message is `{"id","timestamp","type","content","displayContent"?}`, with `type` one of `user`, `gemini`, `info`, `warning` and `error`. A `gemini` message can also hold `toolCalls`, `thoughts`, `tokens` and `model`.

What is kept, from each line parsed, and nothing else:

- From the header: `sessionId`, which must be letters, digits, `_` and `-`, `startTime`, `lastUpdated`, `kind` and the title, `summary`, and only whether `projectHash` is there. The header of an imported session also holds the whole text of its first prompt, which is never kept.
- From a message: its `id`, `type` and `timestamp`, and whether its content is `""`, asks for a tool (`functionCall`), answers one (`functionResponse`), is only thoughts, begins as one of the messages Gemini CLI writes itself as if the person had typed them (below), or begins as the error of a [failed request](#a-failed-request) does. From a reply, whether every tool call was cancelled and when the newest ended, and three numbers worked out from its `tokens`, the reply's [token counts](#token-counts).
- From `$rewindTo`, its id. From `$patch`, the ids it changes, removes and reorders, and the same few facts of any new content.
- From `$set`, its `lastUpdated`, its `summary`, whether it sets `sessionId`, and its `messages`, taken as messages are.

The text of a prompt, a reply, a thought, an error, a tool's arguments or result, `displayContent`, `memoryScratchpad`, `directories`, `projectHash`, a reply's `model` and the rest of its `tokens` are dropped by a poll as soon as the line is parsed. A line that does not parse is passed over, as Gemini CLI passes it over. The text of a session's newest reply is read only when it is asked for, as [Last message](#last-message) says.

Every read is bounded. The first read of a file takes its first line, within 8 MiB, and at most its last 8 MiB, and drops the line that piece begins inside. After that only what was added is read, a mebibyte at a time, up to 64 MiB in one read, so a line too long to parse that was added at once is still read past and told apart. A line is parsed only once its newline is there. A file that is a different file, shorter or the same size, rewritten so that the end of the last read is no longer a line's end, or added to by more than 64 MiB at once, is read again as on its first read: its first line and at most its last 8 MiB. A file kept to at most 10,000 messages drops the oldest.

A line longer than 8 MiB is not parsed. Its first 512 bytes say what it is when they begin `{"id":"…","timestamp":"…","type":"…"`, as Gemini CLI's recorder writes a message: it is then that message with its content not known. An `error` that long is told by how its text begins, which the recorder writes next as `,"content":"…`, and nothing of that text is kept. A `$set` that begins with `messages` replaces the list with one not known. Anything else is a line of a kind not known. A reply's line that long gives no token counts, and nor does a reply before a line of a kind not known, as [Token counts](#token-counts) says. An imported session or one resumed from an older version can hold messages with their keys in another order, and such a line is not told apart.

### Notes Gemini CLI writes as if typed

Gemini CLI records a few messages of its own as `user` messages, and none starts a request. A `user` message whose text, trimmed, begins with one of these says nothing of how the session stands:

- `<session_context>`: the context every session starts with, which also has the fixed id `d04923d38bb0f6017037e74183378ef4` (`packages/core/src/utils/environmentContext.ts`).
- `<hook_context>`: what a SessionStart hook adds (`packages/cli/src/ui/AppContainer.tsx`).
- `I ran the following shell command:`: the output of a command run with `!` (`packages/cli/src/ui/hooks/useExecutionLifecycle.ts`).
- `- **Workspace Directories:**`: the folders `/directory add` adds (`packages/core/src/utils/environmentContext.ts`).
- `User has manually exited Plan Mode.`: leaving Plan Mode by hand (`packages/core/src/utils/approvalModeUtils.ts`).

## Which sessions are listed

A session is listed for 24 hours after it was last active: the newest of its last `lastUpdated`, its last message's time and the end of its last tool call. That is not the file's modified time, because a later start of Gemini CLI in the same folder adds a title to an older session, which moves the time without the session doing anything. Nothing says whether a session is still open, so an open session leaves the list a day after it was last active too.

- A file whose header says `kind` `subagent` is not listed.
- Two projects can each hold a session of one id, as `--session-id` allows, so a session's id in Agent Lookout is `gemini-cli:<sessionId>.<hash>`: 8 characters of the SHA-256 of the project's folder name in `tmp/`, which keeps the id the same from poll to poll without writing the folder's name into the history. Two files of one id in one project of one folder are shown as one session, from the file active last, as Gemini CLI's own list does.
- A session in the folder Gemini CLI keeps under macOS Seatbelt has `.seatbelt` after that: `gemini-cli:<sessionId>.<hash>.seatbelt`. The session ids the adapter takes and the hash hold no dot, so an id from `~/.gemini` has one dot after `gemini-cli:` and one from `~/.cache/.gemini` has two: the two are never the same, though the same project folder name and session id are in both. The ids of sessions in `~/.gemini` are as they were before the second folder was read. A folder `AGENT_LOOKOUT_GEMINI_CLI_HOME` names is read as Gemini CLI's own, so its sessions' ids have no `.seatbelt`, as with the setting before, even when it is `~/.cache/.gemini`.
- The name is the title, `summary`, the last one written. Gemini CLI writes it at a later start in the same folder, as one sentence of at most 80 characters from the model. Until then the name is the folder's, and then the session's id. A prompt is never a name.
- The surface is the terminal. A session has no process, no link and no way to jump to it.

## Status

The status comes from the last record that says how the session stands, and the newest message that does, in the list as replayed. Notes, `info` and `warning` messages say nothing of it.

| Last record, or newest message                                                                     | Status  | Since               |
| -------------------------------------------------------------------------------------------------- | ------- | ------------------- |
| A rollback: a `$rewindTo`, a `$patch` or a `$set` of `messages` that drops the newest such message | Idle    | The `$set` after it |
| A `$set` of `sessionId`: a Gemini CLI program has taken the session up again                       | Idle    | The `$set` after it |
| None, with every line from the start read: a new session                                           | Idle    | Its start           |
| None, with the start of the file not read                                                          | Unknown |                     |
| A prompt                                                                                           | Working | The prompt          |
| A tool's result                                                                                    | Working | The newest prompt   |
| A tool's result after a batch whose every call was cancelled, as Esc leaves it                     | Idle    | The result          |
| A reply that is `""` or asks for a tool, with no tool calls recorded: a tool waits or runs         | Working | The newest prompt   |
| A reply of only thoughts, the note Gemini CLI writes before it asks about a file a tool sent back  | Working | The newest prompt   |
| A reply with text and no tool calls                                                                | Idle    | The reply           |
| A reply with tool calls whose newest call ended less than 30 seconds ago: the results come next    | Working | The newest prompt   |
| A reply with tool calls, ended longer ago or every call cancelled: nothing says what came next     | Unknown |                     |
| The error of a [failed request](#a-failed-request)                                                 | Failed  | The error           |
| An error of another kind                                                                           | Idle    | The error           |
| A type Gemini CLI 0.64.0 does not write, a line of a kind not known, or a reply too long to read   | Unknown |                     |

Taking a session up again, or rewinding it, Gemini CLI writes the tool results of its history again, as `user` messages of id `<reply's id>_response`, then a `$patch` that puts the list in order, then a `$set` of the time. Those copies are old turns, so the session is idle since that `$set`. A `$set` of `messages`, which Gemini CLI 0.44 to 0.63 wrote then, at a session's start and when a prompt was stopped or failed, is a rollback when it drops the newest message that says how the session stands, and says how it stands only when its newest such message is new. That is known only when the file was read from its start. When the first read began inside the file, a message it did not see may be old, so it is not taken as new.

What Gemini CLI writes, and when (`packages/core/src/core/geminiChat.ts`, `packages/cli/src/ui/hooks/useGeminiStream.ts`):

- A prompt is written as a `user` message before the request, and the reply as a `gemini` message once the model has finished. Nothing is written while the model streams.
- A reply that only calls tools has content `""`. A reply with text that also calls a tool is written as a final answer is.
- While a tool waits for approval or runs, nothing is written to the session's file. When every call in the batch has ended, the reply is written again with its `toolCalls`, then the tools' results as a `user` message, then the next request is made.
- A declined tool, a prompt stopped while the model streams, and a prompt whose request fails each take back what they wrote with `$rewindTo` or `$patch`, and a failed request then adds an `error` message, as [A failed request](#a-failed-request) says.
- Between the batch and the results, Gemini CLI does other work, which can ask the network, so the batch can be the newest line for a few seconds. That is why a batch is working for 30 seconds after its newest call ended.
- A tool that stops the agent, or one the CLI runs itself, leaves the batch last with no request after it. That is why a batch older than that is unknown.
- A reply's tool calls are written only once each has ended. A call's status there is `success`, `error` or `cancelled`.

Gemini CLI writes no lock, process id or end mark for a session, and no approval wait, so a session is never shown as needing you or finished.

### A failed request

These notes are from Gemini CLI's source at v0.64.0, with line numbers at that tag, and are not yet checked on a computer running it.

`addItem` in `packages/cli/src/ui/hooks/useHistoryManager.ts` records every error the CLI shows as an `error` message, with the text it shows as its `content` (`:108-114`). So the type does not say that a request failed. Nor do the other fields: `recordMessage` gives it a random `id` and the time, like any message (`packages/core/src/services/chatRecordingService.ts:1014-1027`, `:1029-1060`). Nor does its order. A prompt stopped with Esc is taken back by the same `$rewindTo` or `$patch` as a failed one, so an error of another kind after it looks the same, and a failed request that sends the tools' results takes nothing back. What tells them apart is how the text begins, and the adapter compares that inside the reader, as it does for [notes](#notes-gemini-cli-writes-as-if-typed), and keeps only the answer.

An `error` comes from a failed request in three ways, each in `packages/cli/src/ui/hooks/useGeminiStream.ts`:

- `Turn.run` caught what the request threw and sent an `Error` event (`packages/core/src/core/turn.ts:434-462`). `handleErrorEvent` adds the error (`:1216-1248`, from the case at `:1569-1570`), its text from `parseAndFormatApiError`.
- `submitQuery`'s `try` threw (`:1825-1851`). Its `catch` adds the error (`:1837-1849`), its text from `parseAndFormatApiError`, unless it was a sign-in error, a validation the person already dealt with, or an abort.
- The stream gave no usable reply: `geminiChat.ts` threw `InvalidStreamError` (`packages/core/src/core/geminiChat.ts:1699-1755`), and `Turn.run` sent an `InvalidStream` event (`turn.ts:423-431`). `handleInvalidStreamEvent` adds the error (`:1250-1303`, from the case at `:1621-1622`), with one of ten fixed texts: the six in `packages/core/src/utils/constants.ts:23-39`, the three messages of `InvalidStreamError` it does not replace with one of those, and `Invalid stream received from model`.

`parseAndFormatApiError` (`packages/core/src/utils/errorParsing.ts:35-85`) returns `[API Error: …]` on each of its paths, and no other code in `packages/` at that tag writes those words. Each of the ten fixed texts is used only for this. They are `FAILED_REQUEST_STARTS` in `chatFile.ts`, and `contentShapeOf` sets `failedRequest` when a message's text begins with one.

What is written, in order, when a request fails (`geminiChat.ts:812-842`, the `finally` of `streamWithRetries`, then `turn.ts`, then `useGeminiStream.ts`):

1. A prompt's request takes the prompt back with `updateMessagesFromHistory`: a `$rewindTo`, or a `$patch` with `removeIds` when anything else goes too, such as an older `info`, `warning` or `error` line (`chatRecordingService.ts:1452-1506`), then a `$set` of the time (`:1551-1555`). A request that sends the tools' results takes nothing back (`geminiChat.ts:833`).
2. Sometimes an `info` line, from `maybeAddSuppressedToolErrorNote`, which says nothing of how the session stands.
3. The `error` message, then a `$set` of the time (`chatRecordingService.ts:1053-1054`).
4. Sometimes an `info` line, from `maybeAddLowVerbosityFailureNote`, which says nothing of how the session stands either. It is not written once the note in item 2 has been shown (`useGeminiStream.ts:809-814`).

Every other `error` is something else the CLI shows, and stays idle. Among them:

- A slash command's own failure, as `result.content` or a thrown error's message (`packages/cli/src/ui/hooks/slashCommandProcessor.ts:463`, `:723`, and the commands in `packages/cli/src/ui/commands/`).
- A `!` command that throws (`packages/cli/src/ui/hooks/useExecutionLifecycle.ts:628`).
- A failed update (`packages/cli/src/ui/hooks/useExtensionUpdates.ts:187`, `packages/cli/src/utils/handleAutoUpdate.ts:215`).
- A failed refresh of memory, or a failed acknowledgement of agents (`packages/cli/src/ui/AppContainer.tsx:1105`, `:2764`).
- Anything sent through `emitFeedback` with severity `error` (`AppContainer.tsx:2151-2175`).
- The note that the model could not be told Plan Mode ended (`useGeminiStream.ts:1905-1908`).

These write a text of their own, or pass on another error's message as it came. None of them goes through `parseAndFormatApiError`, so such a message would have to begin with those words itself, and no code in `packages/` at that tag makes one.

A failed session stands from the error's time until something newer says how it stands: a prompt shows it as working again, and a take-back of the error, or a Gemini CLI program that takes the session up again, as idle. A later error of another kind is the newest message, so it shows the session as idle. Nothing of the error's text is kept, on a line of any length. As [What it reads](#what-it-reads) says, the reader keeps the one fact and drops the line.

## Quiet for

A session's `lastWriteAt`, which the dashboard shows as how long a working session has been quiet, is the newest modified time of the session's own file and the files of its subagents. Each comes from the file system alone: nothing is read from a file for it.

- A subagent writes to a file of its own, adding a line at a time, while the session that started it waits and writes nothing to its own file. The file is `chats/<parent session id>/<agent id>.jsonl`, in a folder named for the session's whole id (`initialize` in `packages/core/src/services/chatRecordingService.ts`). So without these times, a session waiting on a subagent would look as if it had stopped.
- The folders go no deeper. A subagent is given no tool that starts another (`registerToolInstance` in `packages/core/src/agents/local-executor.ts`), and `executionContext` there keeps the main session's id for any agent, so a subagent's own subagent would write to the same folder.
- A session's folder is its id joined to `chats/`, in the same project of the same one of Gemini CLI's folders, so this works for a session in either. Gemini CLI's own name for the folder makes any character but a letter, a digit, `_` or `-` a `_`. An id the adapter takes holds no other, so the id is the folder's name and cannot name another folder.
- Only the folder of a session the poll lists is looked at. A session that started no subagent has none, which costs one `lstat` on each poll. The folder is listed when its own time moves, as it does when a subagent starts, or every 30 seconds, and up to 1,000 of its files, in the order of their names, are looked at with `lstat` then. Between listings, only the 16 written to last are looked at again, since Gemini CLI adds to a file without moving its folder's time, so a write to any other is seen within 30 seconds, and up to 16 more if the listing could not look at them. Their names go at the first poll that does not list the session, whether it read the sessions or could not, and the folder is listed afresh if the session comes back.
- Only a name ending in `.jsonl` is looked at, so a `.tmp-<pid>` or `.unreadable-<time>` file is passed over. A link in the folder, a pipe, a device or a folder under such a name counts for nothing, and a link in the folder's place is not followed. A time that could not be right, or that is before the session began, is left out.
- A folder or file that is not there is no failure. That is how a session that started no subagent looks, and `ENOENT` or `ENOTDIR` count the same when something goes between one look and the next, such as a folder between its `lstat` and its `readdir`. Any other error from a look at a folder or a file means the look told nothing, and is not taken to mean there is no subagent.
- Such a look leaves the poll `ok`, and adds a sentence to the source's `detail`: permission was refused for so many sessions, for `EACCES` or `EPERM`, and the lookup failed for so many, for any other error. It gives the kind and the count alone, never a session's id, a folder or a file's name, and the card's rows stay as they are. A session counts once however many of its files could not be looked at, as refused if any was.
- The session is listed from its own file as ever, and its status is what its own lines say. Its `lastWriteAt` stays the newest time the adapter last saw of its subagents, or moves on with any file it can still look at, so a failure cannot move it back. So a subagent that goes on writing while it cannot be looked at is not seen, and the session can look quiet, as the sentence says. If the adapter has seen no time since the session came onto the list, it goes by the session's own file.
- The counts are made afresh at each poll, and hold numbers alone, so the sentence goes at the first poll that can look again, and the time comes back with it. A folder that could not be looked at or listed is tried again at each poll, and while it cannot be listed the files looked at between listings go on being looked at. A file a listing could not look at is looked at on each poll until the next listing, with up to 16 of them a folder, those already looked at first, so the sentence stays while the failure does, not only at each listing. If a listing could not look at more than 16, one it left out may be what was written last, so the time does not fall until a listing has looked at them all.
- A subagent's write moves only this time. The status and its time, the start and how long the session is listed all come from the session's own lines. So a session a reply left idle stays idle while its subagent works, and shows no Quiet for, and a session leaves the list a day after its own last update however recently a subagent wrote. Keep awake reads this time too, so a working session counts for 30 minutes after its subagent's last write, and so does the `quietForMs` that `agent-lookout mcp` gives.

## Token counts

A session's details give the token counts of its newest reply. They come from the same read of the session file that gives the status, and no file is opened or read for them that is not read for it. These notes are from Gemini CLI's source at v0.64.0, with line numbers at that tag.

### Where Gemini CLI writes them

A `gemini` message holds them as `tokens`, a `TokensSummary` of six numbers, `input`, `output`, `cached`, `thoughts`, `tool` and `total`, or `null` (`packages/core/src/services/chatRecordingTypes.ts:19-26`, the field at `:80`). They reach the file this way:

- `processStreamResponse` in `packages/core/src/core/geminiChat.ts` keeps the usage of the last chunk of the reply's stream that had one, not a sum (`:1494-1496`, `:1584-1587`). Only once the stream has ended, and passed the checks that throw a failed try away (`:1698-1757`), does it give that usage to `recordMessageTokens` and then write the reply with `recordMessage` (`:1764-1788`). Nothing is written while the reply streams, and a stream that was stopped or failed writes neither the reply nor its counts.
- `recordMessageTokens` in `packages/core/src/services/chatRecordingService.ts` copies the usage's counts, with 0 for one not sent (`:1087-1116`, the copy at `:1093-1100`). If the newest message in its list is then a `gemini` message with no counts, it writes that message's line again with them, and the new reply is written with `"tokens":null` (`:1101-1108`). Otherwise, as when the prompt or a tool's result was written last, it holds them, and `recordMessage` writes them on the new reply's own line, the line with its text (`:1046-1053`).
- A reply whose stream sent no usage is written with `"tokens":null` (`:1048`).
- When the reply's tools have ended, `recordToolCalls` writes its line again with its tool calls, and with its `tokens` as they were (`:1118-1187`). A message `updateMessagesFromHistory` adds has no `tokens` (`:1392-1404`), and a `$patch` changes only a message's content and its tools' results, never its `tokens` (`applySinglePatch`, `:266-300`).
- When a session is taken up again, Gemini CLI's own `hydrate` reads the counts back from the file: it adds up those of every `gemini` message that has them for its stats, and takes the `total` of the newest such message for the context in use, passing over one with `null` (`packages/core/src/telemetry/uiTelemetry.ts:222-296`, the check at `:236`).
- A subagent writes its replies to a file of its own, which is never read.

`recordMessageTokens` takes the six from the Gemini API's usage metadata: `input` is `promptTokenCount`, `output` `candidatesTokenCount`, `cached` `cachedContentTokenCount`, `thoughts` `thoughtsTokenCount`, `tool` `toolUsePromptTokenCount` and `total` `totalTokenCount` (`chatRecordingTypes.ts:19-26`). Gemini CLI 0.64.0 asks Gemini's API: through Code Assist for a Google sign-in, whose usage it passes on as it came (`packages/core/src/code_assist/converter.ts:158`), and through the `@google/genai` client for an API key, Vertex AI or a gateway at the address `GOOGLE_GEMINI_BASE_URL` names (`packages/core/src/core/contentGenerator.ts:80-99`, `:293-416`). In `@google/genai` 1.30.0, which Gemini CLI 0.64.0 pins (`packages/core/package.json:31`), `GenerateContentResponseUsageMetadata` (`dist/genai.d.ts:3202-3225`) says:

- `promptTokenCount` is the whole prompt, and with cached content "also includes the number of tokens in the cached content". `cachedContentTokenCount` is that cached part.
- `candidatesTokenCount` is the tokens of the reply, and `thoughtsTokenCount` those of the model's thoughts, counted apart.
- `toolUsePromptTokenCount` is the tokens of the results of tools the API runs itself, given back to the model as input.
- `totalTokenCount` is "the sum of `prompt_token_count`, `candidates_token_count`, `tool_use_prompt_token_count`, and `thoughts_token_count`".

So the reply's `output` leaves its thinking out, and `thoughts` holds it alone: Out is the two together, which counts the thinking once, as Out does for Codex, Claude Code and Qwen Code. Qwen Code works its Out out from the total because its providers do not agree on whether the candidates count the reasoning ([qwen-code.md](qwen-code.md#token-counts)). Here it is Gemini's API, whose candidates leave the thinking out, and Gemini CLI writes `thoughts` apart, so the two are added. For counts that add up, that is the total less `input` and `tool`. In is `input` alone, the whole prompt with its cached part, which is how Gemini CLI measures how much of the context is in use: it keeps `promptTokenCount` as `lastPromptTokenCount` (`geminiChat.ts:1767-1769`), and takes that from the model's limit for what is left (`packages/core/src/core/client.ts:726-727`). Only `hydrate`, on a session taken up again, takes the `total` for it instead (`uiTelemetry.ts:248-250`). In stays the prompt, as it is for every agent. `tool` is neither In nor Out: the API counts it apart from the prompt, and it is in the total alone.

### What is shown

| Shown  | From                             |
| ------ | -------------------------------- |
| In     | `input`                          |
| Cached | `cached`, unless 0               |
| Out    | `output` and `thoughts` together |

`summaryCountsOf` in `chatFile.ts` works out these three numbers from a reply's line, reads `tool` and `total` only to check them and keeps nothing more of `tokens`, `tokenCountsOf` in `src/core/tokens/tokenCounts.ts` checks them, and `newestGeminiCliTokens` in `geminiCliMapping.ts` takes those of the newest reply. Each reply's three numbers are kept with the list as it is replayed, so that when a newer reply is taken back the one before it counts. Only the newest reply's go on the session.

- The counted reply is the newest `gemini` message left in the list, replayed by the rules in [Session files](#session-files), that has counts. A reply a `$rewindTo` or a `$patch` took back, as `/rewind`, a declined tool or a stopped request takes it back, is gone from the list and is never the one counted: the counts are then those of the newest reply left. A `user`, `info`, `warning` or `error` message is never counted, and a subagent's file is never read.
- A newer reply with `"tokens":null`, or with no `tokens`, is passed over for the one before it, as Gemini CLI's own `hydrate` passes it over, and as a Codex or Qwen Code reply with no counts leaves them as they were. A session whose replies have none shows a dash.
- Counts that could not be right give a dash, never an older reply's: a `tokens` that is neither an object nor `null`; an `input`, `output` or `total` that is missing, negative or not a whole number; an `input` of 0; a `thoughts` or `tool` that is negative or not a whole number; a `total` smaller than `input`, `output`, `thoughts` and `tool` together, as the 0 Gemini CLI writes when the API sent no total; or a `cached` that is negative, not a whole number or larger than `input`. A `thoughts` or `tool` that is not there counts as 0, and a `total` larger than the four is taken as it is. The dash lasts until the next reply with counts.
- A reply too long to read whole, over 8 MiB, gives a dash too, until the next reply with counts: its `tokens` come after its `content`, past the part that is read.
- A line of a kind not known gives a dash too, until the next reply with counts, since what it did to the list is not known. One is a `$patch` over 8 MiB, which `updateMessagesFromHistory` can write when its `updates` carry the tools' results again (`chatRecordingService.ts:1407-1446`, the line at `:1496-1506`): only its first 512 bytes are read, so the replies it took back are not known, and the newest may be among them.
- A `cached` of 0, or none, is left out, and the details say only Newest reply: Gemini CLI writes 0 for a count the API did not send (`?? 0`, `chatRecordingService.ts:1096`), and the line cannot tell that from a cache that held none.
- When the first read of a file longer than 8 MiB began part way, a `$patch` whose `orderIds` names a message that part does not hold may move that message, which may be a reply, after the newest reply the part holds. The counts are then a dash until a reply written after it has counts. A file read from its start, or whose list a `$set` of `messages` replaced, holds every message, unless more than 10,000 were kept and the oldest dropped, and a `$patch` can then move only those it holds.
- A reply still being written is not read: a line is parsed only once its newline is there, and Gemini CLI writes each line, with any counts in it, in one write (`appendRecord`, `chatRecordingService.ts:892-908`).
- Nothing is summed: there are no totals.

Not yet checked on a computer running Gemini CLI: that the lines hold the counts as the source above writes them. To check, run a session, and compare, for its newest reply, the six numbers of its line's `tokens` with what its details show.

## Last message

What a session last said is read only when `GET /api/sessions/last-message` asks for it, which the dashboard does while the session's details are open, and only for a session the last poll listed (`lastMessages.ts`, on `createTailReader` in `src/collector/messages/tailReader.ts`, as Codex's, Antigravity's and Qwen Code's are). No poll reads it, and it is never put on a session.

- The file is the session file the last poll listed the session from: of two files of one session in one project, the one active last. Never a subagent's file, which is in a folder of the session's and is never listed, nor another session's, and nothing in a request names it. A poll that cannot list the sessions lists none, so none is read until a poll lists it again.
- At most the last 256 KB are read, opened without following a link and without waiting on a pipe. The first line of that end, which the read cut into, is not read.
- The lines read are replayed by the rules in [Session files](#session-files), in the order Gemini CLI's own reader tries them: `$rewindTo`, `$patch`, a message, `$set`, then a header, whose `messages`, if it has any, are added. A line that does not parse, or is none of these, is passed over, as Gemini CLI passes it over.
- The model's reply is a `gemini` message. Its `content` is a string, a list of parts or one part. A part with `text` is what the reply says, unless it is marked `thought`, the model's thinking. A part with a `functionCall` calls a tool, and says nothing. The reply's `thoughts` and `toolCalls`, with the tools' results, are fields of their own. Gemini CLI writes a reply's text as a string, with its thoughts left out (`geminiChat.ts`), and can write it again as its parts, thoughts and calls among them, as it takes a session up again or after `/rewind` (`convertSessionToClientHistory` in `packages/core/src/utils/sessionUtils.ts`, written by `updateMessagesFromHistory`).
- So the text is that of the newest `gemini` message left whose content has text that is not a thought: those parts' text, joined with nothing between, as Gemini CLI joins a reply's text. A reply that only calls tools, or only thinks, is passed over for the one before it. A prompt, a thought, a tool's call, a tool's result and an `info`, `warning` or `error` line are never taken. Each line is judged by its own fields, so a reply quoted in a prompt is never taken.
- A subagent writes to a file of its own, `chats/<session id>/<agent id>.jsonl`, never to the session's. What it found reaches the session's file only as a tool's result, which is never taken.
- It is made fit to show as every last message is, and at most its last 2,000 characters are kept, in memory, for at most 15 seconds after the last ask. The answer has no token counts: a session's are on the session already, from the poll's read. `AGENT_LOOKOUT_LAST_MESSAGE=off` or `AGENT_LOOKOUT_WAITING_TEXT=off` stops it, and the Sources card then says Last message read: Off.

### A reply taken back

Gemini CLI takes back what it wrote with a `$rewindTo` or a `$patch` (`chatRecordingService.ts`, `geminiChat.ts`):

| What happens                                                | What Gemini CLI writes                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/rewind` to a prompt                                       | `{"$rewindTo":"<the prompt's id>"}`: the prompt and every message after it go                                                                                                                                                                                                                                         |
| Every tool a reply called declined or cancelled             | The reply goes: its id in a `$rewindTo`, or in a `$patch`'s `removeIds`                                                                                                                                                                                                                                               |
| A prompt stopped with Esc, or a prompt whose request failed | Stopped: the prompt and every message after it in its turn go, the replies among them. Failed: the prompt goes. Either way, a `$rewindTo` when the messages that go are the newest and nothing else goes, otherwise a `$patch` with `removeIds`. A request that sends the tools' results and fails takes nothing back |
| A session taken up again, or its history changed            | A `$patch` that can give messages new content in `updates`, drop the `info`, `warning` and `error` lines, which the model never sees, in `removeIds`, and put every message in the history's order in `orderIds`                                                                                                      |

Every such line is replayed, so a reply it took back is never taken. But the end that is read can begin after the message a `$rewindTo` or a `$patch` names, as in a long session. Then what that line did is known only in part:

- Messages from before the end are always first in the list: they were written first, a message with a new id is added at the end, and a `$patch` moves only the ids it names.
- A `$rewindTo` to an id the end does not hold drops every message the end holds: that message is before them all, or there is none of that id, which drops every message.
- A `$patch` that changes or removes ids the end does not hold changes nothing the end holds.
- A `$patch` whose `orderIds` names an id the end does not hold moves that message, if there is one, to its place in the order. Whether it is a prompt or a reply is not known, so the newest reply is one after it, or none. A `$rewindTo` to it drops every message the end holds, and a line of its id every one but that line's.
- A line with the id of a message in the list replaces it where it stands. Gemini CLI writes one only for the newest message, as it adds the reply's token counts or its tool calls (`recordMessageTokens`, `recordToolCalls`), so a line of an id the end does not hold is a new message, added at the end.
- A `$set` of `messages`, as Gemini CLI 0.44 to 0.63 wrote, replaces the list, so what was before the end no longer counts.

When no reply the end holds comes after every message it does not hold, the newest reply cannot be told, and the answer is `too-far-back`, never a reply that may have been taken back. These rules are from Gemini CLI's source at v0.64.0, and are not yet checked on a computer running Gemini CLI.

## Known gaps

- A text reply with a pending tool looks idle. When a reply with text also calls a tool, the session shows as idle while that tool waits for approval or runs, because the call is written only once it ends.
- A session waiting for you shows as working, or as idle after a reply with text.
- A closed session keeps the status it had. Most often that is idle: it goes stale a day after its last update, and leaves the list then. So does an open one.
- A session closed while it worked shows as working. When its terminal is closed, or its program stopped or crashed, while a prompt runs or a tool waits or runs, Gemini CLI writes nothing more, so it shows as working, with Quiet for and never stale, until it leaves the list a day after its last update.
- A few other things look the same as a prompt or a tool's result, such as Esc pressed after one of several tools ended, a skill activated by hand, or a hook that stops a prompt. Such a session shows as working until its next reply.
- A failed request that records no error does not show as failed. `gemini -p` throws the error and prints it (`packages/cli/src/nonInteractiveCli.ts:392`), and the IDE mode that speaks ACP throws it too (`packages/cli/src/acp/acpSession.ts:510-519`), so neither has an `addItem`. A request that needs you to sign in again opens the sign-in dialog instead (`useGeminiStream.ts:1827-1828`). Such a session shows as idle once its prompt is taken back, or as working when the request was sending the tools' results.
- With Gemini CLI's experimental `experimental.adk.agentSessionInteractiveEnabled` on, `useAgentStream` adds the error's own message, not the text `parseAndFormatApiError` makes (`packages/cli/src/ui/hooks/useAgentStream.ts:291-300`), so most failed requests show as idle.
- A later error of another kind, such as a slash command's, moves a failed session to idle, since it is then the newest message.
- A subagent can go uncounted. Once a failed request sends Gemini CLI to another model for the rest of a session, its program takes a new id, which it uses for the folder of any subagent started after that, while it goes on writing the session's file under the old id (`rotateSessionId` in `packages/core/src/fallback/handler.ts`). You are not always asked first: it asks nothing when a side request on another model fails, when Flash fails for a moment on auto, or in Plan Mode (`handleFallback` there, `AUTO_ROUTING_OVERRIDES` in `packages/core/src/availability/policyCatalog.ts`, `resolvePolicyChain` in `packages/core/src/availability/policyHelpers.ts`). No session file names that folder, so Quiet for goes by the session's own file. The same goes for a subagent past the first 1,000 files in a session's folder.
- A session can look quiet while a subagent works when a subagent's folder or file cannot be looked up, and in the Mac app Keep awake can stop counting it. Gemini CLI's card says so, with how many sessions that touched, not which ones.
- The title arrives late: it appears only after a later Gemini CLI start in the same folder.
- Sessions that are not seen: those in a Docker or Podman sandbox, those saved by a version before 0.39, and those of a Gemini CLI started with `GEMINI_CLI_HOME` set only in its own shell.
- A session's folder is the one Gemini CLI wrote: on macOS and Linux most likely with every link resolved. On Windows it is in lower case when the system cannot give the folder's own case.
- A session resumed after a day shows within 30 seconds of the next write, when its folder is listed again.
- Last message reads only the last 256 KB of a session's file. After `/rewind` in a long session, or once a long session is taken up again, when Gemini CLI puts the whole history in order, it can say the last message is further back until the session replies again.
- Out counts the thinking once as Gemini's API reports usage. Through a gateway at `GOOGLE_GEMINI_BASE_URL` that answers for another provider, the counts are only as right as the usage that gateway reports.
- Tokens show a dash after a reply too long to read whole, over 8 MiB, or a line too long to read that is not told apart, such as a long `$patch`, until the next reply with counts, and in a file longer than 8 MiB read from part way, after a `$patch` that may move a message from before that part after the newest reply, until a newer reply has counts.
- Last message can be a turn Gemini CLI writes itself in the model's place, such as `[The previous response was interrupted before it completed.]` once a response was cut off after a tool's result. This is read from the source, and not yet checked on a computer running Gemini CLI.

## What breaks when Gemini CLI changes

| Change in Gemini CLI                                                                               | What the dashboard shows                                                            | Where to fix it                                   |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------- |
| A new kind of line, or a new message type                                                          | Sessions that end with one show as Unknown                                          | `chatFile.ts`, `geminiCliMapping.ts`              |
| The rules of `$rewindTo`, `$patch` or `$set` change                                                | Statuses can be wrong                                                               | `src/core/mapping/gemini-cli/geminiCliMapping.ts` |
| A message's keys are written in another order                                                      | Lines longer than 8 MiB show as Unknown                                             | `chatFile.ts`                                     |
| The header changes shape                                                                           | Those sessions are left out                                                         | `chatFile.ts`                                     |
| The `tmp/<project>/chats/session-*.jsonl` layout changes                                           | No sessions are found                                                               | `chats.ts`, `projects.ts`                         |
| `.project_root` moves or changes                                                                   | Sessions have no folder, and are named by their id                                  | `projects.ts`                                     |
| A subagent's file moves out of `chats/<session id>/`, or is no longer added to as it works         | A working session that waits on a subagent shows Quiet for                          | `subagentWrites.ts`                               |
| Gemini CLI's folder moves                                                                          | Gemini CLI is not found                                                             | `index.ts`                                        |
| The folder Gemini CLI keeps under macOS Seatbelt moves, or is kept on another system too           | Sessions run under Seatbelt are not seen                                            | `geminiCliSeatbeltFolder` in `index.ts`           |
| A note Gemini CLI writes as if typed changes its words                                             | A session shows as working after it                                                 | `NOTE_STARTS` in `chatFile.ts`                    |
| The text of a failed request's error changes                                                       | Such a session shows as idle, not failed                                            | `FAILED_REQUEST_STARTS` in `chatFile.ts`          |
| Another kind of error comes to begin as a failed request's does                                    | Such a session shows as failed                                                      | `FAILED_REQUEST_STARTS` in `chatFile.ts`          |
| Approval waits or running tools are written to the file                                            | Nothing, until the adapter reads them                                               | `src/core/mapping/gemini-cli/geminiCliMapping.ts` |
| A reply's `content`, or how a thought is marked, changes                                           | Last message shows nothing, or shows a thought                                      | `lastMessages.ts`                                 |
| A new kind of line, or a new field of `$patch`, takes messages back or moves them                  | Last message can show a reply that line took back                                   | `lastMessages.ts`                                 |
| A message line is written again for a message that is not the newest                               | Last message can show a reply that is not the newest, or one taken back             | `lastMessages.ts`                                 |
| A reply's `tokens` move or are renamed                                                             | Tokens is a dash in every Gemini CLI session's details                              | `summaryCountsOf` in `chatFile.ts`                |
| `output` comes to count the thinking, or `total` comes to leave out `output`, `thoughts` or `tool` | Out counts the thinking twice, or Tokens is a dash when the count left out is not 0 | `summaryCountsOf` in `chatFile.ts`                |

To check a new Gemini CLI version, read `packages/core/src/services/chatRecordingService.ts` and `chatRecordingTypes.ts`, `packages/core/src/core/geminiChat.ts`, `packages/core/src/utils/sessionUtils.ts`, `packages/cli/src/ui/hooks/useGeminiStream.ts`, `packages/core/src/utils/errorParsing.ts` and `constants.ts`, `packages/core/src/config/storage.ts` and `projectRegistry.ts`, `packages/cli/src/config/sandboxConfig.ts` and `packages/cli/src/utils/sandbox.ts` at its tag, and for the token counts `recordMessageTokens`, `processStreamResponse` and `GenerateContentResponseUsageMetadata` in the `@google/genai` that `packages/core/package.json` pins, then, on a machine running it, compare the dashboard with the sessions in Gemini CLI's own `/resume` list.
