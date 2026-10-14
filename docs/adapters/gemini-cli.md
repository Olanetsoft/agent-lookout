# Gemini CLI adapter notes

These notes record what Agent Lookout reads from Gemini CLI, where each value comes from, and what breaks when Gemini CLI changes. The files Gemini CLI writes are not documented for other programs, so when the adapter stops working, start here.

Written on 2026-10-14 from Gemini CLI's source at `v0.64.0`, released 2026-10-13 ([google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) at that tag). Gemini CLI was not installed or run on the machine where the adapter was written, and no file of a real Gemini CLI was read. Everything below comes from that source and from hand-written files laid out the same way. **The adapter has not yet been checked on a machine running Gemini CLI**, and the Sources view says so.

The code is in `src/collector/adapters/gemini-cli/`, and the status mapping is in `src/core/mapping/gemini-cli/geminiCliMapping.ts`.

## How it reads Gemini CLI, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no program run, no network. It reads two kinds of file under Gemini CLI's folder, read-only.

| Interface                | Why it is not used                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gemini --list-sessions` | It lists only the sessions of the folder it is run in, and starting Gemini CLI writes under its folder (`packages/cli/src/config/config.ts`, `packages/core/src/config/storage.ts`). |
| Hooks in `settings.json` | They need the person's `settings.json` changed, which the adapter never does.                                                                                                        |
| `projects.json`          | It says the same as each project's `.project_root`, for every project at once. It is not needed, and is never opened.                                                                |

## What it reads

| Path, under Gemini CLI's folder       | How                                                                                                                                             | How often                                                                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tmp/`                                | One `stat`, which follows a link, to see that it is a folder. Then listed, for the project folders                                              | The `stat` on every poll, or once a minute while it is missing, unless `AGENT_LOOKOUT_GEMINI_CLI_HOME` is set. The listing when its time moves, or every 30 seconds |
| Each folder in `tmp/`                 | One `lstat`, to see that it is a folder. Gemini CLI's own `bin/` and `background-processes/` are passed over unless they hold a `.project_root` | When `tmp/` is listed                                                                                                                                               |
| `tmp/<project>/.project_root`         | Opened read-only, at most 4 KiB, for the folder the project is for. On Windows that folder's case is then asked of the system, as below         | When `tmp/` is listed and the file's size, time or identity changed, and on each poll while it was not there                                                        |
| `tmp/<project>/chats/`                | Looked at with `lstat`, and listed                                                                                                              | Looked at on every poll, and listed when its time moves, or every 30 seconds                                                                                        |
| `tmp/<project>/chats/session-*.jsonl` | Opened read-only. The first line, within 8 MiB, then at most the last 8 MiB, then only what is added                                            | When a file written to in the last day changes. A file not written to for a day is looked at only when the folder is listed                                         |
| `tmp/<project>/chats/session-*.json`  | Looked at with `lstat`, never opened, to count those changed in the last day                                                                    | When the folder is listed                                                                                                                                           |

A file is opened with `O_NOFOLLOW` and `O_NONBLOCK` and read only if the open file is an ordinary file, so a link, a pipe or a device is never read and cannot stall a poll.

It never reads `oauth_creds.json`, `google_accounts.json`, `gemini-credentials.json`, `mcp-oauth-tokens.json`, `a2a-oauth-tokens.json`, `installation_id`, `.env`, `settings.json`, `trustedFolders.json`, `projects.json`, `history/`, or anything else in a project's folder: `logs.json`, which holds every input typed, `shell_history`, `logs/`, `tool-outputs/`, `checkpoints/`, `checkpoint-*.json`, `memory/` and the per-session folders. It never looks into a subagent's folder in `chats/`, never opens a `.tmp-<pid>` or `.unreadable-<time>` file a failed rewrite leaves, and never touches `antigravity-cli/`, `antigravity/` or `antigravity-ide/`, which the Antigravity adapters read.

### Gemini CLI's folder

`AGENT_LOOKOUT_GEMINI_CLI_HOME` if set, which names the folder that holds `tmp/`. Then `.gemini` in the folder Gemini CLI's own `GEMINI_CLI_HOME` names: that variable names a home folder, not Gemini CLI's folder (`packages/core/src/utils/paths.ts`). Then `~/.gemini`.

Gemini CLI is there when `tmp/` is a folder. `~/.gemini` alone does not count, because Antigravity keeps its own folders in it. When `tmp/` is missing, Gemini CLI is reported as not found, with no advice, and is looked for again once a minute. When `AGENT_LOOKOUT_GEMINI_CLI_HOME` names a folder with no `tmp/`, that is an answer: the source is watched and lists no sessions.

Under macOS Seatbelt (`SANDBOX=sandbox-exec`), Gemini CLI keeps its sessions in `~/.cache/.gemini` instead (`storage.ts`, `getGlobalRuntimeDir`). Point `AGENT_LOOKOUT_GEMINI_CLI_HOME` there to see them. In a Docker or Podman sandbox the folder is a temporary one that goes when the sandbox stops, and those sessions are not seen.

### Project folders

Since Gemini CLI 0.29, a project's folder in `tmp/` is named from the last part of the folder Gemini CLI was started in, lower-cased with every other character made `-`, such as `demo-project`, and `-1`, `-2` and so on for a clash (`packages/core/src/config/projectRegistry.ts`). Before 0.29 it was a SHA-256 hash of the folder's path. Those folders are listed like any other, and a session in one has no known folder. Gemini CLI keeps its own `bin/` and `background-processes/` in `tmp/` too, and reserves neither name, so a project started in `~/bin` gets `tmp/bin/`. Those two are passed over unless they hold a `.project_root`.

`.project_root` holds the folder's path as plain text, written once. Its text, trimmed, is the session's folder when it is an absolute path on one line with no control characters. Otherwise the folder is not known. On macOS and Linux it should be the path with every link resolved, as the system gives a program its working folder, though that is read from how the system works, not from Gemini CLI's own code. On Windows Gemini CLI writes it in lower case, so there the adapter asks the system for the folder's path as its disk writes it, which reads nothing in the folder, and takes it when it differs from the text in case alone. That keeps its sessions under the same repository and name as other agents' sessions in the folder.

### Session files

Since Gemini CLI 0.39, a session's file is `chats/session-<YYYY-MM-DDTHH-MM>-<first 8 characters of its id>.jsonl`, with the time in UTC. A clash in the same minute adds `-<n>-` before the id. An imported session's file is `session-<epoch milliseconds>-<first 8 characters of its id>.jsonl`, with a new id. A subagent's file is `chats/<parent session id>/<agent id>.jsonl`, which is not read. Versions before 0.39 wrote one JSON document, `session-<…>.json`, which is not read either. Gemini CLI deletes session files after 30 days by default, and deletes a session with nothing worth resuming when it exits cleanly.

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
- From a message: its `id`, `type` and `timestamp`, and whether its content is `""`, asks for a tool (`functionCall`), answers one (`functionResponse`), is only thoughts, or begins as one of the messages Gemini CLI writes itself as if the person had typed them (below). From a reply, whether every tool call was cancelled and when the newest ended.
- From `$rewindTo`, its id. From `$patch`, the ids it changes, removes and reorders, and the same few facts of any new content.
- From `$set`, its `lastUpdated`, its `summary`, whether it sets `sessionId`, and its `messages`, taken as messages are.

The text of a prompt, a reply, a thought, a tool's arguments or result, `displayContent`, `memoryScratchpad`, `directories` and `projectHash` are dropped as soon as the line is parsed. A line that does not parse is passed over, as Gemini CLI passes it over.

Every read is bounded. The first read of a file takes its first line, within 8 MiB, and at most its last 8 MiB, and drops the line that piece begins inside. After that only what was added is read, a mebibyte at a time, up to 64 MiB in one read, so a line too long to parse that was added at once is still read past and told apart. A line is parsed only once its newline is there. A file that is a different file, shorter or the same size, rewritten so that the end of the last read is no longer a line's end, or added to by more than 64 MiB at once, is read again as on its first read: its first line and at most its last 8 MiB. A file kept to at most 10,000 messages drops the oldest.

A line longer than 8 MiB is not parsed. Its first 512 bytes say what it is when they begin `{"id":"…","timestamp":"…","type":"…"`, as Gemini CLI's recorder writes a message: it is then that message with its content not known. A `$set` that begins with `messages` replaces the list with one not known. Anything else is a line of a kind not known. An imported session or one resumed from an older version can hold messages with their keys in another order, and such a line is not told apart.

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
- Two projects can each hold a session of one id, as `--session-id` allows, so a session's id in Agent Lookout is `gemini-cli:<sessionId>.<hash>`: 8 characters of the SHA-256 of the project's folder name in `tmp/`, which keeps the id the same from poll to poll without writing the folder's name into the history. Two files of one id in one project are shown as one session, from the file active last, as Gemini CLI's own list does.
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
| An error                                                                                           | Idle    | The error           |
| A type Gemini CLI 0.64.0 does not write, a line of a kind not known, or a reply too long to read   | Unknown |                     |

Taking a session up again, or rewinding it, Gemini CLI writes the tool results of its history again, as `user` messages of id `<reply's id>_response`, then a `$patch` that puts the list in order, then a `$set` of the time. Those copies are old turns, so the session is idle since that `$set`. A `$set` of `messages`, which Gemini CLI 0.44 to 0.63 wrote then, at a session's start and when a prompt was stopped or failed, is a rollback when it drops the newest message that says how the session stands, and says how it stands only when its newest such message is new. That is known only when the file was read from its start. When the first read began inside the file, a message it did not see may be old, so it is not taken as new.

What Gemini CLI writes, and when (`packages/core/src/core/geminiChat.ts`, `packages/cli/src/ui/hooks/useGeminiStream.ts`):

- A prompt is written as a `user` message before the request, and the reply as a `gemini` message once the model has finished. Nothing is written while the model streams.
- A reply that only calls tools has content `""`. A reply with text that also calls a tool is written as a final answer is.
- While a tool waits for approval or runs, nothing is written. When every call in the batch has ended, the reply is written again with its `toolCalls`, then the tools' results as a `user` message, then the next request is made.
- A declined tool, a prompt stopped while the model streams, and a request that fails each take back what they wrote with `$rewindTo` or `$patch`, and a failed request then adds an `error` message.
- Between the batch and the results, Gemini CLI does other work, which can ask the network, so the batch can be the newest line for a few seconds. That is why a batch is working for 30 seconds after its newest call ended.
- A tool that stops the agent, or one the CLI runs itself, leaves the batch last with no request after it. That is why a batch older than that is unknown.
- A reply's tool calls are written only once each has ended. A call's status there is `success`, `error` or `cancelled`.

Gemini CLI writes no lock, process id or end mark for a session, and no approval wait, so a session is never shown as needing you, finished or failed.

## Known gaps

- A text reply with a pending tool looks idle. When a reply with text also calls a tool, the session shows as idle while that tool waits for approval or runs, because the call is written only once it ends.
- A session waiting for you shows as working, or as idle after a reply with text.
- A closed session keeps the status it had. Most often that is idle: it goes stale a day after its last update, and leaves the list then. So does an open one.
- A session closed while it worked shows as working. When its terminal is closed, or its program stopped or crashed, while a prompt runs or a tool waits or runs, Gemini CLI writes nothing more, so it shows as working, with Quiet for and never stale, until it leaves the list a day after its last update.
- A few other things look the same as a prompt or a tool's result, such as Esc pressed after one of several tools ended, a skill activated by hand, or a hook that stops a prompt. Such a session shows as working until its next reply.
- Errors are not shown yet: a session whose request failed shows as idle.
- The title arrives late: it appears only after a later Gemini CLI start in the same folder.
- Sessions that are not seen: those in a Docker or Podman sandbox, those under macOS Seatbelt unless `AGENT_LOOKOUT_GEMINI_CLI_HOME` names `~/.cache/.gemini`, those saved by a version before 0.39, and those of a Gemini CLI started with `GEMINI_CLI_HOME` set only in its own shell.
- A session's folder is the one Gemini CLI wrote: on macOS and Linux most likely with every link resolved. On Windows it is in lower case when the system cannot give the folder's own case.
- A session resumed after a day shows within 30 seconds of the next write, when its folder is listed again.

## What breaks when Gemini CLI changes

| Change in Gemini CLI                                     | What the dashboard shows                           | Where to fix it                                   |
| -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| A new kind of line, or a new message type                | Sessions that end with one show as Unknown         | `chatFile.ts`, `geminiCliMapping.ts`              |
| The rules of `$rewindTo`, `$patch` or `$set` change      | Statuses can be wrong                              | `src/core/mapping/gemini-cli/geminiCliMapping.ts` |
| A message's keys are written in another order            | Lines longer than 8 MiB show as Unknown            | `chatFile.ts`                                     |
| The header changes shape                                 | Those sessions are left out                        | `chatFile.ts`                                     |
| The `tmp/<project>/chats/session-*.jsonl` layout changes | No sessions are found                              | `chats.ts`, `projects.ts`                         |
| `.project_root` moves or changes                         | Sessions have no folder, and are named by their id | `projects.ts`                                     |
| Gemini CLI's folder moves                                | Gemini CLI is not found                            | `index.ts`                                        |
| A note Gemini CLI writes as if typed changes its words   | A session shows as working after it                | `NOTE_STARTS` in `chatFile.ts`                    |
| Approval waits or running tools are written to the file  | Nothing, until the adapter reads them              | `src/core/mapping/gemini-cli/geminiCliMapping.ts` |

To check a new Gemini CLI version, read `packages/core/src/services/chatRecordingService.ts` and `chatRecordingTypes.ts`, `packages/core/src/core/geminiChat.ts`, `packages/cli/src/ui/hooks/useGeminiStream.ts`, `packages/core/src/config/storage.ts` and `projectRegistry.ts` at its tag, then, on a machine running it, compare the dashboard with the sessions in Gemini CLI's own `/resume` list.
