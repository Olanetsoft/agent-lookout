# Qwen Code adapter notes

These notes record what Agent Lookout reads from Qwen Code, where each value comes from, and what breaks when Qwen Code changes. When the adapter stops working, start here.

Written on 2026-10-14 from the source of Qwen Code `v0.25.1`, released 2026-10-11 (commit `c1a8218` of [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)), and the documentation in that tag. Qwen Code was not installed or run on the machine where the adapter was written, and no Qwen Code folder was read there. Everything below comes from that source and from hand-written files laid out the same way. **The adapter was built from Qwen Code's source at v0.25.1 and has not yet been checked on a machine running Qwen Code.** The Sources view says so too.

Each citation is `path:line` at `v0.25.1`, where `core/` is `packages/core/src/` and `cli/` is `packages/cli/src/`.

The code is in `src/collector/adapters/qwen-code/`, and the status mapping is in `src/core/mapping/qwen-code/qwenCodeMapping.ts`.

## How it reads Qwen Code, and why

The adapter needs nothing installed and changes nothing: no hooks, no settings, no Qwen Code program run, no network. It reads two things, both read-only:

- the list of running sessions in `<qwen home>/sessions/`, which Qwen Code documents for other programs to read (`docs/users/features/cross-session-protocol.md:22-131`);
- each listed session's chat file, `<runtime>/projects/<folder>/chats/<session id>.jsonl`.

It asks whether each session's process runs with signal 0, which tests a process and sends it nothing. For [Jump](#jump) it also asks tmux and `ps` where the process runs, and `ps` when it started.

Qwen Code has other ways in, and none of them can be used that way:

| Interface                                    | Why it is not used                                                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `qwen sessions ps`                           | It starts Qwen Code, and it deletes the records whose process it judges gone (`core/services/session-registry.ts:786`), which writes in Qwen Code's folder. |
| `qwen sessions list`                         | It starts Qwen Code, and it walks the chat files without saying which sessions run.                                                                         |
| Hooks (`Notification`, `PermissionRequest`)  | Each needs a change to Qwen Code's settings.                                                                                                                |
| A session's socket, `ipcPath`, and its token | It takes messages for the session. Agent Lookout never connects to it, and never uses the token.                                                            |
| `qwen --acp` and Qwen Code's server          | They drive sessions of their own, and do not list the terminal's.                                                                                           |

## What it reads

| Path                                                 | How                                                                                                                    | How often                                                                                                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `<qwen home>/sessions` and `<runtime>/projects`      | One `stat` each, to tell whether Qwen Code is there. Not done when `AGENT_LOOKOUT_QWEN_HOME` is set                    | On the first poll, then at most once a minute while both are missing, and on every poll while `sessions/` is missing and `projects/` is there |
| `<qwen home>/sessions/`                              | Listed                                                                                                                 | Every poll                                                                                                                                    |
| `sessions/<pid>.json`, `sessions/<pid>-<8 hex>.json` | Opened read-only, whole, when 64 KiB or less (`core/services/session-registry.ts:107,119`)                             | Every poll                                                                                                                                    |
| `<runtime>/projects/<folder>/chats/<id>.jsonl`       | One `lstat`, for a session whose process runs                                                                          | Every poll                                                                                                                                    |
| The same file                                        | Opened read-only: the last 8 MiB, then only what is appended                                                           | When its size, modified time or identity changes                                                                                              |
| `<runtime>/projects/`                                | Listed, then one `lstat` of `<each>/chats/<id>.jsonl`, when a session's file is not in the folder named for its folder | At most every 30 seconds for each session                                                                                                     |
| `chats/<id>.jsonl` of a record a crash left behind   | One `lstat`, for its modified time. Never opened by a poll                                                             | Once, at the first poll                                                                                                                       |
| The chat file the adapter last found for a session   | Opened read-only: at most its last 256 KB, for what the session last said                                              | Only when `GET /api/sessions/last-message` asks, while the session's details are open. Never by a poll                                        |

A file is opened without following a link at its name and without waiting on a pipe, and read only if the open file is an ordinary file. A link at a chat file's name is not a chat file.

## The folders

| Folder                               | First                     | Then               | Otherwise       |
| ------------------------------------ | ------------------------- | ------------------ | --------------- |
| Qwen Code's own, with `sessions/`    | `AGENT_LOOKOUT_QWEN_HOME` | `QWEN_HOME`        | `~/.qwen`       |
| The runtime folder, with `projects/` | `AGENT_LOOKOUT_QWEN_HOME` | `QWEN_RUNTIME_DIR` | Qwen Code's own |

This is the order Qwen Code uses (`core/config/storage.ts:172-203`). A value is trimmed, an empty one counts as unset, and `~` is the home folder, as Qwen Code reads it (`core/config/storage.ts:71-91`). `AGENT_LOOKOUT_QWEN_HOME` names both folders at once, and Qwen Code's own variables are then not looked at.

When both folders are missing, Qwen Code is reported as not found, with no advice, and they are looked for again once a minute. Polls in between touch nothing. When `AGENT_LOOKOUT_QWEN_HOME` names a folder with no `sessions` folder in it, that is an answer, not a missing Qwen Code: the source is watched and lists no sessions.

Two ways Qwen Code moves its folders cannot be followed, because Agent Lookout never reads Qwen Code's settings:

- `advanced.runtimeOutputDir` in `settings.json` moves the chat files (`cli/config/config.ts:1797-1799`).
- `QWEN_HOME` and `QWEN_RUNTIME_DIR` can be set in `~/.qwen/.env` or `~/.env`, which Qwen Code reads at start (`cli/config/environment.ts:200-258`).

A person who uses either can start Agent Lookout with `QWEN_HOME` or `QWEN_RUNTIME_DIR` set to the same folder.

## The list of running sessions

`<qwen home>/sessions/` holds one small JSON file for each session a Qwen Code process has open. The file is `<pid>.json`, or `<pid>-<8 hex>.json` for a process that hosts more than one session (`core/services/session-registry.ts:110-139`). The pid in the name, written as Qwen Code writes it, must be the record's own. No other name is opened, Qwen Code's temporary files `<name>.json.<12 hex>.tmp` among them.

A record, as Qwen Code writes it (`core/services/session-registry.ts:474-485`; `docs/users/features/cross-session-protocol.md:38-68`):

| Field           | Meaning                                                                                       | Kept                                           |
| --------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `schemaVersion` | `1`. A record of a higher version is counted and not read, as Qwen Code's own readers do      | Read, not kept                                 |
| `pid`           | The writer's process. It must match the file's name                                           | Yes                                            |
| `procStart`     | A start token on Linux, `null` on a Mac and Windows                                           | Only whether there is one                      |
| `pidNs`         | A process namespace on Linux, `null` elsewhere                                                | Only whether there is one                      |
| `sessionId`     | The session's id. `/clear` and `/resume` change it in place                                   | Yes, when it is hex digits and dashes          |
| `cwd`           | The session's folder. `/cd` changes it                                                        | Yes, when it is an absolute path               |
| `name`          | A label made from the folder                                                                  | No                                             |
| `startedAt`     | When the process registered the session, in epoch milliseconds                                | Yes                                            |
| `qwenVersion`   | The Qwen Code version                                                                         | No                                             |
| `kind`          | `tui`, `headless`, `serve` or `external`. Absent means `tui`                                  | Yes                                            |
| `ipcPath`       | The session's socket                                                                          | No, never used                                 |
| `ipcToken`      | The token a program sends to the session with. Qwen Code's docs say never to show it anywhere | No: dropped with the parsed record, never used |

- Only terminal sessions, `kind` `tui` or none, are listed. `headless` and `serve` are sessions an editor or Qwen Code's own server drives, and `external` a program that is not Qwen Code. They are left out in this version.
- On a Mac or Windows, a record with a start token or a namespace was written on Linux: by Qwen Code in a container, `qwen --sandbox`, which shares the folder. Its pid means nothing here, so it is not listed, and the Sources view says so.
- Two records of one session give the one with the newest `startedAt` whose process runs, as Qwen Code decides: its own listing asks each process first (`core/services/session-registry.ts:701-793`). When no process of them runs, the newest.
- A record caught mid-write keeps the entry it held before, for one poll. Qwen Code writes each through a temporary file and a rename (`core/services/session-registry.ts:537-541`).
- A session's id in Agent Lookout is `qwen-code:<session id>`.

Qwen Code removes a record when its process exits on `/quit`, SIGINT, SIGTERM or SIGHUP. A crash, `kill -9` or a power cut leaves it behind (`cli/llm.tsx:228-317`).

## Chat files

Path: `<runtime>/projects/<folder>/chats/<session id>.jsonl` (`core/config/config.ts:11898-11906`). The folder is the session's folder with every character that is not a letter or a digit made a `-`, after it is made lowercase on Windows (`core/utils/paths.ts:388-392`). The file is made with the session's first line, so a new session has none yet. Chat recording can be turned off, and then there is no file.

Each line is one record, appended and never rewritten (`core/utils/jsonl-utils.ts:347-369`). Its first keys are `uuid`, `parentUuid`, `sessionId`, `timestamp` and `type`, in that order, after an optional `backgroundTurn`, and `cwd`, `version` and `gitBranch` follow (`core/services/chatRecordingService.ts:1525-1555`). `type` is `user`, `assistant`, `tool_result` or `system`, with a `subtype` for most system lines (`core/services/chatRecordingService.ts:371-414`).

Kept of each line: its type, subtype and time, and

- of a `user` line, whether it is a notification stamped `deliveredTurn`, the first line of a turn Qwen Code went on to send (`core/services/chatRecordingService.ts:420-448`);
- of an `assistant` line, whether it holds a reply and whether that calls a tool, which of `ask_user_question` and `exit_plan_mode` it calls first, if either, by name alone (as [Questions and plan approvals](#questions-and-plan-approvals) says), and three numbers worked out from its `usageMetadata`, the reply's [token counts](#token-counts);
- of a `tool_result` line, whether `toolCallResult.status` is `cancelled`;
- of a `ui_telemetry` line with a `request_lifecycle` event, its `phase`, its `outcome` and whether a subagent made it (`core/telemetry/request-lifecycle.ts:15-46`);
- of a `custom_title` line, the title (`core/services/chatRecordingService.ts:3305-3335`);
- whether the line belongs to a Managed Session log.

Never kept by a poll: the prompt, the reply, its thoughts, a tool's call id, input and output, the question or the plan Qwen Code asks you, `cwd`, `gitBranch`, `model`, the rest of `usageMetadata`, or any other field. Each line is parsed and dropped at once. A line a subagent wrote, `isSidechain: true`, is skipped. The text of a session's newest reply is read only when it is asked for, as [Last message](#last-message) says.

Every read is bounded. The first reads at most the last 8 MiB and drops the line it cut into. Each one after reads only what was appended, at most 8 MiB at once. A line still being written is left for the next read. A line over 4 MiB is not parsed: its type, subtype and time are read from its first 64 KiB. A file that shrank or was replaced is read again from its end.

## Token counts

A session's details give the token counts of its newest reply. They come from the same read of the chat file that gives the status, and no file is opened or read for them that is not read for it.

### Where Qwen Code writes them

`recordAssistantTurn` writes the reply's usage as `usageMetadata` on its `assistant` line, after its `message` (`core/services/chatRecordingService.ts:2774-2810`, the field at `:470-471`), in the shape of Gemini's `GenerateContentResponseUsageMetadata`. In `packages/core` and `packages/cli` it is called only from `core/core/llm-chat.ts`, at most once for each reply the model gives:

- The usage is that of the last chunk of the reply's stream that had one, not a sum (`processStreamResponse`, `:5927`, `:6106-6107`).
- Five of its counts are made numbers by `coerceUsageCount` (`:535-545`, `:6120-6148`): `promptTokenCount`, `totalTokenCount`, `candidatesTokenCount`, `cachedContentTokenCount` and `thoughtsTokenCount`. One the provider did not send, or sent negative or not finite, is written as 0. The line holds the provider's usage with those five over it (`:6716-6718`).
- A reply stopped with Esc is written with the usage that had come by then, or none (`:6246-6254`). The part written when Esc comes between tries has none (`:5149-5155`).

What each provider puts in them, from the converter each auth type uses (`createContentGenerator` in `core/core/contentGenerator.ts:530-606`):

| Provider                                                                                                                               | `promptTokenCount`                                                                                                                | `cachedContentTokenCount` | `candidatesTokenCount` | `thoughtsTokenCount`                                           | `totalTokenCount`                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------- | -------------------------------------------------------------- | --------------------------------------- |
| OpenAI-compatible, `openai` and `qwen-oauth` (`core/core/openaiContentGenerator/converter.ts:2085-2135` and `:1479-1528`)              | `prompt_tokens`                                                                                                                   | `cached_tokens`, else 0   | `completion_tokens`    | `reasoning_tokens`, else an estimate from the reasoning's text | `total_tokens`, else 0                  |
| OpenAI Responses, `openai-responses` (`makeFinalResponse`, `core/core/openaiResponsesContentGenerator/responses-converter.ts:490-518`) | `input_tokens`                                                                                                                    | `cached_tokens`, else 0   | `output_tokens`        | `reasoning_tokens`, else 0                                     | `total_tokens`                          |
| Anthropic, `anthropic` (`buildAnthropicUsageMetadata`, `core/core/anthropicContentGenerator/usage.ts:44-75`)                           | the input, the cache reads and the cache writes together, or the input alone when it looks as if it holds the cache reads already | the cache reads           | `output_tokens`        | none, so 0                                                     | the prompt and `output_tokens` together |
| Gemini, `gemini` and `vertex-ai` (`generateContentStream`, `core/core/llm-content-generator/llm-content-generator.ts:309-322`)         | Gemini's own                                                                                                                      | Gemini's own              | Gemini's own           | Gemini's own                                                   | Gemini's own                            |

`qwen-oauth`, Qwen Code's own sign-in, uses the OpenAI-compatible converter: `QwenContentGenerator` extends `OpenAIContentGenerator` (`core/qwen/qwenContentGenerator.ts:25`).

What the providers' own fields mean:

- OpenAI's `cached_tokens` are "present in the prompt", `total_tokens` is "prompt + completion", and reasoning tokens are "counted in the total completion tokens" (`CompletionUsage` in the `openai` package 5.11.0, which Qwen Code 0.25.1 pins, `resources/completions.d.ts:85-146`). In its Responses API, `cached_tokens` and `reasoning_tokens` are breakdowns of `input_tokens` and `output_tokens` (`ResponseUsage`, `resources/responses/responses.d.ts:3452-3494`).
- Anthropic's `output_tokens` includes the reply's thinking, as for [Claude Code](claude-code.md).
- Gemini's `promptTokenCount` includes the cached content, and its `totalTokenCount` is "the sum of `prompt_token_count`, `candidates_token_count`, `tool_use_prompt_token_count`, and `thoughts_token_count`" (`GenerateContentResponseUsageMetadata` in `@google/genai` 2.6.0, which Qwen Code 0.25.1 pins, `dist/genai.d.ts:4875-4898`). So its candidates leave the thoughts out. At 0.25.1, `packages/core` and `packages/cli` name no tool of Gemini's own, such as Google Search, and no `toolUsePromptTokenCount`.

So, as the providers define their fields, `promptTokenCount` is the whole prompt, cached part included, for every provider. `candidatesTokenCount` counts the reasoning for every provider but Gemini, which counts it in `thoughtsTokenCount` alone: adding the two would count an OpenAI-compatible reply's reasoning twice. `totalTokenCount` less `promptTokenCount` is what the reply wrote, reasoning included, for each of them, and it is how Qwen Code itself works out a reply's output from the file when a session is resumed (`ResumeTokenCountsAccumulator` in `core/services/session-resume-token-counts.ts:22-34`, through `getUsageOutputTokenCountForPromptEstimate` in `core/services/tokenEstimation.ts:130-147`).

### What is shown

| Shown  | From                                      |
| ------ | ----------------------------------------- |
| In     | `promptTokenCount`                        |
| Cached | `cachedContentTokenCount`, unless 0       |
| Out    | `totalTokenCount` less `promptTokenCount` |

`usageCountsOf` in `chatRecords.ts` works out these three numbers from a reply's line, reads `candidatesTokenCount` only to check them and keeps nothing more of it, `tokenCountsOf` in `src/core/tokens/tokenCounts.ts` checks them, and `foldQwenCodeRecord` in `qwenCodeMapping.ts` keeps those of the newest reply.

- The counted line is the newest `assistant` line with no subtype that has `usageMetadata`. A subagent's line, `isSidechain: true`, is skipped as every line a subagent wrote is. A line with a subtype, a `system` line and a `user` line are never counted.
- A newer reply with no `usageMetadata` changes nothing, as a Codex reply with no token count line does: the counts stay those of the newest reply that has them. Qwen Code writes none for a reply stopped with Esc before the provider sent its usage, which an OpenAI-compatible provider sends after the reply's last part (`core/core/openaiContentGenerator/converter.ts:2037-2040`), or for a provider that sends none. A session whose replies have none shows a dash.
- A reply stopped with Esc after usage came is counted with what had come. Its status is still idle, as the [Status](#status) table says.
- Counts that could not be right give a dash, never an older reply's: a `usageMetadata` that is not an object; a `promptTokenCount` or `totalTokenCount` that is missing, negative or not a whole number; a `promptTokenCount` of 0, which Qwen Code writes for a provider that sent a total alone; a `totalTokenCount` smaller than `promptTokenCount` and `candidatesTokenCount` together, as the 0 Qwen Code writes for a provider that sent no total; a `candidatesTokenCount` that is negative or not a whole number; or a cached part that is negative, not a whole number or larger than the prompt. The dash lasts until the next reply with counts.
- A reply too long to read whole, over 4 MiB, gives a dash too, until the next reply with counts: its `usageMetadata` comes after its `message`, past the part that is read.
- A `cachedContentTokenCount` of 0 is left out, and the details say only Newest reply: Qwen Code writes 0 for a provider that sent no cached count (`?? 0` in its converters, `coerceUsageCount` in `llm-chat.ts`), and the line cannot tell that from a cache that held none.
- Nothing is summed: there are no totals. A compression or `/rewind` changes nothing: the counts stay those of the newest reply in the file.

Not yet checked on a computer running Qwen Code: that the lines hold the counts as the source above writes them, for any provider. To check, run a session with each provider you use, and compare, for its newest reply, the five counts of its line's `usageMetadata`, and only those, with what its details show.

## Last message

What a session last said is read only when `GET /api/sessions/last-message` asks for it, which the dashboard does while the session's details are open, and only for a session the last poll listed (`lastMessages.ts`, on `createTailReader` in `src/collector/messages/tailReader.ts`, as Codex's and Antigravity's are). No poll reads it, and it is never put on a session.

- The file is the chat file the adapter last found for the session: for an open session, the one the last poll found; for one shown as finished, the one found while it was open; for a record a crash left behind, the one in the folder named for its folder. Never a file beside it, nor another session's, and nothing in a request names it. A session with no chat file is answered `not-found`, and no file is opened.
- At most the last 256 KB are read, opened without following a link and without waiting on a pipe. The first line of that end, which the read cut into, is not read.
- The model's reply is an `assistant` line whose `message` is the reply as the model gave it, a `role` of `model` and a list of `parts`, as the status reads it above. A part with `text` is what the reply says, unless it is marked `thought: true`, the model's thinking. A part with a `functionCall` calls a tool. That a reply's text parts make one answer joined with nothing between, as the model's parts do, is taken from that shape and not yet checked on a machine running Qwen Code.
- So the text is that of the newest `assistant` line with no subtype and no `isSidechain: true` whose parts hold text that is not a thought: those parts' text, joined with nothing between. A reply that only calls tools, or only thinks, is passed over for the one before it. A prompt, a thought, a tool's call, a tool's result, a system line and a subagent's line are never taken. Only a line that names `"assistant"` is parsed, and only by its own `type`, so a reply quoted in a prompt is never taken.
- It is made fit to show as every last message is, and at most its last 2,000 characters are kept, in memory, for at most 15 seconds after the last ask. The answer has no token counts: a session's are on the session already, from the poll's read. `AGENT_LOOKOUT_LAST_MESSAGE=off` or `AGENT_LOOKOUT_WAITING_TEXT=off` stops it, and the Sources card then says Last message read: Off.

## What it never reads

Under Qwen Code's own folder:

- `oauth_creds.json`, `oauth_creds.lock`, `mcp-oauth-tokens*.json`, `extension-secrets-v1.json`, `ide/`, `daemon/`, `jobs/`, `agent-hosts/` and `channels/`, which hold sign-ins, tokens and secrets;
- `settings.json`, `.env`, `installation_id`, `google_accounts.json`, `trustedFolders.json` and `memory.md`;
- `file-history/`, and a project's own `.qwen/settings.json`.

Under the runtime folder: `tmp/`, `debug/`, `todos/`, `usage/` and `resources/`, and in each project's folder `memory/`, `subagents/`, `chats/archive/` and the files beside a chat file, `<id>.runtime.json`, `<id>.worktree.json`, `<id>.pr.json` and `<id>.ledger.jsonl`.

It never writes, creates, renames or deletes anything in either folder, never writes a record of its own into `sessions/`, never connects to a session's socket and never runs `qwen`.

## Status

What each line says:

| Line                                                                              | Status                                |
| --------------------------------------------------------------------------------- | ------------------------------------- |
| A prompt: `user` with no subtype, `cron` or `goal_runtime`                        | Working                               |
| A `user` `notification` stamped `deliveredTurn`                                   | Working                               |
| `user` `mid_turn_user_message`, typed while a turn runs                           | Working                               |
| `assistant` whose reply calls `ask_user_question`, after its request's end        | Needs you, with the reason question   |
| `assistant` whose reply calls `exit_plan_mode`, after its request's end           | Needs you, with the reason question   |
| `assistant` whose reply calls another tool, or one of those with no end before it | Working                               |
| `tool_result`, none stopped since the calls                                       | Working                               |
| `request_lifecycle` `started`, of the session's own, unless it needs you          | Working                               |
| `assistant` with a reply and no call                                              | Idle                                  |
| `tool_result`, one or more stopped or declined                                    | Idle                                  |
| `system` `rewind`                                                                 | Idle                                  |
| `system` `turn_result`                                                            | Idle                                  |
| `request_lifecycle` `ended` with `cancelled`                                      | Idle                                  |
| `request_lifecycle` `ended` any other way                                         | What the line before the request said |
| A line of another type, or a reply too long to read                               | Unknown                               |

Every other line says nothing: a notification saved before any turn ran, messages between agents, other telemetry, a subagent's requests, a request of the session's own that starts while it needs you, titles, compressions and snapshots. Nor does an `assistant` line right after a request ended with `cancelled`: it is the part of the reply Qwen Code had when Esc stopped it, written after the stop (`core/core/llm-chat.ts:6218-6258`, `core/core/llm-chat.ts:5183-5196`). Even when that part calls a tool, no tool runs, and the turn is over. So it never begins a wait either.

A request's end, in the table, is that of a request of the session's own that ended, and not with `cancelled`, with no reply between it and the reply. Qwen Code writes one from 0.25.1, as [Questions and plan approvals](#questions-and-plan-approvals) says, so with an older Qwen Code a reply that asks shows as working.

A request that ended well or failed, with no line after it, puts back what the line before it said. After a reply, Qwen Code can ask the model whether it should speak next, when `skipNextSpeakerCheck` is off (`core/core/client.ts:5481-5507`), and writes a request for it but no reply, so the session is idle again once that request ends. An idle stretch that comes back this way begins when the request ended.

The first rule that holds wins:

1. A Managed Session log: unknown.
2. No chat file, or one read whole with nothing that says anything: idle since the session registered.
3. A file read from its middle with nothing that says anything: unknown.
4. A newest line that says something from before the session registered: idle since it registered. That is a session resumed with `/resume`, or one an earlier Qwen Code left mid-turn.
5. Otherwise, what the newest line that says something says.

A session that `/clear` or `/resume` moved a running process to while Agent Lookout watched counts as registered at the last poll before the move.

A result that was stopped ends the turn because Esc while tools run ends it, whichever calls finished (`cli/ui/hooks/use-llm-stream.ts:5496-5522`). When a person declined one call of several, Qwen Code goes on, and its next request, written from 0.25.1, or a reply that calls a tool shows the session as working again.

A session that needs you has the time of the line that asked, which does not move while it waits. A working session's time is when its stretch of work began, or none when that is before what was read. An idle session's is when it became idle, never before it registered. A Qwen Code session is never shown as failed, and never as needing you for a tool's approval.

### Questions and plan approvals

Qwen Code asks you two things through tools of its own: a question, `ask_user_question`, and a plan to approve, `exit_plan_mode` (`core/tools/tool-names.ts:35,42`). Each is a call in a reply, so the chat file has a line when one begins and a line when it ends:

- The reply that calls it is written before Qwen Code asks. `processStreamResponse` queues the `assistant` line once the reply's stream has ended (`core/core/llm-chat.ts:6735`). `Turn.run` reads that stream to its end (`core/core/turn.ts:747-866`), and the terminal schedules the reply's calls only after its own loop over the turn's events has ended (`cli/ui/hooks/use-llm-stream.ts:2770`, `:3108-3259`). Every line goes through one queue, in the order it was queued (`enqueueRecordWrite` and `appendRecord`, `core/services/chatRecordingService.ts:1666-1734`), so the reply's line comes before any line the answer writes.
- From 0.25.1, the request the reply answers is written as ended before the reply. The wrapper around each request to the model writes its end once the stream has ended, before it hands that end on (`core/core/loggingContentGenerator/loggingContentGenerator.ts:982`), or as the stream is closed early (`:1069-1082`), and the line goes through the same queue (`core/telemetry/request-lifecycle.ts:68-80`, `core/services/chatRecordingService.ts:3118-3133`). So a reply that asks begins a wait only after a request of the session's own that ended, and not with `cancelled`, with no reply between them.
- Before 0.25.1, Qwen Code writes no request, and from 0.24.0 Esc after part of a reply writes that part with no line before it that says it was stopped (`core/core/llm-chat.ts:6218-6259`). A call in that part never runs, since the terminal schedules no call once Esc was pressed (`cli/ui/hooks/use-llm-stream.ts:3107-3110`), and no line tells it from a call that asks. So with a Qwen Code before 0.25.1, a reply that asks shows as working, as one that calls any other tool does.
- In a terminal, Qwen Code always asks a question, and asks for a plan's approval in plan mode. No permission rule or approval mode answers either for you, though a deny rule can refuse one without asking (`core/tools/askUserQuestion.ts:198-219`, `core/tools/exitPlanMode.ts:132-150`, `core/core/permissionFlow.ts:89-94`). Outside plan mode, `exit_plan_mode` asks nothing, and its result is an error at once (`core/tools/exitPlanMode.ts:244-249`).
- No call of the reply runs while one waits for you (`attemptExecutionOfScheduledCalls`, `core/core/coreToolScheduler.ts:5265-5284`). Qwen Code writes no line for the wait itself, and none at the moment you answer. A line written meanwhile, such as the title Qwen Code gives the session, says nothing of its status. Nor does a request of the session's own that starts then: Qwen Code asks the model for the turn again only once the results are written, and the request that makes the session's title, which can run meanwhile, is not written: its prompt id is `side-query:session-title`, one Qwen Code keeps out of the file (`core/services/sessionTitle.ts:157-158`, `core/utils/sideQuery.ts:135-137`, `core/utils/internalPromptIds.ts:24-37`, `core/telemetry/request-lifecycle.ts:54-55`).
- The results end the wait. The terminal's scheduler writes no result itself (`cli/ui/hooks/useReactToolScheduler.ts:228-238`, `core/core/coreToolScheduler.ts:7751-7760`). Once every call of the reply has ended (`checkAndNotifyCompletion`, `core/core/coreToolScheduler.ts:7379-7387`), `handleCompletedTools` writes one `tool_result` line for each (`cli/ui/hooks/use-llm-stream.ts:5475-5494`).
- An answer, or an approved plan, runs the tool, and its result's status is `success`: the answers (`core/tools/askUserQuestion.ts:273-301`), or "User approved." (`core/tools/exitPlanMode.ts:297-305`). Qwen Code then sends the results to the model, and its next request is written.
- Declining, with Cancel or "No, keep planning", and Esc or Ctrl+C in either prompt, are one answer, Cancel (`cli/ui/components/messages/AskUserQuestionDialog.tsx:238-239,325-326,352-353`, `cli/ui/components/messages/ToolConfirmationMessage.tsx:179-180,531-535`). The call is stopped without running (`core/core/coreToolScheduler.ts:4969-4973`), and its result's status is `cancelled`. When every call of the reply was stopped, Qwen Code sends nothing to the model, and the turn is over (`cli/ui/hooks/use-llm-stream.ts:5525-5560`).
- A session resumed while a question was open, with `--resume` or `/resume`, gets no result line for it: Qwen Code makes one up in memory alone (`repairOrphanedToolUseTurnsInHistory`, `core/core/client.ts:1125-1185`), and asks nothing.
- A subagent cannot ask you. `ask_user_question` is taken from every subagent (`createAgentHeadless`, `core/subagents/subagent-manager.ts:1113-1117,1157-1162`), and `exit_plan_mode` too (`EXCLUDED_TOOLS_FOR_SUBAGENTS`, `core/agents/runtime/subagent-plan-tool-policy.ts:51-67`). A subagent writes its lines to a file of its own, each marked `isSidechain: true` (`core/agents/agent-transcript.ts:70,724`).

So, from 0.25.1, a reply that calls either tool, alone or beside other calls, shows the session as needing you, from that line's time, until a newer line says something, which is most often the results:

| What happens                    | What the chat file gets                       | Status                                                |
| ------------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| Qwen Code asks                  | The request's end, then the `assistant` line  | Needs you, since that line                            |
| You answer, or approve the plan | `tool_result` lines, then the model's request | Working                                               |
| You decline, or press Esc       | `tool_result` lines with `cancelled`          | Idle                                                  |
| Qwen Code is closed, or crashes | Nothing. Its record goes, or its process does | Finished, as [Closed sessions](#closed-sessions) says |
| The session is resumed later    | Nothing for the open question                 | Idle since it registered, by rule 4                   |

Both waits have the reason question, which the dashboard says as "Asked you a question": the plan's prompt asks one too, "Would you like to proceed?" (`core/tools/exitPlanMode.ts:177`). What Qwen Code asks, and the plan, are never kept. Of the call, only the tool's name is kept, compared exactly with `ask_user_question` and `exit_plan_mode`, and what is kept is Agent Lookout's own word for it (`QWEN_CODE_WAIT_TOOLS` in `qwenCodeMapping.ts`, `waitToolOf` in `chatRecords.ts`). So a Qwen Code session that needs you has no `waitingText`. Its wait counts as any agent's does: it can send a notification, an email, a webhook post or a push, it is shown in the Needs you panel and counted in the Dock badge, Keep awake and Waits, and the Events log and the history record it.

Not yet checked on a computer running Qwen Code: that the lines come in this order, and that no line that says something is written while a question or a plan waits. To check, ask Qwen Code a question it must answer with `ask_user_question`, and in plan mode let it ask you to approve a plan. While each waits, the newest line of the session's own in its chat file should call the tool, with the end of its request just before it and no `tool_result` after it.

## Closed sessions

A session closes when a poll no longer finds it open after an earlier poll did: its record has gone, its process has gone, or its record names another session, as after `/clear` or `/resume`. It is shown as finished from that poll for 24 hours, with what was last known of it, and no poll reads its chat file again. A session that closes while it waits for you is finished too, and keeps no reason for the wait. While its details are open, what it last said is still read from that file, as [Last message](#last-message) says. It leaves the list sooner if it is open again. When its process is still open with another session, as after `/clear` or `/resume`, it names no process, and with `finished` notifications on it sends one like any session that finishes.

At the first poll, a record whose process has already gone, as a crash leaves, is shown as finished from its chat file's modified time, or from when it registered. One a day old or more is left out. Every other session that closed before Agent Lookout started is not shown, and nothing of this is kept across a restart.

## Fields

- **Name:** the title Qwen Code gave the session, or the one set with `/rename`, then the folder's name, then the id. The newest `custom_title` wins. What was typed is never used, and neither is the record's `name`.
- **Folder:** the record's `cwd`, which `/cd` changes.
- **Started:** the chat file's first line, when the file was read from its start. Otherwise when the process registered the session, or when `/clear` or `/resume` moved the process to it, if Agent Lookout saw that happen.
- **Quiet for:** the chat file's modified time from the `lstat` on each poll. Every line Qwen Code adds moves it on. A session with no chat file has none.
- **Tokens:** the counts of the newest reply that has them, as [Token counts](#token-counts) says. A record a crash left behind has none: its chat file is not read.
- **App:** Terminal.
- **Process:** the record's `pid`, with no Stop or link. Jump is in [Jump](#jump).

## Jump

An open session whose process runs inside a tmux pane, or else in a tab of Terminal or iTerm2 on a Mac, gets a Jump button, as a Claude Code session does. The record's `pid` is the process. The Qwen Code adapter asks the same pane finder and tab finder as the Claude Code adapter, each through an asker of its own, and one look serves both: `tmux -u list-panes -a` and `ps -A -o pid=,ppid=` for a pane, `ps -A -o pid=,ppid=,tty=,comm=` for a tab, as [PRIVACY.md](../../PRIVACY.md#tmux) lists. A pane comes before a tab.

A record can outlive a crashed session, and its pid can go to another program, which may run in a pane or a tab of its own. Qwen Code writes a start token, `procStart`, only on Linux, and in its own form, so on a Mac or Windows there is no start time to compare. But `startedAt` is the clock's time when the process wrote the record (`core/services/session-registry.ts:482`), and that process held the pid then. So for each process found in a pane or a tab, the adapter asks `ps -o pid=,lstart= -p <pids>` when it started, every 30 seconds, and sooner when another process is found in a pane or a tab (`processCheck.ts`). A process that started no later than `startedAt`, give or take a minute for Linux's `ps`, which works the time out again from the clock, was running when the record was written, and two running processes never share a pid, so it is the session's. One that started later was given the pid since, and its session gets no Jump. When `ps` gives no time, the session gets none either, and nor does one whose `startedAt` is more than a minute ahead of the clock, since that time may not have come yet.

`AGENT_LOOKOUT_TMUX=off` and `AGENT_LOOKOUT_TERMINAL_JUMP=off` turn each part off, for Qwen Code as for Claude Code. Windows has no tmux and no Terminal, so there no Qwen Code session has Jump.

## Versions

- The list of running sessions is written from Qwen Code 0.21.14 (QwenLM/qwen-code#8969). With an older Qwen Code there is no list, and the Sources view says so.
- `kind` is written from 0.23.3. A record without one is a terminal's.
- `request_lifecycle` and `executionContext` are written from 0.25.1. So a session shows as needing you only from 0.25.1, as [Questions and plan approvals](#questions-and-plan-approvals) says.
- Up to 0.3.0 Qwen Code kept chats in `tmp/<hash>/chats/session-*.json`. From 0.4.0 the only chats are the JSON Lines files under `projects/`. `tmp/` is never read.

## Known gaps

- A session waiting for a tool's approval shows as working, and its Quiet for grows. Qwen Code writes nothing while it asks.
- Before 0.25.1, a session that asks you a question or to approve a plan shows as working, and its Quiet for grows. Qwen Code writes no request before the reply that asks, so that reply cannot be told from one Esc cut short, whose call never runs.
- When the reply that asks a question, or for a plan's approval, calls other tools as well, Qwen Code runs them only once you answer, and writes every result once the last of them ends. Until then the session still shows as needing you.
- A call Qwen Code answers at once, without asking, such as `exit_plan_mode` outside plan mode or a call a deny rule refuses, writes its reply's line and its result a moment apart. A poll in that moment shows the session as needing you until the next poll, and can send a notification.
- A request that fails for good shows as working until the next prompt: Qwen Code records each failed try, and nothing when it gives up. So can a reply stopped with Esc. Before 0.24.0, Esc writes nothing. From 0.24.0, Esc after any part of a reply writes that part (`core/core/llm-chat.ts:6218-6259`), which shows as idle unless it calls a tool, and an Esc before the first part writes nothing. From 0.25.1, Esc during a request also writes a stopped request first, and the session shows as idle whatever the part holds. But Esc while Qwen Code waits to retry a failed try writes nothing, since no request is open then (`core/utils/retry.ts:171-195`), and nor may Esc before a turn's first request starts, as while Qwen Code compacts the chat. Those show as working until the next prompt on 0.25.1 too.
- Before 0.25.1, a session where you declined one call of several shows as idle until Qwen Code's next reply.
- Closed sessions are shown only while Agent Lookout runs, and records a crash left at its start.
- After a crash, another process can take the pid. The closed session then shows as open, with the status its chat file last gave, often working, since a crash tends to come mid-turn, or needing you, when it crashed while it asked. It has no Jump, since that process started after the record was written. That can last as long as the process that took the pid runs, and come back each time the pid is given out again while the record is left. On a Mac or Windows, with no start time to compare, Qwen Code keeps a record whose pid runs (`core/utils/process-liveness.ts:201-210`). On Linux, a Qwen Code that lists its sessions, as `qwen sessions ps` does, removes the record sooner. It does not once the computer has restarted: Qwen Code leaves alone a record from before the restart (`core/services/session-registry.ts:756-760`).
- Never listed: `qwen -p` runs, which never register (`docs/users/features/commands.md:770`); Qwen Code before 0.21.14; sessions an editor or Qwen Code's server drives; sessions in a container, on a Mac or Windows; and sessions under a folder Agent Lookout's own environment does not name.
- Chats moved by `advanced.runtimeOutputDir`, or with chat recording off, show as idle, and after ten minutes the Sources view says no chat file was found.
- Managed Session logs show as unknown.
- After `/rewind`, Last message and Tokens can be a reply the rewind took back, until the session replies again: the reply's line stays in the file. After Esc, Last message is the part of the reply Qwen Code had when it stopped, which Qwen Code writes after the stop. Tokens are that part's counts only when the provider's usage had come before the stop, and otherwise stay as they were, as [Token counts](#token-counts) says.
- After `/clear` or `/resume` made before Agent Lookout started, the session is idle since its process registered, which can be long before, until its next prompt, so it can show as stale at once. But a session such a `/resume` took up shows what its newest line says when that line is newer than when the process registered, as one another Qwen Code left asking: it then shows as needing you until its next line. After such a `/clear`, Started is that time too until the new session writes its first line. Started is also when the process registered for a chat file over 8 MiB, which is read from its middle.
- After the clock is set back, a session whose `startedAt` is then more than a minute ahead of it has no Jump until the clock catches up. On Linux, a session also has no Jump once the clock is set forward by more than a minute while it runs, since `ps` then gives a start after its `startedAt`, until the clock is set back or the session is restarted.
- On Linux, a record written in a container is listed, and its pid is checked on this computer. If a process here has the same pid, started before the record was written and runs in a tmux pane, the session's Jump selects that pane.
- Tokens show a dash while the newest reply with counts is further back than the 8 MiB read of the chat file, and after a reply too long to read whole, until the next reply with counts.
- Tokens show a dash for an OpenAI-compatible provider that sends no `total_tokens`.

## What breaks when Qwen Code changes

| Change in Qwen Code                                   | What the dashboard shows                                                                                                                                  | Where to fix it                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| The record's fields or `schemaVersion` change         | No Qwen Code sessions, and the Sources view names a newer format                                                                                          | `registry.ts`                                   |
| Record names change                                   | No Qwen Code sessions                                                                                                                                     | `registry.ts`                                   |
| The project folder rule changes                       | Sessions are still found by a look through every folder in `projects/`, up to 30 seconds late, and a crash's leftover is finished from when it registered | `transcriptFile.ts`                             |
| The order of the first keys of a line changes         | A line over 4 MiB reads as unknown                                                                                                                        | `chatRecords.ts`                                |
| `request_lifecycle` changes shape                     | A stopped reply shows as working until the next prompt, and so does a session that asks you                                                               | `chatRecords.ts`                                |
| A new `user` subtype begins turns                     | Those turns do not show as working                                                                                                                        | `src/core/mapping/qwen-code/qwenCodeMapping.ts` |
| A new line type                                       | Sessions show as unknown until their next line                                                                                                            | `src/core/mapping/qwen-code/qwenCodeMapping.ts` |
| `custom_title` changes                                | Sessions are named after their folder                                                                                                                     | `chatRecords.ts`                                |
| `ask_user_question` or `exit_plan_mode` is renamed    | A question, or a plan to approve, shows as working                                                                                                        | `QWEN_CODE_WAIT_TOOLS` in `qwenCodeMapping.ts`  |
| An answer to a question or a plan writes its own line | A session still shows as needing you after you answer, until its results                                                                                  | `src/core/mapping/qwen-code/qwenCodeMapping.ts` |
| A reply's `parts`, or how a thought is marked, change | Last message shows nothing, or shows a thought                                                                                                            | `lastMessages.ts`                               |
| `usageMetadata` moves or its counts are renamed       | Tokens is a dash in every Qwen Code session's details                                                                                                     | `chatRecords.ts`                                |
| A provider's counts come to mean something else       | Out leaves out the reasoning or counts it twice, or In shows less than the context in use                                                                 | `chatRecords.ts`                                |
| `QWEN_HOME` or `QWEN_RUNTIME_DIR` mean something else | Qwen Code is not found, or found empty                                                                                                                    | `index.ts`                                      |
| `startedAt` is no longer when the record was written  | Sessions in a pane or a tab have no Jump, or one that took a crashed session's pid has one                                                                | `processCheck.ts`                               |

To check a new Qwen Code version, read `core/services/session-registry.ts`, `core/services/chatRecordingService.ts`, `core/telemetry/request-lifecycle.ts`, `core/utils/paths.ts`, `core/config/storage.ts` and `docs/users/features/cross-session-protocol.md` at its tag, for the token counts `processStreamResponse` in `core/core/llm-chat.ts` and the converters named in [Token counts](#token-counts), and for the waits `core/tools/tool-names.ts`, `core/tools/askUserQuestion.ts`, `core/tools/exitPlanMode.ts`, `handleCompletedTools` in `cli/ui/hooks/use-llm-stream.ts` and where `core/core/loggingContentGenerator/loggingContentGenerator.ts` ends a request. Then run a session in a terminal, and compare the dashboard with `qwen sessions ps` on a machine where nothing else reads the list.
